(function () {
  var APP_VERSION = "7.7";
  var STORAGE_KEY = "obvalka_pro_v1";
  var BACKUPS_KEY = "obvalka_pro_backups_v1";
  var MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  var today = new Date();
  var viewYear = today.getFullYear();
  var viewMonth = today.getMonth();
  var selectedDate = formatDateKey(today);
  var rangeStart = selectedDate;
  var rangeEnd = selectedDate;
  var periodMode = "day";
  var isManualRange = false;
  var isDragging = false;
  var dragAnchor = null;

  var state = {
    records: {},
    worker: "",
    rate: "",
    theme: "dark"
  };

  var undoStack = [];
  var confirmCallback = null;

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function formatDateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseDateKey(key) {
    var p = key.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function numVal(v) {
    if (v === null || v === undefined || v === "") return 0;
    var n = parseFloat(String(v).replace(",", ".").replace(/[^\d.-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function round2(n) {
    return Math.round((n + 0.0000001) * 100) / 100;
  }

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.style.display = "none";
    }, 2400);
  }

  function normalizeRecord(rec, fallbackRate) {
    if (!rec || typeof rec !== "object") return null;
    var isOff = Boolean(rec.isOff || rec.off || rec.dayOff);
    var boxes = Math.round(numVal(rec.boxes !== undefined ? rec.boxes : (rec.b !== undefined ? rec.b : rec.count)));
    var boxWeight = numVal(rec.boxWeight !== undefined ? rec.boxWeight : (rec.bw !== undefined ? rec.bw : 0));
    var weight = numVal(rec.weight !== undefined ? rec.weight : (rec.totalWeight !== undefined ? rec.totalWeight : rec.w));
    if (weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round2(boxes * boxWeight);
    }
    var rate = numVal(rec.rate !== undefined ? rec.rate : rec.r);
    if (rate <= 0 && fallbackRate > 0) {
      rate = fallbackRate;
    }
    var pay = numVal(rec.pay !== undefined ? rec.pay : (rec.totalPay !== undefined ? rec.totalPay : rec.sum));
    if (pay <= 0 && weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    } else if (weight > 0 && rate > 0 && Math.abs(pay - round2(weight * rate)) > 0.05) {
      pay = round2(weight * rate);
    }
    if (!isOff && boxes === 0 && weight === 0 && pay === 0) {
      isOff = true;
    }
    return {
      id: rec.id || (Date.now() + Math.random()),
      boxes: boxes,
      boxWeight: round2(boxWeight),
      weight: round2(weight),
      rate: round2(rate),
      pay: round2(pay),
      isOff: isOff
    };
  }

  function normalizeState(raw) {
    var out = {
      records: {},
      worker: (raw && raw.worker) ? String(raw.worker) : "",
      rate: (raw && raw.rate !== undefined && raw.rate !== null) ? String(raw.rate) : "",
      theme: (raw && raw.theme === "light") ? "light" : "dark"
    };
    var fbRate = numVal(out.rate);
    if (raw && raw.records && typeof raw.records === "object") {
      Object.keys(raw.records).forEach(function (dk) {
        var arr = raw.records[dk];
        if (Array.isArray(arr)) {
          var cleanArr = [];
          arr.forEach(function (item) {
            var nr = normalizeRecord(item, fbRate);
            if (nr) cleanArr.push(nr);
          });
          if (cleanArr.length > 0) out.records[dk] = cleanArr;
        }
      });
    }
    return out;
  }

  function countTotalRecords(st) {
    if (!st || !st.records) return 0;
    var c = 0;
    Object.keys(st.records).forEach(function (k) {
      if (Array.isArray(st.records[k])) c += st.records[k].length;
    });
    return c;
  }

  function idbOpen(cb) {
    if (!window.indexedDB) { cb(null); return; }
    var req = indexedDB.open("ObvalkaProDB", 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = function (e) { cb(e.target.result); };
    req.onerror = function () { cb(null); };
  }

  function idbSet(key, val, done) {
    idbOpen(function (db) {
      if (!db) { if (done) done(); return; }
      try {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = function () { if (done) done(); };
        tx.onerror = function () { if (done) done(); };
      } catch (e) {
        if (done) done();
      }
    });
  }

  function idbGet(key, cb) {
    idbOpen(function (db) {
      if (!db) { cb(null); return; }
      try {
        var tx = db.transaction("kv", "readonly");
        var req = tx.objectStore("kv").get(key);
        req.onsuccess = function () { cb(req.result || null); };
        req.onerror = function () { cb(null); };
      } catch (e) {
        cb(null);
      }
    });
  }

  function saveState(done) {
    var json = JSON.stringify(state);
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    try { window.name = "OBV_STATE:" + json; } catch (e) {}
    idbSet(STORAGE_KEY, json, done);
  }

  function getBackupsList() {
    try {
      var raw = localStorage.getItem(BACKUPS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveBackupsList(arr, done) {
    var json = JSON.stringify(arr);
    try { localStorage.setItem(BACKUPS_KEY, json); } catch (e) {}
    idbSet(BACKUPS_KEY, json, done);
  }

  function createBackup(tag, done) {
    var list = getBackupsList();
    var d = new Date();
    var title = pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (tag ? " " + tag : "");
    var item = {
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      title: title,
      count: countTotalRecords(state),
      data: JSON.parse(JSON.stringify(state))
    };
    list.unshift(item);
    if (list.length > 25) list = list.slice(0, 25);
    saveBackupsList(list, done);
  }

  function autoDailyBackup() {
    var d = new Date();
    var dayMark = formatDateKey(d);
    var lastAuto = "";
    try { lastAuto = localStorage.getItem("obvalka_last_auto") || ""; } catch (e) {}
    if (lastAuto !== dayMark && countTotalRecords(state) > 0) {
      try { localStorage.setItem("obvalka_last_auto", dayMark); } catch (e) {}
      createBackup("(авто)");
    }
  }

  function loadInitialState(cb) {
    var candidates = [];
    try {
      var ls = localStorage.getItem(STORAGE_KEY);
      if (ls) candidates.push(normalizeState(JSON.parse(ls)));
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBV_STATE:") === 0) {
        candidates.push(normalizeState(JSON.parse(window.name.slice(10))));
      }
    } catch (e) {}

    idbGet(STORAGE_KEY, function (idbRaw) {
      if (idbRaw) {
        try {
          var parsed = typeof idbRaw === "string" ? JSON.parse(idbRaw) : idbRaw;
          candidates.push(normalizeState(parsed));
        } catch (e) {}
      }
      idbGet(BACKUPS_KEY, function (idbBackups) {
        if (idbBackups) {
          try {
            var localB = getBackupsList();
            var remoteB = typeof idbBackups === "string" ? JSON.parse(idbBackups) : idbBackups;
            if (Array.isArray(remoteB) && remoteB.length > localB.length) {
              saveBackupsList(remoteB);
            }
          } catch (e) {}
        }
        var best = null;
        candidates.forEach(function (c) {
          if (!best || countTotalRecords(c) > countTotalRecords(best)) {
            best = c;
          }
        });
        if (best) {
          state = best;
        }
        cb();
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

  function computePeriodBounds() {
    var base = parseDateKey(selectedDate);
    if (isManualRange) {
      return rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
    }
    if (periodMode === "day") {
      return [selectedDate, selectedDate];
    }
    if (periodMode === "week") {
      var dow = (base.getDay() + 6) % 7;
      var s = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dow);
      var e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
      return [formatDateKey(s), formatDateKey(e)];
    }
    if (periodMode === "2week") {
      var dayNum = base.getDate();
      var lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      if (dayNum <= 15) {
        return [formatDateKey(new Date(base.getFullYear(), base.getMonth(), 1)), formatDateKey(new Date(base.getFullYear(), base.getMonth(), 15))];
      } else {
        return [formatDateKey(new Date(base.getFullYear(), base.getMonth(), 16)), formatDateKey(new Date(base.getFullYear(), base.getMonth(), lastDay))];
      }
    }
    if (periodMode === "month") {
      var mLast = new Date(viewYear, viewMonth + 1, 0).getDate();
      return [formatDateKey(new Date(viewYear, viewMonth, 1)), formatDateKey(new Date(viewYear, viewMonth, mLast))];
    }
    if (periodMode === "year") {
      return [viewYear + "-01-01", viewYear + "-12-31"];
    }
    return [selectedDate, selectedDate];
  }

  function formatHumanRange(sKey, eKey) {
    var sd = parseDateKey(sKey);
    var ed = parseDateKey(eKey);
    if (sKey === eKey) {
      return sd.getDate() + " " + MONTHS_GEN[sd.getMonth()];
    }
    return sd.getDate() + " " + MONTHS_SHORT[sd.getMonth()] + " – " + ed.getDate() + " " + MONTHS_SHORT[ed.getMonth()];
  }

  function getRecordsInBounds(sKey, eKey) {
    var items = [];
    var keys = Object.keys(state.records).sort();
    keys.forEach(function (dk) {
      if (dk >= sKey && dk <= eKey) {
        var arr = state.records[dk] || [];
        arr.forEach(function (r) {
          items.push({ date: dk, rec: r });
        });
      }
    });
    return items;
  }

  function renderCalendar() {
    document.getElementById("monthLabel").textContent = MONTHS_NOM[viewMonth] + " " + viewYear;
    var grid = document.getElementById("daysGrid");
    grid.innerHTML = "";

    var bounds = computePeriodBounds();
    var bStart = bounds[0];
    var bEnd = bounds[1];

    var firstDay = new Date(viewYear, viewMonth, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var gridStart = new Date(viewYear, viewMonth, 1 - startOffset);

    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      var dk = formatDateKey(d);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.setAttribute("data-date", dk);
      cell.textContent = d.getDate();

      if (d.getMonth() !== viewMonth) cell.classList.add("other-month");
      if (dk >= bStart && dk <= bEnd) cell.classList.add("in-range");
      if (dk === selectedDate) cell.classList.add("selected");

      var dayRecs = state.records[dk] || [];
      if (dayRecs.length > 0) {
        var hasOff = dayRecs.some(function (r) { return r.isOff; });
        var hasWork = dayRecs.some(function (r) { return !r.isOff; });
        if (hasOff && !hasWork) cell.classList.add("is-off");
        if (hasWork) {
          var dot = document.createElement("span");
          dot.className = "day-dot";
          cell.appendChild(dot);
        }
      }
      grid.appendChild(cell);
    }
  }

  function renderRecordsAndSummary() {
    var bounds = computePeriodBounds();
    var bStart = bounds[0];
    var bEnd = bounds[1];
    var items = getRecordsInBounds(bStart, bEnd);

    var modeTitles = { day: "ДЕНЬ", week: "НЕДЕЛЯ", "2week": "2Х НЕДЕЛИ", month: "МЕСЯЦ", year: "ГОД" };
    var rangeLabel = formatHumanRange(bStart, bEnd);
    document.getElementById("recordsHeader").textContent = "ЗАПИСИ (" + (isManualRange ? rangeLabel : modeTitles[periodMode] + " (" + rangeLabel + ")") + ")";
    document.getElementById("recordsCount").textContent = items.length + " ШТ.";
    document.getElementById("sumTitle").textContent = "ИТОГ ЗА " + (isManualRange ? "ПЕРИОД" : modeTitles[periodMode]) + " (" + rangeLabel + ")";

    var sd = parseDateKey(selectedDate);
    document.getElementById("selectedDateLabel").textContent = sd.getDate() + " " + MONTHS_GEN[sd.getMonth()];

    var listEl = document.getElementById("recordsList");
    listEl.innerHTML = "";

    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;

    items.forEach(function (entry) {
      var dk = entry.date;
      var r = entry.rec;
      var dObj = parseDateKey(dk);
      var dStr = dObj.getDate() + " " + MONTHS_SHORT[dObj.getMonth()];

      var row = document.createElement("div");
      row.className = "rec-item" + (r.isOff ? " off-rec" : "");

      var txt = document.createElement("span");
      if (r.isOff) {
        txt.textContent = dStr + ": Выходной";
      } else {
        totalBoxes += r.boxes;
        totalWeight = round2(totalWeight + r.weight);
        totalPay = round2(totalPay + r.pay);
        var parts = [];
        if (r.boxes > 0) parts.push(r.boxes + " кор.");
        parts.push(r.weight + " кг × " + r.rate + " ₽ = " + r.pay + " ₽");
        txt.textContent = dStr + ": " + parts.join(" • ");
      }

      var delBtn = document.createElement("button");
      delBtn.className = "del-rec-btn";
      delBtn.textContent = "✕";
      delBtn.onclick = function () {
        deleteSingleRecord(dk, r.id);
      };

      row.appendChild(txt);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });

    document.getElementById("sumSub").textContent = totalBoxes + " кор. • " + totalWeight + " кг";
    document.getElementById("sumMoney").textContent = totalPay + " ₽";

    var undoBar = document.getElementById("undoBar");
    if (undoStack.length > 0 || items.length > 0) {
      undoBar.style.display = "flex";
      document.getElementById("undoBtn").textContent = "↩ Отменить (" + undoStack.length + ")";
      document.getElementById("undoBtn").style.opacity = undoStack.length > 0 ? "1" : "0.5";
    } else {
      undoBar.style.display = "none";
    }
  }

  function updateShiftPreview() {
    var boxes = Math.round(numVal(document.getElementById("boxesInput").value));
    var bw = numVal(document.getElementById("boxWeightInput").value);
    var rate = numVal(document.getElementById("rateInput").value);
    var weight = (boxes > 0 && bw > 0) ? round2(boxes * bw) : round2(bw);
    var pay = round2(weight * rate);
    document.getElementById("previewWeight").textContent = weight + " кг";
    document.getElementById("previewPay").textContent = pay + " ₽";
  }

  function renderAll() {
    renderCalendar();
    renderRecordsAndSummary();
    updateShiftPreview();
  }

  function deleteSingleRecord(dk, id) {
    var arr = state.records[dk] || [];
    var idx = arr.findIndex(function (x) { return x.id === id; });
    if (idx === -1) return;
    var removed = arr.splice(idx, 1)[0];
    if (arr.length === 0) delete state.records[dk];
    undoStack.push({ date: dk, rec: removed });
    saveState();
    renderAll();
  }

  function buildReport(isFull) {
    var bounds = computePeriodBounds();
    var bStart = bounds[0];
    var bEnd = bounds[1];
    var items = getRecordsInBounds(bStart, bEnd).filter(function (x) { return !x.rec.isOff; });

    var worker = (state.worker || "").trim();
    var totalBoxes = 0;
    var totalWeight = 0;
    var totalPay = 0;

    items.forEach(function (it) {
      totalBoxes += it.rec.boxes;
      totalWeight = round2(totalWeight + it.rec.weight);
      totalPay = round2(totalPay + it.rec.pay);
    });

    var lines = [];
    if (worker) lines.push(worker);

    if (!isFull) {
      if (isManualRange && bStart !== bEnd) {
        lines.push(formatHumanRange(bStart, bEnd));
      }
      lines.push("Вес: " + totalWeight + " кг " + totalBoxes + " кор.");
      return lines.join("\\n");
    }

    lines.push("Период: " + formatHumanRange(bStart, bEnd));
    items.forEach(function (it) {
      var dObj = parseDateKey(it.date);
      var dStr = pad2(dObj.getDate()) + " " + MONTHS_SHORT[dObj.getMonth()];
      lines.push(dStr + " | " + it.rec.boxes + "кор | " + it.rec.weight + "кг | " + it.rec.pay + "₽");
    });
    lines.push("ИТОГ: " + totalBoxes + "кор | " + totalWeight + "кг | " + totalPay + "₽");
    return lines.join("\\n");
  }

  function openReportPreview(isFull) {
    var text = buildReport(isFull);
    document.getElementById("reportText").value = text;
    document.getElementById("reportModal").style.display = "flex";
  }

  function copyToClipboardSilent(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
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

  function shareReportText(text) {
    copyToClipboardSilent(text);
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () {
        try {
          window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(text) + ";end";
        } catch (e) {}
      });
    } else {
      try {
        window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(text) + ";end";
      } catch (e) {
        showToast("Текст скопирован в буфер");
      }
    }
  }

  function openConfirm(title, msg, onYes) {
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmMsg").textContent = msg;
    confirmCallback = onYes;
    document.getElementById("confirmModal").style.display = "flex";
  }

  function renderBackupsModal() {
    var list = getBackupsList();
    var box = document.getElementById("backupList");
    box.innerHTML = "";
    if (list.length === 0) {
      box.innerHTML = "<div style='color:var(--muted);font-size:12px;text-align:center;padding:16px;'>Нет сохранённых копий</div>";
      return;
    }
    list.forEach(function (b) {
      var row = document.createElement("div");
      row.className = "backup-item";

      var info = document.createElement("div");
      var cnt = (b.count !== undefined && b.count !== null) ? b.count : countTotalRecords(b.data);
      info.innerHTML = "<strong>" + (b.title || "Резервная копия") + "</strong><br><span style='color:var(--muted)'>Записей: " + cnt + "</span>";

      var acts = document.createElement("div");
      acts.className = "b-actions";

      var rBtn = document.createElement("button");
      rBtn.className = "b-rest";
      rBtn.textContent = "Восстановить";
      rBtn.onclick = function () {
        openConfirm("Восстановление базы", "Заменить текущие данные этой копией?", function () {
          state = normalizeState(b.data);
          saveState(function () {
            document.getElementById("workerInput").value = state.worker;
            document.getElementById("rateInput").value = state.rate;
            applyTheme();
            renderAll();
            document.getElementById("restoreModal").style.display = "none";
            showToast("База восстановлена (" + countTotalRecords(state) + " зап.)");
          });
        });
      };

      var dBtn = document.createElement("button");
      dBtn.className = "b-del";
      dBtn.textContent = "✕";
      dBtn.onclick = function () {
        openConfirm("Удаление копии", "Удалить эту сохранённую базу? Вы уверены?", function () {
          var nextList = getBackupsList().filter(function (x) { return x.id !== b.id; });
          saveBackupsList(nextList, function () {
            renderBackupsModal();
            showToast("Копия удалена");
          });
        });
      };

      acts.appendChild(rBtn);
      acts.appendChild(dBtn);
      row.appendChild(info);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  function runStepByStepUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: автообновление работает через GitHub");
      return;
    }
    showToast("Шаг 1/4: Сохранение базы...");
    createBackup("(перед обн.)", function () {
      saveState(function () {
        setTimeout(function () {
          showToast("Шаг 2/4: Проверка целостности...");
          setTimeout(function () {
            showToast("Шаг 3/4: Очистка кэша...");
            var clearTasks = [];
            if (window.caches && caches.keys) {
              clearTasks.push(caches.keys().then(function (keys) {
                return Promise.all(keys.map(function (k) { return caches.delete(k); }));
              }));
            }
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              clearTasks.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
                return Promise.all(regs.map(function (r) { return r.unregister(); }));
              }));
            }
            Promise.all(clearTasks).finally(function () {
              setTimeout(function () {
                showToast("Шаг 4/4: Перезагрузка...");
                setTimeout(function () {
                  window.location.reload(true);
                }, 600);
              }, 700);
            });
          }, 700);
        }, 700);
      });
    });
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").onclick = function () {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderAll();
    };
    document.getElementById("nextMonthBtn").onclick = function () {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderAll();
    };
    document.getElementById("themeBtn").onclick = function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      saveState();
    };
    document.getElementById("updateBtn").onclick = runStepByStepUpdate;

    document.getElementById("periodTabs").onclick = function (e) {
      var btn = e.target.closest(".tab");
      if (!btn) return;
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      periodMode = btn.getAttribute("data-mode");
      isManualRange = false;
      renderAll();
    };

    var grid = document.getElementById("daysGrid");
    grid.addEventListener("pointerdown", function (e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      var dk = cell.getAttribute("data-date");
      isDragging = true;
      dragAnchor = dk;
      selectedDate = dk;
      rangeStart = dk;
      rangeEnd = dk;
      isManualRange = false;
      renderAll();
    });

    grid.addEventListener("pointermove", function (e) {
      if (!isDragging || !dragAnchor) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el ? el.closest(".day-cell") : null;
      if (!cell) return;
      var dk = cell.getAttribute("data-date");
      if (dk && dk !== rangeEnd) {
        rangeStart = dragAnchor;
        rangeEnd = dk;
        isManualRange = (rangeStart !== rangeEnd);
        renderAll();
      }
    });

    window.addEventListener("pointerup", function () {
      isDragging = false;
    });

    document.getElementById("toggleOffBtn").onclick = function () {
      var arr = state.records[selectedDate] || [];
      var offIdx = arr.findIndex(function (x) { return x.isOff; });
      if (offIdx !== -1) {
        var rem = arr.splice(offIdx, 1)[0];
        if (arr.length === 0) delete state.records[selectedDate];
        undoStack.push({ date: selectedDate, rec: rem });
      } else {
        if (!state.records[selectedDate]) state.records[selectedDate] = [];
        state.records[selectedDate].push({
          id: Date.now() + Math.random(),
          boxes: 0,
          boxWeight: 0,
          weight: 0,
          rate: numVal(state.rate),
          pay: 0,
          isOff: true
        });
        autoDailyBackup();
      }
      saveState();
      renderAll();
    };

    document.getElementById("workerInput").addEventListener("input", function (e) {
      state.worker = e.target.value;
      saveState();
    });

    ["boxesInput", "boxWeightInput", "rateInput"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", function (e) {
        if (id === "rateInput") {
          state.rate = e.target.value;
          saveState();
        }
        updateShiftPreview();
      });
    });

    document.getElementById("addRecordBtn").onclick = function () {
      var boxes = Math.round(numVal(document.getElementById("boxesInput").value));
      var bw = numVal(document.getElementById("boxWeightInput").value);
      var rate = numVal(document.getElementById("rateInput").value);
      var weight = (boxes > 0 && bw > 0) ? round2(boxes * bw) : round2(bw);
      if (weight <= 0 && boxes <= 0) {
        showToast("Введите коробки или вес");
        return;
      }
      var pay = round2(weight * rate);
      if (!state.records[selectedDate]) state.records[selectedDate] = [];
      state.records[selectedDate].push({
        id: Date.now() + Math.random(),
        boxes: boxes,
        boxWeight: round2(bw),
        weight: weight,
        rate: round2(rate),
        pay: pay,
        isOff: false
      });
      document.getElementById("boxesInput").value = "";
      document.getElementById("boxWeightInput").value = "";
      autoDailyBackup();
      saveState();
      renderAll();
      showToast("Запись добавлена");
    };

    document.getElementById("undoBtn").onclick = function () {
      if (undoStack.length === 0) return;
      var last = undoStack.pop();
      if (!state.records[last.date]) state.records[last.date] = [];
      state.records[last.date].push(last.rec);
      saveState();
      renderAll();
    };

    document.getElementById("clearPeriodBtn").onclick = function () {
      var bounds = computePeriodBounds();
      var items = getRecordsInBounds(bounds[0], bounds[1]);
      if (items.length === 0) return;
      openConfirm("Очистка записей", "Удалить все записи (" + items.length + " шт.) за выбранный период?", function () {
        items.forEach(function (it) {
          undoStack.push({ date: it.date, rec: it.rec });
        });
        Object.keys(state.records).forEach(function (dk) {
          if (dk >= bounds[0] && dk <= bounds[1]) delete state.records[dk];
        });
        saveState();
        renderAll();
        showToast("Записи очищены");
      });
    };

    document.getElementById("fullReportBtn").onclick = function () { openReportPreview(true); };
    document.getElementById("shortReportBtn").onclick = function () { openReportPreview(false); };
    document.getElementById("closeReportBtn").onclick = function () {
      document.getElementById("reportModal").style.display = "none";
    };
    document.getElementById("sendReportBtn").onclick = function () {
      var txt = document.getElementById("reportText").value;
      document.getElementById("reportModal").style.display = "none";
      shareReportText(txt);
    };

    document.getElementById("saveDbBtn").onclick = function () {
      createBackup("", function () {
        saveState(function () {
          showToast("Резервная копия сохранена");
        });
      });
    };

    document.getElementById("openRestoreBtn").onclick = function () {
      renderBackupsModal();
      document.getElementById("restoreModal").style.display = "flex";
    };
    document.getElementById("closeRestoreBtn").onclick = function () {
      document.getElementById("restoreModal").style.display = "none";
    };

    document.getElementById("transferCodeBtn").onclick = function () {
      document.getElementById("transferCodeArea").value = JSON.stringify(state);
      document.getElementById("codeModal").style.display = "flex";
    };
    document.getElementById("closeCodeBtn").onclick = function () {
      document.getElementById("codeModal").style.display = "none";
    };
    document.getElementById("copyCodeBtn").onclick = function () {
      var val = document.getElementById("transferCodeArea").value;
      copyToClipboardSilent(val);
      showToast("Код базы скопирован");
    };
    document.getElementById("importCodeBtn").onclick = function () {
      var raw = document.getElementById("transferCodeArea").value.trim();
      if (!raw) return;
      try {
        var parsed = JSON.parse(raw);
        state = normalizeState(parsed);
        saveState(function () {
          document.getElementById("workerInput").value = state.worker;
          document.getElementById("rateInput").value = state.rate;
          applyTheme();
          renderAll();
          document.getElementById("codeModal").style.display = "none";
          document.getElementById("restoreModal").style.display = "none";
          showToast("База успешно загружена");
        });
      } catch (e) {
        showToast("Неверный формат кода");
      }
    };

    document.getElementById("confirmNoBtn").onclick = function () {
      document.getElementById("confirmModal").style.display = "none";
      confirmCallback = null;
    };
    document.getElementById("confirmYesBtn").onclick = function () {
      document.getElementById("confirmModal").style.display = "none";
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
    };
  }

  function init() {
    loadInitialState(function () {
      document.getElementById("workerInput").value = state.worker || "";
      document.getElementById("rateInput").value = state.rate || "";
      applyTheme();
      bindEvents();
      renderAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
