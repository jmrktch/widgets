/*
 * Captures every generated snapshot-render HTML panel as a public JPEG.
 * Scan and benchmark panels use 1920x1080; all other panels use 1080x1080.
 * Each panel is captured in the generated page's light and dark themes.
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
const WIDESCREEN = { name: "16:9", width: 1920, height: 1080, topPadding: 40, sidePadding: 72 };
const SQUARE = { name: "1:1", width: 1080, height: 1080, topPadding: 40, sidePadding: 48 };

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

function formatFor(file) {
  const firstDirectory = relative(file).split("/")[0];
  return firstDirectory === "scans" || firstDirectory === "benchmarks" ? WIDESCREEN : SQUARE;
}

function imageTarget(file, theme) {
  const relativeImage = relative(file).replace(/\.html$/i, ".jpg");
  return path.join(OUTPUT, theme.name, relativeImage);
}

async function prepareCanvas(page, format) {
  return page.evaluate(({ width, height, topPadding, sidePadding }) => {
    const contentNodes = Array.from(document.body.childNodes);
    const bounds = Array.from(document.body.children).map((element) => element.getBoundingClientRect());
    const sourceLeft = Math.min(...bounds.map((bound) => bound.left));
    const sourceTop = Math.min(...bounds.map((bound) => bound.top));
    const sourceRight = Math.max(...bounds.map((bound) => bound.right));
    const sourceBottom = Math.max(...bounds.map((bound) => bound.bottom));
    // Snapshot panels have a fixed 1200px content width. Measuring the
    // document's scroll width instead would capture the empty viewport around
    // that panel, rather than the panel itself.
    const sourceWidth = Math.ceil(sourceRight - sourceLeft);
    const sourceHeight = Math.ceil(sourceBottom - sourceTop);
    const canvasBackground = getComputedStyle(document.body).backgroundColor || "#ffffff";
    const availableWidth = width - sidePadding * 2;
    const availableHeight = height - topPadding;
    const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);

    const stage = document.createElement("div");
    stage.id = "snapshot-jpeg-stage";
    contentNodes.forEach((node) => stage.appendChild(node));
    document.body.appendChild(stage);

    const style = document.createElement("style");
    style.textContent = `
      html,body{width:${width}px!important;height:${height}px!important;min-width:0!important;margin:0!important;overflow:hidden!important;background:${canvasBackground}!important}
      body{position:relative!important}
      #snapshot-jpeg-stage{position:absolute;top:${topPadding}px;left:50%;width:${sourceWidth}px;height:${sourceHeight}px;transform:translateX(-50%) scale(${scale});transform-origin:top center}
    `;
    document.head.appendChild(style);

    return { sourceWidth, sourceHeight, scale };
  }, format);
}

async function capture(page, file, theme, format) {
  const url = pathToFileURL(file);
  if (theme.query) url.search = theme.query;
  await page.goto(url.toString(), { waitUntil: "load" });
  await page.waitForTimeout(100);
  const layout = await prepareCanvas(page, format);
  const output = imageTarget(file, theme);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, type: "jpeg", quality: 92, animations: "disabled" });
  return { file: path.relative(ROOT, output).replace(/\\/g, "/"), layout };
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
    const page = await browser.newPage({ viewport: { width: WIDESCREEN.width, height: WIDESCREEN.height }, deviceScaleFactor: 1 });
    for (const file of pages) {
      const format = formatFor(file);
      await page.setViewportSize({ width: format.width, height: format.height });
      const variants = [];
      for (const theme of THEMES) variants.push({ theme: theme.name, ...(await capture(page, file, theme, format)) });
      assets.push({ source: relative(file), ratio: format.name, width: format.width, height: format.height, variants });
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
