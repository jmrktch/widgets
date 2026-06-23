require("dotenv").config();

const { refreshCookie } = require("./refresh-cookie");

function getRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      raw: text
    };
  }
}

async function runRefreshCookieJob() {
  const targetUrl = getRequiredEnv("COOKIE_UPDATE_URL");
  const token = getRequiredEnv("COOKIE_UPDATE_TOKEN");
  const source = String(process.env.COOKIE_UPDATE_SOURCE || "northflank-job").trim() || "northflank-job";

  console.log(`[refresh-cookie-job] starting for ${targetUrl}`);
  const cookie = await refreshCookie();
  console.log("[refresh-cookie-job] cookie captured, pushing to service");

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cookie-update-token": token
    },
    body: JSON.stringify({
      cookie,
      source
    })
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Cookie update failed (${response.status}): ${payload?.error || payload?.raw || "Unknown error"}`);
  }

  console.log("[refresh-cookie-job] cookie update succeeded");
  if (payload?.diagnostics?.cookie) {
    console.log("[refresh-cookie-job] service diagnostics", payload.diagnostics.cookie);
  }
}

if (require.main === module) {
  runRefreshCookieJob().catch((error) => {
    console.error(`[refresh-cookie-job] failed: ${error?.message || "Unknown error"}`);
    process.exit(1);
  });
}

module.exports = {
  runRefreshCookieJob
};
