/*
 * Captures every generated snapshot-render HTML panel as a public JPEG.
 * Each panel is captured directly from its generated DOM in light and dark
 * themes, at four times its CSS-pixel resolution.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const INPUT = path.resolve(ROOT, process.env.SNAPSHOT_RENDER_IMAGE_SOURCE_DIR || "public/snapshot-renders/latest");
const OUTPUT = path.resolve(ROOT, process.env.SNAPSHOT_RENDER_IMAGE_OUTPUT_DIR || path.join(INPUT, "images"));
const LIGHT = { name: "light", query: "" };
const DARK = { name: "dark", query: "theme=dark" };
const THEMES = [LIGHT, DARK];
const RASTER_SCALE = 4;
const MAX_PANEL_SIZE = 1200;

function relative(file) {
  return path.relative(INPUT, file).replace(/\\/g, "/");
}

function listHtml(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "images" ? [] : listHtml(target);
      return entry.isFile() && entry.name.toLowerCase().endsWith(".html") ? [target] : [];
    })
    .sort((left, right) => relative(left).localeCompare(relative(right)));
}

function imageTarget(file, theme) {
  const relativeImage = relative(file).replace(/\.html$/i, ".jpg");
  return path.join(OUTPUT, theme.name, relativeImage);
}

async function capture(page, file, theme) {
  const url = pathToFileURL(file);
  if (theme.query) url.search = theme.query;
  await page.goto(url.toString(), { waitUntil: "load" });
  await page.waitForTimeout(100);
  const panel = page.locator("body > *").first();
  const box = await panel.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`Could not measure rendered panel: ${relative(file)}`);
  const output = imageTarget(file, theme);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await panel.screenshot({ path: output, type: "jpeg", quality: 92, animations: "disabled" });
  const sourceWidth = Math.round(box.width), sourceHeight = Math.round(box.height);
  return {
    file: path.relative(ROOT, output).replace(/\\/g, "/"),
    layout: { sourceWidth, sourceHeight, scale: RASTER_SCALE },
    width: sourceWidth * RASTER_SCALE,
    height: sourceHeight * RASTER_SCALE
  };
}

async function main() {
  if (!fs.existsSync(INPUT)) throw new Error(`Snapshot render directory does not exist: ${path.relative(ROOT, INPUT)}`);
  if (path.relative(INPUT, OUTPUT).startsWith("..") || INPUT === OUTPUT) {
    throw new Error("SNAPSHOT_RENDER_IMAGE_OUTPUT_DIR must be a child directory of the render directory.");
  }

  const pages = listHtml(INPUT);
  if (!pages.length) throw new Error(`No HTML files found under ${path.relative(ROOT, INPUT)}`);
  fs.rmSync(OUTPUT, { recursive: true, force: true });

  const browser = await chromium.launch({ headless: true });
  const assets = [];
  try {
    const page = await browser.newPage({ viewport: { width: MAX_PANEL_SIZE, height: MAX_PANEL_SIZE }, deviceScaleFactor: RASTER_SCALE });
    for (const file of pages) {
      const variants = [];
      for (const theme of THEMES) variants.push({ theme: theme.name, ...(await capture(page, file, theme)) });
      const { layout, width, height } = variants[0];
      assets.push({ source: relative(file), ratio: layout.sourceWidth === layout.sourceHeight ? "1:1" : "source", width, height, variants });
    }
  } finally {
    await browser.close();
  }

  const sourceManifestPath = path.join(INPUT, "manifest.json");
  const sourceManifest = fs.existsSync(sourceManifestPath) ? JSON.parse(fs.readFileSync(sourceManifestPath, "utf8")) : null;
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: sourceManifest?.sourceGeneratedAt || null,
    format: "jpeg",
    quality: 92,
    rasterScale: RASTER_SCALE,
    themes: THEMES.map((theme) => theme.name),
    output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/"),
    assets
  };
  fs.writeFileSync(path.join(OUTPUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, output: manifest.output, pages: pages.length, images: pages.length * THEMES.length }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
