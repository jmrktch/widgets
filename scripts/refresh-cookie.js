const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0";
const { chromium } = require("playwright");

const ENV_PATH = path.join(__dirname, "..", ".env");
const REFRESH_STATE_PATH = path.join(__dirname, "..", "refresh-state.json");
const RUNTIME_COOKIE_PATH = path.join(__dirname, "..", "data", "runtime-cookie.json");
const LOGIN_URL = process.env.FOCUS_LOGIN_URL || "https://focus.marketech.com.au/#/login";
const API_HOST = "api.marketech.com.au";
let activeRefreshPromise = null;

console.log("[refresh-cookie] build 2026-06-23 hardened login v5");

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
}

function upsertEnvValue(fileText, key, value) {
  const safeValue = String(value ?? "").replace(/\r?\n/g, "");
  const line = `${key}=${safeValue}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(fileText)) return fileText.replace(pattern, line);
  const suffix = fileText.endsWith("\n") || fileText.length === 0 ? "" : "\n";
  return `${fileText}${suffix}${line}\n`;
}

function writeRefreshState(state) {
  fs.writeFileSync(REFRESH_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function ensureRuntimeCookieDir() {
  fs.mkdirSync(path.dirname(RUNTIME_COOKIE_PATH), { recursive: true });
}

function writeRuntimeCookie(cookie) {
  ensureRuntimeCookieDir();
  fs.writeFileSync(
    RUNTIME_COOKIE_PATH,
    JSON.stringify(
      {
        cookie: String(cookie || ""),
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
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

async function finalizeAuthenticatedSession(page, loginUrl) {
  const initialCookie = await waitForAuthCookie(page.context(), 8_000, 250);
  if (initialCookie) {
    return true;
  }

  const appUrl = loginUrl.replace(/#\/login.*$/i, "");
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  return waitForAuthCookie(page.context(), 12_000, 250);
}

function isTimeoutError(error) {
  return /Timeout/i.test(String(error?.message || ""));
}

async function logPageSnapshot(page, label) {
  try {
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const snippet = String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 240);
    console.warn(
      `[refresh-cookie] ${label} snapshot url=${url || "-"} title=${title || "-"} body=${snippet || "-"}`
    );
  } catch (error) {
    console.warn(`[refresh-cookie] ${label} snapshot failed: ${error?.message || "Unknown error"}`);
  }
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

async function waitForLoginForm(page, timeoutMs = 90_000) {
  console.log(`[refresh-cookie] waiting for login form (timeout=${timeoutMs})`);

  const emailLocator = page.locator(
    'input[type="email"], input[name="email"], input[id*="email" i], input[placeholder*="email" i], input[autocomplete="username"]'
  );
  const passwordLocator = page.locator(
    'input[type="password"], input[name="password"], input[id*="password" i], input[placeholder*="password" i], input[autocomplete="current-password"]'
  );

  const emailInput = await waitForVisibleLocator(emailLocator, timeoutMs, "Email input");
  const passwordInput = await waitForVisibleLocator(passwordLocator, timeoutMs, "Password input");

  console.log("[refresh-cookie] login form is visible");
  return { emailInput, passwordInput };
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
      console.log(
        `[refresh-cookie] navigating to ${url} (waitUntil=${attempt.waitUntil}, timeout=${attempt.timeout})`
      );
      await page.goto(url, attempt);
      console.log(
        `[refresh-cookie] navigation reached ${page.url() || url} via ${attempt.waitUntil}`
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[refresh-cookie] navigation attempt failed (waitUntil=${attempt.waitUntil}): ${error?.message || "Unknown error"}`
      );
      await logPageSnapshot(page, `after-${attempt.waitUntil}-failure`);
    }
  }

  const finalUrl = page.url();
  if (finalUrl && finalUrl !== "about:blank") {
    console.warn(`[refresh-cookie] proceeding despite navigation failures; current url=${finalUrl}`);
    return;
  }

  throw lastError || new Error(`Failed to navigate to ${url}.`);
}

async function refreshCookie() {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
  const env = readEnvFile();
  const email = process.env.FOCUS_EMAIL || env.FOCUS_EMAIL;
  const password = process.env.FOCUS_PASSWORD || env.FOCUS_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing FOCUS_EMAIL or FOCUS_PASSWORD in .env");
  }

  writeRefreshState({
    isRefreshingCookie: true,
    startedAt: new Date().toISOString()
  });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--no-zygote",
      "--disable-features=site-per-process"
    ]
  });
  try {
    browser.on("disconnected", () => {
      console.warn("[refresh-cookie] browser disconnected");
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => {
      const text = msg.text().trim();
      if (text) {
        console.log(`[refresh-cookie] browser-console ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      console.warn(`[refresh-cookie] pageerror ${error?.message || "Unknown error"}`);
    });
    page.on("crash", () => {
      console.warn("[refresh-cookie] page crashed");
    });

    await gotoWithFallback(page, LOGIN_URL);
    await logPageSnapshot(page, "post-login-goto");

    // If already logged in (existing session), skip form interaction.
    let cookies = await context.cookies("https://api.marketech.com.au", "https://focus.marketech.com.au");
    let existingAt = cookies.find((c) => c.name === "at");
    if (!existingAt) {
      // Try to open any "login with email" style panel first.
      const loginEntryButton = page.locator(
        'button:has-text("Email"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Sign in")'
      ).first();
      if (await loginEntryButton.count()) {
        await loginEntryButton.click().catch(() => {});
      }

      try {
        const loginForm = await waitForLoginForm(page, 90_000);
        const emailInput = loginForm.emailInput;
        const passwordInput = loginForm.passwordInput;
        console.log("[refresh-cookie] filling login form");
        await emailInput.fill(email);
        await passwordInput.fill(password);

        const submit = page.locator(
          'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Continue")'
        ).first();
        console.log("[refresh-cookie] submitting login form");
        await submit.click();
        console.log("[refresh-cookie] waiting for auth cookie after submit");
        const hasCookie = await finalizeAuthenticatedSession(page, LOGIN_URL);
        if (!hasCookie) {
          throw new Error("Auth cookie was not set after login.");
        }
      } catch (error) {
        await logPageSnapshot(page, "login-form-failure");
        if (isTimeoutError(error)) {
          throw new Error(
            `Focus login form did not become usable. Current url=${page.url() || "-"}`
          );
        }
        throw error;
      }
      cookies = await context.cookies("https://api.marketech.com.au", "https://focus.marketech.com.au");
      existingAt = cookies.find((c) => c.name === "at");
    }
    const headerValue = cookies
      .filter((c) => c.domain.includes(API_HOST) || c.domain.includes("marketech.com.au"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    if (!headerValue || !headerValue.includes("at=")) {
      throw new Error("Did not capture a valid auth cookie header.");
    }

    writeRuntimeCookie(headerValue);
    if (fs.existsSync(ENV_PATH)) {
      const existingText = fs.readFileSync(ENV_PATH, "utf8");
      const nextText = upsertEnvValue(existingText, "MARKETECH_COOKIE", headerValue);
      fs.writeFileSync(ENV_PATH, nextText, "utf8");
    }
    writeRefreshState({
      isRefreshingCookie: false,
      lastRefreshedAt: new Date().toISOString()
    });
    console.log("Cookie refresh successful.");
    return headerValue;
  } catch (err) {
    writeRefreshState({
      isRefreshingCookie: false,
      lastFailedAt: new Date().toISOString(),
      error: err.message || "Unknown error"
    });
    throw err;
  } finally {
    await browser.close();
  }
  })();

  try {
    return await activeRefreshPromise;
  } finally {
    activeRefreshPromise = null;
  }
}

if (require.main === module) {
  refreshCookie().catch((err) => {
    console.error("Cookie refresh failed:", err.message || "Unknown error");
    process.exit(1);
  });
}

module.exports = { refreshCookie };
