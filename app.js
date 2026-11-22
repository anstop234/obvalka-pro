(function() {
  var APP_VERSION = "7.3";
  var DB_NAME = "ObvalkaProDB";
  var DB_STORE = "kv";
  var KEY_MAIN = "obvalka_main_data_v1";
  var KEY_BACKUPS = "obvalka_backups_v1";
  var KEY_PENDING_RESTORE = "obvalka_pending_update_backup";

  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  var state = {
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(),
    selectedDate: formatDateKey(new Date()),
    rangeStart: formatDateKey(new Date()),
    rangeEnd: formatDateKey(new Date()),
    mode: "day",
    isManualRange: false,
    records: {},
    dayOffs: {},
    workerName: "",
    lastRate: "",
    theme: "dark",
    undoStack: [],
    lastAutoBackupDate: ""
  };

  var isDragging = false;
  var dragStartKey = null;
  var confirmCallback = null;

  function formatDateKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseDateKey(key) {
    var p = key.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function formatHumanDate(key, withYear) {
    var d = parseDateKey(key);
    var res = d.getDate() + " " + MONTHS_GEN[d.getMonth()];
    if (withYear) res += " " + d.getFullYear();
    return res;
  }

  function formatShortDate(key) {
    var d = parseDateKey(key);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function showToast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.display = "none"; }, 2600);
  }

  /* IndexedDB обёртка с Promise для гарантированной записи перед обновлением */
  function openIDB() {
    return new Promise(function(resolve, reject) {
      if (!window.indexedDB) return reject("no_idb");
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function(e) { reject(e); };
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function() { resolve(true); };
        tx.onerror = function(e) { reject(e); };
      });
    }).catch(function() { return false; });
  }

  function idbGet(key) {
    return openIDB().then(function(db) {
      return new Promise(function(resolve) {
        var tx = db.transaction(DB_STORE, "readonly");
        var req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { resolve(null); };
      });
    }).catch(function() { return null; });
  }

  function countItems(dataObj) {
    if (!dataObj) return 0;
    var rCount = 0;
    if (dataObj.records) {
      Object.keys(dataObj.records).forEach(function(k) {
        if (Array.isArray(dataObj.records[k])) rCount += dataObj.records[k].length;
      });
    }
    var dCount = dataObj.dayOffs ? Object.keys(dataObj.dayOffs).length : 0;
    return rCount + dCount;
  }

  function buildPayload() {
    return {
      records: state.records || {},
      dayOffs: state.dayOffs || {},
      workerName: state.workerName || "",
      lastRate: state.lastRate || "",
      theme: state.theme || "dark",
      lastAutoBackupDate: state.lastAutoBackupDate || "",
      savedAt: Date.now()
    };
  }

  function saveState() {
    var payload = buildPayload();
    try {
      localStorage.setItem(KEY_MAIN, JSON.stringify(payload));
    } catch (e) {}
    return idbSet(KEY_MAIN, payload);
  }

  function applyPayload(data) {
    if (!data) return;
    state.records = data.records || {};
    state.dayOffs = data.dayOffs || {};
    state.workerName = data.workerName || "";
    state.lastRate = data.lastRate || "";
    state.theme = data.theme || "dark";
    state.lastAutoBackupDate = data.lastAutoBackupDate || "";
  }

  function loadBackupsList() {
    var lsList = [];
    try {
      var raw = localStorage.getItem(KEY_BACKUPS);
      if (raw) lsList = JSON.parse(raw) || [];
    } catch (e) {}
    return idbGet(KEY_BACKUPS).then(function(idbList) {
      if (Array.isArray(idbList) && idbList.length >= lsList.length) {
        return idbList;
      }
      return lsList;
    });
  }

  function saveBackupsList(list) {
    try {
      localStorage.setItem(KEY_BACKUPS, JSON.stringify(list));
    } catch (e) {}
    return idbSet(KEY_BACKUPS, list);
  }

  function createBackupSnapshot(labelTag) {
    var payload = buildPayload();
    var total = countItems(payload);
    var now = new Date();
    var pad = function(n) { return String(n).padStart(2, "0"); };
    var dateStr = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    var entry = {
      id: "bk_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      date: dateStr + (labelTag ? " " + labelTag : ""),
      count: total,
      data: payload
    };
    return loadBackupsList().then(function(list) {
      list.unshift(entry);
      if (list.length > 10) list = list.slice(0, 10);
      return saveBackupsList(list).then(function() { return entry; });
    });
  }

  function loadInitialState() {
    var lsData = null;
    try {
      var raw = localStorage.getItem(KEY_MAIN);
      if (raw) lsData = JSON.parse(raw);
    } catch (e) {}

    return Promise.all([idbGet(KEY_MAIN), idbGet(KEY_PENDING_RESTORE)]).then(function(res) {
      var idbData = res[0];
      var pendingData = res[1];
      var lsPending = null;
      try {
        var rPend = localStorage.getItem(KEY_PENDING_RESTORE);
        if (rPend) lsPending = JSON.parse(rPend);
      } catch (e) {}

      var best = lsData;
      if (countItems(idbData) > countItems(best)) best = idbData;
      if (countItems(pendingData) >= countItems(best) && pendingData) best = pendingData;
      if (countItems(lsPending) >= countItems(best) && lsPending) best = lsPending;

      if (best) {
        applyPayload(best);
      }

      if (pendingData || lsPending) {
        try { localStorage.removeItem(KEY_PENDING_RESTORE); } catch (e) {}
        idbSet(KEY_PENDING_RESTORE, null);
        saveState();
        if (countItems(best) > 0) {
          showToast("Обновлено до v " + APP_VERSION + " • База восстановлена");
        }
      }
    });
  }

  function updateRangeByMode() {
    var sel = parseDateKey(state.selectedDate);
    var y = sel.getFullYear();
    var m = sel.getMonth();
    var d = sel.getDate();

    if (state.mode === "day") {
      state.rangeStart = state.selectedDate;
      state.rangeEnd = state.selectedDate;
    } else if (state.mode === "week") {
      var dow = sel.getDay();
      var diffToMon = (dow === 0 ? -6 : 1 - dow);
      var mon = new Date(y, m, d + diffToMon);
      var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      state.rangeStart = formatDateKey(mon);
      state.rangeEnd = formatDateKey(sun);
    } else if (state.mode === "half") {
      if (d <= 15) {
        state.rangeStart = formatDateKey(new Date(y, m, 1));
        state.rangeEnd = formatDateKey(new Date(y, m, 15));
      } else {
        var lastDay = new Date(y, m + 1, 0).getDate();
        state.rangeStart = formatDateKey(new Date(y, m, 16));
        state.rangeEnd = formatDateKey(new Date(y, m, lastDay));
      }
    } else if (state.mode === "month") {
      var endM = new Date(y, m + 1, 0).getDate();
      state.rangeStart = formatDateKey(new Date(y, m, 1));
      state.rangeEnd = formatDateKey(new Date(y, m, endM));
    } else if (state.mode === "year") {
      state.rangeStart = formatDateKey(new Date(y, 0, 1));
      state.rangeEnd = formatDateKey(new Date(y, 11, 31));
    }
  }

  function renderCalendar() {
    document.getElementById("monthTitle").textContent = MONTHS_NOM[state.viewMonth] + " " + state.viewYear;
    document.getElementById("verTag").textContent = "v " + APP_VERSION;

    var grid = document.getElementById("daysGrid");
    grid.innerHTML = "";

    var firstDay = new Date(state.viewYear, state.viewMonth, 1);
    var startDow = firstDay.getDay();
    var offset = (startDow === 0) ? 6 : startDow - 1;
    var startDate = new Date(state.viewYear, state.viewMonth, 1 - offset);

    var rMin = state.rangeStart < state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rMax = state.rangeStart < state.rangeEnd ? state.rangeEnd : state.rangeStart;

    for (var i = 0; i < 42; i++) {
      var cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      var key = formatDateKey(cur);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.textContent = cur.getDate();
      cell.dataset.key = key;

      if (cur.getMonth() !== state.viewMonth) {
        cell.classList.add("other-month");
      }
      if (key >= rMin && key <= rMax) {
        cell.classList.add("in-range");
      }
      if (key === state.selectedDate) {
        cell.classList.add("selected");
      }
      if (state.dayOffs[key]) {
        cell.classList.add("day-off");
      }
      if (state.records[key] && state.records[key].length > 0) {
        var dot = document.createElement("div");
        dot.className = "day-dot";
        cell.appendChild(dot);
      }

      grid.appendChild(cell);
    }

    document.getElementById("selectedDateText").textContent = formatHumanDate(state.selectedDate, false);
    renderSummaryAndRecords();
  }

  function getKeysInRange() {
    var rMin = state.rangeStart < state.rangeEnd ? state.rangeStart : state.rangeEnd;
    var rMax = state.rangeStart < state.rangeEnd ? state.rangeEnd : state.rangeStart;
    var keys = [];
    var cur = parseDateKey(rMin);
    var end = parseDateKey(rMax);
    while (cur <= end) {
      keys.push(formatDateKey(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  function renderSummaryAndRecords() {
    var keys = getKeysInRange();
    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;
    var listEl = document.getElementById("recordsList");
    listEl.innerHTML = "";

    keys.forEach(function(k) {
      var arr = state.records[k] || [];
      arr.forEach(function(item, idx) {
        totalBoxes += item.boxes;
        totalKg += item.weight;
        totalRub += item.sum;

        var row = document.createElement("div");
        row.className = "rec-item";
        var left = document.createElement("span");
        left.textContent = formatShortDate(k) + ": " + item.boxes + " кор. | " + Number(item.weight.toFixed(2)) + " кг × " + item.rate + "₽ = " + Number(item.sum.toFixed(2)) + "₽";
        var del = document.createElement("button");
        del.className = "rec-del";
        del.textContent = "✕";
        del.onclick = function() { deleteRecord(k, idx); };
        row.appendChild(left);
        row.appendChild(del);
        listEl.appendChild(row);
      });
    });

    var periodText = "ДЕНЬ";
    if (state.isManualRange && keys.length > 1) {
      periodText = formatHumanDate(keys[0], false).toUpperCase() + " – " + formatHumanDate(keys[keys.length - 1], false).toUpperCase();
    } else if (state.mode === "week") {
      periodText = "НЕДЕЛЯ (" + formatHumanDate(keys[0], false).toUpperCase() + " – " + formatHumanDate(keys[keys.length - 1], false).toUpperCase() + ")";
    } else if (state.mode === "half") {
      periodText = "2Х НЕДЕЛИ (" + formatHumanDate(keys[0], false).toUpperCase() + " – " + formatHumanDate(keys[keys.length - 1], false).toUpperCase() + ")";
    } else if (state.mode === "month") {
      periodText = "МЕСЯЦ (" + MONTHS_NOM[state.viewMonth].toUpperCase() + " " + state.viewYear + ")";
    } else if (state.mode === "year") {
      periodText = "ГОД (" + state.viewYear + ")";
    }

    document.getElementById("recordsTitle").textContent = "ЗАПИСИ (" + periodText + ")";
    document.getElementById("sumLabel").textContent = "ИТОГ ЗА " + periodText;
    document.getElementById("sumMetrics").textContent = totalBoxes + " кор. | " + Number(totalKg.toFixed(2)) + " кг";
    document.getElementById("sumMoney").textContent = Number(totalRub.toFixed(2)) + " ₽";

    var undoWrap = document.getElementById("undoControls");
    if (state.undoStack.length > 0) {
      undoWrap.style.display = "flex";
      document.getElementById("undoBtn").textContent = "↩ Отменить (" + state.undoStack.length + ")";
    } else {
      undoWrap.style.display = "none";
    }
  }

  function deleteRecord(dateKey, index) {
    var arr = state.records[dateKey];
    if (!arr || !arr[index]) return;
    var removed = arr.splice(index, 1)[0];
    if (arr.length === 0) delete state.records[dateKey];
    state.undoStack.push({ dateKey: dateKey, item: removed });
    saveState();
    renderCalendar();
  }

  function updateShiftPreview() {
    var b = parseInt(document.getElementById("boxesInput").value, 10) || 0;
    var w = parseFloat(document.getElementById("weightInput").value.replace(",", ".")) || 0;
    var r = parseFloat(document.getElementById("rateInput").value.replace(",", ".")) || 0;
    var sum = w * r;
    document.getElementById("shiftKg").textContent = Number(w.toFixed(2)) + " кг";
    document.getElementById("shiftRub").textContent = Number(sum.toFixed(2)) + " ₽";
  }

  function buildReportText(isFull) {
    var keys = getKeysInRange();
    var lines = [];
    var name = (state.workerName || "").trim();
    if (name) lines.push(name);

    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;
    var dayLines = [];

    keys.forEach(function(k) {
      var arr = state.records[k] || [];
      if (arr.length === 0) return;
      var dBoxes = 0;
      var dKg = 0;
      var dRub = 0;
      arr.forEach(function(it) {
        dBoxes += it.boxes;
        dKg += it.weight;
        dRub += it.sum;
      });
      totalBoxes += dBoxes;
      totalKg += dKg;
      totalRub += dRub;
      dayLines.push(formatShortDate(k) + " | " + dBoxes + "кор | " + Number(dKg.toFixed(1)) + "кг | " + Number(dRub.toFixed(2)) + "₽");
    });

    if (!isFull) {
      if (state.isManualRange && keys.length > 1) {
        lines.push(formatShortDate(keys[0]) + " – " + formatShortDate(keys[keys.length - 1]));
      }
      lines.push("Вес: " + Number(totalKg.toFixed(1)) + " кг " + totalBoxes + " кор.");
      return lines.join("\n");
    }

    if (keys.length === 1) {
      lines.push("Вес: " + Number(totalKg.toFixed(1)) + " кг " + totalBoxes + " кор.");
      lines.push("Сумма: " + Number(totalRub.toFixed(2)) + "₽");
      return lines.join("\n");
    }

    lines.push("Период: " + formatShortDate(keys[0]) + " – " + formatShortDate(keys[keys.length - 1]));
    dayLines.forEach(function(l) { lines.push(l); });
    lines.push("ИТОГ: " + totalBoxes + "кор | " + Number(totalKg.toFixed(1)) + "кг | " + Number(totalRub.toFixed(2)) + "₽");
    return lines.join("\n");
  }

  function openReportPreview(isFull) {
    var text = buildReportText(isFull);
    document.getElementById("reportPreviewText").value = text;
    document.getElementById("reportModal").style.display = "flex";
  }

  function shareReportToMessengers(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() {});
    }
    if (navigator.share) {
      navigator.share({
        title: "Отчёт обвалка",
        text: text
      }).catch(function() {});
      return;
    }
    window.location.href = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
  }

  function openConfirm(text, onYes) {
    document.getElementById("confirmText").textContent = text;
    confirmCallback = onYes;
    document.getElementById("confirmModal").style.display = "flex";
  }

  function renderBackupsModal() {
    loadBackupsList().then(function(list) {
      var box = document.getElementById("backupList");
      box.innerHTML = "";
      if (!list || list.length === 0) {
        box.innerHTML = "<div style='color:var(--text-muted);font-size:12px;text-align:center;padding:12px;'>Нет сохранённых копий</div>";
        return;
      }
      list.forEach(function(bk, idx) {
        var row = document.createElement("div");
        row.className = "backup-item";
        var info = document.createElement("span");
        var cnt = (typeof bk.count === "number") ? bk.count : countItems(bk.data);
        info.textContent = (bk.date || "Копия") + " (" + cnt + " зап.)";

        var btns = document.createElement("div");
        btns.style.display = "flex";
        btns.style.gap = "4px";

        var restBtn = document.createElement("button");
        restBtn.className = "m-btn primary";
        restBtn.style.padding = "0 8px";
        restBtn.style.height = "26px";
        restBtn.textContent = "Восстановить";
        restBtn.onclick = function() {
          applyPayload(bk.data);
          document.getElementById("workerName").value = state.workerName;
          document.getElementById("rateInput").value = state.lastRate;
          applyTheme();
          saveState();
          renderCalendar();
          document.getElementById("restoreModal").style.display = "none";
          showToast("База восстановлена");
        };

        var delBtn = document.createElement("button");
        delBtn.className = "m-btn danger";
        delBtn.style.minWidth = "28px";
        delBtn.style.width = "28px";
        delBtn.style.height = "26px";
        delBtn.textContent = "✕";
        delBtn.onclick = function() {
          openConfirm("Удалить эту сохранённую базу? Вы уверены?", function() {
            list.splice(idx, 1);
            saveBackupsList(list).then(function() { renderBackupsModal(); });
          });
        };

        btns.appendChild(restBtn);
        btns.appendChild(delBtn);
        row.appendChild(info);
        row.appendChild(btns);
        box.appendChild(row);
      });
    });
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

  /* Полный цикл безопасного обновления: автосохранение -> чистка кэша -> перезагрузка -> автовосстановление */
  function performSafeUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл (v " + APP_VERSION + ")");
      return;
    }
    showToast("Сохранение базы и проверка...");
    var payload = buildPayload();
    try {
      localStorage.setItem(KEY_PENDING_RESTORE, JSON.stringify(payload));
    } catch (e) {}

    Promise.all([
      saveState(),
      idbSet(KEY_PENDING_RESTORE, payload),
      createBackupSnapshot("(перед обн.)")
    ]).then(function() {
      var url = window.location.href.split("?")[0].split("#")[0];
      return fetch(url + "?vcheck=" + Date.now(), { cache: "no-store" })
        .then(function(r) { return r.text(); })
        .then(function(html) {
          var m = html.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
          var remoteVer = m ? m[1] : null;
          if (!remoteVer || remoteVer === APP_VERSION) {
            try { localStorage.removeItem(KEY_PENDING_RESTORE); } catch (e) {}
            idbSet(KEY_PENDING_RESTORE, null);
            showToast("У вас актуальная версия v " + APP_VERSION);
            return;
          }
          showToast("Обновление до v " + remoteVer + "...");
          var cleanPromises = [];
          if ("caches" in window) {
            cleanPromises.push(caches.keys().then(function(names) {
              return Promise.all(names.map(function(n) { return caches.delete(n); }));
            }));
          }
          if ("serviceWorker" in navigator) {
            cleanPromises.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
              return Promise.all(regs.map(function(reg) { return reg.unregister(); }));
            }));
          }
          return Promise.all(cleanPromises).then(function() {
            setTimeout(function() {
              window.location.replace(url + "?v=" + encodeURIComponent(remoteVer) + "&t=" + Date.now());
            }, 300);
          });
        })
        .catch(function() {
          showToast("Нет сети • У вас версия v " + APP_VERSION);
        });
    });
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").onclick = function() {
      state.viewMonth--;
      if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
      if (state.mode === "month" || state.mode === "year") {
        state.selectedDate = formatDateKey(new Date(state.viewYear, state.viewMonth, 1));
        updateRangeByMode();
      }
      renderCalendar();
    };

    document.getElementById("nextMonthBtn").onclick = function() {
      state.viewMonth++;
      if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
      if (state.mode === "month" || state.mode === "year") {
        state.selectedDate = formatDateKey(new Date(state.viewYear, state.viewMonth, 1));
        updateRangeByMode();
      }
      renderCalendar();
    };

    document.getElementById("themeBtn").onclick = function() {
      state.theme = (state.theme === "dark") ? "light" : "dark";
      applyTheme();
      saveState();
    };

    document.getElementById("updateBtn").onclick = performSafeUpdate;

    var tabBtns = document.querySelectorAll(".tab-btn");
    tabBtns.forEach(function(btn) {
      btn.onclick = function() {
        tabBtns.forEach(function(b) { b.classList.remove("active"); });
        btn.classList.add("active");
        state.mode = btn.dataset.mode;
        state.isManualRange = false;
        updateRangeByMode();
        renderCalendar();
      };
    });

    var grid = document.getElementById("daysGrid");
    function getCellKeyFromEvent(e) {
      var target = e.target;
      if (e.touches && e.touches.length > 0) {
        var touch = e.touches[0];
        target = document.elementFromPoint(touch.clientX, touch.clientY);
      }
      if (target && target.classList && target.classList.contains("day-cell")) {
        return target.dataset.key;
      }
      return null;
    }

    grid.addEventListener("pointerdown", function(e) {
      var key = getCellKeyFromEvent(e);
      if (!key) return;
      isDragging = true;
      dragStartKey = key;
      state.selectedDate = key;
      var d = parseDateKey(key);
      state.viewYear = d.getFullYear();
      state.viewMonth = d.getMonth();
      state.isManualRange = false;
      updateRangeByMode();
      renderCalendar();
    });

    grid.addEventListener("pointermove", function(e) {
      if (!isDragging || !dragStartKey) return;
      var key = getCellKeyFromEvent(e);
      if (!key || key === dragStartKey) return;
      state.isManualRange = true;
      state.rangeStart = dragStartKey;
      state.rangeEnd = key;
      renderCalendar();
    });

    window.addEventListener("pointerup", function() {
      isDragging = false;
      dragStartKey = null;
    });

    document.getElementById("dayOffBtn").onclick = function() {
      var k = state.selectedDate;
      if (state.dayOffs[k]) {
        delete state.dayOffs[k];
      } else {
        state.dayOffs[k] = true;
      }
      saveState();
      renderCalendar();
    };

    document.getElementById("workerName").oninput = function(e) {
      state.workerName = e.target.value;
      saveState();
    };

    ["boxesInput", "weightInput", "rateInput"].forEach(function(id) {
      document.getElementById(id).oninput = function(e) {
        e.target.value = e.target.value.replace(/[^0-9.,]/g, "");
        updateShiftPreview();
      };
    });

    document.getElementById("addRecordBtn").onclick = function() {
      var boxes = parseInt(document.getElementById("boxesInput").value, 10) || 0;
      var weight = parseFloat(document.getElementById("weightInput").value.replace(",", ".")) || 0;
      var rate = parseFloat(document.getElementById("rateInput").value.replace(",", ".")) || 0;
      if (weight <= 0 || rate <= 0) {
        showToast("Введите вес и ставку");
        return;
      }
      var k = state.selectedDate;
      if (!state.records[k]) state.records[k] = [];
      state.records[k].push({
        boxes: boxes,
        weight: weight,
        rate: rate,
        sum: weight * rate
      });
      state.lastRate = String(rate);
      document.getElementById("boxesInput").value = "";
      document.getElementById("weightInput").value = "";
      updateShiftPreview();

      var todayKey = formatDateKey(new Date());
      if (state.lastAutoBackupDate !== todayKey) {
        state.lastAutoBackupDate = todayKey;
        createBackupSnapshot("(авто)");
      }
      saveState();
      renderCalendar();
      showToast("Запись добавлена");
    };

    document.getElementById("undoBtn").onclick = function() {
      if (state.undoStack.length === 0) return;
      var last = state.undoStack.pop();
      if (!state.records[last.dateKey]) state.records[last.dateKey] = [];
      state.records[last.dateKey].push(last.item);
      saveState();
      renderCalendar();
    };

    document.getElementById("clearUndoBtn").onclick = function() {
      openConfirm("Очистить все отменённые записи без возможности возврата?", function() {
        state.undoStack = [];
        renderSummaryAndRecords();
      });
    };

    document.getElementById("fullReportBtn").onclick = function() { openReportPreview(true); };
    document.getElementById("shortReportBtn").onclick = function() { openReportPreview(false); };

    document.getElementById("cancelReportBtn").onclick = function() {
      document.getElementById("reportModal").style.display = "none";
    };

    document.getElementById("sendReportBtn").onclick = function() {
      var txt = document.getElementById("reportPreviewText").value;
      document.getElementById("reportModal").style.display = "none";
      shareReportToMessengers(txt);
    };

    document.getElementById("saveDbBtn").onclick = function() {
      createBackupSnapshot("").then(function(entry) {
        saveState();
        showToast("Сохранено в телефон (" + entry.count + " зап.)");
      });
    };

    document.getElementById("restoreDbBtn").onclick = function() {
      renderBackupsModal();
      document.getElementById("restoreModal").style.display = "flex";
    };

    document.getElementById("closeRestoreBtn").onclick = function() {
      document.getElementById("restoreModal").style.display = "none";
    };

    document.getElementById("transferCodeBtn").onclick = function() {
      var code = btoa(unescape(encodeURIComponent(JSON.stringify(buildPayload()))));
      document.getElementById("dbCodeArea").value = code;
      document.getElementById("codeModal").style.display = "flex";
    };

    document.getElementById("copyCodeBtn").onclick = function() {
      var area = document.getElementById("dbCodeArea");
      area.select();
      if (navigator.clipboard) navigator.clipboard.writeText(area.value).catch(function() {});
      showToast("Код скопирован");
    };

    document.getElementById("applyCodeBtn").onclick = function() {
      try {
        var raw = document.getElementById("dbCodeArea").value.trim();
        var jsonStr = decodeURIComponent(escape(atob(raw)));
        var obj = JSON.parse(jsonStr);
        applyPayload(obj);
        document.getElementById("workerName").value = state.workerName;
        document.getElementById("rateInput").value = state.lastRate;
        applyTheme();
        saveState();
        renderCalendar();
        document.getElementById("codeModal").style.display = "none";
        document.getElementById("restoreModal").style.display = "none";
        showToast("База загружена из кода");
      } catch (e) {
        showToast("Неверный код базы");
      }
    };

    document.getElementById("closeCodeBtn").onclick = function() {
      document.getElementById("codeModal").style.display = "none";
    };

    document.getElementById("confirmNoBtn").onclick = function() {
      document.getElementById("confirmModal").style.display = "none";
      confirmCallback = null;
    };

    document.getElementById("confirmYesBtn").onclick = function() {
      document.getElementById("confirmModal").style.display = "none";
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
    };
  }

  loadInitialState().then(function() {
    document.getElementById("workerName").value = state.workerName;
    document.getElementById("rateInput").value = state.lastRate;
    applyTheme();
    updateRangeByMode();
    bindEvents();
    renderCalendar();
  });
})();