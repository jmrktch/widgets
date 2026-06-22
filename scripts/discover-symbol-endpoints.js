const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const ENV_PATH = path.join(__dirname, "..", ".env");
const env = fs.existsSync(ENV_PATH)
  ? dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const LOGIN_URL = process.env.FOCUS_LOGIN_URL || env.FOCUS_LOGIN_URL || "https://focus.marketech.com.au/#/login";
const EMAIL = process.env.FOCUS_EMAIL || env.FOCUS_EMAIL;
const PASSWORD = process.env.FOCUS_PASSWORD || env.FOCUS_PASSWORD;

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

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("Missing FOCUS_EMAIL or FOCUS_PASSWORD in .env");
  }

  const seen = new Map();
  const matches = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("marketech")) return;
      if (seen.has(url)) return;

      const request = response.request();
      const method = request.method();
      const status = response.status();

      let preview = "";
      try {
        const text = await response.text();
        preview = text.slice(0, 250).replace(/\s+/g, " ");
      } catch {
        preview = "[unreadable body]";
      }

      seen.set(url, true);
      matches.push({
        method,
        status,
        url,
        postData: request.postData() ? request.postData().slice(0, 250) : null,
        preview
      });
    });

    await ensureLoggedIn(page);
    await page.goto("https://focus.marketech.com.au/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);

    // Trigger likely discovery/search/watchlist related UI without assuming exact layout.
    const candidateSelectors = [
      'input[placeholder*="Search" i]',
      'input[placeholder*="Code" i]',
      'input[placeholder*="Symbol" i]',
      'button:has-text("Watchlist")',
      'a:has-text("Watchlist")',
      'button:has-text("Markets")',
      'a:has-text("Markets")'
    ];

    for (const selector of candidateSelectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    const searchInput = page.locator(
      'input[placeholder*="Search" i], input[placeholder*="Code" i], input[placeholder*="Symbol" i]'
    ).filter({ hasNot: page.locator('[aria-hidden="true"]') }).first();
    if (await searchInput.count()) {
      await searchInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.fill("BHP").catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    await page.waitForTimeout(5000);

    console.log(JSON.stringify(matches, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
