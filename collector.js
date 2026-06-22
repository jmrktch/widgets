require("dotenv").config();

const { refreshCookie } = require("./scripts/refresh-cookie");
const { fetchQuotesBatch, fetchChartsBatch, searchContracts } = require("./lib/focus-client");
const { getEnvBoolean, getEnvList, getEnvNumber, getEnvString, validateEnv } = require("./lib/env");
const {
  ensureSeedFiles,
  readSymbols,
  readSymbolMeta,
  upsertQuotesBatch,
  upsertChartsBatch,
  writeCollectorStatus,
  writeSymbols,
  writeSymbolMeta
} = require("./lib/store");

validateEnv();

const INFO_LOGS_ENABLED = getEnvBoolean("INFO_LOGS_ENABLED");

if (!INFO_LOGS_ENABLED) {
  console.log = () => {};
}

const QUOTE_REFRESH_INTERVAL_MS = getEnvNumber("QUOTE_REFRESH_INTERVAL_MS");
const COOKIE_REFRESH_INTERVAL_MS = getEnvNumber("COOKIE_REFRESH_INTERVAL_MS");
const AUTH_REFRESH_RETRY_COUNT = getEnvNumber("AUTH_REFRESH_RETRY_COUNT");
const AUTH_REFRESH_RETRY_DELAY_MS = getEnvNumber("AUTH_REFRESH_RETRY_DELAY_MS");
const QUOTE_BATCH_SIZE = getEnvNumber("QUOTE_BATCH_SIZE");
const QUOTE_BATCH_PAUSE_MS = getEnvNumber("QUOTE_BATCH_PAUSE_MS");
const COLLECTOR_MODE = getEnvString("COLLECTOR_MODE").trim().toLowerCase() || "rolling";
const CHART_COLLECTION_ENABLED = getEnvBoolean("CHART_COLLECTION_ENABLED");
const CHART_COLLECTION_ON_STARTUP = getEnvBoolean("CHART_COLLECTION_ON_STARTUP");
const STARTUP_DAY_CHART_ENABLED = getEnvBoolean("STARTUP_DAY_CHART_ENABLED");
const STARTUP_WEEK_CHART_ENABLED = getEnvBoolean("STARTUP_WEEK_CHART_ENABLED");
const STARTUP_MONTH_CHART_ENABLED = getEnvBoolean("STARTUP_MONTH_CHART_ENABLED");
const CHART_REFRESH_INTERVAL_MS = getEnvNumber("CHART_REFRESH_INTERVAL_MS");
const CHART_BATCH_SIZE = getEnvNumber("CHART_BATCH_SIZE");
const CHART_BATCH_PAUSE_MS = getEnvNumber("CHART_BATCH_PAUSE_MS");
const CHART_INTERVAL_KEYS = getEnvList("CHART_INTERVAL_KEYS")
  .map((item) => item.toLowerCase())
  .filter(Boolean);
const MINUTE_CHART_SYMBOLS = getEnvList("MINUTE_CHART_SYMBOLS")
  .map((item) => item.toUpperCase())
  .filter(Boolean);
const WORKER_SYMBOL_ORDER_MODE = getEnvString("WORKER_SYMBOL_ORDER_MODE").trim().toLowerCase() || "interleave";
const COLLECTOR_SCHEDULER_ENABLED = getEnvBoolean("COLLECTOR_SCHEDULER_ENABLED");
const COLLECTOR_MARKET_TIMEZONE = getEnvString("COLLECTOR_MARKET_TIMEZONE");
const COLLECTOR_MARKET_OPEN_HOUR = getEnvNumber("COLLECTOR_MARKET_OPEN_HOUR");
const COLLECTOR_MARKET_OPEN_MINUTE = getEnvNumber("COLLECTOR_MARKET_OPEN_MINUTE");
const COLLECTOR_MARKET_CLOSE_HOUR = getEnvNumber("COLLECTOR_MARKET_CLOSE_HOUR");
const COLLECTOR_MARKET_CLOSE_MINUTE = getEnvNumber("COLLECTOR_MARKET_CLOSE_MINUTE");
const COLLECTOR_MARKET_STAGE_ORDER = getEnvList("COLLECTOR_MARKET_STAGE_ORDER")
  .map((item) => item.toLowerCase())
  .filter(Boolean);
const COLLECTOR_AFTER_HOURS_STAGE_ORDER = getEnvList("COLLECTOR_AFTER_HOURS_STAGE_ORDER")
  .map((item) => item.toLowerCase())
  .filter(Boolean);
const COLLECTOR_LOOP_PAUSE_MS = getEnvNumber("COLLECTOR_LOOP_PAUSE_MS");
const WORKER_LOOP_PAUSE_MS = getEnvNumber("WORKER_LOOP_PAUSE_MS");
const WORKER_LOOP_JITTER_MS = getEnvNumber("WORKER_LOOP_JITTER_MS");
const STAGE_MIN_GAP_MS = {
  quote: getEnvNumber("QUOTE_STAGE_MIN_GAP_MS"),
  minute: getEnvNumber("MINUTE_STAGE_MIN_GAP_MS"),
  hour: getEnvNumber("HOUR_STAGE_MIN_GAP_MS"),
  day: getEnvNumber("DAY_STAGE_MIN_GAP_MS"),
  week: getEnvNumber("WEEK_STAGE_MIN_GAP_MS"),
  month: getEnvNumber("MONTH_STAGE_MIN_GAP_MS")
};
const SYMBOL_SYNC_ENABLED = getEnvBoolean("SYMBOL_SYNC_ENABLED");
const SYMBOL_SYNC_ON_STARTUP = getEnvBoolean("SYMBOL_SYNC_ON_STARTUP");
const SYMBOL_SYNC_AT_MIDNIGHT = getEnvBoolean("SYMBOL_SYNC_AT_MIDNIGHT");
const SYMBOL_SYNC_INTERVAL_MS = getEnvNumber("SYMBOL_SYNC_INTERVAL_MS");
const SYMBOL_SYNC_MAX_RESULTS = getEnvNumber("SYMBOL_SEARCH_MAX_RESULTS");
const SYMBOL_SYNC_PROGRESS_EVERY = getEnvNumber("SYMBOL_SYNC_PROGRESS_EVERY");
const SYMBOL_SYNC_TARGET_COUNT = getEnvNumber("SYMBOL_SYNC_TARGET_COUNT");
const MIN_SYMBOL_SYNC_COUNT = getEnvNumber("MIN_SYMBOL_SYNC_COUNT");
const SYMBOL_SYNC_FALLBACK_ENABLED = getEnvBoolean("SYMBOL_SYNC_FALLBACK_ENABLED");
const SYMBOL_SYNC_FALLBACK_PROBE_LIMIT = getEnvNumber("SYMBOL_SYNC_FALLBACK_PROBE_LIMIT");
const SYMBOL_SYNC_FALLBACK_EXACT_RESULTS = getEnvNumber("SYMBOL_SYNC_FALLBACK_EXACT_RESULTS");
const SYMBOL_SYNC_ALT_PASSES_ENABLED = getEnvBoolean("SYMBOL_SYNC_ALT_PASSES_ENABLED");
const SYMBOL_SYNC_ALT_PASS_LIMIT = getEnvNumber("SYMBOL_SYNC_ALT_PASS_LIMIT");
const SYMBOL_SYNC_ALT_ROOT_MODES = getEnvList("SYMBOL_SYNC_ALT_ROOT_MODES")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const SYMBOL_SEARCH_PREFIX_DEPTH = getEnvNumber("SYMBOL_SEARCH_PREFIX_DEPTH");
const SYMBOL_SYNC_FORCE_EXPAND_DEPTHS = new Set(
  getEnvList("SYMBOL_SYNC_FORCE_EXPAND_DEPTHS")
    .map((item) => Number.parseInt(String(item).trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0)
);
const SYMBOL_SYNC_EARLY_STOP_ENABLED = getEnvBoolean("SYMBOL_SYNC_EARLY_STOP_ENABLED");
const SYMBOL_SYNC_EARLY_STOP_NO_GROWTH_SCANS = getEnvNumber("SYMBOL_SYNC_EARLY_STOP_NO_GROWTH_SCANS");
const SYMBOL_SYNC_EARLY_STOP_MIN_PREFIX_LENGTH = getEnvNumber("SYMBOL_SYNC_EARLY_STOP_MIN_PREFIX_LENGTH");
const SYMBOL_SEARCH_ROOTS = getEnvList("SYMBOL_SEARCH_ROOTS")
  .map((item) => item.toUpperCase())
  .filter(Boolean);
const SYMBOL_SEARCH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const WEAK_BATCH_SUCCESS_RATIO = getEnvNumber("WEAK_BATCH_SUCCESS_RATIO");
const WEAK_BATCH_MIN_FAILURES = getEnvNumber("WEAK_BATCH_MIN_FAILURES");
const WEAK_BATCH_SAMPLE_SIZE = getEnvNumber("WEAK_BATCH_SAMPLE_SIZE");
const STARTUP_CHART_STAGES = [
  STARTUP_DAY_CHART_ENABLED ? "day" : null,
  STARTUP_WEEK_CHART_ENABLED ? "week" : null,
  STARTUP_MONTH_CHART_ENABLED ? "month" : null
].filter(Boolean);

let isRefreshingQuotes = false;
let isRefreshingCharts = false;
let isSyncingSymbols = false;
let lastQuoteRefreshSummary = null;
let lastChartRefreshSummary = null;
let lastSymbolSyncSummary = null;
let lastCollectorError = null;
let currentQuoteRefreshProgress = null;
let currentChartRefreshProgress = null;
let symbolSyncTimer = null;
let authRefreshPromise = null;
let collectorLoopPromise = null;
const workerLoopPromises = new Map();
const workerCursors = {
  quote: { offset: 0, passesCompleted: 0 },
  minute: { offset: 0, passesCompleted: 0 },
  hour: { offset: 0, passesCompleted: 0 },
  day: { offset: 0, passesCompleted: 0 },
  week: { offset: 0, passesCompleted: 0 },
  month: { offset: 0, passesCompleted: 0 }
};
let workerSymbolOrderCache = {};
let authState = {
  healthy: true,
  lastCheckedAt: null,
  lastRecoveredAt: null,
  lastFailureAt: null,
  lastFailureReason: null
};
const stageState = {
  quote: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null },
  minute: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null },
  hour: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null },
  day: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null },
  week: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null },
  month: { running: false, lastStartedAt: null, lastFinishedAt: null, lastSummary: null, lastError: null }
};
let schedulerState = {
  running: false,
  lastMode: null,
  lastLoopStartedAt: null,
  lastLoopFinishedAt: null
};
const marketTimeFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: COLLECTOR_MARKET_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(array, size) {
  const items = [];
  for (let index = 0; index < array.length; index += size) {
    items.push(array.slice(index, index + size));
  }
  return items;
}

function sleepWithJitter(baseMs, jitterMs = 0) {
  const extra = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return sleep(baseMs + extra);
}

function summarizeBatchTimings(batchDurations, totalUnits, durationMs) {
  if (!batchDurations.length) {
    return {
      avgBatchDurationMs: 0,
      fastestBatchDurationMs: 0,
      slowestBatchDurationMs: 0,
      unitsPerSecond: 0
    };
  }

  const totalBatchDurationMs = batchDurations.reduce((sum, value) => sum + value, 0);
  return {
    avgBatchDurationMs: Math.round(totalBatchDurationMs / batchDurations.length),
    fastestBatchDurationMs: Math.min(...batchDurations),
    slowestBatchDurationMs: Math.max(...batchDurations),
    unitsPerSecond: durationMs > 0 ? Number((totalUnits / (durationMs / 1000)).toFixed(2)) : 0
  };
}

function getChartSymbolsForInterval(intervalKey) {
  const symbols = readSymbols();
  if (intervalKey !== "minute" || MINUTE_CHART_SYMBOLS.length === 0) {
    return symbols;
  }

  const allowed = new Set(MINUTE_CHART_SYMBOLS);
  return symbols.filter((symbol) => allowed.has(symbol));
}

function getProductTypeForSymbol(symbol) {
  const meta = readSymbolMeta();
  return String(meta[symbol]?.productType || "Unknown").trim() || "Unknown";
}

function buildInterleavedOrder(symbols) {
  const buckets = new Map();

  for (const symbol of symbols) {
    const productType = getProductTypeForSymbol(symbol);
    const key = `${symbol[0] || "_"}|${productType}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(symbol);
  }

  const bucketKeys = Array.from(buckets.keys()).sort();
  const ordered = [];
  let added = true;

  while (added) {
    added = false;
    for (const key of bucketKeys) {
      const bucket = buckets.get(key);
      if (bucket && bucket.length > 0) {
        ordered.push(bucket.shift());
        added = true;
      }
    }
  }

  return ordered;
}

function maybeRebuildWorkerSymbolOrderCache(baseSymbols) {
  const fingerprint = Array.isArray(baseSymbols) ? baseSymbols.join("|") : "";
  if (workerSymbolOrderCache.baseFingerprint === fingerprint) {
    return;
  }

  const quoteSymbols = Array.isArray(baseSymbols) ? [...baseSymbols] : [];
  const minuteAllowed = MINUTE_CHART_SYMBOLS.length > 0 ? new Set(MINUTE_CHART_SYMBOLS) : null;
  const minuteSymbols = quoteSymbols.filter((symbol) =>
    minuteAllowed ? minuteAllowed.has(symbol) : true
  );

  if (WORKER_SYMBOL_ORDER_MODE === "interleave") {
    workerSymbolOrderCache = {
      baseFingerprint: fingerprint,
      quote: buildInterleavedOrder(quoteSymbols),
      minute: buildInterleavedOrder(minuteSymbols),
      hour: buildInterleavedOrder(quoteSymbols),
      day: buildInterleavedOrder(quoteSymbols),
      week: buildInterleavedOrder(quoteSymbols),
      month: buildInterleavedOrder(quoteSymbols)
    };
    return;
  }

  workerSymbolOrderCache = {
    baseFingerprint: fingerprint,
    quote: quoteSymbols,
    minute: minuteSymbols,
    hour: quoteSymbols,
    day: quoteSymbols,
    week: quoteSymbols,
    month: quoteSymbols
  };
}

function getSymbolsForStage(stageName) {
  const baseSymbols = readSymbols();
  maybeRebuildWorkerSymbolOrderCache(baseSymbols);

  if (stageName === "quote") {
    return workerSymbolOrderCache.quote || baseSymbols;
  }
  if (stageName === "minute") {
    return workerSymbolOrderCache.minute || getChartSymbolsForInterval(stageName);
  }
  return workerSymbolOrderCache[stageName] || getChartSymbolsForInterval(stageName);
}

function getBatchSizeForStage(stageName) {
  return stageName === "quote" ? QUOTE_BATCH_SIZE : CHART_BATCH_SIZE;
}

function getSuccessfulTickers(items) {
  return new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => String(item?.ticker || "").trim().toUpperCase())
      .filter(Boolean)
  );
}

function summarizeProductTypes(symbols) {
  const meta = readSymbolMeta();
  const counts = {};

  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    const productType = String(meta[symbol]?.productType || "Unknown").trim() || "Unknown";
    counts[productType] = (counts[productType] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([productType, count]) => `${productType}:${count}`)
    .join(",");
}

function maybeLogWeakBatchDiagnostics(stageName, batchInfo, batchSymbols, successItems) {
  const symbols = Array.isArray(batchSymbols) ? batchSymbols : [];
  if (symbols.length === 0) {
    return;
  }

  const successTickers = getSuccessfulTickers(successItems);
  const failedSymbols = symbols.filter((symbol) => !successTickers.has(symbol));
  const successRatio = successItems.length / symbols.length;

  if (failedSymbols.length < WEAK_BATCH_MIN_FAILURES || successRatio >= WEAK_BATCH_SUCCESS_RATIO) {
    return;
  }

  const failedSample = failedSymbols.slice(0, WEAK_BATCH_SAMPLE_SIZE);
  const batchTypes = summarizeProductTypes(symbols);
  const failedTypes = summarizeProductTypes(failedSymbols);
  console.warn(
    `[collector] weak ${stageName} batch diagnostics range=${batchInfo.startOffset}-${batchInfo.endOffset} pass=${batchInfo.passNumber} success=${successItems.length}/${symbols.length} first=${symbols[0]} last=${symbols[symbols.length - 1]} batchTypes=${batchTypes} failedTypes=${failedTypes} failedSample=${failedSample.join(",")}`
  );
}

function reorderRoots(roots, mode) {
  const base = Array.isArray(roots) ? [...roots] : [];
  if (mode === "reverse") {
    return base.reverse();
  }

  if (mode === "digits_first") {
    const digits = base.filter((item) => /^[0-9]$/.test(item));
    const alpha = base.filter((item) => /^[A-Z]$/.test(item));
    return [...digits, ...alpha];
  }

  if (mode === "alpha_first") {
    const alpha = base.filter((item) => /^[A-Z]$/.test(item));
    const digits = base.filter((item) => /^[0-9]$/.test(item));
    return [...alpha, ...digits];
  }

  if (mode === "interleave") {
    const digits = base.filter((item) => /^[0-9]$/.test(item));
    const alpha = base.filter((item) => /^[A-Z]$/.test(item));
    const out = [];
    const maxLength = Math.max(alpha.length, digits.length);
    for (let index = 0; index < maxLength; index += 1) {
      if (alpha[index]) out.push(alpha[index]);
      if (digits[index]) out.push(digits[index]);
    }
    return out;
  }

  return base;
}

function shouldExpandSymbolPrefix(prefix, resultsLength) {
  const normalizedPrefix = String(prefix || "");
  const depth = normalizedPrefix.length;
  if (depth >= SYMBOL_SEARCH_PREFIX_DEPTH) {
    return false;
  }

  if (SYMBOL_SYNC_FORCE_EXPAND_DEPTHS.has(depth)) {
    return true;
  }

  return resultsLength >= SYMBOL_SYNC_MAX_RESULTS;
}

async function runSymbolDiscoveryPass({ roots, discovered, summary, passLabel }) {
  const queue = Array.isArray(roots) ? [...roots] : [];
  const passSummary = {
    passLabel,
    rootsAttempted: queue.length,
    prefixesScanned: 0,
    prefixesQueuedStart: queue.length,
    prefixesExpanded: 0,
    prefixesTruncated: 0,
    symbolsBefore: discovered.size,
    symbolsAfter: discovered.size,
    symbolsAdded: 0,
    earlyStopped: false,
    earlyStopReason: null
  };
  let lastGrowthScan = 0;

  while (queue.length > 0) {
    const prefix = queue.shift();
    passSummary.prefixesScanned += 1;
    summary.prefixesScanned += 1;
    const symbolsBeforeScan = discovered.size;

    try {
      const results = await searchContracts(prefix, SYMBOL_SYNC_MAX_RESULTS);
      for (const item of results) {
        const existing = discovered.get(item.symbol);
        if (!existing || item.isPrimaryListing) {
          discovered.set(item.symbol, item);
        }
      }

      if (shouldExpandSymbolPrefix(prefix, results.length)) {
        passSummary.prefixesExpanded += 1;
        passSummary.prefixesTruncated += 1;
        summary.prefixesExpanded += 1;
        summary.prefixesTruncated += 1;
        for (const next of SYMBOL_SEARCH_ALPHABET) {
          queue.push(prefix + next);
        }
      }

      summary.prefixesQueued = queue.length;
    } catch (error) {
      summary.errors.push({
        pass: passLabel,
        prefix,
        status: error?.status || null,
        message: error?.message || "Unknown error"
      });
      lastCollectorError = {
        at: new Date().toISOString(),
        scope: "symbolSync",
        message: `${passLabel}:${error?.message || "Unknown error"}`
      };
    }

    if (discovered.size > symbolsBeforeScan) {
      lastGrowthScan = passSummary.prefixesScanned;
    }

    const scansSinceGrowth = passSummary.prefixesScanned - lastGrowthScan;
    const prefixLength = String(prefix || "").length;
    if (
      SYMBOL_SYNC_EARLY_STOP_ENABLED &&
      discovered.size >= SYMBOL_SYNC_TARGET_COUNT &&
      prefixLength >= SYMBOL_SYNC_EARLY_STOP_MIN_PREFIX_LENGTH &&
      scansSinceGrowth >= SYMBOL_SYNC_EARLY_STOP_NO_GROWTH_SCANS
    ) {
      passSummary.earlyStopped = true;
      passSummary.earlyStopReason = `Reached ${discovered.size} symbols and no growth for ${scansSinceGrowth} scans at prefix length ${prefixLength}+`;
      console.log(
        `[collector] symbol sync ${passLabel} early stop: ${passSummary.earlyStopReason}`
      );
      break;
    }

    if (
      SYMBOL_SYNC_PROGRESS_EVERY > 0 &&
      (
        passSummary.prefixesScanned === 1 ||
        passSummary.prefixesScanned % SYMBOL_SYNC_PROGRESS_EVERY === 0 ||
        queue.length === 0
      )
    ) {
      console.log(
        `[collector] symbol sync ${passLabel} progress ${passSummary.prefixesScanned} scanned, ${queue.length} queued, ${discovered.size} symbols, latest prefix ${prefix}`
      );
    }
  }

  passSummary.symbolsAfter = discovered.size;
  passSummary.symbolsAdded = passSummary.symbolsAfter - passSummary.symbolsBefore;
  return passSummary;
}

async function runAlternateSymbolDiscoveryPasses(discovered, summary) {
  if (!SYMBOL_SYNC_ALT_PASSES_ENABLED || discovered.size >= SYMBOL_SYNC_TARGET_COUNT) {
    return [];
  }

  const alternateModes = Array.from(new Set(SYMBOL_SYNC_ALT_ROOT_MODES))
    .filter(Boolean)
    .slice(0, Math.max(0, SYMBOL_SYNC_ALT_PASS_LIMIT));

  const passSummaries = [];
  for (const mode of alternateModes) {
    if (discovered.size >= SYMBOL_SYNC_TARGET_COUNT) {
      break;
    }

    const roots = reorderRoots(SYMBOL_SEARCH_ROOTS, mode);
    console.log(
      `[collector] symbol sync alternate pass starting (${mode}, ${roots.length} roots, current ${discovered.size}/${SYMBOL_SYNC_TARGET_COUNT})`
    );
    const passSummary = await runSymbolDiscoveryPass({
      roots,
      discovered,
      summary,
      passLabel: `alt:${mode}`
    });
    passSummaries.push({
      mode,
      rootsAttempted: passSummary.rootsAttempted,
      prefixesScanned: passSummary.prefixesScanned,
      prefixesExpanded: passSummary.prefixesExpanded,
      symbolsAdded: passSummary.symbolsAdded,
      symbolsAfter: passSummary.symbolsAfter
    });
    console.log(
      `[collector] symbol sync alternate pass complete (${mode}, +${passSummary.symbolsAdded}, now ${passSummary.symbolsAfter}/${SYMBOL_SYNC_TARGET_COUNT})`
    );
  }

  return passSummaries;
}

function takeNextBatch(stageName, symbols) {
  const cursor = workerCursors[stageName] || { offset: 0, passesCompleted: 0 };
  const batchSize = Math.max(1, getBatchSizeForStage(stageName));

  if (symbols.length === 0) {
    workerCursors[stageName] = { ...cursor, offset: 0 };
    return {
      symbols: [],
      startOffset: 0,
      endOffset: 0,
      batchSize,
      completedPass: false,
      passNumber: cursor.passesCompleted + 1
    };
  }

  const startOffset = Math.min(cursor.offset, Math.max(symbols.length - 1, 0));
  const endOffsetExclusive = Math.min(startOffset + batchSize, symbols.length);
  const batchSymbols = symbols.slice(startOffset, endOffsetExclusive);
  const completedPass = endOffsetExclusive >= symbols.length;

  workerCursors[stageName] = {
    offset: completedPass ? 0 : endOffsetExclusive,
    passesCompleted: cursor.passesCompleted + (completedPass ? 1 : 0)
  };

  return {
    symbols: batchSymbols,
    startOffset,
    endOffset: endOffsetExclusive,
    batchSize,
    completedPass,
    passNumber: cursor.passesCompleted + 1
  };
}

function getMarketTimeParts(now = new Date()) {
  const parts = {};
  for (const part of marketTimeFormatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return parts;
}

function getMarketClockDate(now = new Date()) {
  return new Date(now.toLocaleString("en-US", { timeZone: COLLECTOR_MARKET_TIMEZONE }));
}

function msUntilNextMarketMidnight(now = new Date()) {
  const marketNow = getMarketClockDate(now);
  const nextMarketMidnight = new Date(marketNow);
  nextMarketMidnight.setHours(24, 0, 0, 0);
  return Math.max(nextMarketMidnight.getTime() - marketNow.getTime(), 1_000);
}

function buildCollectorStatus() {
  return {
    updatedAt: new Date().toISOString(),
    lastError: lastCollectorError,
    scheduler: schedulerState,
    quoteRefresh: {
      running: isRefreshingQuotes,
      currentProgress: currentQuoteRefreshProgress,
      lastSummary: lastQuoteRefreshSummary
    },
    chartRefresh: {
      running: isRefreshingCharts,
      currentProgress: currentChartRefreshProgress,
      lastSummary: lastChartRefreshSummary
    },
    auth: authState,
    stages: stageState,
    symbolSync: {
      running: isSyncingSymbols,
      lastSummary: lastSymbolSyncSummary
    }
  };
}

function persistCollectorStatus() {
  writeCollectorStatus(buildCollectorStatus());
}

function isAuthError(error) {
  return Boolean(error?.isAuthFailure || error?.status === 401 || error?.status === 403);
}

async function refreshCookieWithRetry(reason = "scheduled-refresh") {
  let lastError = null;

  for (let attempt = 1; attempt <= AUTH_REFRESH_RETRY_COUNT; attempt += 1) {
    try {
      await refreshCookie();
      authState = {
        healthy: true,
        lastCheckedAt: new Date().toISOString(),
        lastRecoveredAt: new Date().toISOString(),
        lastFailureAt: authState.lastFailureAt,
        lastFailureReason: null
      };
      lastCollectorError = null;
      persistCollectorStatus();
      return { ok: true, attempt };
    } catch (error) {
      lastError = error;
      authState = {
        ...authState,
        healthy: false,
        lastCheckedAt: new Date().toISOString(),
        lastFailureAt: new Date().toISOString(),
        lastFailureReason: `${reason}: ${error.message || "Unknown error"}`
      };
      lastCollectorError = {
        at: new Date().toISOString(),
        scope: "cookieRefresh",
        message: error.message || "Unknown error"
      };
      persistCollectorStatus();
      if (attempt < AUTH_REFRESH_RETRY_COUNT) {
        await sleep(AUTH_REFRESH_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error("Cookie refresh failed.");
}

async function ensureHealthyAuth(reason = "auth-check") {
  if (authState.healthy) {
    authState = {
      ...authState,
      lastCheckedAt: new Date().toISOString()
    };
    return { ok: true, reused: true };
  }

  if (!authRefreshPromise) {
    authRefreshPromise = refreshCookieWithRetry(reason)
      .finally(() => {
        authRefreshPromise = null;
      });
  }

  return authRefreshPromise;
}

async function recoverAuth(reason = "auth-recovery") {
  authState = {
    ...authState,
    healthy: false,
    lastCheckedAt: new Date().toISOString(),
    lastFailureReason: reason
  };
  persistCollectorStatus();

  if (!authRefreshPromise) {
    authRefreshPromise = refreshCookieWithRetry(reason)
      .finally(() => {
        authRefreshPromise = null;
      });
  }

  return authRefreshPromise;
}

function isStageEnabled(stageName) {
  if (stageName === "quote") {
    return true;
  }
  return CHART_COLLECTION_ENABLED && CHART_INTERVAL_KEYS.includes(stageName);
}

function getCollectorMode(now = new Date()) {
  const parts = getMarketTimeParts(now);
  const weekday = parts.weekday || "";
  const hour = Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const minutesSinceMidnight = hour * 60 + minute;
  const marketOpenMinute = (COLLECTOR_MARKET_OPEN_HOUR * 60) + COLLECTOR_MARKET_OPEN_MINUTE;
  const marketCloseMinute = (COLLECTOR_MARKET_CLOSE_HOUR * 60) + COLLECTOR_MARKET_CLOSE_MINUTE;
  if (isWeekday && minutesSinceMidnight >= marketOpenMinute && minutesSinceMidnight < marketCloseMinute) {
    return "market";
  }
  return "closed";
}

function getStageOrderForMode(mode) {
  if (mode !== "market") {
    return [];
  }
  return COLLECTOR_MARKET_STAGE_ORDER
    .filter((stageName) => isStageEnabled(stageName));
}

function getActiveStageSetForMode(mode) {
  return new Set(getStageOrderForMode(mode));
}

function shouldRunStage(stageName) {
  const stage = stageState[stageName];
  if (!stage || stage.running) {
    return false;
  }

  const minGapMs = STAGE_MIN_GAP_MS[stageName] ?? 60_000;
  if (!stage.lastFinishedAt) {
    return true;
  }

  return Date.now() - new Date(stage.lastFinishedAt).getTime() >= minGapMs;
}

function updateStageState(stageName, patch) {
  if (!stageState[stageName]) {
    return;
  }
  stageState[stageName] = {
    ...stageState[stageName],
    ...patch
  };
  persistCollectorStatus();
}

async function refreshQuotesOnce() {
  if (isRefreshingQuotes) {
    return { skipped: true, reason: "Quote refresh already running." };
  }

  isRefreshingQuotes = true;
  persistCollectorStatus();
  const startedAt = Date.now();
  const symbols = readSymbols();
  const batches = chunk(symbols, QUOTE_BATCH_SIZE);
  let success = 0;
  let failedSymbols = 0;
  let failedBatches = 0;
  const errors = [];
  const batchDurations = [];
  currentQuoteRefreshProgress = {
    startedAt: new Date(startedAt).toISOString(),
    symbolsAttempted: symbols.length,
    batchesAttempted: batches.length,
    batchIndex: 0,
    success: 0,
    failedSymbols: 0
  };
  persistCollectorStatus();

  try {
    try {
      await ensureHealthyAuth("quote-refresh-start");
    } catch (error) {
      console.error(`[collector] quote refresh paused: ${error.message || "Auth unavailable"}`);
      return {
        skipped: true,
        reason: "Auth unavailable for quote refresh."
      };
    }

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchStartedAt = Date.now();
      currentQuoteRefreshProgress.batchIndex = index + 1;
      try {
        const quotes = await fetchQuotesBatch(batch);
        upsertQuotesBatch(quotes);
        success += quotes.length;
        failedSymbols += Math.max(batch.length - quotes.length, 0);
        if (quotes.length < batch.length) {
          errors.push(`Batch returned ${quotes.length}/${batch.length} quotes.`);
        }
      } catch (error) {
        if (isAuthError(error)) {
          console.error(`[collector] quote batch auth failure, attempting recovery (${error.message || "Unknown error"})`);
          try {
            await recoverAuth("quote-batch-auth-failure");
            const retryQuotes = await fetchQuotesBatch(batch);
            upsertQuotesBatch(retryQuotes);
            success += retryQuotes.length;
            failedSymbols += Math.max(batch.length - retryQuotes.length, 0);
            if (retryQuotes.length < batch.length) {
              errors.push(`Batch returned ${retryQuotes.length}/${batch.length} quotes after auth recovery.`);
            }
            currentQuoteRefreshProgress.success = success;
            currentQuoteRefreshProgress.failedSymbols = failedSymbols;
            persistCollectorStatus();
            continue;
          } catch (recoveryError) {
            failedBatches += 1;
            failedSymbols += batch.length;
            lastCollectorError = {
              at: new Date().toISOString(),
              scope: "quoteRefresh",
              message: recoveryError.message || "Auth recovery failed"
            };
            console.error(`[collector] quote auth recovery failed: ${recoveryError.message || "Unknown error"}`);
            break;
          }
        }
        failedBatches += 1;
        failedSymbols += batch.length;
        lastCollectorError = {
          at: new Date().toISOString(),
          scope: "quoteRefresh",
          message: error.message || "Unknown error"
        };
        console.error(`[collector] quote batch failed: ${error.message || "Unknown error"}`);
      }

      currentQuoteRefreshProgress.success = success;
      currentQuoteRefreshProgress.failedSymbols = failedSymbols;
      persistCollectorStatus();
      batchDurations.push(Date.now() - batchStartedAt);
      console.log(`[collector] batch ${index + 1}/${batches.length} complete (${success}/${symbols.length} quotes updated so far)`);

      if (QUOTE_BATCH_PAUSE_MS > 0) {
        await sleep(QUOTE_BATCH_PAUSE_MS);
      }
    }

    const durationMs = Date.now() - startedAt;
    lastQuoteRefreshSummary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      symbolsAttempted: symbols.length,
      batchesAttempted: batches.length,
      success,
      failedSymbols,
      failedBatches,
      errors,
      durationMs,
      ...summarizeBatchTimings(batchDurations, success, durationMs)
    };

    lastCollectorError = null;
    console.log(`[collector] quote refresh complete in ${lastQuoteRefreshSummary.durationMs}ms (${success}/${symbols.length} quotes updated, avg batch ${lastQuoteRefreshSummary.avgBatchDurationMs}ms, ${lastQuoteRefreshSummary.unitsPerSecond} qps)`);
    persistCollectorStatus();
    return lastQuoteRefreshSummary;
  } finally {
    isRefreshingQuotes = false;
    currentQuoteRefreshProgress = null;
    persistCollectorStatus();
  }
}

async function refreshQuoteBatchOnce() {
  if (isRefreshingQuotes) {
    return { skipped: true, reason: "Quote refresh already running." };
  }

  isRefreshingQuotes = true;
  persistCollectorStatus();

  const startedAt = Date.now();
  const symbols = getSymbolsForStage("quote");
  const batch = takeNextBatch("quote", symbols);
  const errors = [];
  let success = 0;
  let failedSymbols = 0;
  let failedBatches = 0;

  currentQuoteRefreshProgress = {
    startedAt: new Date(startedAt).toISOString(),
    symbolsAttempted: symbols.length,
    batchesAttempted: 1,
    batchIndex: batch.passNumber,
    cursorStart: batch.startOffset,
    cursorEnd: batch.endOffset,
    success: 0,
    failedSymbols: 0
  };
  persistCollectorStatus();

  try {
    if (batch.symbols.length === 0) {
      return { skipped: true, reason: "No symbols available for quote batch." };
    }

    try {
      await ensureHealthyAuth("quote-batch-start");
    } catch (error) {
      console.error(`[collector] rolling quote batch paused: ${error.message || "Auth unavailable"}`);
      return { skipped: true, reason: "Auth unavailable for rolling quote batch." };
    }

    try {
      const quotes = await fetchQuotesBatch(batch.symbols);
      upsertQuotesBatch(quotes);
      success = quotes.length;
      failedSymbols = Math.max(batch.symbols.length - quotes.length, 0);
      maybeLogWeakBatchDiagnostics("quote", batch, batch.symbols, quotes);
      if (quotes.length < batch.symbols.length) {
        errors.push(`Batch returned ${quotes.length}/${batch.symbols.length} quotes.`);
      }
    } catch (error) {
      if (isAuthError(error)) {
        console.error(`[collector] rolling quote batch auth failure, attempting recovery (${error.message || "Unknown error"})`);
        try {
          await recoverAuth("rolling-quote-batch-auth-failure");
          const retryQuotes = await fetchQuotesBatch(batch.symbols);
          upsertQuotesBatch(retryQuotes);
          success = retryQuotes.length;
          failedSymbols = Math.max(batch.symbols.length - retryQuotes.length, 0);
          maybeLogWeakBatchDiagnostics("quote", batch, batch.symbols, retryQuotes);
          if (retryQuotes.length < batch.symbols.length) {
            errors.push(`Batch returned ${retryQuotes.length}/${batch.symbols.length} quotes after auth recovery.`);
          }
        } catch (recoveryError) {
          failedBatches = 1;
          failedSymbols = batch.symbols.length;
          lastCollectorError = {
            at: new Date().toISOString(),
            scope: "quoteRefresh",
            message: recoveryError.message || "Auth recovery failed"
          };
          console.error(`[collector] rolling quote auth recovery failed: ${recoveryError.message || "Unknown error"}`);
        }
      } else {
        failedBatches = 1;
        failedSymbols = batch.symbols.length;
        lastCollectorError = {
          at: new Date().toISOString(),
          scope: "quoteRefresh",
          message: error.message || "Unknown error"
        };
        console.error(`[collector] rolling quote batch failed: ${error.message || "Unknown error"}`);
      }
    }

    currentQuoteRefreshProgress.success = success;
    currentQuoteRefreshProgress.failedSymbols = failedSymbols;
    persistCollectorStatus();

    const durationMs = Date.now() - startedAt;
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      symbolsAttempted: symbols.length,
      batchSizeRequested: batch.batchSize,
      batchSymbols: batch.symbols.length,
      cursorStart: batch.startOffset,
      cursorEnd: batch.endOffset,
      passNumber: batch.passNumber,
      completedPass: batch.completedPass,
      success,
      failedSymbols,
      failedBatches,
      errors,
      durationMs,
      unitsPerSecond: durationMs > 0 ? Number((success / (durationMs / 1000)).toFixed(2)) : 0
    };

    lastQuoteRefreshSummary = summary;
    if (failedBatches === 0) {
      lastCollectorError = null;
    }
    console.log(`[collector] rolling quote batch ${batch.startOffset}-${batch.endOffset}/${symbols.length} complete in ${durationMs}ms (${success}/${batch.symbols.length} quotes, pass ${batch.passNumber}, ${summary.unitsPerSecond} qps)`);
    persistCollectorStatus();
    return summary;
  } finally {
    isRefreshingQuotes = false;
    currentQuoteRefreshProgress = null;
    persistCollectorStatus();
  }
}

async function refreshChartIntervalOnce(intervalKey) {
  if (!CHART_COLLECTION_ENABLED) {
    return { skipped: true, reason: "Chart collection is disabled." };
  }

  if (isRefreshingCharts) {
    return { skipped: true, reason: "Chart refresh already running." };
  }

  isRefreshingCharts = true;
  persistCollectorStatus();

  const startedAt = Date.now();
  const symbols = getChartSymbolsForInterval(intervalKey);
  const batches = chunk(symbols, CHART_BATCH_SIZE);
  let success = 0;
  let failedSymbols = 0;
  let failedBatches = 0;
  const errors = [];
  const batchDurations = [];

  currentChartRefreshProgress = {
    startedAt: new Date(startedAt).toISOString(),
    symbolsAttempted: symbols.length,
    intervalKeys: [intervalKey],
    batchesAttempted: batches.length,
    totalTasks: batches.length,
    completedTasks: 0,
    currentIntervalKey: intervalKey,
    batchIndex: 0,
    success: 0,
    failedSymbols: 0
  };
  persistCollectorStatus();

  try {
    try {
      await ensureHealthyAuth(`chart-refresh-start:${intervalKey}`);
    } catch (error) {
      console.error(`[collector] chart refresh paused (${intervalKey}): ${error.message || "Auth unavailable"}`);
      return {
        skipped: true,
        reason: `Auth unavailable for chart refresh (${intervalKey}).`
      };
    }

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchStartedAt = Date.now();
      currentChartRefreshProgress.batchIndex = index + 1;

      try {
        const charts = await fetchChartsBatch(batch, intervalKey);
        upsertChartsBatch(charts, intervalKey);
        success += charts.length;
        failedSymbols += Math.max(batch.length - charts.length, 0);
        if (charts.length < batch.length) {
          errors.push(`${intervalKey} batch returned ${charts.length}/${batch.length} charts.`);
        }
      } catch (error) {
        if (isAuthError(error)) {
          console.error(`[collector] chart batch auth failure, attempting recovery (${intervalKey})`);
          try {
            await recoverAuth(`chart-batch-auth-failure:${intervalKey}`);
            const retryCharts = await fetchChartsBatch(batch, intervalKey);
            upsertChartsBatch(retryCharts, intervalKey);
            success += retryCharts.length;
            failedSymbols += Math.max(batch.length - retryCharts.length, 0);
            if (retryCharts.length < batch.length) {
              errors.push(`${intervalKey} batch returned ${retryCharts.length}/${batch.length} charts after auth recovery.`);
            }
            currentChartRefreshProgress.completedTasks = index + 1;
            currentChartRefreshProgress.success = success;
            currentChartRefreshProgress.failedSymbols = failedSymbols;
            persistCollectorStatus();
            continue;
          } catch (recoveryError) {
            lastCollectorError = {
              at: new Date().toISOString(),
              scope: "chartRefresh",
              message: recoveryError.message || "Auth recovery failed"
            };
            console.error(`[collector] chart auth recovery failed: ${recoveryError.message || "Unknown error"}`);
            return {
              skipped: true,
              reason: `Chart refresh (${intervalKey}) stopped due to auth recovery failure.`
            };
          }
        }
        failedBatches += 1;
        failedSymbols += batch.length;
        lastCollectorError = {
          at: new Date().toISOString(),
          scope: "chartRefresh",
          message: error.message || "Unknown error"
        };
        console.error(`[collector] chart batch failed (${intervalKey}): ${error.message || "Unknown error"}`);
      }

      currentChartRefreshProgress.completedTasks = index + 1;
      currentChartRefreshProgress.success = success;
      currentChartRefreshProgress.failedSymbols = failedSymbols;
      persistCollectorStatus();
      batchDurations.push(Date.now() - batchStartedAt);
      console.log(`[collector] chart ${intervalKey} batch ${index + 1}/${batches.length} complete`);

      if (CHART_BATCH_PAUSE_MS > 0) {
        await sleep(CHART_BATCH_PAUSE_MS);
      }
    }

    const durationMs = Date.now() - startedAt;
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      symbolsAttempted: symbols.length,
      intervalKey,
      batchesAttempted: batches.length,
      success,
      failedSymbols,
      failedBatches,
      errors,
      durationMs,
      ...summarizeBatchTimings(batchDurations, success, durationMs)
    };

    lastChartRefreshSummary = summary;
    lastCollectorError = null;
    console.log(`[collector] chart ${intervalKey} refresh complete in ${summary.durationMs}ms (${success}/${symbols.length} charts updated, avg batch ${summary.avgBatchDurationMs}ms, ${summary.unitsPerSecond} cps)`);
    persistCollectorStatus();
    return summary;
  } finally {
    isRefreshingCharts = false;
    currentChartRefreshProgress = null;
    persistCollectorStatus();
  }
}

async function refreshChartBatchOnce(intervalKey) {
  if (!CHART_COLLECTION_ENABLED) {
    return { skipped: true, reason: "Chart collection is disabled." };
  }

  if (isRefreshingCharts) {
    return { skipped: true, reason: "Chart refresh already running." };
  }

  isRefreshingCharts = true;
  persistCollectorStatus();

  const startedAt = Date.now();
  const symbols = getSymbolsForStage(intervalKey);
  const batch = takeNextBatch(intervalKey, symbols);
  const errors = [];
  let success = 0;
  let failedSymbols = 0;
  let failedBatches = 0;

  currentChartRefreshProgress = {
    startedAt: new Date(startedAt).toISOString(),
    symbolsAttempted: symbols.length,
    intervalKeys: [intervalKey],
    batchesAttempted: 1,
    totalTasks: 1,
    completedTasks: 0,
    currentIntervalKey: intervalKey,
    batchIndex: batch.passNumber,
    cursorStart: batch.startOffset,
    cursorEnd: batch.endOffset,
    success: 0,
    failedSymbols: 0
  };
  persistCollectorStatus();

  try {
    if (batch.symbols.length === 0) {
      return { skipped: true, reason: `No symbols available for ${intervalKey} chart batch.` };
    }

    try {
      await ensureHealthyAuth(`chart-batch-start:${intervalKey}`);
    } catch (error) {
      console.error(`[collector] rolling chart batch paused (${intervalKey}): ${error.message || "Auth unavailable"}`);
      return { skipped: true, reason: `Auth unavailable for rolling ${intervalKey} chart batch.` };
    }

    try {
      const charts = await fetchChartsBatch(batch.symbols, intervalKey);
      upsertChartsBatch(charts, intervalKey);
      success = charts.length;
      failedSymbols = Math.max(batch.symbols.length - charts.length, 0);
      maybeLogWeakBatchDiagnostics(`chart-${intervalKey}`, batch, batch.symbols, charts);
      if (charts.length < batch.symbols.length) {
        errors.push(`${intervalKey} batch returned ${charts.length}/${batch.symbols.length} charts.`);
      }
    } catch (error) {
      if (isAuthError(error)) {
        console.error(`[collector] rolling chart batch auth failure, attempting recovery (${intervalKey})`);
        try {
          await recoverAuth(`rolling-chart-batch-auth-failure:${intervalKey}`);
          const retryCharts = await fetchChartsBatch(batch.symbols, intervalKey);
          upsertChartsBatch(retryCharts, intervalKey);
          success = retryCharts.length;
          failedSymbols = Math.max(batch.symbols.length - retryCharts.length, 0);
          maybeLogWeakBatchDiagnostics(`chart-${intervalKey}`, batch, batch.symbols, retryCharts);
          if (retryCharts.length < batch.symbols.length) {
            errors.push(`${intervalKey} batch returned ${retryCharts.length}/${batch.symbols.length} charts after auth recovery.`);
          }
        } catch (recoveryError) {
          failedBatches = 1;
          failedSymbols = batch.symbols.length;
          lastCollectorError = {
            at: new Date().toISOString(),
            scope: "chartRefresh",
            message: recoveryError.message || "Auth recovery failed"
          };
          console.error(`[collector] rolling chart auth recovery failed: ${recoveryError.message || "Unknown error"}`);
        }
      } else {
        failedBatches = 1;
        failedSymbols = batch.symbols.length;
        lastCollectorError = {
          at: new Date().toISOString(),
          scope: "chartRefresh",
          message: error.message || "Unknown error"
        };
        console.error(`[collector] rolling chart batch failed (${intervalKey}): ${error.message || "Unknown error"}`);
      }
    }

    currentChartRefreshProgress.completedTasks = 1;
    currentChartRefreshProgress.success = success;
    currentChartRefreshProgress.failedSymbols = failedSymbols;
    persistCollectorStatus();

    const durationMs = Date.now() - startedAt;
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      symbolsAttempted: symbols.length,
      intervalKey,
      batchSizeRequested: batch.batchSize,
      batchSymbols: batch.symbols.length,
      cursorStart: batch.startOffset,
      cursorEnd: batch.endOffset,
      passNumber: batch.passNumber,
      completedPass: batch.completedPass,
      success,
      failedSymbols,
      failedBatches,
      errors,
      durationMs,
      unitsPerSecond: durationMs > 0 ? Number((success / (durationMs / 1000)).toFixed(2)) : 0
    };

    lastChartRefreshSummary = summary;
    if (failedBatches === 0) {
      lastCollectorError = null;
    }
    console.log(`[collector] rolling chart ${intervalKey} batch ${batch.startOffset}-${batch.endOffset}/${symbols.length} complete in ${durationMs}ms (${success}/${batch.symbols.length} charts, pass ${batch.passNumber}, ${summary.unitsPerSecond} cps)`);
    persistCollectorStatus();
    return summary;
  } finally {
    isRefreshingCharts = false;
    currentChartRefreshProgress = null;
    persistCollectorStatus();
  }
}

async function refreshChartsOnce() {
  if (!CHART_COLLECTION_ENABLED) {
    return { skipped: true, reason: "Chart collection is disabled." };
  }

  if (isRefreshingCharts) {
    return { skipped: true, reason: "Chart refresh already running." };
  }

  isRefreshingCharts = true;
  persistCollectorStatus();

  const startedAt = Date.now();
  const totalTasks = CHART_INTERVAL_KEYS.reduce((sum, intervalKey) => {
    return sum + chunk(getChartSymbolsForInterval(intervalKey), CHART_BATCH_SIZE).length;
  }, 0);
  let completedTasks = 0;
  let success = 0;
  let failedSymbols = 0;
  let failedBatches = 0;
  const errors = [];
  const batchDurations = [];

  currentChartRefreshProgress = {
    startedAt: new Date(startedAt).toISOString(),
    symbolsAttempted: readSymbols().length,
    intervalKeys: CHART_INTERVAL_KEYS,
    batchesAttempted: totalTasks,
    totalTasks,
    completedTasks: 0,
    currentIntervalKey: CHART_INTERVAL_KEYS[0] || null,
    batchIndex: 0,
    success: 0,
    failedSymbols: 0
  };
  persistCollectorStatus();

  try {
    try {
      await ensureHealthyAuth("chart-refresh-start");
    } catch (error) {
      console.error(`[collector] chart refresh paused: ${error.message || "Auth unavailable"}`);
      return {
        skipped: true,
        reason: "Auth unavailable for chart refresh."
      };
    }

    for (const intervalKey of CHART_INTERVAL_KEYS) {
      const symbols = getChartSymbolsForInterval(intervalKey);
      const batches = chunk(symbols, CHART_BATCH_SIZE);
      currentChartRefreshProgress.currentIntervalKey = intervalKey;

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const batchStartedAt = Date.now();
        currentChartRefreshProgress.batchIndex = index + 1;

        try {
          const charts = await fetchChartsBatch(batch, intervalKey);
          upsertChartsBatch(charts, intervalKey);
          success += charts.length;
          failedSymbols += Math.max(batch.length - charts.length, 0);
          if (charts.length < batch.length) {
            errors.push(`${intervalKey} batch returned ${charts.length}/${batch.length} charts.`);
          }
        } catch (error) {
          if (isAuthError(error)) {
            console.error(`[collector] chart batch auth failure, attempting recovery (${intervalKey})`);
            try {
              await recoverAuth(`chart-batch-auth-failure:${intervalKey}`);
              const retryCharts = await fetchChartsBatch(batch, intervalKey);
              upsertChartsBatch(retryCharts, intervalKey);
              success += retryCharts.length;
              failedSymbols += Math.max(batch.length - retryCharts.length, 0);
              if (retryCharts.length < batch.length) {
                errors.push(`${intervalKey} batch returned ${retryCharts.length}/${batch.length} charts after auth recovery.`);
              }
              completedTasks += 1;
              currentChartRefreshProgress.completedTasks = completedTasks;
              currentChartRefreshProgress.success = success;
              currentChartRefreshProgress.failedSymbols = failedSymbols;
              persistCollectorStatus();
              continue;
            } catch (recoveryError) {
              lastCollectorError = {
                at: new Date().toISOString(),
                scope: "chartRefresh",
                message: recoveryError.message || "Auth recovery failed"
              };
              console.error(`[collector] chart auth recovery failed: ${recoveryError.message || "Unknown error"}`);
              return {
                skipped: true,
                reason: "Chart refresh stopped due to auth recovery failure."
              };
            }
          }
          failedBatches += 1;
          failedSymbols += batch.length;
          lastCollectorError = {
            at: new Date().toISOString(),
            scope: "chartRefresh",
            message: error.message || "Unknown error"
          };
          console.error(`[collector] chart batch failed (${intervalKey}): ${error.message || "Unknown error"}`);
        }

        completedTasks += 1;
        currentChartRefreshProgress.completedTasks = completedTasks;
        currentChartRefreshProgress.success = success;
        currentChartRefreshProgress.failedSymbols = failedSymbols;
        persistCollectorStatus();
        batchDurations.push(Date.now() - batchStartedAt);
        console.log(`[collector] chart ${intervalKey} batch ${index + 1}/${batches.length} complete (${completedTasks}/${totalTasks} tasks)`);

        if (CHART_BATCH_PAUSE_MS > 0) {
          await sleep(CHART_BATCH_PAUSE_MS);
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    lastChartRefreshSummary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      symbolsAttempted: readSymbols().length,
      intervalKeys: CHART_INTERVAL_KEYS,
      batchesAttempted: totalTasks,
      totalTasks,
      success,
      failedSymbols,
      failedBatches,
      errors,
      durationMs,
      ...summarizeBatchTimings(batchDurations, success, durationMs)
    };

    lastCollectorError = null;
    console.log(`[collector] chart refresh complete in ${lastChartRefreshSummary.durationMs}ms (${success} charts cached, avg batch ${lastChartRefreshSummary.avgBatchDurationMs}ms, ${lastChartRefreshSummary.unitsPerSecond} cps)`);
    persistCollectorStatus();
    return lastChartRefreshSummary;
  } finally {
    isRefreshingCharts = false;
    currentChartRefreshProgress = null;
    persistCollectorStatus();
  }
}

async function refreshCookieOnce() {
  try {
    await refreshCookieWithRetry("scheduled-cookie-refresh");
  } catch (error) {
    console.error(`[collector] cookie refresh failed: ${error.message || "Unknown error"}`);
  }
}

async function runStage(stageName) {
  const startedAt = new Date().toISOString();
  updateStageState(stageName, {
    running: true,
    lastStartedAt: startedAt,
    lastError: null
  });

  try {
    let summary;
    if (stageName === "quote") {
      summary = await refreshQuotesOnce();
    } else {
      summary = await refreshChartIntervalOnce(stageName);
    }

    updateStageState(stageName, {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastSummary: summary || null
    });
    return summary;
  } catch (error) {
    const stageError = {
      at: new Date().toISOString(),
      message: error.message || "Unknown error"
    };
    updateStageState(stageName, {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastError: stageError
    });
    throw error;
  }
}

async function startCollectorLoop() {
  if (!COLLECTOR_SCHEDULER_ENABLED) {
    return;
  }

  if (collectorLoopPromise) {
    return collectorLoopPromise;
  }

  collectorLoopPromise = (async () => {
    schedulerState = {
      ...schedulerState,
      running: true
    };
    persistCollectorStatus();

    while (true) {
      const loopStartedAt = new Date().toISOString();
      const mode = getCollectorMode();
      schedulerState = {
        ...schedulerState,
        lastMode: mode,
        lastLoopStartedAt: loopStartedAt
      };
      persistCollectorStatus();

      const stageOrder = getStageOrderForMode(mode);
      for (const stageName of stageOrder) {
        if (!shouldRunStage(stageName)) {
          continue;
        }

        try {
          await runStage(stageName);
        } catch (error) {
          console.error(`[collector] stage ${stageName} failed: ${error.message || "Unknown error"}`);
        }
      }

      schedulerState = {
        ...schedulerState,
        lastLoopFinishedAt: new Date().toISOString()
      };
      persistCollectorStatus();
      await sleep(COLLECTOR_LOOP_PAUSE_MS);
    }
  })();

  return collectorLoopPromise;
}

async function runRollingStage(stageName) {
  const startedAt = new Date().toISOString();
  updateStageState(stageName, {
    running: true,
    lastStartedAt: startedAt,
    lastError: null
  });

  try {
    const summary = stageName === "quote"
      ? await refreshQuoteBatchOnce()
      : await refreshChartBatchOnce(stageName);

    updateStageState(stageName, {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastSummary: summary || null
    });
    return summary;
  } catch (error) {
    const stageError = {
      at: new Date().toISOString(),
      message: error.message || "Unknown error"
    };
    updateStageState(stageName, {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastError: stageError
    });
    throw error;
  }
}

function startRollingWorkers() {
  const stages = Array.from(new Set([
    ...COLLECTOR_MARKET_STAGE_ORDER,
    ...COLLECTOR_AFTER_HOURS_STAGE_ORDER
  ])).filter((stageName) => isStageEnabled(stageName));

  console.log(`[collector] rolling workers enabled (${stages.join(" | ")})`);

  schedulerState = {
    ...schedulerState,
    running: true
  };
  persistCollectorStatus();

  for (const stageName of stages) {
    if (workerLoopPromises.has(stageName)) {
      continue;
    }

    const loopPromise = (async () => {
      while (true) {
        const mode = getCollectorMode();
        schedulerState = {
          ...schedulerState,
          lastMode: mode,
          lastLoopStartedAt: new Date().toISOString()
        };
        persistCollectorStatus();

        const activeStages = getActiveStageSetForMode(mode);
        if (activeStages.has(stageName)) {
          try {
            await runRollingStage(stageName);
          } catch (error) {
            console.error(`[collector] rolling stage ${stageName} failed: ${error.message || "Unknown error"}`);
          }
        }

        schedulerState = {
          ...schedulerState,
          lastLoopFinishedAt: new Date().toISOString()
        };
        persistCollectorStatus();
        await sleepWithJitter(WORKER_LOOP_PAUSE_MS, WORKER_LOOP_JITTER_MS);
      }
    })();

    workerLoopPromises.set(stageName, loopPromise);
  }
}

async function runStartupChartStages() {
  if (!CHART_COLLECTION_ENABLED || STARTUP_CHART_STAGES.length === 0) {
    return;
  }

  console.log(`[collector] startup chart stages enabled (${STARTUP_CHART_STAGES.join(" > ")})`);

  for (const stageName of STARTUP_CHART_STAGES) {
    if (!isStageEnabled(stageName)) {
      console.log(`[collector] skipping startup stage ${stageName} because it is not enabled in CHART_INTERVAL_KEYS`);
      continue;
    }

    try {
      console.log(`[collector] startup stage ${stageName} starting`);
      await runStage(stageName);
      console.log(`[collector] startup stage ${stageName} finished`);
    } catch (error) {
      console.error(`[collector] startup stage ${stageName} failed: ${error.message || "Unknown error"}`);
    }
  }
}

function rankMissingSymbolsForFallback(previousSymbols, discovered) {
  return previousSymbols
    .filter((symbol) => !discovered.has(symbol))
    .sort((a, b) => {
      const aScore = a.length === 4 ? 0 : 1;
      const bScore = b.length === 4 ? 0 : 1;
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      return a.localeCompare(b);
    });
}

async function runSymbolSyncFallbackPass(previousSymbols, discovered, summary) {
  if (!SYMBOL_SYNC_FALLBACK_ENABLED || discovered.size >= SYMBOL_SYNC_TARGET_COUNT) {
    return;
  }

  const missingSymbols = rankMissingSymbolsForFallback(previousSymbols, discovered)
    .slice(0, Math.max(0, SYMBOL_SYNC_FALLBACK_PROBE_LIMIT));

  if (missingSymbols.length === 0) {
    return;
  }

  summary.fallbackProbeCount = missingSymbols.length;
  summary.fallbackRecoveredSymbols = 0;
  summary.fallbackRecoveredFourCharSymbols = 0;
  console.log(`[collector] symbol sync fallback probing ${missingSymbols.length} likely-missing symbols`);

  for (let index = 0; index < missingSymbols.length; index += 1) {
    const symbol = missingSymbols[index];

    try {
      const results = await searchContracts(symbol, SYMBOL_SYNC_FALLBACK_EXACT_RESULTS);
      const exactMatch = results.find((item) => item.symbol === symbol);
      if (exactMatch) {
        const existing = discovered.get(exactMatch.symbol);
        if (!existing || exactMatch.isPrimaryListing) {
          discovered.set(exactMatch.symbol, exactMatch);
          summary.fallbackRecoveredSymbols += 1;
          if (exactMatch.symbol.length === 4) {
            summary.fallbackRecoveredFourCharSymbols += 1;
          }
        }
      }
    } catch (error) {
      summary.errors.push({
        prefix: symbol,
        status: error?.status || null,
        message: `Fallback probe failed: ${error?.message || "Unknown error"}`
      });
    }

    if (
      SYMBOL_SYNC_PROGRESS_EVERY > 0 &&
      (
        index === 0 ||
        (index + 1) % SYMBOL_SYNC_PROGRESS_EVERY === 0 ||
        index + 1 === missingSymbols.length
      )
    ) {
      console.log(
        `[collector] symbol sync fallback progress ${index + 1}/${missingSymbols.length} probes (${summary.fallbackRecoveredSymbols} recovered, ${summary.fallbackRecoveredFourCharSymbols} four-char, latest ${symbol})`
      );
    }

    if (discovered.size >= SYMBOL_SYNC_TARGET_COUNT) {
      break;
    }
  }

  console.log(
    `[collector] symbol sync fallback complete (${summary.fallbackRecoveredSymbols} recovered, ${summary.fallbackRecoveredFourCharSymbols} four-char)`
  );
}

async function syncSymbolsOnce() {
  if (isSyncingSymbols) {
    return { skipped: true, reason: "Symbol sync already running." };
  }

  isSyncingSymbols = true;
  persistCollectorStatus();
  console.log("[collector] symbol sync starting");

  const summary = {
    startedAt: new Date().toISOString(),
    rootsAttempted: SYMBOL_SEARCH_ROOTS.length,
    alternatePassRootsAttempted: 0,
    prefixesScanned: 0,
    prefixesQueued: SYMBOL_SEARCH_ROOTS.length,
    prefixesExpanded: 0,
    prefixesTruncated: 0,
    symbolsFound: 0,
    targetSymbolCount: SYMBOL_SYNC_TARGET_COUNT,
    alternatePasses: [],
    errors: []
  };

  const previousSymbols = readSymbols();
  const discovered = new Map();

  try {
    const primaryPass = await runSymbolDiscoveryPass({
      roots: SYMBOL_SEARCH_ROOTS,
      discovered,
      summary,
      passLabel: "primary"
    });
    summary.primaryPass = {
      rootsAttempted: primaryPass.rootsAttempted,
      prefixesScanned: primaryPass.prefixesScanned,
      prefixesExpanded: primaryPass.prefixesExpanded,
      symbolsAdded: primaryPass.symbolsAdded,
      symbolsAfter: primaryPass.symbolsAfter
    };

    summary.symbolsFound = discovered.size;
    summary.targetGapBeforeAlternatePasses = Math.max(SYMBOL_SYNC_TARGET_COUNT - discovered.size, 0);

    if (discovered.size < SYMBOL_SYNC_TARGET_COUNT) {
      summary.alternatePasses = await runAlternateSymbolDiscoveryPasses(discovered, summary);
      summary.alternatePassRootsAttempted = summary.alternatePasses.reduce(
        (total, item) => total + (item.rootsAttempted || 0),
        0
      );
      summary.symbolsFound = discovered.size;
    }

    summary.targetGapBeforeFallback = Math.max(SYMBOL_SYNC_TARGET_COUNT - discovered.size, 0);

    if (discovered.size < SYMBOL_SYNC_TARGET_COUNT) {
      console.log(
        `[collector] symbol sync below target (${discovered.size}/${SYMBOL_SYNC_TARGET_COUNT}), starting fallback recovery`
      );
      await runSymbolSyncFallbackPass(previousSymbols, discovered, summary);
      summary.symbolsFound = discovered.size;
      summary.targetGapAfterFallback = Math.max(SYMBOL_SYNC_TARGET_COUNT - discovered.size, 0);
    }

    if (discovered.size >= MIN_SYMBOL_SYNC_COUNT) {
      const nextSymbols = writeSymbols(Array.from(discovered.keys()));
      const nextMeta = writeSymbolMeta(Object.fromEntries(
        Array.from(discovered.values())
          .filter((item) => item.name)
          .map((item) => [item.symbol, {
            name: item.name,
            productType: item.productType || "Stock"
          }])
      ));
      summary.symbolsFileUpdated = true;
      summary.finalSymbols = nextSymbols.length;
      summary.metaEntries = Object.keys(nextMeta).length;
    } else {
      summary.symbolsFileUpdated = false;
      summary.finalSymbols = readSymbols().length;
      summary.metaEntries = Object.keys(readSymbolMeta()).length;
      summary.preservedExistingSymbols = true;
      summary.preserveReason = `Preserved existing symbols because sync returned ${discovered.size}, below threshold ${MIN_SYMBOL_SYNC_COUNT}.`;
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - new Date(summary.startedAt).getTime();
    lastSymbolSyncSummary = summary;
    lastCollectorError = null;
    console.log(`[collector] symbol sync complete in ${summary.durationMs}ms (${summary.symbolsFound} symbols found)`);
    persistCollectorStatus();
    return summary;
  } finally {
    isSyncingSymbols = false;
    persistCollectorStatus();
  }
}

function scheduleNextSymbolSync() {
  if (!SYMBOL_SYNC_ENABLED) {
    return;
  }

  if (symbolSyncTimer) {
    clearTimeout(symbolSyncTimer);
    symbolSyncTimer = null;
  }

  const delayMs = SYMBOL_SYNC_AT_MIDNIGHT ? msUntilNextMarketMidnight() : SYMBOL_SYNC_INTERVAL_MS;
  const targetTime = new Date(Date.now() + delayMs).toISOString();
  console.log(`[collector] next symbol sync scheduled for ${targetTime}`);

  symbolSyncTimer = setTimeout(async () => {
    try {
      await syncSymbolsOnce();
    } catch (error) {
      lastCollectorError = {
        at: new Date().toISOString(),
        scope: "symbolSync",
        message: error.message || "Unknown error"
      };
      console.error(`[collector] symbol sync failed: ${error.message || "Unknown error"}`);
    } finally {
      persistCollectorStatus();
      scheduleNextSymbolSync();
    }
  }, delayMs);
}

async function startCollector() {
  ensureSeedFiles();
  persistCollectorStatus();
  console.log("[collector] starting");
  console.log(`[collector] collector mode ${COLLECTOR_MODE}`);
  console.log(`[collector] quote refresh every ${QUOTE_REFRESH_INTERVAL_MS}ms (batch size ${QUOTE_BATCH_SIZE}, pause ${QUOTE_BATCH_PAUSE_MS}ms)`);
  console.log(`[collector] cookie refresh every ${COOKIE_REFRESH_INTERVAL_MS}ms`);
  if (CHART_COLLECTION_ENABLED) {
    console.log(`[collector] chart refresh configured for ${CHART_INTERVAL_KEYS.join(", ")} (batch size ${CHART_BATCH_SIZE}, pause ${CHART_BATCH_PAUSE_MS}ms)`);
    if (MINUTE_CHART_SYMBOLS.length > 0) {
      console.log(`[collector] minute chart universe limited to ${MINUTE_CHART_SYMBOLS.length} configured symbols`);
    }
    if (STARTUP_CHART_STAGES.length > 0) {
      console.log(`[collector] startup chart preload configured for ${STARTUP_CHART_STAGES.join(", ")}`);
    }
  }
  if (SYMBOL_SYNC_ENABLED) {
    console.log(`[collector] symbol sync startup=${SYMBOL_SYNC_ON_STARTUP} midnight=${SYMBOL_SYNC_AT_MIDNIGHT}`);
  }
  if (COLLECTOR_MODE === "rolling") {
    console.log(`[collector] worker symbol order mode ${WORKER_SYMBOL_ORDER_MODE}`);
  }
  if (COLLECTOR_SCHEDULER_ENABLED && COLLECTOR_MODE !== "rolling") {
    console.log(`[collector] staged scheduler enabled (${COLLECTOR_MARKET_STAGE_ORDER.join(" > ")})`);
  }

  await refreshCookieOnce();

  if (SYMBOL_SYNC_ENABLED && SYMBOL_SYNC_ON_STARTUP) {
    console.log("[collector] startup symbol sync enabled");
    await syncSymbolsOnce();
  }

  if (STARTUP_CHART_STAGES.length > 0) {
    console.log("[collector] startup chart preload beginning");
  }
  await runStartupChartStages();
  if (STARTUP_CHART_STAGES.length > 0) {
    console.log("[collector] startup chart preload complete");
  }

  setInterval(() => {
    refreshCookieOnce();
  }, COOKIE_REFRESH_INTERVAL_MS);

  if (SYMBOL_SYNC_ENABLED) {
    scheduleNextSymbolSync();
  }

  if (COLLECTOR_MODE === "rolling") {
    startRollingWorkers();
    return;
  }

  if (COLLECTOR_SCHEDULER_ENABLED) {
    await startCollectorLoop();
    return;
  }

  await refreshQuotesOnce();

  setInterval(() => {
    refreshQuotesOnce();
  }, QUOTE_REFRESH_INTERVAL_MS);

  if (CHART_COLLECTION_ENABLED) {
    if (CHART_COLLECTION_ON_STARTUP) {
      refreshChartsOnce().catch((error) => {
        lastCollectorError = {
          at: new Date().toISOString(),
          scope: "chartRefresh",
          message: error.message || "Unknown error"
        };
        console.error(`[collector] chart refresh failed: ${error.message || "Unknown error"}`);
        persistCollectorStatus();
      });
    }

    setInterval(() => {
      refreshChartsOnce();
    }, CHART_REFRESH_INTERVAL_MS);
  }
}

if (require.main === module) {
  startCollector().catch((error) => {
    console.error(`[collector] failed: ${error.message || "Unknown error"}`);
    process.exit(1);
  });
}

module.exports = {
  startCollector,
  refreshQuotesOnce,
  refreshChartIntervalOnce,
  refreshChartsOnce,
  runStage,
  syncSymbolsOnce
};
