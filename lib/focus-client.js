const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { readSymbolMeta, normalizeSymbol, isValidSymbol } = require("./store");

const DELAY_MINUTES = Number(process.env.DELAY_MINUTES || 20);
const API_BASE = process.env.MARKETECH_API_BASE || "https://api.marketech.com.au";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15_000);
const ENV_PATH = path.join(__dirname, "..", ".env");

function companyNameFor(symbol) {
  const meta = readSymbolMeta();
  return meta[normalizeSymbol(symbol)]?.name || null;
}

function productTypeFor(symbol) {
  const meta = readSymbolMeta();
  return meta[normalizeSymbol(symbol)]?.productType || "Stock";
}

function toIso(date) {
  return new Date(date.getTime()).toISOString();
}

function getCookieFromEnv() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const env = dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
      return env.MARKETECH_COOKIE || process.env.MARKETECH_COOKIE || "";
    }
  } catch {
    // Fall through.
  }
  return process.env.MARKETECH_COOKIE || "";
}

async function postJson(endpointPath, body) {
  const cookie = getCookieFromEnv();
  if (!cookie) {
    const error = new Error("Server is missing MARKETECH_COOKIE.");
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${API_BASE}${endpointPath}`, {
    method: "POST",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const error = new Error(`Upstream API error (${response.status}).`);
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }

  return parsed;
}

function getChartRangeConfig(intervalKey) {
  const normalized = String(intervalKey || "day").trim().toLowerCase();

  if (normalized === "minute") {
    return {
      intervalKey: "minute",
      label: "Minute",
      maxRangeLabel: "7D",
      interval: { Amount: 5, Basis: "Minute" },
      startOffsetMs: 7 * 24 * 60 * 60 * 1000
    };
  }

  if (normalized === "hour") {
    return {
      intervalKey: "hour",
      label: "Hour",
      maxRangeLabel: "90D",
      interval: { Amount: 1, Basis: "Hour" },
      startOffsetMs: 90 * 24 * 60 * 60 * 1000
    };
  }

  if (normalized === "day") {
    return {
      intervalKey: "day",
      label: "Day",
      maxRangeLabel: "5Y",
      interval: { Amount: 1, Basis: "Day" },
      startOffsetMs: 5 * 365 * 24 * 60 * 60 * 1000,
      endSnap: "day"
    };
  }

  if (normalized === "week") {
    return {
      intervalKey: "week",
      label: "Week",
      maxRangeLabel: "15Y",
      interval: { Amount: 1, Basis: "Week" },
      startOffsetMs: 15 * 365 * 24 * 60 * 60 * 1000,
      endSnap: "week"
    };
  }

  if (normalized === "month") {
    return {
      intervalKey: "month",
      label: "Month",
      maxRangeLabel: "25Y",
      interval: { Amount: 1, Basis: "Month" },
      startOffsetMs: 25 * 365 * 24 * 60 * 60 * 1000,
      endSnap: "month"
    };
  }

  const error = new Error(`Unsupported chart interval "${intervalKey}".`);
  error.status = 400;
  throw error;
}

function alignDateForChartEnd(date, endSnap) {
  const aligned = new Date(date.getTime());

  if (endSnap === "day") {
    aligned.setUTCHours(16, 0, 0, 0);
    return aligned;
  }

  if (endSnap === "week") {
    const day = aligned.getUTCDay();
    aligned.setUTCDate(aligned.getUTCDate() - day);
    aligned.setUTCHours(16, 0, 0, 0);
    return aligned;
  }

  if (endSnap === "month") {
    aligned.setUTCDate(1);
    aligned.setUTCMonth(aligned.getUTCMonth() + 1);
    aligned.setUTCDate(0);
    aligned.setUTCHours(16, 0, 0, 0);
    return aligned;
  }

  return aligned;
}

function parseTotmResult(result) {
  const ticker = normalizeSymbol(result?.symbol);
  const messages = Array.isArray(result?.payload?.Messages) ? result.payload.Messages : [];
  const latest = messages[0];

  if (!latest || typeof latest.Last !== "number") {
    return null;
  }

  let change = null;
  let changePercent = null;
  if (typeof latest.PreviousClose === "number") {
    change = latest.Last - latest.PreviousClose;
    changePercent = latest.PreviousClose !== 0 ? (change / latest.PreviousClose) * 100 : null;
  }

  return {
    ticker,
    companyName: companyNameFor(ticker),
    price: latest.Last,
    change,
    changePercent,
    delayedByMinutes: DELAY_MINUTES,
    priceTime: latest.LastTraded || null,
    candleTime: latest.TimeStamp || null,
    priceSourceMode: "totm"
  };
}

function mapCandlesPayload(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.Messages)
      ? payload.Messages
      : [];
}

function calculateQuoteMetrics(candles, mode) {
  const latest = candles[candles.length - 1];
  let change = null;
  let changePercent = null;

  if (mode === "intraday" && typeof candles[0]?.Open === "number" && typeof latest?.Close === "number") {
    change = latest.Close - candles[0].Open;
    changePercent = candles[0].Open !== 0 ? (change / candles[0].Open) * 100 : null;
  } else if (candles.length >= 2 && typeof candles[candles.length - 2]?.Close === "number" && typeof latest?.Close === "number") {
    const previousClose = candles[candles.length - 2].Close;
    change = latest.Close - previousClose;
    changePercent = previousClose !== 0 ? (change / previousClose) * 100 : null;
  }

  return { latest, change, changePercent };
}

async function fetchCandlesForSymbol(symbol, interval, start, end) {
  const ticker = normalizeSymbol(symbol);
  const payload = await postJson("/candles/get", {
    contractKey: {
      ProviderKey: "$",
      ProductType: productTypeFor(ticker),
      Exchange: "XASX",
      Symbol: ticker
    },
    interval,
    start: toIso(start),
    end: toIso(end),
    options: {
      CompleteOnly: false
    }
  });

  return mapCandlesPayload(payload);
}

async function searchContracts(prefix, maxResults = 100) {
  const tickerPrefix = String(prefix || "").trim().toUpperCase();
  const payload = await postJson("/contracts/search", {
    searchTerm: tickerPrefix,
    maxResults
  });

  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.Messages)
      ? payload.Messages
      : [];

  return raw
    .filter((item) =>
      item &&
      item.Exchange === "XASX" &&
      ["Stock", "ETF", "Fund", "Index"].includes(item.ProductType) &&
      isValidSymbol(item.Symbol)
    )
    .map((item) => ({
      symbol: normalizeSymbol(item.Symbol),
      name: item.Name || null,
      productType: item.ProductType || "Stock",
      isPrimaryListing: Boolean(item.IsPrimaryListing)
    }));
}

async function fetchQuoteForSymbol(symbol) {
  const ticker = normalizeSymbol(symbol);
  const totmPayload = await postJson("/totm/get", {
    contractKey: {
      ProviderKey: "$",
      ProductType: productTypeFor(ticker),
      Exchange: "XASX",
      Symbol: ticker
    },
    interval: {
      Basis: "Day",
      Amount: 1
    },
    version: 2
  });

  const totmQuote = parseTotmResult({
    symbol: ticker,
    payload: totmPayload
  });
  if (totmQuote) {
    return totmQuote;
  }

  const delayedEnd = new Date(Date.now() - DELAY_MINUTES * 60 * 1000);
  const attempts = [
    {
      mode: "intraday",
      interval: { Amount: 5, Basis: "Minute" },
      start: new Date(delayedEnd.getTime() - 24 * 60 * 60 * 1000),
      end: delayedEnd
    },
    {
      mode: "daily",
      interval: { Amount: 1, Basis: "Day" },
      start: new Date(delayedEnd.getTime() - 365 * 24 * 60 * 60 * 1000),
      end: delayedEnd
    },
    {
      mode: "weekly",
      interval: { Amount: 1, Basis: "Week" },
      start: new Date(delayedEnd.getTime() - 5 * 365 * 24 * 60 * 60 * 1000),
      end: delayedEnd
    }
  ];

  for (const attempt of attempts) {
    const candles = await fetchCandlesForSymbol(ticker, attempt.interval, attempt.start, attempt.end);
    if (candles.length === 0) {
      continue;
    }

    const { latest, change, changePercent } = calculateQuoteMetrics(candles, attempt.mode);
    if (typeof latest?.Close !== "number") {
      continue;
    }

    return {
      ticker,
      companyName: companyNameFor(ticker),
      price: latest.Close,
      change,
      changePercent,
      delayedByMinutes: DELAY_MINUTES,
      priceTime: latest.LastTraded || null,
      candleTime: latest.TimeStamp || null,
      priceSourceMode: attempt.mode
    };
  }

  const error = new Error(`No quote data returned for ${ticker}.`);
  error.status = 404;
  throw error;
}

async function fetchQuotesBatch(symbols) {
  const uniqueSymbols = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const results = await Promise.allSettled(
    uniqueSymbols.map((symbol) => fetchQuoteForSymbol(symbol))
  );

  const authFailures = results.filter((result) =>
    result.status === "rejected" &&
    (result.reason?.status === 401 || result.reason?.status === 403)
  ).length;

  if (authFailures > 0 && authFailures === results.length) {
    const error = new Error(`Quote batch auth failure (${authFailures}/${results.length}).`);
    error.status = 401;
    error.isAuthFailure = true;
    throw error;
  }

  return results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

function mapChartCandles(candles) {
  return candles
    .filter((candle) =>
      candle &&
      candle.TimeStamp &&
      typeof candle.Open === "number" &&
      typeof candle.High === "number" &&
      typeof candle.Low === "number" &&
      typeof candle.Close === "number"
    )
    .map((candle) => ({
      time: candle.TimeStamp,
      open: candle.Open,
      high: candle.High,
      low: candle.Low,
      close: candle.Close,
      volume: candle.Volume ?? null,
      trades: candle.Trades ?? null,
      lastTraded: candle.LastTraded || null
    }));
}

async function fetchChartForSymbol(symbol, intervalKey = "day") {
  const ticker = normalizeSymbol(symbol);
  const config = getChartRangeConfig(intervalKey);
  const rawEnd = new Date(Date.now() - DELAY_MINUTES * 60 * 1000);
  const end = alignDateForChartEnd(rawEnd, config.endSnap);
  const start = new Date(end.getTime() - config.startOffsetMs);
  const candles = await fetchCandlesForSymbol(ticker, config.interval, start, end);
  const chartCandles = mapChartCandles(candles);

  if (chartCandles.length === 0) {
    const error = new Error(`No chart data returned for ${ticker}.`);
    error.status = 404;
    throw error;
  }

  return {
    ticker,
    intervalKey: config.intervalKey,
    label: config.label,
    maxRangeLabel: config.maxRangeLabel,
    interval: config.interval,
    delayedByMinutes: DELAY_MINUTES,
    candles: chartCandles
  };
}

async function fetchChartsBatch(symbols, intervalKey) {
  const uniqueSymbols = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const results = await Promise.allSettled(
    uniqueSymbols.map((symbol) => fetchChartForSymbol(symbol, intervalKey))
  );

  const authFailures = results.filter((result) =>
    result.status === "rejected" &&
    (result.reason?.status === 401 || result.reason?.status === 403)
  ).length;

  if (authFailures > 0 && authFailures === results.length) {
    const error = new Error(`Chart batch auth failure (${authFailures}/${results.length}).`);
    error.status = 401;
    error.isAuthFailure = true;
    throw error;
  }

  return results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

module.exports = {
  fetchQuoteForSymbol,
  fetchQuotesBatch,
  fetchChartsBatch,
  fetchChartForSymbol,
  getChartRangeConfig,
  searchContracts
};
