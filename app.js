(function() {
  const APP_VERSION = "7.9";
  const STORAGE_KEY = "obvalka_pro_data_v1";
  const BACKUPS_KEY = "obvalka_pro_backups_v1";
  const DB_NAME = "ObvalkaProDB";
  const DB_STORE = "kv_store";
  const NL = String.fromCharCode(10);

  let state = {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    mode: "day",
    selectedDays: [],
    workerName: "",
    defaultRate: 9.5,
    theme: "dark",
    records: {},
    undoStack: []
  };

  let backups = [];
  let pendingDeleteBackupId = null;
  let currentReportText = "";
  let isDragging = false;
  let dragStartKey = null;

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function makeDateKey(y, m, d) {
    return y + "-" + pad(m + 1) + "-" + pad(d);
  }

  function parseDateKey(key) {
    const p = key.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function cleanNum(val) {
    if (val === null || val === undefined) return 0;
    const s = String(val).replace(",", ".").trim();
    let res = "";
    let hasDot = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch >= "0" && ch <= "9") {
        res += ch;
      } else if (ch === "." && !hasDot) {
        res += ch;
        hasDot = true;
      } else if (ch === "-" && res.length === 0) {
        res += ch;
      }
    }
    const n = parseFloat(res);
    return isNaN(n) ? 0 : n;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function round1(n) {
    return Math.round((n + Number.EPSILON) * 10) / 10;
  }

  function formatMoney(n) {
    const r = round2(n);
    return Number.isInteger(r) ? String(r) : r.toFixed(2);
  }

  function formatWeight(n) {
    const r = round1(n);
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }

  function normalizeRecord(rec, fallbackRate) {
    if (!rec || typeof rec !== "object") return null;
    const isOff = Boolean(rec.isOff || rec.off || rec.dayOff);
    if (isOff) {
      return {
        id: rec.id || ("rec_" + Math.random().toString(36).slice(2, 9)),
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      };
    }
    const boxes = Math.round(cleanNum(rec.boxes !== undefined ? rec.boxes : rec.b));
    const boxWeight = cleanNum(rec.boxWeight !== undefined ? rec.boxWeight : rec.bw);
    let weight = cleanNum(
      rec.weight !== undefined ? rec.weight :
      (rec.totalWeight !== undefined ? rec.totalWeight : rec.w)
    );
    if (weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round1(boxes * boxWeight);
    }
    let rate = cleanNum(rec.rate !== undefined ? rec.rate : rec.r);
    if (rate <= 0) {
      rate = fallbackRate > 0 ? fallbackRate : 9.5;
    }
    let pay = cleanNum(
      rec.pay !== undefined ? rec.pay :
      (rec.totalPay !== undefined ? rec.totalPay : rec.sum)
    );
    if (pay <= 0 && weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    } else if (weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    }
    if (boxes === 0 && weight === 0 && pay === 0) {
      return {
        id: rec.id || ("rec_" + Math.random().toString(36).slice(2, 9)),
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      };
    }
    return {
      id: rec.id || ("rec_" + Math.random().toString(36).slice(2, 9)),
      isOff: false,
      boxes: boxes,
      boxWeight: boxWeight,
      weight: round1(weight),
      rate: rate,
      pay: round2(pay)
    };
  }

  function normalizeRecordsMap(rawRecords, fallbackRate) {
    const out = {};
    if (!rawRecords || typeof rawRecords !== "object") return out;
    const keys = Object.keys(rawRecords);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const arr = rawRecords[k];
      if (!Array.isArray(arr)) continue;
      const cleanArr = [];
      for (let j = 0; j < arr.length; j++) {
        const nr = normalizeRecord(arr[j], fallbackRate);
        if (nr) cleanArr.push(nr);
      }
      if (cleanArr.length > 0) {
        out[k] = cleanArr;
      }
    }
    return out;
  }

  function countRecords(recordsObj) {
    if (!recordsObj || typeof recordsObj !== "object") return 0;
    let total = 0;
    const keys = Object.keys(recordsObj);
    for (let i = 0; i < keys.length; i++) {
      if (Array.isArray(recordsObj[keys[i]])) {
        total += recordsObj[keys[i]].length;
      }
    }
    return total;
  }

  function openIDB() {
    return new Promise(function(resolve) {
      try {
        if (!window.indexedDB) {
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };
        req.onsuccess = function(e) {
          resolve(e.target.result);
        };
        req.onerror = function() {
          resolve(null);
        };
      } catch (err) {
        resolve(null);
      }
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function(db) {
      return new Promise(function(resolve) {
        if (!db) {
          resolve(false);
          return;
        }
        try {
          const tx = db.transaction(DB_STORE, "readwrite");
          const store = tx.objectStore(DB_STORE);
          store.put(val, key);
          tx.oncomplete = function() {
            resolve(true);
          };
          tx.onerror = function() {
            resolve(false);
          };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function idbGet(key) {
    return openIDB().then(function(db) {
      return new Promise(function(resolve) {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(DB_STORE, "readonly");
          const store = tx.objectStore(DB_STORE);
          const req = store.get(key);
          req.onsuccess = function() {
            resolve(req.result || null);
          };
          req.onerror = function() {
            resolve(null);
          };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function getSnapshot() {
    return {
      workerName: state.workerName || "",
      defaultRate: state.defaultRate || 9.5,
      theme: state.theme || "dark",
      records: state.records || {},
      backups: backups || [],
      ts: Date.now()
    };
  }

  function persistAll() {
    const snap = getSnapshot();
    const json = JSON.stringify(snap);
    try {
      localStorage.setItem(STORAGE_KEY, json);
      localStorage.setItem(BACKUPS_KEY, JSON.stringify(backups));
    } catch (e) {}
    try {
      window.name = "OBVALKA_PRO:" + json;
    } catch (e) {}
    return idbSet(STORAGE_KEY, snap);
  }

  function loadAllSources() {
    let lsSnap = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsSnap = JSON.parse(raw);
    } catch (e) {}

    let wnSnap = null;
    try {
      if (window.name && window.name.indexOf("OBVALKA_PRO:") === 0) {
        wnSnap = JSON.parse(window.name.slice("OBVALKA_PRO:".length));
      }
    } catch (e) {}

    return idbGet(STORAGE_KEY).then(function(idbSnap) {
      const candidates = [lsSnap, wnSnap, idbSnap].filter(function(x) {
        return x && typeof x === "object";
      });
      if (candidates.length === 0) return null;
      candidates.sort(function(a, b) {
        const ca = countRecords(a.records);
        const cb = countRecords(b.records);
        if (cb !== ca) return cb - ca;
        return (b.ts || 0) - (a.ts || 0);
      });
      return candidates[0];
    });
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    if (snap.workerName) state.workerName = String(snap.workerName);
    const rate = cleanNum(snap.defaultRate);
    if (rate > 0) state.defaultRate = rate;
    if (snap.theme === "light" || snap.theme === "dark") state.theme = snap.theme;
    state.records = normalizeRecordsMap(snap.records, state.defaultRate);
    if (Array.isArray(snap.backups)) {
      backups = snap.backups;
    }
  }

  function createBackup(tag) {
    const now = new Date();
    const dateStr = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear() +
      " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    const cnt = countRecords(state.records);
    const item = {
      id: "bk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      label: dateStr + (tag ? " (" + tag + ")" : ""),
      count: cnt,
      ts: Date.now(),
      data: {
        workerName: state.workerName,
        defaultRate: state.defaultRate,
        records: JSON.parse(JSON.stringify(state.records))
      }
    };
    backups.unshift(item);
    if (backups.length > 25) backups = backups.slice(0, 25);
    return persistAll();
  }

  function ensureDailyAutoBackup() {
    const now = new Date();
    const todayPrefix = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear();
    const exists = backups.some(function(b) {
      return b.label && b.label.indexOf(todayPrefix) === 0 && b.label.indexOf("авто") !== -1;
    });
    if (!exists) {
      createBackup("авто");
    }
  }

  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(function() {
      el.classList.remove("show");
    }, 2600);
  }

  const MONTHS_NOM = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
  ];
  const MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];
  const MONTHS_SHORT = [
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"
  ];

  function getActiveDateKeys() {
    if (state.mode === "month") {
      const daysInM = new Date(state.year, state.month + 1, 0).getDate();
      const arr = [];
      for (let d = 1; d <= daysInM; d++) {
        arr.push(makeDateKey(state.year, state.month, d));
      }
      return arr;
    }
    if (state.mode === "year") {
      const arr = [];
      for (let m = 0; m < 12; m++) {
        const daysInM = new Date(state.year, m + 1, 0).getDate();
        for (let d = 1; d <= daysInM; d++) {
          arr.push(makeDateKey(state.year, m, d));
        }
      }
      return arr;
    }
    return state.selectedDays.slice().sort();
  }

  function selectPeriodByMode(anchorKey) {
    const dt = parseDateKey(anchorKey);
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const d = dt.getDate();

    if (state.mode === "day") {
      state.selectedDays = [anchorKey];
      return;
    }
    if (state.mode === "week") {
      const dow = (dt.getDay() + 6) % 7;
      const mon = new Date(y, m, d - dow);
      const arr = [];
      for (let i = 0; i < 7; i++) {
        const cur = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
        arr.push(makeDateKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
      }
      state.selectedDays = arr;
      return;
    }
    if (state.mode === "biweek") {
      const daysInM = new Date(y, m + 1, 0).getDate();
      const startD = d <= 15 ? 1 : 16;
      const endD = d <= 15 ? 15 : daysInM;
      const arr = [];
      for (let i = startD; i <= endD; i++) {
        arr.push(makeDateKey(y, m, i));
      }
      state.selectedDays = arr;
      return;
    }
    if (state.mode === "month" || state.mode === "year") {
      state.selectedDays = [anchorKey];
    }
  }

  function selectRange(keyA, keyB) {
    const d1 = parseDateKey(keyA);
    const d2 = parseDateKey(keyB);
    const start = d1 <= d2 ? d1 : d2;
    const end = d1 <= d2 ? d2 : d1;
    const arr = [];
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cur <= end) {
      arr.push(makeDateKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
      cur.setDate(cur.getDate() + 1);
    }
    state.selectedDays = arr;
  }

  function renderCalendar() {
    const titleEl = document.getElementById("monthTitle");
    const verEl = document.getElementById("verTag");
    const grid = document.getElementById("calendarGrid");
    if (!grid) return;

    if (titleEl) {
      titleEl.textContent = MONTHS_NOM[state.month] + " " + state.year;
    }
    if (verEl) {
      verEl.textContent = "v" + APP_VERSION;
    }

    const firstDay = new Date(state.year, state.month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
    const prevMonthDays = new Date(state.year, state.month, 0).getDate();

    const selectedSet = {};
    for (let i = 0; i < state.selectedDays.length; i++) {
      selectedSet[state.selectedDays[i]] = true;
    }

    const today = new Date();
    const todayKey = makeDateKey(today.getFullYear(), today.getMonth(), today.getDate());

    grid.innerHTML = "";
    const totalCells = 42;

    for (let idx = 0; idx < totalCells; idx++) {
      const cell = document.createElement("div");
      cell.className = "day-cell";

      let cellY = state.year;
      let cellM = state.month;
      let cellD = 1;
      let isOther = false;

      if (idx < startOffset) {
        isOther = true;
        cellD = prevMonthDays - startOffset + idx + 1;
        cellM = state.month - 1;
        if (cellM < 0) {
          cellM = 11;
          cellY--;
        }
      } else if (idx >= startOffset + daysInMonth) {
        isOther = true;
        cellD = idx - (startOffset + daysInMonth) + 1;
        cellM = state.month + 1;
        if (cellM > 11) {
          cellM = 0;
          cellY++;
        }
      } else {
        cellD = idx - startOffset + 1;
      }

      const key = makeDateKey(cellY, cellM, cellD);
      cell.dataset.key = key;
      cell.textContent = String(cellD);

      if (isOther) {
        cell.classList.add("other-month");
      }
      if (key === todayKey) {
        cell.classList.add("today");
      }

      const recs = state.records[key];
      if (Array.isArray(recs) && recs.length > 0) {
        const hasOff = recs.some(function(r) { return r.isOff; });
        const hasWork = recs.some(function(r) { return !r.isOff; });
        if (hasOff && !hasWork) {
          cell.classList.add("day-off");
        } else if (hasWork) {
          cell.classList.add("has-data");
        }
      }

      if ((state.mode === "month" || state.mode === "year") && !isOther) {
        if (selectedSet[key]) {
          cell.classList.add("selected");
        } else {
          cell.classList.add("period-highlight");
        }
      } else if (selectedSet[key]) {
        cell.classList.add("selected");
      }

      grid.appendChild(cell);
    }
  }

  function updateShiftPreview() {
    const boxesEl = document.getElementById("inpBoxes");
    const weightEl = document.getElementById("inpBoxWeight");
    const rateEl = document.getElementById("inpRate");
    const prevEl = document.getElementById("shiftPreview");
    if (!boxesEl || !weightEl || !rateEl || !prevEl) return;

    const boxes = Math.round(cleanNum(boxesEl.value));
    const bw = cleanNum(weightEl.value);
    const rate = cleanNum(rateEl.value);

    let totalW = 0;
    if (boxes > 0 && bw > 0) {
      totalW = round1(boxes * bw);
    } else if (bw > 0) {
      totalW = round1(bw);
    }
    const totalPay = round2(totalW * rate);
    prevEl.innerHTML = '<span class="w-val">' + formatWeight(totalW) + ' кг</span> ' +
      '<span class="p-val">' + formatMoney(totalPay) + ' ₽</span>';
  }

  function renderRecordsAndTotals() {
    const keys = getActiveDateKeys();
    const headerTitle = document.getElementById("recordsHeaderTitle");
    const headerCount = document.getElementById("recordsHeaderCount");
    const periodLabel = document.getElementById("periodSummaryLabel");
    const periodStats = document.getElementById("periodSummaryStats");
    const periodPay = document.getElementById("periodSummaryPay");
    const listEl = document.getElementById("recordsList");
    const selDateEl = document.getElementById("selectedDateLabel");
    const undoBtn = document.getElementById("btnUndo");
    const undoCnt = document.getElementById("undoCount");

    if (undoBtn && undoCnt) {
      if (state.undoStack.length > 0) {
        undoBtn.style.display = "inline-flex";
        undoCnt.textContent = String(state.undoStack.length);
      } else {
        undoBtn.style.display = "none";
      }
    }

    const primaryKey = state.selectedDays[0] || makeDateKey(state.year, state.month, 1);
    const pDate = parseDateKey(primaryKey);
    if (selDateEl) {
      selDateEl.textContent = pDate.getDate() + " " + MONTHS_GEN[pDate.getMonth()];
    }

    let labelShort = "";
    if (state.mode === "month") {
      labelShort = MONTHS_NOM[state.month].toUpperCase();
    } else if (state.mode === "year") {
      labelShort = state.year + " ГОД";
    } else if (keys.length === 1) {
      const d = parseDateKey(keys[0]);
      labelShort = d.getDate() + " " + MONTHS_SHORT[d.getMonth()].toUpperCase();
    } else if (keys.length > 1) {
      const d1 = parseDateKey(keys[0]);
      const d2 = parseDateKey(keys[keys.length - 1]);
      labelShort = d1.getDate() + " " + MONTHS_SHORT[d1.getMonth()].toUpperCase() +
        " – " + d2.getDate() + " " + MONTHS_SHORT[d2.getMonth()].toUpperCase();
    }

    if (headerTitle) {
      headerTitle.textContent = "ЗАПИСИ (" + labelShort + ")";
    }
    if (periodLabel) {
      periodLabel.textContent = "ИТОГ ЗА ПЕРИОД (" + labelShort + ")";
    }

    let sumBoxes = 0;
    let sumWeight = 0;
    let sumPay = 0;
    let itemsCount = 0;

    if (listEl) listEl.innerHTML = "";

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const arr = state.records[k];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const dt = parseDateKey(k);
      const dLabel = dt.getDate() + " " + MONTHS_SHORT[dt.getMonth()];

      for (let j = 0; j < arr.length; j++) {
        const rec = arr[j];
        itemsCount++;
        if (!rec.isOff) {
          sumBoxes += rec.boxes || 0;
          sumWeight = round1(sumWeight + (rec.weight || 0));
          sumPay = round2(sumPay + (rec.pay || 0));
        }

        if (listEl) {
          const row = document.createElement("div");
          row.className = "record-item" + (rec.isOff ? " is-off" : "");
          const info = document.createElement("div");
          info.className = "rec-text";
          if (rec.isOff) {
            info.textContent = dLabel + ": Выходной";
          } else {
            const boxPart = rec.boxes > 0 ? (rec.boxes + " кор. • ") : "";
            info.textContent = dLabel + ": " + boxPart + formatWeight(rec.weight) +
              " кг × " + rec.rate + " ₽ = " + formatMoney(rec.pay) + " ₽";
          }
          const delBtn = document.createElement("button");
          delBtn.className = "rec-del";
          delBtn.type = "button";
          delBtn.textContent = "✕";
          delBtn.onclick = (function(dateKey, recIndex) {
            return function() {
              deleteRecord(dateKey, recIndex);
            };
          })(k, j);

          row.appendChild(info);
          row.appendChild(delBtn);
          listEl.appendChild(row);
        }
      }
    }

    if (headerCount) {
      headerCount.textContent = itemsCount + " ШТ.";
    }
    if (periodStats) {
      periodStats.textContent = sumBoxes + " кор. • " + formatWeight(sumWeight) + " кг";
    }
    if (periodPay) {
      periodPay.textContent = formatMoney(sumPay) + " ₽";
    }
  }

  function deleteRecord(dateKey, idx) {
    const arr = state.records[dateKey];
    if (!Array.isArray(arr) || !arr[idx]) return;
    const removed = arr.splice(idx, 1)[0];
    if (arr.length === 0) {
      delete state.records[dateKey];
    }
    state.undoStack.push({ dateKey: dateKey, record: removed });
    persistAll();
    renderCalendar();
    renderRecordsAndTotals();
    showToast("Запись удалена");
  }

  function undoLastDelete() {
    if (state.undoStack.length === 0) return;
    const item = state.undoStack.pop();
    if (!state.records[item.dateKey]) {
      state.records[item.dateKey] = [];
    }
    state.records[item.dateKey].push(item.record);
    persistAll();
    renderCalendar();
    renderRecordsAndTotals();
    showToast("Запись восстановлена");
  }

  function addWorkRecord() {
    const boxesEl = document.getElementById("inpBoxes");
    const weightEl = document.getElementById("inpBoxWeight");
    const rateEl = document.getElementById("inpRate");
    const nameEl = document.getElementById("inpWorkerName");

    if (nameEl) {
      state.workerName = nameEl.value.trim();
    }

    const boxes = Math.round(cleanNum(boxesEl ? boxesEl.value : 0));
    const bw = cleanNum(weightEl ? weightEl.value : 0);
    let rate = cleanNum(rateEl ? rateEl.value : 0);

    if (rate > 0) {
      state.defaultRate = rate;
    } else {
      rate = state.defaultRate || 9.5;
    }

    let totalW = 0;
    if (boxes > 0 && bw > 0) {
      totalW = round1(boxes * bw);
    } else if (bw > 0) {
      totalW = round1(bw);
    }

    if (totalW <= 0) {
      showToast("Введите вес коробки (кг)");
      return;
    }

    const totalPay = round2(totalW * rate);
    const targetKey = state.selectedDays[0] || makeDateKey(state.year, state.month, 1);

    if (!state.records[targetKey]) {
      state.records[targetKey] = [];
    }
    state.records[targetKey] = state.records[targetKey].filter(function(r) { return !r.isOff; });
    state.records[targetKey].push({
      id: "rec_" + Date.now(),
      isOff: false,
      boxes: boxes,
      boxWeight: bw,
      weight: totalW,
      rate: rate,
      pay: totalPay
    });

    if (boxesEl) boxesEl.value = "";
    if (weightEl) weightEl.value = "";
    updateShiftPreview();
    ensureDailyAutoBackup();
    persistAll();
    renderCalendar();
    renderRecordsAndTotals();
    showToast("Смена добавлена");
  }

  function toggleDayOff() {
    const targetKey = state.selectedDays[0] || makeDateKey(state.year, state.month, 1);
    const arr = state.records[targetKey] || [];
    const hasOff = arr.some(function(r) { return r.isOff; });

    if (hasOff) {
      state.records[targetKey] = arr.filter(function(r) { return !r.isOff; });
      if (state.records[targetKey].length === 0) {
        delete state.records[targetKey];
      }
      showToast("Выходной снят");
    } else {
      state.records[targetKey] = [{
        id: "off_" + Date.now(),
        isOff: true,
        boxes: 0,
        boxWeight: 0,
        weight: 0,
        rate: 0,
        pay: 0
      }];
      showToast("Отмечен выходной");
    }

    ensureDailyAutoBackup();
    persistAll();
    renderCalendar();
    renderRecordsAndTotals();
  }

  function buildReport(isShort) {
    const keys = getActiveDateKeys();
    const lines = [];
    const name = (state.workerName || "").trim();

    let sumBoxes = 0;
    let sumWeight = 0;
    let sumPay = 0;
    const dayLines = [];

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const arr = state.records[k];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const dt = parseDateKey(k);
      const dShort = dt.getDate() + " " + MONTHS_SHORT[dt.getMonth()];

      for (let j = 0; j < arr.length; j++) {
        const rec = arr[j];
        if (rec.isOff) {
          dayLines.push(dShort + " | Выходной");
        } else {
          sumBoxes += rec.boxes || 0;
          sumWeight = round1(sumWeight + (rec.weight || 0));
          sumPay = round2(sumPay + (rec.pay || 0));
          dayLines.push(
            dShort + " | " + (rec.boxes || 0) + "кор | " +
            formatWeight(rec.weight) + "кг | " + formatMoney(rec.pay) + "₽"
          );
        }
      }
    }

    let periodStr = "";
    if (keys.length === 1) {
      const d = parseDateKey(keys[0]);
      periodStr = d.getDate() + " " + MONTHS_GEN[d.getMonth()];
    } else if (keys.length > 1) {
      const d1 = parseDateKey(keys[0]);
      const d2 = parseDateKey(keys[keys.length - 1]);
      periodStr = d1.getDate() + " " + MONTHS_SHORT[d1.getMonth()] +
        " – " + d2.getDate() + " " + MONTHS_SHORT[d2.getMonth()];
    }

    if (isShort) {
      if (name) lines.push(name);
      const isCustomRange = state.mode === "day" && keys.length > 1;
      if (isCustomRange && periodStr) {
        lines.push(periodStr);
      }
      lines.push("Вес: " + formatWeight(sumWeight) + " кг " + sumBoxes + " кор.");
      return lines.join(NL);
    }

    if (name) lines.push(name);
    if (periodStr) lines.push("Период: " + periodStr);
    for (let i = 0; i < dayLines.length; i++) {
      lines.push(dayLines[i]);
    }
    lines.push("ИТОГ: " + sumBoxes + "кор | " + formatWeight(sumWeight) + "кг | " + formatMoney(sumPay) + "₽");
    return lines.join(NL);
  }

  function openReportPreview(isShort) {
    currentReportText = buildReport(isShort);
    const box = document.getElementById("reportPreviewText");
    const modal = document.getElementById("reportModal");
    if (box) box.textContent = currentReportText;
    if (modal) modal.classList.add("open");
  }

  function sendCurrentReport() {
    const text = currentReportText;
    const modal = document.getElementById("reportModal");
    if (modal) modal.classList.remove("open");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() {});
    }

    if (navigator.share) {
      navigator.share({ text: text }).catch(function() {
        openAndroidIntentShare(text);
      });
    } else {
      openAndroidIntentShare(text);
    }
  }

  function openAndroidIntentShare(text) {
    try {
      const encoded = encodeURIComponent(text);
      const intentUrl = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encoded + ";end";
      window.location.href = intentUrl;
    } catch (e) {}
  }

  function renderBackupsList() {
    const listEl = document.getElementById("backupsList");
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!backups || backups.length === 0) {
      listEl.innerHTML = '<div class="empty-msg">Сохранённых копий пока нет</div>';
      return;
    }

    for (let i = 0; i < backups.length; i++) {
      const bk = backups[i];
      const cnt = bk.count !== undefined ? bk.count : countRecords(bk.data && bk.data.records);
      const row = document.createElement("div");
      row.className = "backup-row";

      const info = document.createElement("div");
      info.className = "backup-info";
      info.innerHTML = '<div class="bk-title">' + (bk.label || "Копия базы") + '</div>' +
        '<div class="bk-sub">Записей: ' + cnt + '</div>';

      const actions = document.createElement("div");
      actions.className = "backup-actions";

      const btnRest = document.createElement("button");
      btnRest.type = "button";
      btnRest.className = "btn-bk-restore";
      btnRest.textContent = "Восстановить";
      btnRest.onclick = (function(item) {
        return function() {
          if (item && item.data) {
            applySnapshot(item.data);
            const nameEl = document.getElementById("inpWorkerName");
            const rateEl = document.getElementById("inpRate");
            if (nameEl) nameEl.value = state.workerName;
            if (rateEl) rateEl.value = state.defaultRate;
            persistAll();
            renderCalendar();
            renderRecordsAndTotals();
            document.getElementById("restoreModal").classList.remove("open");
            showToast("База восстановлена (" + countRecords(state.records) + ")");
          }
        };
      })(bk);

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn-bk-del";
      btnDel.textContent = "✕";
      btnDel.onclick = (function(bkId) {
        return function() {
          pendingDeleteBackupId = bkId;
          document.getElementById("confirmDelBackupModal").classList.add("open");
        };
      })(bk.id);

      actions.appendChild(btnRest);
      actions.appendChild(btnDel);
      row.appendChild(info);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  function runAppUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: для обновления откройте через GitHub");
      return;
    }

    const overlay = document.getElementById("updateOverlay");
    const stepText = document.getElementById("updateStepText");
    if (overlay) overlay.classList.add("open");

    function setStep(t) {
      if (stepText) stepText.textContent = t;
    }

    setStep("Шаг 1/4: Сохранение базы в память...");
    createBackup("перед обн.").then(function() {
      return new Promise(function(r) { setTimeout(r, 800); });
    }).then(function() {
      setStep("Шаг 2/4: Проверка целостности данных...");
      return persistAll();
    }).then(function() {
      return new Promise(function(r) { setTimeout(r, 800); });
    }).then(function() {
      setStep("Шаг 3/4: Очистка старого кэша...");
      const tasks = [];
      if (window.caches && caches.keys) {
        tasks.push(caches.keys().then(function(names) {
          return Promise.all(names.map(function(n) { return caches.delete(n); }));
        }));
      }
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        tasks.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
          return Promise.all(regs.map(function(r) { return r.unregister(); }));
        }));
      }
      return Promise.all(tasks);
    }).then(function() {
      return new Promise(function(r) { setTimeout(r, 800); });
    }).then(function() {
      setStep("Шаг 4/4: Перезагрузка на новую версию...");
      const baseUrl = window.location.href.split("?")[0].split("#")[0];
      setTimeout(function() {
        window.location.replace(baseUrl + "?v=" + Date.now());
      }, 600);
    });
  }

  function bindEvents() {
    const prevM = document.getElementById("btnPrevMonth");
    const nextM = document.getElementById("btnNextMonth");
    if (prevM) {
      prevM.onclick = function() {
        state.month--;
        if (state.month < 0) {
          state.month = 11;
          state.year--;
        }
        renderCalendar();
        renderRecordsAndTotals();
      };
    }
    if (nextM) {
      nextM.onclick = function() {
        state.month++;
        if (state.month > 11) {
          state.month = 0;
          state.year++;
        }
        renderCalendar();
        renderRecordsAndTotals();
      };
    }

    const modeBtns = document.querySelectorAll(".mode-btn");
    for (let i = 0; i < modeBtns.length; i++) {
      modeBtns[i].onclick = function() {
        for (let j = 0; j < modeBtns.length; j++) {
          modeBtns[j].classList.remove("active");
        }
        this.classList.add("active");
        state.mode = this.dataset.mode || "day";
        const anchor = state.selectedDays[0] || makeDateKey(state.year, state.month, 1);
        selectPeriodByMode(anchor);
        renderCalendar();
        renderRecordsAndTotals();
      };
    }

    const grid = document.getElementById("calendarGrid");
    if (grid) {
      grid.addEventListener("pointerdown", function(e) {
        const cell = e.target.closest(".day-cell");
        if (!cell || !cell.dataset.key) return;
        isDragging = true;
        dragStartKey = cell.dataset.key;
        const dt = parseDateKey(dragStartKey);
        state.year = dt.getFullYear();
        state.month = dt.getMonth();
        selectPeriodByMode(dragStartKey);
        renderCalendar();
        renderRecordsAndTotals();
      });

      grid.addEventListener("pointermove", function(e) {
        if (!isDragging || !dragStartKey) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const cell = target ? target.closest(".day-cell") : null;
        if (!cell || !cell.dataset.key) return;
        if (cell.dataset.key !== dragStartKey) {
          state.mode = "day";
          const modeBtnsAll = document.querySelectorAll(".mode-btn");
          for (let j = 0; j < modeBtnsAll.length; j++) {
            modeBtnsAll[j].classList.toggle("active", modeBtnsAll[j].dataset.mode === "day");
          }
          selectRange(dragStartKey, cell.dataset.key);
          renderCalendar();
          renderRecordsAndTotals();
        }
      });

      window.addEventListener("pointerup", function() {
        isDragging = false;
        dragStartKey = null;
      });
    }

    const btnOff = document.getElementById("btnDayOff");
    if (btnOff) btnOff.onclick = toggleDayOff;

    const btnAdd = document.getElementById("btnAddRecord");
    if (btnAdd) btnAdd.onclick = addWorkRecord;

    const btnUndo = document.getElementById("btnUndo");
    if (btnUndo) btnUndo.onclick = undoLastDelete;

    const btnClearAll = document.getElementById("btnClearAll");
    if (btnClearAll) {
      btnClearAll.onclick = function() {
        document.getElementById("confirmClearModal").classList.add("open");
      };
    }

    const btnClearYes = document.getElementById("btnConfirmClearYes");
    if (btnClearYes) {
      btnClearYes.onclick = function() {
        state.records = {};
        state.undoStack = [];
        persistAll();
        renderCalendar();
        renderRecordsAndTotals();
        document.getElementById("confirmClearModal").classList.remove("open");
        showToast("Все записи очищены");
      };
    }

    const btnClearNo = document.getElementById("btnConfirmClearNo");
    if (btnClearNo) {
      btnClearNo.onclick = function() {
        document.getElementById("confirmClearModal").classList.remove("open");
      };
    }

    const inpBoxes = document.getElementById("inpBoxes");
    const inpBW = document.getElementById("inpBoxWeight");
    const inpRate = document.getElementById("inpRate");
    const inpName = document.getElementById("inpWorkerName");

    if (inpBoxes) inpBoxes.addEventListener("input", updateShiftPreview);
    if (inpBW) inpBW.addEventListener("input", updateShiftPreview);
    if (inpRate) {
      inpRate.addEventListener("input", function() {
        const r = cleanNum(this.value);
        if (r > 0) {
          state.defaultRate = r;
          persistAll();
        }
        updateShiftPreview();
      });
    }
    if (inpName) {
      inpName.addEventListener("input", function() {
        state.workerName = this.value.trim();
        persistAll();
      });
    }

    const btnFull = document.getElementById("btnFullReport");
    const btnShort = document.getElementById("btnShortReport");
    if (btnFull) btnFull.onclick = function() { openReportPreview(false); };
    if (btnShort) btnShort.onclick = function() { openReportPreview(true); };

    const btnRepCancel = document.getElementById("btnReportCancel");
    const btnRepSend = document.getElementById("btnReportSend");
    if (btnRepCancel) {
      btnRepCancel.onclick = function() {
        document.getElementById("reportModal").classList.remove("open");
      };
    }
    if (btnRepSend) btnRepSend.onclick = sendCurrentReport;

    const btnSave = document.getElementById("btnSaveBackup");
    const btnRestore = document.getElementById("btnOpenRestore");
    if (btnSave) {
      btnSave.onclick = function() {
        createBackup("вручную").then(function() {
          showToast("База сохранена (" + countRecords(state.records) + " зап.)");
        });
      };
    }
    if (btnRestore) {
      btnRestore.onclick = function() {
        renderBackupsList();
        document.getElementById("restoreModal").classList.add("open");
      };
    }

    const btnCloseRestore = document.getElementById("btnCloseRestore");
    if (btnCloseRestore) {
      btnCloseRestore.onclick = function() {
        document.getElementById("restoreModal").classList.remove("open");
      };
    }

    const btnDelBkYes = document.getElementById("btnConfirmDelBkYes");
    const btnDelBkNo = document.getElementById("btnConfirmDelBkNo");
    if (btnDelBkYes) {
      btnDelBkYes.onclick = function() {
        if (pendingDeleteBackupId) {
          backups = backups.filter(function(b) { return b.id !== pendingDeleteBackupId; });
          pendingDeleteBackupId = null;
          persistAll();
          renderBackupsList();
          showToast("Копия удалена");
        }
        document.getElementById("confirmDelBackupModal").classList.remove("open");
      };
    }
    if (btnDelBkNo) {
      btnDelBkNo.onclick = function() {
        pendingDeleteBackupId = null;
        document.getElementById("confirmDelBackupModal").classList.remove("open");
      };
    }

    const btnExportCode = document.getElementById("btnExportCode");
    const btnImportCode = document.getElementById("btnImportCode");
    const transferArea = document.getElementById("transferCodeArea");
    if (btnExportCode && transferArea) {
      btnExportCode.onclick = function() {
        const code = btoa(unescape(encodeURIComponent(JSON.stringify(getSnapshot()))));
        transferArea.value = code;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).catch(function() {});
        }
        showToast("Код базы скопирован");
      };
    }
    if (btnImportCode && transferArea) {
      btnImportCode.onclick = function() {
        const raw = transferArea.value.trim();
        if (!raw) {
          showToast("Вставьте код базы в поле");
          return;
        }
        try {
          const parsed = JSON.parse(decodeURIComponent(escape(atob(raw))));
          applySnapshot(parsed);
          const nameEl = document.getElementById("inpWorkerName");
          const rateEl = document.getElementById("inpRate");
          if (nameEl) nameEl.value = state.workerName;
          if (rateEl) rateEl.value = state.defaultRate;
          persistAll();
          renderCalendar();
          renderRecordsAndTotals();
          document.getElementById("restoreModal").classList.remove("open");
          showToast("База загружена по коду");
        } catch (e) {
          showToast("Неверный код базы");
        }
      };
    }

    const btnTheme = document.getElementById("btnThemeToggle");
    if (btnTheme) {
      btnTheme.onclick = function() {
        state.theme = state.theme === "dark" ? "light" : "dark";
        document.body.classList.toggle("light-theme", state.theme === "light");
        persistAll();
      };
    }

    const btnUpdate = document.getElementById("btnCheckUpdate");
    if (btnUpdate) {
      btnUpdate.onclick = runAppUpdate;
    }
  }

  function init() {
    const today = new Date();
    state.year = today.getFullYear();
    state.month = today.getMonth();
    state.selectedDays = [makeDateKey(state.year, state.month, today.getDate())];

    loadAllSources().then(function(snap) {
      if (snap) {
        applySnapshot(snap);
      }
      document.body.classList.toggle("light-theme", state.theme === "light");
      const nameEl = document.getElementById("inpWorkerName");
      const rateEl = document.getElementById("inpRate");
      if (nameEl) nameEl.value = state.workerName || "";
      if (rateEl) rateEl.value = state.defaultRate || 9.5;

      bindEvents();
      renderCalendar();
      renderRecordsAndTotals();
      updateShiftPreview();
      persistAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
