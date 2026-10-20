require("dotenv").config();

const { decideCookieRefresh } = require("./should-refresh-cookie");
const { runRefreshCookieJob } = require("./refresh-cookie-job");

const CHECK_INTERVAL_MS = Math.max(60_000, Number(process.env.COOKIE_REFRESH_CHECK_INTERVAL_MS || 10 * 60 * 1000));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOnce() {
  const decision = await decideCookieRefresh();
  console.log(`[watch-cookie-refresh] ${decision.reason}; decision=${decision.shouldRefresh ? "refresh" : "keep"}`);
  if (decision.shouldRefresh) {
    await runRefreshCookieJob();
    const verification = await decideCookieRefresh();
    console.log(`[watch-cookie-refresh] post-refresh ${verification.reason}; decision=${verification.shouldRefresh ? "refresh" : "keep"}`);
    if (verification.shouldRefresh) {
      throw new Error("Fresh cookie did not pass Focus verification.");
    }
  }
}

async function main() {
  console.log(`[watch-cookie-refresh] checking every ${CHECK_INTERVAL_MS}ms`);
  while (true) {
    try {
      await checkOnce();
    } catch (error) {
      // Keep the local soak test alive so the next scheduled check can recover.
      console.error(`[watch-cookie-refresh] check failed: ${error.message || error}`);
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(`[watch-cookie-refresh] fatal: ${error.message || error}`);
  process.exit(1);
});
