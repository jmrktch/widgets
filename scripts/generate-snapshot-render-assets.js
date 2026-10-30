/*
 * Local, presentation-only snapshot renderer.
 * Reads public/snapshot/latest and writes standalone, email-safe HTML panels
 * to public/snapshot-renders/latest. It does not collect data or upload assets.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// Local previews read/write under public. The GitHub Pages workflow supplies
// its staging paths so the same renderer publishes beside the snapshot JSON.
const SOURCE = path.resolve(ROOT, process.env.SNAPSHOT_RENDER_SOURCE_DIR || "public/snapshot/latest");
const OUTPUT = path.resolve(ROOT, process.env.SNAPSHOT_RENDER_OUTPUT_DIR || "public/snapshot-renders/latest");
const LOGO_DATA_URL = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, "public", "marketech_focus_logo.png")).toString("base64")}`;
const SCANS = ["top-gainers", "top-losers", "gapped-up", "gapped-down", "trading-halt", "52-week-high", "52-week-low", "rsi-oversold", "rsi-overbought"];
const BENCHMARKS = ["GOLD", "AU1YY", "US1YY", "OOO", "A200"];
const SCAN_TITLES = { "top-gainers": "Top Gainers", "top-losers": "Top Losers", "gapped-up": "Gapped Up", "gapped-down": "Gapped Down", "trading-halt": "Trading Halts", "52-week-high": "52-Week Highs", "52-week-low": "52-Week Lows", "rsi-oversold": "RSI Oversold", "rsi-overbought": "RSI Overbought" };
const SCAN_SUBTITLES = {
  "top-gainers": "Top gainers among the AU 500.",
  "top-losers": "Top losers among the AU 500.",
  "gapped-up": "Today's open is greater than yesterday's high; of the top AU 500.",
  "gapped-down": "Today's open is below yesterday's low; of the top AU 500.",
  "trading-halt": "Stocks that are currently in a Trading Halt.",
  "52-week-high": "Has traded at its 52-week high today; sorted by market cap.",
  "52-week-low": "Has traded at its 52-week low today; sorted by market cap.",
  "rsi-oversold": "RSI(14) is below 30.",
  "rsi-overbought": "RSI(14) is above 70."
};
const MISSING = "—";

function read(relative) { return JSON.parse(fs.readFileSync(path.join(SOURCE, relative), "utf8")); }
function write(relative, content) { const target = path.join(OUTPUT, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, "utf8"); }
function esc(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function price(value) { const n = num(value); return n === null ? MISSING : (n >= 10 ? n.toFixed(2) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")); }
function pct(value) { const n = num(value); return n === null ? MISSING : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`; }
function signed(value) { const n = num(value); return n === null ? MISSING : `${n > 0 ? "+" : ""}${n.toFixed(3)}`; }
function money(value) { const n = num(value); if (n === null) return MISSING; if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}b`; if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}m`; return `$${n.toLocaleString("en-AU")}`; }
function movement(value) { const n = num(value) || 0; return n > 0 ? "up" : n < 0 ? "down" : "flat"; }
function date(value) { const d = new Date(value); return Number.isNaN(d) ? MISSING : new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "short", year: "numeric" }).format(d); }
function mediaDate(value) { const d = new Date(value); return Number.isNaN(d) ? MISSING : new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(d).replace(",", ""); }
function dividendAmount(value) { const n = num(value); return n === null ? MISSING : `$${price(n)}`; }
function franking(value) { const n = num(value); return n === null ? MISSING : `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(0)}%`; }
function items(section) { return Array.isArray(section?.results) ? section.results : Array.isArray(section?.items) ? section.items : []; }

function sparkline(data) {
  const values = [data?.open, ...(Array.isArray(data?.series) ? data.series : [])].map(num).filter((n) => n !== null);
  if (values.length < 2) return `<span style="color:#8895a3">${MISSING}</span>`;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1, w = 92, h = 30, p = 2;
  const open = num(data?.open) ?? values[0];
  const point = (v, i) => ({ x: p + (i / (values.length - 1)) * (w - p * 2), y: p + (h - p * 2) - ((v - min) / range) * (h - p * 2), v });
  const points = values.map(point); const openY = point(open, 0).y;
  let paths = "";
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]; const color = b.v >= open ? "#138756" : "#c8463a";
    paths += `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price sparkline" style="display:block"><line x1="${p}" y1="${openY.toFixed(1)}" x2="${w-p}" y2="${openY.toFixed(1)}" stroke="#aab5bf" stroke-width="1" stroke-dasharray="3 3"/>${paths}</svg>`;
}

function darkModeAssets() {
  return `<style>
html.dark,html.dark body{background:#19181d!important;color:#f5f6f7!important}
html.dark [bgcolor="#ffffff"],html.dark [style*="background:#ffffff"],html.dark [style*="background:#fff"]{background:#19181d!important}
html.dark [bgcolor="#f1f5f8"],html.dark [style*="background:#f1f5f8"]{background:#000!important}
html.dark [bgcolor="#e7e9ec"],html.dark [style*="background:#e7e9ec"]{background:#28272d!important}
html.dark [style*="background:rgba(255,255,255,.64)"]{background:rgba(25,24,29,.78)!important}
html.dark [style*="border-bottom:1px solid #edf1f5"]{border-bottom-color:#3c3b42!important}
html.dark [style*="border:1px solid #fff"],html.dark [style*="border:1px solid rgba(255,255,255,.72)"]{border-color:#000!important}
html.dark [style*="border:1px solid #111111"]{border-color:#f5f6f7!important}
html.dark [style*="color:#17212b"],html.dark [style*="color:#111b24"],html.dark [style*="color:#263442"],html.dark [style*="color:#1e2a36"]{color:#f5f6f7!important}
html.dark [style*="color:#5d6b78"],html.dark [style*="color:#667481"],html.dark [style*="color:#697784"],html.dark [style*="color:#52616e"],html.dark [style*="color:#7d8893"],html.dark [style*="color:#5f6f82"]{color:#c2c7cd!important}
html.dark [style*="color:#174889"]{color:#8ec2ff!important}
html.dark [style*="color:#137a4b"],html.dark [style*="color:#138756"],html.dark [style*="color:#158b5b"]{color:#47bd86!important}
html.dark [style*="color:#c23a31"],html.dark [style*="color:#c8463a"],html.dark [style*="color:#d34e41"]{color:#ff745f!important}
html.dark [style*="background:#3EAA77"],html.dark [style*="background:#7FC0A1"],html.dark [style*="background:#BDDACB"],html.dark [style*="background:#C8DDD2"],html.dark [style*="background:#D2DDD7"]{background:#47bd86!important}
html.dark [style*="background:#FF745F"],html.dark [style*="background:#F3A093"],html.dark [style*="background:#F7B3A8"],html.dark [style*="background:#F3BCB3"],html.dark [style*="background:#E9CEC9"]{background:#ff745f!important}
html.dark [style*="background:#E0E0E0"]{background:#3c3b42!important}
html.dark [style*="stroke:#aab5bf"]{stroke:#777d86!important}
html.dark [stroke="#138756"]{stroke:#47bd86!important}
html.dark [stroke="#c8463a"]{stroke:#ff745f!important}
html.dark [stroke="#e3ebf5"]{stroke:#3c3b42!important}
</style><script>(function(){var q=window.location.search.toLowerCase(),h=window.location.hash.toLowerCase();if(/(^|[?&])(dark|theme=dark)(?:[=&]|$)/.test(q)||h==='#dark'){document.documentElement.className+=' dark';}}());</script>`;
}

function shell(title, body, aspect) {
  const height = aspect === "1:1" ? 1200 : 675;
  const footer = scanFooter(read("manifest.json").generatedAt);
  // The footer belongs to the fixed canvas rather than immediately after its
  // content. This keeps the disclaimer at the bottom of every rendered page
  // while allowing the panel above it to use the remaining vertical space.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${darkModeAssets()}</head><body bgcolor="#ffffff" style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#17212b"><div style="box-sizing:border-box;width:1200px;height:${height}px;display:flex;flex-direction:column;background:#ffffff"><div style="flex:1 1 auto;min-height:0">${body}</div><div style="flex:0 0 auto">${footer}</div></div></body></html>`;
}
function sectionTitle(title, subtitle = "") { return `<h3 style="margin:0;color:#111b24;font-size:18px;line-height:24px;font-weight:700">${esc(title)}</h3>${subtitle ? `<p style="margin:2px 0 7px;color:#667481;font-size:15px;line-height:20px;font-weight:400">${esc(subtitle)}</p>` : `<div style="height:7px;line-height:7px">&nbsp;</div>`}`; }

function table(headers, rows, widths = "") {
  const head = headers.map((h) => `<th style="padding:7px;background:#f1f5f8;color:#5d6b78;font-size:13px;line-height:18px;text-align:left;font-weight:700">${esc(h)}</th>`).join("");
  const body = rows.length ? rows.join("") : `<tr><td colspan="${headers.length}" style="padding:14px 7px;color:#7d8893;font-size:12px;line-height:17px">No current results.</td></tr>`;
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">${widths ? `<colgroup>${widths}</colgroup>` : ""}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function td(content, cls = "") { const color = cls.includes("up") ? "#137a4b" : cls.includes("down") ? "#c23a31" : cls.includes("flat") ? "#677684" : "#263442"; const nowrap = cls.includes("num") || cls.includes("code") ? "white-space:nowrap;" : ""; return `<td align="left" style="padding:8px 7px;border-bottom:1px solid #edf1f5;color:${color};font-size:12px;line-height:17px;vertical-align:middle;${nowrap}" bgcolor="#ffffff">${content}</td>`; }
function disclaimerTimestamp(value) { const d = new Date(value); if (Number.isNaN(d)) return MISSING; const zone = "Australia/Sydney"; const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: true }).format(d).toUpperCase(); const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(d).find((part) => part.type === "timeZoneName")?.value || ""; const abbreviation = offset.startsWith("GMT+11") ? "AEDT" : "AEST"; const dateValue = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d); return `${time} ${abbreviation} on ${dateValue}`; }
function scanFooter(generatedAt) {
  const timestamp = disclaimerTimestamp(generatedAt);
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#e7e9ec" style="width:100%;margin-top:28px;border-collapse:collapse;background:#e7e9ec"><tr><td width="86" valign="middle" align="center" style="width:86px;padding:20px 0 20px 6px" bgcolor="#e7e9ec"><img src="${esc(LOGO_DATA_URL)}" alt="Marketech Focus" width="65" height="65" style="display:block;width:65px;height:65px;border:0"></td><td valign="middle" style="padding:10px 6px" bgcolor="#e7e9ec"><strong style="display:block;color:#17212b;font-size:15px;line-height:20px;font-weight:700">Get live data and serious tools on Marketech Focus</strong><span style="display:block;margin-top:6px;color:#52616e;font-size:12px;line-height:17px">Content generated at ${esc(timestamp)} by Marketech Online Trading Pty Ltd (ACN 654 674 432), Authorised Representative (1293528) of Sanlam Private Wealth Pty Ltd (AFSL 337927). This content includes third-party information and/or analysis generated using mathematical models. The content has been prepared for general information purposes only and does not consider your objectives, financial situation, or needs. Before making any investment decisions, consider its appropriateness and seek professional advice where needed. Model outputs have limitations and do not guarantee future results. Investing involves risk, including loss of capital. Past performance is not a reliable indicator of future performance. Refer to our Terms and Conditions at marketech.com.au/terms-and-conditions/, for more information. <strong style="font-weight:700">Data provided by TMX Australia Exchange.</strong></span></td></tr></table>`;
}

function scanPanel(key, scan) {
  const rows = items(scan).slice(0, 5).map((r) => { const cls = movement(r.changePercent); return `<tr>${td(`<strong>${esc(r.code)}</strong>`)}${td(esc(r.name), cls)}${td(sparkline(r.dailySparkline))}${td(esc(price(r.last)), `num ${cls}`)}${td(esc(signed(r.change)), `num ${cls}`)}${td(esc(pct(r.changePercent)), `num ${cls}`)}${td(esc(money(r.marketCap)), "num")}</tr>`; });
  return shell(SCAN_TITLES[key], `${sectionTitle(SCAN_TITLES[key], SCAN_SUBTITLES[key])}${table(["Code", "Name", "Daily", "Last", "Chg", "Chg %", "Market Cap"], rows, "<col width=\"56\"><col><col width=\"116\"><col width=\"74\"><col width=\"74\"><col width=\"80\"><col width=\"104\">")}`, "16:9");
}
function dividendsPanel(data) {
  const rows = items(data).slice(0, 10).map((r) => { const cls = movement(r.changePercent); return `<tr>${td(`<strong>${esc(r.code)}</strong>`)}${td(esc(r.name), cls)}${td(sparkline(r.dailySparkline))}${td(esc(date(r.exDate)))}${td(esc(date(r.paymentDate)))}${td(esc(dividendAmount(r.amount)), "num")}${td(esc(price(r.rate)), "num")}${td(esc(franking(r.franking)), "num")}${td(esc(r.type || MISSING))}</tr>`; });
  return shell("Upcoming Dividends", `${sectionTitle("Upcoming Dividends", "Large AU stock dividends with an ex-date in the next 14 days.")}${table(["Code", "Name", "52 weeks", "Ex-date", "Pay date", "Amt", "Rate", "Frank", "Type"], rows, "<col width=\"56\"><col><col width=\"116\"><col width=\"88\"><col width=\"88\"><col width=\"66\"><col width=\"66\"><col width=\"66\"><col width=\"66\">")}`, "16:9");
}
function raiseAsk(r) { if (r.ask) return r.ask; const amount = num(r.raiseAmount ?? r.amount ?? r.totalRaise); const offer = num(r.offerPrice ?? r.price ?? r.issuePrice); return [amount !== null ? `Raising ${money(amount)}` : "", offer !== null ? `@ ${price(offer)}` : ""].filter(Boolean).join(" ") || r.description || MISSING; }
function raisesPanel(data) {
  const rows = items(data).slice(0, 5).map((r) => { const cls = movement(r.changePercent); return `<tr>${td(`<strong>${esc(r.code)}</strong>`)}${td(esc(r.name), cls)}${td(esc(raiseAsk(r)))}${td(esc(String(r.stage || r.rawStatus || MISSING).replace(/([a-z])([A-Z])/g, "$1 $2")))}${td(esc(price(r.last)), `num ${cls}`)}${td(esc(pct(r.changePercent)), `num ${cls}`)}</tr>`; });
  return shell("Current Capital Raises", `${sectionTitle("Current Capital Raises")}${table(["Code", "Name", "Ask", "Stage", "Last", "Chg %"], rows)}`, "16:9");
}
function mediaPanel(data) {
  const rows = items(data).slice(0, 3).map((r) => {
    const provider = r.provider || MISSING;
    const logo = r.providerIconUrl || r.logoUrl;
    const typeIcon = r.typeIconUrl;
    const logoCell = logo
      ? `<img src="${esc(logo)}" alt="${esc(provider)}" width="42" style="display:block;border:0;width:42px;height:auto;margin:0 auto">`
      : `<span style="display:block;color:#5d6b78;font-size:10px;line-height:13px;font-weight:700;text-align:center">${esc(provider)}</span>`;
    return `<tr><td width="78" align="center" valign="middle" style="padding:10px 0;border-bottom:1px solid #edf1f5;width:78px;text-align:center" bgcolor="#ffffff">${logoCell}</td><td valign="middle" style="padding:10px 0 10px 10px;border-bottom:1px solid #edf1f5;color:#263442;font-size:12px;line-height:17px" bgcolor="#ffffff"><div style="margin-bottom:4px;color:#697784;font-size:11px;line-height:15px;font-weight:700">${typeIcon ? `<img src="${esc(typeIcon)}" alt="${esc(r.contentType || "Article")}" width="13" height="13" style="display:inline-block;width:13px;height:13px;margin-right:5px;vertical-align:-2px;border:0">` : ""}<span style="display:inline-block;margin-right:6px;color:#174889">${esc(provider)}</span><span>${esc(mediaDate(r.dateTime || r.publishedAt || r.date))}</span></div><div style="color:#1e2a36;font-size:13px;line-height:18px;font-weight:400">${esc(String(r.headline || r.title || MISSING).replace(/&amp;/g, "&"))}</div></td></tr>`;
  });
  const body = rows.length ? rows.join("") : `<tr><td style="padding:14px 7px;color:#7d8893;font-size:12px">No media items returned.</td></tr>`;
  return shell("Media Snapshot", `${sectionTitle("Media Snapshot")}<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt"><tbody>${body}</tbody></table>`, "16:9");
}

function heatColor(value) { const n = num(value) || 0; if (n === 0) return "#E0E0E0"; if (n >= 2) return "#3EAA77"; if (n >= 1.5) return "#7FC0A1"; if (n >= 1) return "#BDDACB"; if (n >= 0.5) return "#C8DDD2"; if (n > 0) return "#D2DDD7"; if (n <= -2) return "#FF745F"; if (n <= -1.5) return "#F3A093"; if (n <= -1) return "#F7B3A8"; if (n <= -0.5) return "#F3BCB3"; return "#E9CEC9"; }
function canonicalSectorName(value) { const text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); if (text.includes("financial")) return "Financials"; if (text.includes("material")) return "Materials"; if (text.includes("health")) return "Health Care"; if (text.includes("consumerdiscretionary")) return "Consumer Discretionary"; if (text.includes("realestate")) return "Real Estate"; if (text.includes("energy")) return "Energy"; if (text.includes("industrial")) return "Industrials"; if (text.includes("communication")) return "Communication"; if (text.includes("consumerstaple")) return "Consumer Staples"; if (text.includes("information") || text.includes("technology")) return "Information"; if (text.includes("utilit")) return "Utilities"; return "Unknown"; }
function splitTreemap(items, x, y, width, height, horizontal = false) { if (!items.length) return []; if (items.length === 1) return [{ ...items[0], x, y, width, height }]; const sorted = [...items].sort((a, b) => (num(b.weight) || 0) - (num(a.weight) || 0)); const total = sorted.reduce((sum, item) => sum + (num(item.weight) || 0), 0); if (!total) { const size = horizontal ? width / sorted.length : height / sorted.length; return sorted.flatMap((item, index) => horizontal ? splitTreemap([item], x + index * size, y, size, height, !horizontal) : splitTreemap([item], x, y + index * size, width, size, !horizontal)); } let splitIndex = 1, running = num(sorted[0].weight) || 0; for (let index = 1; index < sorted.length - 1; index += 1) { const next = running + (num(sorted[index].weight) || 0); if (Math.abs(total / 2 - next) > Math.abs(total / 2 - running)) break; running = next; splitIndex = index + 1; } const first = sorted.slice(0, splitIndex), second = sorted.slice(splitIndex), firstShare = running / total; if (horizontal) { const firstWidth = width * firstShare; return [...splitTreemap(first, x, y, firstWidth, height, !horizontal), ...splitTreemap(second, x + firstWidth, y, width - firstWidth, height, !horizontal)]; } const firstHeight = height * firstShare; return [...splitTreemap(first, x, y, width, firstHeight, !horizontal), ...splitTreemap(second, x, y + firstHeight, width, height - firstHeight, !horizontal)]; }
function weightedWidths(items, minWidth) { const total = items.reduce((sum, item) => sum + (num(item.weight) || 0), 0); const raw = items.map((item) => total ? ((num(item.weight) || 0) / total) * 100 : 100 / items.length); const lockedTotal = raw.reduce((sum, width) => sum + Math.min(width, minWidth), 0); if (lockedTotal >= 100) return items.map(() => 100 / items.length); const flexibleTotal = raw.reduce((sum, width) => sum + Math.max(0, width - minWidth), 0) || 1, remaining = 100 - items.length * minWidth; return raw.map((width) => minWidth + (Math.max(0, width - minWidth) / flexibleTotal) * remaining); }
function heatmapTextSize(widthPct, heightPct, sectorWidthPct, rowHeightPx) { const widthPx = 1200 * (sectorWidthPct / 100) * (widthPct / 100), heightPx = rowHeightPx * (heightPct / 100); if (widthPx < 48 || heightPx < 32) return { show: false, showPercent: false, fontSize: 0 }; if (widthPx < 64 || heightPx < 42) return { show: true, showPercent: false, fontSize: 13 }; if (widthPx < 82 || heightPx < 54) return { show: true, showPercent: true, fontSize: 14 }; return { show: true, showPercent: true, fontSize: 15 }; }
function heatmapPanel(data) {
  const sectors = Array.isArray(data?.sectors) ? data.sectors : [], stocks = Array.isArray(data?.stocks) ? data.stocks : sectors.flatMap((sector) => sector.stocks || []);
  const indexWeight = stocks.reduce((sum, stock) => sum + (num(stock.marketCap ?? stock.weight) || 0), 0) || 1;
  const indexChange = stocks.reduce((sum, stock) => sum + (num(stock.marketCap ?? stock.weight) || 0) * (num(stock.changePercent) || 0), 0) / indexWeight;
  // The heatmap composition is sourced from heatmap.json, while the A200 header is
  // deliberately sourced from its dedicated benchmark quote.
  const a200Quote = read("benchmarks/A200.json")?.quote || {};
  const a200Price = num(a200Quote.price);
  const a200Change = num(a200Quote.change) ?? indexChange;
  const changeColor = movement(a200Change) === "up" ? "#137a4b" : movement(a200Change) === "down" ? "#c23a31" : "#677684";
  const sectorMap = sectors.reduce((map, sector) => { const name = canonicalSectorName(sector.name); if (name !== "Unknown") map.set(name, sector); return map; }, new Map());
  const rows = [["Financials", "Materials"], ["Health Care", "Consumer Discretionary", "Real Estate", "Energy"], ["Industrials", "Communication", "Consumer Staples", "Information", "Utilities"]].map((names) => names.map((name) => { const sector = sectorMap.get(name) || { name, weight: 0, stocks: [] }; const members = (sector.stocks || []).filter((stock) => stock.code && num(stock.marketCap ?? stock.weight) !== null).sort((a, b) => (num(b.marketCap ?? b.weight) || 0) - (num(a.marketCap ?? a.weight) || 0)).map((stock) => ({ ...stock, weight: num(stock.marketCap ?? stock.weight) || 0 })); const weight = num(sector.weight) || members.reduce((sum, stock) => sum + stock.weight, 0); return { ...sector, name, stocks: members, weight }; }));
  // Reserve space for the header and the fixed bottom disclaimer inside the
  // square canvas.  The previous 1075px treemap painted underneath the footer.
  const totalWeight = rows.flat().reduce((sum, sector) => sum + sector.weight, 0) || 1, treemapHeight = 930;
  const blocks = rows.map((row, rowIndex) => { const rowWeight = row.reduce((sum, sector) => sum + sector.weight, 0), rowHeight = treemapHeight * (rowWeight / totalWeight), widths = weightedWidths(row, rowIndex === 0 ? 34 : rowIndex === 1 ? 15 : 12); const sectorHtml = row.map((sector, sectorIndex) => { const sectorWidth = widths[sectorIndex], tiles = splitTreemap(sector.stocks.slice(0, 34), 0, 0, 100, 100, false).map((stock) => { const text = heatmapTextSize(stock.width, stock.height, sectorWidth, rowHeight), label = text.show ? `<strong style="display:block;color:#111b24;font-size:${text.fontSize}px;line-height:${Math.max(text.fontSize + 1, 14)}px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(stock.code)}</strong>${text.showPercent ? `<em style="display:block;color:#111b24;font-size:${Math.min(13, Math.max(text.fontSize - 2, 12))}px;line-height:${Math.max(text.fontSize - 1, 13)}px;font-style:normal;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(pct(stock.changePercent))}</em>` : ""}` : ""; return `<span style="position:absolute;box-sizing:border-box;left:${stock.x.toFixed(3)}%;top:${stock.y.toFixed(3)}%;width:${stock.width.toFixed(3)}%;height:${stock.height.toFixed(3)}%;border:1px solid rgba(255,255,255,.72);padding:0;overflow:hidden;background:${heatColor(stock.changePercent)}"><span style="display:table;width:100%;height:100%"><span style="display:table-cell;vertical-align:middle;text-align:center;padding:3px">${label}</span></span></span>`; }).join(""); return `<td valign="top" style="width:${sectorWidth.toFixed(3)}%;height:${rowHeight.toFixed(0)}px;border:1px solid #fff;vertical-align:top"><div style="position:relative;width:100%;height:${rowHeight.toFixed(0)}px;overflow:hidden"><div style="position:absolute;top:4px;left:4px;z-index:3;max-width:90%;padding:2px 4px;background:rgba(255,255,255,.64);color:#111b24;font-size:15px;line-height:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sector.name)}</div>${tiles}</div></td>`; }).join(""); return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;height:${rowHeight.toFixed(0)}px;border-collapse:collapse;table-layout:fixed"><tr>${sectorHtml}</tr></table>`; }).join("");
  const arrow = a200Change > 0 ? "▲" : a200Change < 0 ? "▼" : "";
  const header = `<div style="margin:0 0 7px;text-align:center"><div style="display:inline-block;margin:0 0 3px;padding:2px 6px;color:#17212b;font-size:17px;line-height:23px;font-weight:700;border:1px solid #111111">A200, Solactive Australia 200 Index</div><div style="color:${changeColor};font-size:15px;line-height:20px;font-weight:400">${esc(price(a200Price))}&nbsp;&nbsp;${arrow ? `${arrow} ` : ""}${esc(signed(a200Change))}&nbsp;&nbsp;${esc(pct(a200Quote.changePercent))}</div></div>`;
  return shell("Australian Top 200 Heatmap", `${header}${sectionTitle("Australian Top 200 Heatmap")}<div style="font-size:0;line-height:0;overflow:hidden">${blocks || `<div style="padding:30px;color:#7b8793;font-size:12px;line-height:17px">No heatmap data.</div>`}</div>`, "1:1");
}
function socialDate(value) { const d = new Date(value); return Number.isNaN(d) ? "" : new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "short" }).format(d); }
function socialMountain(candles) {
  const source = (candles || []).map((c) => ({ time: new Date(c.time).getTime(), value: num(c.close) })).filter((p) => Number.isFinite(p.time) && p.value !== null);
  if (source.length < 2) return `<div style="height:450px;display:grid;place-items:center;color:#5f6f82;font-size:20px">Chart data is unavailable.</div>`;
  const limit = 900, points = source.length <= limit ? source : Array.from({ length: limit }, (_, i) => source[Math.round(i * (source.length - 1) / (limit - 1))]);
  const width = 1200, height = 465, top = 24, bottom = 48, right = 96;
  const values = points.map((p) => p.value), min = Math.min(...values), max = Math.max(...values), pad = (max - min || Math.max(Math.abs(max) * .02, .01)) * .12, low = min - pad, high = max + pad, span = high - low || 1;
  const x = (_, i) => i / Math.max(points.length - 1, 1) * (width - right);
  const y = (p) => height - bottom - ((p.value - low) / span) * (height - top - bottom);
  const line = points.map((p, i) => `${x(p, i).toFixed(2)},${y(p).toFixed(2)}`).join(" ");
  const area = `0,${height - bottom} ${line} ${x(points.at(-1), points.length - 1).toFixed(2)},${height - bottom}`;
  const grid = Array.from({ length: 4 }, (_, offset) => { const value = low + span * (offset + 1) / 4, lineY = height - bottom - ((value - low) / span) * (height - top - bottom); return `<line x1="0" y1="${lineY.toFixed(2)}" x2="${width-right}" y2="${lineY.toFixed(2)}" stroke="#e3ebf5"/><text x="${width-right+12}" y="${(lineY+6).toFixed(2)}" fill="#5f6f82" font-size="12">${esc(price(value))}</text>`; }).join("");
  const labels = [0, Math.floor(points.length / 2), points.length - 1].map((index, labelIndex, all) => `<text x="${x(points[index], index).toFixed(2)}" y="${height-7}" fill="#5f6f82" font-size="12" text-anchor="${labelIndex === 0 ? "start" : labelIndex === all.length - 1 ? "end" : "middle"}">${esc(socialDate(points[index].time))}</text>`).join("");
  const last = points.at(-1);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Five day area chart" style="display:block;width:100%;height:100%"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#226acb" stop-opacity=".46"/><stop offset="100%" stop-color="#226acb" stop-opacity=".03"/></linearGradient></defs>${grid}<polygon points="${area}" fill="url(#chartFill)"/><polyline points="${line}" fill="none" stroke="#226acb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x(last, points.length - 1).toFixed(2)}" cy="${y(last).toFixed(2)}" r="6" fill="#226acb"/>${labels}</svg>`;
}
function benchmarkChartShell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${darkModeAssets()}</head><body style="margin:0;background:#fff;color:#17212b;font-family:Arial,Helvetica,sans-serif"><div style="box-sizing:border-box;width:1200px;height:675px;display:flex;flex-direction:column;background:#fff"><main style="box-sizing:border-box;flex:1 1 auto;min-height:0;background:#fff;padding:0">${body}</main><div style="flex:0 0 auto">${scanFooter(read("manifest.json").generatedAt)}</div></div></body></html>`;
}
function benchmarkPanel(symbol, data) {
  const candles = data?.candles5m5d?.candles || [], quote = data?.quote, change = quote?.change, changeClass = movement(change) === "up" ? "#158b5b" : movement(change) === "down" ? "#d34e41" : "#667481";
  const chart = data?.unavailable?.reason ? `<div style="height:465px;display:grid;place-items:center;color:#5f6f82;font-size:20px">${esc(data.unavailable.reason)}</div>` : socialMountain(candles);
  const content = `<section><div style="display:flex;justify-content:space-between;gap:18px"><div><div style="font-size:24px;line-height:29px;font-weight:700;letter-spacing:.04em">${esc(symbol)}</div><div style="margin-top:4px;color:#5f6f82;font-size:17px;line-height:22px">${esc(quote?.companyName || symbol)}</div><div style="display:flex;align-items:baseline;gap:12px;margin-top:17px;font-size:17px;font-weight:600"><span style="font-size:28px;line-height:33px;font-weight:700;color:#17212b">${esc(price(quote?.price))}</span><span style="color:${changeClass}">${esc(signed(change))}</span><span style="color:${changeClass}">(${esc(pct(quote?.changePercent))})</span></div></div></div><div style="height:465px;margin-top:22px">${chart}</div><div style="display:flex;align-items:center;gap:8px;margin-top:18px"><span style="padding:10px 14px;border-radius:4px;background:#e7e9ec;color:#52616e;font-size:13px;font-weight:700">5m</span><span style="padding:10px 14px;border-radius:4px;background:#e7e9ec;color:#52616e;font-size:13px;font-weight:700">Mountain</span></div></section>`;
  return benchmarkChartShell(`${symbol} Benchmark`, content);
}
function main() {
  fs.rmSync(OUTPUT, { recursive: true, force: true }); fs.mkdirSync(OUTPUT, { recursive: true });
  const manifest = read("manifest.json"); const links = [];
  for (const key of SCANS) { write(`scans/${key}.html`, scanPanel(key, read(`scans/${key}.json`))); links.push([SCAN_TITLES[key], `scans/${key}.html`]); }
  write("dividends.html", dividendsPanel(read("content/dividends.json"))); write("raises.html", raisesPanel(read("content/raises.json"))); write("media.html", mediaPanel(read("content/media.json"))); write("heatmap.html", heatmapPanel(read("content/heatmap.json")));
  for (const symbol of BENCHMARKS) { write(`benchmarks/${symbol}.html`, benchmarkPanel(symbol, read(`benchmarks/${symbol}.json`))); }
  const list = [["Australian Top 200 Heatmap", "heatmap.html"], ["Media Snapshot", "media.html"], ["Upcoming Dividends", "dividends.html"], ["Current Capital Raises", "raises.html"], ...links, ...BENCHMARKS.map((symbol) => [`${symbol} Benchmark`, `benchmarks/${symbol}.html`])].map(([name, href]) => `<li style="margin:10px 0"><a href="${href}" style="color:#174889;font-size:17px;text-decoration:none;font-weight:700">${esc(name)}</a></li>`).join("");
  write("index.html", shell("Focus Snapshot Renders", `<ul style="margin:0;padding-left:22px">${list}</ul>`, "16:9"));
  write("manifest.json", `${JSON.stringify({ generatedAt: new Date().toISOString(), sourceGeneratedAt: manifest.generatedAt || null, output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/"), files: 1 + SCANS.length + BENCHMARKS.length + 4 }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/"), panels: SCANS.length + BENCHMARKS.length + 4 }, null, 2));
}
main();
