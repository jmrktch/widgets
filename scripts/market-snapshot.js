require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  fetchQuotesBatch,
  fetchChartsBatch,
  fetchQuoteForSymbol,
  fetchChartForSymbol,
  lookupContract
} = require("../lib/focus-client");
const { readSymbols } = require("../lib/store");
const { runRefreshCookieJob } = require("./refresh-cookie-job");

const ROOT = path.join(__dirname, "..");
// Local development publishes through the Express public directory. The
// GitHub Pages workflow supplies a separate, JSON-only staging directory.
const OUTPUT_DIR = path.resolve(ROOT, process.env.MARKET_SNAPSHOT_OUTPUT_DIR || "public/snapshot/latest");
const INTERVAL_MS = Number(process.env.MARKET_SNAPSHOT_INTERVAL_MS || 10 * 60 * 1000);
const BATCH_SIZE = Math.max(1, Number(process.env.MARKET_SNAPSHOT_BATCH_SIZE || 10));
const BATCH_PAUSE_MS = Math.max(0, Number(process.env.MARKET_SNAPSHOT_BATCH_PAUSE_MS || 150));
const MIN_SUCCESS_RATIO = Math.min(1, Math.max(0, Number(process.env.MARKET_SNAPSHOT_MIN_SUCCESS_RATIO || 0.95)));
const FORCE = process.argv.includes("--force");
const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");
const MARKET_TIMEZONE = process.env.COLLECTOR_MARKET_TIMEZONE || "Australia/Sydney";
const SNAPSHOT_OPEN_HOUR = Number(process.env.MARKET_SNAPSHOT_OPEN_HOUR || 9);
const SNAPSHOT_OPEN_MINUTE = Number(process.env.MARKET_SNAPSHOT_OPEN_MINUTE || 30);
const SNAPSHOT_CLOSE_HOUR = Number(process.env.MARKET_SNAPSHOT_CLOSE_HOUR || 17);
const SNAPSHOT_CLOSE_MINUTE = Number(process.env.MARKET_SNAPSHOT_CLOSE_MINUTE || 0);
const AUTH_REFRESH_ATTEMPTS = Math.max(1, Number(process.env.MARKET_SNAPSHOT_AUTH_REFRESH_ATTEMPTS || 3));
const AUTH_RETRY_DELAY_MS = Math.max(0, Number(process.env.MARKET_SNAPSHOT_AUTH_RETRY_DELAY_MS || 3_000));
const BENCHMARKS = ["GOLD", "AU1YY", "US1YY", "OOO", "A200"];
const BENCHMARK_CONTRACTS = {
  GOLD: { productType: "Commodity", exchange: "" },
  AU1YY: { productType: "Bond", exchange: "" },
  US1YY: { productType: "Bond", exchange: "" },
  A200: { productType: "Fund", exchange: "XASX", displayMode: "percentChangeOnly" }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeSnapshotAuthentication() {
  await fetchQuoteForSymbol("BHP");
}

async function ensureSnapshotAuthentication() {
  const startedAt = Date.now();
  try {
    await probeSnapshotAuthentication();
    console.log("[market-snapshot] authentication accepted; using the current cookie.");
    return { refreshed: false, attempts: 0, durationMs: Date.now() - startedAt };
  } catch (initialError) {
    console.warn(`[market-snapshot] authentication probe rejected (${initialError?.status || initialError?.message || "unknown"}); refreshing before collection.`);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= AUTH_REFRESH_ATTEMPTS; attempt += 1) {
    let refreshError = null;
    try {
      console.log(`[market-snapshot] cookie refresh attempt ${attempt}/${AUTH_REFRESH_ATTEMPTS}.`);
      await runRefreshCookieJob();
    } catch (error) {
      // refreshCookie writes the local runtime cookie before this job pushes
      // it to the service. A temporarily unavailable local API must not make
      // us discard a freshly usable local session without testing it first.
      refreshError = error;
      console.warn(`[market-snapshot] refresh hand-off attempt ${attempt}/${AUTH_REFRESH_ATTEMPTS} failed: ${error?.message || error}`);
    }

    try {
      await probeSnapshotAuthentication();
      console.log(`[market-snapshot] authentication accepted after refresh attempt ${attempt}${refreshError ? " (local runtime cookie)" : ""}.`);
      return { refreshed: true, attempts: attempt, handoffSucceeded: !refreshError, durationMs: Date.now() - startedAt };
    } catch (probeError) {
      lastError = probeError;
      console.warn(`[market-snapshot] refreshed cookie was not accepted on attempt ${attempt}/${AUTH_REFRESH_ATTEMPTS}: ${probeError?.message || probeError}`);
    }

    if (attempt < AUTH_REFRESH_ATTEMPTS && AUTH_RETRY_DELAY_MS) {
      await sleep(AUTH_RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error(`Snapshot authentication could not be restored after ${AUTH_REFRESH_ATTEMPTS} refresh attempts: ${lastError?.message || "unknown error"}`);
}

function writeJsonAtomic(name, value) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return path.relative(ROOT, target).replace(/\\/g, "/");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function marketState(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MARKET_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = (Number(map.hour) * 60) + Number(map.minute);
  const open = (SNAPSHOT_OPEN_HOUR * 60) + SNAPSHOT_OPEN_MINUTE;
  const close = (SNAPSHOT_CLOSE_HOUR * 60) + SNAPSHOT_CLOSE_MINUTE;
  return {
    open: !["Sat", "Sun"].includes(map.weekday) && minute >= open && minute < close,
    weekday: map.weekday,
    minute
  };
}

function batches(items) {
  const output = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    output.push(items.slice(offset, offset + BATCH_SIZE));
  }
  return output;
}

async function collectInBatches(symbols, fetchBatch, label) {
  const values = [];
  const failures = [];
  const batchTimings = [];
  const startedAt = Date.now();
  const groups = batches(symbols);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const batchStartedAt = Date.now();
    let returnedCount = 0;
    let errorMessage = null;
    try {
      const rows = await fetchBatch(group);
      values.push(...rows);
      returnedCount = rows.length;
      const returned = new Set(rows.map((row) => row.ticker));
      for (const symbol of group) {
        if (!returned.has(symbol)) failures.push(symbol);
      }
    } catch (error) {
      // Authentication failures are global: every subsequent batch would use
      // the same rejected session cookie. Stop here so a local test (and the
      // scheduled job) fails quickly and leaves the last good public JSON in
      // place rather than wasting requests for the full universe.
      if (error?.isAuthFailure) {
        const message = `${label} authentication failed after the snapshot auth gate. The runtime cookie was rejected.`;
        const authError = new Error(message);
        authError.isAuthFailure = true;
        throw authError;
      }
      errorMessage = error.message || String(error);
      failures.push(...group);
      console.warn(`[market-snapshot] ${label} batch ${index + 1}/${groups.length} failed: ${error.message || error}`);
    }
    batchTimings.push({ batch: index + 1, symbols: group.length, returned: returnedCount, durationMs: Date.now() - batchStartedAt, ...(errorMessage ? { error: errorMessage } : {}) });
    console.log(`[market-snapshot] ${label} batch ${index + 1}/${groups.length}: ${values.length}/${symbols.length}`);
    if (index + 1 < groups.length && BATCH_PAUSE_MS) await sleep(BATCH_PAUSE_MS);
  }
  return { values, failures, batchTimings, durationMs: Date.now() - startedAt };
}

async function retryMissingContracts(symbols, initialRows, fetchOne) {
  const returned = new Set(initialRows.map((row) => row.ticker));
  const missing = symbols.filter((symbol) => !returned.has(symbol));
  if (!missing.length) return initialRows;

  const retries = await Promise.allSettled(missing.map(async (symbol) => {
    const contract = await lookupContract(symbol);
    return fetchOne(symbol, contract);
  }));
  return initialRows.concat(retries
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value));
}

async function fetchQuotesWithContractRetry(symbols) {
  const initial = await fetchQuotesBatch(symbols);
  return retryMissingContracts(symbols, initial, (symbol, contract) => fetchQuoteForSymbol(symbol, contract));
}

async function fetchChartsWithContractRetry(symbols) {
  const initial = await fetchChartsBatch(symbols, "minute");
  return retryMissingContracts(symbols, initial, (symbol, contract) => fetchChartForSymbol(symbol, "minute", contract));
}

function runNodeScript(script, args) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const relay = (chunk, stream) => process[stream].write(`[market-snapshot:${path.basename(script)}] ${chunk}`);
    child.stdout.on("data", (chunk) => relay(chunk, "stdout"));
    child.stderr.on("data", (chunk) => relay(chunk, "stderr"));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve({ durationMs: Date.now() - startedAt }) : reject(new Error(`${script} exited with code ${code}`)));
  });
}

async function runTask(manifest, name, work) {
  const startedAt = Date.now();
  try {
    const result = await work();
    manifest.datasets[name] = { ok: true, durationMs: Date.now() - startedAt, ...result };
  } catch (error) {
    // Never replace a good public dataset with an error response.
    manifest.datasets[name] = { ok: false, durationMs: Date.now() - startedAt, error: error.message || String(error) };
    console.error(`[market-snapshot] ${name} failed: ${error.message || error}`);
  }
}

async function collectBenchmarks() {
  const values = [];
  const charts5m5d = [];
  const unavailable = [];
  for (const symbol of BENCHMARKS) {
    try {
      const override = BENCHMARK_CONTRACTS[symbol] || null;
      const contract = override
        ? { symbol, name: null, ...override }
        : await lookupContract(symbol);
      const [quote, chart] = await Promise.all([
        fetchQuoteForSymbol(symbol, contract),
        fetchChartForSymbol(symbol, "minute", contract)
      ]);
      values.push({ ...quote, contract, ...(override?.displayMode ? { displayMode: override.displayMode } : {}) });
      charts5m5d.push({ ...chart, contract, ...(override?.displayMode ? { displayMode: override.displayMode } : {}) });
    } catch (error) {
      unavailable.push({ symbol, reason: error.message || String(error) });
    }
  }
  // Keep an explicit public record when Focus has no quote/candle data for a
  // requested instrument (currently AU1YY and US1YY), instead of suppressing
  // the usable GOLD/OOO data and failing the complete snapshot.
  const extractedAt = new Date().toISOString();
  for (const symbol of BENCHMARKS) {
    const quote = values.find((value) => value.ticker === symbol) || null;
    const candles5m5d = charts5m5d.find((value) => value.ticker === symbol) || null;
    writeJsonAtomic(`benchmarks/${symbol}.json`, {
      extractedAt,
      symbol,
      quote,
      candles5m5d,
      unavailable: unavailable.find((item) => item.symbol === symbol) || null
    });
  }
  return {
    files: BENCHMARKS.map((symbol) => `benchmarks/${symbol}.json`),
    count: values.length,
    chartCount: charts5m5d.length,
    unavailable
  };
}

async function collectFastSections() {
  const child = await runNodeScript("scripts/probe-fast-brief-sections.js", ["--limit=200", "--dividend-days=14", "--include-scans"]);
  const source = (name) => readJson(path.join(ROOT, "public", name));
  const heatmap = source("heatmap-fast.json");
  if (!heatmap.ok || !heatmap.stocks?.length) {
    throw new Error(`Focus Heatmap subscription returned no stocks: ${heatmap.reason || "unknown reason"}`);
  }
  const output = {
    extractedAt: new Date().toISOString(),
    media: source("top-media-fast.json"),
    raises: source("current-raises-fast.json"),
    dividends: source("upcoming-dividends-fast.json"),
    heatmap
  };
  const profilePath = path.join(ROOT, "public", "fast-brief-profile.json");
  const profile = fs.existsSync(profilePath) ? readJson(profilePath) : null;
  const files = Object.entries({
    media: output.media,
    raises: output.raises,
    dividends: output.dividends,
    heatmap: output.heatmap
  }).map(([name, value]) => writeJsonAtomic(`content/${name}.json`, value));
  return { files, profile: { childDurationMs: child.durationMs, ...(profile || {}) }, counts: {
    media: output.media.items?.length || 0,
    raises: output.raises.items?.length || 0,
    dividends: output.dividends.items?.length || 0,
    heatmap: output.heatmap.stocks?.length || 0
  } };
}

async function collectScans() {
  const limit = Math.max(1, Number(process.env.MARKET_SNAPSHOT_SCAN_LIMIT || 10));
  const scanNames = [
    "top-gainers", "top-losers", "gapped-up", "gapped-down", "trading-halt", "52-week-high", "52-week-low",
    "rsi-oversold", "rsi-overbought", "high-roe-low-dtc"
  ];
  const scans = {};
  for (const name of scanNames) {
    const scan = readJson(path.join(ROOT, "public", `${name}-direct-scan.json`));
    // Scan membership must be defined by the Focus scan configuration, not
    // rebuilt from the quote universe after extraction.
    scans[name] = scan;
  }
  const profilePath = path.join(ROOT, "public", "direct-scan-profile.json");
  const profile = fs.existsSync(profilePath) ? readJson(profilePath) : null;
  const files = Object.entries(scans).map(([name, scan]) => writeJsonAtomic(`scans/${name}.json`, scan));
  return { files, count: scanNames.length, rowsPerScan: limit, profile: { childDurationMs: profile?.totalMs || 0, ...(profile || {}) } };
}

function publishTickerResources(symbols, quotes, charts) {
  const extractedAt = new Date().toISOString();
  const quotesByTicker = new Map(quotes.map((quote) => [quote.ticker, quote]));
  const chartsByTicker = new Map(charts.map((chart) => [chart.ticker, chart]));
  const publishedSymbols = [];

  for (const symbol of symbols) {
    const quote = quotesByTicker.get(symbol);
    const candles5m5d = chartsByTicker.get(symbol);
    // A self-contained resource is only useful if its quote and chart agree.
    // Missing instruments remain visible in universe.json rather than being
    // represented by a misleading partial payload.
    if (!quote || !candles5m5d) continue;
    writeJsonAtomic(`tickers/${symbol}.json`, {
      extractedAt,
      symbol,
      quote,
      candles5m5d
    });
    publishedSymbols.push(symbol);
  }

  writeJsonAtomic("universe.json", {
    extractedAt,
    name: "ASX Top 200 (supplied universe)",
    requestedSymbols: symbols,
    publishedSymbols,
    unavailableSymbols: symbols.filter((symbol) => !publishedSymbols.includes(symbol)),
    tickerResource: "tickers/{symbol}.json"
  });
  return { files: publishedSymbols.length, unavailable: symbols.length - publishedSymbols.length };
}

function removeLegacyCombinedResources() {
  // These payloads duplicated the resource-oriented files and made the candle
  // endpoint too large for normal browser viewing. Remove them only after a
  // complete replacement snapshot has been written.
  for (const name of [
    "asx200-quotes.json",
    "asx200-candles-5m-5d.json",
    "benchmarks.json",
    "market-content.json",
    "scans.json"
  ]) {
    const target = path.join(OUTPUT_DIR, name);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}

async function runSnapshot() {
  const schedule = marketState();
  if (!FORCE && !DRY_RUN && !schedule.open) {
    console.log(`[market-snapshot] skipped: outside Sydney market window (${schedule.weekday} ${schedule.minute}m).`);
    return { skipped: true };
  }

  const symbols = readSymbols();
  if (symbols.length !== 200) throw new Error(`Expected an ASX 200 universe; found ${symbols.length} symbols.`);
  if (DRY_RUN) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      marketWindow: schedule,
      universe: { name: "ASX Top 200 (supplied universe)", symbols: symbols.length },
      plan: [
        "Supplied ASX Top 200 quotes",
        "Supplied ASX Top 200 5-minute / 5-day candles",
        "GOLD, AU1YY, US1YY, OOO benchmark quotes",
        "Platform heatmap, media, raises, next-14-day dividends",
        "Platform-configured scans excluding unusual volume"
      ],
      outputDirectory: path.relative(ROOT, OUTPUT_DIR).replace(/\\/g, "/")
    }, null, 2));
    return { dryRun: true };
  }
  const authentication = await ensureSnapshotAuthentication();
  const universe = new Set(symbols);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    marketTimezone: MARKET_TIMEZONE,
    universe: { name: "ASX Top 200 (supplied universe)", symbols: symbols.length },
    cadenceMinutes: INTERVAL_MS / 60_000,
    authentication,
    datasets: {}
  };

  let quoteResult = null;
  let candleResult = null;
  await runTask(manifest, "quotes", async () => {
    const result = await collectInBatches(symbols, fetchQuotesWithContractRetry, "quotes");
    if (result.values.length / symbols.length < MIN_SUCCESS_RATIO) {
      throw new Error(`Quote success ratio ${result.values.length}/${symbols.length} below threshold. Missing sample: ${result.failures.slice(0, 20).join(", ")}`);
    }
    quoteResult = result;
    return { count: result.values.length, failures: result.failures, batchTimings: result.batchTimings, collectionMs: result.durationMs };
  });
  await runTask(manifest, "candles5m5d", async () => {
    const result = await collectInBatches(symbols, fetchChartsWithContractRetry, "5m candles");
    if (result.values.length / symbols.length < MIN_SUCCESS_RATIO) {
      throw new Error(`Candle success ratio ${result.values.length}/${symbols.length} below threshold. Missing sample: ${result.failures.slice(0, 20).join(", ")}`);
    }
    candleResult = result;
    return { count: result.values.length, failures: result.failures, batchTimings: result.batchTimings, collectionMs: result.durationMs };
  });
  await runTask(manifest, "tickerResources", async () => {
    if (!quoteResult || !candleResult) throw new Error("Cannot publish ticker resources without completed quote and candle collections.");
    return publishTickerResources(symbols, quoteResult.values, candleResult.values);
  });
  await runTask(manifest, "benchmarks", collectBenchmarks);
  await runTask(manifest, "marketContent", collectFastSections);
  await runTask(manifest, "scans", collectScans);

  manifest.finishedAt = new Date().toISOString();
  manifest.totalDurationMs = Date.now() - new Date(manifest.generatedAt).getTime();
  manifest.ok = Object.values(manifest.datasets).every((dataset) => dataset.ok);
  if (manifest.ok) removeLegacyCombinedResources();
  writeJsonAtomic("manifest.json", manifest);
  console.log(`[market-snapshot] complete ok=${manifest.ok} in ${Date.now() - new Date(manifest.generatedAt).getTime()}ms`);
  if (!manifest.ok) {
    throw new Error("Snapshot is incomplete; preserving the previous public deployment.");
  }
  return manifest;
}

async function main() {
  do {
    const cycleStartedAt = Date.now();
    try {
      await runSnapshot();
    } catch (error) {
      console.error(`[market-snapshot] cycle failed: ${error.message || error}`);
      if (ONCE) {
        process.exitCode = 1;
        return;
      }
    }
    if (ONCE) return;
    // Keep the requested cadence measured from cycle start. A ~minute-long
    // collection should not turn a ten-minute schedule into eleven minutes.
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - cycleStartedAt)));
  } while (true);
}

main().catch((error) => {
  console.error(`[market-snapshot] fatal: ${error.message || error}`);
  process.exitCode = 1;
});
