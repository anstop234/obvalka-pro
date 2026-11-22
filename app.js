(function () {
  "use strict";

  var APP_VERSION = "v 8.7";
  var STORAGE_KEY = "obvalka_pro_db_v1";
  var IDB_NAME = "ObvalkaProDB";
  var IDB_STORE = "stateStore";
  var IDB_KEY = "mainState";
  var NL = String.fromCharCode(10);

  var MONTHS_NOM = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
  ];
  var MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];
  var MONTHS_SHORT = [
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"
  ];

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toDateStr(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseDateStr(s) {
    var p = String(s || "").split("-");
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  }

  function parseNum(val) {
    if (typeof val === "number") return isFinite(val) ? val : 0;
    var s = String(val || "").replace(",", ".").trim();
    var out = "";
    var dot = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c >= "0" && c <= "9") out += c;
      else if (c === "." && !dot) { out += c; dot = true; }
    }
    var n = parseFloat(out);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function fmtNum(n) {
    var r = round2(n);
    return Number.isInteger(r) ? String(r) : String(r);
  }

  function fmtDateShort(ds) {
    var d = parseDateStr(ds);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function fmtDateFull(ds) {
    var d = parseDateStr(ds);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function defaultState() {
    var today = toDateStr(new Date());
    var now = new Date();
    return {
      records: [],
      backups: [],
      workerName: "",
      defaultRate: 9.5,
      theme: "dark",
      viewYear: now.getFullYear(),
      viewMonth: now.getMonth(),
      mode: "day",
      activeDate: today,
      rangeStart: today,
      rangeEnd: today,
      lastAutoBackupDate: "",
      updatedAt: 0
    };
  }

  var state = defaultState();
  var undoBuffer = [];
  var undoTimer = null;
  var undoCountdown = 0;
  var isDragging = false;
  var dragStartDate = null;
  var currentReportText = "";
  var pendingDeleteBackupIdx = -1;

  function normalizeRecord(rec, fallbackRate) {
    if (!rec || typeof rec !== "object") return null;
    var date = rec.date || rec.d || toDateStr(new Date());
    var isOff = Boolean(rec.isOff || rec.off || rec.type === "off");
    var boxes = Math.round(parseNum(rec.boxes !== undefined ? rec.boxes : rec.b));
    var boxWeight = parseNum(rec.boxWeight !== undefined ? rec.boxWeight : rec.bw);
    var weight = parseNum(
      rec.weight !== undefined ? rec.weight :
      (rec.totalWeight !== undefined ? rec.totalWeight : rec.w)
    );
    if (!isOff && weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round2(boxes * boxWeight);
    }
    var rate = parseNum(rec.rate !== undefined ? rec.rate : rec.r);
    if (!isOff && rate <= 0) {
      rate = fallbackRate > 0 ? fallbackRate : 9.5;
    }
    var pay = parseNum(
      rec.pay !== undefined ? rec.pay :
      (rec.totalPay !== undefined ? rec.totalPay : rec.sum)
    );
    if (!isOff && pay <= 0 && weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    }
    if (!isOff && boxes === 0 && weight === 0 && pay === 0) {
      isOff = true;
    }
    return {
      id: rec.id || (String(Date.now()) + "_" + Math.random().toString(36).slice(2, 7)),
      date: date,
      isOff: isOff,
      boxes: isOff ? 0 : boxes,
      boxWeight: isOff ? 0 : round2(boxWeight),
      weight: isOff ? 0 : round2(weight),
      rate: isOff ? 0 : round2(rate),
      pay: isOff ? 0 : round2(pay)
    };
  }

  function normalizeState(raw) {
    var base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    var defRate = parseNum(raw.defaultRate);
    if (defRate <= 0) defRate = 9.5;
    base.defaultRate = defRate;
    base.workerName = typeof raw.workerName === "string" ? raw.workerName : "";
    base.theme = raw.theme === "light" ? "light" : "dark";
    base.updatedAt = Number(raw.updatedAt) || 0;
    base.lastAutoBackupDate = typeof raw.lastAutoBackupDate === "string" ? raw.lastAutoBackupDate : "";
    if (Array.isArray(raw.records)) {
      base.records = raw.records.map(function (r) { return normalizeRecord(r, defRate); }).filter(Boolean);
    }
    if (Array.isArray(raw.backups)) {
      base.backups = raw.backups.map(function (b) {
        if (!b || typeof b !== "object") return null;
        var recs = Array.isArray(b.records) ? b.records.map(function (r) { return normalizeRecord(r, defRate); }).filter(Boolean) : [];
        return {
          id: b.id || String(Date.now() + Math.random()),
          label: b.label || "Копия",
          createdAt: Number(b.createdAt) || Date.now(),
          workerName: typeof b.workerName === "string" ? b.workerName : base.workerName,
          defaultRate: parseNum(b.defaultRate) || defRate,
          records: recs
        };
      }).filter(Boolean);
    }
    return base;
  }

  function openIDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { resolve(null); };
      } catch (err) {
        resolve(null);
      }
    });
  }

  function readIDB() {
    return openIDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readonly");
          var store = tx.objectStore(IDB_STORE);
          var req = store.get(IDB_KEY);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (err) {
          resolve(null);
        }
      });
    });
  }

  function writeIDB(payload) {
    return openIDB().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          var store = tx.objectStore(IDB_STORE);
          store.put(payload, IDB_KEY);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (err) {
          resolve(false);
        }
      });
    });
  }

  function readWindowName() {
    try {
      if (window.name && window.name.indexOf("OBVALKA_DB:") === 0) {
        return JSON.parse(window.name.slice(11));
      }
    } catch (e) {}
    return null;
  }

  function writeWindowName(payload) {
    try {
      window.name = "OBVALKA_DB:" + JSON.stringify(payload);
    } catch (e) {}
  }

  function persistState(touchTime) {
    if (touchTime !== false) {
      state.updatedAt = Date.now();
    }
    var snapshot = {
      records: state.records,
      backups: state.backups,
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      theme: state.theme,
      lastAutoBackupDate: state.lastAutoBackupDate,
      updatedAt: state.updatedAt
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {}
    writeWindowName(snapshot);
    return writeIDB(snapshot);
  }

  function pickBestCandidate(candidates) {
    var valid = candidates.filter(Boolean).map(normalizeState);
    if (!valid.length) return defaultState();
    valid.sort(function (a, b) {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      if (b.records.length !== a.records.length) return b.records.length - a.records.length;
      return b.backups.length - a.backups.length;
    });
    return valid[0];
  }

  function loadInitialState() {
    var lsData = null;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsData = JSON.parse(raw);
    } catch (e) {}
    var wnData = readWindowName();
    return readIDB().then(function (idbData) {
      var chosen = pickBestCandidate([lsData, idbData, wnData]);
      var now = new Date();
      var today = toDateStr(now);
      state.records = chosen.records;
      state.backups = chosen.backups;
      state.workerName = chosen.workerName;
      state.defaultRate = chosen.defaultRate;
      state.theme = chosen.theme;
      state.lastAutoBackupDate = chosen.lastAutoBackupDate;
      state.updatedAt = chosen.updatedAt || Date.now();
      state.viewYear = now.getFullYear();
      state.viewMonth = now.getMonth();
      state.mode = "day";
      state.activeDate = today;
      state.rangeStart = today;
      state.rangeEnd = today;
      return persistState(false);
    });
  }

  function showToast(msg, duration) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.classList.remove("show");
    }, duration || 2400);
  }

  function applyTheme() {
    if (state.theme === "light") {
      document.body.classList.add("light");
    } else {
      document.body.classList.remove("light");
    }
    var btn = document.getElementById("btnTheme");
    if (btn) btn.textContent = state.theme === "light" ? "🌙" : "☀️";
  }

  function computeRangeForMode(mode, anchorStr) {
    var d = parseDateStr(anchorStr);
    var y = d.getFullYear();
    var m = d.getMonth();
    var day = d.getDate();
    if (mode === "day") {
      return { start: anchorStr, end: anchorStr };
    }
    if (mode === "week") {
      var dow = d.getDay();
      var diffToMon = dow === 0 ? -6 : 1 - dow;
      var mon = new Date(y, m, day + diffToMon, 12, 0, 0);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 12, 0, 0);
      return { start: toDateStr(mon), end: toDateStr(sun) };
    }
    if (mode === "2weeks") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (day <= 15) {
        return { start: toDateStr(new Date(y, m, 1, 12)), end: toDateStr(new Date(y, m, 15, 12)) };
      } else {
        return { start: toDateStr(new Date(y, m, 16, 12)), end: toDateStr(new Date(y, m, lastDay, 12)) };
      }
    }
    if (mode === "month") {
      var ld = new Date(y, m + 1, 0).getDate();
      return { start: toDateStr(new Date(y, m, 1, 12)), end: toDateStr(new Date(y, m, ld, 12)) };
    }
    if (mode === "year") {
      return { start: y + "-01-01", end: y + "-12-31" };
    }
    return { start: anchorStr, end: anchorStr };
  }

  function setPeriodMode(mode, anchorStr) {
    state.mode = mode;
    var baseDate = anchorStr || state.activeDate;
    var r = computeRangeForMode(mode, baseDate);
    state.rangeStart = r.start;
    state.rangeEnd = r.end;
    var ad = parseDateStr(baseDate);
    state.viewYear = ad.getFullYear();
    state.viewMonth = ad.getMonth();
    refreshUI();
  }

  function updateTabsUI() {
    var tabs = document.querySelectorAll(".period-tab");
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute("data-mode") === state.mode) {
        t.classList.add("active");
      } else {
        t.classList.remove("active");
      }
    }
  }

  function renderCalendar() {
    var titleEl = document.getElementById("monthTitle");
    var verEl = document.getElementById("appVerBadge");
    var gridEl = document.getElementById("calGrid");
    if (titleEl) titleEl.textContent = MONTHS_NOM[state.viewMonth] + " " + state.viewYear;
    if (verEl) verEl.textContent = APP_VERSION;
    if (!gridEl) return;

    var dayMap = {};
    for (var i = 0; i < state.records.length; i++) {
      var rec = state.records[i];
      if (!dayMap[rec.date]) dayMap[rec.date] = { hasWork: false, hasOff: false };
      if (rec.isOff) dayMap[rec.date].hasOff = true;
      else dayMap[rec.date].hasWork = true;
    }

    var firstOfMonth = new Date(state.viewYear, state.viewMonth, 1, 12, 0, 0);
    var startDow = firstOfMonth.getDay();
    var offset = startDow === 0 ? 6 : startDow - 1;
    var startCellDate = new Date(state.viewYear, state.viewMonth, 1 - offset, 12, 0, 0);

    var rStart = state.rangeStart <= state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rEnd = state.rangeStart <= state.rangeEnd ? state.rangeEnd : state.rangeStart;
    var todayStr = toDateStr(new Date());

    gridEl.innerHTML = "";
    for (var cellIdx = 0; cellIdx < 42; cellIdx++) {
      var cur = new Date(startCellDate.getFullYear(), startCellDate.getMonth(), startCellDate.getDate() + cellIdx, 12, 0, 0);
      var ds = toDateStr(cur);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.setAttribute("data-date", ds);

      if (cur.getMonth() !== state.viewMonth) {
        cell.classList.add("other-month");
      }
      if (ds === todayStr) {
        cell.classList.add("today");
      }
      if (ds >= rStart && ds <= rEnd) {
        if (ds === rStart || ds === rEnd) {
          cell.classList.add("selected");
        } else {
          cell.classList.add("in-range");
        }
      }
      if (ds === state.activeDate && state.mode === "day") {
        cell.classList.add("selected");
      }

      var info = dayMap[ds];
      if (info && info.hasOff && !info.hasWork) {
        cell.classList.add("is-off");
        var numSpan = document.createElement("span");
        numSpan.textContent = String(cur.getDate());
        cell.appendChild(numSpan);
        var cross = document.createElement("span");
        cross.className = "off-cross";
        cross.textContent = "✕";
        cell.appendChild(cross);
      } else {
        cell.textContent = String(cur.getDate());
        if (info && info.hasWork) {
          var dot = document.createElement("span");
          dot.className = "dot-work";
          cell.appendChild(dot);
        }
      }
      gridEl.appendChild(cell);
    }
  }

  function getFilteredRecords() {
    var rStart = state.rangeStart <= state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rEnd = state.rangeStart <= state.rangeEnd ? state.rangeEnd : state.rangeStart;
    return state.records.filter(function (rec) {
      return rec.date >= rStart && rec.date <= rEnd;
    }).sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
  }

  function getPeriodLabel() {
    var rStart = state.rangeStart <= state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rEnd = state.rangeStart <= state.rangeEnd ? state.rangeEnd : state.rangeStart;
    if (rStart === rEnd) {
      return "ДЕНЬ (" + fmtDateShort(rStart).toUpperCase() + ")";
    }
    if (state.mode === "week") return "НЕДЕЛЯ";
    if (state.mode === "2weeks") return "2Х НЕДЕЛИ";
    if (state.mode === "month") return "МЕСЯЦ";
    if (state.mode === "year") return "ГОД";
    return fmtDateShort(rStart).toUpperCase() + " — " + fmtDateShort(rEnd).toUpperCase();
  }

  function renderRecordsAndTotals() {
    var recs = getFilteredRecords();
    var pLabel = getPeriodLabel();
    var headerTitle = document.getElementById("recordsHeaderTitle");
    var countBadge = document.getElementById("recordsCountBadge");
    var totalTitle = document.getElementById("totalBoxTitle");
    var totalBoxesWeight = document.getElementById("totalBoxesWeight");
    var totalMoney = document.getElementById("totalMoney");
    var listEl = document.getElementById("recordsList");

    if (headerTitle) headerTitle.textContent = "ЗАПИСИ (" + pLabel + ")";
    if (countBadge) countBadge.textContent = recs.length + " ШТ.";
    if (totalTitle) totalTitle.textContent = "ИТОГ ЗА " + pLabel;

    var sumBoxes = 0;
    var sumWeight = 0;
    var sumPay = 0;
    for (var i = 0; i < recs.length; i++) {
      if (!recs[i].isOff) {
        sumBoxes += recs[i].boxes;
        sumWeight = round2(sumWeight + recs[i].weight);
        sumPay = round2(sumPay + recs[i].pay);
      }
    }

    if (totalBoxesWeight) {
      totalBoxesWeight.textContent = sumBoxes + " кор. • " + fmtNum(sumWeight) + " кг";
    }
    if (totalMoney) {
      totalMoney.textContent = fmtNum(sumPay) + " ₽";
    }

    if (!listEl) return;
    listEl.innerHTML = "";
    for (var j = 0; j < recs.length; j++) {
      (function (item) {
        var row = document.createElement("div");
        row.className = "record-item" + (item.isOff ? " off-item" : "");
        var txt = document.createElement("div");
        txt.className = "record-text";
        if (item.isOff) {
          txt.textContent = fmtDateShort(item.date) + ": Выходной";
        } else {
          var parts = [];
          if (item.boxes > 0) parts.push(item.boxes + " кор.");
          parts.push(fmtNum(item.weight) + " кг × " + fmtNum(item.rate) + " ₽ = " + fmtNum(item.pay) + " ₽");
          txt.textContent = fmtDateShort(item.date) + ": " + parts.join(" • ");
        }
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-del-rec";
        delBtn.textContent = "✕";
        delBtn.addEventListener("click", function () {
          deleteRecord(item.id);
        });
        row.appendChild(txt);
        row.appendChild(delBtn);
        listEl.appendChild(row);
      })(recs[j]);
    }
  }

  function updateShiftPreview() {
    var boxesEl = document.getElementById("inpBoxes");
    var weightEl = document.getElementById("inpWeight");
    var rateEl = document.getElementById("inpRate");
    var prevEl = document.getElementById("shiftPreview");
    var dateEl = document.getElementById("selectedDateLabel");
    if (dateEl) dateEl.textContent = fmtDateFull(state.activeDate);
    if (!prevEl) return;

    var boxes = Math.round(parseNum(boxesEl ? boxesEl.value : 0));
    var bw = parseNum(weightEl ? weightEl.value : 0);
    var rate = parseNum(rateEl ? rateEl.value : state.defaultRate);
    var totalW = boxes > 0 ? round2(boxes * bw) : round2(bw);
    var totalP = round2(totalW * rate);
    prevEl.innerHTML = fmtNum(totalW) + " кг <span>" + fmtNum(totalP) + " ₽</span>";
  }

  function syncInputsFromState() {
    var nameEl = document.getElementById("inpWorker");
    var rateEl = document.getElementById("inpRate");
    if (nameEl && nameEl.value !== state.workerName) nameEl.value = state.workerName;
    if (rateEl && !rateEl.value) rateEl.value = fmtNum(state.defaultRate);
    updateShiftPreview();
  }

  function refreshUI() {
    applyTheme();
    updateTabsUI();
    renderCalendar();
    renderRecordsAndTotals();
    syncInputsFromState();
  }

  function triggerDailyAutoBackup() {
    var today = toDateStr(new Date());
    if (state.lastAutoBackupDate === today) return;
    state.lastAutoBackupDate = today;
    createBackupSnapshot("Авто " + fmtDateShort(today));
  }

  function createBackupSnapshot(label) {
    var snap = {
      id: String(Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
      label: label || ("Копия " + fmtDateShort(toDateStr(new Date()))),
      createdAt: Date.now(),
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      records: JSON.parse(JSON.stringify(state.records))
    };
    state.backups.unshift(snap);
    if (state.backups.length > 25) state.backups.length = 25;
  }

  function addShiftRecord() {
    var boxesEl = document.getElementById("inpBoxes");
    var weightEl = document.getElementById("inpWeight");
    var rateEl = document.getElementById("inpRate");
    var workerEl = document.getElementById("inpWorker");

    if (workerEl) state.workerName = workerEl.value.trim();
    var boxes = Math.round(parseNum(boxesEl ? boxesEl.value : 0));
    var bw = parseNum(weightEl ? weightEl.value : 0);
    var rate = parseNum(rateEl ? rateEl.value : state.defaultRate);
    if (rate > 0) state.defaultRate = rate;

    var totalW = boxes > 0 ? round2(boxes * bw) : round2(bw);
    if (totalW <= 0) {
      showToast("Введите вес коробки");
      return;
    }
    var totalP = round2(totalW * rate);
    var rec = {
      id: String(Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
      date: state.activeDate,
      isOff: false,
      boxes: boxes,
      boxWeight: round2(bw),
      weight: totalW,
      rate: round2(rate),
      pay: totalP
    };
    state.records.push(rec);
    triggerDailyAutoBackup();
    if (boxesEl) boxesEl.value = "";
    if (weightEl) weightEl.value = "";
    persistState(true);
    refreshUI();
    showToast("Запись добавлена");
  }

  function addOffDay() {
    var targetDate = state.activeDate;
    var exists = state.records.some(function (r) { return r.date === targetDate && r.isOff; });
    if (exists) {
      showToast("Выходной уже отмечен");
      return;
    }
    state.records.push({
      id: String(Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
      date: targetDate,
      isOff: true,
      boxes: 0,
      boxWeight: 0,
      weight: 0,
      rate: 0,
      pay: 0
    });
    triggerDailyAutoBackup();
    persistState(true);
    refreshUI();
    showToast("Отмечен выходной: " + fmtDateShort(targetDate));
  }

  function deleteRecord(id) {
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var removed = state.records.splice(idx, 1)[0];
    undoBuffer.push(removed);
    persistState(true);
    refreshUI();
    startUndoTimer();
  }

  function startUndoTimer() {
    var btn = document.getElementById("btnUndoDelete");
    var cntEl = document.getElementById("undoCount");
    if (!btn) return;
    undoCountdown = 7;
    btn.classList.add("show");
    if (cntEl) cntEl.textContent = undoCountdown + "с";
    clearInterval(undoTimer);
    undoTimer = setInterval(function () {
      undoCountdown--;
      if (cntEl) cntEl.textContent = undoCountdown + "с";
      if (undoCountdown <= 0) {
        clearInterval(undoTimer);
        undoBuffer = [];
        btn.classList.remove("show");
      }
    }, 1000);
  }

  function undoLastDelete() {
    if (!undoBuffer.length) return;
    var item = undoBuffer.pop();
    state.records.push(item);
    persistState(true);
    refreshUI();
    if (!undoBuffer.length) {
      clearInterval(undoTimer);
      var btn = document.getElementById("btnUndoDelete");
      if (btn) btn.classList.remove("show");
    }
    showToast("Запись возвращена");
  }

  function buildReportText(isFull) {
    var recs = getFilteredRecords();
    var rStart = state.rangeStart <= state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rEnd = state.rangeStart <= state.rangeEnd ? state.rangeEnd : state.rangeStart;
    var isCustomRange = state.mode === "day" && rStart !== rEnd;
    var lines = [];
    if (state.workerName) {
      lines.push(state.workerName);
    }
    var sumBoxes = 0;
    var sumWeight = 0;
    var sumPay = 0;
    for (var i = 0; i < recs.length; i++) {
      if (!recs[i].isOff) {
        sumBoxes += recs[i].boxes;
        sumWeight = round2(sumWeight + recs[i].weight);
        sumPay = round2(sumPay + recs[i].pay);
      }
    }
    if (!isFull) {
      if (isCustomRange) {
        lines.push("Период: " + fmtDateShort(rStart) + " — " + fmtDateShort(rEnd));
      }
      var wLine = "Вес: " + fmtNum(sumWeight) + " кг";
      if (sumBoxes > 0) wLine += " (" + sumBoxes + " кор.)";
      lines.push(wLine);
      lines.push("Итого: " + fmtNum(sumPay) + " ₽");
      return lines.join(NL);
    }
    var periodHeader = rStart === rEnd ? fmtDateFull(rStart) : (fmtDateShort(rStart) + " — " + fmtDateShort(rEnd));
    lines.push("Период: " + periodHeader);
    for (var j = 0; j < recs.length; j++) {
      var r = recs[j];
      if (r.isOff) {
        lines.push(fmtDateShort(r.date) + " | Выходной");
      } else {
        var seg = [fmtDateShort(r.date)];
        if (r.boxes > 0) seg.push(r.boxes + "кор");
        seg.push(fmtNum(r.weight) + "кг");
        seg.push(fmtNum(r.pay) + "₽");
        lines.push(seg.join(" | "));
      }
    }
    var totSeg = ["ИТОГ:"];
    if (sumBoxes > 0) totSeg.push(sumBoxes + "кор");
    totSeg.push(fmtNum(sumWeight) + "кг");
    totSeg.push(fmtNum(sumPay) + "₽");
    lines.push(totSeg.join(" | "));
    return lines.join(NL);
  }

  function openReportPreview(isFull) {
    currentReportText = buildReportText(isFull);
    var box = document.getElementById("reportPreviewText");
    var modal = document.getElementById("reportModal");
    if (box) box.textContent = currentReportText;
    if (modal) modal.classList.add("open");
  }

  function closeReportModal() {
    var modal = document.getElementById("reportModal");
    if (modal) modal.classList.remove("open");
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function shareReportText() {
    if (!currentReportText) return;
    copyToClipboard(currentReportText);
    if (navigator.share) {
      navigator.share({ text: currentReportText }).catch(function () {});
      return;
    }
    var encoded = encodeURIComponent(currentReportText);
    window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encoded + ";end";
    showToast("Текст скопирован");
  }

  function renderBackupList() {
    var list = document.getElementById("backupList");
    if (!list) return;
    list.innerHTML = "";
    if (!state.backups.length) {
      var empty = document.createElement("div");
      empty.style.fontSize = "12px";
      empty.style.color = "var(--text-sec)";
      empty.style.textAlign = "center";
      empty.style.padding = "12px";
      empty.textContent = "Сохранённых копий пока нет";
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.backups.length; i++) {
      (function (idx, b) {
        var row = document.createElement("div");
        row.className = "backup-item";
        var d = new Date(b.createdAt);
        var timeStr = pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
        var info = document.createElement("div");
        info.className = "backup-info";
        info.innerHTML = "<strong>" + b.label + " (" + timeStr + ")</strong><span>Записей: " + b.records.length + "</span>";

        var actions = document.createElement("div");
        actions.className = "backup-actions";

        var btnRes = document.createElement("button");
        btnRes.type = "button";
        btnRes.className = "btn-b-restore";
        btnRes.textContent = "Восст.";
        btnRes.addEventListener("click", function () {
          var norm = normalizeState(b);
          state.records = norm.records;
          if (norm.workerName) state.workerName = norm.workerName;
          if (norm.defaultRate > 0) state.defaultRate = norm.defaultRate;
          persistState(true);
          refreshUI();
          closeRestoreModal();
          showToast("Восстановлено записей: " + state.records.length);
        });

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "btn-b-del";
        btnDel.textContent = "✕";
        btnDel.addEventListener("click", function () {
          pendingDeleteBackupIdx = idx;
          var cm = document.getElementById("confirmModal");
          if (cm) cm.classList.add("open");
        });

        actions.appendChild(btnRes);
        actions.appendChild(btnDel);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
      })(i, state.backups[i]);
    }
  }

  function openRestoreModal() {
    var transferBox = document.getElementById("transferBox");
    if (transferBox) transferBox.classList.remove("open");
    renderBackupList();
    var modal = document.getElementById("restoreModal");
    if (modal) modal.classList.add("open");
  }

  function closeRestoreModal() {
    var modal = document.getElementById("restoreModal");
    if (modal) modal.classList.remove("open");
  }

  function encodeTransferCode() {
    var payload = {
      v: 1,
      w: state.workerName,
      r: state.defaultRate,
      d: state.records
    };
    var json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  }

  function importTransferCode(codeStr) {
    var clean = String(codeStr || "").trim();
    if (!clean) {
      showToast("Вставьте код переноса");
      return;
    }
    try {
      var json = decodeURIComponent(escape(atob(clean)));
      var obj = JSON.parse(json);
      var rawRecs = Array.isArray(obj.d) ? obj.d : (Array.isArray(obj.records) ? obj.records : []);
      var rate = parseNum(obj.r || obj.defaultRate) || state.defaultRate;
      state.records = rawRecs.map(function (r) { return normalizeRecord(r, rate); }).filter(Boolean);
      if (typeof obj.w === "string") state.workerName = obj.w;
      state.defaultRate = rate;
      persistState(true);
      refreshUI();
      closeRestoreModal();
      showToast("База загружена: " + state.records.length + " зап.");
    } catch (e) {
      showToast("Неверный формат кода");
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function runSafeUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: обновите через Ctrl+F5");
      return;
    }
    var overlay = document.getElementById("updateOverlay");
    var stepEl = document.getElementById("updateStepText");
    if (overlay) overlay.classList.add("open");
    if (stepEl) stepEl.textContent = "Шаг 1/3: Сохранение базы в память...";

    createBackupSnapshot("Перед обн. " + APP_VERSION);
    persistState(true)
      .then(function () {
        return sleep(650);
      })
      .then(function () {
        if (stepEl) stepEl.textContent = "Шаг 2/3: Очистка старого кэша...";
        var tasks = [];
        if (window.caches && caches.keys) {
          tasks.push(caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          }));
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          tasks.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
            return Promise.all(regs.map(function (r) { return r.unregister(); }));
          }));
        }
        return Promise.all(tasks);
      })
      .then(function () {
        return sleep(650);
      })
      .then(function () {
        if (stepEl) stepEl.textContent = "Шаг 3/3: Перезагрузка приложения...";
        return sleep(450);
      })
      .then(function () {
        var baseUrl = window.location.href.split("?")[0].split("#")[0];
        window.location.replace(baseUrl + "?v=" + Date.now());
      });
  }

  function handleCellSelectStart(ds) {
    if (!ds) return;
    if (state.mode !== "day") {
      state.activeDate = ds;
      setPeriodMode(state.mode, ds);
      return;
    }
    isDragging = true;
    dragStartDate = ds;
    state.activeDate = ds;
    state.rangeStart = ds;
    state.rangeEnd = ds;
    refreshUI();
  }

  function handleCellSelectMove(ds) {
    if (!isDragging || !dragStartDate || !ds || state.mode !== "day") return;
    if (state.rangeEnd === ds) return;
    state.rangeStart = dragStartDate;
    state.rangeEnd = ds;
    state.activeDate = ds;
    renderCalendar();
    renderRecordsAndTotals();
    updateShiftPreview();
  }

  function handleCellSelectEnd() {
    isDragging = false;
    dragStartDate = null;
  }

  function bindEvents() {
    var btnPrev = document.getElementById("btnPrevMonth");
    var btnNext = document.getElementById("btnNextMonth");
    if (btnPrev) {
      btnPrev.addEventListener("click", function () {
        state.viewMonth--;
        if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
        if (state.mode === "month" || state.mode === "year") {
          var anchor = state.viewYear + "-" + pad2(state.viewMonth + 1) + "-01";
          setPeriodMode(state.mode, anchor);
        } else {
          renderCalendar();
        }
      });
    }
    if (btnNext) {
      btnNext.addEventListener("click", function () {
        state.viewMonth++;
        if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
        if (state.mode === "month" || state.mode === "year") {
          var anchor = state.viewYear + "-" + pad2(state.viewMonth + 1) + "-01";
          setPeriodMode(state.mode, anchor);
        } else {
          renderCalendar();
        }
      });
    }

    var tabs = document.querySelectorAll(".period-tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener("click", function () {
          var m = tab.getAttribute("data-mode");
          setPeriodMode(m, state.activeDate);
        });
      })(tabs[i]);
    }

    var gridEl = document.getElementById("calGrid");
    if (gridEl) {
      gridEl.addEventListener("mousedown", function (e) {
        var cell = e.target.closest(".day-cell");
        if (cell) handleCellSelectStart(cell.getAttribute("data-date"));
      });
      gridEl.addEventListener("mouseover", function (e) {
        if (!isDragging) return;
        var cell = e.target.closest(".day-cell");
        if (cell) handleCellSelectMove(cell.getAttribute("data-date"));
      });
      gridEl.addEventListener("touchstart", function (e) {
        var touch = e.touches[0];
        if (!touch) return;
        var target = document.elementFromPoint(touch.clientX, touch.clientY);
        var cell = target ? target.closest(".day-cell") : null;
        if (cell) handleCellSelectStart(cell.getAttribute("data-date"));
      }, { passive: true });
      gridEl.addEventListener("touchmove", function (e) {
        if (!isDragging) return;
        var touch = e.touches[0];
        if (!touch) return;
        var target = document.elementFromPoint(touch.clientX, touch.clientY);
        var cell = target ? target.closest(".day-cell") : null;
        if (cell) handleCellSelectMove(cell.getAttribute("data-date"));
      }, { passive: true });
    }
    window.addEventListener("mouseup", handleCellSelectEnd);
    window.addEventListener("touchend", handleCellSelectEnd);

    var btnOff = document.getElementById("btnOffDay");
    if (btnOff) btnOff.addEventListener("click", addOffDay);

    var btnAdd = document.getElementById("btnAddRecord");
    if (btnAdd) btnAdd.addEventListener("click", addShiftRecord);

    var inpBoxes = document.getElementById("inpBoxes");
    var inpWeight = document.getElementById("inpWeight");
    var inpRate = document.getElementById("inpRate");
    var inpWorker = document.getElementById("inpWorker");

    if (inpBoxes) inpBoxes.addEventListener("input", updateShiftPreview);
    if (inpWeight) inpWeight.addEventListener("input", updateShiftPreview);
    if (inpRate) {
      inpRate.addEventListener("input", function () {
        var r = parseNum(inpRate.value);
        if (r > 0) {
          state.defaultRate = r;
          persistState(true);
        }
        updateShiftPreview();
      });
    }
    if (inpWorker) {
      inpWorker.addEventListener("input", function () {
        state.workerName = inpWorker.value.trim();
        persistState(true);
      });
    }

    var btnFullRep = document.getElementById("btnFullReport");
    var btnShortRep = document.getElementById("btnShortReport");
    if (btnFullRep) btnFullRep.addEventListener("click", function () { openReportPreview(true); });
    if (btnShortRep) btnShortRep.addEventListener("click", function () { openReportPreview(false); });

    var btnCancelRep = document.getElementById("btnCancelReport");
    var btnSendRep = document.getElementById("btnSendReport");
    if (btnCancelRep) btnCancelRep.addEventListener("click", closeReportModal);
    if (btnSendRep) btnSendRep.addEventListener("click", shareReportText);

    var btnSave = document.getElementById("btnSaveBackup");
    if (btnSave) {
      btnSave.addEventListener("click", function () {
        createBackupSnapshot("Ручная копия");
        persistState(true);
        showToast("База сохранена (" + state.records.length + " зап.)");
      });
    }

    var btnRestore = document.getElementById("btnOpenRestore");
    var btnCloseRes = document.getElementById("btnCloseRestore");
    if (btnRestore) btnRestore.addEventListener("click", openRestoreModal);
    if (btnCloseRes) btnCloseRes.addEventListener("click", closeRestoreModal);

    var btnToggleTransfer = document.getElementById("btnToggleTransfer");
    var btnCopyCode = document.getElementById("btnCopyCode");
    var btnImportCode = document.getElementById("btnImportCode");
    if (btnToggleTransfer) {
      btnToggleTransfer.addEventListener("click", function () {
        var tb = document.getElementById("transferBox");
        var ta = document.getElementById("transferTextarea");
        if (!tb) return;
        tb.classList.toggle("open");
        if (tb.classList.contains("open") && ta) {
          ta.value = encodeTransferCode();
        }
      });
    }
    if (btnCopyCode) {
      btnCopyCode.addEventListener("click", function () {
        var ta = document.getElementById("transferTextarea");
        var code = encodeTransferCode();
        if (ta) ta.value = code;
        copyToClipboard(code);
        showToast("Код базы скопирован");
      });
    }
    if (btnImportCode) {
      btnImportCode.addEventListener("click", function () {
        var ta = document.getElementById("transferTextarea");
        importTransferCode(ta ? ta.value : "");
      });
    }

    var btnConfirmNo = document.getElementById("btnConfirmNo");
    var btnConfirmYes = document.getElementById("btnConfirmYes");
    if (btnConfirmNo) {
      btnConfirmNo.addEventListener("click", function () {
        pendingDeleteBackupIdx = -1;
        var cm = document.getElementById("confirmModal");
        if (cm) cm.classList.remove("open");
      });
    }
    if (btnConfirmYes) {
      btnConfirmYes.addEventListener("click", function () {
        if (pendingDeleteBackupIdx >= 0 && pendingDeleteBackupIdx < state.backups.length) {
          state.backups.splice(pendingDeleteBackupIdx, 1);
          persistState(true);
          renderBackupList();
          showToast("Копия удалена");
        }
        pendingDeleteBackupIdx = -1;
        var cm = document.getElementById("confirmModal");
        if (cm) cm.classList.remove("open");
      });
    }

    var btnUndo = document.getElementById("btnUndoDelete");
    if (btnUndo) btnUndo.addEventListener("click", undoLastDelete);

    var btnTheme = document.getElementById("btnTheme");
    if (btnTheme) {
      btnTheme.addEventListener("click", function () {
        state.theme = state.theme === "light" ? "dark" : "light";
        persistState(true);
        applyTheme();
      });
    }

    var btnUpdate = document.getElementById("btnUpdate");
    if (btnUpdate) btnUpdate.addEventListener("click", runSafeUpdate);
  }

  function init() {
    bindEvents();
    refreshUI();
    loadInitialState().then(function () {
      refreshUI();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
