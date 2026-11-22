(function() {
  var APP_VERSION = "7.4";
  var DB_NAME = "obvalka_pro_db";
  var STORE_NAME = "kv";
  var STORAGE_KEY = "obvalka_data_v1";
  var BACKUPS_KEY = "obvalka_backups_v1";

  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  var state = {
    viewYear: 2026,
    viewMonth: 10,
    selectedDate: "2026-11-22",
    rangeStart: null,
    rangeEnd: null,
    mode: "day",
    theme: "dark",
    worker: "",
    rate: "",
    records: {},
    dayOffs: {},
    undoStack: [],
    lastAutoBackupDate: ""
  };

  var backups = [];
  var isDragging = false;
  var dragStartStr = null;
  var confirmCallback = null;

  function $(id) { return document.getElementById(id); }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function toDateStr(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }

  function parseDateStr(str) {
    var p = str.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function formatShortDate(str) {
    var d = parseDateStr(str);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function formatGenDate(str) {
    var d = parseDateStr(str);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function parseNum(val) {
    if (typeof val === "number") return isNaN(val) ? 0 : val;
    if (!val) return 0;
    var s = String(val).replace(/,/g, ".").replace(/[^0-9.]/g, "");
    var parts = s.split(".");
    if (parts.length > 2) s = parts[0] + "." + parts.slice(1).join("");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function round2(n) { return Math.round(n * 100) / 100; }
  function round1(n) { return Math.round(n * 10) / 10; }

  function showToast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    if (ms !== 0) {
      t._timer = setTimeout(function() { t.style.display = "none"; }, ms || 2400);
    }
  }

  function openIDB(cb) {
    if (!window.indexedDB) { cb(null); return; }
    try {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function(e) { cb(e.target.result); };
      req.onerror = function() { cb(null); };
    } catch (e) { cb(null); }
  }

  function idbSet(key, val, done) {
    openIDB(function(db) {
      if (!db) { if (done) done(); return; }
      try {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(val, key);
        tx.oncomplete = function() { if (done) done(); };
        tx.onerror = function() { if (done) done(); };
      } catch (e) { if (done) done(); }
    });
  }

  function idbGet(key, cb) {
    openIDB(function(db) {
      if (!db) { cb(null); return; }
      try {
        var tx = db.transaction(STORE_NAME, "readonly");
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function() { cb(req.result || null); };
        req.onerror = function() { cb(null); };
      } catch (e) { cb(null); }
    });
  }

  function countItems(obj) {
    if (!obj || !obj.records) return 0;
    var c = 0;
    for (var k in obj.records) {
      if (obj.records.hasOwnProperty(k)) c += obj.records[k].length;
    }
    if (obj.dayOffs) {
      for (var d in obj.dayOffs) {
        if (obj.dayOffs.hasOwnProperty(d) && obj.dayOffs[d]) c++;
      }
    }
    return c;
  }

  function getSerializableState() {
    return {
      theme: state.theme,
      worker: state.worker,
      rate: state.rate,
      records: state.records,
      dayOffs: state.dayOffs,
      lastAutoBackupDate: state.lastAutoBackupDate
    };
  }

  function saveAll(done) {
    var payload = JSON.stringify(getSerializableState());
    var bkpStr = JSON.stringify(backups);
    try { localStorage.setItem(STORAGE_KEY, payload); } catch (e) {}
    try { localStorage.setItem(BACKUPS_KEY, bkpStr); } catch (e) {}
    try { window.name = "OBV_BKP:" + payload; } catch (e) {}
    idbSet(STORAGE_KEY, payload, function() {
      idbSet(BACKUPS_KEY, bkpStr, function() {
        if (done) done();
      });
    });
  }

  function applyLoadedState(obj) {
    if (!obj) return;
    if (obj.theme) state.theme = obj.theme;
    if (typeof obj.worker === "string") state.worker = obj.worker;
    if (obj.rate !== undefined) state.rate = String(obj.rate);
    if (obj.records && typeof obj.records === "object") state.records = obj.records;
    if (obj.dayOffs && typeof obj.dayOffs === "object") state.dayOffs = obj.dayOffs;
    if (obj.lastAutoBackupDate) state.lastAutoBackupDate = obj.lastAutoBackupDate;
  }

  function createBackup(label, done) {
    var snap = getSerializableState();
    var now = new Date();
    var stamp = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    backups.unshift({
      id: Date.now() + Math.random(),
      date: stamp,
      label: label || "",
      count: countItems(snap),
      data: snap
    });
    if (backups.length > 10) backups = backups.slice(0, 10);
    saveAll(done);
  }

  function loadAll(cb) {
    var lsObj = null;
    var wnObj = null;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsObj = JSON.parse(raw);
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBV_BKP:") === 0) {
        wnObj = JSON.parse(window.name.slice(8));
      }
    } catch (e) {}
    try {
      var rawB = localStorage.getItem(BACKUPS_KEY);
      if (rawB) backups = JSON.parse(rawB) || [];
    } catch (e) {}

    idbGet(STORAGE_KEY, function(idbRaw) {
      var idbObj = null;
      try { if (idbRaw) idbObj = JSON.parse(idbRaw); } catch (e) {}
      idbGet(BACKUPS_KEY, function(idbBRaw) {
        try {
          if (idbBRaw) {
            var idbB = JSON.parse(idbBRaw);
            if (Array.isArray(idbB) && idbB.length > backups.length) backups = idbB;
          }
        } catch (e) {}

        var candidates = [lsObj, idbObj, wnObj];
        var best = null;
        var bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i]) {
            var sc = countItems(candidates[i]);
            if (sc > bestScore) {
              bestScore = sc;
              best = candidates[i];
            }
          }
        }
        if (best) applyLoadedState(best);

        var wasUpdating = false;
        try {
          if (sessionStorage.getItem("obv_updating") === "1") {
            wasUpdating = true;
            sessionStorage.removeItem("obv_updating");
          }
        } catch (e) {}

        if (wasUpdating && bestScore === 0 && backups.length > 0 && backups[0].data) {
          applyLoadedState(backups[0].data);
        }

        saveAll(function() {
          cb(wasUpdating);
        });
      });
    });
  }

  function getPeriodRange() {
    if (state.rangeStart && state.rangeEnd) {
      return state.rangeStart <= state.rangeEnd
        ? { start: state.rangeStart, end: state.rangeEnd, manual: true }
        : { start: state.rangeEnd, end: state.rangeStart, manual: true };
    }
    var sel = parseDateStr(state.selectedDate);
    var y = sel.getFullYear();
    var m = sel.getMonth();
    var d = sel.getDate();

    if (state.mode === "day") {
      return { start: state.selectedDate, end: state.selectedDate, manual: false };
    }
    if (state.mode === "week") {
      var dow = sel.getDay();
      var diff = dow === 0 ? 6 : dow - 1;
      var mon = new Date(y, m, d - diff);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      return {
        start: toDateStr(mon.getFullYear(), mon.getMonth(), mon.getDate()),
        end: toDateStr(sun.getFullYear(), sun.getMonth(), sun.getDate()),
        manual: false
      };
    }
    if (state.mode === "half") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (d <= 15) {
        return { start: toDateStr(y, m, 1), end: toDateStr(y, m, 15), manual: false };
      } else {
        return { start: toDateStr(y, m, 16), end: toDateStr(y, m, lastDay), manual: false };
      }
    }
    if (state.mode === "month") {
      var ld = new Date(y, m + 1, 0).getDate();
      return { start: toDateStr(y, m, 1), end: toDateStr(y, m, ld), manual: false };
    }
    return { start: toDateStr(y, 0, 1), end: toDateStr(y, 11, 31), manual: false };
  }

  function getDatesInRange(startStr, endStr) {
    var list = [];
    var cur = parseDateStr(startStr);
    var end = parseDateStr(endStr);
    while (cur <= end) {
      list.push(toDateStr(cur.getFullYear(), cur.getMonth(), cur.getDate()));
      cur.setDate(cur.getDate() + 1);
    }
    return list;
  }

  function renderCalendar() {
    $("monthTitle").textContent = MONTHS_NOM[state.viewMonth] + " " + state.viewYear;
    $("verTag").textContent = "v " + APP_VERSION;

    var tabs = $("periodTabs").children;
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute("data-mode") === state.mode && !state.rangeStart) {
        t.classList.add("active");
      } else {
        t.classList.remove("active");
      }
    }

    var range = getPeriodRange();
    var grid = $("daysGrid");
    grid.innerHTML = "";

    var firstDow = new Date(state.viewYear, state.viewMonth, 1).getDay();
    var offset = firstDow === 0 ? 6 : firstDow - 1;
    var startCellDate = new Date(state.viewYear, state.viewMonth, 1 - offset);

    for (var c = 0; c < 42; c++) {
      var cellDate = new Date(startCellDate.getFullYear(), startCellDate.getMonth(), startCellDate.getDate() + c);
      var dStr = toDateStr(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
      var div = document.createElement("div");
      div.className = "day-cell";
      div.textContent = cellDate.getDate();
      div.setAttribute("data-date", dStr);

      if (cellDate.getMonth() !== state.viewMonth) div.classList.add("other");
      if (dStr >= range.start && dStr <= range.end) div.classList.add("in-range");
      if (dStr === state.selectedDate) div.classList.add("selected");
      if (state.dayOffs[dStr]) div.classList.add("day-off");

      if (state.records[dStr] && state.records[dStr].length > 0) {
        var dot = document.createElement("div");
        dot.className = "day-dot";
        div.appendChild(dot);
      }

      grid.appendChild(div);
    }
  }

  function renderSummaryAndRecords() {
    var range = getPeriodRange();
    var dates = getDatesInRange(range.start, range.end);

    var modeNames = { day: "ДЕНЬ", week: "НЕДЕЛЮ", half: "2Х НЕДЕЛИ", month: "МЕСЯЦ", year: "ГОД" };
    var titleText = range.manual
      ? formatShortDate(range.start) + " – " + formatShortDate(range.end)
      : (state.mode === "month"
          ? "МЕСЯЦ (" + MONTHS_NOM[state.viewMonth].toUpperCase() + " " + state.viewYear + ")"
          : (state.mode === "half"
              ? "2Х НЕДЕЛИ (" + formatShortDate(range.start) + " – " + formatShortDate(range.end) + ")"
              : modeNames[state.mode]));

    $("recHeader").textContent = "ЗАПИСИ (" + titleText + ")";
    $("sumTitle").textContent = "ИТОГ ЗА " + titleText;
    $("selDateLabel").textContent = formatGenDate(state.selectedDate);

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalMoney = 0;
    var listEl = $("recList");
    listEl.innerHTML = "";

    for (var i = 0; i < dates.length; i++) {
      var dStr = dates[i];
      var dayRecs = state.records[dStr] || [];
      for (var j = 0; j < dayRecs.length; j++) {
        var r = dayRecs[j];
        var b = parseInt(r.boxes, 10) || 0;
        var w = parseNum(r.weight);
        var m = parseNum(r.money);
        totalBoxes += b;
        totalWeight = round1(totalWeight + w);
        totalMoney = round2(totalMoney + m);

        var item = document.createElement("div");
        item.className = "rec-item";
        var left = document.createElement("div");
        left.innerHTML = "<b>" + formatShortDate(dStr) + "</b> • " + b + " кор. | " + w + " кг | <span style='color:var(--yellow);font-weight:700;'>" + m + " ₽</span>";
        var del = document.createElement("button");
        del.className = "rec-del";
        del.textContent = "✕";
        del.setAttribute("data-date", dStr);
        del.setAttribute("data-idx", j);
        item.appendChild(left);
        item.appendChild(del);
        listEl.appendChild(item);
      }
    }

    $("sumWeight").textContent = totalBoxes + " кор. | " + totalWeight + " кг";
    $("sumMoney").textContent = totalMoney + " ₽";

    var undoBtn = $("btnUndo");
    if (state.undoStack.length > 0) {
      undoBtn.style.display = "inline-block";
      undoBtn.textContent = "↩ Отменить (" + state.undoStack.length + ")";
    } else {
      undoBtn.style.display = "none";
    }

    var clearBtn = $("btnClearPeriod");
    clearBtn.style.display = listEl.children.length > 0 ? "inline-block" : "none";
  }

  function updateShiftPreview() {
    var w = parseNum($("inpWeight").value);
    var r = parseNum($("inpRate").value);
    var m = round2(w * r);
    $("shiftW").textContent = round1(w) + " кг";
    $("shiftM").textContent = m + " ₽";
  }

  function renderAll() {
    if (state.theme === "light") document.body.classList.add("light");
    else document.body.classList.remove("light");
    $("btnTheme").textContent = state.theme === "light" ? "🌙" : "☀️";
    $("inpWorker").value = state.worker;
    $("inpRate").value = state.rate;
    renderCalendar();
    renderSummaryAndRecords();
    updateShiftPreview();
  }

  function buildReportText(isFull) {
    var range = getPeriodRange();
    var dates = getDatesInRange(range.start, range.end);
    var lines = [];
    var wName = state.worker.trim();
    if (wName) lines.push(wName);

    var isMultiManual = range.manual && range.start !== range.end;
    var totalBoxes = 0;
    var totalWeight = 0;
    var totalMoney = 0;
    var dayLines = [];

    for (var i = 0; i < dates.length; i++) {
      var dStr = dates[i];
      var recs = state.records[dStr] || [];
      for (var j = 0; j < recs.length; j++) {
        var r = recs[j];
        var b = parseInt(r.boxes, 10) || 0;
        var w = parseNum(r.weight);
        var m = parseNum(r.money);
        totalBoxes += b;
        totalWeight = round1(totalWeight + w);
        totalMoney = round2(totalMoney + m);
        dayLines.push(formatShortDate(dStr) + " | " + b + "кор | " + w + "кг | " + m.toFixed(2) + "₽");
      }
    }

    if (!isFull) {
      if (isMultiManual) {
        lines.push(formatShortDate(range.start) + " – " + formatShortDate(range.end));
      }
      lines.push("Вес: " + totalWeight + " кг " + totalBoxes + " кор.");
      return lines.join("\n");
    }

    if (range.start === range.end) {
      lines.push(formatGenDate(range.start));
    } else {
      lines.push(formatShortDate(range.start) + " – " + formatShortDate(range.end));
    }
    for (var k = 0; k < dayLines.length; k++) lines.push(dayLines[k]);
    lines.push("ИТОГ: " + totalBoxes + "кор | " + totalWeight + "кг | " + totalMoney.toFixed(2) + "₽");
    return lines.join("\n");
  }

  function openConfirm(title, text, cb) {
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    confirmCallback = cb;
    $("modalConfirm").style.display = "flex";
  }

  function renderBackupList() {
    var list = $("backupList");
    list.innerHTML = "";
    if (!backups.length) {
      list.innerHTML = "<div style='font-size:12px;color:var(--muted);text-align:center;padding:12px;'>Сохранённых копий пока нет</div>";
      return;
    }
    for (var i = 0; i < backups.length; i++) {
      var b = backups[i];
      var cnt = typeof b.count === "number" ? b.count : countItems(b.data);
      var lbl = b.label ? " " + b.label : "";
      var row = document.createElement("div");
      row.className = "backup-item";
      row.innerHTML = "<div><b>" + (b.date || "Копия") + lbl + "</b><br><span style='color:var(--muted);'>Записей: " + cnt + "</span></div>";

      var btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "5px";

      var btnRes = document.createElement("button");
      btnRes.className = "m-btn green";
      btnRes.style.padding = "5px 9px";
      btnRes.textContent = "Восстановить";
      btnRes.setAttribute("data-idx", i);

      var btnDel = document.createElement("button");
      btnDel.className = "m-btn red";
      btnDel.style.padding = "5px 8px";
      btnDel.textContent = "✕";
      btnDel.setAttribute("data-del-idx", i);

      btns.appendChild(btnRes);
      btns.appendChild(btnDel);
      row.appendChild(btns);
      list.appendChild(row);
    }
  }

  function runStepByStepUpdate() {
    var btn = $("btnUpdate");
    if (btn._busy) return;
    btn._busy = true;

    showToast("Шаг 1/4: Сохранение базы в память...", 0);
    try { sessionStorage.setItem("obv_updating", "1"); } catch (e) {}

    createBackup("(перед обн.)", function() {
      setTimeout(function() {
        showToast("Шаг 2/4: Проверка целостности данных...", 0);
        saveAll(function() {
          setTimeout(function() {
            showToast("Шаг 3/4: Очистка старого кэша...", 0);
            var cleanTasks = [];
            if (window.caches && caches.keys) {
              cleanTasks.push(caches.keys().then(function(names) {
                return Promise.all(names.map(function(n) { return caches.delete(n); }));
              }));
            }
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              cleanTasks.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
                return Promise.all(regs.map(function(r) { return r.unregister(); }));
              }));
            }
            Promise.all(cleanTasks).catch(function() {}).then(function() {
              setTimeout(function() {
                showToast("Шаг 4/4: Перезагрузка на новую версию...", 0);
                setTimeout(function() {
                  var baseUrl = window.location.href.split("?")[0].split("#")[0];
                  window.location.replace(baseUrl + "?v=" + Date.now());
                }, 800);
              }, 800);
            });
          }, 800);
        });
      }, 800);
    });
  }

  function bindEvents() {
    $("prevMonth").onclick = function() {
      state.rangeStart = null;
      state.rangeEnd = null;
      state.viewMonth--;
      if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
      var ld = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
      var curD = parseDateStr(state.selectedDate).getDate();
      state.selectedDate = toDateStr(state.viewYear, state.viewMonth, Math.min(curD, ld));
      renderAll();
    };

    $("nextMonth").onclick = function() {
      state.rangeStart = null;
      state.rangeEnd = null;
      state.viewMonth++;
      if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
      var ld = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
      var curD = parseDateStr(state.selectedDate).getDate();
      state.selectedDate = toDateStr(state.viewYear, state.viewMonth, Math.min(curD, ld));
      renderAll();
    };

    $("periodTabs").onclick = function(e) {
      var tab = e.target.closest(".tab");
      if (!tab) return;
      state.mode = tab.getAttribute("data-mode");
      state.rangeStart = null;
      state.rangeEnd = null;
      renderAll();
    };

    var grid = $("daysGrid");
    grid.addEventListener("pointerdown", function(e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      var dStr = cell.getAttribute("data-date");
      isDragging = true;
      dragStartStr = dStr;
      state.selectedDate = dStr;
      state.rangeStart = null;
      state.rangeEnd = null;
      var dt = parseDateStr(dStr);
      state.viewYear = dt.getFullYear();
      state.viewMonth = dt.getMonth();
      renderAll();
    });

    grid.addEventListener("pointermove", function(e) {
      if (!isDragging) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      var cell = el.closest(".day-cell");
      if (!cell) return;
      var dStr = cell.getAttribute("data-date");
      if (dStr && dStr !== dragStartStr) {
        state.rangeStart = dragStartStr;
        state.rangeEnd = dStr;
        state.selectedDate = dStr;
        renderAll();
      }
    });

    window.addEventListener("pointerup", function() { isDragging = false; });

    $("btnDayOff").onclick = function() {
      var dStr = state.selectedDate;
      state.dayOffs[dStr] = !state.dayOffs[dStr];
      if (!state.dayOffs[dStr]) delete state.dayOffs[dStr];
      saveAll();
      renderAll();
    };

    $("inpWorker").oninput = function() {
      state.worker = $("inpWorker").value;
      saveAll();
    };

    $("inpBoxes").oninput = function() {
      $("inpBoxes").value = $("inpBoxes").value.replace(/[^0-9]/g, "");
    };

    $("inpWeight").oninput = function() {
      $("inpWeight").value = $("inpWeight").value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
      updateShiftPreview();
    };

    $("inpRate").oninput = function() {
      $("inpRate").value = $("inpRate").value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
      state.rate = $("inpRate").value;
      saveAll();
      updateShiftPreview();
    };

    $("btnAdd").onclick = function() {
      var boxes = parseInt($("inpBoxes").value, 10) || 0;
      var weight = round1(parseNum($("inpWeight").value));
      var rate = parseNum($("inpRate").value);
      if (boxes <= 0 && weight <= 0) {
        showToast("Введите коробки или вес", 1800);
        return;
      }
      var money = round2(weight * rate);
      var dStr = state.selectedDate;
      if (!state.records[dStr]) state.records[dStr] = [];
      state.records[dStr].push({ boxes: boxes, weight: weight, rate: rate, money: money });
      delete state.dayOffs[dStr];

      $("inpBoxes").value = "";
      $("inpWeight").value = "";
      updateShiftPreview();

      var todayStr = toDateStr(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
      if (state.lastAutoBackupDate !== todayStr) {
        state.lastAutoBackupDate = todayStr;
        createBackup("(авто)");
      } else {
        saveAll();
      }
      renderAll();
      showToast("Запись добавлена: " + weight + " кг • " + money + " ₽", 1800);
    };

    $("recList").onclick = function(e) {
      var btn = e.target.closest(".rec-del");
      if (!btn) return;
      var dStr = btn.getAttribute("data-date");
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      var arr = state.records[dStr];
      if (!arr || !arr[idx]) return;
      var removed = arr.splice(idx, 1)[0];
      if (arr.length === 0) delete state.records[dStr];
      state.undoStack.push({ date: dStr, item: removed });
      saveAll();
      renderAll();
    };

    $("btnUndo").onclick = function() {
      if (!state.undoStack.length) return;
      var last = state.undoStack.pop();
      if (!state.records[last.date]) state.records[last.date] = [];
      state.records[last.date].push(last.item);
      saveAll();
      renderAll();
    };

    $("btnClearPeriod").onclick = function() {
      openConfirm("Очистить записи", "Удалить все записи за выбранный период?", function() {
        var range = getPeriodRange();
        var dates = getDatesInRange(range.start, range.end);
        for (var i = 0; i < dates.length; i++) {
          delete state.records[dates[i]];
        }
        saveAll();
        renderAll();
        showToast("Записи за период удалены", 1800);
      });
    };

    $("btnRepFull").onclick = function() {
      $("reportText").value = buildReportText(true);
      $("modalReport").style.display = "flex";
    };

    $("btnRepShort").onclick = function() {
      $("reportText").value = buildReportText(false);
      $("modalReport").style.display = "flex";
    };

    $("repCancel").onclick = function() { $("modalReport").style.display = "none"; };

    $("repSend").onclick = function() {
      var txt = $("reportText").value;
      $("modalReport").style.display = "none";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function() {});
      }
      if (navigator.share) {
        navigator.share({ text: txt }).catch(function() {});
      } else {
        showToast("Отчёт скопирован в буфер обмена", 2000);
      }
    };

    $("btnSaveBase").onclick = function() {
      createBackup("", function() {
        showToast("База сохранена в память (" + countItems(getSerializableState()) + " зап.)", 2200);
      });
    };

    $("btnRestoreBase").onclick = function() {
      renderBackupList();
      $("modalBackups").style.display = "flex";
    };

    $("backupsClose").onclick = function() { $("modalBackups").style.display = "none"; };

    $("backupList").onclick = function(e) {
      var resBtn = e.target.closest("[data-idx]");
      if (resBtn) {
        var idx = parseInt(resBtn.getAttribute("data-idx"), 10);
        var b = backups[idx];
        if (b && b.data) {
          applyLoadedState(b.data);
          saveAll();
          renderAll();
          $("modalBackups").style.display = "none";
          showToast("База восстановлена", 2000);
        }
        return;
      }
      var delBtn = e.target.closest("[data-del-idx]");
      if (delBtn) {
        var dIdx = parseInt(delBtn.getAttribute("data-del-idx"), 10);
        openConfirm("Удаление копии", "Удалить эту сохранённую базу? Вы уверены?", function() {
          backups.splice(dIdx, 1);
          saveAll();
          renderBackupList();
        });
      }
    };

    $("btnTransferOpen").onclick = function() {
      $("transferArea").value = JSON.stringify(getSerializableState());
      $("modalTransfer").style.display = "flex";
    };

    $("transferClose").onclick = function() { $("modalTransfer").style.display = "none"; };

    $("btnCopyCode").onclick = function() {
      var area = $("transferArea");
      area.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(area.value).catch(function() {});
      }
      showToast("Код базы скопирован", 1800);
    };

    $("btnApplyCode").onclick = function() {
      try {
        var parsed = JSON.parse($("transferArea").value.trim());
        if (!parsed || typeof parsed !== "object") throw new Error("bad");
        applyLoadedState(parsed);
        saveAll();
        renderAll();
        $("modalTransfer").style.display = "none";
        $("modalBackups").style.display = "none";
        showToast("База загружена из кода", 2000);
      } catch (e) {
        showToast("Неверный формат кода базы", 2200);
      }
    };

    $("confirmNo").onclick = function() { $("modalConfirm").style.display = "none"; confirmCallback = null; };
    $("confirmYes").onclick = function() {
      $("modalConfirm").style.display = "none";
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
    };

    $("btnTheme").onclick = function() {
      state.theme = state.theme === "dark" ? "light" : "dark";
      saveAll();
      renderAll();
    };

    $("btnUpdate").onclick = function() {
      if (window.location.protocol === "file:") {
        showToast("Локальный файл: обновление работает на GitHub", 2400);
        return;
      }
      runStepByStepUpdate();
    };
  }

  loadAll(function(wasUpdating) {
    bindEvents();
    renderAll();
    if (wasUpdating) {
      showToast("Обновлено до v " + APP_VERSION + " • База сохранена (" + countItems(getSerializableState()) + " зап.)", 3000);
    }
  });
})();
