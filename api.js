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
const { fetchQuoteForSymbol, getCookieDiagnostics } = require("./lib/focus-client");

validateEnv();

const app = express();
const PORT = getEnvNumber("PORT");
const CHART_CACHE_TTL_MS = getEnvNumber("CHART_CACHE_TTL_MS");
const PUBLIC_WIDGET_REFRESH_MS = getEnvNumber("PUBLIC_WIDGET_REFRESH_MS");
const COOKIE_UPDATE_TOKEN = getEnvString("COOKIE_UPDATE_TOKEN").trim();
const INFO_LOGS_ENABLED = getEnvBoolean("INFO_LOGS_ENABLED");
const CHART_DEBUG_LOGS = ["1", "true", "yes", "on"].includes(
  String(process.env.CHART_DEBUG_LOGS || "").trim().toLowerCase()
);
const RUNTIME_COOKIE_PATH = path.join(__dirname, "data", "runtime-cookie.json");

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
  if (value === "1m") return "week";
  return value;
}

function logChartDebug(event, details = {}) {
  if (!CHART_DEBUG_LOGS) {
    return;
  }
  console.log(`[chart-debug] ${new Date().toISOString()} ${event}`, details);
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
    logChartDebug("api-cache-hit", {
      ticker,
      intervalKey,
      durationMs: Date.now() - startedAt,
      isStale: cacheMeta.isStale,
      cacheAgeMs: cacheMeta.cacheAgeMs,
      updatedAt: cached.updatedAt || null,
      candleCount: Array.isArray(cached.candles) ? cached.candles.length : 0
    });
    return res.json({
      ...cached,
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
