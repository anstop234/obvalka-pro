(function() {
  var APP_VER = "7.5";
  var LS_KEY = "obvalka_pro_db_v1";
  var IDB_NAME = "ObvalkaProStorage";
  var IDB_STORE = "kv";

  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  var state = {
    records: {},
    dayOffs: {},
    worker: "",
    rate: "",
    theme: "dark",
    undoStack: [],
    backups: []
  };

  var now = new Date();
  var viewYear = now.getFullYear();
  var viewMonth = now.getMonth();
  var selectedKey = fmtKey(now);
  var rangeStart = selectedKey;
  var rangeEnd = selectedKey;
  var periodMode = "day";
  var isDragging = false;
  var dragAnchor = null;
  var confirmCallback = null;

  function $(id) { return document.getElementById(id); }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseKey(k) {
    var p = k.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function fmtHumanDate(k) {
    var d = parseKey(k);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }

  function fmtShortDate(k) {
    var d = parseKey(k);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function parseNum(v) {
    if (v === null || v === undefined) return 0;
    var s = String(v).replace(",", ".").replace(/[^0-9.]/g, "");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function round2(n) {
    return Math.round((n + 1e-9) * 100) / 100;
  }

  function fmtNum(n) {
    return String(round2(n));
  }

  function showToast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._tm);
    t._tm = setTimeout(function() { t.style.display = "none"; }, 2400);
  }

  function idbOpen(cb) {
    try {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function(e) { cb(null, e.target.result); };
      req.onerror = function() { cb(new Error("idb")); };
    } catch (e) { cb(e); }
  }

  function idbSet(key, val, done) {
    idbOpen(function(err, db) {
      if (err) { if (done) done(false); return; }
      try {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function() { if (done) done(true); };
        tx.onerror = function() { if (done) done(false); };
      } catch (e) { if (done) done(false); }
    });
  }

  function idbGet(key, done) {
    idbOpen(function(err, db) {
      if (err) { done(null); return; }
      try {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function() { done(req.result || null); };
        req.onerror = function() { done(null); };
      } catch (e) { done(null); }
    });
  }

  function countRecords(obj) {
    if (!obj || !obj.records) return 0;
    var c = 0;
    for (var k in obj.records) {
      if (obj.records.hasOwnProperty(k) && Array.isArray(obj.records[k])) c += obj.records[k].length;
    }
    return c;
  }

  function saveAll(done) {
    var payload = JSON.stringify(state);
    try { localStorage.setItem(LS_KEY, payload); } catch (e) {}
    try { window.name = "OBVALKA_DB:" + payload; } catch (e) {}
    idbSet(LS_KEY, payload, function(ok) {
      if (done) done(ok);
    });
  }

  function applyLoadedData(raw) {
    if (!raw) return false;
    try {
      var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== "object") return false;
      state.records = parsed.records || {};
      state.dayOffs = parsed.dayOffs || {};
      state.worker = parsed.worker || "";
      state.rate = parsed.rate || "";
      state.theme = parsed.theme || "dark";
      state.undoStack = Array.isArray(parsed.undoStack) ? parsed.undoStack : [];
      state.backups = Array.isArray(parsed.backups) ? parsed.backups : [];
      return true;
    } catch (e) { return false; }
  }

  function loadAll(cb) {
    var candidates = [];
    try {
      var lsRaw = localStorage.getItem(LS_KEY);
      if (lsRaw) candidates.push(JSON.parse(lsRaw));
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBVALKA_DB:") === 0) {
        candidates.push(JSON.parse(window.name.slice(11)));
      }
    } catch (e) {}

    idbGet(LS_KEY, function(idbRaw) {
      if (idbRaw) {
        try { candidates.push(typeof idbRaw === "string" ? JSON.parse(idbRaw) : idbRaw); } catch (e) {}
      }
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!c || typeof c !== "object") continue;
        var score = countRecords(c) * 10 + (Array.isArray(c.backups) ? c.backups.length : 0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best) applyLoadedData(best);
      cb();
    });
  }

  function createBackup(tag, done) {
    var d = new Date();
    var stamp = pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    var cnt = countRecords(state);
    var snap = {
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      date: stamp + (tag ? " " + tag : ""),
      count: cnt,
      data: JSON.stringify({
        records: state.records,
        dayOffs: state.dayOffs,
        worker: state.worker,
        rate: state.rate
      })
    };
    state.backups.unshift(snap);
    if (state.backups.length > 8) state.backups = state.backups.slice(0, 8);
    saveAll(done);
  }

  function ensureDailyAutoBackup() {
    var d = new Date();
    var todayTag = pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
    for (var i = 0; i < state.backups.length; i++) {
      if (state.backups[i].date && state.backups[i].date.indexOf(todayTag) === 0 && state.backups[i].date.indexOf("(авто)") !== -1) {
        return;
      }
    }
    createBackup("(авто)");
  }

  function updatePeriodRange() {
    var d = parseKey(selectedKey);
    if (periodMode === "day") {
      rangeStart = selectedKey;
      rangeEnd = selectedKey;
    } else if (periodMode === "week") {
      var day = d.getDay();
      var diff = day === 0 ? -6 : 1 - day;
      var mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      rangeStart = fmtKey(mon);
      rangeEnd = fmtKey(sun);
    } else if (periodMode === "2weeks") {
      var y = d.getFullYear(), m = d.getMonth();
      if (d.getDate() <= 15) {
        rangeStart = fmtKey(new Date(y, m, 1));
        rangeEnd = fmtKey(new Date(y, m, 15));
      } else {
        var last = new Date(y, m + 1, 0).getDate();
        rangeStart = fmtKey(new Date(y, m, 16));
        rangeEnd = fmtKey(new Date(y, m, last));
      }
    } else if (periodMode === "month") {
      var ym = d.getFullYear(), mm = d.getMonth();
      rangeStart = fmtKey(new Date(ym, mm, 1));
      rangeEnd = fmtKey(new Date(ym, mm + 1, 0));
    } else if (periodMode === "year") {
      var yy = d.getFullYear();
      rangeStart = fmtKey(new Date(yy, 0, 1));
      rangeEnd = fmtKey(new Date(yy, 11, 31));
    }
  }

  function getOrderedRange() {
    return rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
  }

  function renderCalendar() {
    $("monthLabel").textContent = MONTHS_NOM[viewMonth] + " " + viewYear;
    var grid = $("daysGrid");
    grid.innerHTML = "";

    var firstDay = new Date(viewYear, viewMonth, 1);
    var startDow = firstDay.getDay();
    var offset = startDow === 0 ? 6 : startDow - 1;
    var startDate = new Date(viewYear, viewMonth, 1 - offset);
    var todayKey = fmtKey(new Date());
    var rng = getOrderedRange();

    for (var i = 0; i < 42; i++) {
      var cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      var k = fmtKey(cur);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.setAttribute("data-key", k);
      if (cur.getMonth() !== viewMonth) cell.className += " other";
      if (k === todayKey) cell.className += " today";
      if (k >= rng[0] && k <= rng[1]) cell.className += " in-range";
      if (k === selectedKey && periodMode !== "custom") cell.className += " selected";
      if (periodMode === "custom" && (k === rng[0] || k === rng[1])) cell.className += " selected";

      var num = document.createElement("span");
      num.textContent = cur.getDate();
      cell.appendChild(num);

      if (state.dayOffs[k]) {
        var off = document.createElement("span");
        off.className = "day-off-mark";
        off.innerHTML = "&#10005;";
        cell.appendChild(off);
      }

      if (state.records[k] && state.records[k].length > 0) {
        var bar = document.createElement("span");
        bar.className = "day-bar";
        cell.appendChild(bar);
      }

      grid.appendChild(cell);
    }
  }

  function getKeysInRange() {
    var rng = getOrderedRange();
    var start = parseKey(rng[0]);
    var end = parseKey(rng[1]);
    var keys = [];
    var cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cur <= end) {
      keys.push(fmtKey(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  function renderSummaryAndRecords() {
    var rng = getOrderedRange();
    var keys = getKeysInRange();
    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;

    var list = $("recordsList");
    list.innerHTML = "";

    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var arr = state.records[k] || [];
      for (var j = 0; j < arr.length; j++) {
        var r = arr[j];
        var b = parseInt(r.boxes, 10) || 0;
        var w = parseNum(r.weight);
        var rub = round2(w * parseNum(r.rate));
        totalBoxes += b;
        totalKg = round2(totalKg + w);
        totalRub = round2(totalRub + rub);

        var row = document.createElement("div");
        row.className = "rec-item";
        var info = document.createElement("span");
        info.textContent = fmtShortDate(k) + ": " + b + " кор. | " + fmtNum(w) + " кг | " + fmtNum(rub) + " ₽";
        var del = document.createElement("button");
        del.className = "rec-del";
        del.textContent = "Удалить";
        del.setAttribute("data-key", k);
        del.setAttribute("data-idx", j);
        row.appendChild(info);
        row.appendChild(del);
        list.appendChild(row);
      }
    }

    var titleMap = {
      day: "ДЕНЬ",
      week: "НЕДЕЛЯ",
      "2weeks": "2Х НЕДЕЛИ",
      month: "МЕСЯЦ",
      year: "ГОД",
      custom: "ПЕРИОД"
    };
    var pName = titleMap[periodMode] || "ДЕНЬ";
    var rangeText = rng[0] === rng[1] ? fmtHumanDate(rng[0]) : (fmtHumanDate(rng[0]) + " – " + fmtHumanDate(rng[1]));

    $("recordsHeader").textContent = "ЗАПИСИ (" + pName + (rng[0] !== rng[1] ? " (" + rangeText + ")" : "") + ")";
    $("sumPeriodLabel").textContent = "ИТОГ ЗА " + pName + (rng[0] !== rng[1] ? " (" + rangeText.toUpperCase() + ")" : "");
    $("sumBoxesKg").textContent = totalBoxes + " кор. | " + fmtNum(totalKg) + " кг";
    $("sumMoney").textContent = fmtNum(totalRub) + " ₽";
    $("selectedDateLabel").textContent = fmtHumanDate(selectedKey);

    if (state.undoStack.length > 0) {
      $("undoRow").style.display = "flex";
      $("undoBtn").textContent = "↩ Отменить удаление (" + state.undoStack.length + ")";
    } else {
      $("undoRow").style.display = "none";
    }
  }

  function updateShiftPreview() {
    var w = parseNum($("weightInput").value);
    var r = parseNum($("rateInput").value);
    var rub = round2(w * r);
    $("shiftKg").textContent = fmtNum(w) + " кг";
    $("shiftRub").textContent = fmtNum(rub) + " ₽";
  }

  function renderAll() {
    document.documentElement.setAttribute("data-theme", state.theme);
    $("themeBtn").innerHTML = state.theme === "dark" ? "&#9728;" : "&#9790;";
    $("verTag").textContent = "v " + APP_VER;
    renderCalendar();
    renderSummaryAndRecords();
    updateShiftPreview();
  }

  function buildFullReport() {
    var rng = getOrderedRange();
    var keys = getKeysInRange();
    var lines = [];
    if (state.worker && state.worker.trim()) lines.push(state.worker.trim());

    if (rng[0] === rng[1] && periodMode === "day") {
      var arrDay = state.records[rng[0]] || [];
      var bDay = 0, wDay = 0;
      for (var d = 0; d < arrDay.length; d++) {
        bDay += parseInt(arrDay[d].boxes, 10) || 0;
        wDay = round2(wDay + parseNum(arrDay[d].weight));
      }
      lines.push("Вес: " + fmtNum(wDay) + " кг " + bDay + " кор.");
      return lines.join("\n");
    }

    lines.push(fmtShortDate(rng[0]) + " – " + fmtShortDate(rng[1]));
    var tBoxes = 0, tKg = 0, tRub = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var arr = state.records[k] || [];
      if (arr.length === 0) continue;
      var db = 0, dw = 0, dr = 0;
      for (var j = 0; j < arr.length; j++) {
        db += parseInt(arr[j].boxes, 10) || 0;
        var w = parseNum(arr[j].weight);
        dw = round2(dw + w);
        dr = round2(dr + w * parseNum(arr[j].rate));
      }
      tBoxes += db;
      tKg = round2(tKg + dw);
      tRub = round2(tRub + dr);
      lines.push(fmtShortDate(k) + " | " + db + "кор | " + fmtNum(dw) + "кг | " + fmtNum(dr) + "₽");
    }
    lines.push("ИТОГ: " + tBoxes + "кор | " + fmtNum(tKg) + "кг | " + fmtNum(tRub) + "₽");
    return lines.join("\n");
  }

  function buildShortReport() {
    var rng = getOrderedRange();
    var keys = getKeysInRange();
    var lines = [];
    if (state.worker && state.worker.trim()) lines.push(state.worker.trim());
    if (periodMode === "custom" && rng[0] !== rng[1]) {
      lines.push(fmtShortDate(rng[0]) + " – " + fmtShortDate(rng[1]));
    }
    var tBoxes = 0, tKg = 0;
    for (var i = 0; i < keys.length; i++) {
      var arr = state.records[keys[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        tBoxes += parseInt(arr[j].boxes, 10) || 0;
        tKg = round2(tKg + parseNum(arr[j].weight));
      }
    }
    lines.push("Вес: " + fmtNum(tKg) + " кг " + tBoxes + " кор.");
    return lines.join("\n");
  }

  function openConfirm(title, msg, cb) {
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = msg;
    confirmCallback = cb;
    $("confirmModal").style.display = "flex";
  }

  function renderBackupsModal() {
    var box = $("backupList");
    box.innerHTML = "";
    if (!state.backups || state.backups.length === 0) {
      box.innerHTML = "<div style='font-size:12px; color:var(--muted);'>Сохранённых копий пока нет</div>";
      return;
    }
    for (var i = 0; i < state.backups.length; i++) {
      (function(idx) {
        var b = state.backups[idx];
        var item = document.createElement("div");
        item.className = "backup-item";
        var left = document.createElement("div");
        var cnt = typeof b.count === "number" ? b.count : 0;
        left.innerHTML = "<b>" + (b.date || "Копия") + "</b><br><span style='color:var(--muted)'>Записей: " + cnt + "</span>";
        var right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "5px";
        var restBtn = document.createElement("button");
        restBtn.className = "m-btn green";
        restBtn.textContent = "Восстановить";
        restBtn.onclick = function() {
          try {
            var d = JSON.parse(b.data);
            state.records = d.records || {};
            state.dayOffs = d.dayOffs || {};
            if (d.worker) { state.worker = d.worker; $("workerInput").value = state.worker; }
            if (d.rate) { state.rate = d.rate; $("rateInput").value = state.rate; }
            saveAll();
            renderAll();
            $("restoreModal").style.display = "none";
            showToast("База восстановлена");
          } catch (e) { showToast("Ошибка чтения копии"); }
        };
        var delBtn = document.createElement("button");
        delBtn.className = "m-btn red";
        delBtn.innerHTML = "&#10005;";
        delBtn.onclick = function() {
          openConfirm("Удаление копии", "Удалить эту сохранённую базу? Вы уверены?", function() {
            state.backups.splice(idx, 1);
            saveAll();
            renderBackupsModal();
            showToast("Копия удалена");
          });
        };
        right.appendChild(restBtn);
        right.appendChild(delBtn);
        item.appendChild(left);
        item.appendChild(right);
        box.appendChild(item);
      })(i);
    }
  }

  function runStepByStepUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: обновите через GitHub");
      return;
    }
    showToast("Шаг 1/4: Сохранение базы...");
    createBackup("(перед обн.)", function() {
      setTimeout(function() {
        showToast("Шаг 2/4: Проверка целостности...");
        saveAll(function() {
          setTimeout(function() {
            showToast("Шаг 3/4: Очистка старого кэша...");
            var cleanCaches = Promise.resolve();
            if ("caches" in window) {
              cleanCaches = caches.keys().then(function(names) {
                return Promise.all(names.map(function(n) { return caches.delete(n); }));
              });
            }
            cleanCaches.then(function() {
              if ("serviceWorker" in navigator) {
                navigator.serviceWorker.getRegistrations().then(function(regs) {
                  for (var i = 0; i < regs.length; i++) regs[i].unregister();
                });
              }
              setTimeout(function() {
                showToast("Шаг 4/4: Загрузка новой версии...");
                var baseUrl = window.location.href.split("?")[0];
                window.location.replace(baseUrl + "?v=" + Date.now());
              }, 800);
            });
          }, 800);
        });
      }, 800);
    });
  }

  function selectDayCell(key, isStart) {
    if (!key) return;
    if (isStart) {
      isDragging = true;
      dragAnchor = key;
      selectedKey = key;
      if (periodMode === "custom") {
        periodMode = "day";
        var tabs = document.querySelectorAll(".tab");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].classList.toggle("active", tabs[i].getAttribute("data-mode") === "day");
        }
      }
      updatePeriodRange();
      renderAll();
    } else if (isDragging && dragAnchor && key !== dragAnchor) {
      periodMode = "custom";
      rangeStart = dragAnchor;
      rangeEnd = key;
      selectedKey = key;
      var tabs2 = document.querySelectorAll(".tab");
      for (var j = 0; j < tabs2.length; j++) tabs2[j].classList.remove("active");
      renderAll();
    }
  }

  function bindEvents() {
    var grid = $("daysGrid");
    grid.addEventListener("pointerdown", function(e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      selectDayCell(cell.getAttribute("data-key"), true);
    });
    grid.addEventListener("pointermove", function(e) {
      if (!isDragging) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el ? el.closest(".day-cell") : null;
      if (cell) selectDayCell(cell.getAttribute("data-key"), false);
    });
    window.addEventListener("pointerup", function() {
      isDragging = false;
      dragAnchor = null;
    });

    $("prevMonthBtn").onclick = function() {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (periodMode === "month" || periodMode === "year") {
        selectedKey = fmtKey(new Date(viewYear, viewMonth, 1));
        updatePeriodRange();
      }
      renderAll();
    };

    $("nextMonthBtn").onclick = function() {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      if (periodMode === "month" || periodMode === "year") {
        selectedKey = fmtKey(new Date(viewYear, viewMonth, 1));
        updatePeriodRange();
      }
      renderAll();
    };

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function() {
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
        this.classList.add("active");
        periodMode = this.getAttribute("data-mode");
        updatePeriodRange();
        renderAll();
      };
    }

    $("themeBtn").onclick = function() {
      state.theme = state.theme === "dark" ? "light" : "dark";
      saveAll();
      renderAll();
    };

    $("updBtn").onclick = runStepByStepUpdate;

    $("dayOffBtn").onclick = function() {
      if (state.dayOffs[selectedKey]) {
        delete state.dayOffs[selectedKey];
        showToast("Выходной снят");
      } else {
        state.dayOffs[selectedKey] = true;
        showToast("Отмечен выходной");
      }
      ensureDailyAutoBackup();
      saveAll();
      renderAll();
    };

    $("workerInput").oninput = function() {
      state.worker = this.value;
      saveAll();
    };

    $("boxesInput").oninput = function() {
      this.value = this.value.replace(/[^0-9]/g, "");
    };

    $("weightInput").oninput = function() {
      this.value = this.value.replace(",", ".").replace(/[^0-9.]/g, "");
      updateShiftPreview();
    };

    $("rateInput").oninput = function() {
      this.value = this.value.replace(",", ".").replace(/[^0-9.]/g, "");
      state.rate = this.value;
      saveAll();
      updateShiftPreview();
    };

    $("addRecordBtn").onclick = function() {
      var boxes = parseInt($("boxesInput").value, 10) || 0;
      var weight = parseNum($("weightInput").value);
      var rate = parseNum($("rateInput").value);
      if (weight <= 0 && boxes <= 0) {
        showToast("Введите коробки или вес");
        return;
      }
      if (!state.records[selectedKey]) state.records[selectedKey] = [];
      state.records[selectedKey].push({
        boxes: boxes,
        weight: weight,
        rate: rate
      });
      delete state.dayOffs[selectedKey];
      $("boxesInput").value = "";
      $("weightInput").value = "";
      ensureDailyAutoBackup();
      saveAll();
      renderAll();
      showToast("Запись добавлена");
    };

    $("recordsList").onclick = function(e) {
      var btn = e.target.closest(".rec-del");
      if (!btn) return;
      var k = btn.getAttribute("data-key");
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      if (state.records[k] && state.records[k][idx]) {
        var removed = state.records[k].splice(idx, 1)[0];
        if (state.records[k].length === 0) delete state.records[k];
        state.undoStack.push({ key: k, item: removed });
        saveAll();
        renderAll();
      }
    };

    $("undoBtn").onclick = function() {
      if (state.undoStack.length === 0) return;
      var last = state.undoStack.pop();
      if (!state.records[last.key]) state.records[last.key] = [];
      state.records[last.key].push(last.item);
      saveAll();
      renderAll();
    };

    $("clearUndoBtn").onclick = function() {
      openConfirm("Очистка истории", "Очистить все отменённые записи? Вы уверены?", function() {
        state.undoStack = [];
        saveAll();
        renderAll();
      });
    };

    $("fullRepBtn").onclick = function() {
      $("reportModalTitle").textContent = "Полный отчёт";
      $("reportPreviewText").value = buildFullReport();
      $("reportModal").style.display = "flex";
    };

    $("shortRepBtn").onclick = function() {
      $("reportModalTitle").textContent = "Краткий отчёт";
      $("reportPreviewText").value = buildShortReport();
      $("reportModal").style.display = "flex";
    };

    $("closeReportBtn").onclick = function() {
      $("reportModal").style.display = "none";
    };

    $("sendReportBtn").onclick = function() {
      var txt = $("reportPreviewText").value;
      $("reportModal").style.display = "none";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function() {});
      }
      if (navigator.share) {
        navigator.share({ text: txt }).catch(function() {});
      } else {
        showToast("Отчёт скопирован в буфер");
      }
    };

    $("saveDbBtn").onclick = function() {
      createBackup("(вручную)", function() {
        showToast("База сохранена (" + countRecords(state) + " зап.)");
      });
    };

    $("restoreDbBtn").onclick = function() {
      $("codeTransferBox").style.display = "none";
      renderBackupsModal();
      $("restoreModal").style.display = "flex";
    };

    $("closeRestoreBtn").onclick = function() {
      $("restoreModal").style.display = "none";
    };

    $("toggleCodeBtn").onclick = function() {
      var box = $("codeTransferBox");
      if (box.style.display === "none") {
        box.style.display = "flex";
        $("transferCodeArea").value = JSON.stringify({
          records: state.records,
          dayOffs: state.dayOffs,
          worker: state.worker,
          rate: state.rate
        });
      } else {
        box.style.display = "none";
      }
    };

    $("copyCodeBtn").onclick = function() {
      var area = $("transferCodeArea");
      area.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(area.value);
      } else {
        document.execCommand("copy");
      }
      showToast("Код базы скопирован");
    };

    $("importCodeBtn").onclick = function() {
      try {
        var d = JSON.parse($("transferCodeArea").value.trim());
        if (!d || typeof d !== "object" || !d.records) throw new Error("bad");
        state.records = d.records || {};
        state.dayOffs = d.dayOffs || {};
        if (d.worker) { state.worker = d.worker; $("workerInput").value = state.worker; }
        if (d.rate) { state.rate = d.rate; $("rateInput").value = state.rate; }
        saveAll();
        renderAll();
        $("restoreModal").style.display = "none";
        showToast("Данные загружены из кода");
      } catch (e) { showToast("Неверный формат кода"); }
    };

    $("confirmNoBtn").onclick = function() {
      $("confirmModal").style.display = "none";
      confirmCallback = null;
    };

    $("confirmYesBtn").onclick = function() {
      $("confirmModal").style.display = "none";
      if (confirmCallback) {
        var fn = confirmCallback;
        confirmCallback = null;
        fn();
      }
    };
  }

  loadAll(function() {
    $("workerInput").value = state.worker || "";
    $("rateInput").value = state.rate || "";
    updatePeriodRange();
    bindEvents();
    renderAll();
  });
})();
