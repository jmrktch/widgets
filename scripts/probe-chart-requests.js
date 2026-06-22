const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const readline = require("readline");
const { chromium } = require("playwright");

const ENV_PATH = path.join(__dirname, "..", ".env");
const OUTPUT_PATH = path.join(__dirname, "..", "chart-request-log.json");

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
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

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const env = readEnv();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const events = [];

  page.on("request", (request) => {
    if (!request.url().includes("/candles/get")) {
      return;
    }

    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData() || null;
    }

    events.push({
      capturedAt: new Date().toISOString(),
      url: request.url(),
      method: request.method(),
      body
    });
  });

  await loginPage(page, env);
  await page.goto("https://focus.marketech.com.au/", { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("Browser is open.");
  console.log("Open a stock chart in Focus and click through the chart ranges you care about.");
  console.log("When done, come back here and press Enter.");

  await waitForEnter("Press Enter to save captured chart requests...");

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(events, null, 2) + "\n", "utf8");
  console.log(`Saved ${events.length} chart request(s) to ${OUTPUT_PATH}`);

  await browser.close();
}

main().catch((err) => {
  console.error("Chart request probe failed:", err.message || "Unknown error");
  process.exit(1);
});
