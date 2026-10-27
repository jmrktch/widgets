require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createFocusBrowserSession, getFocusBaseUrl, loginFocusPage, logPageSnapshot } = require("../lib/focus-browser-session");

const ROOT = path.join(__dirname, "..");
const DEBUG_OUTPUT = process.argv.includes("--debug");
const SPARKLINE_MAX_POINTS = Number(process.env.BRIEF_SPARKLINE_MAX_POINTS || 26);
function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.findIndex((arg) => arg.startsWith(prefix));
  if (index === -1) return fallback;

  const parts = [process.argv[index].slice(prefix.length)];
  while (
    parts.length &&
    /^["']/.test(parts[0]) &&
    !new RegExp(`${parts[0][0]}$`).test(parts[parts.length - 1]) &&
    index + parts.length < process.argv.length
  ) {
    parts.push(process.argv[index + parts.length]);
  }

  return parts.join(" ").replace(/^["']|["']$/g, "") || fallback;
}

const SCAN_NAME = readArg("scan", "Top Gainers");
const LIMIT = Number(readArg("limit", 5));
const ALL_SCAN_NAMES = [
  "Top Gainers",
  "Top Losers",
  "Unusual Volume",
  "Gapped Up",
  "Gapped Down",
  "Trading Halt",
  "52 Week High",
  "52 Week Low",
  "RSI Oversold",
  "RSI Overbought"
];
// These scans use a Top 500-by-market-cap candidate universe before Focus
// applies its native gap ranking. All other scans retain their native target.
const MARKET_CAP_TOP_500_SCANS = new Set([
  "Gapped Up",
  "Gapped Down"
]);
// For these lists, publish every qualifying company largest-first. This is
// deliberately separate from the platform's native scan configuration, which
// decides whether a company belongs in the result set.
const MARKET_CAP_OUTPUT_ORDER_SCANS = new Set([
  "52 Week High",
  "52 Week Low"
]);
// TMX does not provide the volume data required for a trustworthy unusual-volume scan.
const SCAN_NAMES = process.argv.includes("--all")
  ? ALL_SCAN_NAMES.filter((name) => name !== "Unusual Volume")
  : [SCAN_NAME];


function outputFileFor(scanName) {
  return path.join(ROOT, "public", `${scanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-direct-scan.json`);
}

async function openFocusHome(page) {
  const url = new URL("/#/", `${getFocusBaseUrl()}/`).toString();
  const readyTimeoutMs = Math.max(15_000, Number(process.env.FOCUS_APP_READY_TIMEOUT_MS || 60_000));

  // Do not use networkidle here: the live SignalR connection can keep it
  // pending on cloud runners even after the app is usable.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    try {
      await page.waitForFunction(() => {
        const root = document.querySelector("[ng-app]") || document.body;
        const injector = window.angular?.element?.(root)?.injector?.();
        const movers = injector?.get?.("marketMoversService");
        return Boolean(movers?.getMoverByName?.("Top Gainers"));
      }, null, { timeout: readyTimeoutMs });
      await page.waitForTimeout(500);
      return;
    } catch (error) {
      await logPageSnapshot(page, `focus-home-not-ready-attempt-${attempt}`);
      if (/\/login(?:[/?#]|$)/i.test(page.url())) {
        await loginFocusPage(page);
      }
      if (attempt === 2) throw error;
    }
  }
}

async function collectScansWithPage(page, timing = {}) {
  const startedAt = Date.now();
  const scanLimit = Math.max(1, Number(timing.limit || LIMIT));
  const scanNames = timing.scanNames || (timing.all ? ALL_SCAN_NAMES.filter((name) => name !== "Unusual Volume") : SCAN_NAMES);
  const summaries = [];

    for (const scanName of scanNames) {
      console.log(`[scan] ${scanName}`);

      const output = await page.evaluate(async ({ scanName, limit, scanFetchLimit, universeLimit, marketCapTop500Scans, marketCapOutputOrderScans, debugOutput, sparklineMaxPoints }) => {
      const startedAt = Date.now();

      function clean(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function jsonSafe(value, depth = 0, seen = new WeakSet()) {
        if (value === null || value === undefined) return value;
        if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
        if (typeof value !== "object") return value;
        if (seen.has(value)) return "[circular]";
        if (depth > 6) return `[${Array.isArray(value) ? "array" : "object"}]`;
        seen.add(value);
        if (Array.isArray(value)) return value.slice(0, 200).map((item) => jsonSafe(item, depth + 1, seen));
        return Object.fromEntries(Object.keys(value).slice(0, 160).map((key) => {
          try {
            return [key, jsonSafe(value[key], depth + 1, seen)];
          } catch (error) {
            return [key, `[unreadable: ${error.message || error}]`];
          }
        }));
      }

      function getInjector() {
        const root = document.querySelector("[ng-app]") || document.body;
        return window.angular?.element?.(root)?.injector?.() || null;
      }

      function toContractId(contract) {
        if (window.Helper?.toId) return window.Helper.toId(contract);
        return [contract?.ProviderKey || "$", contract?.ProductType, contract?.Exchange, contract?.Symbol].filter(Boolean).join(".");
      }

      function metadataValue(metadata, key) {
        const item = Array.isArray(metadata) ? metadata.find((entry) => entry?.Key === key) : null;
        return item?.Value ?? item?.value ?? null;
      }

      function firstMetadataNumber(metadata, keys) {
        for (const key of keys) {
          const value = metadataValue(metadata, key);
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
        return null;
      }

      function metadataVolume(metadata) {
        return firstMetadataNumber(metadata, [
          "slot0_volumeValue",
          "slot1_volumeValue",
          "slot2_volumeValue",
          "slot3_volumeValue",
          "volumeValue",
          "Volume"
        ]);
      }

      function mapMessages(payload) {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.Messages)) return payload.Messages;
        return [];
      }

      function pickFirstNumber(object, keys) {
        for (const key of keys) {
          const value = object?.[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
        return null;
      }

      function pickIndexSet(length, maxPoints) {
        if (length <= maxPoints) return Array.from({ length }, (_, index) => index);
        const indexes = new Set([0, length - 1]);
        const slots = Math.max(maxPoints - 1, 1);
        for (let index = 1; index < slots; index += 1) {
          indexes.add(Math.round((index * (length - 1)) / slots));
        }
        return Array.from(indexes).sort((a, b) => a - b).slice(0, maxPoints);
      }

      function compactSparkline(candles) {
        const valid = mapMessages(candles)
          .filter((candle) => candle?.TimeStamp && typeof candle.Close === "number")
          .map((candle) => ({
            time: candle.TimeStamp,
            open: typeof candle.Open === "number" ? candle.Open : null,
            high: typeof candle.High === "number" ? candle.High : null,
            low: typeof candle.Low === "number" ? candle.Low : null,
            close: candle.Close,
            volume: typeof candle.Volume === "number" ? candle.Volume : null
          }));

        const first = valid[0] || null;
        const indexes = pickIndexSet(valid.length, sparklineMaxPoints);
        return {
          interval: {
            amount: 5,
            basis: "Minute"
          },
          sourcePointCount: valid.length,
          open: typeof first?.open === "number" ? first.open : typeof first?.close === "number" ? first.close : null,
          series: indexes
            .map((index) => valid[index]?.close)
            .filter((value) => typeof value === "number"),
          volumeSeries: indexes
            .map((index) => valid[index]?.volume)
            .filter((value) => typeof value === "number"),
          latestVolume: valid.findLast((item) => typeof item.volume === "number")?.volume ?? null
        };
      }

      function parseStreamPacket(packet, fallbackLimit) {
        if (Array.isArray(packet?.list)) {
          return packet.list
            .filter((item) => item?.type !== "Delete" && item?.contract)
            .map((item, index) => {
              const contract = item.contract;
              const metadata = item.metadata || [];
              const last = metadataValue(metadata, "slot0_priceValue") ?? metadataValue(metadata, "priceValue") ?? null;
              const changePercent = metadataValue(metadata, "slot1_percValue") ?? metadataValue(metadata, "slot0_percValue") ?? metadataValue(metadata, "percValue") ?? null;
              const scanMetric = firstMetadataNumber(metadata, [
                "slot0_percValue",
                "slot0_ratioValue",
                "slot0_bigDollarValue",
                "slot1_percValue",
                "slot1_ratioValue",
                "percValue",
                "mathsPctChange"
              ]);
              const previous = typeof last === "number" && typeof changePercent === "number"
                ? last / (1 + (changePercent / 100))
                : null;
              return {
                position: index,
                code: contract.Symbol || null,
                name: contract.Name || contract.DisplayName || null,
                contractKey: {
                  providerKey: contract.ProviderKey || "$",
                  productType: contract.ProductType || null,
                  exchange: contract.Exchange || null,
                  symbol: contract.Symbol || null
                },
                id: item.$id || toContractId(contract),
                last,
                change: previous === null ? null : last - previous,
                changePercent,
                scanMetric,
                volume: metadataVolume(metadata),
                marketCap: metadataValue(metadata, "slot3_bigDollarValue") ?? metadataValue(metadata, "slot2_bigDollarValue") ?? metadataValue(metadata, "slot0_marketCap") ?? metadataValue(metadata, "marketCap") ?? null,
                metadata: metadata.map((entry) => ({ key: entry.Key, value: entry.Value }))
              };
            })
            .slice(0, fallbackLimit);
        }

        const messages = Array.isArray(packet?.Messages) ? packet.Messages : [];
        const rows = [];
        for (const message of messages) {
          for (const item of message.Items || []) {
            if (item?.Type === "Delete" || !item?.Match?.Contract) continue;
            const match = item.Match;
            const contract = match.Contract;
            const metadata = match.Metadata || [];
            const scanMetric = firstMetadataNumber(metadata, [
              "slot0_percValue",
              "slot0_ratioValue",
              "slot0_bigDollarValue",
              "slot1_percValue",
              "slot1_ratioValue",
              "percValue",
              "mathsPctChange"
            ]);
            rows.push({
              position: item.NewPosition ?? rows.length,
              code: contract.Symbol || null,
              name: contract.Name || contract.DisplayName || null,
              contractKey: {
                providerKey: contract.ProviderKey || "$",
                productType: contract.ProductType || null,
                exchange: contract.Exchange || null,
                symbol: contract.Symbol || null
              },
              id: toContractId(contract),
              last: metadataValue(metadata, "slot0_priceValue") ?? metadataValue(metadata, "priceValue") ?? null,
              change: metadataValue(metadata, "slot0_changeValue") ?? metadataValue(metadata, "changeValue") ?? null,
              changePercent: metadataValue(metadata, "slot0_percValue") ?? metadataValue(metadata, "percValue") ?? metadataValue(metadata, "mathsPctChange") ?? null,
              scanMetric,
              volume: metadataVolume(metadata),
              marketCap: metadataValue(metadata, "slot3_bigDollarValue") ?? metadataValue(metadata, "slot2_bigDollarValue") ?? metadataValue(metadata, "slot0_marketCap") ?? metadataValue(metadata, "marketCap") ?? null,
              metadata: metadata.map((entry) => ({ key: entry.Key, value: entry.Value }))
            });
          }
        }
        return rows
          .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
          .slice(0, fallbackLimit);
      }

      async function enrichRows(rows) {
        const uniqueCodes = Array.from(new Set(rows.map((row) => row.code).filter(Boolean)));
        const contractsBySymbol = new Map();
        await Promise.all(uniqueCodes.map(async (symbol) => {
          try {
            const response = await fetch("https://api.marketech.com.au/contracts/search", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json;charset=UTF-8",
                Accept: "application/json, text/plain, */*"
              },
              body: JSON.stringify({
                searchTerm: {
                  Terms: [
                    { Text: symbol, Fields: "Symbol" }
                  ]
                }
              })
            });
            const payload = await response.json().catch(() => null);
            const messages = Array.isArray(payload) ? payload : Array.isArray(payload?.Messages) ? payload.Messages : [];
            const match = messages.find((item) =>
              item?.Symbol === symbol &&
              (!item.ProductType || item.ProductType === rows.find((row) => row.code === symbol)?.contractKey?.productType) &&
              (!item.Exchange || item.Exchange === rows.find((row) => row.code === symbol)?.contractKey?.exchange)
            ) || messages.find((item) => item?.Symbol === symbol);
            if (match) contractsBySymbol.set(symbol, match);
          } catch {
            // Keep scan rows even if enrichment fails.
          }
        }));

        const now = new Date();
        const start = new Date(now.getTime() - 10 * 60 * 60 * 1000);

        const enrichedBySymbol = new Map(await Promise.all(rows.map(async (row) => {
          const contractKey = {
            ProviderKey: row.contractKey.providerKey || "$",
            ProductType: row.contractKey.productType || "Stock",
            Exchange: row.contractKey.exchange || "XASX",
            Symbol: row.contractKey.symbol || row.code
          };

          const [candlesResult, totmResult] = await Promise.all([
            fetch("https://api.marketech.com.au/candles/get", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json;charset=UTF-8",
                Accept: "application/json, text/plain, */*"
              },
              body: JSON.stringify({
                contractKey,
                interval: {
                  Amount: 5,
                  Basis: "Minute"
                },
                start: start.toISOString(),
                end: now.toISOString(),
                options: {
                  CompleteOnly: false
                }
              })
            }).then(async (response) => ({ status: response.status, payload: await response.json().catch(() => null) })).catch((error) => ({ error: error.message || String(error) })),
            fetch("https://api.marketech.com.au/totm/get", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json;charset=UTF-8",
                Accept: "application/json, text/plain, */*"
              },
              body: JSON.stringify({
                contractKey,
                interval: {
                  Basis: "Day",
                  Amount: 1
                },
                version: 2
              })
            }).then(async (response) => ({ status: response.status, payload: await response.json().catch(() => null) })).catch((error) => ({ error: error.message || String(error) }))
          ]);

          const totm = mapMessages(totmResult.payload)[0] || {};
          const marketCap = pickFirstNumber(totm, [
            "MarketCap",
            "MarketCapitalisation",
            "MarketCapitalization",
            "MarketValue",
            "Capitalisation",
            "Capitalization"
          ]);
          const computedMarketCap = typeof marketCap === "number"
            ? marketCap
            : (typeof totm.Last === "number" && typeof totm.SharesOutstanding === "number"
                ? totm.Last * totm.SharesOutstanding
                : null);
          const quoteLast = typeof totm.Last === "number" ? totm.Last : null;
          const quotePreviousClose = typeof totm.PreviousClose === "number" ? totm.PreviousClose : null;
          const quoteChange = typeof quoteLast === "number" && typeof quotePreviousClose === "number"
            ? quoteLast - quotePreviousClose
            : null;
          const quoteChangePercent = typeof quoteChange === "number" && quotePreviousClose
            ? (quoteChange / quotePreviousClose) * 100
            : null;

          return [row.code, {
            candles: candlesResult,
            sparkline: compactSparkline(candlesResult.payload),
            last: quoteLast,
            change: quoteChange,
            changePercent: quoteChangePercent,
            marketCap: computedMarketCap,
            quote: {
              status: totmResult.status || null,
              last: quoteLast,
              previousClose: quotePreviousClose,
              sharesOutstanding: typeof totm.SharesOutstanding === "number" ? totm.SharesOutstanding : null,
              lastTraded: totm.LastTraded || null,
              timestamp: totm.TimeStamp || null
            },
            debug: debugOutput ? {
              totmKeys: Object.keys(totm),
              totm,
              candlesStatus: candlesResult.status || null
            } : undefined
          }];
        })));

        return rows.map((row) => {
          const contract = contractsBySymbol.get(row.code);
          const enriched = enrichedBySymbol.get(row.code) || {};
          const scanMetric = row.scanMetric ?? row.changePercent;
          const outputLast = enriched.last ?? row.last ?? null;
          const outputChange = enriched.change ?? row.change ?? null;
          const outputChangePercent = enriched.changePercent ?? row.changePercent ?? null;
          return {
            code: row.code,
            name: row.name || contract?.Name || null,
            dailySparkline: enriched.sparkline || compactSparkline([]),
            last: outputLast,
            change: typeof outputChange === "number" ? Number(outputChange.toFixed(6)) : outputChange,
            changePercent: typeof outputChangePercent === "number" ? Number(outputChangePercent.toFixed(6)) : outputChangePercent,
            marketCap: row.marketCap ?? enriched.marketCap ?? null,
            scanMetric,
            volume: row.volume ?? enriched.sparkline?.latestVolume ?? null,
            volumeVsAverage: scanMetric,
            contractKey: row.contractKey,
            quote: enriched.quote || null,
            metadata: row.metadata,
            ...(debugOutput ? { debug: enriched.debug || null } : {})
          };
        });
      }

      function selectPlatformRows(rows) {
        // Focus calculates and ranks every other scan. Preserve its order;
        // this only limits how many rows we publish.
        return rows.slice(0, limit);
      }

      async function buildPublishedResults(rows) {
        const orderByMarketCap = marketCapOutputOrderScans.includes(scanName);
        // Stream packets do not carry market cap. Enrich the full returned
        // 52-week result set before ordering it, then publish the first N.
        const enriched = await enrichRows(orderByMarketCap ? rows : selectPlatformRows(rows));
        return orderByMarketCap
          ? enriched
            .sort((left, right) => (Number(right.marketCap) || -Infinity) - (Number(left.marketCap) || -Infinity))
            .slice(0, limit)
          : enriched;
      }

      const injector = getInjector();
      if (!injector) throw new Error("Angular injector not found.");

      const mms = injector.get("marketMoversService");
      const scanning = injector.get("scanningService");
      const filters = injector.get("moversFilters");
      const findMover = () => mms.getMoverByName?.(scanName)
        || (mms.getMovers?.() || []).find((item) => clean(item.name).toLowerCase() === clean(scanName).toLowerCase());
      // Focus sends built-in presets before a user's saved/custom movers.
      // Sentiment scans are currently saved movers, so cloud sessions can need
      // a short additional wait after the preset catalogue is usable.
      let mover = findMover();
      const moverDeadline = Date.now() + Math.max(5_000, Number(window.__FOCUS_MOVER_READY_TIMEOUT_MS || 45_000));
      while (!mover && Date.now() < moverDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        mover = findMover();
      }
      if (!mover) {
        const available = (mms.getMovers?.() || []).map((item) => `${item.id}:${item.name}`).join(", ");
        throw new Error(`Scan not found after waiting for saved movers: ${scanName}. Available: ${available}`);
      }

      // Gapped scans use an explicit Top 500-by-market-cap candidate universe.
      // Market-cap sorting of published 52-week results happens after the scan
      // has returned all qualifying contracts.
      let platformLimit = mover.config?.scanTargets?.limit;
      const useMarketCapTop500 = marketCapTop500Scans.includes(scanName);
      if (useMarketCapTop500) {
        if (platformLimit?.property?.key !== "marketCap") {
          throw new Error(`Focus preset ${scanName} has no platform market-cap universe limit.`);
        }
        const scanConfig = window._?.cloneDeep
          ? window._.cloneDeep(mover.config)
          : structuredClone(mover.config);
        platformLimit = scanConfig.scanTargets.limit;
        platformLimit.direction = "Descending";
        platformLimit.number = universeLimit;
        mms.updateConfig(mover.id, scanConfig, true, true);
      }

      const diagnostics = {
        mover: jsonSafe({
          id: mover.id,
          name: mover.name,
          isPreset: mover.isPreset,
          config: mover.config
        }),
        serviceMethods: {
          marketMoversService: Object.keys(mms).filter((key) => typeof mms[key] === "function").sort(),
          scanningService: Object.keys(scanning).filter((key) => typeof scanning[key] === "function").sort(),
          moversFilters: Object.keys(filters).filter((key) => typeof filters[key] === "function").sort()
        }
      };

      const events = [];
      const viaMarketMovers = await new Promise((resolve) => {
        let sub = null;
        let settled = false;
        let quietTimer = null;
        let bestRows = [];
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(quietTimer);
          if (sub?.dispose) sub.dispose();
          if (sub?.unsubscribe) sub.unsubscribe();
          resolve(result);
        };
        const scheduleQuietFinish = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => {
            finish({
              ok: true,
              method: "marketMoversService.subscribe",
              rows: bestRows,
              eventCount: events.length,
              reason: "quiet period after latest scan rows"
            });
          }, 1200);
        };
        const timeout = setTimeout(() => {
          finish(bestRows.length
            ? {
                ok: true,
                method: "marketMoversService.subscribe",
                rows: bestRows,
                eventCount: events.length,
                reason: "timeout with latest scan rows"
              }
            : { ok: false, reason: "timeout", events });
        }, 8000);

        const startSubscription = () => {
          try {
          sub = mms.subscribe(mover.id, scanFetchLimit, `brief-${Date.now()}`).subscribe(
            (packet) => {
              if (settled) return;
              events.push(jsonSafe(packet));
              const rows = parseStreamPacket(packet, scanFetchLimit);
              if (packet?.Errors?.length) {
                finish({ ok: false, method: "marketMoversService.subscribe", reason: "scan errors", events });
                return;
              }
              if (rows.length) {
                bestRows = rows;
                scheduleQuietFinish();
              }
              if (packet?.progress === true || packet?.progress === 100) {
                finish({ ok: true, method: "marketMoversService.subscribe", rows: bestRows, eventCount: events.length });
              }
            },
            (error) => {
              finish({ ok: false, method: "marketMoversService.subscribe", reason: error?.message || String(error), events });
            }
          );
          } catch (error) {
            finish({ ok: false, method: "marketMoversService.subscribe", reason: error?.message || String(error), events });
          }
        };
        startSubscription();
      });

      let directScanJson = null;
      if (!viaMarketMovers.ok && filters?.toScanJson && scanning?.subscribe) {
        try {
          directScanJson = await filters.toScanJson(mover.config, undefined, `brief-direct-${mover.id}`);
        } catch (error) {
          diagnostics.toScanJsonError = error?.message || String(error);
        }
      }

      const finalOutput = {
        ok: viaMarketMovers.ok,
        scan: scanName,
        limit,
        extractedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        source: viaMarketMovers.method || "Focus Angular services",
        sort: marketCapOutputOrderScans.includes(scanName)
          ? { source: "marketCap", direction: "Descending" }
          : { source: "Focus preset order" },
        platformTarget: {
          source: useMarketCapTop500 ? "collector override via Focus Scan Management" : "native Focus Scan Management preset",
          direction: platformLimit?.direction ?? null,
          number: platformLimit?.number ?? null,
          property: platformLimit?.property?.key ?? null
        },
        results: viaMarketMovers.ok ? await buildPublishedResults(viaMarketMovers.rows || []) : []
      };

      if (debugOutput) {
        finalOutput.diagnostics = {
          ...diagnostics,
          directScanJson: jsonSafe(directScanJson),
          subscriptionResult: viaMarketMovers.ok ? {
            eventCount: viaMarketMovers.eventCount
          } : viaMarketMovers
        };
      }

      return finalOutput;
    }, {
      scanName,
      limit: scanLimit,
      scanFetchLimit: Math.max(scanLimit * 6, 30),
      universeLimit: 500,
      marketCapTop500Scans: Array.from(MARKET_CAP_TOP_500_SCANS),
      marketCapOutputOrderScans: Array.from(MARKET_CAP_OUTPUT_ORDER_SCANS),
      debugOutput: DEBUG_OUTPUT,
      sparklineMaxPoints: SPARKLINE_MAX_POINTS
    });

      const outputFile = outputFileFor(scanName);
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");

      summaries.push({
        ok: output.ok,
        scan: output.scan,
        output: path.relative(ROOT, outputFile),
        rows: output.results.length,
        durationMs: output.durationMs,
        first: output.results[0] || null
      });
    }

    const profile = {
      extractedAt: new Date().toISOString(),
      sessionStartupMs: timing.sessionStartupMs || 0,
      homeReadyMs: timing.homeReadyMs || 0,
      scansMs: Date.now() - startedAt,
      totalMs: (timing.sessionStartupMs || 0) + (timing.homeReadyMs || 0) + (Date.now() - startedAt),
      scans: summaries.map(({ scan, rows, durationMs, ok }) => ({ scan, rows, durationMs, ok }))
    };
    fs.writeFileSync(path.join(ROOT, "public", "direct-scan-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    return {
      ok: summaries.every((summary) => summary.ok),
      rows: summaries.reduce((total, summary) => total + summary.rows, 0),
      timings: profile,
      scans: summaries.map(({ ok, scan, output, rows, durationMs }) => ({ ok, scan, output, rows, durationMs }))
    };
}

async function main() {
  const startedAt = Date.now();
  const session = await createFocusBrowserSession();
  const sessionReadyAt = Date.now();
  try {
    await openFocusHome(session.page);
    const result = await collectScansWithPage(session.page, {
      sessionStartupMs: sessionReadyAt - startedAt,
      homeReadyMs: Date.now() - sessionReadyAt,
      limit: LIMIT,
      all: process.argv.includes("--all")
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await logPageSnapshot(session.page, "direct-scan-json-failure").catch(() => {});
    throw error;
  } finally {
    await session.browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { collectScansWithPage };
