require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createFocusBrowserSession, getFocusBaseUrl, logPageSnapshot } = require("../lib/focus-browser-session");

const ROOT = path.join(__dirname, "..");
const OUTPUT_FILE = path.join(ROOT, "public", "heatmap.json");
const DEBUG_OUTPUT = process.argv.includes("--debug");

async function dismissBlockingOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator('[aria-label="Close window"], button:has-text("Close"), button:has-text("Dismiss")').first().click({
    timeout: 1500
  }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll("#userflow-ui,.userflowjs-modal-backdrop,.userflowjs-bubble,.userflowjs-tooltip")
      .forEach((element) => element.remove());
  }).catch(() => {});
}

async function tryClick(locator, timeoutMs = 4000) {
  try {
    if (await locator.count()) {
      await locator.first().click({ force: true, timeout: timeoutMs });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function openFocusHome(page) {
  await page.goto(new URL("/#/", `${getFocusBaseUrl()}/`).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await dismissBlockingOverlays(page);
}

async function switchMainWidget(page, widgetName) {
  await dismissBlockingOverlays(page);
  const menuButton = page.locator('div#main tile-widget-menu [aria-label="Change window content"]').first();
  if (!(await tryClick(menuButton, 5000))) return false;

  await page.waitForTimeout(600);
  const choices = [
    page.locator(`._md.md-open-menu-container[aria-hidden="false"] [aria-label="Change window to ${widgetName}"]`),
    page.locator(`._md.md-open-menu-container [aria-label="Change window to ${widgetName}"]`),
    page.getByRole("menuitem", { name: widgetName }),
    page.locator(`button:has-text("${widgetName}")`)
  ];

  for (const choice of choices) {
    if (await tryClick(choice, 5000)) {
      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await dismissBlockingOverlays(page);
      return true;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function extractHeatmapJson(page) {
  await page.locator("div#main .highcharts-root, div#main .heatmap-label").first().waitFor({
    state: "attached",
    timeout: 25_000
  });

  return page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function numeric(value) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const cleaned = String(value || "").replace(/[%,$]/g, "").replace(/,/g, "").trim();
      if (!cleaned) return null;
      const parsed = Number.parseFloat(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function shape(point) {
      const args = point?.shapeArgs || {};
      return {
        x: typeof args.x === "number" ? Math.round(args.x * 100) / 100 : null,
        y: typeof args.y === "number" ? Math.round(args.y * 100) / 100 : null,
        width: typeof args.width === "number" ? Math.round(args.width * 100) / 100 : null,
        height: typeof args.height === "number" ? Math.round(args.height * 100) / 100 : null
      };
    }

    function labelRect(label) {
      const styles = window.getComputedStyle(label);
      return {
        x: numeric(styles.left),
        y: numeric(styles.top),
        width: numeric(styles.width),
        height: numeric(styles.height)
      };
    }

    function parseLabel(label) {
      const text = clean(label.innerText || label.textContent);
      const percentMatch = text.match(/[-+]?\d+(?:\.\d+)?%/);
      const parts = text.split(/\s+/).filter(Boolean);
      return {
        text,
        code: parts[0] || null,
        changePercentDisplay: percentMatch ? percentMatch[0] : null,
        changePercent: percentMatch ? numeric(percentMatch[0]) : null,
        size: label.getAttribute("size") || null,
        rect: labelRect(label)
      };
    }

    const chart = (window.Highcharts?.charts || [])
      .filter(Boolean)
      .find((candidate) => {
        const container = candidate.container;
        return container && document.querySelector("div#main")?.contains(container) && candidate.series?.some((series) => /tree/i.test(series.type || ""));
      }) || (window.Highcharts?.charts || [])
      .filter(Boolean)
      .find((candidate) => candidate.series?.some((series) => /tree/i.test(series.type || "")));

    const visibleLabels = Array.from(document.querySelectorAll("div#main .heatmap-label.heatmap-point"))
      .map(parseLabel)
      .filter((label) => label.text);
    const visibleGroups = Array.from(document.querySelectorAll("div#main .heatmap-label.heatmap-group"))
      .map((label) => ({
        name: clean(label.innerText || label.textContent),
        size: label.getAttribute("size") || null,
        rect: labelRect(label)
      }))
      .filter((group) => group.name);
    const labelsByCode = new Map(visibleLabels.filter((label) => label.code).map((label) => [label.code, label]));

    if (!chart) {
      return {
        extractedAt: new Date().toISOString(),
        source: "Focus rendered heatmap labels",
        chart: null,
        sectors: visibleGroups.map((group) => ({ ...group, stocks: [] })),
        stocks: visibleLabels
      };
    }

    const series = chart.series.find((candidate) => /tree/i.test(candidate.type || "")) || chart.series[0];
    const points = (series.points || []).map((point) => {
      const options = point.options || {};
      const name = clean(point.name || options.name || point.id || options.id);
      const parent = clean(point.parent || options.parent);
      const label = labelsByCode.get(name) || null;
      const isSector = !parent || point.node?.children?.length > 0;

      return {
        id: clean(point.id || options.id || name) || null,
        parent: parent || null,
        name: name || null,
        code: isSector ? null : name || null,
        sector: null,
        isSector,
        weight: typeof point.value === "number" ? point.value : typeof options.value === "number" ? options.value : null,
        changePercent: typeof point.colorValue === "number" ? point.colorValue : label?.changePercent ?? null,
        changePercentDisplay: label?.changePercentDisplay || null,
        color: point.color || options.color || null,
        rect: shape(point),
        label: label ? {
          text: label.text,
          size: label.size,
          rect: label.rect
        } : null
      };
    });

    const sectorsById = new Map(points.filter((point) => point.isSector).map((point) => [point.id || point.name, {
      id: point.id,
      name: point.name,
      rect: point.rect,
      stocks: []
    }]));

    const stocks = points.filter((point) => !point.isSector).map((stock) => {
      const parentSector = sectorsById.get(stock.parent);
      const mapped = {
        ...stock,
        sector: parentSector?.name || stock.parent || null
      };
      delete mapped.isSector;
      if (parentSector) parentSector.stocks.push(mapped);
      return mapped;
    });

    const sectors = Array.from(sectorsById.values())
      .map((sector) => ({
        ...sector,
        stocks: sector.stocks.sort((a, b) => (b.weight || 0) - (a.weight || 0))
      }))
      .filter((sector) => sector.stocks.length || visibleGroups.some((group) => group.name === sector.name));

    return {
      extractedAt: new Date().toISOString(),
      source: "Focus Highcharts heatmap model",
      chart: {
        width: chart.chartWidth || null,
        height: chart.chartHeight || null,
        plotWidth: chart.plotWidth || null,
        plotHeight: chart.plotHeight || null,
        pointCount: stocks.length,
        sectorCount: sectors.length
      },
      sectors,
      stocks,
      visibleLabels,
      visibleGroups
    };
  });
}

async function main() {
  const apiCalls = [];
  const storageGetResponses = [];
  const session = await createFocusBrowserSession();

  session.page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("api.marketech.com.au")) return;
    apiCalls.push({
      method: request.method(),
      url,
      postData: request.postData() || null
    });
  });

  session.page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("api.marketech.com.au/storage/get")) return;
    try {
      storageGetResponses.push({
        status: response.status(),
        url,
        payload: await response.json()
      });
    } catch {
      storageGetResponses.push({
        status: response.status(),
        url,
        payload: null
      });
    }
  });

  try {
    await openFocusHome(session.page);
    if (!(await switchMainWidget(session.page, "Heatmap"))) {
      throw new Error("Could not switch main Focus tile to Heatmap.");
    }

    const output = await extractHeatmapJson(session.page);
    if (DEBUG_OUTPUT) {
      output.debug = {
        apiCalls: apiCalls
          .filter((call) => !/marketDepth|orders|account/i.test(call.url))
          .slice(-40),
        storageGetResponses: storageGetResponses.slice(-10)
      };
    }

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    console.log(JSON.stringify({
      ok: Boolean(output.chart?.pointCount || output.stocks?.length),
      output: path.relative(ROOT, OUTPUT_FILE),
      source: output.source,
      chart: output.chart,
      firstSector: output.sectors?.[0] ? {
        name: output.sectors[0].name,
        stocks: output.sectors[0].stocks.length
      } : null,
      firstStock: output.stocks?.[0] || null
    }, null, 2));
  } catch (error) {
    await logPageSnapshot(session.page, "heatmap-json-failure").catch(() => {});
    throw error;
  } finally {
    await session.browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
