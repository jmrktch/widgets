const { spawnSync } = require("child_process");

const shouldInstall =
  String(process.env.CI || "").toLowerCase() === "true" ||
  String(process.env.NORTHFLANK_PROJECT_ID || "").trim() !== "" ||
  String(process.env.PLAYWRIGHT_INSTALL_CHROMIUM || "").toLowerCase() === "true";

if (!shouldInstall) {
  console.log("[postinstall] Skipping Playwright browser install outside CI/hosted deploy.");
  process.exit(0);
}

const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "0"
};

console.log("[postinstall] Installing Playwright Chromium for hosted runtime...");

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["playwright", "install", "chromium"], {
  stdio: "inherit",
  env
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
