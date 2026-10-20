require("dotenv").config();

const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = "Australia/Sydney";
// Keep an authentication runway on either side of the ASX 10:00–16:30 session.
const DEFAULT_OPEN_HOUR = 9;
const DEFAULT_CLOSE_HOUR = 17;
const DEFAULT_CLOSE_MINUTE = 30;

function getNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function getStatusUrl() {
  const explicit = String(process.env.COOKIE_STATUS_URL || "").trim();
  if (explicit) return explicit;

  const updateUrl = String(process.env.COOKIE_UPDATE_URL || "").trim();
  if (!updateUrl) return "";

  const url = new URL(updateUrl);
  url.pathname = url.pathname.replace(/\/runtime-cookie\/?$/, "/auth-status");
  return url.toString();
}

function getMarketClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: String(process.env.COOKIE_REFRESH_TIMEZONE || DEFAULT_TIMEZONE),
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    minutes: (Number(values.hour) * 60) + Number(values.minute)
  };
}

function isRefreshWindowOpen(now = new Date()) {
  const { weekday, minutes } = getMarketClock(now);
  const openMinute = (getNumber("COOKIE_REFRESH_OPEN_HOUR", DEFAULT_OPEN_HOUR) * 60)
    + getNumber("COOKIE_REFRESH_OPEN_MINUTE", 0);
  const closeMinute = (getNumber("COOKIE_REFRESH_CLOSE_HOUR", DEFAULT_CLOSE_HOUR) * 60)
    + getNumber("COOKIE_REFRESH_CLOSE_MINUTE", DEFAULT_CLOSE_MINUTE);
  return !["Sat", "Sun"].includes(weekday) && minutes >= openMinute && minutes < closeMinute;
}

function writeGithubOutput(shouldRefresh) {
  if (process.env.GITHUB_OUTPUT) {
    require("fs").appendFileSync(process.env.GITHUB_OUTPUT, `should_refresh=${shouldRefresh}\n`);
  }
}

async function decideCookieRefresh() {
  const inRefreshWindow = isRefreshWindowOpen();
  if (!inRefreshWindow) {
    return { shouldRefresh: false, reason: "outside the configured ASX weekday window" };
  }

  const statusUrl = getStatusUrl();
  const token = String(process.env.COOKIE_UPDATE_TOKEN || "").trim();
  if (!statusUrl || !token) {
    return { shouldRefresh: true, reason: "cookie status configuration is incomplete" };
  }

  try {
    const verifiedStatusUrl = new URL(statusUrl);
    verifiedStatusUrl.searchParams.set("verify", "1");
    const response = await fetch(verifiedStatusUrl, {
      headers: { "x-cookie-update-token": token },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`status endpoint returned ${response.status}`);
    }

    const payload = await response.json();
    const updatedAt = payload?.cookie?.updatedAt;
    const updatedAtMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
    const ageMs = Number.isFinite(updatedAtMs) ? Math.max(Date.now() - updatedAtMs, 0) : Number.POSITIVE_INFINITY;
    const maxAgeMs = getNumber("COOKIE_REFRESH_MAX_AGE_MS", DEFAULT_MAX_AGE_MS);
    const verified = payload?.cookie?.verification?.valid;
    const shouldRefresh = !payload?.cookie?.present || verified !== true || ageMs >= maxAgeMs;

    return {
      shouldRefresh,
      reason: `cookie=${payload?.cookie?.present ? "present" : "missing"} focus=${verified === true ? "accepted" : "rejected"} ageMs=${Number.isFinite(ageMs) ? ageMs : "unknown"} maxAgeMs=${maxAgeMs}`
    };
  } catch (error) {
    // A reachable Action should repair a service whose status route or volume
    // has failed, rather than silently allowing authentication to remain down.
    return { shouldRefresh: true, reason: `status check failed; refreshing to recover: ${error.message}` };
  }
}

async function main() {
  const decision = await decideCookieRefresh();
  console.log(`[should-refresh-cookie] ${decision.reason}; decision=${decision.shouldRefresh ? "refresh" : "keep"}`);
  writeGithubOutput(decision.shouldRefresh);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[should-refresh-cookie] failed: ${error.message || "Unknown error"}`);
    process.exit(1);
  });
}

module.exports = {
  decideCookieRefresh,
  isRefreshWindowOpen
};
