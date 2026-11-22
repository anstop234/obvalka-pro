(function() {
  "use strict";

  var APP_VERSION = "8.2";
  var STORAGE_KEY = "obvalka_pro_state_v1";
  var IDB_NAME = "ObvalkaProDB";
  var IDB_STORE = "kv";
  var IDB_KEY = "main_state";
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toIso(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseIso(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function formatDayMonth(iso) {
    var d = parseIso(iso);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function formatShortDate(iso) {
    var d = parseIso(iso);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function cleanNum(val) {
    if (typeof val === "number") return isFinite(val) ? val : 0;
    if (!val) return 0;
    var s = String(val).replace(",", ".").trim();
    var out = "";
    var hasDot = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= "0" && ch <= "9") {
        out += ch;
      } else if (ch === "." && !hasDot) {
        out += ch;
        hasDot = true;
      } else if (ch === "-" && out.length === 0) {
        out += ch;
      }
    }
    var num = parseFloat(out);
    return isFinite(num) ? num : 0;
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function round1(n) {
    return Math.round((Number(n) || 0) * 10) / 10;
  }

  function normalizeRecord(raw, fallbackRate) {
    if (!raw || typeof raw !== "object") return null;
    var date = raw.date || raw.d || toIso(new Date());
    var isOff = Boolean(raw.isOff || raw.off || raw.dayOff);
    var boxes = Math.round(cleanNum(raw.boxes !== undefined ? raw.boxes : raw.b));
    var boxWeight = round1(cleanNum(raw.boxWeight !== undefined ? raw.boxWeight : raw.bw));
    var totalWeight = round1(cleanNum(raw.totalWeight !== undefined ? raw.totalWeight : (raw.weight !== undefined ? raw.weight : raw.w)));
    var rate = round2(cleanNum(raw.rate !== undefined ? raw.rate : raw.r));

    if (!isOff && boxes === 0 && totalWeight === 0 && boxWeight === 0) {
      isOff = true;
    }

    if (isOff) {
      return {
        id: raw.id || (Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
        date: date,
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        totalWeight: 0,
        rate: 0,
        totalPay: 0
      };
    }

    if (totalWeight <= 0 && boxes > 0 && boxWeight > 0) {
      totalWeight = round1(boxes * boxWeight);
    } else if (boxes > 0 && boxWeight > 0 && Math.abs(totalWeight - boxWeight) < 0.01 && boxes > 1) {
      totalWeight = round1(boxes * boxWeight);
    }

    if (rate <= 0) {
      rate = round2(cleanNum(fallbackRate));
    }

    var totalPay = round2(totalWeight * rate);
    return {
      id: raw.id || (Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
      date: date,
      isOff: false,
      boxes: boxes,
      boxWeight: boxWeight,
      totalWeight: totalWeight,
      rate: rate,
      totalPay: totalPay
    };
  }

  function createDefaultState() {
    var today = new Date();
    var iso = toIso(today);
    return {
      records: [],
      backups: [],
      workerName: "",
      lastRate: 9.5,
      theme: "dark",
      viewYear: today.getFullYear(),
      viewMonth: today.getMonth(),
      mode: "day",
      rangeStart: iso,
      rangeEnd: iso,
      manualRange: false,
      autoBackupDate: "",
      updatedAt: 0
    };
  }

  function normalizeState(raw) {
    var base = createDefaultState();
    if (!raw || typeof raw !== "object") return base;

    base.workerName = typeof raw.workerName === "string" ? raw.workerName : "";
    var r = cleanNum(raw.lastRate);
    base.lastRate = r > 0 ? round2(r) : 9.5;
    base.theme = raw.theme === "light" ? "light" : "dark";
    base.autoBackupDate = typeof raw.autoBackupDate === "string" ? raw.autoBackupDate : "";
    base.updatedAt = Number(raw.updatedAt) || 0;

    if (Array.isArray(raw.records)) {
      var list = [];
      for (var i = 0; i < raw.records.length; i++) {
        var nr = normalizeRecord(raw.records[i], base.lastRate);
        if (nr) list.push(nr);
      }
      base.records = list;
    }

    if (Array.isArray(raw.backups)) {
      var bList = [];
      for (var j = 0; j < raw.backups.length; j++) {
        var b = raw.backups[j];
        if (!b || !Array.isArray(b.records)) continue;
        var normRecs = [];
        for (var k = 0; k < b.records.length; k++) {
          var br = normalizeRecord(b.records[k], b.lastRate || base.lastRate);
          if (br) normRecs.push(br);
        }
        bList.push({
          id: b.id || ("bk_" + j + "_" + Date.now()),
          label: String(b.label || "Копия базы"),
          createdAt: Number(b.createdAt) || Date.now(),
          workerName: typeof b.workerName === "string" ? b.workerName : base.workerName,
          lastRate: cleanNum(b.lastRate) || base.lastRate,
          records: normRecs
        });
      }
      base.backups = bList;
    }

    return base;
  }

  function openDb(cb) {
    if (!window.indexedDB) {
      cb(null);
      return;
    }
    try {
      var req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = function(e) {
        cb(e.target.result);
      };
      req.onerror = function() {
        cb(null);
      };
    } catch (err) {
      cb(null);
    }
  }

  function readFromIdb(cb) {
    openDb(function(db) {
      if (!db) {
        cb(null);
        return;
      }
      try {
        var tx = db.transaction(IDB_STORE, "readonly");
        var store = tx.objectStore(IDB_STORE);
        var getReq = store.get(IDB_KEY);
        getReq.onsuccess = function() {
          cb(getReq.result || null);
        };
        getReq.onerror = function() {
          cb(null);
        };
      } catch (e) {
        cb(null);
      }
    });
  }

  function writeToIdb(payload, cb) {
    openDb(function(db) {
      if (!db) {
        if (cb) cb(false);
        return;
      }
      try {
        var tx = db.transaction(IDB_STORE, "readwrite");
        var store = tx.objectStore(IDB_STORE);
        store.put(payload, IDB_KEY);
        tx.oncomplete = function() {
          if (cb) cb(true);
        };
        tx.onerror = function() {
          if (cb) cb(false);
        };
      } catch (e) {
        if (cb) cb(false);
      }
    });
  }

  function readFromLocalStorage() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function readFromWindowName() {
    try {
      if (!window.name || window.name.indexOf("OBVALKA_BAK:") !== 0) return null;
      var json = window.name.slice("OBVALKA_BAK:".length);
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function pickBestState(candidates) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || typeof c !== "object") continue;
      var norm = normalizeState(c);
      var recCount = norm.records.length;
      var bkCount = norm.backups.length;
      var ts = Number(norm.updatedAt) || 0;
      var score = recCount * 1000000000000 + bkCount * 10000000000 + Math.floor(ts / 1000);
      if (score > bestScore) {
        bestScore = score;
        best = norm;
      }
    }
    return best || createDefaultState();
  }

  var state = createDefaultState();
  var lastDeletedRecord = null;
  var undoTimer = null;
  var undoSeconds = 0;
  var pendingReportText = "";

  window.ObvalkaApp = {
    getState: function() {
      return state;
    },
    onCalendarSelect: function(startIso, endIso, isManual) {
      state.rangeStart = startIso;
      state.rangeEnd = endIso;
      state.manualRange = Boolean(isManual);
      if (isManual) {
        state.mode = startIso === endIso ? "day" : "custom";
      }
      renderAll();
    },
    onMonthChange: function(year, month) {
      state.viewYear = year;
      state.viewMonth = month;
      if (state.mode === "month") {
        applyPeriodMode("month");
      } else if (state.mode === "year") {
        applyPeriodMode("year");
      } else {
        renderAll();
      }
    }
  };

  function persistState(cb) {
    state.updatedAt = Date.now();
    var snapshot = {
      records: state.records,
      backups: state.backups,
      workerName: state.workerName,
      lastRate: state.lastRate,
      theme: state.theme,
      autoBackupDate: state.autoBackupDate,
      updatedAt: state.updatedAt
    };
    var json = JSON.stringify(snapshot);
    try {
      window.localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {}
    try {
      window.name = "OBVALKA_BAK:" + json;
    } catch (e) {}
    writeToIdb(snapshot, function(ok) {
      if (cb) cb(ok);
    });
  }

  function showToast(msg, duration) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._tid);
    el._tid = setTimeout(function() {
      el.classList.remove("show");
    }, duration || 2200);
  }

  function applyTheme() {
    if (state.theme === "light") {
      document.body.classList.add("light-theme");
    } else {
      document.body.classList.remove("light-theme");
    }
    var btn = document.getElementById("btnTheme");
    if (btn) {
      btn.textContent = state.theme === "light" ? "🌙" : "☀️";
    }
  }

  function applyPeriodMode(mode) {
    state.mode = mode;
    state.manualRange = false;
    var anchor = parseIso(state.rangeStart || toIso(new Date()));
    var y = anchor.getFullYear();
    var m = anchor.getMonth();
    var day = anchor.getDate();

    if (mode === "day") {
      var iso = toIso(anchor);
      state.rangeStart = iso;
      state.rangeEnd = iso;
    } else if (mode === "week") {
      var dow = anchor.getDay();
      var diffToMon = dow === 0 ? -6 : 1 - dow;
      var mon = new Date(y, m, day + diffToMon);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      state.rangeStart = toIso(mon);
      state.rangeEnd = toIso(sun);
    } else if (mode === "two_weeks") {
      if (day <= 15) {
        state.rangeStart = toIso(new Date(y, m, 1));
        state.rangeEnd = toIso(new Date(y, m, 15));
      } else {
        var lastDay = new Date(y, m + 1, 0).getDate();
        state.rangeStart = toIso(new Date(y, m, 16));
        state.rangeEnd = toIso(new Date(y, m, lastDay));
      }
    } else if (mode === "month") {
      var vy = state.viewYear;
      var vm = state.viewMonth;
      var endM = new Date(vy, vm + 1, 0).getDate();
      state.rangeStart = toIso(new Date(vy, vm, 1));
      state.rangeEnd = toIso(new Date(vy, vm, endM));
    } else if (mode === "year") {
      var yy = state.viewYear;
      state.rangeStart = yy + "-01-01";
      state.rangeEnd = yy + "-12-31";
    }

    var sDate = parseIso(state.rangeStart);
    state.viewYear = sDate.getFullYear();
    state.viewMonth = sDate.getMonth();
    renderAll();
  }

  function getFilteredRecords() {
    var s = state.rangeStart;
    var e = state.rangeEnd;
    if (s > e) {
      var tmp = s;
      s = e;
      e = tmp;
    }
    var res = [];
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      if (r.date >= s && r.date <= e) {
        res.push(r);
      }
    }
    res.sort(function(a, b) {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return 0;
    });
    return res;
  }

  function updateShiftPreview() {
    var boxesEl = document.getElementById("inpBoxes");
    var weightEl = document.getElementById("inpBoxWeight");
    var rateEl = document.getElementById("inpRate");
    var prevEl = document.getElementById("shiftPreview");
    if (!boxesEl || !weightEl || !rateEl || !prevEl) return;

    var boxes = Math.round(cleanNum(boxesEl.value));
    var bw = round1(cleanNum(weightEl.value));
    var rate = round2(cleanNum(rateEl.value));
    var totalW = boxes > 0 ? round1(boxes * bw) : bw;
    var totalP = round2(totalW * rate);

    prevEl.innerHTML = '<span style="color:#10b981;font-weight:700;">' + totalW + ' кг</span> &nbsp;<span style="color:#f59e0b;font-weight:700;">' + totalP + ' ₽</span>';
  }

  function renderRecordsAndTotals() {
    var listEl = document.getElementById("recordsList");
    var titleEl = document.getElementById("recordsTitle");
    var countEl = document.getElementById("recordsCount");
    var summaryTitleEl = document.getElementById("summaryTitle");
    var summarySubEl = document.getElementById("summarySub");
    var summaryPayEl = document.getElementById("summaryPay");
    var selectedDateLabelEl = document.getElementById("selectedDateLabel");

    var filtered = getFilteredRecords();
    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;

    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      if (!r.isOff) {
        totalBoxes += r.boxes;
        totalWeight = round1(totalWeight + r.totalWeight);
        totalPay = round2(totalPay + r.totalPay);
      }
    }

    var isSingle = state.rangeStart === state.rangeEnd;
    var periodSuffix = isSingle
      ? ("ДЕНЬ (" + formatShortDate(state.rangeStart).toUpperCase() + ")")
      : (formatShortDate(state.rangeStart).toUpperCase() + " – " + formatShortDate(state.rangeEnd).toUpperCase());

    if (titleEl) titleEl.textContent = "ЗАПИСИ (" + periodSuffix + ")";
    if (countEl) countEl.textContent = filtered.length + " ШТ.";
    if (summaryTitleEl) summaryTitleEl.textContent = "ИТОГ ЗА " + periodSuffix;
    if (summarySubEl) summarySubEl.textContent = totalBoxes + " кор. • " + totalWeight + " кг";
    if (summaryPayEl) summaryPayEl.textContent = totalPay + " ₽";
    if (selectedDateLabelEl) selectedDateLabelEl.textContent = formatDayMonth(state.rangeStart);

    if (!listEl) return;
    listEl.innerHTML = "";

    for (var j = 0; j < filtered.length; j++) {
      (function(rec) {
        var row = document.createElement("div");
        row.className = "rec-item" + (rec.isOff ? " rec-off" : "");

        var textSpan = document.createElement("span");
        textSpan.className = "rec-text";
        if (rec.isOff) {
          textSpan.textContent = formatShortDate(rec.date) + ": Выходной";
        } else {
          var parts = [formatShortDate(rec.date) + ":"];
          if (rec.boxes > 0) parts.push(rec.boxes + " кор. •");
          parts.push(rec.totalWeight + " кг × " + rec.rate + " ₽ =");
          textSpan.innerHTML = parts.join(" ") + ' <strong style="color:#f59e0b;">' + rec.totalPay + ' ₽</strong>';
        }

        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "rec-del";
        delBtn.textContent = "✕";
        delBtn.onclick = function() {
          deleteRecord(rec.id);
        };

        row.appendChild(textSpan);
        row.appendChild(delBtn);
        listEl.appendChild(row);
      })(filtered[j]);
    }
  }

  function renderTabsAndHeader() {
    var verEl = document.getElementById("appVersion");
    if (verEl) verEl.textContent = "v " + APP_VERSION;

    var tabs = document.querySelectorAll(".mode-tab");
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute("data-mode") === state.mode) {
        t.classList.add("active");
      } else {
        t.classList.remove("active");
      }
    }

    var undoBtn = document.getElementById("btnUndo");
    if (undoBtn) {
      if (lastDeletedRecord && undoSeconds > 0) {
        undoBtn.style.display = "inline-flex";
        undoBtn.textContent = "↩ Вернуть (" + undoSeconds + "с)";
      } else {
        undoBtn.style.display = "none";
      }
    }
  }

  function renderAll() {
    applyTheme();
    renderTabsAndHeader();
    renderRecordsAndTotals();
    updateShiftPreview();
    if (window.ObvalkaCalendar && typeof window.ObvalkaCalendar.render === "function") {
      window.ObvalkaCalendar.render(state);
    }
  }

  function ensureDailyAutoBackup() {
    var todayIso = toIso(new Date());
    if (state.autoBackupDate === todayIso) return;
    if (state.records.length === 0) return;

    var now = new Date();
    var label = pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + " (авто)";
    state.backups.unshift({
      id: "auto_" + Date.now(),
      label: label,
      createdAt: Date.now(),
      workerName: state.workerName,
      lastRate: state.lastRate,
      records: JSON.parse(JSON.stringify(state.records))
    });
    if (state.backups.length > 25) {
      state.backups = state.backups.slice(0, 25);
    }
    state.autoBackupDate = todayIso;
  }

  function addRecord(isOff) {
    var targetDate = state.rangeStart || toIso(new Date());
    var nameEl = document.getElementById("inpWorker");
    if (nameEl) {
      state.workerName = nameEl.value.trim();
    }

    if (isOff) {
      state.records.push({
        id: "rec_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        date: targetDate,
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        totalWeight: 0,
        rate: 0,
        totalPay: 0
      });
      ensureDailyAutoBackup();
      persistState();
      renderAll();
      return;
    }

    var boxesEl = document.getElementById("inpBoxes");
    var weightEl = document.getElementById("inpBoxWeight");
    var rateEl = document.getElementById("inpRate");

    var boxes = Math.round(cleanNum(boxesEl ? boxesEl.value : 0));
    var bw = round1(cleanNum(weightEl ? weightEl.value : 0));
    var rate = round2(cleanNum(rateEl ? rateEl.value : state.lastRate));

    if (rate > 0) {
      state.lastRate = rate;
    } else {
      rate = state.lastRate;
    }

    var totalW = boxes > 0 ? round1(boxes * bw) : bw;
    if (totalW <= 0) {
      showToast("Введите вес или количество коробок");
      return;
    }

    var totalP = round2(totalW * rate);
    state.records.push({
      id: "rec_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      date: targetDate,
      isOff: false,
      boxes: boxes,
      boxWeight: bw,
      totalWeight: totalW,
      rate: rate,
      totalPay: totalP
    });

    if (boxesEl) boxesEl.value = "";
    if (weightEl) weightEl.value = "";

    ensureDailyAutoBackup();
    persistState();
    renderAll();
  }

  function deleteRecord(id) {
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    lastDeletedRecord = state.records[idx];
    state.records.splice(idx, 1);

    clearInterval(undoTimer);
    undoSeconds = 7;
    undoTimer = setInterval(function() {
      undoSeconds--;
      if (undoSeconds <= 0) {
        clearInterval(undoTimer);
        lastDeletedRecord = null;
      }
      renderTabsAndHeader();
    }, 1000);

    persistState();
    renderAll();
  }

  function undoDelete() {
    if (!lastDeletedRecord) return;
    state.records.push(lastDeletedRecord);
    lastDeletedRecord = null;
    clearInterval(undoTimer);
    undoSeconds = 0;
    persistState();
    renderAll();
  }

  function buildReportText(isFull) {
    var NL = String.fromCharCode(10);
    var filtered = getFilteredRecords();
    var nameEl = document.getElementById("inpWorker");
    var worker = (nameEl && nameEl.value.trim()) ? nameEl.value.trim() : (state.workerName || "Обвальщик");
    var isSingle = state.rangeStart === state.rangeEnd;

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;
    for (var i = 0; i < filtered.length; i++) {
      if (!filtered[i].isOff) {
        totalBoxes += filtered[i].boxes;
        totalWeight = round1(totalWeight + filtered[i].totalWeight);
        totalPay = round2(totalPay + filtered[i].totalPay);
      }
    }

    var lines = [];
    lines.push(worker);

    if (!isFull) {
      if (state.manualRange && !isSingle) {
        lines.push(formatShortDate(state.rangeStart) + " – " + formatShortDate(state.rangeEnd));
      }
      lines.push("Вес: " + totalWeight + " кг " + totalBoxes + " кор.");
      return lines.join(NL);
    }

    if (isSingle) {
      lines.push("Вес: " + totalWeight + " кг " + totalBoxes + " кор.");
      return lines.join(NL);
    }

    lines.push("Период: " + formatShortDate(state.rangeStart) + " – " + formatShortDate(state.rangeEnd));

    var byDate = {};
    var dateOrder = [];
    for (var j = 0; j < filtered.length; j++) {
      var r = filtered[j];
      if (!byDate[r.date]) {
        byDate[r.date] = { boxes: 0, weight: 0, pay: 0, isOff: false };
        dateOrder.push(r.date);
      }
      if (r.isOff) {
        byDate[r.date].isOff = true;
      } else {
        byDate[r.date].boxes += r.boxes;
        byDate[r.date].weight = round1(byDate[r.date].weight + r.totalWeight);
        byDate[r.date].pay = round2(byDate[r.date].pay + r.totalPay);
      }
    }

    for (var k = 0; k < dateOrder.length; k++) {
      var dt = dateOrder[k];
      var item = byDate[dt];
      if (item.isOff && item.weight === 0) {
        lines.push(formatShortDate(dt) + " | Выходной");
      } else {
        lines.push(formatShortDate(dt) + " | " + item.boxes + "кор | " + item.weight + "кг | " + item.pay + "₽");
      }
    }

    lines.push("ИТОГ: " + totalBoxes + "кор | " + totalWeight + "кг | " + totalPay + "₽");
    return lines.join(NL);
  }

  function openReportPreview(isFull) {
    pendingReportText = buildReportText(isFull);
    var modal = document.getElementById("reportModal");
    var box = document.getElementById("reportPreviewText");
    if (box) box.textContent = pendingReportText;
    if (modal) modal.style.display = "flex";
  }

  function closeReportPreview() {
    var modal = document.getElementById("reportModal");
    if (modal) modal.style.display = "none";
  }

  function copyTextSilent(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function() {});
      }
    } catch (e) {}
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function sendReportSystem() {
    var text = pendingReportText;
    closeReportPreview();
    if (!text) return;
    copyTextSilent(text);

    if (navigator.share) {
      navigator.share({
        title: "Отчёт обвалки",
        text: text
      }).catch(function() {
        openAndroidIntent(text);
      });
    } else {
      openAndroidIntent(text);
    }
  }

  function openAndroidIntent(text) {
    var ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) {
      var intentUrl = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(text) + ";end";
      window.location.href = intentUrl;
    } else {
      showToast("Отчёт скопирован в буфер обмена");
    }
  }

  function saveManualBackup() {
    var now = new Date();
    var label = pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + " (" + state.records.length + " зап.)";
    state.backups.unshift({
      id: "man_" + Date.now(),
      label: label,
      createdAt: Date.now(),
      workerName: state.workerName,
      lastRate: state.lastRate,
      records: JSON.parse(JSON.stringify(state.records))
    });
    if (state.backups.length > 30) {
      state.backups = state.backups.slice(0, 30);
    }
    persistState(function() {
      showToast("База сохранена (" + state.records.length + " записей)");
    });
  }

  function openBackupsModal() {
    var modal = document.getElementById("backupModal");
    renderBackupsList();
    if (modal) modal.style.display = "flex";
  }

  function closeBackupsModal() {
    var modal = document.getElementById("backupModal");
    if (modal) modal.style.display = "none";
  }

  function renderBackupsList() {
    var listEl = document.getElementById("backupsList");
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!state.backups || state.backups.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:14px;font-size:13px;">Сохранённых копий пока нет</div>';
      return;
    }

    for (var i = 0; i < state.backups.length; i++) {
      (function(bk) {
        var item = document.createElement("div");
        item.className = "bk-item";

        var info = document.createElement("div");
        info.className = "bk-info";
        info.textContent = bk.label;

        var actions = document.createElement("div");
        actions.className = "bk-actions";

        var btnRest = document.createElement("button");
        btnRest.type = "button";
        btnRest.className = "bk-btn-restore";
        btnRest.textContent = "Восстановить";
        btnRest.onclick = function() {
          var normRecs = [];
          for (var k = 0; k < bk.records.length; k++) {
            var nr = normalizeRecord(bk.records[k], bk.lastRate || state.lastRate);
            if (nr) normRecs.push(nr);
          }
          state.records = normRecs;
          if (bk.workerName) state.workerName = bk.workerName;
          if (bk.lastRate) state.lastRate = bk.lastRate;
          var wEl = document.getElementById("inpWorker");
          var rEl = document.getElementById("inpRate");
          if (wEl) wEl.value = state.workerName;
          if (rEl) rEl.value = state.lastRate;
          persistState();
          renderAll();
          closeBackupsModal();
          showToast("Восстановлено записей: " + normRecs.length);
        };

        var btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "bk-btn-del";
        btnDel.textContent = "✕";
        btnDel.onclick = function() {
          askConfirm("Удалить копию «" + bk.label + "»?", function() {
            state.backups = state.backups.filter(function(x) { return x.id !== bk.id; });
            persistState();
            renderBackupsList();
          });
        };

        actions.appendChild(btnRest);
        actions.appendChild(btnDel);
        item.appendChild(info);
        item.appendChild(actions);
        listEl.appendChild(item);
      })(state.backups[i]);
    }
  }

  function askConfirm(text, onYes) {
    var modal = document.getElementById("confirmModal");
    var txtEl = document.getElementById("confirmText");
    var yesBtn = document.getElementById("confirmYes");
    var noBtn = document.getElementById("confirmNo");
    if (!modal || !txtEl || !yesBtn || !noBtn) {
      if (window.confirm(text)) onYes();
      return;
    }
    txtEl.textContent = text;
    modal.style.display = "flex";
    yesBtn.onclick = function() {
      modal.style.display = "none";
      onYes();
    };
    noBtn.onclick = function() {
      modal.style.display = "none";
    };
  }

  function exportCodeToClipboard() {
    var payload = {
      v: APP_VERSION,
      w: state.workerName,
      r: state.lastRate,
      d: state.records
    };
    var code = "OBV1:" + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    copyTextSilent(code);
    showToast("Код базы скопирован в буфер обмена");
  }

  function importCodeFromPrompt() {
    var box = document.getElementById("codeImportArea");
    if (!box) return;
    box.style.display = box.style.display === "none" ? "block" : "none";
  }

  function applyImportedCode() {
    var inp = document.getElementById("inpImportCode");
    if (!inp) return;
    var raw = inp.value.trim();
    if (!raw) {
      showToast("Вставьте код базы");
      return;
    }
    try {
      if (raw.indexOf("OBV1:") === 0) raw = raw.slice(5);
      var json = decodeURIComponent(escape(atob(raw)));
      var obj = JSON.parse(json);
      if (!obj || !Array.isArray(obj.d)) throw new Error("bad format");
      var list = [];
      for (var i = 0; i < obj.d.length; i++) {
        var nr = normalizeRecord(obj.d[i], obj.r || state.lastRate);
        if (nr) list.push(nr);
      }
      state.records = list;
      if (obj.w) state.workerName = obj.w;
      if (obj.r) state.lastRate = obj.r;
      var wEl = document.getElementById("inpWorker");
      var rEl = document.getElementById("inpRate");
      if (wEl) wEl.value = state.workerName;
      if (rEl) rEl.value = state.lastRate;
      persistState();
      renderAll();
      closeBackupsModal();
      showToast("База перенесена (" + list.length + " записей)");
    } catch (e) {
      showToast("Неверный формат кода базы");
    }
  }

  function runSafeUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный режим (v " + APP_VERSION + ")");
      return;
    }

    var now = new Date();
    var updLabel = pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + " (перед обн.)";
    state.backups.unshift({
      id: "upd_" + Date.now(),
      label: updLabel,
      createdAt: Date.now(),
      workerName: state.workerName,
      lastRate: state.lastRate,
      records: JSON.parse(JSON.stringify(state.records))
    });
    if (state.backups.length > 30) {
      state.backups = state.backups.slice(0, 30);
    }

    showToast("Шаг 1/3: Сохранение базы (" + state.records.length + " зап.)...", 3000);
    persistState(function() {
      setTimeout(function() {
        showToast("Шаг 2/3: Очистка кэша...", 3000);
        var tasks = [];
        if (window.caches && window.caches.keys) {
          tasks.push(window.caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(k) { return window.caches.delete(k); }));
          }).catch(function() {}));
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          tasks.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
            return Promise.all(regs.map(function(r) { return r.unregister(); }));
          }).catch(function() {}));
        }
        Promise.all(tasks).then(function() {
          setTimeout(function() {
            showToast("Шаг 3/3: Перезагрузка...", 2000);
            try {
              window.sessionStorage.setItem("obvalka_just_updated", String(state.records.length));
            } catch (e) {}
            window.location.reload(true);
          }, 700);
        });
      }, 700);
    });
  }

  function bindEvents() {
    var tabs = document.querySelectorAll(".mode-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function() {
        applyPeriodMode(this.getAttribute("data-mode"));
      };
    }

    var btnPrev = document.getElementById("btnPrevMonth");
    if (btnPrev) {
      btnPrev.onclick = function() {
        var m = state.viewMonth - 1;
        var y = state.viewYear;
        if (m < 0) { m = 11; y--; }
        window.ObvalkaApp.onMonthChange(y, m);
      };
    }

    var btnNext = document.getElementById("btnNextMonth");
    if (btnNext) {
      btnNext.onclick = function() {
        var m = state.viewMonth + 1;
        var y = state.viewYear;
        if (m > 11) { m = 0; y++; }
        window.ObvalkaApp.onMonthChange(y, m);
      };
    }

    var btnTheme = document.getElementById("btnTheme");
    if (btnTheme) {
      btnTheme.onclick = function() {
        state.theme = state.theme === "dark" ? "light" : "dark";
        persistState();
        applyTheme();
      };
    }

    var btnUpdate = document.getElementById("btnUpdate");
    if (btnUpdate) {
      btnUpdate.onclick = runSafeUpdate;
    }

    var btnDayOff = document.getElementById("btnDayOff");
    if (btnDayOff) {
      btnDayOff.onclick = function() { addRecord(true); };
    }

    var btnAdd = document.getElementById("btnAddRecord");
    if (btnAdd) {
      btnAdd.onclick = function() { addRecord(false); };
    }

    var btnUndo = document.getElementById("btnUndo");
    if (btnUndo) {
      btnUndo.onclick = undoDelete;
    }

    var inpWorker = document.getElementById("inpWorker");
    if (inpWorker) {
      inpWorker.oninput = function() {
        state.workerName = this.value.trim();
        persistState();
      };
    }

    var inpBoxes = document.getElementById("inpBoxes");
    var inpBoxWeight = document.getElementById("inpBoxWeight");
    var inpRate = document.getElementById("inpRate");
    if (inpBoxes) inpBoxes.oninput = updateShiftPreview;
    if (inpBoxWeight) inpBoxWeight.oninput = updateShiftPreview;
    if (inpRate) {
      inpRate.oninput = function() {
        var v = cleanNum(this.value);
        if (v > 0) state.lastRate = round2(v);
        updateShiftPreview();
      };
    }

    var btnFullRep = document.getElementById("btnFullReport");
    if (btnFullRep) btnFullRep.onclick = function() { openReportPreview(true); };

    var btnShortRep = document.getElementById("btnShortReport");
    if (btnShortRep) btnShortRep.onclick = function() { openReportPreview(false); };

    var btnRepCancel = document.getElementById("btnReportCancel");
    if (btnRepCancel) btnRepCancel.onclick = closeReportPreview;

    var btnRepSend = document.getElementById("btnReportSend");
    if (btnRepSend) btnRepSend.onclick = sendReportSystem;

    var btnSaveDb = document.getElementById("btnSaveDb");
    if (btnSaveDb) btnSaveDb.onclick = saveManualBackup;

    var btnOpenDb = document.getElementById("btnOpenDb");
    if (btnOpenDb) btnOpenDb.onclick = openBackupsModal;

    var btnCloseBk = document.getElementById("btnCloseBackup");
    if (btnCloseBk) btnCloseBk.onclick = closeBackupsModal;

    var btnExpCode = document.getElementById("btnExportCode");
    if (btnExpCode) btnExpCode.onclick = exportCodeToClipboard;

    var btnImpToggle = document.getElementById("btnImportToggle");
    if (btnImpToggle) btnImpToggle.onclick = importCodeFromPrompt;

    var btnImpApply = document.getElementById("btnImportApply");
    if (btnImpApply) btnImpApply.onclick = applyImportedCode;
  }

  function init() {
    var lsData = readFromLocalStorage();
    var wnData = readFromWindowName();

    readFromIdb(function(idbData) {
      state = pickBestState([lsData, idbData, wnData]);
      var today = new Date();
      state.viewYear = today.getFullYear();
      state.viewMonth = today.getMonth();
      state.mode = "day";
      state.rangeStart = toIso(today);
      state.rangeEnd = toIso(today);
      state.manualRange = false;

      var wEl = document.getElementById("inpWorker");
      var rEl = document.getElementById("inpRate");
      if (wEl) wEl.value = state.workerName || "";
      if (rEl) rEl.value = state.lastRate || 9.5;

      bindEvents();
      persistState();
      renderAll();

      try {
        var updCount = window.sessionStorage.getItem("obvalka_just_updated");
        if (updCount !== null) {
          window.sessionStorage.removeItem("obvalka_just_updated");
          showToast("Обновлено до v " + APP_VERSION + " • Записей: " + state.records.length, 2800);
        }
      } catch (e) {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
