const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { chromium } = require("playwright");

const ENV_PATH = path.join(__dirname, "..", ".env");
const DEBUG_TIMINGS = String(process.env.DEBUG_TIMINGS || "true").toLowerCase() === "true";
let browserPromise = null;
let browserState = null;

function logTiming(label, startedAt, details = {}) {
  if (!DEBUG_TIMINGS) return;
  const durationMs = Date.now() - startedAt;
  console.log(`[timing] ${label} ${durationMs}ms ${JSON.stringify(details)}`);
}

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return null;
      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim()
      };
    })
    .filter(Boolean);
}

async function waitForAuthCookie(context, timeoutMs = 12_000, pollMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies("https://focus.marketech.com.au", "https://api.marketech.com.au");
    if (cookies.some((cookie) => cookie.name === "at")) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function finalizeAuthenticatedSession(page, loginUrl) {
  const initialCookie = await waitForAuthCookie(page.context(), 8_000, 250);
  if (initialCookie) {
    return true;
  }

  const appUrl = loginUrl.replace(/#\/login.*$/i, "");
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  return waitForAuthCookie(page.context(), 12_000, 250);
}

async function loginPage(page, env) {
  const loginUrl = env.FOCUS_LOGIN_URL || "https://focus.marketech.com.au/#/login";
  const email = env.FOCUS_EMAIL;
  const password = env.FOCUS_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing FOCUS_EMAIL or FOCUS_PASSWORD in .env");
  }

  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const cookies = await page.context().cookies("https://focus.marketech.com.au", "https://api.marketech.com.au");
  if (cookies.some((cookie) => cookie.name === "at")) {
    return;
  }

  const loginEntryButton = page.locator(
    'button:has-text("Email"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Sign in")'
  ).first();
  if (await loginEntryButton.count()) {
    await loginEntryButton.click().catch(() => {});
  }

  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input[id*="email" i], input[placeholder*="email" i], input[autocomplete="username"]'
  ).first();
  const passwordInput = page.locator(
    'input[type="password"], input[name="password"], input[id*="password" i], input[placeholder*="password" i], input[autocomplete="current-password"]'
  ).first();

  await emailInput.waitFor({ state: "visible", timeout: 45000 });
  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Continue")'
  ).first();
  await submit.click();

  const hasCookie = await finalizeAuthenticatedSession(page, loginUrl);
  if (!hasCookie) {
    throw new Error("Auth cookie was not set after login.");
  }
}

async function createBrowserState() {
  const env = readEnv();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const cookiePairs = parseCookieHeader(process.env.MARKETECH_COOKIE || env.MARKETECH_COOKIE);
  if (cookiePairs.length > 0) {
    await context.addCookies(cookiePairs.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: ".marketech.com.au",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax"
    })));
  }

  const hasCookie = await waitForAuthCookie(context, 2_000, 200);
  if (!hasCookie) {
    await loginPage(page, env);
  }
  await page.goto("https://focus.marketech.com.au/", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  return { browser, context, page };
}

async function ensureBrowserState() {
  if (browserState) return browserState;
  if (!browserPromise) {
    const startedAt = Date.now();
    browserPromise = createBrowserState()
      .then((state) => {
        browserState = state;
        logTiming("browser.init", startedAt);
        return state;
      })
      .finally(() => {
        browserPromise = null;
      });
  }
  return browserPromise;
}

async function resetBrowserState() {
  if (browserState?.browser) {
    try {
      await browserState.browser.close();
    } catch {
      // Ignore browser close errors.
    }
  }
  browserState = null;
}

async function fetchTotmQuotes(symbols) {
  const uniqueSymbols = Array.from(new Set(symbols.map((symbol) => String(symbol || "").toUpperCase().trim()).filter(Boolean)));
  const startedAt = Date.now();

  async function runFetchAttempt() {
    const state = await ensureBrowserState();
    return state.page.evaluate(async (tickers) => {
      const requests = tickers.map(async (symbol) => {
        const response = await fetch("https://api.marketech.com.au/totm/get", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Accept: "application/json, text/plain, */*"
          },
          body: JSON.stringify({
            contractKey: {
              ProviderKey: "$",
              ProductType: "Stock",
              Exchange: "XASX",
              Symbol: symbol
            },
            interval: {
              Basis: "Day",
              Amount: 1
            },
            version: 2
          })
        });

        return {
          symbol,
          status: response.status,
          text: await response.text()
        };
      });

      return Promise.all(requests);
    }, uniqueSymbols);
  }

  let results = await runFetchAttempt();
  const needsRetry = results.some((result) => result.status === 401 || result.status === 403);
  if (needsRetry) {
    await resetBrowserState();
    results = await runFetchAttempt();
  }

  const output = results.map((result) => {
    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      parsed = null;
    }
    return {
      symbol: result.symbol,
      status: result.status,
      payload: parsed
    };
  });
  logTiming("browser.totm", startedAt, {
    symbols: uniqueSymbols.length,
    statuses: output.map((item) => item.status)
  });
  return output;
}

async function fetchCandles(symbol, interval, start, end) {
  const ticker = String(symbol || "").toUpperCase().trim();
  const startedAt = Date.now();

  async function runFetchAttempt() {
    const state = await ensureBrowserState();
    return state.page.evaluate(async ({ tickerValue, intervalValue, startValue, endValue }) => {
      const response = await fetch("https://api.marketech.com.au/candles/get", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json, text/plain, */*"
        },
        body: JSON.stringify({
          contractKey: {
            ProviderKey: "$",
            ProductType: "Stock",
            Exchange: "XASX",
            Symbol: tickerValue
          },
          interval: intervalValue,
          start: startValue,
          end: endValue,
          options: {
            CompleteOnly: false
          }
        })
      });

      return {
        status: response.status,
        text: await response.text()
      };
    }, {
      tickerValue: ticker,
      intervalValue: interval,
      startValue: start,
      endValue: end
    });
  }

  let result = await runFetchAttempt();
  if (result.status === 401 || result.status === 403) {
    await resetBrowserState();
    result = await runFetchAttempt();
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = null;
  }

  const output = {
    symbol: ticker,
    status: result.status,
    payload: parsed
  };
  logTiming("browser.candles", startedAt, {
    ticker,
    basis: interval?.Basis,
    amount: interval?.Amount,
    status: result.status
  });
  return output;
}

async function fetchContractsSearch(prefix, maxResults = 100) {
  const searchTerm = String(prefix || "").trim().toUpperCase();
  const startedAt = Date.now();

  async function runFetchAttempt() {
    const state = await ensureBrowserState();
    return state.page.evaluate(async ({ termValue, maxResultsValue }) => {
      const response = await fetch("https://api.marketech.com.au/contracts/search", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json, text/plain, */*"
        },
        body: JSON.stringify({
          searchTerm: termValue,
          maxResults: maxResultsValue
        })
      });

      return {
        status: response.status,
        text: await response.text()
      };
    }, {
      termValue: searchTerm,
      maxResultsValue: maxResults
    });
  }

  let result = await runFetchAttempt();
  if (result.status === 401 || result.status === 403) {
    await resetBrowserState();
    result = await runFetchAttempt();
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = null;
  }

  const output = {
    prefix: searchTerm,
    status: result.status,
    payload: parsed
  };
  logTiming("browser.contractsSearch", startedAt, {
    prefix: searchTerm,
    maxResults,
    status: result.status
  });
  return output;
}

module.exports = {
  fetchTotmQuotes,
  fetchCandles,
  fetchContractsSearch,
  resetBrowserState
};
