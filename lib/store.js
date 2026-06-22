const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CHARTS_DIR = path.join(DATA_DIR, "charts");
const SYMBOLS_FILE = path.join(ROOT, "symbols.json");
const SYMBOLS_META_FILE = path.join(ROOT, "symbols-meta.json");
const LATEST_QUOTES_FILE = path.join(DATA_DIR, "latest-quotes.json");
const PARTNERS_FILE = path.join(DATA_DIR, "partners.json");
const COLLECTOR_STATUS_FILE = path.join(DATA_DIR, "collector-status.json");
const fileCache = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CHARTS_DIR)) {
    fs.mkdirSync(CHARTS_DIR, { recursive: true });
  }
}

function normalizeIntervalKey(intervalKey) {
  return String(intervalKey || "").trim().toLowerCase();
}

function getChartsFilePath(intervalKey) {
  const normalizedIntervalKey = normalizeIntervalKey(intervalKey || "default");
  return path.join(CHARTS_DIR, `latest-charts-${normalizedIntervalKey}.json`);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function cloneFallback(fallback) {
  if (Array.isArray(fallback)) {
    return [...fallback];
  }
  if (fallback && typeof fallback === "object") {
    return { ...fallback };
  }
  return fallback;
}

function readJsonFileCached(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fileCache.delete(filePath);
      return cloneFallback(fallback);
    }

    const stats = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.value;
    }

    const value = readJsonFile(filePath, fallback);
    fileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      value
    });
    return value;
  } catch {
    return cloneFallback(fallback);
  }
}

function writeJsonFile(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    const stats = fs.statSync(filePath);
    fileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      value
    });
  } catch {
    fileCache.delete(filePath);
  }
}

function isValidSymbol(symbol) {
  return /^[A-Z0-9]{1,10}$/.test(String(symbol || "").trim().toUpperCase());
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function chartKey(symbol, intervalKey) {
  return `${normalizeSymbol(symbol)}:${normalizeIntervalKey(intervalKey)}`;
}

function readSymbols() {
  const raw = readJsonFileCached(SYMBOLS_FILE, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(normalizeSymbol).filter(isValidSymbol);
}

function writeSymbols(symbols) {
  const cleaned = Array.from(new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map(normalizeSymbol)
      .filter(isValidSymbol)
  )).sort();
  writeJsonFile(SYMBOLS_FILE, cleaned);
  return cleaned;
}

function readSymbolMeta() {
  const raw = readJsonFileCached(SYMBOLS_META_FILE, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([symbol, value]) => {
        const normalizedSymbol = normalizeSymbol(symbol);
        if (typeof value === "string") {
          return [normalizedSymbol, { name: value.trim(), productType: "Stock" }];
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return [normalizedSymbol, {
            name: typeof value.name === "string" ? value.name.trim() : "",
            productType: typeof value.productType === "string" ? value.productType.trim() : "Stock"
          }];
        }
        return [normalizedSymbol, null];
      })
      .filter(([symbol, meta]) => isValidSymbol(symbol) && meta && meta.name)
  );
}

function writeSymbolMeta(meta) {
  const cleaned = Object.fromEntries(
    Object.entries(meta || {})
      .map(([symbol, value]) => {
        const normalizedSymbol = normalizeSymbol(symbol);
        if (typeof value === "string") {
          return [normalizedSymbol, { name: value.trim(), productType: "Stock" }];
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return [normalizedSymbol, {
            name: typeof value.name === "string" ? value.name.trim() : "",
            productType: typeof value.productType === "string" ? value.productType.trim() : "Stock"
          }];
        }
        return [normalizedSymbol, null];
      })
      .filter(([symbol, entry]) => isValidSymbol(symbol) && entry && entry.name)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  writeJsonFile(SYMBOLS_META_FILE, cleaned);
  return cleaned;
}

function readLatestQuotes() {
  const raw = readJsonFileCached(LATEST_QUOTES_FILE, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeLatestQuotes(quotes) {
  writeJsonFile(LATEST_QUOTES_FILE, quotes);
}

function readLatestCharts(intervalKey) {
  const raw = readJsonFileCached(getChartsFilePath(intervalKey), {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeLatestCharts(charts, intervalKey) {
  writeJsonFile(getChartsFilePath(intervalKey), charts);
}

function readCollectorStatus() {
  const raw = readJsonFileCached(COLLECTOR_STATUS_FILE, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeCollectorStatus(status) {
  writeJsonFile(COLLECTOR_STATUS_FILE, status || {});
}

function getQuote(symbol) {
  const quotes = readLatestQuotes();
  return quotes[normalizeSymbol(symbol)] || null;
}

function upsertQuote(symbol, quote) {
  const ticker = normalizeSymbol(symbol);
  const quotes = readLatestQuotes();
  quotes[ticker] = {
    ...quote,
    ticker,
    updatedAt: new Date().toISOString()
  };
  writeLatestQuotes(quotes);
  return quotes[ticker];
}

function upsertQuotesBatch(quotesBatch) {
  const quotes = readLatestQuotes();
  const updatedAt = new Date().toISOString();

  for (const quote of quotesBatch) {
    if (!quote || !isValidSymbol(quote.ticker)) {
      continue;
    }
    quotes[normalizeSymbol(quote.ticker)] = {
      ...quote,
      ticker: normalizeSymbol(quote.ticker),
      updatedAt
    };
  }

  writeLatestQuotes(quotes);
  return quotes;
}

function getChart(symbol, intervalKey) {
  const normalizedIntervalKey = normalizeIntervalKey(intervalKey);
  const charts = readLatestCharts(normalizedIntervalKey);
  return charts[chartKey(symbol, normalizedIntervalKey)] || null;
}

function upsertChart(symbol, intervalKey, chart) {
  const normalizedIntervalKey = normalizeIntervalKey(intervalKey);
  const charts = readLatestCharts(normalizedIntervalKey);
  charts[chartKey(symbol, normalizedIntervalKey)] = {
    ...chart,
    ticker: normalizeSymbol(symbol),
    intervalKey: normalizedIntervalKey,
    updatedAt: new Date().toISOString()
  };
  writeLatestCharts(charts, normalizedIntervalKey);
  return charts[chartKey(symbol, normalizedIntervalKey)];
}

function upsertChartsBatch(chartsBatch, intervalKey) {
  const normalizedIntervalKey = normalizeIntervalKey(intervalKey);
  const charts = readLatestCharts(normalizedIntervalKey);
  const updatedAt = new Date().toISOString();

  for (const chart of chartsBatch) {
    if (!chart || !isValidSymbol(chart.ticker)) {
      continue;
    }

    charts[chartKey(chart.ticker, normalizedIntervalKey)] = {
      ...chart,
      ticker: normalizeSymbol(chart.ticker),
      intervalKey: normalizedIntervalKey,
      updatedAt
    };
  }

  writeLatestCharts(charts, normalizedIntervalKey);
  return charts;
}

function searchSymbols(query, limit = 20) {
  const q = String(query || "").trim().toUpperCase();
  if (!q) {
    return [];
  }

  const meta = readSymbolMeta();
  return readSymbols()
    .map((symbol) => ({
      symbol,
      companyName: meta[symbol]?.name || null
    }))
    .filter((item) => item.symbol.includes(q) || String(item.companyName || "").toUpperCase().includes(q))
    .map((item) => {
      const companyNameUpper = String(item.companyName || "").toUpperCase();
      const companyWords = companyNameUpper.split(/[^A-Z0-9]+/).filter(Boolean);
      let score = 0;

      if (item.symbol === q) score += 10_000;
      if (item.symbol.startsWith(q)) score += 5_000;
      if (item.symbol.includes(q)) score += 1_000;

      if (companyNameUpper === q) score += 800;
      if (companyNameUpper.startsWith(q)) score += 500;
      if (companyWords.some((word) => word.startsWith(q))) score += 300;
      if (companyNameUpper.includes(q)) score += 100;

      score -= item.symbol.length;

      return {
        ...item,
        score
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }

      return a.symbol.localeCompare(b.symbol);
    })
    .map(({ score, ...item }) => item)
    .slice(0, limit);
}

function ensureSeedFiles() {
  ensureDataDir();
  if (!fs.existsSync(LATEST_QUOTES_FILE)) {
    writeLatestQuotes({});
  }
  for (const intervalKey of ["minute", "hour", "day", "week", "month"]) {
    const filePath = getChartsFilePath(intervalKey);
    if (!fs.existsSync(filePath)) {
      writeLatestCharts({}, intervalKey);
    }
  }
  if (!fs.existsSync(PARTNERS_FILE)) {
    writeJsonFile(PARTNERS_FILE, {});
  }
  if (!fs.existsSync(COLLECTOR_STATUS_FILE)) {
    writeCollectorStatus({});
  }
}

module.exports = {
  ensureSeedFiles,
  readSymbols,
  writeSymbols,
  readSymbolMeta,
  writeSymbolMeta,
  readLatestQuotes,
  readLatestCharts,
  readCollectorStatus,
  writeCollectorStatus,
  getQuote,
  upsertQuote,
  upsertQuotesBatch,
  getChart,
  upsertChart,
  upsertChartsBatch,
  searchSymbols,
  isValidSymbol,
  normalizeSymbol
};
