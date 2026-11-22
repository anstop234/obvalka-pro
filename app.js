(function () {
  var APP_VERSION = "7.6";
  var STORAGE_KEY = "obvalka_pro_db_v1";
  var BACKUPS_KEY = "obvalka_pro_backups_v1";
  var IDB_NAME = "ObvalkaProDB";
  var IDB_STORE = "kv";

  var MONTHS_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  var state = {
    records: {},
    worker: "",
    rate: "",
    theme: "dark",
    lastAutoBackupDate: ""
  };
  var backups = [];
  var trash = [];

  var today = new Date();
  var viewYear = today.getFullYear();
  var viewMonth = today.getMonth();
  var selectedKey = fmtKey(today);
  var mode = "day";
  var customRange = null;
  var isDragging = false;
  var dragStartKey = null;

  function fmtKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseKey(k) {
    var p = k.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function parseNum(val) {
    if (val === null || val === undefined) return 0;
    var s = String(val).replace(",", ".").replace(/[^0-9.]/g, "");
    var parts = s.split(".");
    if (parts.length > 2) s = parts[0] + "." + parts.slice(1).join("");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function fmtNum(n) {
    var r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : String(r);
  }

  function showToast(msg, ms) {
    var el = document.getElementById("toastBox");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.style.display = "none";
    }, ms || 2400);
  }

  function openIDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        var req = indexedDB.open(IDB_NAME, 1);
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

  function idbGet(key) {
    return openIDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readonly");
          var st = tx.objectStore(IDB_STORE);
          var rq = st.get(key);
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          var st = tx.objectStore(IDB_STORE);
          st.put(val, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function countItems(recObj) {
    if (!recObj) return 0;
    var total = 0;
    Object.keys(recObj).forEach(function (k) {
      if (Array.isArray(recObj[k])) total += recObj[k].length;
    });
    return total;
  }

  function saveAll() {
    var payload = JSON.stringify(state);
    var bkPayload = JSON.stringify(backups);
    try { localStorage.setItem(STORAGE_KEY, payload); } catch (e) {}
    try { localStorage.setItem(BACKUPS_KEY, bkPayload); } catch (e) {}
    try {
      window.name = JSON.stringify({ st: state, bk: backups });
    } catch (e) {}
    return Promise.all([
      idbSet(STORAGE_KEY, payload),
      idbSet(BACKUPS_KEY, bkPayload)
    ]);
  }

  function loadAll() {
    var lsState = null;
    var lsBk = [];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsState = JSON.parse(raw);
    } catch (e) {}
    try {
      var rawB = localStorage.getItem(BACKUPS_KEY);
      if (rawB) lsBk = JSON.parse(rawB);
    } catch (e) {}

    var wnState = null;
    var wnBk = [];
    try {
      if (window.name && window.name.charAt(0) === "{") {
        var parsedWn = JSON.parse(window.name);
        if (parsedWn && parsedWn.st) wnState = parsedWn.st;
        if (parsedWn && Array.isArray(parsedWn.bk)) wnBk = parsedWn.bk;
      }
    } catch (e) {}

    return Promise.all([idbGet(STORAGE_KEY), idbGet(BACKUPS_KEY)]).then(function (res) {
      var idbState = null;
      var idbBk = [];
      try { if (res[0]) idbState = JSON.parse(res[0]); } catch (e) {}
      try { if (res[1]) idbBk = JSON.parse(res[1]); } catch (e) {}

      var candidates = [lsState, idbState, wnState].filter(Boolean);
      var best = null;
      var bestScore = -1;
      candidates.forEach(function (c) {
        var sc = countItems(c.records) * 10 + (c.worker ? 1 : 0) + (c.rate ? 1 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          best = c;
        }
      });

      if (best) {
        state.records = best.records || {};
        state.worker = best.worker || "";
        state.rate = best.rate || "";
        state.theme = best.theme || "dark";
        state.lastAutoBackupDate = best.lastAutoBackupDate || "";
      }

      var allBk = [lsBk, idbBk, wnBk];
      var longestBk = [];
      allBk.forEach(function (arr) {
        if (Array.isArray(arr) && arr.length > longestBk.length) longestBk = arr;
      });
      backups = longestBk;
      saveAll();
    });
  }

  function createBackup(tag) {
    var now = new Date();
    var label = String(now.getDate()).padStart(2, "0") + "." +
      String(now.getMonth() + 1).padStart(2, "0") + "." +
      now.getFullYear() + " " +
      String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0");
    if (tag) label += " (" + tag + ")";
    var snap = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      label: label,
      count: countItems(state.records),
      data: JSON.parse(JSON.stringify(state))
    };
    backups.unshift(snap);
    if (backups.length > 25) backups = backups.slice(0, 25);
    return saveAll();
  }

  function calcShiftPreview() {
    var boxes = parseInt(parseNum(document.getElementById("boxesInput").value), 10) || 0;
    var boxWeight = parseNum(document.getElementById("weightInput").value);
    var rate = parseNum(document.getElementById("rateInput").value);
    var totalKg = boxes > 0 ? (boxes * boxWeight) : boxWeight;
    totalKg = Math.round(totalKg * 100) / 100;
    var rub = Math.round(totalKg * rate * 100) / 100;
    document.getElementById("shiftKgLabel").textContent = fmtNum(totalKg) + " кг";
    document.getElementById("shiftRubLabel").textContent = fmtNum(rub) + " ₽";
    return { boxes: boxes, boxWeight: boxWeight, totalKg: totalKg, rate: rate, rub: rub };
  }

  function getActiveRange() {
    if (customRange) return customRange;
    var sel = parseKey(selectedKey);
    if (mode === "day") {
      return { start: sel, end: sel };
    }
    if (mode === "week") {
      var dow = (sel.getDay() + 6) % 7;
      var s = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() - dow);
      var e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
      return { start: s, end: e };
    }
    if (mode === "2weeks") {
      var y = sel.getFullYear();
      var m = sel.getMonth();
      if (sel.getDate() <= 15) {
        return { start: new Date(y, m, 1), end: new Date(y, m, 15) };
      } else {
        var lastD = new Date(y, m + 1, 0).getDate();
        return { start: new Date(y, m, 16), end: new Date(y, m, lastD) };
      }
    }
    if (mode === "month") {
      return {
        start: new Date(viewYear, viewMonth, 1),
        end: new Date(viewYear, viewMonth + 1, 0)
      };
    }
    return {
      start: new Date(viewYear, 0, 1),
      end: new Date(viewYear, 11, 31)
    };
  }

  function isKeyInRange(k, range) {
    var d = parseKey(k).getTime();
    var s = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()).getTime();
    var e = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate()).getTime();
    if (s > e) { var t = s; s = e; e = t; }
    return d >= s && d <= e;
  }

  function renderCalendar() {
    document.getElementById("monthLabel").textContent = MONTHS_NOM[viewMonth] + " " + viewYear;
    document.getElementById("verLabel").textContent = "v " + APP_VERSION;

    var grid = document.getElementById("daysGrid");
    grid.innerHTML = "";

    var firstDay = new Date(viewYear, viewMonth, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var startDate = new Date(viewYear, viewMonth, 1 - startOffset);
    var range = getActiveRange();
    var todayKey = fmtKey(today);

    for (var i = 0; i < 42; i++) {
      var d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      var k = fmtKey(d);
      var cell = document.createElement("div");
      cell.className = "day-cell";
      cell.dataset.key = k;
      if (d.getMonth() !== viewMonth) cell.classList.add("other-month");
      if (k === todayKey) cell.classList.add("today");
      if (isKeyInRange(k, range)) cell.classList.add("in-range");
      if (k === selectedKey) cell.classList.add("selected");

      var numSpan = document.createElement("span");
      numSpan.textContent = String(d.getDate());
      cell.appendChild(numSpan);

      var dayRecs = state.records[k] || [];
      var hasWork = dayRecs.some(function (r) { return !r.off; });
      var hasOff = dayRecs.some(function (r) { return r.off; });

      if (hasWork) {
        var dot = document.createElement("div");
        dot.className = "day-dot";
        cell.appendChild(dot);
      }
      if (hasOff) {
        var offM = document.createElement("div");
        offM.className = "day-off-mark";
        offM.textContent = "✕";
        cell.appendChild(offM);
      }

      grid.appendChild(cell);
    }

    var selD = parseKey(selectedKey);
    document.getElementById("selectedDateLabel").textContent = selD.getDate() + " " + MONTHS_GEN[selD.getMonth()];
  }

  function renderRecordsAndSummary() {
    var range = getActiveRange();
    var s = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
    var e = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
    if (s > e) { var tmp = s; s = e; e = tmp; }

    var listEl = document.getElementById("recordsList");
    listEl.innerHTML = "";

    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;
    var items = [];

    var cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    while (cur <= e) {
      var k = fmtKey(cur);
      var arr = state.records[k] || [];
      arr.forEach(function (rec, idx) {
        items.push({ key: k, idx: idx, date: new Date(cur), rec: rec });
        if (!rec.off) {
          totalBoxes += Number(rec.boxes) || 0;
          totalKg += Number(rec.kg) || 0;
          totalRub += Number(rec.rub) || 0;
        }
      });
      cur.setDate(cur.getDate() + 1);
    }

    totalKg = Math.round(totalKg * 100) / 100;
    totalRub = Math.round(totalRub * 100) / 100;

    var modeNames = {
      day: "ДЕНЬ",
      week: "НЕДЕЛЮ",
      "2weeks": "2Х НЕДЕЛИ",
      month: "МЕСЯЦ (" + MONTHS_NOM[viewMonth].toUpperCase() + " " + viewYear + ")",
      year: "ГОД (" + viewYear + ")"
    };
    var periodLabel = customRange
      ? (s.getDate() + " " + MONTHS_SHORT[s.getMonth()] + " – " + e.getDate() + " " + MONTHS_SHORT[e.getMonth()])
      : modeNames[mode];

    document.getElementById("recordsTitle").textContent = "ЗАПИСИ (" + periodLabel + ")";
    document.getElementById("sumPeriodLabel").textContent = "ИТОГ ЗА " + periodLabel;
    document.getElementById("sumSubLabel").textContent = totalBoxes + " кор. • " + fmtNum(totalKg) + " кг";
    document.getElementById("sumMoneyLabel").textContent = fmtNum(totalRub) + " ₽";

    items.forEach(function (it) {
      var row = document.createElement("div");
      row.className = "rec-item";
      var dStr = it.date.getDate() + " " + MONTHS_GEN[it.date.getMonth()];
      var txt = document.createElement("span");
      if (it.rec.off) {
        txt.style.color = "var(--danger)";
        txt.textContent = dStr + ": Выходной";
      } else {
        txt.textContent = dStr + ": " + it.rec.boxes + " кор. • " + fmtNum(it.rec.kg) + " кг • " + fmtNum(it.rec.rub) + " ₽";
      }
      var delBtn = document.createElement("button");
      delBtn.className = "rec-del";
      delBtn.textContent = "✕";
      delBtn.onclick = function () {
        trash.push({ key: it.key, rec: it.rec });
        state.records[it.key].splice(it.idx, 1);
        if (state.records[it.key].length === 0) delete state.records[it.key];
        saveAll();
        refreshUI();
      };
      row.appendChild(txt);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });

    var undoBar = document.getElementById("undoBar");
    if (trash.length > 0) {
      undoBar.style.display = "flex";
      document.getElementById("undoBtn").textContent = "↩ Вернуть (" + trash.length + ")";
    } else {
      undoBar.style.display = "none";
    }
  }

  function refreshUI() {
    renderCalendar();
    renderRecordsAndSummary();
    calcShiftPreview();
  }

  function buildReport(isFull) {
    var range = getActiveRange();
    var s = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
    var e = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
    if (s > e) { var t = s; s = e; e = t; }

    var workerName = (state.worker || "").trim();
    var lines = [];
    if (workerName) lines.push(workerName);

    var isSingleDay = (s.getTime() === e.getTime());
    var isManualMulti = (customRange !== null && !isSingleDay);

    var totalBoxes = 0;
    var totalKg = 0;
    var totalRub = 0;
    var dayRows = [];

    var cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    while (cur <= e) {
      var k = fmtKey(cur);
      var arr = state.records[k] || [];
      var dBoxes = 0;
      var dKg = 0;
      var dRub = 0;
      var hasWork = false;
      arr.forEach(function (r) {
        if (!r.off) {
          hasWork = true;
          dBoxes += Number(r.boxes) || 0;
          dKg += Number(r.kg) || 0;
          dRub += Number(r.rub) || 0;
        }
      });
      if (hasWork) {
        dKg = Math.round(dKg * 100) / 100;
        dRub = Math.round(dRub * 100) / 100;
        totalBoxes += dBoxes;
        totalKg += dKg;
        totalRub += dRub;
        var dShort = cur.getDate() + " " + MONTHS_SHORT[cur.getMonth()];
        dayRows.push(dShort + " | " + dBoxes + "кор | " + fmtNum(dKg) + "кг | " + fmtNum(dRub) + "₽");
      }
      cur.setDate(cur.getDate() + 1);
    }

    totalKg = Math.round(totalKg * 100) / 100;
    totalRub = Math.round(totalRub * 100) / 100;

    if (!isFull) {
      if (isManualMulti) {
        lines.push(s.getDate() + " " + MONTHS_SHORT[s.getMonth()] + " – " + e.getDate() + " " + MONTHS_SHORT[e.getMonth()]);
      }
      lines.push("Вес: " + fmtNum(totalKg) + " кг " + totalBoxes + " кор.");
      return lines.join("\n");
    }

    if (isSingleDay) {
      lines.push(s.getDate() + " " + MONTHS_SHORT[s.getMonth()]);
    } else {
      lines.push(s.getDate() + " " + MONTHS_SHORT[s.getMonth()] + " – " + e.getDate() + " " + MONTHS_SHORT[e.getMonth()]);
    }
    dayRows.forEach(function (r) { lines.push(r); });
    lines.push("ИТОГ: " + totalBoxes + "кор | " + fmtNum(totalKg) + "кг | " + fmtNum(totalRub) + "₽");
    return lines.join("\n");
  }

  function copyToClipboard(text) {
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

  function triggerSystemShare(text) {
    copyToClipboard(text);
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () {});
      return;
    }
    var encoded = encodeURIComponent(text);
    var isAndroid = /Android/i.test(navigator.userAgent || "");
    if (isAndroid) {
      try {
        window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encoded + ";end";
        return;
      } catch (e) {}
    }
    showToast("Текст скопирован — вставьте в любой мессенджер");
  }

  function askConfirm(text, onYes) {
    var modal = document.getElementById("confirmModal");
    document.getElementById("confirmText").textContent = text;
    modal.style.display = "flex";
    var yesBtn = document.getElementById("confirmYesBtn");
    var noBtn = document.getElementById("confirmNoBtn");
    yesBtn.onclick = function () {
      modal.style.display = "none";
      onYes();
    };
    noBtn.onclick = function () {
      modal.style.display = "none";
    };
  }

  function renderBackupsList() {
    var box = document.getElementById("backupList");
    box.innerHTML = "";
    if (backups.length === 0) {
      box.innerHTML = "<div style='color:var(--text-muted);font-size:13px;text-align:center;padding:12px;'>Сохранённых копий пока нет</div>";
      return;
    }
    backups.forEach(function (bk, idx) {
      var row = document.createElement("div");
      row.className = "bk-item";
      var info = document.createElement("span");
      var cnt = (typeof bk.count === "number") ? bk.count : countItems(bk.data && bk.data.records);
      info.textContent = (bk.label || "Копия") + " • " + cnt + " зап.";
      var btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "5px";

      var restBtn = document.createElement("button");
      restBtn.className = "m-btn green";
      restBtn.style.padding = "5px 8px";
      restBtn.style.fontSize = "11px";
      restBtn.textContent = "Восстановить";
      restBtn.onclick = function () {
        if (bk.data) {
          state.records = bk.data.records || {};
          state.worker = bk.data.worker || "";
          state.rate = bk.data.rate || "";
          document.getElementById("workerInput").value = state.worker;
          document.getElementById("rateInput").value = state.rate;
          saveAll();
          refreshUI();
          document.getElementById("restoreModal").style.display = "none";
          showToast("База восстановлена");
        }
      };

      var delBtn = document.createElement("button");
      delBtn.className = "m-btn red";
      delBtn.style.padding = "5px 8px";
      delBtn.style.fontSize = "11px";
      delBtn.textContent = "✕";
      delBtn.onclick = function () {
        askConfirm("Удалить эту сохранённую базу? Вы уверены?", function () {
          backups.splice(idx, 1);
          saveAll();
          renderBackupsList();
          showToast("Копия удалена");
        });
      };

      btns.appendChild(restBtn);
      btns.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(btns);
      box.appendChild(row);
    });
  }

  function runStepByStepUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: загрузите на GitHub для проверки обновлений");
      return;
    }
    showToast("Шаг 1/4: Сохранение базы в память...", 2000);
    createBackup("перед обн.").then(function () {
      return new Promise(function (r) { setTimeout(r, 800); });
    }).then(function () {
      showToast("Шаг 2/4: Проверка целостности данных...", 2000);
      return saveAll();
    }).then(function () {
      return new Promise(function (r) { setTimeout(r, 800); });
    }).then(function () {
      showToast("Шаг 3/4: Очистка старого кэша...", 2000);
      var tasks = [];
      if ("caches" in window) {
        tasks.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
      if ("serviceWorker" in navigator) {
        tasks.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
        }));
      }
      return Promise.all(tasks);
    }).then(function () {
      return new Promise(function (r) { setTimeout(r, 800); });
    }).then(function () {
      return fetch("app.js?nocache=" + Date.now(), { cache: "no-store" })
        .then(function (resp) { return resp.text(); })
        .then(function (txt) {
          var m = txt.match(/APP_VERSION\s*=\s*"([^"]+)"/);
          var remoteVer = m ? m[1] : APP_VERSION;
          if (remoteVer === APP_VERSION) {
            showToast("У вас актуальная версия v " + APP_VERSION, 2600);
          } else {
            showToast("Шаг 4/4: Загрузка v " + remoteVer + "...", 2000);
            setTimeout(function () {
              var cleanUrl = window.location.origin + window.location.pathname + "?v=" + Date.now();
              window.location.replace(cleanUrl);
            }, 800);
          }
        })
        .catch(function () {
          showToast("Нет интернета для проверки обновлений", 2500);
        });
    });
  }

  function bindEvents() {
    document.getElementById("prevMonthBtn").onclick = function () {
      customRange = null;
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (mode === "month" || mode === "year") {
        selectedKey = fmtKey(new Date(viewYear, viewMonth, 1));
      }
      refreshUI();
    };

    document.getElementById("nextMonthBtn").onclick = function () {
      customRange = null;
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      if (mode === "month" || mode === "year") {
        selectedKey = fmtKey(new Date(viewYear, viewMonth, 1));
      }
      refreshUI();
    };

    document.getElementById("themeBtn").onclick = function () {
      state.theme = (state.theme === "dark") ? "light" : "dark";
      document.body.classList.toggle("light", state.theme === "light");
      document.getElementById("themeBtn").textContent = (state.theme === "light") ? "🌙" : "☀️";
      saveAll();
    };

    document.getElementById("updBtn").onclick = runStepByStepUpdate;

    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        mode = btn.dataset.mode;
        customRange = null;
        refreshUI();
      };
    });

    var grid = document.getElementById("daysGrid");
    grid.addEventListener("pointerdown", function (e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      isDragging = true;
      dragStartKey = cell.dataset.key;
      selectedKey = dragStartKey;
      customRange = null;
      var d = parseKey(selectedKey);
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
      refreshUI();
    });

    grid.addEventListener("pointermove", function (e) {
      if (!isDragging) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el && el.closest(".day-cell");
      if (!cell) return;
      var k = cell.dataset.key;
      if (k && k !== dragStartKey) {
        customRange = { start: parseKey(dragStartKey), end: parseKey(k) };
        selectedKey = k;
        refreshUI();
      }
    });

    window.addEventListener("pointerup", function () {
      isDragging = false;
    });

    document.getElementById("dayOffBtn").onclick = function () {
      if (!state.records[selectedKey]) state.records[selectedKey] = [];
      var alreadyOff = state.records[selectedKey].some(function (r) { return r.off; });
      if (alreadyOff) {
        showToast("Этот день уже отмечен как выходной");
        return;
      }
      state.records[selectedKey].push({ off: true });
      var todayStr = fmtKey(new Date());
      if (state.lastAutoBackupDate !== todayStr) {
        state.lastAutoBackupDate = todayStr;
        createBackup("авто");
      } else {
        saveAll();
      }
      refreshUI();
      showToast("Выходной добавлен");
    };

    document.getElementById("workerInput").addEventListener("input", function (e) {
      state.worker = e.target.value;
      saveAll();
    });

    document.getElementById("boxesInput").addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(/[^0-9]/g, "");
      calcShiftPreview();
    });

    document.getElementById("weightInput").addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(",", ".").replace(/[^0-9.]/g, "");
      calcShiftPreview();
    });

    document.getElementById("rateInput").addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(",", ".").replace(/[^0-9.]/g, "");
      state.rate = e.target.value;
      saveAll();
      calcShiftPreview();
    });

    document.getElementById("addRecordBtn").onclick = function () {
      var calc = calcShiftPreview();
      if (calc.totalKg <= 0) {
        showToast("Введите вес коробки или количество коробок");
        return;
      }
      if (!state.records[selectedKey]) state.records[selectedKey] = [];
      state.records[selectedKey].push({
        off: false,
        boxes: calc.boxes,
        boxWeight: calc.boxWeight,
        kg: calc.totalKg,
        rate: calc.rate,
        rub: calc.rub
      });
      document.getElementById("boxesInput").value = "";
      document.getElementById("weightInput").value = "";

      var todayStr = fmtKey(new Date());
      if (state.lastAutoBackupDate !== todayStr) {
        state.lastAutoBackupDate = todayStr;
        createBackup("авто");
      } else {
        saveAll();
      }
      refreshUI();
      showToast("Смена добавлена: " + fmtNum(calc.totalKg) + " кг");
    };

    document.getElementById("undoBtn").onclick = function () {
      if (trash.length === 0) return;
      var last = trash.pop();
      if (!state.records[last.key]) state.records[last.key] = [];
      state.records[last.key].push(last.rec);
      saveAll();
      refreshUI();
    };

    document.getElementById("clearTrashBtn").onclick = function () {
      askConfirm("Очистить все удалённые записи безвозвратно?", function () {
        trash = [];
        refreshUI();
      });
    };

    document.getElementById("fullReportBtn").onclick = function () {
      document.getElementById("reportModalTitle").textContent = "Полный отчёт";
      document.getElementById("reportTextArea").value = buildReport(true);
      document.getElementById("reportModal").style.display = "flex";
    };

    document.getElementById("shortReportBtn").onclick = function () {
      document.getElementById("reportModalTitle").textContent = "Краткий отчёт";
      document.getElementById("reportTextArea").value = buildReport(false);
      document.getElementById("reportModal").style.display = "flex";
    };

    document.getElementById("closeReportBtn").onclick = function () {
      document.getElementById("reportModal").style.display = "none";
    };

    document.getElementById("copyReportBtn").onclick = function () {
      var txt = document.getElementById("reportTextArea").value;
      copyToClipboard(txt);
      showToast("Отчёт скопирован");
    };

    document.getElementById("sendReportBtn").onclick = function () {
      var txt = document.getElementById("reportTextArea").value;
      document.getElementById("reportModal").style.display = "none";
      triggerSystemShare(txt);
    };

    document.getElementById("saveDbBtn").onclick = function () {
      createBackup("вручную").then(function () {
        showToast("Копия базы сохранена в телефон");
      });
    };

    document.getElementById("openRestoreBtn").onclick = function () {
      renderBackupsList();
      document.getElementById("restoreModal").style.display = "flex";
    };

    document.getElementById("closeRestoreBtn").onclick = function () {
      document.getElementById("restoreModal").style.display = "none";
    };

    document.getElementById("transferCodeBtn").onclick = function () {
      document.getElementById("transferArea").value = JSON.stringify(state);
      document.getElementById("transferModal").style.display = "flex";
    };

    document.getElementById("closeTransferBtn").onclick = function () {
      document.getElementById("transferModal").style.display = "none";
    };

    document.getElementById("copyCodeBtn").onclick = function () {
      copyToClipboard(document.getElementById("transferArea").value);
      showToast("Код базы скопирован");
    };

    document.getElementById("importCodeBtn").onclick = function () {
      try {
        var obj = JSON.parse(document.getElementById("transferArea").value.trim());
        if (!obj || typeof obj.records !== "object") throw new Error("bad");
        state.records = obj.records || {};
        state.worker = obj.worker || "";
        state.rate = obj.rate || "";
        document.getElementById("workerInput").value = state.worker;
        document.getElementById("rateInput").value = state.rate;
        saveAll();
        refreshUI();
        document.getElementById("transferModal").style.display = "none";
        document.getElementById("restoreModal").style.display = "none";
        showToast("База успешно загружена по коду");
      } catch (e) {
        showToast("Неверный формат кода базы");
      }
    };
  }

  function init() {
    bindEvents();
    loadAll().then(function () {
      document.body.classList.toggle("light", state.theme === "light");
      document.getElementById("themeBtn").textContent = (state.theme === "light") ? "🌙" : "☀️";
      document.getElementById("workerInput").value = state.worker;
      document.getElementById("rateInput").value = state.rate;
      refreshUI();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
