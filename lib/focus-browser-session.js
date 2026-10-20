const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0";
const { chromium } = require("playwright");

const ENV_PATH = path.join(__dirname, "..", ".env");
const RUNTIME_COOKIE_PATH = path.join(__dirname, "..", "data", "runtime-cookie.json");
const DEFAULT_AUTH_STATE_PATH = path.join(__dirname, "..", ".focus-auth-state.json");
const DEFAULT_LOGIN_URL = "https://focus.marketech.com.au/#/login";
const DEFAULT_APP_URL = "https://focus.marketech.com.au/";

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
}

function readRuntimeCookie() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_COOKIE_PATH, "utf8"));
    return typeof parsed?.cookie === "string" ? parsed.cookie : "";
  } catch {
    return "";
  }
}

async function applyRuntimeCookie(context) {
  const rawCookie = readRuntimeCookie();
  if (!rawCookie) return false;

  const cookies = rawCookie
    .split(";")
    .map((entry) => entry.trim())
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0 ? { name: entry.slice(0, separator), value: entry.slice(separator + 1) } : null;
    })
    .filter((cookie) => cookie?.name === "at" && cookie.value);

  if (!cookies.length) return false;
  await context.addCookies(cookies.map((cookie) => ({
    ...cookie,
    domain: ".marketech.com.au",
    path: "/",
    secure: true,
    sameSite: "Lax"
  })));
  return true;
}

async function waitForAuthCookie(context, timeoutMs = 12_000, pollMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies("https://api.marketech.com.au", "https://focus.marketech.com.au");
    if (cookies.some((cookie) => cookie.name === "at")) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function waitForVisibleLocator(locator, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await locator.count()) {
        await locator.first().waitFor({ state: "visible", timeout: 2_000 });
        return locator.first();
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw lastError || new Error(`${label} did not become visible within ${timeoutMs}ms.`);
}

async function logPageSnapshot(page, label) {
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const snippet = String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 240);
  console.warn(`[focus-browser] ${label} url=${page.url() || "-"} title=${title || "-"} body=${snippet || "-"}`);
}

async function gotoWithFallback(page, url) {
  const attempts = [
    { waitUntil: "domcontentloaded", timeout: 20_000 },
    { waitUntil: "load", timeout: 20_000 },
    { waitUntil: "commit", timeout: 15_000 }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      await page.goto(url, attempt);
      return;
    } catch (error) {
      lastError = error;
      await logPageSnapshot(page, `navigation-failed-${attempt.waitUntil}`);
    }
  }

  const finalUrl = page.url();
  if (finalUrl && finalUrl !== "about:blank") {
    return;
  }

  throw lastError || new Error(`Failed to navigate to ${url}.`);
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

async function loginFocusPage(page, options = {}) {
  const env = { ...readEnvFile(), ...process.env };
  const loginUrl = options.loginUrl || env.FOCUS_LOGIN_URL || DEFAULT_LOGIN_URL;
  const email = env.FOCUS_EMAIL;
  const password = env.FOCUS_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing FOCUS_EMAIL or FOCUS_PASSWORD in .env");
  }

  await gotoWithFallback(page, loginUrl);
  await logPageSnapshot(page, "post-login-goto");

  const hasExistingCookie = await waitForAuthCookie(page.context(), 2_000, 200);
  // An expired or server-revoked `at` cookie can still be present in browser
  // storage. It is not a usable session when Focus has redirected us to the
  // login route, so do not let its mere presence skip the real login.
  if (hasExistingCookie && !/\/login(?:[/?#]|$)/i.test(page.url())) {
    return;
  }

  const loginEntryButton = page.locator(
    'button:has-text("Email"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Sign in")'
  ).first();
  if (await loginEntryButton.count()) {
    await loginEntryButton.click().catch(() => {});
  }

  const emailInput = await waitForVisibleLocator(
    page.locator('input[type="email"], input[name="email"], input[id*="email" i], input[placeholder*="email" i], input[autocomplete="username"]'),
    90_000,
    "Email input"
  );
  const passwordInput = await waitForVisibleLocator(
    page.locator('input[type="password"], input[name="password"], input[id*="password" i], input[placeholder*="password" i], input[autocomplete="current-password"]'),
    90_000,
    "Password input"
  );

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Continue")'
  ).first();
  await submit.click();

  const hasCookie = await finalizeAuthenticatedSession(page, loginUrl);
  if (!hasCookie) {
    await logPageSnapshot(page, "login-failure");
    throw new Error("Auth cookie was not set after login.");
  }
}

function getAuthStatePath(options = {}) {
  return options.storageStatePath || process.env.FOCUS_AUTH_STATE_PATH || DEFAULT_AUTH_STATE_PATH;
}

function hasUsableStorageState(file) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(state.cookies) && state.cookies.some((cookie) =>
      cookie.name === "at" &&
      // Playwright represents a valid session cookie with expires: -1.
      // Treat that as usable rather than forcing every child collector to
      // re-open Focus's login page.
      (!cookie.expires || cookie.expires <= 0 || cookie.expires * 1000 > Date.now() + 60_000)
    );
  } catch {
    return false;
  }
}

async function saveAuthState(context, options = {}) {
  if (options.persistAuthState === false) return;
  const file = getAuthStatePath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await context.storageState({ path: file });
}

async function warmSessionLooksValid(page, options = {}) {
  const appUrl = String(options.appUrl || process.env.FOCUS_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  await page.goto(new URL("/#/", `${appUrl}/`).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  }).catch(() => {});
  await page.waitForTimeout(1500);
  if (/\/login/i.test(page.url())) return false;
  return waitForAuthCookie(page.context(), 500, 100);
}

async function createFocusBrowserSession(options = {}) {
  const browser = await chromium.launch({
    headless: options.headless !== false,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--no-zygote",
      "--disable-features=site-per-process"
    ]
  });
  const authStatePath = getAuthStatePath(options);
  const contextOptions = {
    viewport: options.viewport || { width: 1440, height: 1400 }
  };
  if (options.reuseAuthState !== false && hasUsableStorageState(authStatePath)) {
    contextOptions.storageState = authStatePath;
  }
  const context = await browser.newContext(contextOptions);
  // The cookie refresher is the single login owner. Browser collectors reuse
  // its private runtime cookie and only fall back to an interactive login when
  // that cookie is genuinely invalid or expired.
  await applyRuntimeCookie(context);
  const page = await context.newPage();
  page.setDefaultTimeout(options.defaultTimeoutMs || 20_000);
  page.on("pageerror", (error) => {
    console.warn(`[focus-browser] pageerror ${error?.message || "Unknown error"}`);
  });

  const hasWarmCookie = options.reuseAuthState !== false && await waitForAuthCookie(context, 500, 100);
  const hasValidWarmSession = hasWarmCookie && await warmSessionLooksValid(page, options);
  if (!hasValidWarmSession) {
    await loginFocusPage(page, options);
    await saveAuthState(context, options).catch((error) => {
      console.warn(`[focus-browser] auth-state-save-failed ${error?.message || error}`);
    });
  }
  return { browser, context, page };
}

function getFocusBaseUrl() {
  return String(process.env.FOCUS_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
}

module.exports = {
  createFocusBrowserSession,
  getFocusBaseUrl,
  loginFocusPage,
  logPageSnapshot,
  waitForAuthCookie
};
