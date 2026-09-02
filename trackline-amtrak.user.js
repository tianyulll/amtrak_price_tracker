// ==UserScript==
// @name         Trackline — Amtrak Fare Watch
// @namespace    https://github.com/tianyulll/amtrak_price_tracker
// @version      0.5.3
// @description  Scan all Amtrak result pages and notify when fares meet your target price.
// @homepageURL  https://github.com/tianyulll/amtrak_price_tracker
// @supportURL   https://github.com/tianyulll/amtrak_price_tracker/issues
// @downloadURL  https://raw.githubusercontent.com/tianyulll/amtrak_price_tracker/main/trackline-amtrak.user.js
// @updateURL    https://raw.githubusercontent.com/tianyulll/amtrak_price_tracker/main/trackline-amtrak.user.js
// @match        https://www.amtrak.com/tickets/departure.html*
// @match        https://www.amtrak.com/*/tickets/departure.html*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function tracklineUserscript(global) {
  "use strict";

  const CARD_SELECTOR = '[amt-auto-test-id^="autoId-one-way-journey-solution-"]';
  const SCRIPT_VERSION = "0.5.3";
  const FARE_CLASSES = ["Coach", "Business", "First", "Private Rooms"];
  const STORAGE_KEY = "trackline-amtrak-v1";
  const TAB_STORAGE_KEY = "trackline-amtrak-tab-v1";
  const DEFAULT_INTERVAL_MINUTES = 15;
  const MIN_INTERVAL_MINUTES = 1;
  const MAX_INTERVAL_MINUTES = 24 * 60;
  const RESULTS_TIMEOUT_MS = 75_000;
  const PAGE_CHANGE_TIMEOUT_MS = 30_000;
  const MAX_CONTEXTS = 12;

  function normalizedLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function timeAfter(lines, marker) {
    const start = lines.indexOf(marker);
    if (start < 0) return null;

    for (let index = start + 1; index < Math.min(start + 5, lines.length); index += 1) {
      const sameLine = lines[index].match(/^(\d{1,2}:\d{2})\s*([ap])(?:\.?m\.?)?$/i);
      if (sameLine) return `${sameLine[1]} ${sameLine[2].toUpperCase()}M`;

      if (/^\d{1,2}:\d{2}$/.test(lines[index]) && index + 1 < lines.length) {
        const meridiem = lines[index + 1].toLowerCase().replace(/\./g, "");
        if (["a", "p", "am", "pm"].includes(meridiem)) {
          return `${lines[index]} ${meridiem[0].toUpperCase()}M`;
        }
      }
    }
    return null;
  }

  function firstPrice(lines) {
    for (const line of lines) {
      const match = line.match(/^\$?\s*([\d,]+(?:\.\d{1,2})?)$/);
      if (match) return Number(match[1].replace(/,/g, ""));
    }
    return null;
  }

  function parseCardText(text) {
    const lines = normalizedLines(text);
    const departsIndex = lines.indexOf("DEPARTS");
    const arrivesIndex = lines.indexOf("ARRIVES");
    if (departsIndex < 0 || arrivesIndex < 0) return [];

    const header = lines
      .slice(0, departsIndex)
      .filter((line) => !["Lowest Fare", "Premium"].includes(line));
    const route = header[0] || "Amtrak";
    const trainIndex = header.findIndex(
      (line, index) => index > 0 && /^[A-Za-z]?\d+[A-Za-z]?$/.test(line),
    );
    if (trainIndex < 0) return [];

    const trainNumber = header[trainIndex];
    const routeName = header[trainIndex + 1] || "Amtrak";
    const departureTime = timeAfter(lines, "DEPARTS");
    const arrivalTime = timeAfter(lines, "ARRIVES");
    if (!departureTime) return [];

    const tripDetailsIndex = lines.indexOf("Trip Details");
    const tail = lines.slice(tripDetailsIndex >= 0 ? tripDetailsIndex + 1 : arrivesIndex + 1);
    const fares = [];

    for (let index = 0; index < tail.length; index += 1) {
      const fareClass = tail[index];
      if (!FARE_CLASSES.includes(fareClass)) continue;

      let nextClassIndex = tail.length;
      for (let cursor = index + 1; cursor < tail.length; cursor += 1) {
        if (FARE_CLASSES.includes(tail[cursor])) {
          nextClassIndex = cursor;
          break;
        }
      }
      const window = tail.slice(index + 1, nextClassIndex);
      if (window.includes("Not Offered")) continue;
      const price = firstPrice(window);
      if (!Number.isFinite(price)) continue;

      fares.push({
        route,
        trainNumber,
        routeName,
        departureTime,
        arrivalTime,
        fareClass,
        price,
        key: [route, trainNumber, departureTime, fareClass].join("|"),
      });
    }
    return fares;
  }

  function canonicalDate(raw) {
    if (!raw) return null;
    const value = String(raw).trim();
    const numeric = value.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
    if (numeric) {
      return `${numeric[3]}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
    }

    const named = value.match(
      /\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[,\s]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/i,
    );
    if (!named) return null;
    const parsed = new Date(named[0]);
    if (Number.isNaN(parsed.getTime())) return null;
    return [
      parsed.getFullYear(),
      String(parsed.getMonth() + 1).padStart(2, "0"),
      String(parsed.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function detectedTravelDate(doc, urlString) {
    const url = new URL(urlString);
    for (const [name, value] of url.searchParams.entries()) {
      if (/date|depart/i.test(name)) {
        const parsed = canonicalDate(value);
        if (parsed) return parsed;
      }
    }

    const selectors = [
      'input[aria-label="Depart Date"]',
      'input[name*="depart" i][name*="date" i]',
      '[amt-auto-test-id*="depart-date" i]',
      "main h1",
      "main h2",
      "main h3",
    ];
    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        const parsed = canonicalDate(element.value || element.textContent);
        if (parsed) return parsed;
      }
    }

    // Limit the fallback to likely result-header text instead of scanning every card.
    const mainText = [...doc.querySelectorAll("main header, main [class*=trip], main [class*=search]")]
      .slice(0, 30)
      .map((element) => element.textContent)
      .join(" ");
    return canonicalDate(mainText);
  }

  function contextFor(fares, doc, urlString) {
    const routes = [...new Set(fares.map((fare) => fare.route))].sort();
    const route = routes.join(", ") || "Unknown route";
    const travelDate = detectedTravelDate(doc, urlString);
    // Date normally distinguishes searches. The full URL helps when Amtrak exposes
    // additional search state in the query/hash. If no date is visible, the script
    // clearly warns the user to reset before monitoring a different trip date.
    const url = new URL(urlString);
    const urlState = `${url.search}|${url.hash}`;
    const key = [route, travelDate || "date-unknown", urlState].join("|");
    return { key, route, travelDate, label: `${route}${travelDate ? ` · ${travelDate}` : ""}` };
  }

  function clockMinutes(value) {
    if (!value) return null;
    const twelveHour = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i);
    if (twelveHour) {
      let hour = Number(twelveHour[1]) % 12;
      if (twelveHour[3].toLowerCase() === "p") hour += 12;
      return hour * 60 + Number(twelveHour[2]);
    }
    const twentyFourHour = String(value).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    return twentyFourHour
      ? Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2])
      : null;
  }

  function windowHourValue(value) {
    if (value === null || value === undefined || String(value).trim() === "") return "";
    const raw = String(value).trim();
    if (/^\d{1,2}$/.test(raw)) {
      const hour = Number(raw);
      return hour >= 0 && hour <= 23 ? String(hour) : "";
    }
    const legacy = raw.match(/^([01]?\d|2[0-3]):[0-5]\d$/);
    return legacy ? String(Number(legacy[1])) : "";
  }

  function windowMinuteValue(value) {
    const raw = String(value ?? "").trim();
    const fullTime = raw.match(/^(?:[01]?\d|2[0-3]):([0-5]\d)$/);
    if (fullTime) return fullTime[1];
    if (/^\d{1,2}$/.test(raw)) {
      const minute = Number(raw);
      if (minute >= 0 && minute <= 59) return String(minute).padStart(2, "0");
    }
    return "00";
  }

  function windowBoundaryMinutes(value, isEnd = false) {
    const precise = clockMinutes(value);
    if (precise !== null) return precise;
    const hour = windowHourValue(value);
    if (hour !== "") return Number(hour) * 60 + (isEnd ? 59 : 0);
    return null;
  }

  function formatTime24(value) {
    const minutes = clockMinutes(value);
    if (minutes === null) return String(value || "");
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function filterFaresByWindow(fares, startValue, endValue) {
    const start = windowBoundaryMinutes(startValue, false);
    const end = windowBoundaryMinutes(endValue, true);
    if (start === null && end === null) return [...fares];

    return fares.filter((fare) => {
      const departure = clockMinutes(fare.departureTime);
      if (departure === null) return false;
      if (start !== null && end === null) return departure >= start;
      if (start === null && end !== null) return departure <= end;
      if (start < end) return departure >= start && departure <= end;
      // A window such as 22:30–02:15 crosses midnight.
      return departure >= start || departure <= end;
    });
  }

  function filterFaresForManualScan(fares, startValue, endValue, threshold) {
    const matchingWindow = filterFaresByWindow(fares, startValue, endValue);
    return Number.isFinite(threshold)
      ? matchingWindow.filter((fare) => fare.price <= threshold)
      : matchingWindow;
  }

  function minimumFarePrice(fares) {
    const prices = fares.map((fare) => fare.price).filter(Number.isFinite);
    return prices.length ? Math.min(...prices) : null;
  }

  function evaluateThresholds(previousStates, fares, threshold) {
    if (!Number.isFinite(threshold)) return { nextStates: {}, hits: [] };
    const nextStates = {};
    const hits = [];
    for (const fare of fares) {
      const previous = previousStates?.[fare.key];
      const below = fare.price <= threshold;
      if (below && (!previous || previous.threshold !== threshold || !previous.below)) {
        hits.push({ ...fare, threshold });
      }
      nextStates[fare.key] = { threshold, below };
    }
    return { nextStates, hits };
  }

  function pageCountFromText(text) {
    const match = String(text || "").match(/Showing\s+\d+\s*[-–]\s*\d+\s+of\s+(\d+)/i);
    return match ? Math.max(1, Math.ceil(Number(match[1]) / 10)) : 1;
  }

  const exported = {
    canonicalDate,
    clockMinutes,
    contextFor,
    detectedTravelDate,
    evaluateThresholds,
    filterFaresForManualScan,
    filterFaresByWindow,
    formatTime24,
    minimumFarePrice,
    pageCountFromText,
    parseCardText,
    windowBoundaryMinutes,
    windowHourValue,
    windowMinuteValue,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!global || !global.document) return;

  const doc = global.document;
  let refreshTimer = null;
  let countdownTimer = null;
  let panel = null;
  let statusElement = null;
  let detailElement = null;
  let minimumElement = null;
  let countdownElement = null;
  let scanInProgress = false;

  function defaultState() {
    return {
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      contexts: {},
      contextOrder: [],
    };
  }

  function defaultTabState() {
    return {
      active: false,
      nextRefreshAt: null,
      minimized: false,
      panelPosition: null,
      windowStart: "",
      windowEnd: "",
      priceThreshold: null,
    };
  }

  function loadState() {
    let stored;
    try {
      stored = GM_getValue(STORAGE_KEY, null);
      if (typeof stored === "string") stored = JSON.parse(stored);
    } catch (_error) {
      stored = null;
    }
    return { ...defaultState(), ...(stored && typeof stored === "object" ? stored : {}) };
  }

  function saveState(state) {
    GM_setValue(STORAGE_KEY, state);
  }

  function loadTabState() {
    try {
      const stored = JSON.parse(global.sessionStorage.getItem(TAB_STORAGE_KEY));
      return { ...defaultTabState(), ...(stored && typeof stored === "object" ? stored : {}) };
    } catch (_error) {
      return defaultTabState();
    }
  }

  function saveTabState(state) {
    global.sessionStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(state));
  }

  function clampInterval(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MINUTES;
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(parsed)));
  }

  function money(value) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  }

  function timeLabel(timestamp) {
    return timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : "—";
  }

  function addStyles() {
    const style = doc.createElement("style");
    style.textContent = `
      #trackline-watch { box-sizing:border-box; position: fixed; right: 18px; bottom: 18px; width: 360px; max-height:calc(100vh - 36px);
        overflow:auto; z-index: 2147483646;
        color: #17211d; background: #fffdf7; border: 1px solid #b8c7be; border-radius: 14px;
        box-shadow: 0 10px 34px rgba(0,0,0,.22); padding: 14px; font: 14px/1.35 system-ui,sans-serif; }
      #trackline-watch * { box-sizing: border-box; }
      #trackline-watch .tl-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; cursor:grab; touch-action:none; user-select:none; }
      #trackline-watch .tl-head:active { cursor:grabbing; }
      #trackline-watch .tl-head-actions { display:flex; align-items:center; gap:6px; }
      #trackline-watch .tl-title { font-weight:750; font-size:16px; }
      #trackline-watch .tl-version { color:#68766f; font-size:10px; font-weight:600; margin-left:5px; }
      #trackline-watch .tl-dot { width:9px; height:9px; border-radius:50%; background:#87948d; display:inline-block; margin-right:6px; }
      #trackline-watch[data-active="true"] .tl-dot { background:#168554; box-shadow:0 0 0 4px rgba(22,133,84,.12); }
      #trackline-watch .tl-status { font-weight:650; margin-bottom:3px; }
      #trackline-watch .tl-detail { color:#53615a; font-size:12px; min-height:32px; }
      #trackline-watch .tl-minimum { margin-top:5px; padding:7px 9px; border-radius:8px; background:#edf7f0; color:#176c48; font-size:12px; font-weight:750; }
      #trackline-watch .tl-settings { margin-top:9px; padding-top:5px; border-top:1px solid #d9e0da; }
      #trackline-watch .tl-section-title { color:#2f4339; font-size:11px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; }
      #trackline-watch .tl-window-row { display:block; }
      #trackline-watch .tl-window { display:flex; align-items:center; justify-content:space-between; gap:5px; margin-top:6px; }
      #trackline-watch .tl-time-pair { display:flex; align-items:center; gap:3px; }
      #trackline-watch .tl-controls { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:10px; }
      #trackline-watch .tl-test { grid-column:1 / -1; }
      #trackline-watch button { cursor:pointer; border:1px solid #9dac9f; border-radius:8px; padding:7px 8px; background:#fff; color:#17211d; }
      #trackline-watch button:hover { background:#f0f6f1; }
      #trackline-watch .tl-primary { background:#176c48; border-color:#176c48; color:white; }
      #trackline-watch .tl-minimize { width:26px; min-width:26px; height:26px; padding:0; line-height:1; font-size:17px; }
      #trackline-watch label { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:9px; font-size:12px; color:#53615a; }
      #trackline-watch input { width:70px; border:1px solid #a9b6ad; border-radius:7px; padding:5px; }
      #trackline-watch input[type="number"] { appearance:textfield; -moz-appearance:textfield; }
      #trackline-watch input[type="number"]::-webkit-inner-spin-button,
      #trackline-watch input[type="number"]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
      #trackline-watch .tl-window input { flex:none; width:45px; text-align:center; }
      #trackline-watch .tl-threshold { width:86px; }
      #trackline-watch .tl-scan-results { max-height:220px; overflow:auto; margin-top:10px; border-top:1px solid #d9e0da; padding-top:8px; }
      #trackline-watch .tl-scan-results[hidden] { display:none; }
      #trackline-watch .tl-scan-title { position:sticky; top:-8px; z-index:1; color:#2f4339; background:#fffdf7; font-size:11px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; margin-bottom:5px; padding:8px 0 2px; }
      #trackline-watch .tl-scan-empty { color:#53615a; font-size:12px; }
      #trackline-watch .tl-result { display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid #edf0ed; font-size:12px; }
      #trackline-watch .tl-scan-title + .tl-result { border-top:0; }
      #trackline-watch .tl-result-main { min-width:0; }
      #trackline-watch .tl-result-time { font-weight:750; }
      #trackline-watch .tl-result-detail { color:#53615a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #trackline-watch .tl-result-price { color:#176c48; font-weight:750; white-space:nowrap; }
      #trackline-watch[data-minimized="true"] { width:240px; max-height:none; overflow:visible; padding:10px 12px; }
      #trackline-watch[data-minimized="true"] .tl-body { display:none; }
      #trackline-watch[data-minimized="true"] .tl-head { margin-bottom:0; }
      .trackline-alert { outline:4px solid #e09b24 !important; outline-offset:2px; }
      #trackline-toast { position:fixed; left:50%; top:24px; transform:translateX(-50%); z-index:2147483647;
        max-width:560px; padding:13px 18px; border-radius:10px; background:#153c2c; color:white;
        box-shadow:0 8px 30px rgba(0,0,0,.3); font:600 14px/1.35 system-ui,sans-serif; }
    `;
    doc.head.appendChild(style);
  }

  function buildPanel() {
    panel = doc.createElement("aside");
    panel.id = "trackline-watch";
    panel.innerHTML = `
      <div class="tl-head"><span class="tl-title"><span class="tl-dot"></span>Trackline <span class="tl-version">v${SCRIPT_VERSION}</span></span><span class="tl-head-actions"><span class="tl-countdown">Paused</span><button class="tl-minimize" type="button" aria-label="Minimize Trackline" aria-expanded="true" title="Minimize">−</button></span></div>
      <div class="tl-body">
        <div class="tl-status">Waiting for results…</div>
        <div class="tl-detail"></div>
        <div class="tl-minimum" hidden></div>
        <div class="tl-settings">
          <div class="tl-section-title">Watch filters</div>
          <label class="tl-window-row">Departure window (24h) <span class="tl-window"><span class="tl-time-pair"><input class="tl-window-start-hour" type="text" inputmode="numeric" maxlength="2" placeholder="00" aria-label="Start hour, 0 to 23">:<input class="tl-window-start-minute" type="text" inputmode="numeric" maxlength="2" value="00" aria-label="Start minute, 0 to 59"></span><span>to</span><span class="tl-time-pair"><input class="tl-window-end-hour" type="text" inputmode="numeric" maxlength="2" placeholder="23" aria-label="End hour, 0 to 23">:<input class="tl-window-end-minute" type="text" inputmode="numeric" maxlength="2" value="00" aria-label="End minute, 0 to 59"></span></span></label>
          <label>Price at or below <span>$ <input class="tl-threshold" type="number" min="0" step="0.01" placeholder="Off" aria-label="Price threshold"></span></label>
          <label>Refresh every <span><input class="tl-interval" type="number" min="1" max="1440" step="1"> min</span></label>
        </div>
        <div class="tl-controls">
          <button class="tl-toggle tl-primary">Start monitoring</button>
          <button class="tl-check">Scan now</button>
          <button class="tl-test">Test notification</button>
        </div>
        <div class="tl-scan-results" aria-live="polite" hidden></div>
      </div>
    `;
    doc.body.appendChild(panel);
    statusElement = panel.querySelector(".tl-status");
    detailElement = panel.querySelector(".tl-detail");
    minimumElement = panel.querySelector(".tl-minimum");
    countdownElement = panel.querySelector(".tl-countdown");

    const state = loadState();
    let tabState = loadTabState();
    panel.querySelector(".tl-interval").value = clampInterval(state.intervalMinutes);
    const startHour = windowHourValue(tabState.windowStart);
    const endHour = windowHourValue(tabState.windowEnd);
    panel.querySelector(".tl-window-start-hour").value = startHour === "" ? "" : startHour.padStart(2, "0");
    panel.querySelector(".tl-window-start-minute").value = windowMinuteValue(tabState.windowStart);
    panel.querySelector(".tl-window-end-hour").value = endHour === "" ? "" : endHour.padStart(2, "0");
    panel.querySelector(".tl-window-end-minute").value = windowMinuteValue(tabState.windowEnd);
    panel.querySelector(".tl-threshold").value = Number.isFinite(tabState.priceThreshold)
      ? tabState.priceThreshold
      : "";
    panel.querySelector(".tl-interval").addEventListener("change", (event) => {
      const updated = loadState();
      updated.intervalMinutes = clampInterval(event.target.value);
      event.target.value = updated.intervalMinutes;
      saveState(updated);
      const currentTab = loadTabState();
      if (currentTab.active) scheduleRefresh(currentTab, false);
    });
    tabState = saveWatchSettingsFromPanel();
    for (const selector of [
      ".tl-window-start-hour",
      ".tl-window-start-minute",
      ".tl-window-end-hour",
      ".tl-window-end-minute",
      ".tl-threshold",
    ]) {
      panel.querySelector(selector).addEventListener("change", updateWatchSettings);
    }
    panel.querySelector(".tl-toggle").addEventListener("click", toggleMonitoring);
    panel.querySelector(".tl-minimize").addEventListener("click", toggleMinimized);
    panel.querySelector(".tl-head").addEventListener("pointerdown", beginPanelDrag);
    panel.querySelector(".tl-check").addEventListener("click", () => {
      saveWatchSettingsFromPanel();
      void scanPage({ userInitiated: true, manual: true });
    });
    panel.querySelector(".tl-test").addEventListener("click", () => {
      void notify("Trackline test", "Chrome desktop notifications are working for Trackline.");
    });
    renderActiveState(tabState);
  }

  function renderActiveState(tabState) {
    if (!panel) return;
    panel.dataset.active = String(Boolean(tabState.active));
    applyPanelPresentation(tabState);
    panel.querySelector(".tl-toggle").textContent = tabState.active ? "Pause monitoring" : "Start monitoring";
    if (!tabState.active) countdownElement.textContent = "Paused";
  }

  function clampPanelPosition(left, top) {
    return {
      left: Math.min(Math.max(0, left), Math.max(0, global.innerWidth - panel.offsetWidth)),
      top: Math.min(Math.max(0, top), Math.max(0, global.innerHeight - panel.offsetHeight)),
    };
  }

  function applyPanelPresentation(tabState) {
    const minimized = Boolean(tabState.minimized);
    panel.dataset.minimized = String(minimized);
    const button = panel.querySelector(".tl-minimize");
    button.textContent = minimized ? "+" : "−";
    button.setAttribute("aria-label", minimized ? "Restore Trackline" : "Minimize Trackline");
    button.setAttribute("aria-expanded", String(!minimized));
    button.title = minimized ? "Restore" : "Minimize";

    const position = tabState.panelPosition;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const clamped = clampPanelPosition(position.left, position.top);
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function toggleMinimized() {
    const tabState = loadTabState();
    tabState.minimized = !tabState.minimized;
    saveTabState(tabState);
    applyPanelPresentation(tabState);
  }

  function beginPanelDrag(event) {
    if (event.button !== 0 || event.target.closest("button, input, label, a")) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    let moved = false;

    const move = (moveEvent) => {
      moved = true;
      const position = clampPanelPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };
    const finish = () => {
      global.removeEventListener("pointermove", move);
      global.removeEventListener("pointerup", finish);
      global.removeEventListener("pointercancel", finish);
      if (!moved) return;
      const rectAfterMove = panel.getBoundingClientRect();
      const tabState = loadTabState();
      tabState.panelPosition = { left: Math.round(rectAfterMove.left), top: Math.round(rectAfterMove.top) };
      saveTabState(tabState);
    };

    global.addEventListener("pointermove", move);
    global.addEventListener("pointerup", finish, { once: true });
    global.addEventListener("pointercancel", finish, { once: true });
    event.preventDefault();
  }

  function saveWatchSettingsFromPanel() {
    const tabState = loadTabState();
    const startHourInput = panel.querySelector(".tl-window-start-hour");
    const startMinuteInput = panel.querySelector(".tl-window-start-minute");
    const endHourInput = panel.querySelector(".tl-window-end-hour");
    const endMinuteInput = panel.querySelector(".tl-window-end-minute");
    const startHour = windowHourValue(startHourInput.value);
    const startMinute = windowMinuteValue(startMinuteInput.value);
    const endHour = windowHourValue(endHourInput.value);
    const endMinute = windowMinuteValue(endMinuteInput.value);
    tabState.windowStart = startHour === "" ? "" : `${startHour.padStart(2, "0")}:${startMinute}`;
    tabState.windowEnd = endHour === "" ? "" : `${endHour.padStart(2, "0")}:${endMinute}`;
    startHourInput.value = startHour === "" ? "" : startHour.padStart(2, "0");
    startMinuteInput.value = startMinute;
    endHourInput.value = endHour === "" ? "" : endHour.padStart(2, "0");
    endMinuteInput.value = endMinute;
    const threshold = Number(panel.querySelector(".tl-threshold").value);
    tabState.priceThreshold = panel.querySelector(".tl-threshold").value !== "" && threshold >= 0
      ? threshold
      : null;
    saveTabState(tabState);
    return tabState;
  }

  async function updateWatchSettings() {
    const tabState = saveWatchSettingsFromPanel();
    if (!fareCards().length) return;
    if (tabState.active) {
      await scanPage({ userInitiated: true });
    } else {
      renderReadyFares(collectFares(), tabState);
    }
  }

  function toast(message) {
    doc.getElementById("trackline-toast")?.remove();
    const element = doc.createElement("div");
    element.id = "trackline-toast";
    element.textContent = message;
    doc.body.appendChild(element);
    global.setTimeout(() => element.remove(), 12_000);
  }

  async function notify(title, text) {
    try {
      GM_notification({
        title,
        text,
        timeout: 0,
        onclick: () => global.focus(),
      });
      return true;
    } catch (_error) {
      // Fall back to the browser notification API when the userscript manager
      // does not provide extension-level notifications.
    }
    if (!("Notification" in global)) return false;
    let permission = global.Notification.permission;
    if (permission === "default") permission = await global.Notification.requestPermission();
    if (permission === "granted") {
      new global.Notification(title, { body: text, requireInteraction: true });
      return true;
    }
    toast("Chrome notifications are blocked. Allow notifications for this browser, then try again.");
    return false;
  }

  function fareCards() {
    return [...doc.querySelectorAll(CARD_SELECTOR)].filter((card) => card.offsetParent !== null);
  }

  function collectFares() {
    return fareCards().flatMap((card) => parseCardText(card.innerText));
  }

  function paginationRoot() {
    const labelled = doc.querySelector(
      'nav[aria-label="Page Navigation" i], [role="navigation"][aria-label="Page Navigation" i]',
    );
    if (labelled) return labelled;
    const labelledPage = doc.querySelector('[aria-label^="Page " i]');
    if (labelledPage) {
      return labelledPage.closest('nav, [role="navigation"]')
        || labelledPage.closest("ul, ol")?.parentElement
        || labelledPage.parentElement;
    }
    return [...doc.querySelectorAll('nav, [role="navigation"]')]
      .find((element) => /Showing\s+\d+\s*[-–]\s*\d+\s+of\s+\d+/i.test(element.innerText))
      || null;
  }

  function paginationControls() {
    return [...doc.querySelectorAll("a, button")]
      .filter((element) => /^Page\s+\d+/i.test(controlPageLabel(element)));
  }

  function paginationPageCount() {
    // The summary and controls can be rendered in separate wrapper elements.
    const reported = pageCountFromText(doc.body.innerText);
    const labelledPages = paginationControls()
      .map(controlPageLabel)
      .map((label) => label.match(/^Page\s+(\d+)/i))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    return Math.max(reported, ...labelledPages, 1);
  }

  function currentPageNumber() {
    const root = paginationRoot();
    // Amtrak puts this label on a span inside the link rather than on the link itself.
    const labelledCurrent = doc.querySelector('[aria-label*="Current Page" i]');
    if (labelledCurrent) {
      const match = labelledCurrent.getAttribute("aria-label").match(/^Page\s+(\d+)/i);
      if (match) return Number(match[1]);
    }
    if (!root) return paginationPageCount() === 1 ? 1 : null;
    const current = root.querySelector(
      '[aria-current="page"], [aria-current="true"], a.active, button.active, a.selected, button.selected, .active > a, .active > button, .selected > a, .selected > button',
    ) || [...root.querySelectorAll("button:disabled, a[aria-disabled='true']")].find((element) =>
      /^Page\s+\d+$/i.test((element.getAttribute("aria-label") || element.innerText || "").trim()),
    );
    if (!current) return null;
    const label = (current.getAttribute("aria-label") || current.innerText || "").trim();
    const match = label.match(/(?:Page\s+)?(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function pageControl(pageNumber) {
    return paginationControls().find((element) => {
      const match = controlPageLabel(element).match(/^Page\s+(\d+)/i);
      return match && Number(match[1]) === pageNumber;
    }) || null;
  }

  function controlPageLabel(element) {
    const direct = element.getAttribute("aria-label");
    if (direct) return direct.trim();
    const labelledChild = element.querySelector('[aria-label^="Page " i]');
    if (labelledChild) return labelledChild.getAttribute("aria-label").trim();
    const text = (element.innerText || "").trim();
    return /^\d+$/.test(text) ? `Page ${text}` : text;
  }

  function firstCardSignature() {
    const card = fareCards()[0];
    return card ? card.innerText.trim() : "";
  }

  async function waitForPageChange(previousSignature, targetPage) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < PAGE_CHANGE_TIMEOUT_MS) {
      const signature = firstCardSignature();
      if (signature && signature !== previousSignature) {
        await new Promise((resolve) => global.setTimeout(resolve, 150));
        return;
      }
      if (!previousSignature && signature && currentPageNumber() === targetPage) return;
      await new Promise((resolve) => global.setTimeout(resolve, 200));
    }
    throw new Error(`Timed out while opening Amtrak results page ${targetPage}.`);
  }

  async function goToResultsPage(pageNumber) {
    if (currentPageNumber() === pageNumber) return;
    const control = pageControl(pageNumber);
    if (!control) {
      if (pageNumber === 1 && paginationPageCount() === 1) return;
      throw new Error(`Could not find the control for Amtrak results page ${pageNumber}.`);
    }
    const previousSignature = firstCardSignature();
    control.click();
    await waitForPageChange(previousSignature, pageNumber);
  }

  async function collectAllFares() {
    statusElement.textContent = "Finding result pages…";
    let firstPageCardCount = fareCards().length;
    if (paginationPageCount() === 1 && firstPageCardCount >= 10 && paginationControls().length < 2) {
      const scrollingElement = doc.scrollingElement;
      const previousScrollTop = scrollingElement?.scrollTop || 0;
      scrollingElement?.scrollTo({ top: scrollingElement.scrollHeight, behavior: "auto" });
      await new Promise((resolve) => global.setTimeout(resolve, 500));
      scrollingElement?.scrollTo({ top: previousScrollTop, behavior: "auto" });
      firstPageCardCount = fareCards().length;
    }
    if (paginationPageCount() === 1 && firstPageCardCount >= 10 && paginationControls().length < 2) {
      throw new Error(
        "Amtrak shows ten fares but no result-page controls. Wait for the page to finish loading, then select Scan now again.",
      );
    }
    const initialPageCount = paginationPageCount();
    if (initialPageCount > 1) await goToResultsPage(1);
    const pageCount = paginationPageCount();
    const faresByKey = new Map();
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (pageNumber > 1) await goToResultsPage(pageNumber);
        statusElement.textContent = `Scanning results page ${pageNumber} of ${pageCount}…`;
        const pageFares = collectFares();
        if (!pageFares.length) {
          throw new Error(`No readable fares were found on Amtrak results page ${pageNumber}.`);
        }
        for (const fare of pageFares) faresByKey.set(fare.key, fare);
      }
    } finally {
      if (pageCount > 1 && currentPageNumber() !== 1) {
        try {
          await goToResultsPage(1);
        } catch (_error) {
          // A completed aggregate is still usable if Amtrak refuses the cosmetic return to page 1.
        }
      }
    }
    return { fares: [...faresByKey.values()], pageCount };
  }

  function markAlertCards(alerts) {
    const identities = new Set(alerts.map((alert) => `${alert.trainNumber}|${alert.departureTime}`));
    for (const card of fareCards()) {
      const fares = parseCardText(card.innerText);
      const matched = fares.some((fare) => identities.has(`${fare.trainNumber}|${fare.departureTime}`));
      card.classList.toggle("trackline-alert", matched);
    }
  }

  function windowDescription(tabState) {
    const start = windowBoundaryMinutes(tabState.windowStart, false);
    const end = windowBoundaryMinutes(tabState.windowEnd, true);
    const target = Number.isFinite(tabState.priceThreshold)
      ? ` · target ${money(tabState.priceThreshold)}`
      : "";
    const formatBoundary = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const window = start === null && end === null
      ? "any departure time"
      : `${start === null ? "00:00" : formatBoundary(start)}–${end === null ? "23:59" : formatBoundary(end)}`;
    return `${window}${target}`;
  }

  function renderReadyFares(fares, tabState, pageCount = null) {
    const matchingFares = filterFaresForManualScan(
      fares,
      tabState.windowStart,
      tabState.windowEnd,
      tabState.priceThreshold,
    );
    const context = contextFor(fares, doc, global.location.href);
    statusElement.textContent = pageCount === null
      ? `${matchingFares.length} matching fares visible · Scan now scans all results`
      : `${matchingFares.length} of ${fares.length} fares ready · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
    detailElement.textContent = context.travelDate
      ? `${context.label} · ${windowDescription(tabState)} · select Start monitoring`
      : `${context.label} · ${windowDescription(tabState)} · date not detected; use a fresh tab for another trip`;
  }

  function touchContext(state, context) {
    state.contextOrder = (state.contextOrder || []).filter((key) => key !== context.key);
    state.contextOrder.push(context.key);
    while (state.contextOrder.length > MAX_CONTEXTS) {
      const oldest = state.contextOrder.shift();
      delete state.contexts[oldest];
    }
  }

  function renderScanFailure(error, userInitiated, manual) {
    statusElement.textContent = "Could not scan every results page";
    detailElement.textContent = manual
      ? "Monitoring state was left unchanged. Select Scan now to try again."
      : "Monitoring state was left unchanged. Trackline will try again later.";
    if (userInitiated) toast(error instanceof Error ? error.message : "The full result scan failed.");
  }

  function clearScanResults() {
    const results = panel.querySelector(".tl-scan-results");
    results.hidden = true;
    results.replaceChildren();
  }

  function renderScanResults(fares) {
    const results = panel.querySelector(".tl-scan-results");
    results.replaceChildren();
    results.hidden = false;

    const title = doc.createElement("div");
    title.className = "tl-scan-title";
    title.textContent = "Current matches";
    results.appendChild(title);

    if (!fares.length) {
      const empty = doc.createElement("div");
      empty.className = "tl-scan-empty";
      empty.textContent = "No fares match the selected time window and price ceiling.";
      results.appendChild(empty);
      revealScanResults(results);
      return;
    }

    const sorted = [...fares].sort((left, right) =>
      (clockMinutes(left.departureTime) ?? Infinity) - (clockMinutes(right.departureTime) ?? Infinity)
      || left.price - right.price
      || left.fareClass.localeCompare(right.fareClass),
    );
    for (const fare of sorted) {
      const row = doc.createElement("div");
      row.className = "tl-result";
      const main = doc.createElement("div");
      main.className = "tl-result-main";
      const time = doc.createElement("div");
      time.className = "tl-result-time";
      time.textContent = formatTime24(fare.departureTime);
      const detail = doc.createElement("div");
      detail.className = "tl-result-detail";
      detail.textContent = `Train ${fare.trainNumber} · ${fare.fareClass}`;
      const price = doc.createElement("div");
      price.className = "tl-result-price";
      price.textContent = money(fare.price);
      main.append(time, detail);
      row.append(main, price);
      results.appendChild(row);
    }
    revealScanResults(results);
  }

  function revealScanResults(results) {
    global.requestAnimationFrame(() => {
      const visibleTop = panel.scrollTop;
      const visibleBottom = visibleTop + panel.clientHeight;
      const resultsBottom = results.offsetTop + Math.min(results.offsetHeight, panel.clientHeight);
      if (results.offsetTop < visibleTop || resultsBottom > visibleBottom) {
        panel.scrollTop = Math.max(0, results.offsetTop - 8);
      }
    });
  }

  function renderMinimumFare(fares) {
    const minimum = minimumFarePrice(fares);
    minimumElement.hidden = false;
    minimumElement.textContent = minimum === null
      ? "Minimum fare in selected window: none"
      : `Minimum fare in selected window: ${money(minimum)}`;
  }

  async function scanPage({ userInitiated = false, manual = false } = {}) {
    if (scanInProgress) {
      if (userInitiated) toast("A full results scan is already running.");
      return false;
    }
    scanInProgress = true;
    clearScanResults();
    panel.querySelector(".tl-check").disabled = true;
    let aggregate;
    try {
      aggregate = await collectAllFares();
    } catch (error) {
      renderScanFailure(error, userInitiated, manual);
      return false;
    } finally {
      scanInProgress = false;
      panel.querySelector(".tl-check").disabled = false;
    }
    const { fares: allFares, pageCount } = aggregate;
    if (!allFares.length) {
      statusElement.textContent = "No readable fares found";
      detailElement.textContent = "Trackline will wait; monitoring state was left unchanged.";
      if (userInitiated) toast("No fare cards are visible yet.");
      return false;
    }

    const tabState = loadTabState();
    const fares = filterFaresByWindow(allFares, tabState.windowStart, tabState.windowEnd);
    const matches = filterFaresForManualScan(
      allFares,
      tabState.windowStart,
      tabState.windowEnd,
      tabState.priceThreshold,
    );
    const context = contextFor(allFares, doc, global.location.href);
    renderMinimumFare(fares);
    renderScanResults(matches);
    if (manual) {
      statusElement.textContent = `${matches.length} matching ${matches.length === 1 ? "fare" : "fares"} · ${pageCount} ${pageCount === 1 ? "page" : "pages"} scanned · ${timeLabel(Date.now())}`;
      detailElement.textContent = `${context.label} · ${windowDescription(tabState)} · manual scan`;
      markAlertCards(matches);
      return true;
    }

    const state = loadState();
    const saved = state.contexts[context.key] || {
      thresholdStates: {},
      label: context.label,
    };
    const { nextStates: thresholdStates, hits: thresholdHits } = evaluateThresholds(
      saved.mode === "threshold-scan-v1" ? saved.thresholdStates : {},
      fares,
      tabState.priceThreshold,
    );
    state.contexts[context.key] = {
      thresholdStates,
      mode: "threshold-scan-v1",
      label: context.label,
      lastCheckedAt: Date.now(),
    };
    touchContext(state, context);
    saveState(state);

    statusElement.textContent = `${matches.length} matching ${matches.length === 1 ? "fare" : "fares"} · ${pageCount} ${pageCount === 1 ? "page" : "pages"} scanned · ${timeLabel(Date.now())}`;
    detailElement.textContent = context.travelDate
      ? `${context.label} · ${windowDescription(tabState)}`
      : `${context.label} · ${windowDescription(tabState)} · date not detected; use a fresh tab for another trip`;
    markAlertCards(matches);

    if (thresholdHits.length && Number.isFinite(tabState.priceThreshold)) {
      const cheapest = [...matches].sort((left, right) => left.price - right.price)[0];
      const title = matches.length === 1 ? "Amtrak target fare found" : "Amtrak target fares found";
      const text = cheapest
        ? `${matches.length} ${matches.length === 1 ? "fare is" : "fares are"} at or below ${money(tabState.priceThreshold)}. Lowest: Train ${cheapest.trainNumber} · ${formatTime24(cheapest.departureTime)} · ${cheapest.fareClass} · ${money(cheapest.price)}.`
        : `${thresholdHits.length} new fares meet your target of ${money(tabState.priceThreshold)}.`;
      void notify(title, text);
    }
    return true;
  }

  function clearTimers() {
    if (refreshTimer) global.clearTimeout(refreshTimer);
    if (countdownTimer) global.clearInterval(countdownTimer);
    refreshTimer = null;
    countdownTimer = null;
  }

  function scheduleRefresh(tabState = loadTabState(), preserveExistingDeadline = true) {
    clearTimers();
    if (!tabState.active) {
      renderActiveState(tabState);
      return;
    }

    const state = loadState();
    const intervalMs = clampInterval(state.intervalMinutes) * 60_000;
    const existing = Number(tabState.nextRefreshAt);
    const deadline = preserveExistingDeadline && existing > Date.now()
      ? existing
      : Date.now() + intervalMs;
    tabState.nextRefreshAt = deadline;
    saveTabState(tabState);
    renderActiveState(tabState);

    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const minutes = Math.floor(seconds / 60);
      countdownElement.textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
    };
    updateCountdown();
    countdownTimer = global.setInterval(updateCountdown, 1000);
    refreshTimer = global.setTimeout(() => global.location.reload(), Math.max(0, deadline - Date.now()));
  }

  async function toggleMonitoring() {
    const state = loadState();
    state.intervalMinutes = clampInterval(panel.querySelector(".tl-interval").value);
    saveState(state);
    const tabState = saveWatchSettingsFromPanel();
    tabState.active = !tabState.active;
    tabState.nextRefreshAt = null;
    saveTabState(tabState);
    if (tabState.active) {
      await scanPage({ userInitiated: true });
      scheduleRefresh(loadTabState(), false);
    } else {
      clearTimers();
      renderActiveState(tabState);
      toast("Trackline monitoring paused.");
    }
  }

  function waitForResults() {
    const startedAt = Date.now();
    const attempt = async () => {
      if (fareCards().length) {
        const tabState = loadTabState();
        if (tabState.active) {
          await scanPage();
          scheduleRefresh(tabState, true);
        } else {
          renderReadyFares(collectFares(), tabState);
        }
        return;
      }
      if (Date.now() - startedAt >= RESULTS_TIMEOUT_MS) {
        statusElement.textContent = "Results did not load";
        detailElement.textContent = "Monitoring remains active and will try again at the next refresh.";
        scheduleRefresh(loadTabState(), true);
        return;
      }
      global.setTimeout(() => void attempt(), 1000);
    };
    void attempt();
  }

  function initialize() {
    addStyles();
    buildPanel();
    waitForResults();
    try {
      GM_registerMenuCommand("Trackline: scan fares now", () => {
        saveWatchSettingsFromPanel();
        void scanPage({ userInitiated: true, manual: true });
      });
      GM_registerMenuCommand("Trackline: pause/resume", toggleMonitoring);
    } catch (_error) {
      // The floating panel still provides both controls.
    }
  }

  initialize();
})(typeof window !== "undefined" ? window : null);
