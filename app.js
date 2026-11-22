(function() {
  "use strict";

  var APP_VERSION = "v 8.6";
  var LS_KEY = "obvalka_pro_db_v1";
  var IDB_NAME = "obvalka_pro_idb";
  var IDB_STORE = "kv";
  var IDB_KEY = "main_db";
  var NL = String.fromCharCode(10);

  var MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  var state = {
    viewYear: 2026,
    viewMonth: 10,
    periodMode: "day",
    selectedStart: "2026-11-22",
    selectedEnd: "2026-11-22",
    workerName: "",
    defaultRate: 9.5,
    theme: "dark",
    records: {},
    backups: [],
    updatedAt: 0,
    lastAutoBackupDate: ""
  };

  var isDragging = false;
  var dragAnchorDate = null;
  var undoBuffer = null;
  var undoTimer = null;
  var currentReportText = "";

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function toIso(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }

  function parseIso(iso) {
    var parts = String(iso || "").split("-");
    return new Date(parseInt(parts[0], 10) || 2026, (parseInt(parts[1], 10) || 1) - 1, parseInt(parts[2], 10) || 1);
  }

  function formatShortDate(iso) {
    var dt = parseIso(iso);
    return dt.getDate() + " " + MONTHS_SHORT[dt.getMonth()];
  }

  function formatFullDate(iso) {
    var dt = parseIso(iso);
    return dt.getDate() + " " + MONTHS_GEN[dt.getMonth()];
  }

  function parseNum(val) {
    if (typeof val === "number") return isFinite(val) ? val : 0;
    var s = String(val || "").replace(",", ".").trim();
    var out = "";
    var dotSeen = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= "0" && ch <= "9") out += ch;
      else if (ch === "." && !dotSeen) { out += "."; dotSeen = true; }
    }
    var n = parseFloat(out);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function fmtMoney(n) {
    var r = round2(n);
    return (r % 1 === 0 ? r.toString() : r.toFixed(2)) + " ₽";
  }

  function fmtWeight(n) {
    var r = round2(n);
    return (r % 1 === 0 ? r.toString() : r.toFixed(2)) + " кг";
  }

  function normalizeRecord(rec, fallbackRate) {
    if (!rec || typeof rec !== "object") return null;
    if (rec.isOff || rec.off || rec.type === "off") {
      return { isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 };
    }
    var boxes = parseNum(rec.boxes !== undefined ? rec.boxes : rec.b);
    var boxWeight = parseNum(rec.boxWeight !== undefined ? rec.boxWeight : rec.bw);
    var weight = parseNum(rec.weight !== undefined ? rec.weight : (rec.totalWeight !== undefined ? rec.totalWeight : rec.w));
    if (weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round2(boxes * boxWeight);
    }
    var rate = parseNum(rec.rate !== undefined ? rec.rate : rec.r);
    if (rate <= 0 && weight > 0) {
      rate = fallbackRate || 9.5;
    }
    var pay = parseNum(rec.pay !== undefined ? rec.pay : (rec.totalPay !== undefined ? rec.totalPay : rec.sum));
    if (pay <= 0 && weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    }
    if (boxes <= 0 && weight <= 0 && pay <= 0) {
      return { isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 };
    }
    return {
      isOff: false,
      boxes: boxes,
      boxWeight: boxWeight,
      weight: round2(weight),
      rate: round2(rate),
      pay: round2(pay)
    };
  }

  function normalizeDb(raw, fallbackRate) {
    var rateDef = parseNum(raw && raw.defaultRate) || fallbackRate || 9.5;
    var outRecords = {};
    var src = (raw && raw.records) || {};
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      var d = keys[i];
      var arr = Array.isArray(src[d]) ? src[d] : [src[d]];
      var cleanArr = [];
      for (var j = 0; j < arr.length; j++) {
        var item = normalizeRecord(arr[j], rateDef);
        if (item) cleanArr.push(item);
      }
      if (cleanArr.length > 0) outRecords[d] = cleanArr;
    }
    return {
      workerName: (raw && raw.workerName) || "",
      defaultRate: rateDef,
      theme: (raw && raw.theme) || "dark",
      records: outRecords,
      backups: Array.isArray(raw && raw.backups) ? raw.backups : [],
      updatedAt: Number(raw && raw.updatedAt) || 0,
      lastAutoBackupDate: (raw && raw.lastAutoBackupDate) || ""
    };
  }

  function countRecords(db) {
    if (!db || !db.records) return 0;
    var total = 0;
    var ks = Object.keys(db.records);
    for (var i = 0; i < ks.length; i++) {
      total += Array.isArray(db.records[ks[i]]) ? db.records[ks[i]].length : 0;
    }
    return total;
  }

  function openIdb() {
    return new Promise(function(resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function(e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = function(e) { resolve(e.target.result); };
        req.onerror = function() { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function readIdb() {
    return openIdb().then(function(db) {
      if (!db) return null;
      return new Promise(function(resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readonly");
          var st = tx.objectStore(IDB_STORE);
          var rq = st.get(IDB_KEY);
          rq.onsuccess = function() { resolve(rq.result || null); };
          rq.onerror = function() { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function writeIdb(payload) {
    return openIdb().then(function(db) {
      if (!db) return false;
      return new Promise(function(resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          var st = tx.objectStore(IDB_STORE);
          st.put(payload, IDB_KEY);
          tx.oncomplete = function() { resolve(true); };
          tx.onerror = function() { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function serializeState() {
    return {
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      theme: state.theme,
      records: state.records,
      backups: state.backups,
      updatedAt: state.updatedAt,
      lastAutoBackupDate: state.lastAutoBackupDate
    };
  }

  function saveAllStorages(touchTime) {
    if (touchTime !== false) state.updatedAt = Date.now();
    var payload = serializeState();
    var json = JSON.stringify(payload);
    try { localStorage.setItem(LS_KEY, json); } catch (e) {}
    try { window.name = "OBVALKA_DB:" + json; } catch (e) {}
    return writeIdb(payload);
  }

  function pickBestDb(candidates) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c) continue;
      var norm = normalizeDb(c, 9.5);
      var cnt = countRecords(norm);
      var bkp = norm.backups.length;
      var score = cnt * 100000 + bkp * 1000 + (norm.updatedAt > 0 ? 1 : 0);
      if (score > bestScore || (score === bestScore && norm.updatedAt > (best ? best.updatedAt : 0))) {
        best = norm;
        bestScore = score;
      }
    }
    return best;
  }

  function loadAllStorages() {
    var lsObj = null;
    var wnObj = null;
    try {
      var s = localStorage.getItem(LS_KEY);
      if (s) lsObj = JSON.parse(s);
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBVALKA_DB:") === 0) {
        wnObj = JSON.parse(window.name.slice("OBVALKA_DB:".length));
      }
    } catch (e) {}
    return readIdb().then(function(idbObj) {
      var chosen = pickBestDb([lsObj, idbObj, wnObj]);
      if (chosen) {
        state.workerName = chosen.workerName;
        state.defaultRate = chosen.defaultRate;
        state.theme = chosen.theme;
        state.records = chosen.records;
        state.backups = chosen.backups;
        state.updatedAt = chosen.updatedAt;
        state.lastAutoBackupDate = chosen.lastAutoBackupDate;
      }
      return saveAllStorages(false);
    });
  }

  function createBackupSnapshot(tag) {
    var now = new Date();
    var label = pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + (tag ? " " + tag : "");
    var snap = {
      id: "bkp_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      label: label,
      createdAt: Date.now(),
      data: normalizeDb(serializeState(), state.defaultRate)
    };
    state.backups.unshift(snap);
    if (state.backups.length > 25) state.backups = state.backups.slice(0, 25);
  }

  function ensureDailyAutoBackup() {
    var now = new Date();
    var todayKey = toIso(now.getFullYear(), now.getMonth(), now.getDate());
    if (state.lastAutoBackupDate !== todayKey && countRecords(state) > 0) {
      createBackupSnapshot("(авто)");
      state.lastAutoBackupDate = todayKey;
    }
  }

  function computePeriodBounds(mode, anchorIso) {
    var dt = parseIso(anchorIso);
    var y = dt.getFullYear();
    var m = dt.getMonth();
    var d = dt.getDate();
    if (mode === "day") {
      return { start: anchorIso, end: anchorIso };
    }
    if (mode === "week") {
      var dow = (dt.getDay() + 6) % 7;
      var sDt = new Date(y, m, d - dow);
      var eDt = new Date(y, m, d - dow + 6);
      return {
        start: toIso(sDt.getFullYear(), sDt.getMonth(), sDt.getDate()),
        end: toIso(eDt.getFullYear(), eDt.getMonth(), eDt.getDate())
      };
    }
    if (mode === "2weeks") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (d <= 15) {
        return { start: toIso(y, m, 1), end: toIso(y, m, 15) };
      }
      return { start: toIso(y, m, 16), end: toIso(y, m, lastDay) };
    }
    if (mode === "month") {
      var lastM = new Date(y, m + 1, 0).getDate();
      return { start: toIso(y, m, 1), end: toIso(y, m, lastM) };
    }
    if (mode === "year") {
      return { start: toIso(y, 0, 1), end: toIso(y, 11, 31) };
    }
    return { start: anchorIso, end: anchorIso };
  }

  function setPeriodMode(mode) {
    state.periodMode = mode;
    var bounds = computePeriodBounds(mode, state.selectedStart);
    state.selectedStart = bounds.start;
    state.selectedEnd = bounds.end;
    var dt = parseIso(state.selectedStart);
    state.viewYear = dt.getFullYear();
    state.viewMonth = dt.getMonth();
    refreshAll();
  }

  function getOrderedRange() {
    return state.selectedStart <= state.selectedEnd
      ? { start: state.selectedStart, end: state.selectedEnd }
      : { start: state.selectedEnd, end: state.selectedStart };
  }

  function renderCalendar() {
    var titleEl = document.getElementById("calMonthTitle");
    var verEl = document.getElementById("appVersionBadge");
    if (titleEl) titleEl.textContent = MONTHS_NOM[state.viewMonth] + " " + state.viewYear;
    if (verEl) verEl.textContent = APP_VERSION;

    var tabs = document.querySelectorAll(".period-tab");
    for (var t = 0; t < tabs.length; t++) {
      var m = tabs[t].getAttribute("data-mode");
      tabs[t].classList.toggle("active", m === state.periodMode);
    }

    var grid = document.getElementById("calGrid");
    if (!grid) return;

    var firstDay = new Date(state.viewYear, state.viewMonth, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var daysInMonth = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(state.viewYear, state.viewMonth, 0).getDate();

    var range = getOrderedRange();
    var cells = [];

    for (var p = startOffset - 1; p >= 0; p--) {
      var pd = prevMonthDays - p;
      var pm = state.viewMonth - 1;
      var py = state.viewYear;
      if (pm < 0) { pm = 11; py--; }
      cells.push({ iso: toIso(py, pm, pd), day: pd, other: true });
    }
    for (var d = 1; d <= daysInMonth; d++) {
      cells.push({ iso: toIso(state.viewYear, state.viewMonth, d), day: d, other: false });
    }
    var rem = (7 - (cells.length % 7)) % 7;
    for (var n = 1; n <= rem; n++) {
      var nm = state.viewMonth + 1;
      var ny = state.viewYear;
      if (nm > 11) { nm = 0; ny++; }
      cells.push({ iso: toIso(ny, nm, n), day: n, other: true });
    }

    var html = "";
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var dayRecs = state.records[c.iso] || [];
      var hasOff = false;
      var hasWork = false;
      for (var r = 0; r < dayRecs.length; r++) {
        if (dayRecs[r].isOff) hasOff = true;
        else hasWork = true;
      }

      var isStart = c.iso === range.start;
      var isEnd = c.iso === range.end;
      var inRange = c.iso >= range.start && c.iso <= range.end;

      var cls = "day-cell";
      if (c.other) cls += " other-month";
      if (hasOff) cls += " is-off";
      else if (hasWork) cls += " has-work";

      if (isStart || isEnd) {
        cls += " selected-edge";
      } else if (inRange) {
        cls += " in-range";
      }

      var badge = hasOff ? '<span class="off-x">✕</span>' : (hasWork ? '<span class="work-dot"></span>' : "");
      html += '<div class="' + cls + '" data-iso="' + c.iso + '"><span class="day-num">' + c.day + "</span>" + badge + "</div>";
    }
    grid.innerHTML = html;
  }

  function getPeriodLabel() {
    var range = getOrderedRange();
    if (state.periodMode === "day" && range.start === range.end) {
      return "ДЕНЬ (" + formatShortDate(range.start).toUpperCase() + ")";
    }
    if (state.periodMode === "week") return "НЕДЕЛЯ (" + formatShortDate(range.start) + " – " + formatShortDate(range.end) + ")";
    if (state.periodMode === "2weeks") return "2Х НЕДЕЛИ (" + formatShortDate(range.start) + " – " + formatShortDate(range.end) + ")";
    if (state.periodMode === "month") return "МЕСЯЦ (" + MONTHS_NOM[parseIso(range.start).getMonth()].toUpperCase() + ")";
    if (state.periodMode === "year") return "ГОД (" + parseIso(range.start).getFullYear() + ")";
    return formatShortDate(range.start).toUpperCase() + " – " + formatShortDate(range.end).toUpperCase();
  }

  function renderRecordsAndTotals() {
    var range = getOrderedRange();
    var pLabel = getPeriodLabel();
    var recTitle = document.getElementById("recordsPeriodLabel");
    var totTitle = document.getElementById("totalsPeriodLabel");
    if (recTitle) recTitle.textContent = "ЗАПИСИ (" + pLabel + ")";
    if (totTitle) totTitle.textContent = "ИТОГ ЗА " + pLabel;

    var listEl = document.getElementById("recordsList");
    var countBadge = document.getElementById("recordsCountBadge");
    var allDates = Object.keys(state.records).sort();
    var rows = [];
    var totBoxes = 0;
    var totWeight = 0;
    var totPay = 0;

    for (var i = 0; i < allDates.length; i++) {
      var iso = allDates[i];
      if (iso < range.start || iso > range.end) continue;
      var arr = state.records[iso] || [];
      for (var j = 0; j < arr.length; j++) {
        var rec = arr[j];
        rows.push({ iso: iso, idx: j, rec: rec });
        if (!rec.isOff) {
          totBoxes += rec.boxes || 0;
          totWeight = round2(totWeight + (rec.weight || 0));
          totPay = round2(totPay + (rec.pay || 0));
        }
      }
    }

    if (countBadge) countBadge.textContent = rows.length + " ШТ.";
    var totBoxesEl = document.getElementById("totalBoxes");
    var totWeightEl = document.getElementById("totalWeight");
    var totPayEl = document.getElementById("totalPay");
    if (totBoxesEl) totBoxesEl.textContent = totBoxes + " кор.";
    if (totWeightEl) totWeightEl.textContent = fmtWeight(totWeight);
    if (totPayEl) totPayEl.textContent = fmtMoney(totPay);

    if (!listEl) return;
    if (rows.length === 0) {
      listEl.innerHTML = "";
      return;
    }

    var html = "";
    for (var k = 0; k < rows.length; k++) {
      var item = rows[k];
      var r = item.rec;
      if (r.isOff) {
        html += '<div class="record-row off-row">' +
          '<span class="rec-text">' + formatShortDate(item.iso) + ': <strong class="off-label">Выходной</strong></span>' +
          '<button class="del-rec-btn" data-iso="' + item.iso + '" data-idx="' + item.idx + '">✕</button>' +
          "</div>";
      } else {
        var boxPart = r.boxes > 0 ? r.boxes + " кор. • " : "";
        html += '<div class="record-row">' +
          '<span class="rec-text">' + formatShortDate(item.iso) + ": " + boxPart + fmtWeight(r.weight) + " × " + r.rate + ' ₽ = <strong class="rec-pay">' + fmtMoney(r.pay) + "</strong></span>" +
          '<button class="del-rec-btn" data-iso="' + item.iso + '" data-idx="' + item.idx + '">✕</button>' +
          "</div>";
      }
    }
    listEl.innerHTML = html;

    var formDateEl = document.getElementById("selectedDateLabel");
    if (formDateEl) {
      formDateEl.textContent = range.start === range.end
        ? formatFullDate(range.start)
        : formatShortDate(range.start) + " – " + formatShortDate(range.end);
    }
  }

  function updateLiveCalc() {
    var boxes = parseNum(document.getElementById("inputBoxes").value);
    var boxWeight = parseNum(document.getElementById("inputBoxWeight").value);
    var rate = parseNum(document.getElementById("inputRate").value);

    var totalWeight = 0;
    if (boxes > 0 && boxWeight > 0) {
      totalWeight = round2(boxes * boxWeight);
    } else if (boxWeight > 0) {
      totalWeight = round2(boxWeight);
    }
    var totalPay = round2(totalWeight * rate);

    var wEl = document.getElementById("previewWeight");
    var pEl = document.getElementById("previewPay");
    if (wEl) wEl.textContent = fmtWeight(totalWeight);
    if (pEl) pEl.textContent = fmtMoney(totalPay);
  }

  function applyTheme() {
    document.body.classList.toggle("light-theme", state.theme === "light");
    var btn = document.getElementById("btnTheme");
    if (btn) btn.textContent = state.theme === "light" ? "🌙" : "☀";
  }

  function refreshAll() {
    applyTheme();
    var nameInput = document.getElementById("inputWorkerName");
    var rateInput = document.getElementById("inputRate");
    if (nameInput && nameInput.value !== state.workerName) nameInput.value = state.workerName;
    if (rateInput && !rateInput.dataset.edited) rateInput.value = state.defaultRate;
    renderCalendar();
    renderRecordsAndTotals();
    updateLiveCalc();
  }

  function showToast(msg) {
    var t = document.getElementById("toastBox");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.classList.remove("show"); }, 2600);
  }

  function triggerUndoBar(iso, idx, rec) {
    undoBuffer = { iso: iso, idx: idx, rec: rec };
    var bar = document.getElementById("undoBar");
    var cntEl = document.getElementById("undoCountdown");
    if (!bar) return;
    bar.classList.remove("hidden");
    var sec = 5;
    if (cntEl) cntEl.textContent = sec;
    clearInterval(undoTimer);
    undoTimer = setInterval(function() {
      sec--;
      if (cntEl) cntEl.textContent = sec;
      if (sec <= 0) {
        clearInterval(undoTimer);
        bar.classList.add("hidden");
        undoBuffer = null;
      }
    }, 1000);
  }

  function buildReport(isShort) {
    var range = getOrderedRange();
    var lines = [];
    if (state.workerName.trim()) lines.push(state.workerName.trim());

    var isStandardSinglePeriod = (state.periodMode === "day" && range.start === range.end) ||
      state.periodMode === "week" || state.periodMode === "2weeks" ||
      state.periodMode === "month" || state.periodMode === "year";

    var allDates = Object.keys(state.records).sort();
    var totBoxes = 0;
    var totWeight = 0;
    var totPay = 0;
    var dayLines = [];

    for (var i = 0; i < allDates.length; i++) {
      var iso = allDates[i];
      if (iso < range.start || iso > range.end) continue;
      var arr = state.records[iso] || [];
      for (var j = 0; j < arr.length; j++) {
        var r = arr[j];
        if (r.isOff) {
          dayLines.push(formatShortDate(iso) + " | Выходной");
        } else {
          totBoxes += r.boxes || 0;
          totWeight = round2(totWeight + (r.weight || 0));
          totPay = round2(totPay + (r.pay || 0));
          var bStr = r.boxes > 0 ? r.boxes + "кор | " : "";
          dayLines.push(formatShortDate(iso) + " | " + bStr + fmtWeight(r.weight).replace(" ", "") + " | " + fmtMoney(r.pay).replace(" ", ""));
        }
      }
    }

    if (isShort) {
      if (!isStandardSinglePeriod && range.start !== range.end) {
        lines.push("Период: " + formatShortDate(range.start) + " – " + formatShortDate(range.end));
      }
      lines.push("Вес: " + fmtWeight(totWeight) + (totBoxes > 0 ? " (" + totBoxes + " кор.)" : ""));
      lines.push("Итого: " + fmtMoney(totPay));
    } else {
      var pText = range.start === range.end ? formatFullDate(range.start) : formatShortDate(range.start) + " – " + formatShortDate(range.end);
      lines.push("Период: " + pText);
      for (var k = 0; k < dayLines.length; k++) lines.push(dayLines[k]);
      lines.push("ИТОГ: " + (totBoxes > 0 ? totBoxes + "кор | " : "") + fmtWeight(totWeight).replace(" ", "") + " | " + fmtMoney(totPay).replace(" ", ""));
    }
    return lines.join(NL);
  }

  function openReportPreview(isShort) {
    currentReportText = buildReport(isShort);
    var pre = document.getElementById("reportPreviewText");
    var modal = document.getElementById("reportModal");
    if (pre) pre.textContent = currentReportText;
    if (modal) modal.classList.remove("hidden");
  }

  function shareReportText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() {});
    }
    if (navigator.share) {
      navigator.share({ text: text }).catch(function() {});
      return;
    }
    try {
      var intentUrl = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(text) + ";end";
      window.location.href = intentUrl;
    } catch (e) {
      showToast("Отчёт скопирован в буфер обмена");
    }
  }

  function runSafeUpdate() {
    var ov = document.getElementById("updateOverlay");
    var st = document.getElementById("updateStepText");
    if (ov) ov.classList.remove("hidden");
    if (st) st.textContent = "Шаг 1/4: Сохранение базы в память...";

    createBackupSnapshot("(перед обн.)");
    saveAllStorages(true).then(function() {
      setTimeout(function() {
        if (st) st.textContent = "Шаг 2/4: Проверка целостности данных...";
        setTimeout(function() {
          if (st) st.textContent = "Шаг 3/4: Очистка старого кэша...";
          var tasks = [];
          if (window.caches && window.caches.keys) {
            tasks.push(window.caches.keys().then(function(names) {
              return Promise.all(names.map(function(n) { return window.caches.delete(n); }));
            }));
          }
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            tasks.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
              return Promise.all(regs.map(function(rg) { return rg.unregister(); }));
            }));
          }
          Promise.all(tasks).catch(function() {}).then(function() {
            setTimeout(function() {
              if (st) st.textContent = "Шаг 4/4: Перезагрузка на новую версию...";
              setTimeout(function() {
                window.location.reload(true);
              }, 600);
            }, 700);
          });
        }, 700);
      }, 700);
    });
  }

  function openRestoreModal() {
    var list = document.getElementById("backupsList");
    var modal = document.getElementById("restoreModal");
    if (!list || !modal) return;
    if (state.backups.length === 0) {
      list.innerHTML = '<div class="empty-bkp">Резервных копий пока нет</div>';
    } else {
      var html = "";
      for (var i = 0; i < state.backups.length; i++) {
        var b = state.backups[i];
        var cnt = countRecords(b.data);
        html += '<div class="bkp-item">' +
          '<div class="bkp-info"><strong>' + b.label + '</strong><span>Записей: ' + cnt + "</span></div>" +
          '<div class="bkp-actions">' +
          '<button class="btn-bkp-load" data-idx="' + i + '">Восстановить</button>' +
          '<button class="btn-bkp-del" data-idx="' + i + '">✕</button>' +
          "</div></div>";
      }
      list.innerHTML = html;
    }
    modal.classList.remove("hidden");
  }

  function bindEvents() {
    var prevBtn = document.getElementById("btnPrevMonth");
    var nextBtn = document.getElementById("btnNextMonth");
    if (prevBtn) prevBtn.addEventListener("click", function() {
      state.viewMonth--;
      if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
      renderCalendar();
    });
    if (nextBtn) nextBtn.addEventListener("click", function() {
      state.viewMonth++;
      if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
      renderCalendar();
    });

    var tabs = document.querySelectorAll(".period-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function() {
        setPeriodMode(this.getAttribute("data-mode"));
      });
    }

    var grid = document.getElementById("calGrid");
    if (grid) {
      grid.addEventListener("pointerdown", function(e) {
        var cell = e.target.closest(".day-cell");
        if (!cell) return;
        var iso = cell.getAttribute("data-iso");
        if (!iso) return;
        isDragging = true;
        dragAnchorDate = iso;
        if (state.periodMode === "day") {
          state.selectedStart = iso;
          state.selectedEnd = iso;
        } else {
          var b = computePeriodBounds(state.periodMode, iso);
          state.selectedStart = b.start;
          state.selectedEnd = b.end;
        }
        refreshAll();
      });

      grid.addEventListener("pointermove", function(e) {
        if (!isDragging || !dragAnchorDate) return;
        var el = document.elementFromPoint(e.clientX, e.clientY);
        var cell = el ? el.closest(".day-cell") : null;
        if (!cell) return;
        var iso = cell.getAttribute("data-iso");
        if (!iso || iso === state.selectedEnd) return;
        state.periodMode = "day";
        state.selectedStart = dragAnchorDate;
        state.selectedEnd = iso;
        refreshAll();
      });

      window.addEventListener("pointerup", function() {
        isDragging = false;
        dragAnchorDate = null;
      });
    }

    var btnOff = document.getElementById("btnDayOff");
    if (btnOff) btnOff.addEventListener("click", function() {
      var targetIso = getOrderedRange().start;
      if (!state.records[targetIso]) state.records[targetIso] = [];
      state.records[targetIso].push({ isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 });
      ensureDailyAutoBackup();
      saveAllStorages(true);
      refreshAll();
      showToast("Выходной добавлен на " + formatShortDate(targetIso));
    });

    var btnAdd = document.getElementById("btnAddRecord");
    if (btnAdd) btnAdd.addEventListener("click", function() {
      var boxes = parseNum(document.getElementById("inputBoxes").value);
      var boxWeight = parseNum(document.getElementById("inputBoxWeight").value);
      var rate = parseNum(document.getElementById("inputRate").value);

      var weight = 0;
      if (boxes > 0 && boxWeight > 0) weight = round2(boxes * boxWeight);
      else if (boxWeight > 0) weight = round2(boxWeight);

      if (weight <= 0) {
        showToast("Введите вес коробки или количество коробок");
        return;
      }
      if (rate > 0) state.defaultRate = rate;
      var pay = round2(weight * rate);
      var targetIso = getOrderedRange().start;
      if (!state.records[targetIso]) state.records[targetIso] = [];
      state.records[targetIso].push({
        isOff: false,
        boxes: boxes,
        boxWeight: boxWeight,
        weight: weight,
        rate: rate,
        pay: pay
      });

      document.getElementById("inputBoxes").value = "";
      document.getElementById("inputBoxWeight").value = "";
      ensureDailyAutoBackup();
      saveAllStorages(true);
      refreshAll();
      showToast("Запись добавлена: " + fmtWeight(weight) + " • " + fmtMoney(pay));
    });

    ["inputBoxes", "inputBoxWeight", "inputRate"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", function() {
        if (id === "inputRate") el.dataset.edited = "1";
        updateLiveCalc();
      });
    });

    var nameEl = document.getElementById("inputWorkerName");
    if (nameEl) nameEl.addEventListener("input", function() {
      state.workerName = this.value;
      saveAllStorages(true);
    });

    var recList = document.getElementById("recordsList");
    if (recList) recList.addEventListener("click", function(e) {
      var btn = e.target.closest(".del-rec-btn");
      if (!btn) return;
      var iso = btn.getAttribute("data-iso");
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      var arr = state.records[iso];
      if (!arr || !arr[idx]) return;
      var removed = arr.splice(idx, 1)[0];
      if (arr.length === 0) delete state.records[iso];
      saveAllStorages(true);
      refreshAll();
      triggerUndoBar(iso, idx, removed);
    });

    var undoBtn = document.getElementById("btnUndoDelete");
    if (undoBtn) undoBtn.addEventListener("click", function() {
      if (!undoBuffer) return;
      clearInterval(undoTimer);
      if (!state.records[undoBuffer.iso]) state.records[undoBuffer.iso] = [];
      state.records[undoBuffer.iso].splice(undoBuffer.idx, 0, undoBuffer.rec);
      undoBuffer = null;
      document.getElementById("undoBar").classList.add("hidden");
      saveAllStorages(true);
      refreshAll();
      showToast("Запись восстановлена");
    });

    var btnTheme = document.getElementById("btnTheme");
    if (btnTheme) btnTheme.addEventListener("click", function() {
      state.theme = state.theme === "dark" ? "light" : "dark";
      saveAllStorages(true);
      applyTheme();
    });

    var btnUpd = document.getElementById("btnUpdate");
    if (btnUpd) btnUpd.addEventListener("click", runSafeUpdate);

    var btnFull = document.getElementById("btnFullReport");
    var btnShort = document.getElementById("btnShortReport");
    if (btnFull) btnFull.addEventListener("click", function() { openReportPreview(false); });
    if (btnShort) btnShort.addEventListener("click", function() { openReportPreview(true); });

    var btnCancelRep = document.getElementById("btnCancelReport");
    var btnSendRep = document.getElementById("btnSendReport");
    if (btnCancelRep) btnCancelRep.addEventListener("click", function() {
      document.getElementById("reportModal").classList.add("hidden");
    });
    if (btnSendRep) btnSendRep.addEventListener("click", function() {
      document.getElementById("reportModal").classList.add("hidden");
      shareReportText(currentReportText);
    });

    var btnSaveDb = document.getElementById("btnSaveDb");
    if (btnSaveDb) btnSaveDb.addEventListener("click", function() {
      createBackupSnapshot("");
      saveAllStorages(true);
      showToast("Резервная копия сохранена");
    });

    var btnOpenRes = document.getElementById("btnOpenRestore");
    if (btnOpenRes) btnOpenRes.addEventListener("click", openRestoreModal);

    var btnCloseRes = document.getElementById("btnCloseRestore");
    if (btnCloseRes) btnCloseRes.addEventListener("click", function() {
      document.getElementById("restoreModal").classList.add("hidden");
    });

    var bkpList = document.getElementById("backupsList");
    if (bkpList) bkpList.addEventListener("click", function(e) {
      var loadBtn = e.target.closest(".btn-bkp-load");
      var delBtn = e.target.closest(".btn-bkp-del");
      if (loadBtn) {
        var idx = parseInt(loadBtn.getAttribute("data-idx"), 10);
        var b = state.backups[idx];
        if (!b || !b.data) return;
        var norm = normalizeDb(b.data, state.defaultRate);
        state.workerName = norm.workerName || state.workerName;
        state.defaultRate = norm.defaultRate || state.defaultRate;
        state.records = norm.records;
        saveAllStorages(true);
        document.getElementById("restoreModal").classList.add("hidden");
        refreshAll();
        showToast("База восстановлена (" + countRecords(state) + " зап.)");
      } else if (delBtn) {
        var dIdx = parseInt(delBtn.getAttribute("data-idx"), 10);
        state.backups.splice(dIdx, 1);
        saveAllStorages(true);
        openRestoreModal();
      }
    });

    var btnToggleCode = document.getElementById("btnToggleCode");
    if (btnToggleCode) btnToggleCode.addEventListener("click", function() {
      var box = document.getElementById("codeTransferBox");
      var area = document.getElementById("transferCodeArea");
      if (!box) return;
      box.classList.toggle("hidden");
      if (!box.classList.contains("hidden") && area) {
        area.value = JSON.stringify(serializeState());
      }
    });

    var btnCopyCode = document.getElementById("btnCopyCode");
    if (btnCopyCode) btnCopyCode.addEventListener("click", function() {
      var area = document.getElementById("transferCodeArea");
      if (!area) return;
      area.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(area.value).catch(function() {});
      }
      showToast("Код базы скопирован");
    });

    var btnImportCode = document.getElementById("btnImportCode");
    if (btnImportCode) btnImportCode.addEventListener("click", function() {
      var area = document.getElementById("transferCodeArea");
      if (!area || !area.value.trim()) return;
      try {
        var parsed = JSON.parse(area.value.trim());
        var norm = normalizeDb(parsed, state.defaultRate);
        state.workerName = norm.workerName || state.workerName;
        state.defaultRate = norm.defaultRate || state.defaultRate;
        state.records = norm.records;
        saveAllStorages(true);
        document.getElementById("restoreModal").classList.add("hidden");
        refreshAll();
        showToast("База загружена из кода (" + countRecords(state) + " зап.)");
      } catch (err) {
        showToast("Ошибка формата кода базы");
      }
    });
  }

  function init() {
    var now = new Date();
    var todayIso = toIso(now.getFullYear(), now.getMonth(), now.getDate());
    state.viewYear = now.getFullYear();
    state.viewMonth = now.getMonth();
    state.selectedStart = todayIso;
    state.selectedEnd = todayIso;

    bindEvents();
    refreshAll();

    loadAllStorages().then(function() {
      refreshAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
