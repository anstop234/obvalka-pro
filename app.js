(function () {
  "use strict";

  var APP_VERSION = "8.5";
  var STORAGE_KEY = "obvalka_pro_db_v8";
  var BACKUPS_KEY = "obvalka_pro_backups_v8";
  var IDB_NAME = "ObvalkaProDB";
  var IDB_STORE = "kv";
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

  var state = {
    viewYear: 2026,
    viewMonth: 10,
    selectedDate: "2026-11-22",
    rangeStart: "2026-11-22",
    rangeEnd: "2026-11-22",
    periodMode: "day",
    customRange: false,
    workerName: "",
    defaultRate: "",
    theme: "dark",
    records: [],
    updatedAt: 0
  };

  var backups = [];
  var undoStack = [];
  var undoTimer = null;
  var pendingPreviewText = "";
  var isDragging = false;
  var dragAnchor = null;

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function toIsoDate(y, mZero, d) {
    return y + "-" + pad2(mZero + 1) + "-" + pad2(d);
  }

  function parseIso(iso) {
    var parts = (iso || "").split("-");
    if (parts.length !== 3) return new Date(2026, 10, 22);
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }

  function dateToIso(dt) {
    return toIsoDate(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  function formatRuDayMonth(iso) {
    var dt = parseIso(iso);
    return dt.getDate() + " " + MONTHS_GEN[dt.getMonth()];
  }

  function formatRuShort(iso) {
    var dt = parseIso(iso);
    return dt.getDate() + " " + MONTHS_SHORT[dt.getMonth()];
  }

  function parseNum(val) {
    if (typeof val === "number") return isFinite(val) ? val : 0;
    if (!val) return 0;
    var s = String(val).replace(",", ".").trim();
    var out = "";
    var dotSeen = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= "0" && ch <= "9") {
        out += ch;
      } else if (ch === "." && !dotSeen) {
        out += ".";
        dotSeen = true;
      }
    }
    var n = parseFloat(out);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + 1e-9) * 100) / 100;
  }

  function fmtNum(n) {
    var r = round2(n);
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function normalizeRecord(raw, fallbackRate) {
    if (!raw || typeof raw !== "object") return null;
    var date = raw.date || raw.d || state.selectedDate;
    var isOff = Boolean(raw.isOff || raw.off || raw.dayOff);
    var boxes = Math.round(parseNum(raw.boxes !== undefined ? raw.boxes : raw.b));
    var boxWeight = parseNum(raw.boxWeight !== undefined ? raw.boxWeight : raw.bw);
    var weight = parseNum(
      raw.weight !== undefined ? raw.weight :
      (raw.totalWeight !== undefined ? raw.totalWeight : raw.w)
    );
    if (!isOff && weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round2(boxes * boxWeight);
    }
    var rate = parseNum(raw.rate !== undefined ? raw.rate : raw.r);
    if (!isOff && rate <= 0 && fallbackRate > 0) {
      rate = fallbackRate;
    }
    var pay = parseNum(
      raw.pay !== undefined ? raw.pay :
      (raw.totalPay !== undefined ? raw.totalPay : raw.sum)
    );
    if (!isOff && weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    }
    if (!isOff && boxes === 0 && weight === 0 && pay === 0) {
      isOff = true;
    }
    return {
      id: raw.id || (Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
      date: date,
      isOff: isOff,
      boxes: isOff ? 0 : boxes,
      boxWeight: isOff ? 0 : round2(boxWeight),
      weight: isOff ? 0 : round2(weight),
      rate: isOff ? 0 : round2(rate),
      pay: isOff ? 0 : round2(pay)
    };
  }

  function migratePayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    var defRate = parseNum(payload.defaultRate || payload.rate || 9.5);
    var rawList = Array.isArray(payload.records) ? payload.records : [];
    var clean = [];
    for (var i = 0; i < rawList.length; i++) {
      var item = normalizeRecord(rawList[i], defRate);
      if (item) clean.push(item);
    }
    return {
      workerName: payload.workerName || payload.name || "",
      defaultRate: defRate > 0 ? String(defRate) : "",
      theme: payload.theme === "light" ? "light" : "dark",
      records: clean,
      updatedAt: Number(payload.updatedAt) || 0
    };
  }

  function openIDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = function (e) {
          resolve(e.target.result);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (err) {
        resolve(null);
      }
    });
  }

  function idbGet(key) {
    return openIDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readonly");
          var store = tx.objectStore(IDB_STORE);
          var req = store.get(key);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          var store = tx.objectStore(IDB_STORE);
          store.put(val, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function readWindowName() {
    try {
      if (!window.name || window.name.indexOf("OBVALKA_DB:") !== 0) return null;
      var jsonStr = window.name.slice("OBVALKA_DB:".length);
      return JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }
  }

  function writeWindowName(obj) {
    try {
      window.name = "OBVALKA_DB:" + JSON.stringify(obj);
    } catch (e) {}
  }

  function getSnapshotObject() {
    return {
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      theme: state.theme,
      records: state.records,
      updatedAt: state.updatedAt
    };
  }

  function persistAll(touchTime) {
    if (touchTime !== false) {
      state.updatedAt = Date.now();
    }
    var snap = getSnapshotObject();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      localStorage.setItem(BACKUPS_KEY, JSON.stringify(backups));
    } catch (e) {}
    writeWindowName({ db: snap, backups: backups });
    return Promise.all([
      idbSet(STORAGE_KEY, snap),
      idbSet(BACKUPS_KEY, backups)
    ]);
  }

  function pickBestSource(candidates) {
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = migratePayload(candidates[i]);
      if (!c) continue;
      if (!best) {
        best = c;
        continue;
      }
      if (c.updatedAt > best.updatedAt) {
        best = c;
      } else if (c.updatedAt === best.updatedAt && c.records.length > best.records.length) {
        best = c;
      }
    }
    return best;
  }

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.classList.remove("show");
    }, 2800);
  }

  function computeRangeForMode(baseIso, mode) {
    var dt = parseIso(baseIso);
    var y = dt.getFullYear();
    var m = dt.getMonth();
    var d = dt.getDate();

    if (mode === "day") {
      return { start: baseIso, end: baseIso };
    }
    if (mode === "week") {
      var dow = dt.getDay();
      var diffToMon = dow === 0 ? -6 : 1 - dow;
      var mon = new Date(y, m, d + diffToMon);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      return { start: dateToIso(mon), end: dateToIso(sun) };
    }
    if (mode === "two_weeks") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (d <= 15) {
        return { start: toIsoDate(y, m, 1), end: toIsoDate(y, m, 15) };
      } else {
        return { start: toIsoDate(y, m, 16), end: toIsoDate(y, m, lastDay) };
      }
    }
    if (mode === "month") {
      var lastM = new Date(y, m + 1, 0).getDate();
      return { start: toIsoDate(y, m, 1), end: toIsoDate(y, m, lastM) };
    }
    if (mode === "year") {
      return { start: toIsoDate(y, 0, 1), end: toIsoDate(y, 11, 31) };
    }
    return { start: baseIso, end: baseIso };
  }

  function setPeriodMode(mode) {
    state.periodMode = mode;
    state.customRange = false;
    var r = computeRangeForMode(state.selectedDate, mode);
    state.rangeStart = r.start;
    state.rangeEnd = r.end;
    refreshAll();
  }

  function selectSingleDay(iso) {
    state.selectedDate = iso;
    var dt = parseIso(iso);
    state.viewYear = dt.getFullYear();
    state.viewMonth = dt.getMonth();
    state.customRange = false;
    var r = computeRangeForMode(iso, state.periodMode);
    state.rangeStart = r.start;
    state.rangeEnd = r.end;
    refreshAll();
  }

  function selectCustomSpan(isoA, isoB) {
    var start = isoA <= isoB ? isoA : isoB;
    var end = isoA <= isoB ? isoB : isoA;
    state.selectedDate = isoB;
    state.rangeStart = start;
    state.rangeEnd = end;
    state.customRange = start !== end;
    refreshAll();
  }

  function getRangeRecords() {
    var s = state.rangeStart;
    var e = state.rangeEnd;
    return state.records.filter(function (r) {
      return r.date >= s && r.date <= e;
    }).sort(function (a, b) {
      return a.date.localeCompare(b.date);
    });
  }

  function getPeriodTitle() {
    if (state.customRange && state.rangeStart !== state.rangeEnd) {
      return formatRuShort(state.rangeStart) + " – " + formatRuShort(state.rangeEnd);
    }
    if (state.periodMode === "day") {
      return "ДЕНЬ (" + formatRuShort(state.selectedDate).toUpperCase() + ")";
    }
    if (state.periodMode === "week") {
      return "НЕДЕЛЯ (" + formatRuShort(state.rangeStart) + " – " + formatRuShort(state.rangeEnd) + ")";
    }
    if (state.periodMode === "two_weeks") {
      return "2Х НЕДЕЛИ (" + formatRuShort(state.rangeStart) + " – " + formatRuShort(state.rangeEnd) + ")";
    }
    if (state.periodMode === "month") {
      var dt = parseIso(state.selectedDate);
      return "МЕСЯЦ (" + MONTHS_NOM[dt.getMonth()].toUpperCase() + ")";
    }
    if (state.periodMode === "year") {
      var dtY = parseIso(state.selectedDate);
      return "ГОД (" + dtY.getFullYear() + ")";
    }
    return "ДЕНЬ";
  }

  function renderCalendar() {
    var titleEl = document.getElementById("monthTitle");
    if (titleEl) {
      titleEl.innerHTML = MONTHS_NOM[state.viewMonth] + " " + state.viewYear + ' <span class="ver-badge">v ' + APP_VERSION + "</span>";
    }

    var btns = document.querySelectorAll(".period-btn");
    for (var i = 0; i < btns.length; i++) {
      var m = btns[i].getAttribute("data-period");
      if (!state.customRange && m === state.periodMode) {
        btns[i].classList.add("active");
      } else {
        btns[i].classList.remove("active");
      }
    }

    var grid = document.getElementById("calGrid");
    if (!grid) return;

    var recMap = {};
    var offMap = {};
    for (var r = 0; r < state.records.length; r++) {
      var item = state.records[r];
      if (item.isOff) {
        offMap[item.date] = true;
      } else {
        recMap[item.date] = true;
      }
    }

    var firstDay = new Date(state.viewYear, state.viewMonth, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var daysInMonth = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(state.viewYear, state.viewMonth, 0).getDate();

    var cells = [];
    for (var p = startOffset - 1; p >= 0; p--) {
      var py = state.viewMonth === 0 ? state.viewYear - 1 : state.viewYear;
      var pm = state.viewMonth === 0 ? 11 : state.viewMonth - 1;
      var pd = prevMonthDays - p;
      cells.push({ iso: toIsoDate(py, pm, pd), day: pd, other: true });
    }
    for (var d = 1; d <= daysInMonth; d++) {
      cells.push({ iso: toIsoDate(state.viewYear, state.viewMonth, d), day: d, other: false });
    }
    var rem = cells.length % 7;
    if (rem !== 0) {
      var need = 7 - rem;
      var ny = state.viewMonth === 11 ? state.viewYear + 1 : state.viewYear;
      var nm = state.viewMonth === 11 ? 0 : state.viewMonth + 1;
      for (var n = 1; n <= need; n++) {
        cells.push({ iso: toIsoDate(ny, nm, n), day: n, other: true });
      }
    }

    var html = "";
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c];
      var cls = ["day-cell"];
      if (cell.other) cls.push("other-month");

      var inRange = cell.iso >= state.rangeStart && cell.iso <= state.rangeEnd;
      var isSingleActive = cell.iso === state.selectedDate && state.rangeStart === state.rangeEnd;
      var isRangeEdge = inRange && state.rangeStart !== state.rangeEnd && (cell.iso === state.rangeStart || cell.iso === state.rangeEnd);

      if (isSingleActive || isRangeEdge) {
        cls.push("selected");
      } else if (inRange && state.rangeStart !== state.rangeEnd) {
        cls.push("in-range");
      }

      if (offMap[cell.iso]) {
        cls.push("has-off");
      } else if (recMap[cell.iso]) {
        cls.push("has-record");
      }

      var markHtml = "";
      if (offMap[cell.iso]) {
        markHtml = '<span class="off-mark">✕</span>';
      } else if (recMap[cell.iso]) {
        markHtml = '<span class="rec-dot"></span>';
      }

      html += '<div class="' + cls.join(" ") + '" data-date="' + cell.iso + '"><span>' + cell.day + "</span>" + markHtml + "</div>";
    }

    grid.innerHTML = html;
  }

  function renderRecordsAndSummary() {
    var list = getRangeRecords();
    var pTitle = getPeriodTitle();

    var headerEl = document.getElementById("recordsHeaderTitle");
    if (headerEl) headerEl.textContent = "ЗАПИСИ (" + pTitle + ")";

    var countEl = document.getElementById("recordsCountBadge");
    if (countEl) countEl.textContent = list.length + " ШТ.";

    var sumTitleEl = document.getElementById("summaryTitle");
    if (sumTitleEl) sumTitleEl.textContent = "ИТОГ ЗА " + pTitle;

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;

    for (var i = 0; i < list.length; i++) {
      if (!list[i].isOff) {
        totalBoxes += list[i].boxes;
        totalWeight = round2(totalWeight + list[i].weight);
        totalPay = round2(totalPay + list[i].pay);
      }
    }

    var bwEl = document.getElementById("summaryBoxesWeight");
    if (bwEl) bwEl.textContent = totalBoxes + " кор. • " + fmtNum(totalWeight) + " кг";

    var payEl = document.getElementById("summaryMoney");
    if (payEl) payEl.textContent = fmtNum(totalPay) + " ₽";

    var listEl = document.getElementById("recordsList");
    if (!listEl) return;

    if (list.length === 0) {
      listEl.innerHTML = "";
      return;
    }

    var rowsHtml = "";
    for (var j = 0; j < list.length; j++) {
      var r = list[j];
      var dLabel = formatRuShort(r.date);
      if (r.isOff) {
        rowsHtml +=
          '<div class="record-row is-off">' +
          '<div class="record-text">' + dLabel + ': <span class="off-tag">Выходной</span></div>' +
          '<button type="button" class="del-rec-btn" data-id="' + r.id + '" title="Удалить">✕</button>' +
          "</div>";
      } else {
        var boxPart = r.boxes > 0 ? (r.boxes + " кор. • ") : "";
        rowsHtml +=
          '<div class="record-row">' +
          '<div class="record-text">' + dLabel + ": " + boxPart + fmtNum(r.weight) + " кг × " + fmtNum(r.rate) + ' ₽ = <span class="money-tag">' + fmtNum(r.pay) + " ₽</span></div>" +
          '<button type="button" class="del-rec-btn" data-id="' + r.id + '" title="Удалить">✕</button>' +
          "</div>";
      }
    }
    listEl.innerHTML = rowsHtml;

    var selLabelEl = document.getElementById("selectedDateLabel");
    if (selLabelEl) selLabelEl.textContent = formatRuDayMonth(state.selectedDate);
  }

  function updateShiftPreview() {
    var boxes = Math.round(parseNum(document.getElementById("boxesInput").value));
    var boxW = parseNum(document.getElementById("boxWeightInput").value);
    var rate = parseNum(document.getElementById("rateInput").value);

    var weight = 0;
    if (boxes > 0 && boxW > 0) {
      weight = round2(boxes * boxW);
    } else if (boxW > 0) {
      weight = round2(boxW);
    }
    var pay = round2(weight * rate);

    var prevEl = document.getElementById("shiftPreviewVal");
    if (prevEl) {
      prevEl.innerHTML =
        '<span class="w-val">' + fmtNum(weight) + ' кг</span> <span class="m-val">' + fmtNum(pay) + " ₽</span>";
    }
  }

  function refreshAll() {
    document.body.setAttribute("data-theme", state.theme);
    var themeBtn = document.getElementById("themeBtn");
    if (themeBtn) themeBtn.textContent = state.theme === "dark" ? "☀" : "🌙";

    var nameInput = document.getElementById("workerNameInput");
    if (nameInput && nameInput.value !== state.workerName) {
      nameInput.value = state.workerName;
    }
    var rateInput = document.getElementById("rateInput");
    if (rateInput && !rateInput.value && state.defaultRate) {
      rateInput.value = state.defaultRate;
    }

    renderCalendar();
    renderRecordsAndSummary();
    updateShiftPreview();
  }

  function createDailyAutoBackupIfNeeded() {
    var today = dateToIso(new Date());
    var tag = "Авто " + today;
    var exists = backups.some(function (b) {
      return b.label === tag;
    });
    if (!exists) {
      backups.unshift({
        id: "auto_" + Date.now(),
        label: tag,
        createdAt: new Date().toLocaleString("ru-RU"),
        isAuto: true,
        data: getSnapshotObject()
      });
      if (backups.length > 25) backups.length = 25;
    }
  }

  function addShiftRecord() {
    var boxes = Math.round(parseNum(document.getElementById("boxesInput").value));
    var boxW = parseNum(document.getElementById("boxWeightInput").value);
    var rate = parseNum(document.getElementById("rateInput").value);

    var weight = 0;
    if (boxes > 0 && boxW > 0) {
      weight = round2(boxes * boxW);
    } else if (boxW > 0) {
      weight = round2(boxW);
    }

    if (weight <= 0) {
      showToast("Введите вес коробки (кг)");
      return;
    }

    if (rate > 0) {
      state.defaultRate = String(rate);
    }

    var pay = round2(weight * rate);
    state.records.push({
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      date: state.selectedDate,
      isOff: false,
      boxes: boxes,
      boxWeight: round2(boxW),
      weight: weight,
      rate: round2(rate),
      pay: pay
    });

    document.getElementById("boxesInput").value = "";
    document.getElementById("boxWeightInput").value = "";

    createDailyAutoBackupIfNeeded();
    persistAll(true);
    refreshAll();
    showToast("Запись добавлена");
  }

  function toggleDayOff() {
    var target = state.selectedDate;
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].date === target && state.records[i].isOff) {
        idx = i;
        break;
      }
    }
    if (idx !== -1) {
      state.records.splice(idx, 1);
      showToast("Выходной снят");
    } else {
      state.records.push({
        id: Date.now() + "_off",
        date: target,
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      });
      createDailyAutoBackupIfNeeded();
      showToast("Отмечен выходной");
    }
    persistAll(true);
    refreshAll();
  }

  function deleteRecordById(id) {
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    var removed = state.records.splice(idx, 1)[0];
    undoStack.push(removed);
    persistAll(true);
    refreshAll();
    showUndoBanner();
  }

  function showUndoBanner() {
    var banner = document.getElementById("undoBanner");
    var btn = document.getElementById("undoDeleteBtn");
    if (!banner || !btn) return;
    btn.textContent = "↩ Вернуть удалённое (" + undoStack.length + ")";
    banner.style.display = "block";
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () {
      undoStack = [];
      banner.style.display = "none";
    }, 9000);
  }

  function undoLastDelete() {
    if (undoStack.length === 0) return;
    var item = undoStack.pop();
    state.records.push(item);
    persistAll(true);
    refreshAll();
    if (undoStack.length > 0) {
      showUndoBanner();
    } else {
      document.getElementById("undoBanner").style.display = "none";
    }
    showToast("Запись восстановлена");
  }

  function buildFullReportText() {
    var list = getRangeRecords();
    var lines = [];
    if (state.workerName.trim()) {
      lines.push(state.workerName.trim());
    }
    var periodLine = state.rangeStart === state.rangeEnd
      ? formatRuDayMonth(state.rangeStart)
      : formatRuShort(state.rangeStart) + " – " + formatRuShort(state.rangeEnd);
    lines.push("Период: " + periodLine);

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.isOff) {
        lines.push(formatRuShort(r.date) + " | Выходной");
      } else {
        totalBoxes += r.boxes;
        totalWeight = round2(totalWeight + r.weight);
        totalPay = round2(totalPay + r.pay);
        var bStr = r.boxes > 0 ? (r.boxes + "кор | ") : "";
        lines.push(formatRuShort(r.date) + " | " + bStr + fmtNum(r.weight) + "кг | " + fmtNum(r.pay) + "₽");
      }
    }

    lines.push("ИТОГ: " + totalBoxes + "кор | " + fmtNum(totalWeight) + "кг | " + fmtNum(totalPay) + "₽");
    return lines.join(NL);
  }

  function buildShortReportText() {
    var list = getRangeRecords();
    var lines = [];
    if (state.workerName.trim()) {
      lines.push(state.workerName.trim());
    }
    if (state.customRange && state.rangeStart !== state.rangeEnd) {
      lines.push("Период: " + formatRuShort(state.rangeStart) + " – " + formatRuShort(state.rangeEnd));
    }

    var totalBoxes = 0;
    var totalWeight = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].isOff) {
        totalBoxes += list[i].boxes;
        totalWeight = round2(totalWeight + list[i].weight);
      }
    }
    lines.push("Вес: " + fmtNum(totalWeight) + " кг " + totalBoxes + " кор.");
    return lines.join(NL);
  }

  function openReportPreview(text) {
    pendingPreviewText = text;
    var box = document.getElementById("previewTextBox");
    var modal = document.getElementById("previewModal");
    if (box) box.textContent = text;
    if (modal) modal.style.display = "flex";
  }

  function sendPreviewReport() {
    var text = pendingPreviewText;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
    document.getElementById("previewModal").style.display = "none";

    if (navigator.share) {
      navigator.share({
        title: "Отчёт обвалки",
        text: text
      }).catch(function () {});
      return;
    }

    var encoded = encodeURIComponent(text);
    var ua = (navigator.userAgent || "").toLowerCase();
    if (ua.indexOf("android") !== -1) {
      window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encoded + ";end";
    } else {
      showToast("Отчёт скопирован в буфер обмена");
    }
  }

  function saveManualBackup() {
    var now = new Date();
    var label = "Копия " + pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes());
    backups.unshift({
      id: "man_" + Date.now(),
      label: label,
      createdAt: now.toLocaleString("ru-RU"),
      isAuto: false,
      data: getSnapshotObject()
    });
    if (backups.length > 25) backups.length = 25;
    persistAll(false);
    showToast("Резервная копия сохранена");
  }

  function renderBackupsList() {
    var listEl = document.getElementById("backupsList");
    if (!listEl) return;
    if (backups.length === 0) {
      listEl.innerHTML = '<div class="empty-msg">Сохранённых копий пока нет</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < backups.length; i++) {
      var b = backups[i];
      var cnt = (b.data && Array.isArray(b.data.records)) ? b.data.records.length : 0;
      html +=
        '<div class="backup-item">' +
        '<div class="backup-info"><strong>' + b.label + "</strong><span>Записей: " + cnt + " • " + (b.createdAt || "") + "</span></div>" +
        '<div class="backup-actions">' +
        '<button type="button" class="mini-btn restore" data-bidx="' + i + '">Восстановить</button>' +
        '<button type="button" class="mini-btn del" data-delidx="' + i + '">✕</button>' +
        "</div>" +
        "</div>";
    }
    listEl.innerHTML = html;
  }

  function openRestoreModal() {
    document.getElementById("transferCodeBox").style.display = "none";
    renderBackupsList();
    document.getElementById("restoreModal").style.display = "flex";
  }

  function applyBackupIndex(idx) {
    var b = backups[idx];
    if (!b || !b.data) return;
    var migrated = migratePayload(b.data);
    if (!migrated) return;
    state.workerName = migrated.workerName;
    state.defaultRate = migrated.defaultRate;
    state.records = migrated.records;
    persistAll(true);
    refreshAll();
    document.getElementById("restoreModal").style.display = "none";
    showToast("База восстановлена (" + state.records.length + " зап.)");
  }

  function deleteBackupIndex(idx) {
    backups.splice(idx, 1);
    persistAll(false);
    renderBackupsList();
    showToast("Копия удалена");
  }

  function showTransferCodeArea() {
    var box = document.getElementById("transferCodeBox");
    var ta = document.getElementById("transferCodeInput");
    box.style.display = "block";
    try {
      var raw = JSON.stringify(getSnapshotObject());
      ta.value = btoa(unescape(encodeURIComponent(raw)));
    } catch (e) {
      ta.value = JSON.stringify(getSnapshotObject());
    }
  }

  function copyTransferCode() {
    var ta = document.getElementById("transferCodeInput");
    ta.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).catch(function () {});
    }
    showToast("Код базы скопирован");
  }

  function importTransferCode() {
    var val = (document.getElementById("transferCodeInput").value || "").trim();
    if (!val) {
      showToast("Вставьте код базы");
      return;
    }
    try {
      var parsed = null;
      if (val.charAt(0) === "{") {
        parsed = JSON.parse(val);
      } else {
        var decoded = decodeURIComponent(escape(atob(val)));
        parsed = JSON.parse(decoded);
      }
      var migrated = migratePayload(parsed);
      if (!migrated) throw new Error("bad");
      state.workerName = migrated.workerName;
      state.defaultRate = migrated.defaultRate;
      state.records = migrated.records;
      persistAll(true);
      refreshAll();
      document.getElementById("restoreModal").style.display = "none";
      showToast("База перенесена (" + state.records.length + " зап.)");
    } catch (e) {
      showToast("Неверный код базы");
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function runSafeUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: обновите через Ctrl+F5");
      return;
    }
    var overlay = document.getElementById("updateOverlay");
    var stepText = document.getElementById("updateStepText");
    overlay.style.display = "flex";

    stepText.textContent = "Шаг 1/4: Сохранение базы в память...";
    backups.unshift({
      id: "upd_" + Date.now(),
      label: "Авто (перед обн. v" + APP_VERSION + ")",
      createdAt: new Date().toLocaleString("ru-RU"),
      isAuto: true,
      data: getSnapshotObject()
    });
    if (backups.length > 25) backups.length = 25;

    persistAll(true)
      .then(function () {
        return sleep(700);
      })
      .then(function () {
        stepText.textContent = "Шаг 2/4: Проверка целостности (" + state.records.length + " зап.)...";
        return sleep(700);
      })
      .then(function () {
        stepText.textContent = "Шаг 3/4: Очистка старого кэша...";
        var tasks = [];
        if (window.caches && window.caches.keys) {
          tasks.push(
            window.caches.keys().then(function (names) {
              return Promise.all(names.map(function (n) { return window.caches.delete(n); }));
            })
          );
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          tasks.push(
            navigator.serviceWorker.getRegistrations().then(function (regs) {
              return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
            })
          );
        }
        return Promise.all(tasks).then(function () { return sleep(700); });
      })
      .then(function () {
        stepText.textContent = "Шаг 4/4: Перезагрузка на свежую версию...";
        return sleep(500);
      })
      .then(function () {
        var base = window.location.href.split("?")[0].split("#")[0];
        window.location.replace(base + "?v=" + Date.now());
      });
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").addEventListener("click", function () {
      if (state.viewMonth === 0) {
        state.viewMonth = 11;
        state.viewYear -= 1;
      } else {
        state.viewMonth -= 1;
      }
      selectSingleDay(toIsoDate(state.viewYear, state.viewMonth, 1));
    });

    document.getElementById("nextMonthBtn").addEventListener("click", function () {
      if (state.viewMonth === 11) {
        state.viewMonth = 0;
        state.viewYear += 1;
      } else {
        state.viewMonth += 1;
      }
      selectSingleDay(toIsoDate(state.viewYear, state.viewMonth, 1));
    });

    var periodBtns = document.querySelectorAll(".period-btn");
    for (var i = 0; i < periodBtns.length; i++) {
      periodBtns[i].addEventListener("click", function () {
        setPeriodMode(this.getAttribute("data-period"));
      });
    }

    var grid = document.getElementById("calGrid");
    grid.addEventListener("pointerdown", function (e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      var iso = cell.getAttribute("data-date");
      if (!iso) return;
      isDragging = true;
      dragAnchor = iso;
      selectSingleDay(iso);
    });

    grid.addEventListener("pointermove", function (e) {
      if (!isDragging || !dragAnchor) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      var cell = el.closest(".day-cell");
      if (!cell) return;
      var iso = cell.getAttribute("data-date");
      if (iso && iso !== state.rangeEnd) {
        selectCustomSpan(dragAnchor, iso);
      }
    });

    window.addEventListener("pointerup", function () {
      isDragging = false;
      dragAnchor = null;
    });

    document.getElementById("dayOffBtn").addEventListener("click", toggleDayOff);
    document.getElementById("addRecordBtn").addEventListener("click", addShiftRecord);
    document.getElementById("undoDeleteBtn").addEventListener("click", undoLastDelete);

    document.getElementById("recordsList").addEventListener("click", function (e) {
      var btn = e.target.closest(".del-rec-btn");
      if (!btn) return;
      deleteRecordById(btn.getAttribute("data-id"));
    });

    document.getElementById("workerNameInput").addEventListener("input", function () {
      state.workerName = this.value;
      persistAll(true);
    });

    document.getElementById("boxesInput").addEventListener("input", updateShiftPreview);
    document.getElementById("boxWeightInput").addEventListener("input", updateShiftPreview);
    document.getElementById("rateInput").addEventListener("input", function () {
      state.defaultRate = this.value;
      updateShiftPreview();
      persistAll(true);
    });

    document.getElementById("themeBtn").addEventListener("click", function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      persistAll(false);
      refreshAll();
    });

    document.getElementById("updateBtn").addEventListener("click", runSafeUpdate);

    document.getElementById("fullReportBtn").addEventListener("click", function () {
      openReportPreview(buildFullReportText());
    });
    document.getElementById("shortReportBtn").addEventListener("click", function () {
      openReportPreview(buildShortReportText());
    });

    document.getElementById("cancelPreviewBtn").addEventListener("click", function () {
      document.getElementById("previewModal").style.display = "none";
    });
    document.getElementById("sendPreviewBtn").addEventListener("click", sendPreviewReport);

    document.getElementById("saveBackupBtn").addEventListener("click", saveManualBackup);
    document.getElementById("openRestoreBtn").addEventListener("click", openRestoreModal);
    document.getElementById("closeRestoreBtn").addEventListener("click", function () {
      document.getElementById("restoreModal").style.display = "none";
    });

    document.getElementById("backupsList").addEventListener("click", function (e) {
      var rBtn = e.target.closest("[data-bidx]");
      if (rBtn) {
        applyBackupIndex(parseInt(rBtn.getAttribute("data-bidx"), 10));
        return;
      }
      var dBtn = e.target.closest("[data-delidx]");
      if (dBtn) {
        deleteBackupIndex(parseInt(dBtn.getAttribute("data-delidx"), 10));
      }
    });

    document.getElementById("toggleTransferBtn").addEventListener("click", showTransferCodeArea);
    document.getElementById("copyCodeBtn").addEventListener("click", copyTransferCode);
    document.getElementById("importCodeBtn").addEventListener("click", importTransferCode);
  }

  function bootstrap() {
    var today = new Date();
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth();
    var todayIso = dateToIso(today);
    state.selectedDate = todayIso;
    state.rangeStart = todayIso;
    state.rangeEnd = todayIso;

    var lsDb = null;
    var lsBackups = null;
    try {
      lsDb = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      lsBackups = JSON.parse(localStorage.getItem(BACKUPS_KEY) || "null");
    } catch (e) {}

    var wn = readWindowName();
    var wnDb = wn && wn.db ? wn.db : null;
    var wnBackups = wn && Array.isArray(wn.backups) ? wn.backups : null;

    Promise.all([idbGet(STORAGE_KEY), idbGet(BACKUPS_KEY)]).then(function (res) {
      var idbDb = res[0];
      var idbBackups = res[1];

      var best = pickBestSource([lsDb, idbDb, wnDb]);
      if (best) {
        state.workerName = best.workerName;
        state.defaultRate = best.defaultRate;
        state.theme = best.theme;
        state.records = best.records;
        state.updatedAt = best.updatedAt;
      }

      var bLists = [lsBackups, idbBackups, wnBackups];
      var bestB = [];
      for (var i = 0; i < bLists.length; i++) {
        if (Array.isArray(bLists[i]) && bLists[i].length > bestB.length) {
          bestB = bLists[i];
        }
      }
      backups = bestB;

      bindEvents();
      refreshAll();
      persistAll(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
