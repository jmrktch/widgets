const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { chromium } = require("playwright");

const ENV_PATH = path.join(__dirname, "..", ".env");
const env = fs.existsSync(ENV_PATH)
  ? dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const LOGIN_URL = process.env.FOCUS_LOGIN_URL || env.FOCUS_LOGIN_URL || "https://focus.marketech.com.au/#/login";
const EMAIL = process.env.FOCUS_EMAIL || env.FOCUS_EMAIL;
const PASSWORD = process.env.FOCUS_PASSWORD || env.FOCUS_PASSWORD;
const SYMBOL = (process.env.PROBE_SYMBOL || env.PROBE_SYMBOL || "ACP").toUpperCase();

async function ensureLoggedIn(page) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  const existingCookies = await page.context().cookies("https://focus.marketech.com.au", "https://api.marketech.com.au");
  if (existingCookies.some((cookie) => cookie.name === "at")) {
    return;
  }

  const loginEntryButton = page.locator(
    'button:has-text("Email"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Sign in")'
  ).first();
  if (await loginEntryButton.count()) {
    await loginEntryButton.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input[id*="email" i], input[placeholder*="email" i], input[autocomplete="username"]'
  ).first();
  const passwordInput = page.locator(
    'input[type="password"], input[name="password"], input[id*="password" i], input[placeholder*="password" i], input[autocomplete="current-password"]'
  ).first();

  await emailInput.waitFor({ state: "visible", timeout: 45000 });
  await emailInput.fill(EMAIL);
  await passwordInput.fill(PASSWORD);

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Continue")'
  ).first();
  await submit.click();
  await page.waitForTimeout(5000);
  await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
}

function logEvent(label, payload) {
  console.log(`\n=== ${label} ===`);
  console.log(payload);
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("Missing FOCUS_EMAIL or FOCUS_PASSWORD in .env");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("request", (request) => {
      const url = request.url();
      if (!url.includes("api.marketech.com.au")) return;
      const postData = request.postData() || "";
      if (
        url.includes("storage/get") ||
        url.includes("candles/get") ||
        url.includes("stream/negotiate") ||
        url.includes("summary") ||
        url.includes("trades") ||
        postData.includes(SYMBOL) ||
        postData.includes("tradesSummary") ||
        postData.includes("summaryDepth")
      ) {
        logEvent("REQUEST", JSON.stringify({
          method: request.method(),
          url,
          postData: postData.slice(0, 1000)
        }, null, 2));
      }
    });

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("api.marketech.com.au")) return;

      const request = response.request();
      const postData = request.postData() || "";
      if (
        url.includes("storage/get") ||
        url.includes("candles/get") ||
        url.includes("stream/negotiate") ||
        url.includes("summary") ||
        url.includes("trades") ||
        postData.includes(SYMBOL) ||
        postData.includes("tradesSummary") ||
        postData.includes("summaryDepth")
      ) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          body = "[unreadable body]";
        }
        logEvent("RESPONSE", JSON.stringify({
          status: response.status(),
          url,
          body: body.slice(0, 2000)
        }, null, 2));
      }
    });

    page.on("websocket", (ws) => {
      logEvent("WEBSOCKET_OPEN", ws.url());

      ws.on("framesent", (event) => {
        const text = event.payload || "";
        if (
          text.includes(SYMBOL) ||
          text.includes("tradesSummary") ||
          text.includes("summaryDepth") ||
          text.includes("ContractKey") ||
          text.includes("Last")
        ) {
          logEvent("WS_SENT", text.slice(0, 3000));
        }
      });

      ws.on("framereceived", (event) => {
        const text = event.payload || "";
        if (
          text.includes(SYMBOL) ||
          text.includes("tradesSummary") ||
          text.includes("summaryDepth") ||
          text.includes("Last") ||
          text.includes("LastTraded")
        ) {
          logEvent("WS_RECV", text.slice(0, 3000));
        }
      });
    });

    await ensureLoggedIn(page);
    await page.goto("https://focus.marketech.com.au/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000);

    const searchInput = page.locator(
      'input[placeholder*="Search" i], input[placeholder*="Code" i], input[placeholder*="Symbol" i], input[aria-label*="Code" i]'
    ).first();

    if (await searchInput.count()) {
      await searchInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.fill(SYMBOL).catch(() => {});
        await page.waitForTimeout(4000);
      }
    }

    const symbolButton = page.locator(`text=${SYMBOL}`).first();
    if (await symbolButton.count()) {
      await symbolButton.click().catch(() => {});
      await page.waitForTimeout(8000);
    } else {
      await page.waitForTimeout(8000);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
