(function() {
  const APP_VERSION = "v 8.0";
  const STORAGE_KEY = "obvalka_pro_data_v1";
  const BACKUPS_KEY = "obvalka_pro_backups_v1";
  const DB_NAME = "ObvalkaProDB";
  const STORE_NAME = "kv";
  const NL = String.fromCharCode(10);

  let state = {
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(),
    selectedDate: ObvalkaCalendar.toKey(new Date()),
    rangeStart: null,
    rangeEnd: null,
    mode: "day",
    manualRange: false,
    worker: "",
    rate: 9.5,
    theme: "dark",
    records: [],
    undoStack: []
  };

  let pendingDeleteBackupId = null;
  let currentReportText = "";

  function showToast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.display = "none"; }, 2600);
  }

  function cleanNum(val) {
    if (typeof val === "number") return isNaN(val) ? 0 : val;
    if (!val) return 0;
    const s = String(val).replace(",", ".").replace(/[^0-9.]/g, "");
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const date = raw.date || ObvalkaCalendar.toKey(new Date());
    const isOff = Boolean(raw.isOff || raw.off);
    const boxes = Math.round(cleanNum(raw.boxes !== undefined ? raw.boxes : raw.b));
    const boxWeight = cleanNum(raw.boxWeight !== undefined ? raw.boxWeight : raw.bw);
    let weight = cleanNum(raw.weight !== undefined ? raw.weight : (raw.totalWeight !== undefined ? raw.totalWeight : raw.w));
    if (weight === 0 && boxes > 0 && boxWeight > 0) {
      weight = Math.round(boxes * boxWeight * 100) / 100;
    }
    let rate = cleanNum(raw.rate !== undefined ? raw.rate : raw.r);
    if (rate === 0 && !isOff) rate = state.rate || 9.5;
    let pay = cleanNum(raw.pay !== undefined ? raw.pay : (raw.totalPay !== undefined ? raw.totalPay : raw.sum));
    if (pay === 0 && weight > 0 && rate > 0) {
      pay = Math.round(weight * rate * 100) / 100;
    }
    return {
      id: raw.id || (Date.now() + Math.random()),
      date: date,
      boxes: isOff ? 0 : boxes,
      boxWeight: isOff ? 0 : boxWeight,
      weight: isOff ? 0 : Math.round(weight * 100) / 100,
      rate: isOff ? 0 : rate,
      pay: isOff ? 0 : Math.round(pay * 100) / 100,
      isOff: isOff
    };
  }

  function openIDB() {
    return new Promise(function(resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { resolve(null); };
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function(db) {
      if (!db) return;
      return new Promise(function(resolve) {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(val, key);
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { resolve(); };
      });
    });
  }

  function idbGet(key) {
    return openIDB().then(function(db) {
      if (!db) return null;
      return new Promise(function(resolve) {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { resolve(null); };
      });
    });
  }

  function getSerializableState() {
    return {
      worker: state.worker,
      rate: state.rate,
      theme: state.theme,
      records: state.records
    };
  }

  function saveAll() {
    const payload = JSON.stringify(getSerializableState());
    try { localStorage.setItem(STORAGE_KEY, payload); } catch (e) {}
    try { window.name = "OBVALKA_BACKUP:" + payload; } catch (e) {}
    return idbSet(STORAGE_KEY, payload);
  }

  function getBackups() {
    try {
      const raw = localStorage.getItem(BACKUPS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveBackups(list) {
    const raw = JSON.stringify(list);
    try { localStorage.setItem(BACKUPS_KEY, raw); } catch (e) {}
    return idbSet(BACKUPS_KEY, raw);
  }

  function createBackup(tag) {
    const list = getBackups();
    const now = new Date();
    const label = now.toLocaleDateString("ru-RU") + " " + now.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"}) + (tag ? " " + tag : "");
    list.unshift({ id: Date.now(), label: label, data: getSerializableState() });
    if (list.length > 20) list.length = 20;
    return saveBackups(list);
  }

  function applyLoadedData(obj) {
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.worker === "string") state.worker = obj.worker;
    if (obj.rate !== undefined && cleanNum(obj.rate) > 0) state.rate = cleanNum(obj.rate);
    if (obj.theme === "light" || obj.theme === "dark") state.theme = obj.theme;
    if (Array.isArray(obj.records)) {
      state.records = obj.records.map(normalizeRecord).filter(Boolean);
    }
  }

  function loadInitialData() {
    let lsObj = null;
    let wnObj = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsObj = JSON.parse(raw);
    } catch (e) {}
    try {
      if (window.name && window.name.indexOf("OBVALKA_BACKUP:") === 0) {
        wnObj = JSON.parse(window.name.slice("OBVALKA_BACKUP:".length));
      }
    } catch (e) {}

    return idbGet(STORAGE_KEY).then(function(idbRaw) {
      let idbObj = null;
      if (idbRaw) {
        try { idbObj = typeof idbRaw === "string" ? JSON.parse(idbRaw) : idbRaw; } catch (e) {}
      }
      const candidates = [lsObj, idbObj, wnObj].filter(Boolean);
      candidates.sort(function(a, b) {
        const la = Array.isArray(a.records) ? a.records.length : 0;
        const lb = Array.isArray(b.records) ? b.records.length : 0;
        return lb - la;
      });
      if (candidates.length > 0) applyLoadedData(candidates[0]);
      document.body.classList.toggle("light", state.theme === "light");
      document.getElementById("inpWorker").value = state.worker || "";
      document.getElementById("inpRate").value = state.rate || "";
      saveAll();
    });
  }

  function setPeriodByMode(mode) {
    state.mode = mode;
    state.manualRange = false;
    const base = ObvalkaCalendar.parseKey(state.selectedDate);
    if (mode === "day") {
      state.rangeStart = null;
      state.rangeEnd = null;
    } else if (mode === "week") {
      const dow = (base.getDay() + 6) % 7;
      const s = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dow);
      const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
      state.rangeStart = ObvalkaCalendar.toKey(s);
      state.rangeEnd = ObvalkaCalendar.toKey(e);
    } else if (mode === "twoWeeks") {
      const d = base.getDate();
      const s = new Date(base.getFullYear(), base.getMonth(), d <= 15 ? 1 : 16);
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      const e = new Date(base.getFullYear(), base.getMonth(), d <= 15 ? 15 : lastDay);
      state.rangeStart = ObvalkaCalendar.toKey(s);
      state.rangeEnd = ObvalkaCalendar.toKey(e);
    } else if (mode === "month") {
      const s = new Date(state.viewYear, state.viewMonth, 1);
      const e = new Date(state.viewYear, state.viewMonth + 1, 0);
      state.rangeStart = ObvalkaCalendar.toKey(s);
      state.rangeEnd = ObvalkaCalendar.toKey(e);
    } else if (mode === "year") {
      const s = new Date(state.viewYear, 0, 1);
      const e = new Date(state.viewYear, 11, 31);
      state.rangeStart = ObvalkaCalendar.toKey(s);
      state.rangeEnd = ObvalkaCalendar.toKey(e);
    }
    updateTabsUI();
    renderAll();
  }

  function updateTabsUI() {
    const tabs = document.querySelectorAll("#periodTabs .tab");
    tabs.forEach(function(t) {
      t.classList.toggle("active", !state.manualRange && t.dataset.mode === state.mode);
    });
  }

  function getFilteredRecords() {
    if (state.rangeStart && state.rangeEnd) {
      return state.records.filter(function(r) {
        return r.date >= state.rangeStart && r.date <= state.rangeEnd;
      }).sort(function(a, b) { return a.date.localeCompare(b.date); });
    }
    return state.records.filter(function(r) { return r.date === state.selectedDate; });
  }

  function renderAll() {
    ObvalkaCalendar.render(state, function(a, b, isDrag) {
      state.selectedDate = a;
      if (a !== b || isDrag) {
        state.rangeStart = a;
        state.rangeEnd = b;
        state.manualRange = true;
        updateTabsUI();
      } else {
        state.manualRange = false;
        setPeriodByMode("day");
        return;
      }
      renderAll();
    });

    document.getElementById("selectedDateText").textContent = ObvalkaCalendar.formatRuDay(state.selectedDate);
    const list = getFilteredRecords();
    const recEl = document.getElementById("recordsList");
    recEl.innerHTML = "";

    let totBoxes = 0;
    let totWeight = 0;
    let totPay = 0;

    list.forEach(function(r) {
      totBoxes += r.boxes;
      totWeight += r.weight;
      totPay += r.pay;

      const row = document.createElement("div");
      row.className = "rec-item" + (r.isOff ? " off-item" : "");
      const info = document.createElement("span");
      if (r.isOff) {
        info.textContent = ObvalkaCalendar.formatShortDay(r.date) + ": Выходной";
      } else {
        info.textContent = ObvalkaCalendar.formatShortDay(r.date) + ": " + r.boxes + " кор. • " + r.weight + " кг × " + r.rate + " ₽ = " + r.pay + " ₽";
      }
      const del = document.createElement("button");
      del.className = "del-rec";
      del.textContent = "✕";
      del.onclick = function() {
        state.undoStack.push(r);
        state.records = state.records.filter(function(x) { return x.id !== r.id; });
        saveAll();
        renderAll();
      };
      row.appendChild(info);
      row.appendChild(del);
      recEl.appendChild(row);
    });

    totWeight = Math.round(totWeight * 100) / 100;
    totPay = Math.round(totPay * 100) / 100;

    let periodLabel = "ДЕНЬ (" + ObvalkaCalendar.formatShortDay(state.selectedDate).toUpperCase() + ")";
    if (state.rangeStart && state.rangeEnd) {
      periodLabel = ObvalkaCalendar.formatShortDay(state.rangeStart).toUpperCase() + " – " + ObvalkaCalendar.formatShortDay(state.rangeEnd).toUpperCase();
    }
    document.getElementById("recHeader").textContent = "ЗАПИСИ (" + periodLabel + ")";
    document.getElementById("recCount").textContent = list.length + " ШТ.";
    document.getElementById("sumTitle").textContent = "ИТОГ ЗА " + periodLabel;
    document.getElementById("sumSub").textContent = totBoxes + " кор. • " + totWeight + " кг";
    document.getElementById("sumMoney").textContent = totPay + " ₽";

    const undoBar = document.getElementById("undoBar");
    if (state.undoStack.length > 0) {
      undoBar.classList.add("show");
      document.getElementById("btnUndo").textContent = "↩ Отменить удаление (" + state.undoStack.length + ")";
    } else {
      undoBar.classList.remove("show");
    }
  }

  function updatePreview() {
    const boxes = Math.round(cleanNum(document.getElementById("inpBoxes").value));
    const bw = cleanNum(document.getElementById("inpWeight").value);
    const rate = cleanNum(document.getElementById("inpRate").value);
    const w = boxes > 0 ? Math.round(boxes * bw * 100) / 100 : Math.round(bw * 100) / 100;
    const p = Math.round(w * rate * 100) / 100;
    document.getElementById("prevWeight").textContent = w + " кг";
    document.getElementById("prevMoney").textContent = p + " ₽";
  }

  function buildReport(isFull) {
    const list = getFilteredRecords();
    const worker = (document.getElementById("inpWorker").value || state.worker || "").trim();
    let totBoxes = 0;
    let totWeight = 0;
    let totPay = 0;
    list.forEach(function(r) {
      totBoxes += r.boxes;
      totWeight += r.weight;
      totPay += r.pay;
    });
    totWeight = Math.round(totWeight * 100) / 100;
    totPay = Math.round(totPay * 100) / 100;

    const lines = [];
    if (worker) lines.push(worker);

    if (!isFull) {
      if (state.manualRange && state.rangeStart && state.rangeEnd && state.rangeStart !== state.rangeEnd) {
        lines.push(ObvalkaCalendar.formatShortDay(state.rangeStart) + " – " + ObvalkaCalendar.formatShortDay(state.rangeEnd));
      }
      lines.push("Вес: " + totWeight + " кг " + totBoxes + " кор.");
      return lines.join(NL);
    }

    const pText = (state.rangeStart && state.rangeEnd)
      ? (ObvalkaCalendar.formatShortDay(state.rangeStart) + " – " + ObvalkaCalendar.formatShortDay(state.rangeEnd))
      : ObvalkaCalendar.formatRuDay(state.selectedDate);
    lines.push("Период: " + pText);

    list.forEach(function(r) {
      if (r.isOff) {
        lines.push(ObvalkaCalendar.formatShortDay(r.date) + " | Выходной");
      } else {
        lines.push(ObvalkaCalendar.formatShortDay(r.date) + " | " + r.boxes + "кор | " + r.weight + "кг | " + r.pay + "₽");
      }
    });
    lines.push("ИТОГ: " + totBoxes + "кор | " + totWeight + "кг | " + totPay + "₽");
    return lines.join(NL);
  }

  function openReportPreview(isFull) {
    currentReportText = buildReport(isFull);
    document.getElementById("repPreviewText").textContent = currentReportText;
    document.getElementById("repModal").classList.add("open");
  }

  function sendReport() {
    document.getElementById("repModal").classList.remove("open");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentReportText).catch(function() {});
    }
    if (navigator.share) {
      navigator.share({ text: currentReportText }).catch(function() {
        window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(currentReportText) + ";end";
      });
    } else {
      window.location.href = "intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=" + encodeURIComponent(currentReportText) + ";end";
    }
  }

  function renderBackupModal() {
    const list = getBackups();
    const box = document.getElementById("backupList");
    box.innerHTML = "";
    if (list.length === 0) {
      box.innerHTML = "<div style='font-size:12px;color:var(--text-muted);text-align:center;padding:12px;'>Нет сохранённых копий</div>";
      return;
    }
    list.forEach(function(b) {
      const row = document.createElement("div");
      row.className = "backup-item";
      const info = document.createElement("span");
      const cnt = b.data && Array.isArray(b.data.records) ? b.data.records.length : 0;
      info.textContent = b.label + " (" + cnt + " зап.)";
      const acts = document.createElement("div");
      acts.className = "b-acts";
      const rest = document.createElement("button");
      rest.className = "b-rest";
      rest.textContent = "Восстановить";
      rest.onclick = function() {
        applyLoadedData(b.data);
        saveAll();
        document.getElementById("dbModal").classList.remove("open");
        renderAll();
        showToast("База восстановлена");
      };
      const del = document.createElement("button");
      del.className = "b-del";
      del.textContent = "✕";
      del.onclick = function() {
        pendingDeleteBackupId = b.id;
        document.getElementById("confirmDelModal").classList.add("open");
      };
      acts.appendChild(rest);
      acts.appendChild(del);
      row.appendChild(info);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  function stepUpdate() {
    if (window.location.protocol === "file:") {
      showToast("Локальный файл: загрузите на GitHub для проверки");
      return;
    }
    showToast("Шаг 1/3: Сохранение базы...");
    createBackup("(перед обн.)").then(function() { return saveAll(); }).then(function() {
      setTimeout(function() {
        showToast("Шаг 2/3: Очистка кэша...");
        const p1 = window.caches ? caches.keys().then(function(ks) { return Promise.all(ks.map(function(k) { return caches.delete(k); })); }) : Promise.resolve();
        const p2 = navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function(rs) { return Promise.all(rs.map(function(r) { return r.unregister(); })); }) : Promise.resolve();
        Promise.all([p1, p2]).then(function() {
          setTimeout(function() {
            showToast("Шаг 3/3: Перезагрузка...");
            window.location.reload(true);
          }, 800);
        });
      }, 800);
    });
  }

  function bindEvents() {
    document.getElementById("prevMonth").onclick = function() {
      state.viewMonth--;
      if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
      renderAll();
    };
    document.getElementById("nextMonth").onclick = function() {
      state.viewMonth++;
      if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
      renderAll();
    };
    document.querySelectorAll("#periodTabs .tab").forEach(function(btn) {
      btn.onclick = function() { setPeriodByMode(btn.dataset.mode); };
    });
    document.getElementById("btnTheme").onclick = function() {
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.body.classList.toggle("light", state.theme === "light");
      saveAll();
    };
    document.getElementById("btnUpdate").onclick = stepUpdate;

    document.getElementById("btnOffDay").onclick = function() {
      state.records.push({
        id: Date.now() + Math.random(),
        date: state.selectedDate,
        boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0, isOff: true
      });
      saveAll();
      renderAll();
      showToast("Выходной добавлен");
    };

    ["inpBoxes", "inpWeight", "inpRate"].forEach(function(id) {
      document.getElementById(id).addEventListener("input", function() {
        if (id === "inpRate") {
          state.rate = cleanNum(this.value);
          saveAll();
        }
        updatePreview();
      });
    });

    document.getElementById("inpWorker").addEventListener("input", function() {
      state.worker = this.value;
      saveAll();
    });

    document.getElementById("btnAdd").onclick = function() {
      const boxes = Math.round(cleanNum(document.getElementById("inpBoxes").value));
      const bw = cleanNum(document.getElementById("inpWeight").value);
      const rate = cleanNum(document.getElementById("inpRate").value) || state.rate || 9.5;
      const w = boxes > 0 ? Math.round(boxes * bw * 100) / 100 : Math.round(bw * 100) / 100;
      if (w <= 0) { showToast("Введите вес коробки"); return; }
      const pay = Math.round(w * rate * 100) / 100;
      state.rate = rate;
      state.records.push({
        id: Date.now() + Math.random(),
        date: state.selectedDate,
        boxes: boxes, boxWeight: bw, weight: w, rate: rate, pay: pay, isOff: false
      });
      document.getElementById("inpBoxes").value = "";
      document.getElementById("inpWeight").value = "";
      updatePreview();
      saveAll();
      renderAll();
      showToast("Смена добавлена");
    };

    document.getElementById("btnUndo").onclick = function() {
      if (state.undoStack.length === 0) return;
      state.records.push(state.undoStack.pop());
      saveAll();
      renderAll();
    };
    document.getElementById("btnClearUndo").onclick = function() {
      state.undoStack = [];
      renderAll();
    };

    document.getElementById("btnFullRep").onclick = function() { openReportPreview(true); };
    document.getElementById("btnShortRep").onclick = function() { openReportPreview(false); };
    document.getElementById("btnCancelRep").onclick = function() { document.getElementById("repModal").classList.remove("open"); };
    document.getElementById("btnSendRep").onclick = sendReport;

    document.getElementById("btnSaveDb").onclick = function() {
      createBackup("").then(function() { showToast("База сохранена"); });
    };
    document.getElementById("btnOpenDb").onclick = function() {
      renderBackupModal();
      document.getElementById("dbModal").classList.add("open");
    };
    document.getElementById("btnCloseDb").onclick = function() {
      document.getElementById("dbModal").classList.remove("open");
    };
    document.getElementById("btnNoDel").onclick = function() {
      pendingDeleteBackupId = null;
      document.getElementById("confirmDelModal").classList.remove("open");
    };
    document.getElementById("btnYesDel").onclick = function() {
      if (pendingDeleteBackupId !== null) {
        const list = getBackups().filter(function(x) { return x.id !== pendingDeleteBackupId; });
        saveBackups(list);
        pendingDeleteBackupId = null;
        renderBackupModal();
        showToast("Копия удалена");
      }
      document.getElementById("confirmDelModal").classList.remove("open");
    };

    document.getElementById("btnCopyCode").onclick = function() {
      const code = JSON.stringify(getSerializableState());
      const area = document.getElementById("codeArea");
      area.value = code;
      area.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).catch(function() {});
      }
      showToast("Код базы скопирован");
    };
    document.getElementById("btnImportCode").onclick = function() {
      const raw = document.getElementById("codeArea").value.trim();
      if (!raw) { showToast("Вставьте код базы"); return; }
      try {
        const obj = JSON.parse(raw);
        applyLoadedData(obj);
        saveAll();
        document.getElementById("dbModal").classList.remove("open");
        renderAll();
        showToast("База загружена из кода");
      } catch (e) {
        showToast("Неверный формат кода");
      }
    };
  }

  document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("verLabel").textContent = APP_VERSION;
    bindEvents();
    loadInitialData().then(function() {
      renderAll();
      updatePreview();
    });
  });
})();
