require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { getEnvBoolean, getEnvNumber, getEnvString, validateEnv } = require("./lib/env");
const {
  ensureSeedFiles,
  getQuote,
  getChart,
  upsertQuote,
  upsertChart,
  searchSymbols,
  isValidSymbol,
  normalizeSymbol,
  readCollectorStatus,
  readSymbols,
  readSymbolMeta
} = require("./lib/store");
const { fetchQuoteForSymbol, fetchQuotesBatch, getCookieDiagnostics } = require("./lib/focus-client");

validateEnv();

const app = express();
const PORT = getEnvNumber("PORT");
const CHART_CACHE_TTL_MS = getEnvNumber("CHART_CACHE_TTL_MS");
const PUBLIC_WIDGET_REFRESH_MS = getEnvNumber("PUBLIC_WIDGET_REFRESH_MS");
const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT_MAX_REQUESTS = 60;
const API_RATE_LIMIT_BLOCK_MS = 2 * 60 * 1000;
const MINI_CHART_MAX_POINTS = 16;
const PUBLIC_CHART_MAX_CANDLES_BY_INTERVAL = {
  minute: 50,
  hour: 50,
  day: 50,
  month: 36
};
const COOKIE_UPDATE_TOKEN = getEnvString("COOKIE_UPDATE_TOKEN").trim();
const INFO_LOGS_ENABLED = getEnvBoolean("INFO_LOGS_ENABLED");
const CHART_DEBUG_LOGS = ["1", "true", "yes", "on"].includes(
  String(process.env.CHART_DEBUG_LOGS || "").trim().toLowerCase()
);
const RUNTIME_COOKIE_PATH = path.join(__dirname, "data", "runtime-cookie.json");
const apiRateLimitState = new Map();

if (!INFO_LOGS_ENABLED) {
  console.log = () => {};
}

ensureSeedFiles();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").trim();
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function enforceApiRateLimit(req, res, next) {
  const now = Date.now();
  const clientIp = getClientIp(req);
  const currentState = apiRateLimitState.get(clientIp);

  if (currentState?.blockedUntil && currentState.blockedUntil > now) {
    return res.status(429).json({
      error: "Too many requests."
    });
  }

  const windowStartedAt = currentState?.windowStartedAt || now;
  const shouldResetWindow = now - windowStartedAt >= API_RATE_LIMIT_WINDOW_MS;
  const nextState = shouldResetWindow
    ? { windowStartedAt: now, requestCount: 1, blockedUntil: null }
    : {
        windowStartedAt,
        requestCount: (currentState?.requestCount || 0) + 1,
        blockedUntil: null
      };

  if (nextState.requestCount > API_RATE_LIMIT_MAX_REQUESTS) {
    apiRateLimitState.set(clientIp, {
      windowStartedAt: now,
      requestCount: nextState.requestCount,
      blockedUntil: now + API_RATE_LIMIT_BLOCK_MS
    });
    return res.status(429).json({
      error: "Too many requests."
    });
  }

  apiRateLimitState.set(clientIp, nextState);

  if (apiRateLimitState.size > 5000) {
    for (const [ip, state] of apiRateLimitState.entries()) {
      const isExpiredWindow = !state?.windowStartedAt || now - state.windowStartedAt >= API_RATE_LIMIT_WINDOW_MS;
      const isExpiredBlock = !state?.blockedUntil || state.blockedUntil <= now;
      if (isExpiredWindow && isExpiredBlock) {
        apiRateLimitState.delete(ip);
      }
    }
  }

  return next();
}

app.use("/api", enforceApiRateLimit);

function getChartCacheMeta(chart) {
  if (!chart?.updatedAt) {
    return {
      servedFromCache: true,
      cacheAgeMs: null,
      isStale: true
    };
  }

  const cacheAgeMs = Math.max(Date.now() - new Date(chart.updatedAt).getTime(), 0);
  return {
    servedFromCache: true,
    cacheAgeMs,
    isStale: cacheAgeMs >= CHART_CACHE_TTL_MS
  };
}

function sendValidationError(res) {
  return res.status(400).json({
    error: "Invalid symbol. Use A-Z and 0-9 only, max 10 characters."
  });
}

function getCookieUpdateSecret(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return String(req.headers["x-cookie-update-token"] || "").trim();
}

function writeRuntimeCookie(cookie, source = "internal-api") {
  fs.mkdirSync(path.dirname(RUNTIME_COOKIE_PATH), { recursive: true });
  fs.writeFileSync(
    RUNTIME_COOKIE_PATH,
    JSON.stringify(
      {
        cookie,
        source,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function normalizeChartInterval(rawValue) {
  const value = String(rawValue || "day").trim().toLowerCase();
  if (value === "1d") return "minute";
  if (value === "1w") return "day";
  if (value === "1m") return "day";
  return value;
}

function logChartDebug(event, details = {}) {
  if (!CHART_DEBUG_LOGS) {
    return;
  }
  console.log(`[chart-debug] ${new Date().toISOString()} ${event}`, details);
}

function getSydneyDateKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function pickIndexSet(total, desired) {
  if (!Number.isInteger(total) || total <= 0) {
    return [];
  }
  if (!Number.isInteger(desired) || desired <= 0 || total <= desired) {
    return Array.from({ length: total }, (_, index) => index);
  }

  const indices = new Set([0, total - 1]);
  for (let step = 0; step < desired; step += 1) {
    indices.add(Math.round((step * (total - 1)) / (desired - 1)));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

function downsampleMiniCandles(candles, maxPoints = MINI_CHART_MAX_POINTS) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const safeMaxPoints = Math.max(3, Number(maxPoints) || MINI_CHART_MAX_POINTS);
  if (candles.length <= safeMaxPoints) {
    return candles.slice();
  }

  return pickIndexSet(candles.length, safeMaxPoints)
    .map((index) => candles[index])
    .filter(Boolean);
}

function roundMiniSeriesValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Number(numeric.toFixed(4));
}

function downsampleChartCandles(candles, maxCandles = 60) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const safeMaxCandles = Math.max(3, Number(maxCandles) || 60);
  if (candles.length <= safeMaxCandles) {
    return candles.slice();
  }

  return pickIndexSet(candles.length, safeMaxCandles)
    .map((index) => candles[index])
    .filter(Boolean);
}

function getPublicChartMaxCandles(intervalKey) {
  const normalized = String(intervalKey || "day").trim().toLowerCase();
  return PUBLIC_CHART_MAX_CANDLES_BY_INTERVAL[normalized] || 60;
}

function compactChartCandle(candle) {
  if (!candle || typeof candle !== "object") {
    return null;
  }
  const timeMs = Number.isFinite(candle.timeMs) ? Number(candle.timeMs) : new Date(candle.time).getTime();
  if (!Number.isFinite(timeMs)) {
    return null;
  }
  return [
    timeMs,
    Number(candle.open),
    Number(candle.high),
    Number(candle.low),
    Number(candle.close)
  ];
}

function buildMiniChartPayload(chart) {
  if (!chart || !Array.isArray(chart.candles)) {
    return null;
  }

  const sourceCandles = chart.candles;
  const candlesByDay = new Map();
  for (const candle of sourceCandles) {
    const dateKey = getSydneyDateKey(candle?.time);
    if (!dateKey) {
      continue;
    }
    if (!candlesByDay.has(dateKey)) {
      candlesByDay.set(dateKey, []);
    }
    candlesByDay.get(dateKey).push(candle);
  }

  const dateKeys = Array.from(candlesByDay.keys()).sort();
  let selectedCandles = [];
  for (let index = dateKeys.length - 1; index >= 0; index -= 1) {
    const dayCandles = candlesByDay.get(dateKeys[index]) || [];
    if (dayCandles.length >= 2) {
      selectedCandles = dayCandles;
      break;
    }
    if (!selectedCandles.length && dayCandles.length) {
      selectedCandles = dayCandles;
    }
  }

  if (!selectedCandles.length) {
    selectedCandles = sourceCandles.slice(-MINI_CHART_MAX_POINTS);
  }

  const downsampledCandles = downsampleMiniCandles(selectedCandles, MINI_CHART_MAX_POINTS);
  const compactSeries = downsampledCandles
    .map((candle) => roundMiniSeriesValue(candle?.close))
    .filter(Number.isFinite);

  return {
    series: compactSeries
  };
}

async function handleQuoteRequest(req, res) {
  const ticker = normalizeSymbol(req.params.symbol);
  if (!isValidSymbol(ticker)) {
    return sendValidationError(res);
  }

  const cached = getQuote(ticker);
  if (cached) {
    return res.json(cached);
  }

  try {
    const quote = await fetchQuoteForSymbol(ticker);
    return res.json(upsertQuote(ticker, quote));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({ error: error?.message || "Failed to load quote." });
  }
}

app.get("/api/quote/:symbol", handleQuoteRequest);
app.get("/api/public/quote/:symbol", handleQuoteRequest);

async function handleQuotesRequest(req, res) {
  const requestedSymbols = String(req.query.symbols || "")
    .split(",")
    .map((value) => normalizeSymbol(value))
    .filter(Boolean);
  const uniqueSymbols = Array.from(new Set(requestedSymbols)).slice(0, 50);

  if (!uniqueSymbols.length) {
    return res.status(400).json({
      error: "Provide at least one symbol in the symbols query parameter."
    });
  }

  const invalidSymbol = uniqueSymbols.find((ticker) => !isValidSymbol(ticker));
  if (invalidSymbol) {
    return sendValidationError(res);
  }

  const quotesBySymbol = new Map();
  const missingSymbols = [];

  uniqueSymbols.forEach((ticker) => {
    const cached = getQuote(ticker);
    if (cached) {
      quotesBySymbol.set(ticker, cached);
    } else {
      missingSymbols.push(ticker);
    }
  });

  if (missingSymbols.length) {
    try {
      const fetchedQuotes = await fetchQuotesBatch(missingSymbols);
      fetchedQuotes.forEach((quote) => {
        const ticker = normalizeSymbol(quote?.ticker);
        if (!ticker) {
          return;
        }
        const stored = upsertQuote(ticker, quote);
        quotesBySymbol.set(ticker, stored);
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return res.status(status).json({ error: error?.message || "Failed to load quotes." });
    }
  }

  return res.json({
    results: uniqueSymbols
      .map((ticker) => quotesBySymbol.get(ticker))
      .filter(Boolean)
  });
}

app.get("/api/quotes", handleQuotesRequest);
app.get("/api/public/quotes", handleQuotesRequest);

async function handleChartRequest(req, res) {
  const startedAt = Date.now();
  const ticker = normalizeSymbol(req.params.symbol);
  const intervalKey = normalizeChartInterval(req.query.interval || req.query.range || "day");

  if (!isValidSymbol(ticker)) {
    return sendValidationError(res);
  }

  const cached = getChart(ticker, intervalKey);
  if (cached) {
    const cacheMeta = getChartCacheMeta(cached);
    const publicChartMaxCandles = getPublicChartMaxCandles(intervalKey);
    const publicCandles = downsampleChartCandles(cached.candles, publicChartMaxCandles)
      .map(compactChartCandle)
      .filter(Boolean);
    logChartDebug("api-cache-hit", {
      ticker,
      intervalKey,
      durationMs: Date.now() - startedAt,
      isStale: cacheMeta.isStale,
      cacheAgeMs: cacheMeta.cacheAgeMs,
      updatedAt: cached.updatedAt || null,
      candleCount: Array.isArray(cached.candles) ? cached.candles.length : 0,
      publicChartMaxCandles,
      servedCandleCount: publicCandles.length
    });
    return res.json({
      ...cached,
      candleFormat: "timeMs-ohlc-v1",
      candles: publicCandles,
      originalCandleCount: Array.isArray(cached.candles) ? cached.candles.length : 0,
      ...cacheMeta
    });
  }

  logChartDebug("api-cache-miss", {
    ticker,
    intervalKey,
    durationMs: Date.now() - startedAt
  });

  return res.status(503).json({
    error: `Chart for ${ticker} (${intervalKey}) is not cached yet. Try again after the collector refreshes it.`,
    servedFromCache: false,
    cacheAgeMs: null,
    isStale: true
  });
}

app.get("/api/chart/:symbol", handleChartRequest);
app.get("/api/public/chart/:symbol", handleChartRequest);

app.get("/api/chart-mini/:symbol", (req, res) => {
  const ticker = normalizeSymbol(req.params.symbol);
  if (!isValidSymbol(ticker)) {
    return sendValidationError(res);
  }

  const cached = getChart(ticker, "minute");
  if (!cached) {
    return res.status(503).json({
      error: `Mini chart for ${ticker} is not cached yet. Try again after the collector refreshes it.`,
      servedFromCache: false,
      cacheAgeMs: null,
      isStale: true
    });
  }

  const payload = buildMiniChartPayload(cached);
  return res.json(payload);
});

app.get("/api/chart-mini", (req, res) => {
  const requestedSymbols = String(req.query.symbols || "")
    .split(",")
    .map((value) => normalizeSymbol(value))
    .filter(Boolean);
  const uniqueSymbols = Array.from(new Set(requestedSymbols)).slice(0, 50);

  if (!uniqueSymbols.length) {
    return res.status(400).json({
      error: "Provide at least one symbol in the symbols query parameter."
    });
  }

  const invalidSymbol = uniqueSymbols.find((ticker) => !isValidSymbol(ticker));
  if (invalidSymbol) {
    return sendValidationError(res);
  }

  return res.json({
    results: uniqueSymbols.map((ticker) => {
      const cached = getChart(ticker, "minute");
      if (!cached) {
        return {
          symbol: ticker,
          chart: null
        };
      }
      return {
        symbol: ticker,
        chart: buildMiniChartPayload(cached)
      };
    })
  });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "");
  const limit = Math.max(1, Math.min(Number(req.query.limit || 20), 100));
  return res.json({
    query: q,
    results: searchSymbols(q, limit)
  });
});

app.post("/internal/runtime-cookie", (req, res) => {
  if (!COOKIE_UPDATE_TOKEN) {
    return res.status(503).json({
      error: "COOKIE_UPDATE_TOKEN is not configured on this service."
    });
  }

  const secret = getCookieUpdateSecret(req);
  if (!secret || secret !== COOKIE_UPDATE_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized cookie update request."
    });
  }

  const cookie = String(req.body?.cookie || "").trim();
  if (!cookie || !cookie.includes("at=")) {
    return res.status(400).json({
      error: "Cookie payload must include a valid auth cookie string."
    });
  }

  const source = String(req.body?.source || "internal-api").trim() || "internal-api";
  writeRuntimeCookie(cookie, source);
  return res.json({
    ok: true,
    source,
    diagnostics: {
      cookie: getCookieDiagnostics()
    }
  });
});

app.get("/internal/status", (req, res) => {
  const collectorStatus = readCollectorStatus();
  return res.json({
    api: {
      startedAt: process.uptime(),
      port: PORT
    },
    symbols: {
      tracked: readSymbols().length,
      metaEntries: Object.keys(readSymbolMeta()).length
    },
    collector: collectorStatus,
    diagnostics: {
      cookie: getCookieDiagnostics()
    }
  });
});

app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  return res.send(`(function () {
  var script = document.currentScript;
  if (!script) return;
  var symbolRaw = (script.dataset.symbol || "ASX:BHP").trim().toUpperCase();
  var symbol = symbolRaw.indexOf(":") >= 0 ? symbolRaw.split(":")[1] : symbolRaw;
  var theme = (script.dataset.theme || "light").toLowerCase();
  var width = script.dataset.width || "350";
  var containerId = script.dataset.containerId || "mt-quote-widget";
  var refreshMs = Number(script.dataset.refreshMs || ${PUBLIC_WIDGET_REFRESH_MS});
  var apiBase = new URL(script.src, window.location.href).origin;
  var mount = document.getElementById(containerId) || script.parentElement;
  if (!mount) return;

  var style = document.createElement("style");
  style.textContent = ".mtw-card{font-family:Segoe UI,Tahoma,sans-serif;border:1px solid #d8e2ef;border-radius:10px;padding:12px 14px;max-width:" + width + "px;background:" + (theme === "dark" ? "#0f1722" : "#ffffff") + ";color:" + (theme === "dark" ? "#e8eef6" : "#122133") + ";box-shadow:0 6px 20px rgba(12,23,38,.10)}.mtw-top{display:flex;justify-content:space-between;gap:8px}.mtw-ticker{font-weight:700;font-size:18px}.mtw-company{font-size:12px;opacity:.75}.mtw-price{font-size:28px;font-weight:700;margin-top:4px}.mtw-up{color:#118a44}.mtw-down{color:#b42318}.mtw-meta{font-size:12px;opacity:.85;margin-top:6px}.mtw-error{font-size:12px;color:#b42318;margin-top:8px}";
  mount.appendChild(style);

  var card = document.createElement("div");
  card.className = "mtw-card";
  card.innerHTML = "<div class='mtw-top'><div><div class='mtw-ticker'>Loading...</div><div class='mtw-company'></div></div><div class='mtw-meta'>Delayed 20m</div></div><div class='mtw-price'>-</div><div class='mtw-meta mtw-change'></div><div class='mtw-meta mtw-time'></div><div class='mtw-error'></div>";
  mount.appendChild(card);

  var tickerEl = card.querySelector(".mtw-ticker");
  var companyEl = card.querySelector(".mtw-company");
  var priceEl = card.querySelector(".mtw-price");
  var changeEl = card.querySelector(".mtw-change");
  var timeEl = card.querySelector(".mtw-time");
  var errorEl = card.querySelector(".mtw-error");

  function fmtSigned(n, d) {
    var v = Number(n);
    if (!Number.isFinite(v)) return "-";
    return (v > 0 ? "+" : "") + v.toFixed(d);
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
  }

  async function load() {
    try {
      errorEl.textContent = "";
      var r = await fetch(apiBase + "/api/quote/" + encodeURIComponent(symbol));
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed");

      tickerEl.textContent = data.ticker;
      companyEl.textContent = data.companyName || "";
      priceEl.textContent = Number(data.price).toFixed(2);
      var up = Number(data.change) >= 0;
      changeEl.className = "mtw-meta mtw-change " + (up ? "mtw-up" : "mtw-down");
      changeEl.textContent = "Change: " + fmtSigned(data.change, 2) + " (" + fmtSigned(data.changePercent, 2) + "%)";
      timeEl.textContent = "Last traded: " + fmtDate(data.priceTime);
    } catch (e) {
      errorEl.textContent = e.message || "Widget error";
    }
  }

  load();
  setInterval(load, refreshMs);
})();`);
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});
