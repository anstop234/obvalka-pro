(function () {
  "use strict";

  var APP_VERSION = "8.4";
  var STORAGE_KEY = "obvalka_pro_state_v8";
  var DB_NAME = "ObvalkaProDB";
  var DB_STORE = "kv";
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

  var now = new Date();
  var state = {
    viewYear: now.getFullYear(),
    viewMonth: now.getMonth(),
    selectedStart: toKey(now),
    selectedEnd: toKey(now),
    periodMode: "day",
    isCustomRange: false,
    workerName: "",
    defaultRate: "",
    theme: "dark",
    records: [],
    backups: [],
    lastAutoBackupDate: "",
    updatedAt: 0
  };

  var deletedHistory = [];
  var pendingDeleteBackupIdx = -1;
  var dragActive = false;
  var dragAnchorKey = null;

  function toKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseKey(key) {
    var p = String(key || "").split("-");
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function cleanNum(val) {
    if (typeof val === "number") return isFinite(val) ? val : 0;
    var s = String(val || "").replace(",", ".").trim();
    var out = "";
    var dot = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch >= "0" && ch <= "9") out += ch;
      else if (ch === "." && !dot) { out += "."; dot = true; }
    }
    var n = parseFloat(out);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function normalizeRecord(raw, fallbackRate) {
    if (!raw || typeof raw !== "object") return null;
    var date = raw.date || raw.d || toKey(new Date());
    var isOff = Boolean(raw.isOff || raw.off || raw.type === "off");
    var boxes = Math.round(cleanNum(raw.boxes !== undefined ? raw.boxes : raw.b));
    var boxWeight = cleanNum(raw.boxWeight !== undefined ? raw.boxWeight : raw.bw);
    var weight = cleanNum(raw.weight !== undefined ? raw.weight : (raw.totalWeight !== undefined ? raw.totalWeight : raw.w));
    var rate = cleanNum(raw.rate !== undefined ? raw.rate : raw.r);
    if (rate <= 0 && fallbackRate > 0) rate = fallbackRate;

    if (!isOff && boxes === 0 && weight === 0 && cleanNum(raw.pay || raw.totalPay || raw.sum) === 0) {
      isOff = true;
    }

    if (isOff) {
      return {
        id: raw.id || (Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
        date: date,
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      };
    }

    if (weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round2(boxes * boxWeight);
    } else if (boxes > 0 && boxWeight > 0 && Math.abs(weight - boxWeight) < 0.001 && boxes > 1) {
      weight = round2(boxes * boxWeight);
    } else {
      weight = round2(weight);
    }

    var pay = round2(weight * rate);
    return {
      id: raw.id || (Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
      date: date,
      isOff: false,
      boxes: boxes,
      boxWeight: round2(boxWeight),
      weight: weight,
      rate: round2(rate),
      pay: pay
    };
  }

  function normalizePayload(data) {
    if (!data || typeof data !== "object") return null;
    var rate = cleanNum(data.defaultRate || data.rate || "");
    var recs = Array.isArray(data.records) ? data.records : [];
    var cleanRecs = [];
    for (var i = 0; i < recs.length; i++) {
      var nr = normalizeRecord(recs[i], rate);
      if (nr) cleanRecs.push(nr);
    }
    var bks = Array.isArray(data.backups) ? data.backups : [];
    return {
      workerName: String(data.workerName || ""),
      defaultRate: rate > 0 ? String(rate) : "",
      theme: data.theme === "light" ? "light" : "dark",
      records: cleanRecs,
      backups: bks,
      lastAutoBackupDate: String(data.lastAutoBackupDate || ""),
      updatedAt: Number(data.updatedAt) || 0
    };
  }

  function getSerializableState() {
    return {
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      theme: state.theme,
      records: state.records,
      backups: state.backups,
      lastAutoBackupDate: state.lastAutoBackupDate,
      updatedAt: state.updatedAt || Date.now()
    };
  }

  function idbOpen() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(DB_STORE, "readonly");
          var req = tx.objectStore(DB_STORE).get(key);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).put(val, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function saveAllStorages(touchTimestamp) {
    if (touchTimestamp !== false) state.updatedAt = Date.now();
    var payload = getSerializableState();
    var json = JSON.stringify(payload);
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    try { window.name = "OBV_BAK:" + json; } catch (e) {}
    return idbSet(STORAGE_KEY, payload);
  }

  function pickBestCandidate(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var cand = normalizePayload(list[i]);
      if (!cand) continue;
      if (!best) { best = cand; continue; }
      var candScore = cand.records.length * 10 + cand.backups.length;
      var bestScore = best.records.length * 10 + best.backups.length;
      if (cand.updatedAt > best.updatedAt && candScore >= bestScore) {
        best = cand;
      } else if (candScore > bestScore) {
        best = cand;
      }
    }
    return best;
  }

  function loadInitialState() {
    var candidates = [];
    try {
      var lsRaw = localStorage.getItem(STORAGE_KEY);
      if (lsRaw) candidates.push(JSON.parse(lsRaw));
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBV_BAK:") === 0) {
        candidates.push(JSON.parse(window.name.slice(8)));
      }
    } catch (e) {}

    return idbGet(STORAGE_KEY).then(function (idbData) {
      if (idbData) candidates.push(idbData);
      var best = pickBestCandidate(candidates);
      if (best) {
        state.workerName = best.workerName;
        state.defaultRate = best.defaultRate;
        state.theme = best.theme;
        state.records = best.records;
        state.backups = best.backups;
        state.lastAutoBackupDate = best.lastAutoBackupDate;
        state.updatedAt = best.updatedAt || Date.now();
        saveAllStorages(false);
      }
    });
  }

  function showToast(msg, ms) {
    var el = document.getElementById("toastBox");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.style.display = "none"; }, ms || 2400);
  }

  function applyTheme() {
    if (state.theme === "light") {
      document.body.classList.add("light");
      document.getElementById("themeBtn").textContent = "🌙";
    } else {
      document.body.classList.remove("light");
      document.getElementById("themeBtn").textContent = "☀️";
    }
  }

  function getOrderedRange() {
    if (state.selectedStart <= state.selectedEnd) {
      return { start: state.selectedStart, end: state.selectedEnd };
    }
    return { start: state.selectedEnd, end: state.selectedStart };
  }

  function applyPeriodPreset(mode) {
    state.periodMode = mode;
    state.isCustomRange = false;
    var base = parseKey(state.selectedStart);
    var y = base.getFullYear();
    var m = base.getMonth();
    var d = base.getDate();

    if (mode === "day") {
      state.selectedEnd = state.selectedStart;
    } else if (mode === "week") {
      var dow = (base.getDay() + 6) % 7;
      var mon = new Date(y, m, d - dow);
      var sun = new Date(y, m, d - dow + 6);
      state.selectedStart = toKey(mon);
      state.selectedEnd = toKey(sun);
    } else if (mode === "twoWeeks") {
      if (d <= 15) {
        state.selectedStart = toKey(new Date(y, m, 1));
        state.selectedEnd = toKey(new Date(y, m, 15));
      } else {
        var lastD = new Date(y, m + 1, 0).getDate();
        state.selectedStart = toKey(new Date(y, m, 16));
        state.selectedEnd = toKey(new Date(y, m, lastD));
      }
    } else if (mode === "month") {
      var endM = new Date(y, m + 1, 0);
      state.selectedStart = toKey(new Date(y, m, 1));
      state.selectedEnd = toKey(endM);
    } else if (mode === "year") {
      state.selectedStart = y + "-01-01";
      state.selectedEnd = y + "-12-31";
    }
  }

  function renderCalendar() {
    var grid = document.getElementById("calGrid");
    var monthLbl = document.getElementById("monthLabel");
    if (!grid || !monthLbl) return;

    monthLbl.textContent = MONTHS_NOM[state.viewMonth] + " " + state.viewYear;
    var range = getOrderedRange();

    var dayFlags = {};
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      if (r.isOff) {
        if (!dayFlags[r.date]) dayFlags[r.date] = "off";
      } else {
        dayFlags[r.date] = "work";
      }
    }

    var firstDay = new Date(state.viewYear, state.viewMonth, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var daysInMonth = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
    var totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    grid.innerHTML = "";
    for (var c = 0; c < totalCells; c++) {
      var cellDate = new Date(state.viewYear, state.viewMonth, 1 - startOffset + c);
      var key = toKey(cellDate);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.dataset.key = key;
      cell.textContent = String(cellDate.getDate());

      if (cellDate.getMonth() !== state.viewMonth) cell.classList.add("other-month");
      if (key >= range.start && key <= range.end) {
        cell.classList.add("in-range");
        if (key === range.start || key === range.end) cell.classList.add("selected");
      }

      if (dayFlags[key]) {
        var dot = document.createElement("span");
        dot.className = "day-dot " + dayFlags[key];
        cell.appendChild(dot);
      }
      grid.appendChild(cell);
    }

    var tabs = document.querySelectorAll("#periodTabs .tab-btn");
    for (var t = 0; t < tabs.length; t++) {
      var btn = tabs[t];
      btn.classList.toggle("active", !state.isCustomRange && btn.dataset.mode === state.periodMode);
    }
  }

  function formatHumanDate(key) {
    var d = parseKey(key);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function formatShortDate(key) {
    var d = parseKey(key);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function getFilteredRecords() {
    var range = getOrderedRange();
    var list = [];
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      if (r.date >= range.start && r.date <= range.end) list.push(r);
    }
    list.sort(function (a, b) { return a.date.localeCompare(b.date); });
    return list;
  }

  function renderRecordsAndSummary() {
    var range = getOrderedRange();
    var list = getFilteredRecords();

    var modeNames = {
      day: "ДЕНЬ",
      week: "НЕДЕЛЯ",
      twoWeeks: "2Х НЕДЕЛИ",
      month: "МЕСЯЦ",
      year: "ГОД"
    };
    var tag = state.isCustomRange ? "ПЕРИОД" : (modeNames[state.periodMode] || "ДЕНЬ");
    document.getElementById("recordsHeader").textContent = "ЗАПИСИ (" + tag + ")";
    document.getElementById("recordsCount").textContent = list.length + " ШТ.";
    document.getElementById("sumPeriodTitle").textContent = "ИТОГ ЗА " + tag;

    if (range.start === range.end) {
      document.getElementById("selectedDateLabel").textContent = formatHumanDate(range.start);
    } else {
      document.getElementById("selectedDateLabel").textContent = formatShortDate(range.start) + " – " + formatShortDate(range.end);
    }

    var totBoxes = 0;
    var totWeight = 0;
    var totPay = 0;
    var container = document.getElementById("recordsList");
    container.innerHTML = "";

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var row = document.createElement("div");
      row.className = "rec-item" + (r.isOff ? " off-item" : "");

      var info = document.createElement("span");
      if (r.isOff) {
        info.textContent = formatShortDate(r.date) + ": Выходной";
      } else {
        totBoxes += r.boxes;
        totWeight = round2(totWeight + r.weight);
        totPay = round2(totPay + r.pay);
        var bPart = r.boxes > 0 ? (r.boxes + " кор. • ") : "";
        info.textContent = formatShortDate(r.date) + ": " + bPart + r.weight + " кг × " + r.rate + " ₽ = " + r.pay + " ₽";
      }

      var delBtn = document.createElement("button");
      delBtn.className = "rec-del";
      delBtn.textContent = "✕";
      delBtn.dataset.id = r.id;

      row.appendChild(info);
      row.appendChild(delBtn);
      container.appendChild(row);
    }

    document.getElementById("sumBoxesWeight").textContent = totBoxes + " кор. • " + totWeight + " кг";
    document.getElementById("sumMoney").textContent = totPay + " ₽";
  }

  function updateShiftPreview() {
    var boxes = Math.round(cleanNum(document.getElementById("boxesInput").value));
    var boxW = cleanNum(document.getElementById("weightInput").value);
    var rate = cleanNum(document.getElementById("rateInput").value);

    var totalW = (boxes > 0 && boxW > 0) ? round2(boxes * boxW) : round2(boxW);
    var totalM = round2(totalW * rate);

    document.getElementById("prevWeight").textContent = totalW + " кг";
    document.getElementById("prevMoney").textContent = totalM + " ₽";
  }

  function updateUndoButton() {
    var btn = document.getElementById("undoBtn");
    if (!btn) return;
    if (deletedHistory.length > 0) {
      btn.style.display = "block";
      btn.textContent = "↩ ОТМЕНИТЬ УДАЛЕНИЕ (" + deletedHistory.length + ")";
    } else {
      btn.style.display = "none";
    }
  }

  function createBackupSnapshot(tag) {
    var snap = {
      ts: Date.now(),
      label: new Date().toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
      }) + (tag ? " " + tag : ""),
      data: {
        workerName: state.workerName,
        defaultRate: state.defaultRate,
        records: JSON.parse(JSON.stringify(state.records))
      }
    };
    state.backups.unshift(snap);
    if (state.backups.length > 20) state.backups.length = 20;
  }

  function ensureDailyAutoBackup() {
    var todayKey = toKey(new Date());
    if (state.lastAutoBackupDate !== todayKey) {
      state.lastAutoBackupDate = todayKey;
      createBackupSnapshot("(авто)");
    }
  }

  function buildReport(isFull) {
    var range = getOrderedRange();
    var list = getFilteredRecords();
    var worker = (state.workerName || "").trim();
    var lines = [];

    if (worker) lines.push(worker);

    var periodStr = range.start === range.end
      ? formatHumanDate(range.start)
      : (formatShortDate(range.start) + " – " + formatShortDate(range.end));

    if (isFull) {
      lines.push("Период: " + periodStr);
      var totB = 0;
      var totW = 0;
      var totP = 0;
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.isOff) {
          lines.push(formatShortDate(r.date) + " | Выходной");
        } else {
          totB += r.boxes;
          totW = round2(totW + r.weight);
          totP = round2(totP + r.pay);
          lines.push(formatShortDate(r.date) + " | " + r.boxes + "кор | " + r.weight + "кг | " + r.pay + "₽");
        }
      }
      lines.push("ИТОГ: " + totB + "кор | " + totW + "кг | " + totP + "₽");
    } else {
      if (state.isCustomRange && range.start !== range.end) {
        lines.push(periodStr);
      }
      var sB = 0;
      var sW = 0;
      for (var j = 0; j < list.length; j++) {
        if (!list[j].isOff) {
          sB += list[j].boxes;
          sW = round2(sW + list[j].weight);
        }
      }
      lines.push("Вес: " + sW + " кг " + sB + " кор.");
    }

    return lines.join(NL);
  }

  function openReportPreview(isFull) {
    var txt = buildReport(isFull);
    document.getElementById("reportText").textContent = txt;
    document.getElementById("reportModal").classList.add("open");
  }

  function sendCurrentReport() {
    var txt = document.getElementById("reportText").textContent || "";
    document.getElementById("reportModal").classList.remove("open");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function () {});
    }

    if (navigator.share) {
      navigator.share({ text: txt }).catch(function () {});
      return;
    }

    try {
      window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(txt) + ";end";
    } catch (e) {
      showToast("Отчёт скопирован в буфер обмена");
    }
  }

  function renderBackupList() {
    var box = document.getElementById("backupList");
    box.innerHTML = "";
    if (!state.backups.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12px;padding:12px;">Резервных копий пока нет</div>';
      return;
    }
    for (var i = 0; i < state.backups.length; i++) {
      var bk = state.backups[i];
      var cnt = (bk.data && Array.isArray(bk.data.records)) ? bk.data.records.length : 0;
      var row = document.createElement("div");
      row.className = "bk-row";

      var title = document.createElement("span");
      title.textContent = bk.label + " (" + cnt + " зап.)";

      var acts = document.createElement("div");
      acts.className = "bk-acts";

      var useBtn = document.createElement("button");
      useBtn.className = "bk-use";
      useBtn.textContent = "Восстановить";
      useBtn.dataset.idx = String(i);

      var delBtn = document.createElement("button");
      delBtn.className = "bk-del";
      delBtn.textContent = "✕";
      delBtn.dataset.delIdx = String(i);

      acts.appendChild(useBtn);
      acts.appendChild(delBtn);
      row.appendChild(title);
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  function runUpdateFlow() {
    showToast("Шаг 1/3: Сохранение базы...", 2000);
    createBackupSnapshot("(перед обн.)");
    saveAllStorages(true).then(function () {
      showToast("Шаг 2/3: Очистка кэша...", 2000);
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
      Promise.all(tasks).then(function () {
        showToast("Шаг 3/3: Перезагрузка...", 1500);
        setTimeout(function () {
          var baseUrl = window.location.href.split("?")[0];
          window.location.replace(baseUrl + "?v=" + Date.now());
        }, 700);
      });
    });
  }

  function refreshAll() {
    applyTheme();
    document.getElementById("verLabel").textContent = "v " + APP_VERSION;
    document.getElementById("workerInput").value = state.workerName;
    if (state.defaultRate && !document.getElementById("rateInput").value) {
      document.getElementById("rateInput").value = state.defaultRate;
    }
    renderCalendar();
    renderRecordsAndSummary();
    updateShiftPreview();
    updateUndoButton();
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").addEventListener("click", function () {
      state.viewMonth--;
      if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
      renderCalendar();
    });

    document.getElementById("nextMonthBtn").addEventListener("click", function () {
      state.viewMonth++;
      if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
      renderCalendar();
    });

    document.getElementById("themeBtn").addEventListener("click", function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      saveAllStorages(true);
    });

    document.getElementById("updateBtn").addEventListener("click", runUpdateFlow);

    document.getElementById("periodTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab-btn");
      if (!btn) return;
      applyPeriodPreset(btn.dataset.mode);
      renderCalendar();
      renderRecordsAndSummary();
    });

    var calGrid = document.getElementById("calGrid");
    calGrid.addEventListener("pointerdown", function (e) {
      var cell = e.target.closest(".day-cell");
      if (!cell || !cell.dataset.key) return;
      dragActive = true;
      dragAnchorKey = cell.dataset.key;
      state.selectedStart = dragAnchorKey;
      state.selectedEnd = dragAnchorKey;
      if (state.periodMode !== "day") {
        applyPeriodPreset(state.periodMode);
      } else {
        state.isCustomRange = false;
      }
      renderCalendar();
      renderRecordsAndSummary();
    });

    calGrid.addEventListener("pointermove", function (e) {
      if (!dragActive) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el ? el.closest(".day-cell") : null;
      if (!cell || !cell.dataset.key) return;
      if (cell.dataset.key !== dragAnchorKey) {
        state.isCustomRange = true;
        state.selectedStart = dragAnchorKey;
        state.selectedEnd = cell.dataset.key;
        renderCalendar();
        renderRecordsAndSummary();
      }
    });

    window.addEventListener("pointerup", function () { dragActive = false; });

    document.getElementById("offDayBtn").addEventListener("click", function () {
      var range = getOrderedRange();
      ensureDailyAutoBackup();
      state.records.push({
        id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        date: range.start,
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      });
      saveAllStorages(true);
      renderCalendar();
      renderRecordsAndSummary();
      showToast("Выходной добавлен");
    });

    document.getElementById("workerInput").addEventListener("input", function (e) {
      state.workerName = e.target.value;
      saveAllStorages(true);
    });

    document.getElementById("boxesInput").addEventListener("input", updateShiftPreview);
    document.getElementById("weightInput").addEventListener("input", updateShiftPreview);
    document.getElementById("rateInput").addEventListener("input", function (e) {
      state.defaultRate = e.target.value;
      updateShiftPreview();
      saveAllStorages(true);
    });

    document.getElementById("addRecordBtn").addEventListener("click", function () {
      var boxes = Math.round(cleanNum(document.getElementById("boxesInput").value));
      var boxW = cleanNum(document.getElementById("weightInput").value);
      var rate = cleanNum(document.getElementById("rateInput").value);

      var totalW = (boxes > 0 && boxW > 0) ? round2(boxes * boxW) : round2(boxW);
      if (totalW <= 0) {
        showToast("Введите вес коробки или общий вес");
        return;
      }

      var range = getOrderedRange();
      ensureDailyAutoBackup();
      state.records.push({
        id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        date: range.start,
        isOff: false,
        boxes: boxes,
        boxWeight: round2(boxW),
        weight: totalW,
        rate: round2(rate),
        pay: round2(totalW * rate)
      });

      document.getElementById("boxesInput").value = "";
      document.getElementById("weightInput").value = "";
      updateShiftPreview();
      saveAllStorages(true);
      renderCalendar();
      renderRecordsAndSummary();
      showToast("Запись добавлена");
    });

    document.getElementById("recordsList").addEventListener("click", function (e) {
      var btn = e.target.closest(".rec-del");
      if (!btn) return;
      var id = btn.dataset.id;
      for (var i = 0; i < state.records.length; i++) {
        if (state.records[i].id === id) {
          deletedHistory.push(state.records[i]);
          state.records.splice(i, 1);
          break;
        }
      }
      saveAllStorages(true);
      renderCalendar();
      renderRecordsAndSummary();
      updateUndoButton();
    });

    document.getElementById("undoBtn").addEventListener("click", function () {
      if (!deletedHistory.length) return;
      var item = deletedHistory.pop();
      state.records.push(item);
      saveAllStorages(true);
      renderCalendar();
      renderRecordsAndSummary();
      updateUndoButton();
      showToast("Запись возвращена");
    });

    document.getElementById("fullReportBtn").addEventListener("click", function () { openReportPreview(true); });
    document.getElementById("shortReportBtn").addEventListener("click", function () { openReportPreview(false); });
    document.getElementById("closeReportBtn").addEventListener("click", function () {
      document.getElementById("reportModal").classList.remove("open");
    });
    document.getElementById("sendReportBtn").addEventListener("click", sendCurrentReport);

    document.getElementById("saveBackupBtn").addEventListener("click", function () {
      createBackupSnapshot("");
      saveAllStorages(true);
      showToast("Резервная копия сохранена");
    });

    document.getElementById("openRestoreBtn").addEventListener("click", function () {
      renderBackupList();
      document.getElementById("confirmDeleteBox").classList.remove("open");
      document.getElementById("restoreModal").classList.add("open");
    });

    document.getElementById("closeRestoreBtn").addEventListener("click", function () {
      document.getElementById("restoreModal").classList.remove("open");
    });

    document.getElementById("backupList").addEventListener("click", function (e) {
      var useBtn = e.target.closest(".bk-use");
      if (useBtn) {
        var idx = Number(useBtn.dataset.idx);
        var bk = state.backups[idx];
        if (bk && bk.data) {
          var norm = normalizePayload(bk.data);
          if (norm) {
            state.records = norm.records;
            if (norm.workerName) state.workerName = norm.workerName;
            if (norm.defaultRate) {
              state.defaultRate = norm.defaultRate;
              document.getElementById("rateInput").value = norm.defaultRate;
            }
            saveAllStorages(true);
            refreshAll();
            document.getElementById("restoreModal").classList.remove("open");
            showToast("База восстановлена (" + state.records.length + " зап.)");
          }
        }
        return;
      }

      var delBtn = e.target.closest(".bk-del");
      if (delBtn) {
        pendingDeleteBackupIdx = Number(delBtn.dataset.delIdx);
        document.getElementById("confirmDeleteBox").classList.add("open");
      }
    });

    document.getElementById("cancelDelBkBtn").addEventListener("click", function () {
      pendingDeleteBackupIdx = -1;
      document.getElementById("confirmDeleteBox").classList.remove("open");
    });

    document.getElementById("confirmDelBkBtn").addEventListener("click", function () {
      if (pendingDeleteBackupIdx >= 0 && pendingDeleteBackupIdx < state.backups.length) {
        state.backups.splice(pendingDeleteBackupIdx, 1);
        saveAllStorages(true);
        renderBackupList();
        showToast("Копия удалена");
      }
      pendingDeleteBackupIdx = -1;
      document.getElementById("confirmDeleteBox").classList.remove("open");
    });

    document.getElementById("copyCodeBtn").addEventListener("click", function () {
      var code = btoa(unescape(encodeURIComponent(JSON.stringify(getSerializableState()))));
      var inp = document.getElementById("transferCodeInput");
      inp.value = code;
      inp.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).catch(function () {});
      }
      showToast("Код базы скопирован");
    });

    document.getElementById("importCodeBtn").addEventListener("click", function () {
      var code = document.getElementById("transferCodeInput").value.trim();
      if (!code) { showToast("Вставьте код переноса"); return; }
      try {
        var json = decodeURIComponent(escape(atob(code)));
        var norm = normalizePayload(JSON.parse(json));
        if (!norm) throw new Error("bad");
        state.records = norm.records;
        state.workerName = norm.workerName;
        state.defaultRate = norm.defaultRate;
        if (norm.backups.length) state.backups = norm.backups;
        saveAllStorages(true);
        refreshAll();
        document.getElementById("restoreModal").classList.remove("open");
        showToast("База загружена из кода");
      } catch (e) {
        showToast("Неверный код переноса");
      }
    });
  }

  function boot() {
    bindEvents();
    refreshAll();
    loadInitialState().then(function () {
      refreshAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
