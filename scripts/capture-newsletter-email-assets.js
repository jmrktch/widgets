/*
 * Extracts the image-only assets required by the Daily Focus email.
 * Assets use stable, semantic filenames and replace the previous set on every
 * successful run so GitHub Pages can serve one current URL per asset.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const RENDER_SOURCE = path.resolve(ROOT, process.env.NEWSLETTER_RENDER_SOURCE_DIR || "public/snapshot-renders/latest");
const OUTPUT = path.resolve(ROOT, process.env.NEWSLETTER_ASSET_OUTPUT_DIR || "public/newsletter/latest/assets");
const SNAPSHOT_SOURCE = path.resolve(ROOT, process.env.NEWSLETTER_SNAPSHOT_SOURCE_DIR || "public/snapshot/latest");
const RASTER_SCALE = 2;
const VIEWPORT = { width: 1200, height: 1200 };

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function safeSegment(value, label) {
  const segment = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) throw new Error(`Invalid ${label}: ${value}`);
  return segment;
}

function safeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error(`Invalid sparkline symbol: ${value}`);
  return symbol;
}

function assertOutputPath() {
  const expected = path.resolve(ROOT, "public/newsletter/latest/assets");
  if (OUTPUT !== expected) throw new Error("NEWSLETTER_ASSET_OUTPUT_DIR must be public/newsletter/latest/assets.");
}

function listScanPages() {
  const directory = path.join(RENDER_SOURCE, "scans");
  if (!fs.existsSync(directory)) throw new Error(`Scan render directory does not exist: ${relative(directory)}`);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function screenshotPng(locator, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`Unable to measure ${path.basename(target)}.`);
  await locator.screenshot({ path: target, type: "png", omitBackground: true, animations: "disabled" });
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

async function captureHeatmap(page) {
  const source = path.join(RENDER_SOURCE, "heatmap.html");
  if (!fs.existsSync(source)) throw new Error(`Heatmap render does not exist: ${relative(source)}`);
  await page.goto(pathToFileURL(source).toString(), { waitUntil: "load" });
  const locator = page.locator(".snapshot-heatmap-tiles");
  if (await locator.count() !== 1) throw new Error("Expected exactly one newsletter heatmap target.");
  const file = path.join(OUTPUT, "heatmap.png");
  const dimensions = await screenshotPng(locator, file);
  return { kind: "heatmap", file: relative(file), ...dimensions };
}

async function captureSparklines(page) {
  const captured = [];
  const scans = [];
  const targets = new Set();
  for (const source of listScanPages()) {
    const scan = safeSegment(path.basename(source, ".html"), "scan key");
    await page.goto(pathToFileURL(source).toString(), { waitUntil: "load" });
    const locators = page.locator("svg.snapshot-sparkline");
    const count = await locators.count();
    scans.push({ scan, sparklines: count });
    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index);
      const attributes = await locator.evaluate((node) => ({ scan: node.getAttribute("data-scan"), symbol: node.getAttribute("data-symbol") }));
      const attributedScan = safeSegment(attributes.scan, "sparkline scan key");
      const symbol = safeSymbol(attributes.symbol);
      if (attributedScan !== scan) throw new Error(`Sparkline scan mismatch: ${attributedScan} in ${scan}.`);
      const file = path.join(OUTPUT, "sparklines", scan, `${symbol}.png`);
      const key = path.relative(OUTPUT, file).replace(/\\/g, "/");
      if (targets.has(key)) throw new Error(`Duplicate sparkline asset: ${key}`);
      targets.add(key);
      const dimensions = await screenshotPng(locator, file);
      captured.push({ kind: "sparkline", scan, symbol, file: relative(file), ...dimensions });
    }
  }
  return { assets: captured, scans };
}

async function main() {
  assertOutputPath();
  if (!fs.existsSync(RENDER_SOURCE)) throw new Error(`Render source does not exist: ${relative(RENDER_SOURCE)}`);
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: RASTER_SCALE });
    const page = await context.newPage();
    const heatmap = await captureHeatmap(page);
    const sparklineCapture = await captureSparklines(page);
    await context.close();
    const sourceManifestFile = path.join(SNAPSHOT_SOURCE, "manifest.json");
    const sourceManifest = fs.existsSync(sourceManifestFile) ? JSON.parse(fs.readFileSync(sourceManifestFile, "utf8")) : null;
    const manifest = {
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: sourceManifest?.generatedAt || null,
      rasterScale: RASTER_SCALE,
      scans: sparklineCapture.scans,
      assets: [heatmap, ...sparklineCapture.assets]
    };
    fs.writeFileSync(path.join(OUTPUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, output: relative(OUTPUT), heatmap, sparklines: sparklineCapture.assets.length, scans: sparklineCapture.scans }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
