(function() {
  var APP_VERSION = "7.7";
  var STORAGE_KEY = "obvalka_pro_db_v1";
  var BACKUPS_KEY = "obvalka_pro_backups_v1";
  var DB_NAME = "ObvalkaProDB";
  var STORE_NAME = "kv";

  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  var state = {
    records: {},
    daysOff: {},
    rate: "",
    worker: "",
    theme: "dark",
    lastAutoBackup: ""
  };

  var backups = [];
  var undoStack = [];
  var confirmCallback = null;

  var now = new Date();
  var viewYear = now.getFullYear();
  var viewMonth = now.getMonth();
  var activeDate = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
  var mode = "day";
  var rangeStart = activeDate;
  var rangeEnd = activeDate;
  var isManualRange = false;
  var isDragging = false;
  var dragAnchor = null;

  function fmtDate(y, m, d) {
    var mm = (m + 1 < 10 ? "0" : "") + (m + 1);
    var dd = (d < 10 ? "0" : "") + d;
    return y + "-" + mm + "-" + dd;
  }

  function parseDate(str) {
    var p = str.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function parseNum(val) {
    if (val === null || val === undefined) return 0;
    var s = String(val).replace(",", ".").replace(/[^0-9.]/g, "");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function showToast(msg, ms) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(function() {
      t.style.display = "none";
    }, ms || 2400);
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

  function countRecords(obj) {
    if (!obj || !obj.records) return 0;
    var c = 0;
    for (var k in obj.records) {
      if (obj.records.hasOwnProperty(k) && Array.isArray(obj.records[k])) {
        c += obj.records[k].length;
      }
    }
    return c;
  }

  function persistAll(done) {
    var payload = JSON.stringify(state);
    var bPayload = JSON.stringify(backups);
    try { localStorage.setItem(STORAGE_KEY, payload); } catch (e) {}
    try { localStorage.setItem(BACKUPS_KEY, bPayload); } catch (e) {}
    try {
      window.name = "OBVALKA_STATE:" + JSON.stringify({ state: state, backups: backups });
    } catch (e) {}
    idbSet(STORAGE_KEY, state, function() {
      idbSet(BACKUPS_KEY, backups, function() {
        if (done) done();
      });
    });
  }

  function applyLoadedData(loadedState, loadedBackups) {
    if (loadedState && typeof loadedState === "object") {
      state.records = loadedState.records || {};
      state.daysOff = loadedState.daysOff || {};
      state.rate = loadedState.rate || "";
      state.worker = loadedState.worker || "";
      state.theme = loadedState.theme || "dark";
      state.lastAutoBackup = loadedState.lastAutoBackup || "";
    }
    if (Array.isArray(loadedBackups) && loadedBackups.length > 0) {
      backups = loadedBackups;
    }
    document.body.classList.toggle("light", state.theme === "light");
    document.getElementById("themeBtn").textContent = state.theme === "light" ? "🌙" : "☀️";
    document.getElementById("workerName").value = state.worker;
    document.getElementById("rateInput").value = state.rate;
  }

  function loadAll(cb) {
    var lsState = null;
    var lsBackups = [];
    var winState = null;
    var winBackups = [];

    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsState = JSON.parse(raw);
      var rawB = localStorage.getItem(BACKUPS_KEY);
      if (rawB) lsBackups = JSON.parse(rawB);
    } catch (e) {}

    try {
      if (window.name && window.name.indexOf("OBVALKA_STATE:") === 0) {
        var parsedWin = JSON.parse(window.name.slice("OBVALKA_STATE:".length));
        if (parsedWin && parsedWin.state) winState = parsedWin.state;
        if (parsedWin && Array.isArray(parsedWin.backups)) winBackups = parsedWin.backups;
      }
    } catch (e) {}

    idbGet(STORAGE_KEY, function(idbState) {
      idbGet(BACKUPS_KEY, function(idbBackups) {
        var candidates = [lsState, idbState, winState];
        var best = null;
        var bestCount = -1;
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i]) {
            var cnt = countRecords(candidates[i]);
            if (cnt > bestCount) {
              bestCount = cnt;
              best = candidates[i];
            }
          }
        }
        var bestBackups = lsBackups;
        if (Array.isArray(idbBackups) && idbBackups.length > bestBackups.length) bestBackups = idbBackups;
        if (winBackups.length > bestBackups.length) bestBackups = winBackups;

        if ((!best || bestCount === 0) && bestBackups.length > 0 && bestBackups[0].data) {
          best = JSON.parse(JSON.stringify(bestBackups[0].data));
        }

        applyLoadedData(best, bestBackups);
        persistAll();
        if (cb) cb();
      });
    });
  }

  function createBackupSnapshot(tag, done) {
    var nowD = new Date();
    var label = (nowD.getDate() < 10 ? "0" : "") + nowD.getDate() + "." +
                (nowD.getMonth() + 1 < 10 ? "0" : "") + (nowD.getMonth() + 1) + "." +
                nowD.getFullYear() + " " +
                (nowD.getHours() < 10 ? "0" : "") + nowD.getHours() + ":" +
                (nowD.getMinutes() < 10 ? "0" : "") + nowD.getMinutes();
    if (tag) label += " (" + tag + ")";
    var snap = {
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      label: label,
      count: countRecords(state),
      data: JSON.parse(JSON.stringify(state))
    };
    backups.unshift(snap);
    if (backups.length > 25) backups = backups.slice(0, 25);
    persistAll(done);
  }

  function checkDailyAutoBackup() {
    var todayKey = fmtDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    if (state.lastAutoBackup !== todayKey && countRecords(state) > 0) {
      state.lastAutoBackup = todayKey;
      createBackupSnapshot("авто");
    }
  }

  function updateRangeFromMode() {
    isManualRange = false;
    var d = parseDate(activeDate);
    var y = d.getFullYear();
    var m = d.getMonth();
    var day = d.getDate();

    if (mode === "day") {
      rangeStart = activeDate;
      rangeEnd = activeDate;
    } else if (mode === "week") {
      var wd = d.getDay();
      var diffToMon = (wd === 0 ? 6 : wd - 1);
      var mon = new Date(y, m, day - diffToMon);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      rangeStart = fmtDate(mon.getFullYear(), mon.getMonth(), mon.getDate());
      rangeEnd = fmtDate(sun.getFullYear(), sun.getMonth(), sun.getDate());
    } else if (mode === "half") {
      var lastDay = new Date(y, m + 1, 0).getDate();
      if (day <= 15) {
        rangeStart = fmtDate(y, m, 1);
        rangeEnd = fmtDate(y, m, 15);
      } else {
        rangeStart = fmtDate(y, m, 16);
        rangeEnd = fmtDate(y, m, lastDay);
      }
    } else if (mode === "month") {
      var lastM = new Date(y, m + 1, 0).getDate();
      rangeStart = fmtDate(y, m, 1);
      rangeEnd = fmtDate(y, m, lastM);
    } else if (mode === "year") {
      rangeStart = fmtDate(y, 0, 1);
      rangeEnd = fmtDate(y, 11, 31);
    }
  }

  function getSortedRange() {
    return rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
  }

  function renderCalendar() {
    document.getElementById("monthTitle").textContent = MONTHS_NOM[viewMonth] + " " + viewYear;
    var grid = document.getElementById("daysGrid");
    grid.innerHTML = "";

    var firstDay = new Date(viewYear, viewMonth, 1).getDay();
    var startOffset = (firstDay === 0 ? 6 : firstDay - 1);
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
    var todayStr = fmtDate(now.getFullYear(), now.getMonth(), now.getDate());
    var r = getSortedRange();

    var totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    for (var i = 0; i < totalCells; i++) {
      var cellDateStr = "";
      var dayNum = 0;
      var isOther = false;

      if (i < startOffset) {
        dayNum = prevMonthDays - startOffset + 1 + i;
        var pm = viewMonth === 0 ? 11 : viewMonth - 1;
        var py = viewMonth === 0 ? viewYear - 1 : viewYear;
        cellDateStr = fmtDate(py, pm, dayNum);
        isOther = true;
      } else if (i >= startOffset + daysInMonth) {
        dayNum = i - (startOffset + daysInMonth) + 1;
        var nm = viewMonth === 11 ? 0 : viewMonth + 1;
        var ny = viewMonth === 11 ? viewYear + 1 : viewYear;
        cellDateStr = fmtDate(ny, nm, dayNum);
        isOther = true;
      } else {
        dayNum = i - startOffset + 1;
        cellDateStr = fmtDate(viewYear, viewMonth, dayNum);
      }

      var cell = document.createElement("div");
      cell.className = "day-cell";
      if (isOther) cell.classList.add("other-month");
      if (cellDateStr === todayStr) cell.classList.add("today");
      if (cellDateStr >= r[0] && cellDateStr <= r[1]) cell.classList.add("in-range");
      if (cellDateStr === activeDate) cell.classList.add("active");
      if (state.records[cellDateStr] && state.records[cellDateStr].length > 0) cell.classList.add("has-data");
      if (state.daysOff[cellDateStr]) cell.classList.add("is-off");

      cell.textContent = dayNum;
      cell.setAttribute("data-date", cellDateStr);
      grid.appendChild(cell);
    }

    var ad = parseDate(activeDate);
    document.getElementById("selectedDateLabel").textContent = ad.getDate() + " " + MONTHS_GEN[ad.getMonth()];
  }

  function formatShortDate(dStr) {
    var d = parseDate(dStr);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function renderRecordsAndSummary() {
    var r = getSortedRange();
    var listEl = document.getElementById("recordsList");
    listEl.innerHTML = "";

    var periodTitle = "";
    if (mode === "day" && !isManualRange) {
      periodTitle = "ДЕНЬ (" + formatShortDate(activeDate) + ")";
    } else if (mode === "week" && !isManualRange) {
      periodTitle = "НЕДЕЛЯ (" + formatShortDate(r[0]) + " – " + formatShortDate(r[1]) + ")";
    } else if (mode === "half" && !isManualRange) {
      periodTitle = "2Х НЕДЕЛИ (" + formatShortDate(r[0]) + " – " + formatShortDate(r[1]) + ")";
    } else if (mode === "month" && !isManualRange) {
      periodTitle = "МЕСЯЦ (" + MONTHS_NOM[viewMonth].toUpperCase() + " " + viewYear + ")";
    } else if (mode === "year" && !isManualRange) {
      periodTitle = "ГОД (" + viewYear + ")";
    } else {
      periodTitle = "ПЕРИОД (" + formatShortDate(r[0]) + " – " + formatShortDate(r[1]) + ")";
    }

    document.getElementById("recordsHeader").textContent = "ЗАПИСИ (" + periodTitle + ")";
    document.getElementById("sumTitle").textContent = "ИТОГ ЗА " + periodTitle;

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalMoney = 0;
    var itemsCount = 0;

    var cur = parseDate(r[0]);
    var endD = parseDate(r[1]);
    while (cur <= endD) {
      var ds = fmtDate(cur.getFullYear(), cur.getMonth(), cur.getDate());
      if (state.daysOff[ds]) {
        var offRow = document.createElement("div");
        offRow.className = "rec-item";
        offRow.innerHTML = '<span style="color:var(--red);font-weight:700;">' + formatShortDate(ds) + ': Выходной</span>' +
                           '<button class="rec-del" data-del-off="' + ds + '">✕</button>';
        listEl.appendChild(offRow);
      }
      var dayRecs = state.records[ds] || [];
      for (var i = 0; i < dayRecs.length; i++) {
        var rec = dayRecs[i];
        var b = Number(rec.boxes) || 0;
        var w = Number(rec.weight) || 0;
        var m = Number(rec.money) || 0;
        totalBoxes += b;
        totalWeight += w;
        totalMoney += m;
        itemsCount++;

        var row = document.createElement("div");
        row.className = "rec-item";
        var boxTxt = b > 0 ? (b + " кор. • ") : "";
        row.innerHTML = '<span><b>' + formatShortDate(ds) + '</b>: ' + boxTxt + (Math.round(w * 10) / 10) + ' кг × ' + rec.rate + ' ₽ = <b style="color:var(--yellow)">' + (Math.round(m * 100) / 100) + ' ₽</b></span>' +
                        '<button class="rec-del" data-del-rec="' + ds + '" data-idx="' + i + '">✕</button>';
        listEl.appendChild(row);
      }
      cur.setDate(cur.getDate() + 1);
    }

    totalWeight = Math.round(totalWeight * 10) / 10;
    totalMoney = Math.round(totalMoney * 100) / 100;

    document.getElementById("recordsCount").textContent = itemsCount > 0 ? (itemsCount + " шт.") : "";
    document.getElementById("sumStats").textContent = totalBoxes + " кор. • " + totalWeight + " кг";
    document.getElementById("sumMoney").textContent = totalMoney + " ₽";
  }

  function updateShiftPreview() {
    var boxes = parseNum(document.getElementById("boxesInput").value);
    var boxWeight = parseNum(document.getElementById("weightInput").value);
    var rate = parseNum(document.getElementById("rateInput").value);

    var totalW = boxes > 0 ? (boxes * boxWeight) : boxWeight;
    totalW = Math.round(totalW * 10) / 10;
    var totalM = Math.round(totalW * rate * 100) / 100;

    document.getElementById("previewWeight").textContent = totalW + " кг";
    document.getElementById("previewMoney").textContent = totalM + " ₽";
  }

  function updateUndoBar() {
    var bar = document.getElementById("undoBar");
    if (undoStack.length > 0) {
      bar.style.display = "flex";
      document.getElementById("undoBtn").textContent = "↩ Отменить удаление (" + undoStack.length + ")";
    } else {
      bar.style.display = "none";
    }
  }

  function buildReportText(type) {
    var r = getSortedRange();
    var wName = (document.getElementById("workerName").value || state.worker || "").trim();
    var lines = [];
    if (wName) lines.push(wName);

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalMoney = 0;

    var cur = parseDate(r[0]);
    var endD = parseDate(r[1]);
    var dayRows = [];

    while (cur <= endD) {
      var ds = fmtDate(cur.getFullYear(), cur.getMonth(), cur.getDate());
      var dayRecs = state.records[ds] || [];
      if (dayRecs.length > 0) {
        var dB = 0, dW = 0, dM = 0;
        for (var i = 0; i < dayRecs.length; i++) {
          dB += Number(dayRecs[i].boxes) || 0;
          dW += Number(dayRecs[i].weight) || 0;
          dM += Number(dayRecs[i].money) || 0;
        }
        dW = Math.round(dW * 10) / 10;
        dM = Math.round(dM * 100) / 100;
        totalBoxes += dB;
        totalWeight += dW;
        totalMoney += dM;
        dayRows.push(formatShortDate(ds) + " | " + dB + "кор | " + dW + "кг | " + dM + "₽");
      }
      cur.setDate(cur.getDate() + 1);
    }

    totalWeight = Math.round(totalWeight * 10) / 10;
    totalMoney = Math.round(totalMoney * 100) / 100;

    if (type === "short") {
      if (isManualRange && r[0] !== r[1]) {
        lines.push(formatShortDate(r[0]) + " – " + formatShortDate(r[1]));
      }
      lines.push("Вес: " + totalWeight + " кг " + totalBoxes + " кор.");
      return lines.join("\n");
    }

    if (r[0] === r[1]) {
      lines.push(formatShortDate(r[0]));
    } else {
      lines.push(formatShortDate(r[0]) + " – " + formatShortDate(r[1]));
    }
    for (var j = 0; j < dayRows.length; j++) {
      lines.push(dayRows[j]);
    }
    lines.push("ИТОГ: " + totalBoxes + "кор | " + totalWeight + "кг | " + totalMoney + "₽");
    return lines.join("\n");
  }

  function openReportPreview(type) {
    var text = buildReportText(type);
    document.getElementById("reportModalTitle").textContent = type === "full" ? "Полный отчёт" : "Краткий отчёт";
    document.getElementById("reportPreviewText").value = text;
    document.getElementById("reportModal").classList.add("open");
  }

  function sendReportSystem() {
    var text = document.getElementById("reportPreviewText").value;
    document.getElementById("reportModal").classList.remove("open");

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
    } catch (e) {}
  }

  function renderBackupsList() {
    var list = document.getElementById("backupList");
    list.innerHTML = "";
    if (!backups || backups.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px;">Сохранённых копий пока нет</div>';
      return;
    }
    for (var i = 0; i < backups.length; i++) {
      var b = backups[i];
      var cnt = typeof b.count === "number" ? b.count : countRecords(b.data);
      var lbl = b.label || "Копия";
      var row = document.createElement("div");
      row.className = "backup-row";
      row.innerHTML = '<div><b>' + lbl + '</b><div style="color:var(--muted);font-size:11px;">Записей: ' + cnt + '</div></div>' +
                      '<div style="display:flex;gap:5px;">' +
                      '<button class="m-btn primary" style="padding:5px 10px;font-size:11px;" data-restore-idx="' + i + '">Восстановить</button>' +
                      '<button class="m-btn danger" style="padding:5px 9px;font-size:11px;" data-del-backup="' + i + '">✕</button>' +
                      '</div>';
      list.appendChild(row);
    }
  }

  function askConfirm(text, onYes) {
    document.getElementById("confirmText").textContent = text;
    confirmCallback = onYes;
    document.getElementById("confirmModal").classList.add("open");
  }

  function runSafeUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: загрузите на GitHub для обновления");
      return;
    }
    showToast("Шаг 1/4: Сохранение базы в память...", 3000);
    createBackupSnapshot("перед обн.", function() {
      setTimeout(function() {
        showToast("Шаг 2/4: Проверка целостности данных...", 3000);
        persistAll(function() {
          setTimeout(function() {
            showToast("Шаг 3/4: Очистка старого кэша...", 3000);
            var cleanCaches = Promise.resolve();
            if ("caches" in window) {
              cleanCaches = caches.keys().then(function(keys) {
                return Promise.all(keys.map(function(k) { return caches.delete(k); }));
              }).catch(function() {});
            }
            var cleanSW = Promise.resolve();
            if ("serviceWorker" in navigator) {
              cleanSW = navigator.serviceWorker.getRegistrations().then(function(regs) {
                return Promise.all(regs.map(function(r) { return r.unregister(); }));
              }).catch(function() {});
            }
            Promise.all([cleanCaches, cleanSW]).then(function() {
              setTimeout(function() {
                showToast("Шаг 4/4: Перезагрузка на новую версию...", 3000);
                setTimeout(function() {
                  window.location.reload(true);
                }, 700);
              }, 700);
            });
          }, 700);
        });
      }, 700);
    });
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").onclick = function() {
      if (viewMonth === 0) { viewMonth = 11; viewYear--; } else { viewMonth--; }
      var maxD = new Date(viewYear, viewMonth + 1, 0).getDate();
      var curD = Math.min(parseDate(activeDate).getDate(), maxD);
      activeDate = fmtDate(viewYear, viewMonth, curD);
      updateRangeFromMode();
      renderCalendar();
      renderRecordsAndSummary();
    };

    document.getElementById("nextMonthBtn").onclick = function() {
      if (viewMonth === 11) { viewMonth = 0; viewYear++; } else { viewMonth++; }
      var maxD = new Date(viewYear, viewMonth + 1, 0).getDate();
      var curD = Math.min(parseDate(activeDate).getDate(), maxD);
      activeDate = fmtDate(viewYear, viewMonth, curD);
      updateRangeFromMode();
      renderCalendar();
      renderRecordsAndSummary();
    };

    document.getElementById("themeBtn").onclick = function() {
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.body.classList.toggle("light", state.theme === "light");
      document.getElementById("themeBtn").textContent = state.theme === "light" ? "🌙" : "☀️";
      persistAll();
    };

    document.getElementById("updateBtn").onclick = runSafeUpdate;

    var tabs = document.querySelectorAll("#modeTabs .tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function() {
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
        this.classList.add("active");
        mode = this.getAttribute("data-mode");
        updateRangeFromMode();
        renderCalendar();
        renderRecordsAndSummary();
      };
    }

    var grid = document.getElementById("daysGrid");
    grid.addEventListener("pointerdown", function(e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      var ds = cell.getAttribute("data-date");
      if (!ds) return;
      isDragging = true;
      dragAnchor = ds;
      activeDate = ds;
      var pd = parseDate(ds);
      viewYear = pd.getFullYear();
      viewMonth = pd.getMonth();
      if (mode === "day") {
        rangeStart = ds;
        rangeEnd = ds;
        isManualRange = false;
      } else {
        updateRangeFromMode();
      }
      renderCalendar();
      renderRecordsAndSummary();
    });

    grid.addEventListener("pointermove", function(e) {
      if (!isDragging || !dragAnchor) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      var cell = el.closest(".day-cell");
      if (!cell) return;
      var ds = cell.getAttribute("data-date");
      if (ds && ds !== rangeEnd) {
        rangeStart = dragAnchor;
        rangeEnd = ds;
        isManualRange = (rangeStart !== rangeEnd);
        renderCalendar();
        renderRecordsAndSummary();
      }
    });

    window.addEventListener("pointerup", function() {
      isDragging = false;
    });

    document.getElementById("toggleOffBtn").onclick = function() {
      if (state.daysOff[activeDate]) {
        delete state.daysOff[activeDate];
      } else {
        state.daysOff[activeDate] = true;
      }
      checkDailyAutoBackup();
      persistAll();
      renderCalendar();
      renderRecordsAndSummary();
    };

    document.getElementById("workerName").oninput = function() {
      state.worker = this.value;
      persistAll();
    };

    document.getElementById("boxesInput").oninput = function() {
      this.value = this.value.replace(/[^0-9]/g, "");
      updateShiftPreview();
    };

    document.getElementById("weightInput").oninput = function() {
      this.value = this.value.replace(",", ".").replace(/[^0-9.]/g, "");
      updateShiftPreview();
    };

    document.getElementById("rateInput").oninput = function() {
      this.value = this.value.replace(",", ".").replace(/[^0-9.]/g, "");
      state.rate = this.value;
      persistAll();
      updateShiftPreview();
    };

    document.getElementById("addRecordBtn").onclick = function() {
      var boxes = parseNum(document.getElementById("boxesInput").value);
      var boxWeight = parseNum(document.getElementById("weightInput").value);
      var rate = parseNum(document.getElementById("rateInput").value);

      var totalW = boxes > 0 ? (boxes * boxWeight) : boxWeight;
      totalW = Math.round(totalW * 10) / 10;
      if (totalW <= 0) {
        showToast("Введите вес коробки");
        return;
      }
      var totalM = Math.round(totalW * rate * 100) / 100;

      if (!state.records[activeDate]) state.records[activeDate] = [];
      state.records[activeDate].push({
        boxes: boxes,
        boxWeight: boxWeight,
        weight: totalW,
        rate: rate,
        money: totalM
      });
      if (state.daysOff[activeDate]) delete state.daysOff[activeDate];

      document.getElementById("boxesInput").value = "";
      document.getElementById("weightInput").value = "";
      updateShiftPreview();
      checkDailyAutoBackup();
      persistAll();
      renderCalendar();
      renderRecordsAndSummary();
      showToast("Запись добавлена");
    };

    document.getElementById("recordsList").onclick = function(e) {
      var delRec = e.target.closest("[data-del-rec]");
      if (delRec) {
        var ds = delRec.getAttribute("data-del-rec");
        var idx = parseInt(delRec.getAttribute("data-idx"), 10);
        if (state.records[ds] && state.records[ds][idx]) {
          var removed = state.records[ds].splice(idx, 1)[0];
          if (state.records[ds].length === 0) delete state.records[ds];
          undoStack.push({ type: "rec", date: ds, item: removed });
          updateUndoBar();
          persistAll();
          renderCalendar();
          renderRecordsAndSummary();
        }
        return;
      }
      var delOff = e.target.closest("[data-del-off]");
      if (delOff) {
        var ods = delOff.getAttribute("data-del-off");
        delete state.daysOff[ods];
        undoStack.push({ type: "off", date: ods });
        updateUndoBar();
        persistAll();
        renderCalendar();
        renderRecordsAndSummary();
      }
    };

    document.getElementById("undoBtn").onclick = function() {
      if (undoStack.length === 0) return;
      var last = undoStack.pop();
      if (last.type === "rec") {
        if (!state.records[last.date]) state.records[last.date] = [];
        state.records[last.date].push(last.item);
      } else if (last.type === "off") {
        state.daysOff[last.date] = true;
      }
      updateUndoBar();
      persistAll();
      renderCalendar();
      renderRecordsAndSummary();
    };

    document.getElementById("clearUndoBtn").onclick = function() {
      askConfirm("Очистить историю удалений? Вы уверены?", function() {
        undoStack = [];
        updateUndoBar();
      });
    };

    document.getElementById("fullReportBtn").onclick = function() { openReportPreview("full"); };
    document.getElementById("shortReportBtn").onclick = function() { openReportPreview("short"); };
    document.getElementById("cancelReportBtn").onclick = function() {
      document.getElementById("reportModal").classList.remove("open");
    };
    document.getElementById("sendReportBtn").onclick = sendReportSystem;

    document.getElementById("saveBaseBtn").onclick = function() {
      createBackupSnapshot("", function() {
        showToast("База сохранена (" + countRecords(state) + " зап.)");
      });
    };

    document.getElementById("openRestoreBtn").onclick = function() {
      renderBackupsList();
      document.getElementById("restoreModal").classList.add("open");
    };
    document.getElementById("closeRestoreBtn").onclick = function() {
      document.getElementById("restoreModal").classList.remove("open");
    };

    document.getElementById("backupList").onclick = function(e) {
      var rBtn = e.target.closest("[data-restore-idx]");
      if (rBtn) {
        var idx = parseInt(rBtn.getAttribute("data-restore-idx"), 10);
        if (backups[idx] && backups[idx].data) {
          applyLoadedData(JSON.parse(JSON.stringify(backups[idx].data)), backups);
          persistAll();
          renderCalendar();
          renderRecordsAndSummary();
          document.getElementById("restoreModal").classList.remove("open");
          showToast("База восстановлена");
        }
        return;
      }
      var dBtn = e.target.closest("[data-del-backup]");
      if (dBtn) {
        var didx = parseInt(dBtn.getAttribute("data-del-backup"), 10);
        askConfirm("Удалить эту сохранённую базу? Вы уверены?", function() {
          backups.splice(didx, 1);
          persistAll();
          renderBackupsList();
        });
      }
    };

    document.getElementById("transferCodeBtn").onclick = function() {
      document.getElementById("transferTextarea").value = JSON.stringify(state);
      document.getElementById("transferModal").classList.add("open");
    };
    document.getElementById("closeTransferBtn").onclick = function() {
      document.getElementById("transferModal").classList.remove("open");
    };
    document.getElementById("copyCodeBtn").onclick = function() {
      var ta = document.getElementById("transferTextarea");
      ta.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).catch(function() {});
      }
      showToast("Код базы скопирован");
    };
    document.getElementById("applyCodeBtn").onclick = function() {
      try {
        var parsed = JSON.parse(document.getElementById("transferTextarea").value.trim());
        if (!parsed || typeof parsed !== "object" || !parsed.records) {
          showToast("Неверный формат кода");
          return;
        }
        applyLoadedData(parsed, backups);
        persistAll();
        renderCalendar();
        renderRecordsAndSummary();
        document.getElementById("transferModal").classList.remove("open");
        document.getElementById("restoreModal").classList.remove("open");
        showToast("База загружена из кода");
      } catch (e) {
        showToast("Ошибка чтения кода");
      }
    };

    document.getElementById("confirmNoBtn").onclick = function() {
      confirmCallback = null;
      document.getElementById("confirmModal").classList.remove("open");
    };
    document.getElementById("confirmYesBtn").onclick = function() {
      document.getElementById("confirmModal").classList.remove("open");
      if (confirmCallback) {
        var fn = confirmCallback;
        confirmCallback = null;
        fn();
      }
    };
  }

  function init() {
    document.getElementById("verBadge").textContent = "v " + APP_VERSION;
    loadAll(function() {
      updateRangeFromMode();
      renderCalendar();
      renderRecordsAndSummary();
      updateShiftPreview();
      bindEvents();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
