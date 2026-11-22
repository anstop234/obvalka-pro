(function () {
  "use strict";

  var APP_VERSION = "7.2";
  var STORAGE_KEY = "obvalka_pro_data_v1";
  var BACKUPS_KEY = "obvalka_pro_backups_v1";
  var DB_NAME = "ObvalkaProDB";
  var DB_STORE = "kv";

  var MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  var state = {
    records: [],
    dayOffs: {},
    workerName: "",
    lastRate: "",
    theme: "dark"
  };

  var undoStack = [];
  var viewYear = 2026;
  var viewMonth = 10;
  var selectedDate = "2026-11-22";
  var periodMode = "day";
  var customRange = null;
  var isDragging = false;
  var dragStart = null;
  var pendingConfirmAction = null;

  function $(id) { return document.getElementById(id); }

  function showToast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.style.display = "none"; }, 2400);
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function toIso(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }

  function parseIso(iso) {
    var p = iso.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function fmtDateFull(iso) {
    var d = parseIso(iso);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function fmtDateShort(iso) {
    var d = parseIso(iso);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function cleanNumStr(val, allowDecimal) {
    var s = String(val || "").replace(",", ".");
    if (!allowDecimal) {
      return s.replace(/[^0-9]/g, "");
    }
    var out = "";
    var dotSeen = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= "0" && ch <= "9") {
        out += ch;
      } else if (ch === "." && !dotSeen) {
        dotSeen = true;
        out += ".";
      }
    }
    return out;
  }

  function fmtNum(n) {
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function idbOpen(cb) {
    if (!window.indexedDB) { cb(null); return; }
    try {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = function (e) { cb(e.target.result); };
      req.onerror = function () { cb(null); };
    } catch (e) {
      cb(null);
    }
  }

  function idbSet(key, val, cb) {
    idbOpen(function (db) {
      if (!db) { if (cb) cb(); return; }
      try {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
      } catch (e) {
        if (cb) cb();
      }
    });
  }

  function idbGet(key, cb) {
    idbOpen(function (db) {
      if (!db) { cb(null); return; }
      try {
        var tx = db.transaction(DB_STORE, "readonly");
        var req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = function () { cb(req.result || null); };
        req.onerror = function () { cb(null); };
      } catch (e) {
        cb(null);
      }
    });
  }

  function saveState(cb) {
    state.updatedAt = Date.now();
    var json = JSON.stringify(state);
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    idbSet(STORAGE_KEY, json, cb);
  }

  function applyLoadedData(raw) {
    if (!raw) return;
    try {
      var obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (obj && Array.isArray(obj.records)) state.records = obj.records;
      if (obj && obj.dayOffs && typeof obj.dayOffs === "object") state.dayOffs = obj.dayOffs;
      if (obj && typeof obj.workerName === "string") state.workerName = obj.workerName;
      if (obj && typeof obj.lastRate === "string") state.lastRate = obj.lastRate;
      if (obj && (obj.theme === "light" || obj.theme === "dark")) state.theme = obj.theme;
    } catch (e) {}
  }

  function initStorage(done) {
    var lsRaw = null;
    try { lsRaw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    idbGet(STORAGE_KEY, function (idbRaw) {
      var chosen = lsRaw;
      if (idbRaw) {
        try {
          var lsObj = lsRaw ? JSON.parse(lsRaw) : null;
          var idbObj = JSON.parse(idbRaw);
          var lsCount = lsObj && lsObj.records ? lsObj.records.length : 0;
          var idbCount = idbObj && idbObj.records ? idbObj.records.length : 0;
          if (idbCount > lsCount || (!lsRaw && idbRaw)) {
            chosen = idbRaw;
          }
        } catch (e) {}
      }
      applyLoadedData(chosen);
      if (chosen) {
        try { localStorage.setItem(STORAGE_KEY, chosen); } catch (e) {}
      }
      done();
    });
  }

  function getBackups(cb) {
    var list = [];
    try {
      var raw = localStorage.getItem(BACKUPS_KEY);
      if (raw) list = JSON.parse(raw);
    } catch (e) {}
    idbGet(BACKUPS_KEY, function (idbList) {
      if (Array.isArray(idbList) && idbList.length > list.length) {
        list = idbList;
      }
      cb(Array.isArray(list) ? list : []);
    });
  }

  function saveBackups(list, cb) {
    try { localStorage.setItem(BACKUPS_KEY, JSON.stringify(list)); } catch (e) {}
    idbSet(BACKUPS_KEY, list, cb);
  }

  function createBackupPoint(isAuto) {
    getBackups(function (list) {
      var now = new Date();
      var stamp = pad2(now.getDate()) + "." + pad2(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes());
      var dayTag = toIso(now.getFullYear(), now.getMonth(), now.getDate());
      if (isAuto) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].autoDay === dayTag) return;
        }
      }
      var item = {
        id: Date.now(),
        label: stamp + (isAuto ? " (авто)" : ""),
        autoDay: isAuto ? dayTag : "",
        count: state.records.length,
        data: JSON.stringify(state)
      };
      list.unshift(item);
      if (list.length > 8) list = list.slice(0, 8);
      saveBackups(list, function () {
        if (!isAuto) showToast("База сохранена (" + item.count + " зап.)");
      });
    });
  }

  function getActiveRange() {
    if (customRange) {
      return customRange.start <= customRange.end
        ? { start: customRange.start, end: customRange.end }
        : { start: customRange.end, end: customRange.start };
    }
    var d = parseIso(selectedDate);
    var y = d.getFullYear();
    var m = d.getMonth();
    var day = d.getDate();

    if (periodMode === "day") {
      return { start: selectedDate, end: selectedDate };
    }
    if (periodMode === "week") {
      var dow = d.getDay();
      var diffToMon = dow === 0 ? -6 : 1 - dow;
      var mon = new Date(y, m, day + diffToMon);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      return {
        start: toIso(mon.getFullYear(), mon.getMonth(), mon.getDate()),
        end: toIso(sun.getFullYear(), sun.getMonth(), sun.getDate())
      };
    }
    if (periodMode === "biweek") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (day <= 15) {
        return { start: toIso(y, m, 1), end: toIso(y, m, 15) };
      } else {
        return { start: toIso(y, m, 16), end: toIso(y, m, lastDay) };
      }
    }
    if (periodMode === "month") {
      var lastM = new Date(y, m + 1, 0).getDate();
      return { start: toIso(y, m, 1), end: toIso(y, m, lastM) };
    }
    return { start: toIso(y, 0, 1), end: toIso(y, 11, 31) };
  }

  function renderCalendar() {
    $("monthTitle").textContent = MONTHS_NOM[viewMonth] + " " + viewYear;
    $("verTag").textContent = "v " + APP_VERSION;

    var grid = $("daysGrid");
    grid.innerHTML = "";

    var firstDay = new Date(viewYear, viewMonth, 1);
    var startDow = firstDay.getDay();
    var offset = startDow === 0 ? 6 : startDow - 1;
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

    var activeRange = getActiveRange();
    var showRangeHighlight = (periodMode !== "day" || customRange !== null);

    var recDates = {};
    for (var r = 0; r < state.records.length; r++) {
      recDates[state.records[r].date] = true;
    }

    for (var i = 0; i < 42; i++) {
      var cellYear = viewYear;
      var cellMonth = viewMonth;
      var dayNum = 0;
      var isOther = false;

      if (i < offset) {
        dayNum = prevMonthDays - offset + 1 + i;
        cellMonth = viewMonth - 1;
        if (cellMonth < 0) { cellMonth = 11; cellYear--; }
        isOther = true;
      } else if (i >= offset + daysInMonth) {
        dayNum = i - (offset + daysInMonth) + 1;
        cellMonth = viewMonth + 1;
        if (cellMonth > 11) { cellMonth = 0; cellYear++; }
        isOther = true;
      } else {
        dayNum = i - offset + 1;
      }

      var iso = toIso(cellYear, cellMonth, dayNum);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      if (isOther) cell.className += " other-month";
      if (state.dayOffs[iso]) cell.className += " day-off";
      if (showRangeHighlight && iso >= activeRange.start && iso <= activeRange.end) {
        cell.className += " in-range";
      }
      if (iso === selectedDate) {
        cell.className += " selected";
      }
      cell.setAttribute("data-iso", iso);

      var numSpan = document.createElement("span");
      numSpan.textContent = String(dayNum);
      cell.appendChild(numSpan);

      if (recDates[iso]) {
        var dot = document.createElement("div");
        dot.className = "day-dot";
        cell.appendChild(dot);
      }

      grid.appendChild(cell);
    }

    $("selectedDateLabel").textContent = fmtDateFull(selectedDate);
  }

  function renderRecordsAndSummary() {
    var range = getActiveRange();
    var filtered = [];
    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;

    for (var i = 0; i < state.records.length; i++) {
      var rec = state.records[i];
      if (rec.date >= range.start && rec.date <= range.end) {
        filtered.push(rec);
        totalBoxes += rec.boxes;
        totalKg += rec.totalKg;
        totalRub += rec.totalRub;
      }
    }

    filtered.sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : a.id - b.id);
    });

    var titleText = "ДЕНЬ";
    var sumTitle = "ИТОГ ЗА ДЕНЬ";
    if (customRange) {
      var pText = fmtDateFull(range.start) + " – " + fmtDateFull(range.end);
      titleText = "ПЕРИОД (" + pText + ")";
      sumTitle = "ИТОГ ЗА ПЕРИОД (" + pText.toUpperCase() + ")";
    } else if (periodMode === "week") {
      var wText = fmtDateFull(range.start) + " – " + fmtDateFull(range.end);
      titleText = "НЕДЕЛЯ (" + wText + ")";
      sumTitle = "ИТОГ ЗА НЕДЕЛЮ (" + wText.toUpperCase() + ")";
    } else if (periodMode === "biweek") {
      var bText = fmtDateFull(range.start) + " – " + fmtDateFull(range.end);
      titleText = "2Х НЕДЕЛИ (" + bText + ")";
      sumTitle = "ИТОГ ЗА 2Х НЕДЕЛИ (" + bText.toUpperCase() + ")";
    } else if (periodMode === "month") {
      var mText = MONTHS_NOM[viewMonth] + " " + viewYear;
      titleText = "МЕСЯЦ (" + mText + ")";
      sumTitle = "ИТОГ ЗА МЕСЯЦ (" + mText.toUpperCase() + ")";
    } else if (periodMode === "year") {
      titleText = "ГОД (" + viewYear + ")";
      sumTitle = "ИТОГ ЗА ГОД (" + viewYear + ")";
    }

    $("recordsHeader").textContent = "ЗАПИСИ (" + titleText + ")";
    $("sumLabel").textContent = sumTitle;
    $("sumStats").textContent = totalBoxes + " кор. | " + fmtNum(totalKg) + " кг";
    $("sumMoney").textContent = fmtNum(totalRub) + " ₽";

    var listEl = $("recordsList");
    listEl.innerHTML = "";
    for (var j = 0; j < filtered.length; j++) {
      var item = filtered[j];
      var row = document.createElement("div");
      row.className = "rec-item";

      var info = document.createElement("span");
      info.textContent = fmtDateShort(item.date) + ": " + item.boxes + " кор. × " + fmtNum(item.boxWeight) + " кг = " + fmtNum(item.totalKg) + " кг (" + fmtNum(item.totalRub) + " ₽)";

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "rec-del";
      delBtn.textContent = "✕";
      delBtn.setAttribute("data-id", String(item.id));

      row.appendChild(info);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }

    var undoBar = $("undoBar");
    if (undoStack.length > 0) {
      undoBar.style.display = "flex";
      $("undoBtn").textContent = "↩ ОТМЕНИТЬ УДАЛЕНИЕ (" + undoStack.length + ")";
    } else {
      undoBar.style.display = "none";
    }
  }

  function updateShiftPreview() {
    var boxes = parseInt(cleanNumStr($("boxCount").value, false), 10) || 0;
    var weight = parseFloat(cleanNumStr($("boxWeight").value, true)) || 0;
    var rate = parseFloat(cleanNumStr($("ratePerKg").value, true)) || 0;
    var kg = Math.round(boxes * weight * 100) / 100;
    var rub = Math.round(kg * rate * 100) / 100;
    $("previewKg").textContent = fmtNum(kg) + " кг";
    $("previewRub").textContent = fmtNum(rub) + " ₽";
  }

  function refreshAll() {
    renderCalendar();
    renderRecordsAndSummary();
    updateShiftPreview();
  }

  function selectDateAndSync(iso) {
    selectedDate = iso;
    var d = parseIso(iso);
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    customRange = null;
    refreshAll();
  }

  function buildReportText(isFull) {
    var range = getActiveRange();
    var filtered = [];
    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;

    for (var i = 0; i < state.records.length; i++) {
      var rec = state.records[i];
      if (rec.date >= range.start && rec.date <= range.end) {
        filtered.push(rec);
        totalBoxes += rec.boxes;
        totalKg += rec.totalKg;
        totalRub += rec.totalRub;
      }
    }

    filtered.sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : a.id - b.id);
    });

    var name = ($("workerName").value || state.workerName || "").trim();
    var lines = [];

    if (!isFull) {
      if (name) lines.push(name);
      if (customRange && range.start !== range.end) {
        lines.push(fmtDateShort(range.start) + " – " + fmtDateShort(range.end));
      }
      lines.push("Вес: " + fmtNum(totalKg) + " кг " + totalBoxes + " кор.");
      return lines.join("\n");
    }

    if (name) lines.push(name);
    if (range.start === range.end) {
      lines.push(fmtDateShort(range.start));
    } else {
      lines.push(fmtDateShort(range.start) + " – " + fmtDateShort(range.end));
    }

    for (var j = 0; j < filtered.length; j++) {
      var r = filtered[j];
      lines.push(fmtDateShort(r.date) + " | " + r.boxes + "кор | " + fmtNum(r.totalKg) + "кг | " + fmtNum(r.totalRub) + "₽");
    }

    lines.push("ИТОГ: " + totalBoxes + "кор | " + fmtNum(totalKg) + "кг | " + fmtNum(totalRub) + "₽");
    return lines.join("\n");
  }

  function silentCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    } else {
      var ta = $("reportPreviewText");
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
    }
  }

  function openConfirm(text, onYes) {
    $("confirmText").textContent = text;
    pendingConfirmAction = onYes;
    $("confirmModal").style.display = "flex";
  }

  function renderBackupList() {
    getBackups(function (list) {
      var box = $("backupList");
      box.innerHTML = "";
      if (list.length === 0) {
        box.innerHTML = "<div style='font-size:12px;color:var(--text-dim);text-align:center;padding:12px;'>Сохранённых копий пока нет</div>";
        return;
      }
      for (var i = 0; i < list.length; i++) {
        (function (item) {
          var row = document.createElement("div");
          row.className = "backup-item";

          var label = document.createElement("span");
          var cnt = typeof item.count === "number" ? item.count : 0;
          label.textContent = (item.label || "Копия") + " (" + cnt + " зап.)";

          var btns = document.createElement("div");
          btns.style.display = "flex";
          btns.style.gap = "4px";

          var restBtn = document.createElement("button");
          restBtn.type = "button";
          restBtn.className = "m-btn green";
          restBtn.style.height = "26px";
          restBtn.style.padding = "0 8px";
          restBtn.textContent = "Восстановить";
          restBtn.onclick = function () {
            applyLoadedData(item.data);
            $("workerName").value = state.workerName || "";
            $("ratePerKg").value = state.lastRate || "";
            saveState();
            refreshAll();
            $("restoreModal").style.display = "none";
            showToast("База восстановлена");
          };

          var delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "m-btn red";
          delBtn.style.height = "26px";
          delBtn.style.padding = "0 8px";
          delBtn.textContent = "✕";
          delBtn.onclick = function () {
            openConfirm("Удалить эту сохранённую базу? Вы уверены?", function () {
              getBackups(function (cur) {
                var next = cur.filter(function (x) { return x.id !== item.id; });
                saveBackups(next, function () {
                  renderBackupList();
                  showToast("Копия удалена");
                });
              });
            });
          };

          btns.appendChild(restBtn);
          btns.appendChild(delBtn);
          row.appendChild(label);
          row.appendChild(btns);
          box.appendChild(row);
        })(list[i]);
      }
    });
  }

  function bindEvents() {
    $("prevMonthBtn").onclick = function () {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (periodMode === "month" || periodMode === "year") {
        selectedDate = toIso(viewYear, viewMonth, 1);
      }
      refreshAll();
    };

    $("nextMonthBtn").onclick = function () {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      if (periodMode === "month" || periodMode === "year") {
        selectedDate = toIso(viewYear, viewMonth, 1);
      }
      refreshAll();
    };

    var tabs = $("periodTabs").querySelectorAll(".tab-btn");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function () {
        for (var k = 0; k < tabs.length; k++) tabs[k].classList.remove("active");
        this.classList.add("active");
        periodMode = this.getAttribute("data-mode");
        customRange = null;
        var d = parseIso(selectedDate);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        refreshAll();
      };
    }

    var grid = $("daysGrid");

    function getCellIsoFromPoint(x, y) {
      var el = document.elementFromPoint(x, y);
      while (el && el !== grid) {
        if (el.hasAttribute && el.hasAttribute("data-iso")) {
          return el.getAttribute("data-iso");
        }
        el = el.parentNode;
      }
      return null;
    }

    grid.onpointerdown = function (e) {
      var iso = getCellIsoFromPoint(e.clientX, e.clientY);
      if (!iso) return;
      isDragging = true;
      dragStart = iso;
      selectDateAndSync(iso);
    };

    grid.onpointermove = function (e) {
      if (!isDragging || !dragStart) return;
      var iso = getCellIsoFromPoint(e.clientX, e.clientY);
      if (!iso || iso === dragStart) return;
      customRange = { start: dragStart, end: iso };
      refreshAll();
    };

    window.addEventListener("pointerup", function () {
      isDragging = false;
      dragStart = null;
    });

    $("dayOffBtn").onclick = function () {
      if (state.dayOffs[selectedDate]) {
        delete state.dayOffs[selectedDate];
        showToast("Выходной снят");
      } else {
        state.dayOffs[selectedDate] = true;
        createBackupPoint(true);
        showToast("Отмечен выходной");
      }
      saveState();
      refreshAll();
    };

    $("recordsList").onclick = function (e) {
      var btn = e.target;
      if (btn && btn.classList.contains("rec-del")) {
        var id = Number(btn.getAttribute("data-id"));
        var idx = -1;
        for (var i = 0; i < state.records.length; i++) {
          if (state.records[i].id === id) { idx = i; break; }
        }
        if (idx !== -1) {
          var removed = state.records.splice(idx, 1)[0];
          undoStack.push(removed);
          saveState();
          refreshAll();
        }
      }
    };

    $("undoBtn").onclick = function () {
      if (undoStack.length === 0) return;
      var rec = undoStack.pop();
      state.records.push(rec);
      saveState();
      refreshAll();
      showToast("Запись возвращена");
    };

    $("clearUndoBtn").onclick = function () {
      openConfirm("Очистить все отменённые удаления? Вернуть их будет нельзя.", function () {
        undoStack = [];
        refreshAll();
        showToast("Список отмен очищен");
      });
    };

    $("workerName").oninput = function () {
      state.workerName = this.value;
      saveState();
    };

    $("boxCount").oninput = function () {
      this.value = cleanNumStr(this.value, false);
      updateShiftPreview();
    };

    $("boxWeight").oninput = function () {
      this.value = cleanNumStr(this.value, true);
      updateShiftPreview();
    };

    $("ratePerKg").oninput = function () {
      this.value = cleanNumStr(this.value, true);
      state.lastRate = this.value;
      saveState();
      updateShiftPreview();
    };

    $("addRecordBtn").onclick = function () {
      var boxes = parseInt(cleanNumStr($("boxCount").value, false), 10) || 0;
      var weight = parseFloat(cleanNumStr($("boxWeight").value, true)) || 0;
      var rate = parseFloat(cleanNumStr($("ratePerKg").value, true)) || 0;

      if (boxes <= 0 || weight <= 0) {
        showToast("Введите коробки и вес");
        return;
      }

      var kg = Math.round(boxes * weight * 100) / 100;
      var rub = Math.round(kg * rate * 100) / 100;

      state.records.push({
        id: Date.now(),
        date: selectedDate,
        boxes: boxes,
        boxWeight: weight,
        rate: rate,
        totalKg: kg,
        totalRub: rub
      });

      if (state.dayOffs[selectedDate]) delete state.dayOffs[selectedDate];
      $("boxCount").value = "";
      $("boxWeight").value = "";
      createBackupPoint(true);
      saveState();
      refreshAll();
      showToast("Смена добавлена");
    };

    $("fullReportBtn").onclick = function () {
      $("reportPreviewText").value = buildReportText(true);
      $("reportModal").style.display = "flex";
    };

    $("shortReportBtn").onclick = function () {
      $("reportPreviewText").value = buildReportText(false);
      $("reportModal").style.display = "flex";
    };

    $("cancelReportBtn").onclick = function () {
      $("reportModal").style.display = "none";
    };

    $("sendWaBtn").onclick = function () {
      var text = $("reportPreviewText").value;
      silentCopy(text);
      $("reportModal").style.display = "none";
      window.location.href = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
    };

    $("sendTgBtn").onclick = function () {
      var text = $("reportPreviewText").value;
      silentCopy(text);
      $("reportModal").style.display = "none";
      window.location.href = "https://t.me/share/url?url=" + encodeURIComponent(" ") + "&text=" + encodeURIComponent(text);
    };

    $("sendNativeBtn").onclick = function () {
      var text = $("reportPreviewText").value;
      silentCopy(text);
      $("reportModal").style.display = "none";
      if (navigator.share) {
        navigator.share({ text: text }).catch(function () {});
      } else {
        showToast("Скопировано для вставки в MAX");
      }
    };

    $("themeBtn").onclick = function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.body.classList.toggle("light", state.theme === "light");
      $("themeBtn").textContent = state.theme === "dark" ? "☀️" : "🌙";
      saveState();
    };

    $("saveBackupBtn").onclick = function () {
      createBackupPoint(false);
    };

    $("restoreModalBtn").onclick = function () {
      renderBackupList();
      $("restoreModal").style.display = "flex";
    };

    $("closeRestoreBtn").onclick = function () {
      $("restoreModal").style.display = "none";
    };

    $("transferCodeBtn").onclick = function () {
      $("transferCodeArea").value = JSON.stringify(state);
      $("codeModal").style.display = "flex";
    };

    $("copyCodeBtn").onclick = function () {
      var ta = $("transferCodeArea");
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(function () {});
      showToast("Код базы скопирован");
    };

    $("applyCodeBtn").onclick = function () {
      var raw = $("transferCodeArea").value.trim();
      if (!raw) { showToast("Вставьте код базы"); return; }
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.records)) throw new Error("bad");
        applyLoadedData(parsed);
        $("workerName").value = state.workerName || "";
        $("ratePerKg").value = state.lastRate || "";
        saveState();
        refreshAll();
        $("codeModal").style.display = "none";
        $("restoreModal").style.display = "none";
        showToast("База успешно загружена");
      } catch (e) {
        showToast("Неверный формат кода");
      }
    };

    $("closeCodeBtn").onclick = function () {
      $("codeModal").style.display = "none";
    };

    $("confirmYesBtn").onclick = function () {
      $("confirmModal").style.display = "none";
      if (pendingConfirmAction) {
        var fn = pendingConfirmAction;
        pendingConfirmAction = null;
        fn();
      }
    };

    $("confirmNoBtn").onclick = function () {
      $("confirmModal").style.display = "none";
      pendingConfirmAction = null;
    };

    $("updateBtn").onclick = function () {
      if (window.location.protocol === "file:") {
        showToast("Локальный файл: актуальная v " + APP_VERSION);
        return;
      }
      showToast("Проверка обновления...");
      saveState(function () {
        var url = "app.js?nocache=" + Date.now();
        fetch(url, { cache: "no-store" })
          .then(function (r) { return r.text(); })
          .then(function (txt) {
            var m = txt.match(/APP_VERSION\s*=\s*"([^"]+)"/);
            var remoteVer = m ? m[1] : APP_VERSION;
            if (remoteVer !== APP_VERSION) {
              showToast("Обновление до v " + remoteVer + "...");
              if (window.caches) {
                caches.keys().then(function (keys) {
                  return Promise.all(keys.map(function (k) { return caches.delete(k); }));
                }).finally(function () {
                  window.location.replace("index.html?v=" + encodeURIComponent(remoteVer) + "&t=" + Date.now());
                });
              } else {
                window.location.replace("index.html?v=" + encodeURIComponent(remoteVer) + "&t=" + Date.now());
              }
            } else {
              showToast("У вас актуальная версия v " + APP_VERSION);
            }
          })
          .catch(function () {
            showToast("Нет связи с сервером обновлений");
          });
      });
    };
  }

  function boot() {
    var today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    selectedDate = toIso(viewYear, viewMonth, today.getDate());

    bindEvents();
    refreshAll();

    initStorage(function () {
      if (state.theme === "light") {
        document.body.classList.add("light");
        $("themeBtn").textContent = "🌙";
      }
      $("workerName").value = state.workerName || "";
      $("ratePerKg").value = state.lastRate || "";
      refreshAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
