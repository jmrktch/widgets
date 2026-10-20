require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createFocusBrowserSession, getFocusBaseUrl, loginFocusPage, logPageSnapshot } = require("../lib/focus-browser-session");
const { collectScansWithPage } = require("./probe-direct-scan-json");

const ROOT = path.join(__dirname, "..");
const DEBUG_OUTPUT = process.argv.includes("--debug");
const HEATMAP_ONLY = process.argv.includes("--heatmap-only");
const INCLUDE_SCANS = process.argv.includes("--include-scans");
const LIMIT = Number((process.argv.find((arg) => arg.startsWith("--limit=")) || "--limit=5").split("=")[1] || 5);
const DIVIDEND_WINDOW_DAYS = Math.max(1, Number((process.argv.find((arg) => arg.startsWith("--dividend-days=")) || "--dividend-days=1").split("=")[1] || 1));

const OUTPUTS = {
  media: path.join(ROOT, "public", "top-media-fast.json"),
  raises: path.join(ROOT, "public", "current-raises-fast.json"),
  heatmap: path.join(ROOT, "public", "heatmap-fast.json"),
  dividends: path.join(ROOT, "public", "upcoming-dividends-fast.json"),
  profile: path.join(ROOT, "public", "fast-brief-profile.json")
};

async function openFocusHome(page) {
  const url = new URL("/#/", `${getFocusBaseUrl()}/`).toString();
  const readyTimeoutMs = Math.max(15_000, Number(process.env.FOCUS_APP_READY_TIMEOUT_MS || 60_000));

  // SignalR can keep the page's network busy indefinitely, particularly on a
  // fresh GitHub runner. Wait for the service we actually need instead.
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

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const startedAt = Date.now();
  const session = await createFocusBrowserSession();
  const sessionReadyAt = Date.now();

  try {
    await openFocusHome(session.page);
    const homeReadyAt = Date.now();

    const output = await session.page.evaluate(async ({ limit, dividendWindowDays, debugOutput, heatmapOnly }) => {
      const startedAt = Date.now();

      function mapMessages(payload) {
        const flatten = (items) => items.flatMap((item) => Array.isArray(item) ? flatten(item) : [item]);
        if (Array.isArray(payload)) return flatten(payload);
        if (Array.isArray(payload?.Messages)) return flatten(payload.Messages);
        if (Array.isArray(payload?.Items)) return flatten(payload.Items);
        if (Array.isArray(payload?.Data)) return flatten(payload.Data);
        if (Array.isArray(payload?.data)) return flatten(payload.data);
        if (Array.isArray(payload?.Results)) return flatten(payload.Results);
        if (Array.isArray(payload?.results)) return flatten(payload.results);
        return [];
      }

      function mapDeltaItems(payload) {
        return mapMessages(payload).map((message) => message?.Item || message).filter(Boolean);
      }

      function clean(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = String(value || "");
        return textarea.value;
      }

      function firstValue(object, keys) {
        for (const key of keys) {
          if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") return object[key];
        }
        return null;
      }

      function dateKey(date, timeZone = "Australia/Sydney") {
        const parts = new Intl.DateTimeFormat("en-AU", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).formatToParts(date).reduce((map, part) => {
          map[part.type] = part.value;
          return map;
        }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
      }

      function addDays(date, days) {
        return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
      }

      function weekdayName(date, timeZone = "Australia/Sydney") {
        return new Intl.DateTimeFormat("en-AU", {
          timeZone,
          weekday: "long"
        }).format(date);
      }

      function dividendTargetOffset(date) {
        const weekday = weekdayName(date);
        if (weekday === "Thursday") return 4;
        if (weekday === "Friday") return 3;
        return 2;
      }

      function numberValue(value) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const parsed = Number(value.replace(/[$,%\s,]+/g, ""));
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      }

      function toContractKey(input) {
        const source = input?.ContractKey || input?.contractKey || input?.Contract || input?.contract || input;
        if (!source) return null;
        const symbol = source.Symbol || source.symbol || input?.Symbol || input?.Code || input?.code;
        if (!symbol) return null;
        return {
          ProviderKey: source.ProviderKey || source.providerKey || "$",
          ProductType: source.ProductType || source.productType || "Stock",
          Exchange: source.Exchange || source.exchange || "XASX",
          Symbol: symbol
        };
      }

      async function postJson(path, body) {
        const response = await fetch(`https://api.marketech.com.au/${path.replace(/^\/+/, "")}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Accept: "application/json, text/plain, */*"
          },
          body: JSON.stringify(body || {})
        });
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = text;
        }
        return { ok: response.ok, status: response.status, payload };
      }

      async function getJson(path) {
        const response = await fetch(`https://api.marketech.com.au/${path.replace(/^\/+/, "")}`, {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*"
          }
        });
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = text;
        }
        return { ok: response.ok, status: response.status, payload };
      }

      async function fetchCandles(contractKey, options = {}) {
        if (!contractKey) return null;
        const end = new Date();
        const lookbackMs = options.lookbackMs || 10 * 60 * 60 * 1000;
        const start = new Date(end.getTime() - lookbackMs);
        const maxPoints = options.maxPoints || 16;
        const interval = options.interval || { Amount: 5, Basis: "Minute" };
        const result = await postJson("candles/get", {
          contractKey,
          interval,
          start: start.toISOString(),
          end: end.toISOString(),
          options: { CompleteOnly: false }
        }).catch((error) => ({ error: error.message || String(error), payload: null }));
        const candles = mapMessages(result.payload).filter((candle) => candle?.TimeStamp && typeof candle.Close === "number");
        const indexes = candles.length <= maxPoints
          ? candles.map((_, index) => index)
          : Array.from(new Set(Array.from({ length: maxPoints }, (_, index) => Math.round((index * (candles.length - 1)) / (maxPoints - 1))))).sort((a, b) => a - b);
        return {
          interval: { amount: interval.Amount, basis: interval.Basis },
          sourcePointCount: candles.length,
          open: typeof candles[0]?.Open === "number" ? candles[0].Open : typeof candles[0]?.Close === "number" ? candles[0].Close : null,
          series: indexes.map((index) => candles[index]?.Close).filter((value) => typeof value === "number")
        };
      }

      async function fetchDividendSparkline(contractKey) {
        return fetchCandles(contractKey, {
          interval: { Amount: 1, Basis: "Week" },
          lookbackMs: 52 * 7 * 24 * 60 * 60 * 1000,
          maxPoints: 26
        });
      }

      async function fetchTotm(contractKey) {
        if (!contractKey) return null;
        const result = await postJson("totm/get", {
          contractKey,
          interval: { Basis: "Day", Amount: 1 },
          version: 2
        }).catch((error) => ({ error: error.message || String(error), payload: null }));
        const totm = mapMessages(result.payload)[0] || {};
        const last = typeof totm.Last === "number" ? totm.Last : null;
        const previousClose = typeof totm.PreviousClose === "number" ? totm.PreviousClose : null;
        const change = typeof last === "number" && typeof previousClose === "number" ? last - previousClose : null;
        return {
          status: result.status || null,
          last,
          previousClose,
          change,
          changePercent: typeof change === "number" && previousClose ? (change / previousClose) * 100 : null,
          sharesOutstanding: typeof totm.SharesOutstanding === "number" ? totm.SharesOutstanding : null,
          marketCap: typeof last === "number" && typeof totm.SharesOutstanding === "number" ? last * totm.SharesOutstanding : null,
          lastTraded: totm.LastTraded || null,
          timestamp: totm.TimeStamp || null
        };
      }

      async function fetchContractDetails(contractKey) {
        if (!contractKey?.Symbol) return null;
        const isMatch = (item) =>
          item?.Symbol === contractKey.Symbol &&
          (!contractKey.ProductType || item?.ProductType === contractKey.ProductType) &&
          (!contractKey.Exchange || item?.Exchange === contractKey.Exchange);
        const bodies = [
          { endpoint: "contracts/get", body: { contractKey } },
          { endpoint: "contracts/get", body: contractKey },
          {
            endpoint: "contracts/search",
            body: {
              searchTerm: {
                Terms: [
                  { Text: contractKey.Symbol, Fields: "Symbol" }
                ]
              }
            }
          }
        ];
        for (const request of bodies) {
          const result = await postJson(request.endpoint, request.body).catch(() => ({ ok: false, payload: null }));
          const matches = mapMessages(result.payload);
          const match = matches.find(isMatch) || matches.find((item) => item?.Symbol === contractKey.Symbol);
          if (match) return match;
        }
        return null;
      }

      async function searchContract(text, fields = "Name") {
        const result = await postJson("contracts/search", {
          searchTerm: {
            Terms: [
              { Text: text, Fields: fields }
            ]
          }
        }).catch(() => ({ ok: false, payload: null }));
        return mapMessages(result.payload);
      }

      async function fetchMarketIndex() {
        const candidates = [
          {
            name: "ASX All Ordinaries Index",
            contractKey: { ProviderKey: "$", ProductType: "Index", Exchange: "XASX", Symbol: "XAO" }
          }
        ];
        const searched = await searchContract("All Ordinaries", "Name");
        for (const contract of searched) {
          if (contract?.Symbol && contract?.ProductType === "Index") {
            candidates.push({
              name: contract.Name || contract.DisplayName || "ASX All Ordinaries Index",
              contractKey: toContractKey(contract)
            });
          }
        }

        const seen = new Set();
        for (const candidate of candidates) {
          const key = JSON.stringify(candidate.contractKey);
          if (!candidate.contractKey || seen.has(key)) continue;
          seen.add(key);
          const quote = await fetchTotm(candidate.contractKey);
          if (typeof quote?.last === "number") {
            return {
              ok: true,
              extractedAt: new Date().toISOString(),
              source: "totm/get",
              name: "ASX All Ordinaries Index",
              resolvedName: candidate.name,
              contractKey: candidate.contractKey,
              last: quote.last,
              change: typeof quote.change === "number" ? Number(quote.change.toFixed(6)) : quote.change,
              changePercent: typeof quote.changePercent === "number" ? Number(quote.changePercent.toFixed(6)) : quote.changePercent,
              quote
            };
          }
        }

        return {
          ok: false,
          extractedAt: new Date().toISOString(),
          source: "totm/get",
          name: "ASX All Ordinaries Index",
          reason: "No All Ordinaries index quote returned",
          candidates: candidates.map((candidate) => candidate.contractKey)
        };
      }

      async function enrichMarketRows(rows, includeSparkline = false) {
        return Promise.all(rows.map(async (row) => {
          const contractKey = row.contractKey || toContractKey(row);
          const [totm, sparkline] = await Promise.all([
            fetchTotm(contractKey),
            includeSparkline ? fetchCandles(contractKey) : Promise.resolve(null)
          ]);
          return {
            ...row,
            contractKey,
            last: row.last ?? totm?.last ?? null,
            change: row.change ?? (typeof totm?.change === "number" ? Number(totm.change.toFixed(6)) : null),
            changePercent: row.changePercent ?? (typeof totm?.changePercent === "number" ? Number(totm.changePercent.toFixed(6)) : null),
            marketCap: row.marketCap ?? totm?.marketCap ?? null,
            dailySparkline: includeSparkline ? sparkline : row.dailySparkline,
            quote: totm
          };
        }));
      }

      async function fetchMedia() {
        const mediaLimit = 3;
        const mediaCount = Math.max(80, limit * 20);
        const todayKey = dateKey(new Date());
        const providerPriority = [
          ["Money of Mine", ["moneyofmine", "money of mine", "mom"]],
          ["ausbiz", ["ausbiz"]],
          ["Marcus Today", ["marcustoday", "marcus today"]],
          ["Pitt Street", ["pittstreet", "pitt street", "pittstreetresearch", "pitt street research"]],
          ["Share Cafe", ["sharecafe", "share cafe"]],
          ["Small Caps", ["smallcaps", "small caps"]],
          ["Stocks Down Under", ["stocksdownunder", "stocks down under"]],
          ["Market Open", ["marketopen", "market open"]],
          ["Equities Club", ["equitiesclub", "equities club"]],
          ["The Stock Network", ["thestocknetwork", "stocknetwork", "the stock network"]],
          ["Resource Rising Stars", ["resourcerisingstars", "resource rising stars"]],
          ["Fear and Greed", ["fearandgreed", "fear and greed"]],
          ["ASX Briefs", ["asxbriefs", "asx briefs"]],
          ["Sub11", ["sub11"]],
          ["Ticker Talk", ["tickertalk", "ticker talk"]],
          ["Vertical Events", ["verticalevents", "vertical events"]],
          ["RIU", ["riu"]]
        ];
        const commentaryTerms = [
          { source: "MoneyOfMine", type: "Article", article: "DirectorsSpecial" },
          { source: "MoneyOfMine", type: "Podcast", podcast: "MoneyOfMine" },
          { source: "MoneyOfMine", type: "Video", video: "MoneyOfMine" },
          { source: "MarcusToday", type: "Article", article: "MarcusTodayDailyReport" },
          { source: "MarcusToday", type: "Podcast", podcast: "MarcusTodayReport" },
          { source: "MarcusToday", type: "Podcast", podcast: "OnTheCouch" },
          { source: "ShareCafe", type: "Article", article: "StockWatch" },
          { source: "ShareCafe", type: "Article", article: "CompanyNews" },
          { source: "ShareCafe", type: "Article", article: "MarketReports" },
          { source: "ShareCafe", type: "Article", article: "FundsManagement" },
          { source: "SmallCaps", type: "Article", article: "SmallCaps" },
          { source: "StocksDownUnder", type: "Article", article: "Article" },
          { source: "StocksDownUnder", type: "Article", article: "News" },
          { source: "StocksDownUnder", type: "Research", research: "PittStreetResearch" },
          { source: "MarketOpen", type: "Article", article: "ASXNews" },
          { source: "MarketOpen", type: "Podcast", podcast: "MarketOpen" },
          { source: "EquitiesClub", type: "Article", article: "ASXInsights" },
          { source: "EquitiesClub", type: "Article", article: "WeeklyWrap" },
          { source: "TheStockNetwork", type: "Article", article: "WhatsHot" },
          { source: "TheStockNetwork", type: "Article", article: "CompanyNews" }
        ];
        const newsFilter = { Types: ["Podcast", "Video", "Article", "Research", "Sentiment"] };
        const bodies = [
          { endpoint: "commentary/get", body: { count: mediaCount, startDate: todayKey, endDate: todayKey, filter: { Terms: commentaryTerms } } },
          { endpoint: "commentary/get", body: { count: mediaCount, filter: { Terms: commentaryTerms } } },
          { endpoint: "news/get", body: { count: mediaCount, startDate: todayKey, endDate: todayKey, filter: newsFilter } },
          { endpoint: "news/get", body: { count: mediaCount, filter: newsFilter } }
        ];
        const attempts = [];
        const payloadSources = [];
        for (const request of bodies) {
          const attempt = await postJson(request.endpoint, request.body).catch((error) => ({ ok: false, status: null, error: error.message || String(error), payload: null }));
          const count = mapMessages(attempt.payload).length;
          attempts.push({ endpoint: request.endpoint, body: request.body, ok: attempt.ok, status: attempt.status, count });
          if (attempt.ok && count) payloadSources.push({ endpoint: request.endpoint, body: request.body, payload: attempt.payload });
        }
        const providerLogos = {
          "Money of Mine": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/Money_Of_Mine_Logo_JPG_1400.png",
          ausbiz: "https://fastiqaueastcommentary.blob.core.windows.net/gfx/ausbizlogoRaw.png",
          "Marcus Today": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/b49cbe86cb411762753e730c58953bb88ad958a9d657212c074729b6f04e5463.jpg",
          "Pitt Street": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/PittStreet-removebg-preview.png",
          "Share Cafe": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/NyrZo_z__400x400-removebg-preview.png",
          "Small Caps": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/small_caps_logo.jfif",
          "Stocks Down Under": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/stocks_down_under_logo-removebg-preview.png",
          "Market Open": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/Market_Open_alt.png",
          "Equities Club": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/EM_NoBackground.png",
          "The Stock Network": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/TheStockNetwork.PNG",
          "Resource Rising Stars": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/RRS_NoBackground.PNG",
          "Fear and Greed": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/fear-and-greed.jpg",
          "ASX Briefs": "https://storage.buzzsprout.com/z812v42r7rkjodg53kubln9pobrp",
          Sub11: "https://fastiqaueastcommentary.blob.core.windows.net/gfx/sub11podcast_v2-removebg-preview.png",
          "Ticker Talk": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/Market_Open_alt.png",
          "Vertical Events": "https://fastiqaueastcommentary.blob.core.windows.net/gfx/ruiexplorersconference-removebg-preview.png",
          RIU: "https://fastiqaueastcommentary.blob.core.windows.net/gfx/ruiexplorersconference-removebg-preview.png"
        };
        const typeIcons = {
          Video: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232f75b5'%3E%3Cpath d='M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 9.5-5 3v-7l5 4z'/%3E%3C/svg%3E",
          Podcast: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232f75b5'%3E%3Cpath d='M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.4 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.32 6-6.72h-1.7z'/%3E%3C/svg%3E",
          Article: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232f75b5'%3E%3Cpath d='M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM8 13h8v2H8v-2zm0 4h8v2H8v-2zm5-8V3.5L18.5 9H13z'/%3E%3C/svg%3E",
          Research: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232f75b5'%3E%3Cpath d='M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l5.41 5.42-1.41 1.41-5.42-5.41A6.47 6.47 0 0 1 9.5 16 6.5 6.5 0 1 1 9.5 3zm0 2A4.5 4.5 0 1 0 9.5 14 4.5 4.5 0 0 0 9.5 5z'/%3E%3C/svg%3E",
          Sentiment: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232f75b5'%3E%3Cpath d='M3 17.25V21h3.75L17.8 9.95l-3.75-3.75L3 17.25zm17.7-10.2c.4-.4.4-1 0-1.4l-2.35-2.35a.99.99 0 0 0-1.4 0l-1.85 1.85 3.75 3.75 1.85-1.85z'/%3E%3C/svg%3E"
        };
        const normalizeKey = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
        const providerFrom = (value) => {
          const key = normalizeKey(value);
          const match = providerPriority.find(([, aliases]) => aliases.some((alias) => key.includes(normalizeKey(alias))));
          return match ? match[0] : clean(value) || null;
        };
        const providerRank = (provider) => {
          const key = normalizeKey(provider);
          const index = providerPriority.findIndex(([name]) => normalizeKey(name) === key);
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        const contentTypeFrom = (value) => {
          const type = clean(value);
          if (/podcast|audio/i.test(type)) return "Podcast";
          if (/video/i.test(type)) return "Video";
          if (/research/i.test(type)) return "Research";
          if (/sentiment/i.test(type)) return "Sentiment";
          return type || "Article";
        };
        const titleFromContent = (item) => {
          const content = firstValue(item, ["Summary", "summary", "Content", "content"]);
          if (!content) return null;
          const element = document.createElement("div");
          element.innerHTML = String(content);
          return clean(element.querySelector("h1,h2,h3,.title")?.textContent || "");
        };
        const oldestFirst = (a, b) => (new Date(a.dateTime).getTime() || 0) - (new Date(b.dateTime).getTime() || 0);
        const rawWithSource = payloadSources.flatMap((source) =>
          mapMessages(source.payload).map((item) => ({ item, endpoint: source.endpoint }))
        );
        const mapped = rawWithSource.map(({ item, endpoint }, index) => {
          const providerRaw = firstValue(item, ["CommentarySource", "commentarySource", "Source", "source", "Provider", "ProviderName", "Author", "Publisher"]);
          const provider = providerFrom(providerRaw);
          const contentType = contentTypeFrom(firstValue(item, ["Type", "type", "ContentType", "NewsType"]));
          const rawHeadline = clean(decodeHtml(firstValue(item, ["Title", "title", "Headline", "headline", "Name", "name"])));
          const contentTitle = titleFromContent(item);
          const headline = contentTitle && (!rawHeadline || normalizeKey(rawHeadline) === normalizeKey(provider))
            ? `${provider} - ${contentTitle}`
            : rawHeadline;
          const providerLogo = providerLogos[provider] || null;
          const payloadLogo = firstValue(item, ["LogoUrl", "ProviderLogoUrl", "ImageUrl", "ThumbnailUrl"]);
          return {
            dateTime: firstValue(item, ["Timestamp", "timestamp", "DateTime", "dateTime", "Published", "PublishedUtc", "PublishedDate", "Created", "Date", "TimeStamp"]),
            provider,
            providerRaw,
            providerRank: providerRank(provider),
            contentType,
            headline,
            id: firstValue(item, ["CommentaryId", "Id", "ID", "NewsId"]) || `media-${index}`,
            newsId: firstValue(item, ["Id", "ID", "NewsId"]),
            commentaryId: firstValue(item, ["CommentaryId"]),
            sourceEndpoint: endpoint,
            logoUrl: providerLogo || payloadLogo || null,
            providerIconUrl: providerLogo || payloadLogo || null,
            typeIconUrl: typeIcons[contentType] || typeIcons.Article
          };
        }).filter((item) => item.headline && item.provider).sort(oldestFirst);

        const todaysMapped = mapped.filter((item) => {
          const date = new Date(item.dateTime);
          return !Number.isNaN(date.getTime()) && dateKey(date) === todayKey;
        });
        const uniqueByArticle = [];
        const seenArticles = new Set();
        for (const item of todaysMapped) {
          const articleKey = item.commentaryId || item.id || item.newsId || `${item.provider}:${item.headline}`;
          if (seenArticles.has(articleKey)) continue;
          seenArticles.add(articleKey);
          uniqueByArticle.push(item);
        }

        const items = [];
        const seenProviders = new Set();
        for (const [provider] of providerPriority) {
          if (items.length >= mediaLimit) break;
          const key = normalizeKey(provider);
          const item = uniqueByArticle.find((candidate) => normalizeKey(candidate.provider) === key && !seenProviders.has(key));
          if (!item) continue;
          seenProviders.add(key);
          items.push(item);
        }
        for (const item of uniqueByArticle) {
          if (items.length >= mediaLimit) break;
          const key = normalizeKey(item.provider);
          if (seenProviders.has(key)) continue;
          seenProviders.add(key);
          items.push(item);
        }
        return {
          ok: payloadSources.length > 0 || attempts.some((attempt) => attempt.ok),
          status: attempts.find((attempt) => attempt.ok)?.status || null,
          extractedAt: new Date().toISOString(),
          source: payloadSources.some((source) => source.endpoint === "commentary/get") ? "commentary/get+news/get" : "news/get",
          selection: {
            limit: mediaLimit,
            date: todayKey,
            rule: "Today from midnight forward; one per provider; provider priority order first",
            providerPriority: providerPriority.map(([provider]) => provider)
          },
          items,
          ...(debugOutput ? { debug: { attempts, rawCount: mapped.length, todaysRawCount: todaysMapped.length, firstRaw: rawWithSource[0]?.item || null } } : {})
        };
      }

      async function fetchRaises() {
        const bodies = [
          { count: 50 },
          { count: 50, filter: { Current: true } },
          { page: 0, count: 50 },
          {}
        ];
        const endpoints = ["ecm/raises", "ecm/raises/get", "ecm/getRaises", "ecm/raise/get", "ecm/bids", "ecm/bids/get"];
        const attempts = endpoints.flatMap((endpoint) => [
          { method: "GET", endpoint },
          ...bodies.map((body) => ({ method: "POST", endpoint, body }))
        ]);
        const responses = [];
        let picked = null;
        for (const attempt of attempts) {
          const result = await (attempt.method === "GET" ? getJson(attempt.endpoint) : postJson(attempt.endpoint, attempt.body))
            .catch((error) => ({ ok: false, status: null, error: error.message || String(error), payload: null }));
          responses.push({ ...attempt, ok: result.ok, status: result.status, count: mapMessages(result.payload).length, payload: debugOutput ? result.payload : undefined });
          if (result.ok && mapMessages(result.payload).length && !picked) picked = result;
        }
        picked = picked || responses.find((item) => item.ok) || null;
        const rawItems = picked?.payload ? mapDeltaItems(picked.payload) : [];
        const mappedRaises = rawItems.filter((item) => {
          const status = clean(firstValue(item, ["Status", "OfferStatus", "RaiseStatus"])).toLowerCase();
          const state = clean(firstValue(item, ["State"])).toLowerCase();
          const closeDate = firstValue(item, ["CloseDate", "ClosingDate", "EndDate"]);
          return /pending|open|active|live|current/.test(`${status} ${state}`) || (closeDate && new Date(closeDate) >= new Date());
        }).slice(0, limit).map((item) => {
          const offerPrice = firstValue(item, ["OfferPrice", "IssuePrice", "Price", "BidPrice"]);
          const offeredUnits = firstValue(item, ["OfferedUnits", "UnitsOffered", "OfferUnits", "SharesOffered"]);
          const rawRaiseAmount = firstValue(item, ["RaiseAmount", "Amount", "TotalRaise", "TargetRaise", "MaximumRaise", "OfferSize"]);
          const computedRaiseAmount = numberValue(rawRaiseAmount) ?? (
            numberValue(offerPrice) !== null && numberValue(offeredUnits) !== null
              ? numberValue(offerPrice) * numberValue(offeredUnits)
              : null
          );
          return {
            code: firstValue(item, ["Code", "Symbol", "Ticker"]) || toContractKey(item)?.Symbol || null,
            name: clean(firstValue(item, ["Name", "CompanyName", "ContractName"])),
            ask: clean(firstValue(item, ["Ask", "Offer", "OfferSummary", "RaiseSummary", "BidDescription"])),
            stage: firstValue(item, ["Stage", "Status", "OfferStatus", "RaiseStatus", "State"]),
            raiseAmount: computedRaiseAmount,
            offerPrice,
            offeredUnits,
            description: clean(firstValue(item, ["Description", "Title", "OfferName", "Summary"])) || [
              firstValue(item, ["Type"]),
              firstValue(item, ["Class"]),
              numberValue(offerPrice) !== null ? `offer price ${offerPrice}` : null,
              item.OffersClose ? `closes ${item.OffersClose}` : null
            ].filter(Boolean).join(" - "),
            id: firstValue(item, ["Id", "ID", "RaiseId"]),
            rawStatus: firstValue(item, ["Status", "OfferStatus", "RaiseStatus", "State"]),
            contractKey: toContractKey(item)
          };
        });
        const items = await enrichMarketRows(mappedRaises, false);
        return {
          ok: Boolean(picked?.ok),
          extractedAt: new Date().toISOString(),
          source: "ecm/raises",
          items,
          ...(debugOutput ? { debug: { attempts: responses } } : {})
        };
      }

      async function fetchDividends() {
        const now = new Date();
        const todayKey = dateKey(now);
        const targetOffsetDays = dividendTargetOffset(now);
        const targetKey = dateKey(addDays(now, targetOffsetDays));
        const windowEndKey = dateKey(addDays(now, dividendWindowDays - 1));
        const backfillEndKey = dateKey(addDays(now, 45));
        const bodies = [
          {
            contractKey: null,
            count: 500,
            startDate: todayKey,
            endDate: backfillEndKey,
            filter: { OrderDir: "asc", OrderBy: "exDate" }
          },
          {
            contractKey: null,
            count: 500,
            startDate: todayKey,
            filter: { OrderDir: "asc", OrderBy: "exDate" }
          },
          {
            contractKey: null,
            count: 500,
            startDate: targetKey,
            endDate: targetKey,
            filter: { OrderDir: "asc", OrderBy: "exDate" }
          },
          {
            contractKey: null,
            count: 500,
            startDate: `${todayKey}T00:00:00`,
            endDate: `${backfillEndKey}T23:59:59`,
            filter: { OrderDir: "asc", OrderBy: "exDate" }
          },
          {
            contractKey: null,
            count: 500,
            filter: { OrderDir: "asc", OrderBy: "exDate" }
          },
          {
            contractKey: null,
            count: 500,
            filter: { OrderDir: "desc", OrderBy: "exDate" }
          },
          { count: 500 },
          {}
        ];
        const attempts = [];
        const rawById = new Map();
        let ok = false;
        for (const body of bodies) {
          const result = await postJson("dividends/get", body).catch((error) => ({ ok: false, status: null, error: error.message || String(error), payload: null }));
          const raw = mapDeltaItems(result.payload);
          attempts.push({ body, ok: result.ok, status: result.status, count: raw.length, payload: debugOutput ? result.payload : undefined });
          if (result.ok) ok = true;
          for (const item of raw) {
            const id = firstValue(item, ["Id", "ID", "DividendId"]) || JSON.stringify([toContractKey(item), firstValue(item, ["ExDate", "exDate", "ExDividendDate"]), firstValue(item, ["Amount", "DividendAmount", "DistributionAmount"])]);
            if (!rawById.has(id)) rawById.set(id, item);
          }
        }
        const allItems = Array.from(rawById.values());
        const rawItems = allItems.filter((item) => {
          const exDate = firstValue(item, ["ExDate", "exDate", "ExDividendDate"]);
          if (!exDate) return false;
          const exDateKey = dateKey(new Date(exDate));
          return dividendWindowDays > 1
            ? exDateKey >= todayKey && exDateKey <= windowEndKey
            : exDateKey === targetKey;
        });
        const enrichedItems = await enrichMarketRows(rawItems.map((item) => ({
          code: firstValue(item, ["Code", "Symbol", "Ticker"]) || toContractKey(item)?.Symbol || null,
          name: clean(firstValue(item, ["Name", "CompanyName", "ContractName"])),
          exDate: firstValue(item, ["ExDate", "exDate", "ExDividendDate"]),
          paymentDate: firstValue(item, ["PaymentDate", "PayDate", "PayableDate"]),
          amount: firstValue(item, ["Amount", "DividendAmount", "DistributionAmount"]),
          rate: firstValue(item, ["Rate", "DividendRate"]),
          franking: firstValue(item, ["FrankedPercent", "Franking", "FrankingPercent", "FrankingPercentage", "FrankedPercentage", "PercentFranked", "FrankingRate"]),
          type: firstValue(item, ["Type", "DividendType", "DistributionType"]),
          id: firstValue(item, ["Id", "ID", "DividendId"]),
          contractKey: toContractKey(item)
        })), false);
        const itemsWithDetails = await Promise.all(enrichedItems.map(async (item) => {
          const [details, dividendSparkline] = await Promise.all([
            item.name ? Promise.resolve(null) : fetchContractDetails(item.contractKey),
            fetchDividendSparkline(item.contractKey)
          ]);
          return {
            ...item,
            name: item.name || details?.Name || "",
            dailySparkline: dividendSparkline || item.dailySparkline
          };
        }));
        const items = itemsWithDetails
          .sort((a, b) => (numberValue(b.marketCap) || 0) - (numberValue(a.marketCap) || 0));
        return {
          ok,
          extractedAt: new Date().toISOString(),
          source: "dividends/get",
          targetExDate: targetKey,
          targetOffsetDays,
          window: {
            startDate: dividendWindowDays > 1 ? todayKey : targetKey,
            endDate: dividendWindowDays > 1 ? windowEndKey : targetKey,
            days: dividendWindowDays
          },
          selection: {
            rule: dividendWindowDays > 1
              ? "All dividends in the requested ex-date window, sorted by market cap descending"
              : "All dividends with target ex-date, sorted by market cap descending, capped at limit",
            limit: dividendWindowDays > 1 ? null : limit
          },
          backfillRange: { startDate: todayKey, endDate: backfillEndKey },
          items,
          ...(debugOutput ? { debug: { attempts, rawCount: allItems.length, targetRawCount: rawItems.length, firstRaw: rawItems[0] || allItems[0] || null } } : {})
        };
      }

      function parseScanRows(packet, fallbackLimit) {
        const list = Array.isArray(packet?.list) ? packet.list : [];
        return list
          .filter((item) => item?.type !== "Delete" && item?.contract)
          .map((item, index) => {
            const metadata = item.metadata || [];
            const value = (key) => metadata.find((entry) => entry?.Key === key)?.Value ?? null;
            const contract = item.contract;
            return {
              position: index,
              code: contract.Symbol || null,
              name: contract.Name || contract.DisplayName || null,
              sector: contract.Sector || value("sector") || value("slot2_stringValue") || null,
              industry: contract.Industry || null,
              subIndustry: contract.SubIndustry || null,
              marketCap: value("slot0_bigDollarValue") ?? value("slot3_bigDollarValue") ?? null,
              changePercent: value("slot1_percValue") ?? value("slot0_percValue") ?? null,
              contractKey: toContractKey(contract),
              metadata: metadata.map((entry) => ({ key: entry.Key, value: entry.Value }))
            };
          })
          .slice(0, fallbackLimit);
      }

      async function fetchHeatmap() {
        const injector = window.angular?.element?.(document.querySelector("[ng-app]") || document.body)?.injector?.();
        const mms = injector?.get?.("marketMoversService");
        const mover = mms?.getMoverByName?.("Heatmap") || mms?.getMover?.("Heatmap") || mms?.getMovers?.()?.find((item) => clean(item.name).toLowerCase() === "heatmap");

        if (!mms?.subscribe || !mover) {
          return {
            ok: false,
            extractedAt: new Date().toISOString(),
            source: "marketMoversService.subscribe:Heatmap",
            stocks: [],
            sectors: [],
            reason: "Custom Heatmap scan not found",
            ...(debugOutput ? { debug: { movers: (mms?.getMovers?.() || []).map((item) => ({ id: item.id, name: item.name })).slice(0, 80) } } : {})
          };
        }

        const rows = await new Promise((resolve) => {
          let sub = null;
          const packets = [];
          const timeout = setTimeout(() => {
            if (sub?.dispose) sub.dispose();
            if (sub?.unsubscribe) sub.unsubscribe();
            resolve({ rows: [], packets });
          }, 8000);

          try {
            sub = mms.subscribe(mover.id, 200, `brief-heatmap-${Date.now()}`).subscribe((packet) => {
              packets.push({
                listCount: packet?.list?.length || 0,
                progress: packet?.progress,
                matches: packet?.matches,
                errors: packet?.Errors || null
              });
              const parsed = parseScanRows(packet, 200);
              if (parsed.length) {
                clearTimeout(timeout);
                if (sub?.dispose) sub.dispose();
                if (sub?.unsubscribe) sub.unsubscribe();
                resolve({ rows: parsed, packets });
              }
            }, () => {
              clearTimeout(timeout);
              resolve({ rows: [], packets });
            });
          } catch {
            clearTimeout(timeout);
            resolve({ rows: [], packets });
          }
        });

        const enriched = await enrichMarketRows(rows.rows || [], false);
        const detailsBySymbol = new Map(await Promise.all(enriched.map(async (row) => [row.code, await fetchContractDetails(row.contractKey)])));
        const stocks = enriched.map((row) => {
          const details = detailsBySymbol.get(row.code);
          return {
            code: row.code,
            name: row.name || details?.Name || null,
            sector: row.sector || details?.Sector || "Unknown",
            industry: row.industry || details?.Industry || null,
            subIndustry: row.subIndustry || details?.SubIndustry || null,
            weight: row.marketCap,
            marketCap: row.marketCap,
            changePercent: row.changePercent,
            contractKey: row.contractKey
          };
        }).filter((stock) => stock.code && typeof stock.weight === "number");
        const totalWeight = stocks.reduce((total, stock) => total + stock.weight, 0);
        const sectors = Array.from(stocks.reduce((map, stock) => {
          const key = stock.sector || "Unknown";
          const current = map.get(key) || { name: key, weight: 0, count: 0, stocks: [] };
          current.weight += typeof stock.weight === "number" ? stock.weight : 0;
          current.count += 1;
          current.stocks.push(stock);
          map.set(key, current);
          return map;
        }, new Map()).values()).sort((a, b) => b.weight - a.weight).map((sector, index) => ({
          ...sector,
          order: index,
          shareOfTotal: totalWeight ? sector.weight / totalWeight : null,
          stocks: sector.stocks
            .sort((a, b) => b.weight - a.weight)
            .map((stock, stockIndex) => ({
              ...stock,
              order: stockIndex,
              shareOfTotal: totalWeight ? stock.weight / totalWeight : null,
              shareOfSector: sector.weight ? stock.weight / sector.weight : null
            }))
        }));
        return {
          ok: stocks.length > 0,
          extractedAt: new Date().toISOString(),
          source: `marketMoversService.subscribe:${mover.name}`,
          layoutBasis: {
            weight: "marketCap",
            color: "changePercent",
            sectorShare: "sector.weight / totalWeight",
            stockShare: "stock.weight / sector.weight"
          },
          totalWeight,
          stocks: sectors.flatMap((sector) => sector.stocks),
          sectors,
          ...(debugOutput ? { debug: { mover: { id: mover.id, name: mover.name }, packets: rows.packets || [], firstDetail: detailsBySymbol.values().next().value || null } } : {})
        };
      }

      async function timed(task) {
        const started = Date.now();
        const value = await task();
        return { value, durationMs: Date.now() - started };
      }
      const skipped = { value: null, durationMs: 0 };
      const [mediaResult, raisesResult, dividendsResult, heatmapResult] = heatmapOnly
        ? [skipped, skipped, skipped, await timed(fetchHeatmap)]
        : await Promise.all([
          timed(fetchMedia), timed(fetchRaises), timed(fetchDividends), timed(fetchHeatmap)
        ]);

      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        media: mediaResult.value,
        raises: raisesResult.value,
        dividends: dividendsResult.value,
        heatmap: heatmapResult.value,
        sectionTimings: {
          mediaMs: mediaResult.durationMs,
          raisesMs: raisesResult.durationMs,
          dividendsMs: dividendsResult.durationMs,
          heatmapMs: heatmapResult.durationMs
        }
      };
    }, {
      limit: LIMIT,
      dividendWindowDays: DIVIDEND_WINDOW_DAYS,
      debugOutput: DEBUG_OUTPUT,
      heatmapOnly: HEATMAP_ONLY
    });

    if (!HEATMAP_ONLY) {
      writeJson(OUTPUTS.media, output.media);
      writeJson(OUTPUTS.raises, output.raises);
      writeJson(OUTPUTS.dividends, output.dividends);
    }
    writeJson(OUTPUTS.heatmap, output.heatmap);
    writeJson(OUTPUTS.profile, {
      extractedAt: new Date().toISOString(),
      sessionStartupMs: sessionReadyAt - startedAt,
      homeReadyMs: homeReadyAt - sessionReadyAt,
      pageEvaluationMs: output.durationMs,
      totalMs: Date.now() - startedAt,
      sections: output.sectionTimings
    });
    const scanResult = INCLUDE_SCANS
      ? await collectScansWithPage(session.page, {
        sessionStartupMs: sessionReadyAt - startedAt,
        homeReadyMs: homeReadyAt - sessionReadyAt,
        limit: Math.max(1, Number(process.env.MARKET_SNAPSHOT_SCAN_LIMIT || 10)),
        all: true
      })
      : null;

    console.log(JSON.stringify({
      ok: output.ok,
      durationMs: output.durationMs,
      outputs: Object.fromEntries(Object.entries(OUTPUTS).map(([key, file]) => [key, path.relative(ROOT, file)])),
      timings: output.sectionTimings,
      scans: scanResult ? { rows: scanResult.rows, durationMs: scanResult.timings.scansMs } : null,
      counts: {
        media: output.media.items?.length || 0,
        raises: output.raises.items?.length || 0,
        dividends: output.dividends.items?.length || 0,
        heatmapStocks: output.heatmap.stocks?.length || 0,
        heatmapSectors: output.heatmap.sectors?.length || 0
      },
      status: {
        media: output.media?.ok ?? null,
        raises: output.raises?.ok ?? null,
        dividends: output.dividends?.ok ?? null,
        heatmap: output.heatmap.ok
      }
    }, null, 2));
  } catch (error) {
    await logPageSnapshot(session.page, "fast-brief-sections-failure").catch(() => {});
    throw error;
  } finally {
    await session.browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
