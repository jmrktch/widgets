const fs = require("fs");
const path = require("path");

const ENV_DEFAULTS = {
  MARKETECH_API_BASE: "https://api.marketech.com.au",
  FOCUS_LOGIN_URL: "https://focus.marketech.com.au/#/login",
  PORT: 3000,
  PUBLIC_WIDGET_REFRESH_MS: 60_000,
  DELAY_MINUTES: 20,
  QUOTE_REFRESH_INTERVAL_MS: 15_000,
  COOKIE_REFRESH_INTERVAL_MS: 600_000,
  COOKIE_REFRESH_ENABLED: true,
  AUTH_REFRESH_RETRY_COUNT: 3,
  AUTH_REFRESH_RETRY_DELAY_MS: 3_000,
  QUOTE_BATCH_SIZE: 100,
  QUOTE_BATCH_PAUSE_MS: 150,
  COLLECTOR_MODE: "rolling",
  COLLECTOR_SCHEDULER_ENABLED: true,
  COLLECTOR_MARKET_TIMEZONE: "Australia/Sydney",
  COLLECTOR_MARKET_OPEN_HOUR: 10,
  COLLECTOR_MARKET_OPEN_MINUTE: 0,
  COLLECTOR_MARKET_CLOSE_HOUR: 16,
  COLLECTOR_MARKET_CLOSE_MINUTE: 30,
  COLLECTOR_MARKET_STAGE_ORDER: "quote,minute,hour",
  COLLECTOR_AFTER_HOURS_STAGE_ORDER: "day,week,month",
  COLLECTOR_FINAL_UPDATE_ENABLED: true,
  COLLECTOR_FINAL_UPDATE_HOUR: 17,
  COLLECTOR_FINAL_UPDATE_MINUTE: 0,
  COLLECTOR_FINAL_UPDATE_DURATION_MINUTES: 10,
  COLLECTOR_FINAL_STAGE_ORDER: "quote,minute,hour,day,week,month",
  COLLECTOR_LOOP_PAUSE_MS: 5_000,
  WORKER_LOOP_PAUSE_MS: 250,
  WORKER_LOOP_JITTER_MS: 250,
  QUOTE_STAGE_MIN_GAP_MS: 15_000,
  MINUTE_STAGE_MIN_GAP_MS: 60_000,
  HOUR_STAGE_MIN_GAP_MS: 60_000,
  DAY_STAGE_MIN_GAP_MS: 3_600_000,
  WEEK_STAGE_MIN_GAP_MS: 3_600_000,
  MONTH_STAGE_MIN_GAP_MS: 3_600_000,
  QUOTE_STAGE_MARKET_START_DELAY_MS: 0,
  MINUTE_STAGE_MARKET_START_DELAY_MS: 0,
  HOUR_STAGE_MARKET_START_DELAY_MS: 300_000,
  DAY_STAGE_MARKET_START_DELAY_MS: 3_600_000,
  WEEK_STAGE_MARKET_START_DELAY_MS: 3_600_000,
  MONTH_STAGE_MARKET_START_DELAY_MS: 3_600_000,
  CHART_COLLECTION_ENABLED: true,
  CHART_COLLECTION_ON_STARTUP: true,
  STARTUP_DAY_CHART_ENABLED: false,
  STARTUP_WEEK_CHART_ENABLED: false,
  STARTUP_MONTH_CHART_ENABLED: false,
  CHART_REFRESH_INTERVAL_MS: 600_000,
  CHART_BATCH_SIZE: 25,
  CHART_BATCH_PAUSE_MS: 25,
  CHART_INTERVAL_KEYS: "minute,hour,day,week,month",
  MINUTE_CHART_SYMBOLS: "",
  WORKER_SYMBOL_ORDER_MODE: "interleave",
  SYMBOL_SYNC_ENABLED: true,
  SYMBOL_SYNC_ON_STARTUP: true,
  SYMBOL_SYNC_AT_MIDNIGHT: true,
  SYMBOL_SYNC_INTERVAL_MS: 86_400_000,
  SYMBOL_SEARCH_MAX_RESULTS: 100,
  SYMBOL_SYNC_PROGRESS_EVERY: 25,
  MIN_SYMBOL_SYNC_COUNT: 1800,
  SYMBOL_SYNC_TARGET_COUNT: 1800,
  SYMBOL_SYNC_FALLBACK_ENABLED: true,
  SYMBOL_SYNC_FALLBACK_PROBE_LIMIT: 500,
  SYMBOL_SYNC_FALLBACK_EXACT_RESULTS: 20,
  SYMBOL_SYNC_ALT_PASSES_ENABLED: true,
  SYMBOL_SYNC_ALT_PASS_LIMIT: 2,
  SYMBOL_SYNC_ALT_ROOT_MODES: "reverse,digits_first",
  SYMBOL_SEARCH_PREFIX_DEPTH: 3,
  SYMBOL_SYNC_FORCE_EXPAND_DEPTHS: "1",
  SYMBOL_SYNC_EARLY_STOP_ENABLED: true,
  SYMBOL_SYNC_EARLY_STOP_NO_GROWTH_SCANS: 150,
  SYMBOL_SYNC_EARLY_STOP_MIN_PREFIX_LENGTH: 3,
  SYMBOL_SEARCH_ROOTS: "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,0,1,2,3,4,5,6,7,8,9",
  CHART_CACHE_TTL_MS: 60_000,
  WEAK_BATCH_SUCCESS_RATIO: 0.75,
  WEAK_BATCH_MIN_FAILURES: 25,
  WEAK_BATCH_SAMPLE_SIZE: 12,
  INFO_LOGS_ENABLED: true,
  DEBUG_TIMINGS: true
};

const BOOLEAN_KEYS = new Set([
  "COLLECTOR_SCHEDULER_ENABLED",
  "COLLECTOR_FINAL_UPDATE_ENABLED",
  "CHART_COLLECTION_ENABLED",
  "CHART_COLLECTION_ON_STARTUP",
  "COOKIE_REFRESH_ENABLED",
  "SYMBOL_SYNC_ENABLED",
  "SYMBOL_SYNC_ON_STARTUP",
  "SYMBOL_SYNC_AT_MIDNIGHT",
  "INFO_LOGS_ENABLED",
  "DEBUG_TIMINGS"
]);

const NUMBER_KEYS = new Set([
  "PORT",
  "PUBLIC_WIDGET_REFRESH_MS",
  "DELAY_MINUTES",
  "QUOTE_REFRESH_INTERVAL_MS",
  "COOKIE_REFRESH_INTERVAL_MS",
  "AUTH_REFRESH_RETRY_COUNT",
  "AUTH_REFRESH_RETRY_DELAY_MS",
  "QUOTE_BATCH_SIZE",
  "QUOTE_BATCH_PAUSE_MS",
  "COLLECTOR_MARKET_OPEN_HOUR",
  "COLLECTOR_MARKET_OPEN_MINUTE",
  "COLLECTOR_MARKET_CLOSE_HOUR",
  "COLLECTOR_MARKET_CLOSE_MINUTE",
  "COLLECTOR_FINAL_UPDATE_HOUR",
  "COLLECTOR_FINAL_UPDATE_MINUTE",
  "COLLECTOR_FINAL_UPDATE_DURATION_MINUTES",
  "COLLECTOR_LOOP_PAUSE_MS",
  "QUOTE_STAGE_MIN_GAP_MS",
  "MINUTE_STAGE_MIN_GAP_MS",
  "HOUR_STAGE_MIN_GAP_MS",
  "DAY_STAGE_MIN_GAP_MS",
  "WEEK_STAGE_MIN_GAP_MS",
  "MONTH_STAGE_MIN_GAP_MS",
  "QUOTE_STAGE_MARKET_START_DELAY_MS",
  "MINUTE_STAGE_MARKET_START_DELAY_MS",
  "HOUR_STAGE_MARKET_START_DELAY_MS",
  "DAY_STAGE_MARKET_START_DELAY_MS",
  "WEEK_STAGE_MARKET_START_DELAY_MS",
  "MONTH_STAGE_MARKET_START_DELAY_MS",
  "CHART_REFRESH_INTERVAL_MS",
  "CHART_BATCH_SIZE",
  "CHART_BATCH_PAUSE_MS",
  "SYMBOL_SYNC_INTERVAL_MS",
  "SYMBOL_SEARCH_MAX_RESULTS",
  "MIN_SYMBOL_SYNC_COUNT",
  "SYMBOL_SYNC_TARGET_COUNT",
  "SYMBOL_SYNC_FALLBACK_PROBE_LIMIT",
  "SYMBOL_SYNC_FALLBACK_EXACT_RESULTS",
  "SYMBOL_SEARCH_PREFIX_DEPTH",
  "CHART_CACHE_TTL_MS"
  ,
  "WEAK_BATCH_SUCCESS_RATIO",
  "WEAK_BATCH_MIN_FAILURES",
  "WEAK_BATCH_SAMPLE_SIZE"
]);

function getEnvString(key) {
  const value = process.env[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return String(ENV_DEFAULTS[key] ?? "");
}

function getEnvNumber(key) {
  const rawValue = process.env[key];
  if (rawValue === undefined || rawValue === "") {
    return Number(ENV_DEFAULTS[key] ?? 0);
  }

  const parsed = Number(rawValue);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  console.warn(`[env] Invalid number for ${key}: ${JSON.stringify(rawValue)}. Using default ${ENV_DEFAULTS[key]}.`);
  return Number(ENV_DEFAULTS[key] ?? 0);
}

function getEnvBoolean(key) {
  const rawValue = process.env[key];
  if (rawValue === undefined || rawValue === "") {
    return Boolean(ENV_DEFAULTS[key]);
  }
  return String(rawValue).toLowerCase() === "true";
}

function getEnvList(key) {
  return getEnvString(key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findEnvFileIssues() {
  const envPath = path.join(process.cwd(), ".env");
  const issues = [];

  if (!fs.existsSync(envPath)) {
    return issues;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.includes("=")) {
      issues.push(`Malformed .env line ${index + 1}: expected KEY=value.`);
      continue;
    }
    if (line.toLowerCase().startsWith("origin=") || line.toLowerCase().startsWith("referer=")) {
      issues.push(`Suspicious header-style .env entry on line ${index + 1}: ${line.split("=")[0]}.`);
    }
  }

  const cookie = process.env.MARKETECH_COOKIE || "";
  if (cookie.includes("\n") || cookie.includes("\r")) {
    issues.push("MARKETECH_COOKIE appears to contain a newline. Paste only the cookie value.");
  }

  return issues;
}

function validateEnv() {
  const warnings = [];

  if (!process.env.MARKETECH_COOKIE && !(process.env.FOCUS_EMAIL && process.env.FOCUS_PASSWORD)) {
    warnings.push("Missing MARKETECH_COOKIE and Focus login credentials. Upstream requests will fail.");
  }

  if (!process.env.FOCUS_LOGIN_URL) {
    warnings.push(`FOCUS_LOGIN_URL not set. Using default ${ENV_DEFAULTS.FOCUS_LOGIN_URL || "https://focus.marketech.com.au/#/login"}.`);
  }

  for (const key of NUMBER_KEYS) {
    const rawValue = process.env[key];
    if (rawValue !== undefined && rawValue !== "" && !Number.isFinite(Number(rawValue))) {
      warnings.push(`Invalid numeric env value for ${key}. Falling back to ${ENV_DEFAULTS[key]}.`);
    }
  }

  for (const key of BOOLEAN_KEYS) {
    const rawValue = process.env[key];
    if (rawValue !== undefined && rawValue !== "") {
      const lower = String(rawValue).toLowerCase();
      if (lower !== "true" && lower !== "false") {
        warnings.push(`Invalid boolean env value for ${key}. Use true or false.`);
      }
    }
  }

  warnings.push(...findEnvFileIssues());

  for (const warning of warnings) {
    console.warn(`[env] ${warning}`);
  }

  return warnings;
}

module.exports = {
  ENV_DEFAULTS,
  getEnvBoolean,
  getEnvList,
  getEnvNumber,
  getEnvString,
  validateEnv
};
