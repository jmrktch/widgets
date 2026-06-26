(function () {
  var script = document.currentScript;
  if (!script) return;
  var maxWatchlistSymbols = 15;

  var widgetTypeRaw = String(script.dataset.widget || "ticker").trim().toLowerCase();
  var widgetType = widgetTypeRaw === "watchlists" ? "watchlist" : widgetTypeRaw;
  var symbolRaw = String(script.dataset.symbol || "ASX:BHP").trim().toUpperCase();
  var symbol = symbolRaw.indexOf(":") >= 0 ? symbolRaw.split(":").pop() : symbolRaw;
  var symbols = String(script.dataset.symbols || "BHP,CSL,CBA,A200,TLS,WES,RIO,FMG")
    .split(",")
    .map(function (value) { return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); })
    .filter(Boolean)
    .slice(0, maxWatchlistSymbols);
  var interval = String(script.dataset.interval || "day").trim().toLowerCase();
  var containerId = script.dataset.containerId || "";
  var width = script.dataset.width || "";
  var apiBase = new URL(script.src, window.location.href).origin;
  var chartLabelFontSize = 10.5;
  var flashTimersByKey = new Map();
  var sydneyDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  var sydneyTimePartsFormatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  var axisLabelFormatters = {
    minuteDate: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
    minuteTime: new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
    day: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
    month: new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" })
  };
  var sydneyDateKeyCache = new Map();
  var sydneyTimePartsCache = new Map();
  var axisLabelCache = new Map();
  var chartZoomPresets = {
    minute: [
      { key: "1d", label: "1D", durationMs: 1 * 24 * 60 * 60 * 1000 },
      { key: "3d", label: "3D", durationMs: 3 * 24 * 60 * 60 * 1000 },
    ],
    hour: [
      { key: "7d", label: "7D", durationMs: 7 * 24 * 60 * 60 * 1000 },
      { key: "14d", label: "14D", durationMs: 14 * 24 * 60 * 60 * 1000 }
    ],
    day: [
      { key: "1m", label: "1M", durationMs: 30 * 24 * 60 * 60 * 1000 },
      { key: "3m", label: "3M", durationMs: 91 * 24 * 60 * 60 * 1000 }
    ],
    month: [
      { key: "1y", label: "1Y", durationMs: 365 * 24 * 60 * 60 * 1000 },
      { key: "3y", label: "3Y", durationMs: 3 * 365 * 24 * 60 * 60 * 1000 }
    ]
  };
  var mount = containerId ? document.getElementById(containerId) : null;
  if (!mount) {
    mount = document.createElement("div");
    script.parentNode.insertBefore(mount, script);
  }

  function ensureStyles() {
    if (document.getElementById("mtw-embed-style")) return;
    var style = document.createElement("style");
    style.id = "mtw-embed-style";
    style.textContent = "" +
      ".mtw-root{font-family:Roboto,Segoe UI,Tahoma,sans-serif;color:#122133;width:100%;}" +
      ".mtw-root *{box-sizing:border-box;}" +
      ".mtw-shell{position:relative;background:#fff;}" +
      ".mtw-logo-badge{position:absolute;top:5px;right:0;width:35px;height:35px;display:flex;align-items:center;justify-content:flex-end;background:#f0f0f0;padding:4px;border-radius:99px 0 0 99px;text-decoration:none;overflow:hidden;transition:width 180ms ease;box-shadow:0 0 3px rgba(0,0,0,.5);}" +
      ".mtw-logo-badge:hover,.mtw-logo-badge:focus-visible{width:320px;}" +
      ".mtw-logo-badge-label{font-family:Roboto,Segoe UI,Tahoma,sans-serif;font-size:.85rem;font-weight:700;line-height:1;color:#444;white-space:nowrap;margin-right:10px;opacity:0;transform:translateX(10px);transition:opacity 180ms ease,transform 180ms ease;pointer-events:none;}" +
      ".mtw-logo-badge:hover .mtw-logo-badge-label,.mtw-logo-badge:focus-visible .mtw-logo-badge-label{opacity:1;transform:translateX(0);}" +
      ".mtw-logo-badge-icon{flex:0 0 27px;width:27px;height:27px;display:grid;place-items:center;}" +
      ".mtw-logo-badge img{display:block;width:100%;height:100%;object-fit:contain;}" +
      ".mtw-branding{width:100%;padding:5px;font-size:.8rem;line-height:1.2;color:#3f3f3f;text-align:center;background:#f0f0f0;border:1px solid #d2deed;border-top:none;border-radius:0 0 4px 4px;}" +
      ".mtw-branding-quote{width:350px;padding:5px;font-size:.8rem;line-height:1.2;color:#3f3f3f;text-align:center;background:#f0f0f0;border:1px solid #d2deed;border-top:none;border-radius:0 0 4px 4px;}" +
      ".mtw-branding a{color:#FF745F;text-decoration:none;}" +
      ".mtw-branding-quote a{color:#FF745F;text-decoration:none;}" +
      ".mtw-branding a:hover{text-decoration:underline;}" +
      ".mtw-branding-quote a:hover{text-decoration:underline;}" +
      ".mtw-ticker-widget{max-width:350px;}" +
      ".mtw-quote-shell{width:100%;max-width:350px;padding:10px;border:1px solid #d2deed;border-radius:4px 4px 0 0;border-bottom:none;position:relative;}" +
      ".mtw-ticker-line{margin:0 0 4px;}" +
      ".mtw-ticker{margin:0;font-size:1.3rem;line-height:1.15;font-weight:700;letter-spacing:.02em;}" +
      ".mtw-company{margin:0 0 10px;font-size:.9rem;line-height:1.2;font-weight:400;color:#5f6f82;}" +
      ".mtw-quote-top{display: grid;grid-template-columns: 75% 25%;justify-content: space-between;align-items:start}" +
      ".mtw-quote-main{min-width:0;}" +
      ".mtw-quote-metrics{display:grid;grid-template-columns:auto auto auto;justify-content: flex-start;gap:8px;align-items:end;min-width:0;}" +
      ".mtw-price{margin:0;font-size:1.75rem;font-weight:700;line-height:1;}" +
      ".mtw-price.flash-up,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-last.flash-up{animation:mtw-price-flash-up 4s ease-out;}" +
      ".mtw-price.flash-down,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-last.flash-down{animation:mtw-price-flash-down 4s ease-out;}" +
      ".mtw-price.flash-flat,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-last.flash-flat{animation:mtw-price-flash-flat 4s ease-out;}" +
      ".mtw-metric{margin:0;min-width:0;font-size:1rem;line-height:1.15;font-weight:500;}" +
      ".mtw-up{color:#238657;}" +
      ".mtw-down{color:#e61f00;}" +
      ".mtw-muted{color:#5f6f82;}" +
      ".mtw-mini-chart-wrap{min-height:56px;display:grid;place-items:center;align-self:stretch;min-width:84px;width:100%;}" +
      ".mtw-mini-chart-placeholder{color:#5f6f82;font-size:.74rem;text-align:center;}" +
      ".mtw-watchlist-widget{width:100%;min-width:0;}" +
      ".mtw-watchlist-shell{width:100%;min-width:0;border:1px solid #d2deed;border-bottom:none;padding:10px;position:relative;background:#fff;border-radius:4px 4px 0 0;}" +
      ".mtw-watchlist-table{width:100%;border-collapse:collapse;table-layout:fixed;}" +
      ".mtw-watchlist-table thead th{padding:0 6px 6px;border-bottom:1px solid #d8d8d8;font-size:clamp(.68rem,1.15vw,.8rem);line-height:1.15;color:#5f6f82;font-weight:400;text-align:left;}" +
      ".mtw-watchlist-table tbody td{min-height:28px;padding:6px 6px;border-bottom:1px solid #efefef;font-size:clamp(.68rem,1.15vw,.8rem);line-height:1.15;color:#122133;vertical-align:middle;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".mtw-watchlist-table tbody tr:last-child td{border-bottom:none;}" +
      ".mtw-watchlist-cell{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}" +
      ".mtw-watchlist-table th.mtw-watchlist-cell,.mtw-watchlist-table td.mtw-watchlist-cell{text-align:left;}" +
      ".mtw-watchlist-code,.mtw-watchlist-last{font-weight:700;}" +
      ".mtw-watchlist-name{color:#5f6f82;}" +
      ".mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-name.mtw-up,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-up{color:#238657;}" +
      ".mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-name.mtw-down,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-down{color:#e61f00;}" +
      ".mtw-watchlist-table td.mtw-watchlist-cell.mtw-watchlist-name.mtw-muted,.mtw-watchlist-table td.mtw-watchlist-cell.mtw-muted{color:#5f6f82;}" +
      ".mtw-watchlist-chart{overflow:visible;}" +
      ".mtw-watchlist-mini-chart{width:100%;min-height:22px;display:grid;justify-items:start;align-items:center;overflow:visible;}" +
      ".mtw-watchlist-status{padding:8px 0 2px;font-size:.72rem;color:#5f6f82;}" +
      ".mtw-watchlist-col-code{width:50px;}" +
      ".mtw-watchlist-col-name{width:auto;}" +
      ".mtw-watchlist-col-daily{width:80px;}" +
      ".mtw-watchlist-col-last{width:65px;}" +
      ".mtw-watchlist-col-chg{width:65px;}" +
      ".mtw-watchlist-col-chg-pct{width:70px;}" +
      ".mtw-chart-widget{width:100%;min-width:0;}" +
      ".mtw-chart-panel{margin-top:0;padding:10px;border:1px solid #dbe5f0;border-bottom:none;border-radius:4px 4px 0 0;background:#fff;position:relative;}" +
      ".mtw-chart-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;flex-wrap:wrap;}" +
      ".mtw-chart-quote-header{min-width:0;}" +
      ".mtw-chart-quote-metrics{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;}" +
      ".mtw-chart-quote-metrics .mtw-price{font-size:1.5rem;}" +
      ".mtw-chart-quote-metrics .mtw-metric{font-size:1rem;}" +
      ".mtw-chart-controls{display:flex;flex-direction:column;padding-top:2px;gap:6px;align-items:flex-start;justify-content:flex-end;}" +
      ".mtw-control-group{display:flex;gap:6px;flex-wrap:wrap;}" +
      ".mtw-chart-btn{background:rgba(0,0,0,.04);color:#122133;padding:7px 10px;font-size:.78rem;border:0;border-radius:4px;font-weight:600;}" +
      ".mtw-chart-btn.active{background:#FF745F;color:#fff;}" +
      ".mtw-chart-wrap{width:100%;min-height:100px;position:relative;}" +
      ".mtw-chart-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px;}" +
      ".mtw-chart-zoom{display:flex;gap:6px;flex-wrap:wrap;}" +
      ".mtw-chart-range{display:none;font-size:.78rem;line-height:1.2;color:#5f6f82;}" +
      ".mtw-chart-empty{color:#5f6f82;font-size:.9rem;min-height:170px;display:grid;place-items:center;text-align:center;}" +
      ".mtw-chart-canvas svg{display:block;width:100%;}" +
      ".mtw-chart-status{color:#e61f00;font-size:.85rem;margin-top:8px;min-height:1.1em;}" +
      "@keyframes mtw-price-flash-up{0%{color:#238657;background-color:rgba(17,138,68,.20);}100%{color:inherit;background-color:transparent;}}" +
      "@keyframes mtw-price-flash-down{0%{color:#e61f00;background-color:rgba(180,35,24,.18);}100%{color:inherit;background-color:transparent;}}" +
      "@keyframes mtw-price-flash-flat{0%{color:#122133;background-color:rgba(18,33,51,.10);}100%{color:inherit;background-color:transparent;}}" +
      "@media (max-width:720px){.mtw-chart-top{flex-direction:column;align-items:flex-start;}}";
    document.head.appendChild(style);
  }

  function normalizeSize(value, fallback) {
    if (!value) return fallback;
    var raw = String(value).trim();
    if (!raw) return fallback;
    if (/^\d+$/.test(raw)) return raw + "px";
    return raw;
  }

  function fmtSigned(value, digits) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return (n > 0 ? "+" : "") + n.toFixed(digits == null ? 2 : digits);
  }

  function fmtPrice(value, digits) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits == null ? 2 : digits);
  }

  function applyPriceFlash(element, flashKey, previousPrice, nextPrice) {
    if (!element || !Number.isFinite(previousPrice) || !Number.isFinite(nextPrice)) {
      return;
    }

    var nextClass = nextPrice > previousPrice
      ? "flash-up"
      : nextPrice < previousPrice
        ? "flash-down"
        : "flash-flat";

    element.classList.remove("flash-up", "flash-down", "flash-flat");
    void element.offsetWidth;
    element.classList.add(nextClass);

    var existingTimer = flashTimersByKey.get(flashKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    var timerId = setTimeout(function () {
      element.classList.remove("flash-up", "flash-down", "flash-flat");
      flashTimersByKey.delete(flashKey);
    }, 4000);

    flashTimersByKey.set(flashKey, timerId);
  }

  function readJsonResponse(res) {
    return res.text().then(function (raw) {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (_) {
        throw new Error(raw.trim().slice(0, 140) || ("Unexpected " + res.status + " response."));
      }
    });
  }

  function getSydneyDateKey(iso) {
    var cacheKey = String(iso || "");
    if (!cacheKey) return "";
    if (sydneyDateKeyCache.has(cacheKey)) {
      return sydneyDateKeyCache.get(cacheKey);
    }
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    var result = sydneyDateKeyFormatter.format(date);
    sydneyDateKeyCache.set(cacheKey, result);
    return result;
  }

  function getCandleTimeMs(candle) {
    if (!candle) return NaN;
    if (Array.isArray(candle)) {
      return Number(candle[0]);
    }
    if (Number.isFinite(candle.timeMs)) {
      return candle.timeMs;
    }
    var timeMs = new Date(candle.time).getTime();
    if (Number.isFinite(timeMs)) {
      candle.timeMs = timeMs;
    }
    return timeMs;
  }

  function getCandleTimeIso(candle) {
    if (!candle) return null;
    if (Array.isArray(candle)) {
      var timeMs = getCandleTimeMs(candle);
      return Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null;
    }
    return candle.time || null;
  }

  function getCandleOpen(candle) {
    return Array.isArray(candle) ? Number(candle[1]) : Number(candle && candle.open);
  }

  function getCandleHigh(candle) {
    return Array.isArray(candle) ? Number(candle[2]) : Number(candle && candle.high);
  }

  function getCandleLow(candle) {
    return Array.isArray(candle) ? Number(candle[3]) : Number(candle && candle.low);
  }

  function getCandleClose(candle) {
    return Array.isArray(candle) ? Number(candle[4]) : Number(candle && candle.close);
  }

  function pickMiniSampleIndices(total, desired) {
    if (!Number.isInteger(total) || total <= 0) return [];
    if (!Number.isInteger(desired) || desired <= 0 || total <= desired) {
      return Array.from({ length: total }, function (_, index) { return index; });
    }
    var indices = new Set([0, total - 1]);
    for (var step = 0; step < desired; step += 1) {
      indices.add(Math.round((step * (total - 1)) / (desired - 1)));
    }
    return Array.from(indices).sort(function (a, b) { return a - b; });
  }

  function downsampleMiniCandles(candles, maxPoints) {
    if (!Array.isArray(candles) || !candles.length) return [];
    var safeMaxPoints = Math.max(3, Number(maxPoints) || 16);
    if (candles.length <= safeMaxPoints) {
      return candles.slice();
    }
    return pickMiniSampleIndices(candles.length, safeMaxPoints).map(function (index) {
      return candles[index];
    }).filter(Boolean);
  }

  function selectMiniChartCandles(sourceCandles) {
    if (!Array.isArray(sourceCandles) || !sourceCandles.length) return [];
    var candlesByDay = new Map();
    sourceCandles.forEach(function (candle) {
      var dateKey = getSydneyDateKey(candle && candle.time);
      if (!dateKey) return;
      if (!candlesByDay.has(dateKey)) {
        candlesByDay.set(dateKey, []);
      }
      candlesByDay.get(dateKey).push(candle);
    });
    var dateKeys = Array.from(candlesByDay.keys()).sort();
    var selected = [];
    for (var index = dateKeys.length - 1; index >= 0; index -= 1) {
      var dayCandles = candlesByDay.get(dateKeys[index]) || [];
      if (dayCandles.length >= 2) {
        selected = dayCandles;
        break;
      }
      if (!selected.length && dayCandles.length) {
        selected = dayCandles;
      }
    }
    if (!selected.length) {
      selected = sourceCandles.slice(-16);
    }
    return downsampleMiniCandles(selected, 16);
  }

  function getSydneyTimeParts(timeMs) {
    if (sydneyTimePartsCache.has(timeMs)) {
      return sydneyTimePartsCache.get(timeMs);
    }
    var values = {};
    sydneyTimePartsFormatter.formatToParts(new Date(timeMs)).forEach(function (part) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    });
    var result = {
      weekday: values.weekday || "",
      hour: Number(values.hour || 0),
      minute: Number(values.minute || 0)
    };
    sydneyTimePartsCache.set(timeMs, result);
    return result;
  }

  function isSydneyMarketPollingWindow() {
    var parts = getSydneyTimeParts(Date.now());
    var isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(parts.weekday) >= 0;
    if (!isWeekday) return false;
    var totalMinutes = parts.hour * 60 + parts.minute;
    var windowStartMinutes = 9 * 60 + 50;
    var windowEndMinutes = 16 * 60 + 30;
    return totalMinutes >= windowStartMinutes && totalMinutes <= windowEndMinutes;
  }

  function getRightScalePadding(stats, digits) {
    var values = Array.isArray(stats) ? stats : [stats && stats.min, stats && stats.max, stats && stats.rawMin, stats && stats.rawMax];
    var labels = values
      .filter(function (value) { return Number.isFinite(value); })
      .map(function (value) { return fmtPrice(value, digits == null ? 2 : digits); });
    var longestLabelLength = labels.reduce(function (max, label) {
      return Math.max(max, String(label).length);
    }, 0);
    return Math.max(44, 18 + longestLabelLength * 8);
  }

  function getResponsiveChartDimensions(availableWidth, baseWidth, baseHeight) {
    var minWidth = 220;
    var widthValue = Math.min(Math.max(availableWidth || 0, minWidth), baseWidth || 3000);
    var aspectRatio = (baseHeight || 400) / (baseWidth || 3000);
    var heightValue = Math.min(Math.max(Math.round(widthValue * aspectRatio), 220), 420);
    return { width: widthValue, height: heightValue };
  }

  function formatAxisLabel(timeValue, intervalKey) {
    if (timeValue == null || timeValue === "") return "";
    var cacheKey = intervalKey + "|" + timeValue;
    if (axisLabelCache.has(cacheKey)) {
      return axisLabelCache.get(cacheKey);
    }
    var date = typeof timeValue === "number" ? new Date(timeValue) : new Date(timeValue);
    if (Number.isNaN(date.getTime())) return "";
    var result = "";
    if (intervalKey === "minute" || intervalKey === "hour") {
      result = axisLabelFormatters.minuteDate.format(date) + " " + axisLabelFormatters.minuteTime.format(date);
    } else if (intervalKey === "day") {
      result = axisLabelFormatters.day.format(date);
    } else {
      result = axisLabelFormatters.month.format(date);
    }
    axisLabelCache.set(cacheKey, result);
    return result;
  }

  function isCompressedTradingInterval(intervalKey) {
    return intervalKey === "minute" || intervalKey === "hour" || intervalKey === "day";
  }

  function isTradingSlot(timeMs, intervalKey) {
    var parts = getSydneyTimeParts(timeMs);
    var isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(parts.weekday) >= 0;
    if (!isWeekday) return false;
    if (intervalKey === "day") return true;
    var totalMinutes = parts.hour * 60 + parts.minute;
    return totalMinutes >= 10 * 60 && totalMinutes <= 16 * 60;
  }

  function addInterval(date, intervalKey) {
    var next = new Date(date.getTime());
    if (intervalKey === "minute") {
      next.setUTCMinutes(next.getUTCMinutes() + 5, 0, 0);
      return next;
    }
    if (intervalKey === "hour") {
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      return next;
    }
    if (intervalKey === "day") {
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    if (intervalKey === "week") {
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    }
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }

  function getIntervalStepMs(intervalKey) {
    if (intervalKey === "minute") return 5 * 60 * 1000;
    if (intervalKey === "hour") return 60 * 60 * 1000;
    if (intervalKey === "day") return 24 * 60 * 60 * 1000;
    if (intervalKey === "week") return 7 * 24 * 60 * 60 * 1000;
    return null;
  }

  function alignTimeToInterval(timeMs, intervalKey) {
    var date = new Date(timeMs);
    if (intervalKey === "minute") {
      var minutes = date.getUTCMinutes();
      date.setUTCMinutes(minutes - (minutes % 5), 0, 0);
      return date.getTime();
    }
    if (intervalKey === "hour") {
      date.setUTCMinutes(0, 0, 0);
      return date.getTime();
    }
    if (intervalKey === "day") {
      date.setUTCHours(0, 0, 0, 0);
      return date.getTime();
    }
    if (intervalKey === "week") {
      var day = date.getUTCDay();
      date.setUTCDate(date.getUTCDate() - day);
      date.setUTCHours(0, 0, 0, 0);
      return date.getTime();
    }
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  function buildTradingSlots(startMs, endMs, intervalKey) {
    intervalKey = intervalKey || "minute";
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return [];
    }
    var slots = [];
    var cursor = alignTimeToInterval(startMs, intervalKey);
    while (cursor <= endMs) {
      if (cursor >= startMs && isTradingSlot(cursor, intervalKey)) {
        slots.push(cursor);
      }
      cursor = addInterval(new Date(cursor), intervalKey).getTime();
    }
    return slots;
  }

  function buildAxisTicks(windowStartMs, windowEndMs, widthValue, padding, intervalKey) {
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
      return [];
    }
    var desiredTicks = 5;
    var axisLeftPadding = padding + 18;
    var axisRightPadding = padding + 18;
    var ticks = [];
    for (var i = 0; i < desiredTicks; i += 1) {
      var ratio = desiredTicks === 1 ? 0 : i / (desiredTicks - 1);
      var timeMs = windowStartMs + ratio * (windowEndMs - windowStartMs);
      var x = axisLeftPadding + ratio * (widthValue - axisLeftPadding - axisRightPadding);
      ticks.push({
        x: x,
        label: formatAxisLabel(timeMs, intervalKey)
      });
    }
    return ticks.filter(function (tick) { return tick.label; });
  }

  function buildAxisTicksFromSlots(slots, widthValue, padding, intervalKey) {
    if (!Array.isArray(slots) || slots.length < 2) return [];
    var desiredTicks = 5;
    var axisLeftPadding = padding + 18;
    var axisRightPadding = padding + 18;
    var lastIndex = slots.length - 1;
    var ticks = [];
    for (var i = 0; i < desiredTicks; i += 1) {
      var ratio = desiredTicks === 1 ? 0 : i / (desiredTicks - 1);
      var index = Math.round(ratio * lastIndex);
      var x = axisLeftPadding + ratio * (widthValue - axisLeftPadding - axisRightPadding);
      ticks.push({
        x: x,
        label: formatAxisLabel(slots[index], intervalKey)
      });
    }
    return ticks.filter(function (tick) { return tick.label; });
  }

  function buildPriceScale(stats, heightValue, padding, bottomPadding, steps) {
    steps = steps || 7;
    if (!stats || !Number.isFinite(stats.min) || !Number.isFinite(stats.max) || steps < 2) {
      return [];
    }
    var lines = [];
    for (var i = 0; i < steps; i += 1) {
      var ratio = i / (steps - 1);
      var y = padding + ratio * (heightValue - padding - bottomPadding);
      var value = stats.max - ratio * (stats.max - stats.min);
      lines.push({ y: y, value: value });
    }
    return lines;
  }

  function getChartStats(candles) {
    var prices = (candles || []).flatMap(function (candle) {
      return [getCandleOpen(candle), getCandleHigh(candle), getCandleLow(candle), getCandleClose(candle)];
    }).filter(Number.isFinite);
    if (prices.length < 2) return null;
    var rawMin = Math.min.apply(null, prices);
    var rawMax = Math.max.apply(null, prices);
    var rawSpan = rawMax - rawMin || Math.max(Math.abs(rawMax) * 0.02, 1);
    var buffer = rawSpan * 0.08;
    return {
      min: rawMin - buffer,
      max: rawMax + buffer,
      rawMin: rawMin,
      rawMax: rawMax
    };
  }

  function getZoomPresets(intervalKey) {
    return chartZoomPresets[intervalKey] || chartZoomPresets.day;
  }

  function buildMiniAreaSeries(sourceSeries) {
    if (!Array.isArray(sourceSeries) || !sourceSeries.length) return [];
    return sourceSeries
      .map(function (value, index) {
        return { index: index, value: Number(value) };
      })
      .filter(function (point) {
        return Number.isFinite(point.value);
      });
  }

  function buildMiniChartColoredSegments(coords, prevCloseY) {
    if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(prevCloseY)) return [];
    var segments = [];
    for (var index = 1; index < coords.length; index += 1) {
      var start = coords[index - 1];
      var end = coords[index];
      var startDelta = prevCloseY - start.y;
      var endDelta = prevCloseY - end.y;
      var startAbove = startDelta >= 0;
      var endAbove = endDelta >= 0;
      if (startAbove === endAbove || start.y === end.y) {
        segments.push({
          points: start.x.toFixed(2) + "," + start.y.toFixed(2) + " " + end.x.toFixed(2) + "," + end.y.toFixed(2),
          stroke: startAbove ? "#22a06b" : "#d14343"
        });
        continue;
      }
      var ratio = (prevCloseY - start.y) / (end.y - start.y);
      var crossingX = start.x + (end.x - start.x) * ratio;
      var crossingPoint = { x: crossingX, y: prevCloseY };
      segments.push({
        points: start.x.toFixed(2) + "," + start.y.toFixed(2) + " " + crossingPoint.x.toFixed(2) + "," + crossingPoint.y.toFixed(2),
        stroke: startAbove ? "#22a06b" : "#d14343"
      });
      segments.push({
        points: crossingPoint.x.toFixed(2) + "," + crossingPoint.y.toFixed(2) + " " + end.x.toFixed(2) + "," + end.y.toFixed(2),
        stroke: endAbove ? "#22a06b" : "#d14343"
      });
    }
    return segments;
  }

  function buildMiniChartSvgMarkup(series, previousClose, options) {
    options = options || {};
    var miniSeries = buildMiniAreaSeries(series);
    if (miniSeries.length < 1) return "";
    var chartWidth = options.width == null ? 114 : options.width;
    var chartHeight = options.height == null ? 52 : options.height;
    var padding = options.padding == null ? 4 : options.padding;
    var endpointRadius = options.endpointRadius == null ? 2.8 : options.endpointRadius;
    var prevClose = Number(previousClose);
    var values = miniSeries.map(function (point) { return Number(point.value); }).filter(Number.isFinite);
    if (Number.isFinite(prevClose)) values.push(prevClose);
    if (values.length < 1) return "";
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || Math.max(Math.abs(max) * 0.003, 1);
    var paddedMin = min - span * 0.12;
    var paddedMax = max + span * 0.12;
    var paddedSpan = paddedMax - paddedMin || 1;
    var latest = Number(miniSeries[miniSeries.length - 1].value);
    var stroke = Number.isFinite(prevClose) && latest < prevClose ? "#d14343" : "#22a06b";
    var coords = miniSeries.map(function (point, index) {
      var ratioX = miniSeries.length === 1 ? 0 : index / (miniSeries.length - 1);
      var x = padding + ratioX * (chartWidth - padding * 2);
      var y = chartHeight - padding - ((Number(point.value) - paddedMin) / paddedSpan) * (chartHeight - padding * 2);
      return { x: x, y: y, value: Number(point.value) };
    });
    var linePoints = coords.map(function (point) { return point.x.toFixed(2) + "," + point.y.toFixed(2); }).join(" ");
    var prevCloseY = Number.isFinite(prevClose)
      ? chartHeight - padding - ((prevClose - paddedMin) / paddedSpan) * (chartHeight - padding * 2)
      : null;
    var coloredSegments = Number.isFinite(prevCloseY) && coords.length > 1
      ? buildMiniChartColoredSegments(coords, prevCloseY)
      : [];
    return (
      "<svg viewBox='0 0 " + chartWidth + " " + chartHeight + "' width='100%' height='" + chartHeight + "' role='img' aria-label='Daily minute chart'>" +
      (Number.isFinite(prevCloseY) ? "<line x1='" + padding + "' y1='" + prevCloseY.toFixed(2) + "' x2='" + (chartWidth - padding).toFixed(2) + "' y2='" + prevCloseY.toFixed(2) + "' stroke='#7f8da3' stroke-width='1' stroke-dasharray='3 3' opacity='0.9' />" : "") +
      (coords.length > 1 && coloredSegments.length
        ? coloredSegments.map(function (segment) {
          return "<polyline points='" + segment.points + "' fill='none' stroke='" + segment.stroke + "' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'></polyline>";
        }).join("")
        : coords.length > 1
          ? "<polyline points='" + linePoints + "' fill='none' stroke='" + stroke + "' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'></polyline>"
          : "") +
      "<circle cx='" + coords[coords.length - 1].x.toFixed(2) + "' cy='" + coords[coords.length - 1].y.toFixed(2) + "' r='" + endpointRadius + "' fill='" + stroke + "'></circle>" +
      "</svg>"
    );
  }

  function getVisibleWindow(candles, intervalKey, zoomKey) {
    var presets = getZoomPresets(intervalKey);
    var activePreset = presets.find(function (preset) { return preset.key === zoomKey; }) || presets[presets.length - 1] || null;
    if (!Array.isArray(candles) || !candles.length || !activePreset || !activePreset.durationMs) {
      return null;
    }
    var lastCandle = candles[candles.length - 1];
    var endMs = getCandleTimeMs(lastCandle);
    var startMs = endMs - activePreset.durationMs;
    return { startMs: startMs, endMs: endMs };
  }

  function getVisibleCandles(candles, intervalKey, zoomKey) {
    var window = getVisibleWindow(candles, intervalKey, zoomKey);
    if (!window) return candles || [];
    return (candles || []).filter(function (candle) {
      var timeMs = getCandleTimeMs(candle);
      return timeMs >= window.startMs && timeMs <= window.endMs;
    });
  }

  function buildAreaSeries(sourceCandles, intervalKey, window) {
    if (!Array.isArray(sourceCandles) || !sourceCandles.length || !window) {
      return [];
    }
    var allCandles = sourceCandles
      .map(function (candle) {
        return {
          sourceCandle: candle,
          timeMs: getCandleTimeMs(candle)
        };
      })
      .sort(function (a, b) { return a.timeMs - b.timeMs; });
    var domainStartMs = alignTimeToInterval(window.startMs, intervalKey);
    var domainEndMs = allCandles[allCandles.length - 1].timeMs;
    var candleMap = new Map(allCandles.map(function (candle) { return [candle.timeMs, candle]; }));
    var lastKnownPrice = null;
    allCandles.forEach(function (candle) {
      var close = getCandleClose(candle.sourceCandle);
      if (candle.timeMs <= domainStartMs && Number.isFinite(close)) {
        lastKnownPrice = close;
      }
    });
    if (!Number.isFinite(lastKnownPrice)) {
      lastKnownPrice = getCandleClose(allCandles[0].sourceCandle);
    }
    if (isCompressedTradingInterval(intervalKey)) {
      return buildTradingSlots(domainStartMs, domainEndMs, intervalKey).map(function (slotTimeMs) {
        var candle = candleMap.get(slotTimeMs);
        var close = getCandleClose(candle && candle.sourceCandle);
        if (candle && Number.isFinite(close)) {
          lastKnownPrice = close;
        }
        return {
          time: new Date(slotTimeMs).toISOString(),
          timeMs: slotTimeMs,
          value: lastKnownPrice
        };
      }).filter(function (point) { return Number.isFinite(point.value); });
    }
    return allCandles
      .filter(function (candle) {
        return candle.timeMs >= domainStartMs && candle.timeMs <= domainEndMs && Number.isFinite(getCandleClose(candle.sourceCandle));
      })
      .map(function (candle) {
        return {
          time: getCandleTimeIso(candle.sourceCandle),
          timeMs: candle.timeMs,
          value: getCandleClose(candle.sourceCandle)
        };
      });
  }

  function buildAreaChartSvg(candles, mountWidth, intervalKey, zoomKey) {
    if (!Array.isArray(candles) || candles.length < 1) {
      return "<div class='mtw-chart-empty'>Load a quote to see the chart.</div>";
    }
    var dimensions = getResponsiveChartDimensions(mountWidth || 790, 3000, 400);
    var widthValue = dimensions.width;
    var heightValue = dimensions.height;
    var padding = 14;
    var bottomPadding = 20;
    var window = getVisibleWindow(candles, intervalKey, zoomKey);
    var areaPoints = buildAreaSeries(candles, intervalKey, window);
    var values = areaPoints.map(function (point) { return Number(point.value); }).filter(Number.isFinite);
    if (values.length < 2) {
      return "<div class='mtw-chart-empty'>Chart values are unavailable.</div>";
    }
    var stats = getChartStats(getVisibleCandles(candles, intervalKey, zoomKey));
    if (!stats) {
      return "<div class='mtw-chart-empty'>Chart values are unavailable.</div>";
    }
    var min = stats.min;
    var max = stats.max;
    var span = max - min || 1;
    var rightPadding = getRightScalePadding(stats);
    var chartRight = widthValue - rightPadding;
    var windowStartMs = window ? window.startMs : getCandleTimeMs(candles[0]);
    var windowEndMs = window ? window.endMs : getCandleTimeMs(candles[candles.length - 1]);
    var plotWidth = widthValue - padding - rightPadding;
    var compressedSlots = isCompressedTradingInterval(intervalKey) ? buildTradingSlots(windowStartMs, windowEndMs, intervalKey) : [];
    var slotIndexMap = new Map(compressedSlots.map(function (slotTimeMs, index) { return [slotTimeMs, index]; }));
    var coords = areaPoints.map(function (point) {
      var ratio = compressedSlots.length > 1
        ? (slotIndexMap.get(point.timeMs) || 0) / (compressedSlots.length - 1)
        : windowEndMs > windowStartMs
          ? (point.timeMs - windowStartMs) / (windowEndMs - windowStartMs)
          : 0;
      var x = padding + ratio * plotWidth;
      var y = heightValue - bottomPadding - ((Number(point.value) - min) / span) * (heightValue - padding - bottomPadding);
      return { x: x, y: y, value: Number(point.value), time: point.time };
    });
    var linePoints = coords.map(function (point) { return point.x.toFixed(2) + "," + point.y.toFixed(2); }).join(" ");
    var areaPolygon = [coords[0].x.toFixed(2) + "," + (heightValue - bottomPadding).toFixed(2)]
      .concat(coords.map(function (point) { return point.x.toFixed(2) + "," + point.y.toFixed(2); }))
      .concat([coords[coords.length - 1].x.toFixed(2) + "," + (heightValue - bottomPadding).toFixed(2)])
      .join(" ");
    var axisTicks = compressedSlots.length > 1
      ? buildAxisTicksFromSlots(compressedSlots, widthValue, padding, intervalKey)
      : buildAxisTicks(windowStartMs, windowEndMs, widthValue, padding, intervalKey);
    var priceLines = buildPriceScale(stats, heightValue, padding, bottomPadding, 7);
    return (
      "<svg viewBox='0 0 " + widthValue + " " + heightValue + "' width='100%' height='" + heightValue + "' role='img' aria-label='Delayed area chart'>" +
      "<defs><linearGradient id='mtwChartFill' x1='0' y1='0' x2='0' y2='1'><stop offset='0%' stop-color='#226acb' stop-opacity='0.65' /><stop offset='100%' stop-color='#ffffff' stop-opacity='0' /></linearGradient></defs>" +
      "<line x1='" + padding + "' y1='" + padding + "' x2='" + padding + "' y2='" + (heightValue - padding) + "' stroke='#dbe5f0' />" +
      priceLines.map(function (line) {
        return "<line x1='" + padding + "' y1='" + line.y.toFixed(2) + "' x2='" + chartRight + "' y2='" + line.y.toFixed(2) + "' stroke='#e3ebf5' stroke-width='1' />";
      }).join("") +
      "<polygon points='" + areaPolygon + "' fill='url(#mtwChartFill)'></polygon>" +
      "<polyline points='" + linePoints + "' fill='none' stroke='#226acb' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'></polyline>" +
      "<circle cx='" + coords[coords.length - 1].x.toFixed(2) + "' cy='" + coords[coords.length - 1].y.toFixed(2) + "' r='4' fill='#226acb'></circle>" +
      axisTicks.map(function (tick) {
        return "<line x1='" + tick.x.toFixed(2) + "' y1='" + (heightValue - bottomPadding).toFixed(2) + "' x2='" + tick.x.toFixed(2) + "' y2='" + (heightValue - bottomPadding + 6).toFixed(2) + "' stroke='#c7d5e6' /><text x='" + tick.x.toFixed(2) + "' y='" + (heightValue - 2).toFixed(2) + "' fill='#5f6f82' font-size='" + chartLabelFontSize + "' text-anchor='middle'>" + tick.label + "</text>";
      }).join("") +
      priceLines.map(function (line) {
        return "<text x='" + (chartRight + 8).toFixed(2) + "' y='" + (line.y + 4).toFixed(2) + "' fill='#5f6f82' font-size='" + chartLabelFontSize + "' text-anchor='start'>" + fmtPrice(line.value) + "</text>";
      }).join("") +
      "</svg>"
    );
  }

  function buildCandlesChartSvg(candles, mountWidth, intervalKey, zoomKey) {
    if (!Array.isArray(candles) || candles.length < 2) {
      return "<div class='mtw-chart-empty'>Not enough chart data yet.</div>";
    }
    var dimensions = getResponsiveChartDimensions(mountWidth || 790, 3000, 400);
    var widthValue = dimensions.width;
    var heightValue = dimensions.height;
    var padding = 14;
    var bottomPadding = 20;
    var visibleCandles = getVisibleCandles(candles, intervalKey, zoomKey);
    var stats = getChartStats(visibleCandles);
    if (!stats) {
      return "<div class='mtw-chart-empty'>Chart values are unavailable.</div>";
    }
    var span = stats.max - stats.min || 1;
    var rightPadding = getRightScalePadding(stats);
    var chartRight = widthValue - rightPadding;
    var window = getVisibleWindow(candles, intervalKey, zoomKey);
    var windowStartMs = window ? window.startMs : getCandleTimeMs(visibleCandles[0]);
    var windowEndMs = window ? window.endMs : getCandleTimeMs(visibleCandles[visibleCandles.length - 1]);
    var plotWidth = widthValue - padding - rightPadding;
    var stepMs = getIntervalStepMs(intervalKey);
    var compressedSlots = isCompressedTradingInterval(intervalKey) ? buildTradingSlots(windowStartMs, windowEndMs, intervalKey) : [];
    var slotIndexMap = new Map(compressedSlots.map(function (slotTimeMs, index) { return [slotTimeMs, index]; }));
    var plottedCandles = visibleCandles.filter(function (candle) {
      var candleTimeMs = getCandleTimeMs(candle);
      if (!Number.isFinite(candleTimeMs) || candleTimeMs < windowStartMs || candleTimeMs > windowEndMs) {
        return false;
      }
      if (compressedSlots.length > 1) {
        return slotIndexMap.has(candleTimeMs);
      }
      return true;
    });
    if (plottedCandles.length < 2) {
      return "<div class='mtw-chart-empty'>Not enough chart data yet.</div>";
    }
    var estimatedBars = compressedSlots.length || (stepMs ? Math.max(Math.round((windowEndMs - windowStartMs) / stepMs) + 1, plottedCandles.length, 1) : Math.max(plottedCandles.length, 1));
    var minCandleWidth = intervalKey === "month" ? 2 : 4;
    var candleWidth = Math.max(Math.min((plotWidth / estimatedBars) * 0.65, 10), minCandleWidth);
    function toY(value) {
      return heightValue - bottomPadding - ((value - stats.min) / span) * (heightValue - padding - bottomPadding);
    }
    var parts = plottedCandles.map(function (candle) {
      var candleTimeMs = getCandleTimeMs(candle);
      var slotIndex = compressedSlots.length > 1 ? slotIndexMap.get(candleTimeMs) : null;
      var ratio = compressedSlots.length > 1
        ? slotIndex / (compressedSlots.length - 1)
        : windowEndMs > windowStartMs
          ? (candleTimeMs - windowStartMs) / (windowEndMs - windowStartMs)
          : 0;
      var centerX = padding + ratio * plotWidth;
      var openValue = getCandleOpen(candle);
      var closeValue = getCandleClose(candle);
      var highValue = getCandleHigh(candle);
      var lowValue = getCandleLow(candle);
      var openY = toY(openValue);
      var closeY = toY(closeValue);
      var highY = toY(highValue);
      var lowY = toY(lowValue);
      var isUp = closeValue >= openValue;
      var color = isUp ? "#118a44" : "#b42318";
      var bodyTop = Math.min(openY, closeY);
      var bodyHeight = Math.max(Math.abs(closeY - openY), 1.5);
      return (
        "<line x1='" + centerX.toFixed(2) + "' y1='" + highY.toFixed(2) + "' x2='" + centerX.toFixed(2) + "' y2='" + lowY.toFixed(2) + "' stroke='" + color + "' stroke-width='1.4' />" +
        "<rect x='" + (centerX - candleWidth / 2).toFixed(2) + "' y='" + bodyTop.toFixed(2) + "' width='" + candleWidth.toFixed(2) + "' height='" + bodyHeight.toFixed(2) + "' fill='" + color + "' stroke='" + color + "' stroke-width='1.2' />"
      );
    }).join("");
    var axisTicks = compressedSlots.length > 1
      ? buildAxisTicksFromSlots(compressedSlots, widthValue, padding, intervalKey)
      : buildAxisTicks(windowStartMs, windowEndMs, widthValue, padding, intervalKey);
    var priceLines = buildPriceScale(stats, heightValue, padding, bottomPadding, 7);
    return (
      "<svg viewBox='0 0 " + widthValue + " " + heightValue + "' width='100%' height='" + heightValue + "' role='img' aria-label='Delayed candle chart'>" +
      "<line x1='" + padding + "' y1='" + padding + "' x2='" + padding + "' y2='" + (heightValue - padding) + "' stroke='#dbe5f0' />" +
      priceLines.map(function (line) {
        return "<line x1='" + padding + "' y1='" + line.y.toFixed(2) + "' x2='" + chartRight + "' y2='" + line.y.toFixed(2) + "' stroke='#e3ebf5' stroke-width='1' />";
      }).join("") +
      parts +
      axisTicks.map(function (tick) {
        return "<line x1='" + tick.x.toFixed(2) + "' y1='" + (heightValue - bottomPadding).toFixed(2) + "' x2='" + tick.x.toFixed(2) + "' y2='" + (heightValue - bottomPadding + 6).toFixed(2) + "' stroke='#c7d5e6' /><text x='" + tick.x.toFixed(2) + "' y='" + (heightValue - 2).toFixed(2) + "' fill='#5f6f82' font-size='" + chartLabelFontSize + "' text-anchor='middle'>" + tick.label + "</text>";
      }).join("") +
      priceLines.map(function (line) {
        return "<text x='" + (chartRight + 8).toFixed(2) + "' y='" + (line.y + 4).toFixed(2) + "' fill='#5f6f82' font-size='" + chartLabelFontSize + "' text-anchor='start'>" + fmtPrice(line.value) + "</text>";
      }).join("") +
      "</svg>"
    );
  }

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      return readJsonResponse(res).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed.");
        return data;
      });
    });
  }

  function fetchMiniChart(symbolValue) {
    return fetchJson(apiBase + "/api/chart-mini/" + encodeURIComponent(symbolValue));
  }

  function fetchMiniChartsBatch(symbolValues) {
    var uniqueSymbols = Array.from(new Set((symbolValues || []).filter(Boolean)));
    if (!uniqueSymbols.length) {
      return Promise.resolve({ results: [] });
    }
    return fetchJson(apiBase + "/api/chart-mini?symbols=" + encodeURIComponent(uniqueSymbols.join(",")));
  }

  function normalizeWidgetSymbol(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function fetchQuotesBatch(symbolValues) {
    var uniqueSymbols = Array.from(new Set((symbolValues || []).filter(Boolean)));
    if (!uniqueSymbols.length) {
      return Promise.resolve({ results: [] });
    }
    return fetchJson(apiBase + "/api/quotes?symbols=" + encodeURIComponent(uniqueSymbols.join(",")));
  }

  var MINI_CHART_REFRESH_MS = 60000;

  function createTickerWidget() {
    mount.innerHTML = "" +
      "<div class='mtw-root mtw-ticker-widget'>" +
        "<div class='mtw-shell mtw-quote-shell'>" +
          "<a class='mtw-logo-badge' href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer' aria-label='Marketech Focus'>" +
            "<span class='mtw-logo-badge-label'>Get live data & serious tools on Marketech</span>" +
            "<span class='mtw-logo-badge-icon'><img src='" + apiBase + "/marketech_focus_logo.png' alt='' /></span>" +
          "</a>" +
          "<div class='mtw-ticker-line'><h3 class='mtw-ticker'></h3></div>" +
          "<h4 class='mtw-company'></h4>" +
          "<div class='mtw-quote-top'><div class='mtw-quote-main'><div class='mtw-quote-metrics'><h1 class='mtw-price'>-</h1><h2 class='mtw-metric mtw-change'></h2><h2 class='mtw-metric mtw-change-pct'></h2></div></div><div class='mtw-mini-chart-wrap'><div class='mtw-mini-chart-placeholder'></div></div></div>" +
        "</div>" +
        "<div class='mtw-branding-quote'>(20 min delay) Get live data on <a href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer'>Marketech</a></div>" +
      "</div>";
    var root = mount.firstElementChild;
    var tickerEl = root.querySelector(".mtw-ticker");
    var companyEl = root.querySelector(".mtw-company");
    var priceEl = root.querySelector(".mtw-price");
    var changeEl = root.querySelector(".mtw-change");
    var changePctEl = root.querySelector(".mtw-change-pct");
    var miniChartWrapEl = root.querySelector(".mtw-mini-chart-wrap");
    if (width) {
      root.style.maxWidth = normalizeSize(width, "350px");
    }
    var previousPrice = null;
    var cachedMiniSeries = null;
    var lastMiniChartRefreshAt = 0;
    return {
      load: function () {
        var now = Date.now();
        var shouldRefreshMiniChart = !lastMiniChartRefreshAt || now - lastMiniChartRefreshAt >= MINI_CHART_REFRESH_MS;
        var quoteRequest = fetchJson(apiBase + "/api/quote/" + encodeURIComponent(symbol));
        var miniChartRequest = shouldRefreshMiniChart
          ? fetchMiniChart(symbol).catch(function () { return null; })
          : Promise.resolve(null);
        return Promise.all([quoteRequest, miniChartRequest]).then(function (results) {
          var quote = results[0];
          var chartData = results[1];
          var nextPrice = Number(quote.price);
          var isFlat = Number(quote.change) === 0;
          var cls = Number(quote.change) >= 0 ? "mtw-up" : "mtw-down";
          tickerEl.textContent = quote.ticker;
          companyEl.className = "mtw-company";
          companyEl.textContent = quote.companyName || "";
          priceEl.textContent = fmtPrice(quote.price);
          changeEl.className = "mtw-metric mtw-change " + (isFlat ? "mtw-muted" : cls);
          changePctEl.className = "mtw-metric mtw-change-pct " + (isFlat ? "mtw-muted" : cls);
          changeEl.textContent = Number(quote.change) === 0 ? "0.00" : fmtSigned(quote.change);
          changePctEl.textContent = Number(quote.changePercent) === 0 ? "(0.00%)" : "(" + fmtSigned(quote.changePercent) + "%)";
          applyPriceFlash(priceEl, "ticker:" + (quote.ticker || symbol), previousPrice, nextPrice);
          if (chartData && Array.isArray(chartData.series)) {
            cachedMiniSeries = chartData.series.slice();
            lastMiniChartRefreshAt = now;
          }
          if (Array.isArray(cachedMiniSeries) && cachedMiniSeries.length) {
            var currentPrice = Number(quote.price);
            var currentChange = Number(quote.change);
            var previousClose = Number.isFinite(currentPrice) && Number.isFinite(currentChange) ? currentPrice - currentChange : null;
            var svgMarkup = buildMiniChartSvgMarkup(cachedMiniSeries, previousClose, { width: 114, height: 52, padding: 4, endpointRadius: 2.8 });
            miniChartWrapEl.innerHTML = svgMarkup || "<div class='mtw-mini-chart-placeholder'>No day chart</div>";
          }
          previousPrice = nextPrice;
        }).catch(function (error) {
          companyEl.className = "mtw-company mtw-down";
          companyEl.textContent = (error && error.message) || "Too many requests.";
          if (!Array.isArray(cachedMiniSeries) || !cachedMiniSeries.length) {
            miniChartWrapEl.innerHTML = "<div class='mtw-mini-chart-placeholder'>Too many requests.</div>";
          }
        });
      }
    };
  }

  function createWatchlistWidget() {
    mount.innerHTML = "" +
      "<div class='mtw-root mtw-watchlist-widget'>" +
        "<div class='mtw-shell mtw-watchlist-shell'>" +
          "<a class='mtw-logo-badge' href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer' aria-label='Marketech Focus'>" +
            "<span class='mtw-logo-badge-label'>Get live data & serious tools on Marketech</span>" +
            "<span class='mtw-logo-badge-icon'><img src='" + apiBase + "/marketech_focus_logo.png' alt='' /></span>" +
          "</a>" +
          "<table class='mtw-watchlist-table'><colgroup><col class='mtw-watchlist-col-code' /><col class='mtw-watchlist-col-name' /><col class='mtw-watchlist-col-daily' /><col class='mtw-watchlist-col-last' /><col class='mtw-watchlist-col-chg' /><col class='mtw-watchlist-col-chg-pct' /></colgroup><thead><tr><th class='mtw-watchlist-cell'>Code</th><th class='mtw-watchlist-cell'>Name</th><th class='mtw-watchlist-cell'>Daily</th><th class='mtw-watchlist-cell'>Last</th><th class='mtw-watchlist-cell'>Chg</th><th class='mtw-watchlist-cell'>Chg %</th></tr></thead><tbody><tr><td class='mtw-watchlist-status' colspan='6'>Loading watchlist...</td></tr></tbody></table>" +
        "</div>" +
        "<div class='mtw-branding'>(20 min delay) Get live data on <a href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer'>Marketech</a></div>" +
      "</div>";
    var root = mount.firstElementChild;
    var bodyEl = root.querySelector("tbody");
    if (width) {
      root.style.width = normalizeSize(width, "100%");
      root.style.maxWidth = "none";
    }
    var previousPricesBySymbol = new Map();
    var cachedMiniSeriesBySymbol = new Map();
    var lastMiniChartRefreshAt = 0;
    return {
      load: function () {
        var now = Date.now();
        var shouldRefreshMiniCharts = !lastMiniChartRefreshAt || now - lastMiniChartRefreshAt >= MINI_CHART_REFRESH_MS;
        var quotesRequest = fetchQuotesBatch(symbols);
        var miniChartsRequest = shouldRefreshMiniCharts
          ? fetchMiniChartsBatch(symbols)
          : Promise.resolve([]);
        return Promise.all([quotesRequest, miniChartsRequest]).then(function (results) {
          var quoteResults = results[0] && Array.isArray(results[0].results) ? results[0].results : [];
          var miniChartResults = results[1] && Array.isArray(results[1].results) ? results[1].results : [];
          var quotesBySymbol = new Map();
          quoteResults.forEach(function (quote) {
            var ticker = normalizeWidgetSymbol(quote && quote.ticker);
            if (ticker) {
              quotesBySymbol.set(ticker, quote);
            }
          });
          miniChartResults.forEach(function (entry) {
            if (entry && entry.chart && Array.isArray(entry.chart.series)) {
              cachedMiniSeriesBySymbol.set(entry.symbol, entry.chart.series.slice());
            }
          });
          var rows = symbols.map(function (tickerSymbol) {
            return {
              symbol: tickerSymbol,
              quote: quotesBySymbol.get(tickerSymbol) || null,
              miniSeries: cachedMiniSeriesBySymbol.get(tickerSymbol) || []
            };
          });
          if (shouldRefreshMiniCharts) {
            lastMiniChartRefreshAt = now;
          }
          bodyEl.innerHTML = rows.map(function (row) {
            if (!row.quote) {
              return "<tr><td class='mtw-watchlist-cell mtw-watchlist-code'>" + row.symbol + "</td><td class='mtw-watchlist-cell mtw-watchlist-name'>Unavailable</td><td class='mtw-watchlist-cell mtw-watchlist-chart'>-</td><td class='mtw-watchlist-cell mtw-watchlist-last'>-</td><td class='mtw-watchlist-cell'>-</td><td class='mtw-watchlist-cell'>-</td></tr>";
            }
            var chg = Number(row.quote.change);
            var chgPct = Number(row.quote.changePercent);
            var isFlat = chg === 0;
            var changeClass = isFlat ? "mtw-muted" : chg >= 0 ? "mtw-up" : "mtw-down";
            var currentPrice = Number(row.quote.price);
            var currentChange = Number(row.quote.change);
            var previousClose = Number.isFinite(currentPrice) && Number.isFinite(currentChange) ? currentPrice - currentChange : null;
            var chartSvg = buildMiniChartSvgMarkup(row.miniSeries, previousClose, { width: 72, height: 22, padding: 2, endpointRadius: 1.8 }) || "-";
            var symbolKey = row.quote.ticker || row.symbol;
            return "<tr data-symbol='" + symbolKey + "'>" +
              "<td class='mtw-watchlist-cell mtw-watchlist-code'>" + row.quote.ticker + "</td>" +
              "<td class='mtw-watchlist-cell mtw-watchlist-name " + changeClass + "' title='" + (row.quote.companyName || "") + "'>" + (row.quote.companyName || "") + "</td>" +
              "<td class='mtw-watchlist-cell mtw-watchlist-chart'><div class='mtw-watchlist-mini-chart'>" + chartSvg + "</div></td>" +
              "<td class='mtw-watchlist-cell mtw-watchlist-last'>" + fmtPrice(row.quote.price) + "</td>" +
              "<td class='mtw-watchlist-cell " + changeClass + "'>" + (isFlat ? "0.00" : fmtSigned(chg)) + "</td>" +
              "<td class='mtw-watchlist-cell " + changeClass + "'>" + (isFlat ? "0.00%" : fmtSigned(chgPct) + "%") + "</td>" +
            "</tr>";
          }).join("");
          rows.forEach(function (row) {
            if (!row.quote || !row.quote.ticker) {
              return;
            }
            var symbolKey = row.quote.ticker;
            var nextPrice = Number(row.quote.price);
            var previousPrice = previousPricesBySymbol.get(symbolKey);
            var rowEl = bodyEl.querySelector("tr[data-symbol='" + symbolKey + "']");
            var priceCellEl = rowEl && rowEl.querySelector(".mtw-watchlist-last");
            applyPriceFlash(priceCellEl, "watchlist:" + symbolKey, previousPrice, nextPrice);
            if (Number.isFinite(nextPrice)) {
              previousPricesBySymbol.set(symbolKey, nextPrice);
            }
          });
        }).catch(function (error) {
          bodyEl.innerHTML = "<tr><td class='mtw-watchlist-status mtw-down' colspan='6'>" + ((error && error.message) || "Too many requests.") + "</td></tr>";
        });
      }
    };
  }

  function createChartWidget() {
    mount.innerHTML = "" +
      "<div class='mtw-root mtw-chart-widget'>" +
        "<div class='mtw-shell mtw-chart-panel'>" +
          "<a class='mtw-logo-badge' href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer' aria-label='Marketech Focus'>" +
            "<span class='mtw-logo-badge-label'>Get live data & serious tools on Marketech</span>" +
            "<span class='mtw-logo-badge-icon'><img src='" + apiBase + "/marketech_focus_logo.png' alt='' /></span>" +
          "</a>" +
          "<div class='mtw-chart-top'>" +
            "<div class='mtw-chart-quote-header'>" +
              "<div class='mtw-ticker-line'><h3 class='mtw-ticker'></h3></div>" +
              "<h4 class='mtw-company'></h4>" +
              "<div class='mtw-chart-quote-metrics'><h1 class='mtw-price'>-</h1><h2 class='mtw-metric mtw-change'></h2><h2 class='mtw-metric mtw-change-pct'></h2></div>" +
            "</div>" +
            "<div class='mtw-chart-controls'><div class='mtw-control-group'><button type='button' class='mtw-chart-btn active'>Area</button><button type='button' class='mtw-chart-btn'>Candles</button></div><div class='mtw-control-group'><button type='button' class='mtw-chart-btn'>Minute</button><button type='button' class='mtw-chart-btn'>Hour</button><button type='button' class='mtw-chart-btn active'>Day</button><button type='button' class='mtw-chart-btn'>Month</button></div></div>" +
          "</div>" +
          "<div class='mtw-chart-wrap'><div class='mtw-chart-canvas'><div class='mtw-chart-empty'>Load a quote to see the chart.</div></div></div>" +
          "<div class='mtw-chart-bottom'><div class='mtw-chart-zoom'></div><div class='mtw-chart-range'></div></div>" +
          "<div class='mtw-chart-status'></div>" +
        "</div>" +
        "<div class='mtw-branding'>(20 min delay) Get live data on <a href='https://marketech.com.au/focus' target='_blank' rel='noopener noreferrer'>Marketech</a></div>" +
      "</div>";
    var root = mount.firstElementChild;
    var tickerEl = root.querySelector(".mtw-ticker");
    var companyEl = root.querySelector(".mtw-company");
    var priceEl = root.querySelector(".mtw-price");
    var changeEl = root.querySelector(".mtw-change");
    var changePctEl = root.querySelector(".mtw-change-pct");
    var canvasEl = root.querySelector(".mtw-chart-canvas");
    var zoomEl = root.querySelector(".mtw-chart-zoom");
    var rangeEl = root.querySelector(".mtw-chart-range");
    var statusEl = root.querySelector(".mtw-chart-status");
    var controlGroups = root.querySelectorAll(".mtw-control-group");
    var modeButtons = Array.from(controlGroups[0].querySelectorAll(".mtw-chart-btn"));
    var intervalButtons = Array.from(controlGroups[1].querySelectorAll(".mtw-chart-btn"));
    var chartIntervals = ["minute", "hour", "day", "month"];
    var currentMode = "area";
    var currentInterval = ["minute", "hour", "day", "month"].indexOf(interval) >= 0 ? interval : "day";
    var currentZoomKey = getZoomPresets(currentInterval).slice(-1)[0].key;
    var chartDataByInterval = {};
    var previousPrice = null;
    if (width) {
      root.style.width = normalizeSize(width, "100%");
      root.style.maxWidth = "none";
    }
    modeButtons[0].dataset.mode = "area";
    modeButtons[1].dataset.mode = "candles";
    intervalButtons[0].dataset.interval = "minute";
    intervalButtons[1].dataset.interval = "hour";
    intervalButtons[2].dataset.interval = "day";
    intervalButtons[3].dataset.interval = "month";

    function getCurrentChartData() {
      return chartDataByInterval[currentInterval] || null;
    }

    function setActiveButtons() {
      modeButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.mode === currentMode);
      });
      intervalButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.interval === currentInterval);
      });
    }

    function getIntervalLabel(data) {
      var label = (data && data.label) || currentInterval;
      var maxRange = (data && data.maxRangeLabel) || "MAX";
      var points = getVisibleCandles(data && data.candles, currentInterval, currentZoomKey).length;
      return label + " interval · max " + maxRange + " · " + points + " candles";
    }

    function renderZoomButtons() {
      var presets = getZoomPresets(currentInterval);
      var activeKey = currentZoomKey || presets[presets.length - 1].key;
      zoomEl.innerHTML = presets.map(function (preset) {
        return "<button type='button' class='mtw-chart-btn" + (preset.key === activeKey ? " active" : "") + "' data-zoom='" + preset.key + "'>" + preset.label + "</button>";
      }).join("");
      Array.from(zoomEl.querySelectorAll("[data-zoom]")).forEach(function (button) {
        button.addEventListener("click", function () {
          currentZoomKey = button.dataset.zoom;
          renderZoomButtons();
          var currentChartData = getCurrentChartData();
          if (currentChartData) {
            rangeEl.textContent = getIntervalLabel(currentChartData);
            renderCurrentChart();
          }
        });
      });
    }

    function renderCurrentChart() {
      var widthValue = root.clientWidth || 790;
      var currentChartData = getCurrentChartData();
      var candles = currentChartData && Array.isArray(currentChartData.candles) ? currentChartData.candles : [];
      canvasEl.innerHTML = currentMode === "candles"
        ? buildCandlesChartSvg(candles, widthValue, currentInterval, currentZoomKey)
        : buildAreaChartSvg(candles, widthValue, currentInterval, currentZoomKey);
    }

    function render() {
      return Promise.all([
        fetchJson(apiBase + "/api/quote/" + encodeURIComponent(symbol)),
        Promise.allSettled(chartIntervals.map(function (intervalKey) {
          return fetchJson(apiBase + "/api/chart/" + encodeURIComponent(symbol) + "?interval=" + encodeURIComponent(intervalKey))
            .then(function (chart) {
              return {
                intervalKey: intervalKey,
                chart: chart
              };
            });
        }))
      ]).then(function (results) {
        var quote = results[0];
        var chartResults = results[1];
        var isFlat = Number(quote.change) === 0;
        var cls = Number(quote.change) >= 0 ? "mtw-up" : "mtw-down";
        tickerEl.textContent = quote.ticker;
        companyEl.textContent = quote.companyName || "";
        priceEl.textContent = fmtPrice(quote.price);
        changeEl.className = "mtw-metric mtw-change " + (isFlat ? "mtw-muted" : cls);
        changePctEl.className = "mtw-metric mtw-change-pct " + (isFlat ? "mtw-muted" : cls);
        changeEl.textContent = Number(quote.change) === 0 ? "0.00" : fmtSigned(quote.change);
        changePctEl.textContent = Number(quote.changePercent) === 0 ? "(0.00%)" : "(" + fmtSigned(quote.changePercent) + "%)";
        applyPriceFlash(priceEl, "chart:" + (quote.ticker || symbol), previousPrice, Number(quote.price));
        previousPrice = Number(quote.price);
        var failedIntervals = [];
        chartResults.forEach(function (result, index) {
          if (result.status === "fulfilled" && result.value && result.value.chart) {
            chartDataByInterval[result.value.intervalKey] = result.value.chart;
          } else {
            failedIntervals.push(chartIntervals[index]);
          }
        });
        var currentChartData = getCurrentChartData();
        if (!getZoomPresets(currentInterval).some(function (preset) { return preset.key === currentZoomKey; })) {
          currentZoomKey = getZoomPresets(currentInterval).slice(-1)[0].key;
        }
        renderZoomButtons();
        if (currentChartData) {
          rangeEl.textContent = getIntervalLabel(currentChartData);
          renderCurrentChart();
        } else {
          canvasEl.innerHTML = "<div class='mtw-chart-empty'>Chart unavailable.</div>";
          rangeEl.textContent = "";
        }
        statusEl.textContent = failedIntervals.length ? ("Some chart intervals could not refresh: " + failedIntervals.join(", ")) : "";
      }).catch(function (error) {
        statusEl.textContent = (error && error.message) || "Chart unavailable.";
      });
    }
    var resizeObserver = new ResizeObserver(function () {
      if (getCurrentChartData()) {
        renderCurrentChart();
      }
    });
    resizeObserver.observe(root);
    modeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        currentMode = button.dataset.mode || "area";
        setActiveButtons();
        if (getCurrentChartData()) {
          renderCurrentChart();
        }
      });
    });
    intervalButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        currentInterval = button.dataset.interval || "day";
        currentZoomKey = getZoomPresets(currentInterval).slice(-1)[0].key;
        setActiveButtons();
        renderZoomButtons();
        var currentChartData = getCurrentChartData();
        if (currentChartData) {
          rangeEl.textContent = getIntervalLabel(currentChartData);
          renderCurrentChart();
          statusEl.textContent = "";
        } else {
          canvasEl.innerHTML = "<div class='mtw-chart-empty'>Chart unavailable.</div>";
          rangeEl.textContent = "";
          statusEl.textContent = "Chart unavailable for " + currentInterval + ".";
        }
      });
    });
    setActiveButtons();
    renderZoomButtons();
    return { load: render };
  }

  ensureStyles();
  mount.innerHTML = "";
  mount.style.width = normalizeSize(width, widgetType === "ticker" ? "350px" : "100%");
  mount.style.maxWidth = widgetType === "ticker" ? normalizeSize(width, "350px") : "none";
  var refreshMs = widgetType === "chart"
    ? 60000
    : widgetType === "watchlist"
      ? 30000
      : 15000;

  var widget = widgetType === "watchlist"
    ? createWatchlistWidget()
    : widgetType === "chart"
      ? createChartWidget()
      : createTickerWidget();
  var lastLoadAt = 0;
  var isPageVisible = typeof document.visibilityState !== "string" ? true : document.visibilityState === "visible";
  var isWidgetVisible = typeof IntersectionObserver === "undefined" ? true : false;

  function canPollNow() {
    return isPageVisible && isWidgetVisible;
  }

  function runLoad() {
    lastLoadAt = Date.now();
    Promise.resolve(widget.load()).catch(function () {});
  }

  if (typeof document.addEventListener === "function" && typeof document.visibilityState === "string") {
    document.addEventListener("visibilitychange", function () {
      isPageVisible = document.visibilityState === "visible";
    });
  }

  if (typeof IntersectionObserver !== "undefined") {
    var visibilityObserver = new IntersectionObserver(function (entries) {
      var entry = entries && entries[0];
      isWidgetVisible = Boolean(entry && entry.isIntersecting);
    }, {
      threshold: 0.05
    });
    visibilityObserver.observe(mount);
  }

  runLoad();
  setInterval(function () {
    if (!canPollNow()) {
      return;
    }
    if (!isSydneyMarketPollingWindow()) {
      return;
    }
    runLoad();
  }, refreshMs);
})();
