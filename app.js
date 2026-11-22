(function() {
  const APP_VERSION = 'v 7.8';
  const STORAGE_KEY = 'obvalka_pro_data_v1';
  const BACKUPS_KEY = 'obvalka_pro_backups_v1';
  const AUTO_BACKUP_DATE_KEY = 'obvalka_pro_last_auto_backup';
  const DB_NAME = 'ObvalkaProDB';
  const DB_STORE = 'kv';
  const REPO_RAW_BASE = 'https://raw.githubusercontent.com/anstop234/obvalka-pro/main/';

  const MONTHS_NOM = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
  ];
  const MONTHS_GEN = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  const MONTHS_SHORT = [
    'янв', 'фев', 'мар', 'апр', 'май', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'
  ];

  let state = {
    viewYear: 2026,
    viewMonth: 10,
    periodMode: 'day',
    selectedDates: ['2026-11-21'],
    anchorDate: '2026-11-21',
    isCustomRange: false,
    workerName: '',
    defaultRate: 9.5,
    records: {},
    theme: 'dark'
  };

  let undoStack = [];
  let pendingConfirmAction = null;
  let currentReportText = '';
  let isDragging = false;
  let dragStartDate = null;

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function toKey(y, m, d) {
    return y + '-' + pad2(m + 1) + '-' + pad2(d);
  }

  function parseKey(key) {
    const p = key.split('-').map(Number);
    return { y: p[0], m: p[1] - 1, d: p[2] };
  }

  function formatDateGen(key) {
    const p = parseKey(key);
    return p.d + ' ' + MONTHS_GEN[p.m];
  }

  function formatDateShort(key) {
    const p = parseKey(key);
    return p.d + ' ' + MONTHS_SHORT[p.m];
  }

  function parseNum(val) {
    if (typeof val === 'number') return isFinite(val) ? val : 0;
    if (!val) return 0;
    const cleaned = String(val).replace(',', '.').replace(/[^0-9.-]/g, '');
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function round1(n) {
    return Math.round((n + Number.EPSILON) * 10) / 10;
  }

  function normalizeRecord(raw, fallbackRate) {
    if (!raw || typeof raw !== 'object') return null;
    const isOff = Boolean(raw.isOff || raw.off || raw.dayOff);
    if (isOff) {
      return { isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 };
    }
    const boxes = Math.round(parseNum(raw.boxes !== undefined ? raw.boxes : raw.b));
    const boxWeight = parseNum(raw.boxWeight !== undefined ? raw.boxWeight : raw.bw);
    let weight = parseNum(
      raw.weight !== undefined ? raw.weight :
      (raw.totalWeight !== undefined ? raw.totalWeight : raw.w)
    );
    if (weight <= 0 && boxes > 0 && boxWeight > 0) {
      weight = round1(boxes * boxWeight);
    }
    let rate = parseNum(raw.rate !== undefined ? raw.rate : raw.r);
    if (rate <= 0 && weight > 0) {
      rate = fallbackRate > 0 ? fallbackRate : 9.5;
    }
    let pay = parseNum(
      raw.pay !== undefined ? raw.pay :
      (raw.totalPay !== undefined ? raw.totalPay : raw.sum)
    );
    if (weight > 0 && rate > 0) {
      pay = round2(weight * rate);
    }
    if (boxes === 0 && weight === 0 && pay === 0) {
      return { isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 };
    }
    return {
      isOff: false,
      boxes: boxes,
      boxWeight: boxWeight,
      weight: round1(weight),
      rate: round2(rate),
      pay: round2(pay)
    };
  }

  function normalizeDataset(rawObj) {
    if (!rawObj || typeof rawObj !== 'object') return null;
    const fallbackRate = parseNum(rawObj.defaultRate) || 9.5;
    const out = {
      workerName: typeof rawObj.workerName === 'string' ? rawObj.workerName : '',
      defaultRate: fallbackRate,
      theme: rawObj.theme === 'light' ? 'light' : 'dark',
      records: {}
    };
    const srcRecs = rawObj.records && typeof rawObj.records === 'object' ? rawObj.records : {};
    Object.keys(srcRecs).forEach(function(dateKey) {
      const list = Array.isArray(srcRecs[dateKey]) ? srcRecs[dateKey] : [srcRecs[dateKey]];
      const normList = [];
      list.forEach(function(item) {
        const nr = normalizeRecord(item, fallbackRate);
        if (nr) normList.push(nr);
      });
      if (normList.length > 0) {
        out.records[dateKey] = normList;
      }
    });
    return out;
  }

  function countRecords(recordsMap) {
    if (!recordsMap || typeof recordsMap !== 'object') return 0;
    let total = 0;
    Object.keys(recordsMap).forEach(function(k) {
      if (Array.isArray(recordsMap[k])) total += recordsMap[k].length;
    });
    return total;
  }

  function openIDB() {
    return new Promise(function(resolve) {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };
        req.onsuccess = function(e) { resolve(e.target.result); };
        req.onerror = function() { resolve(null); };
      } catch (err) {
        resolve(null);
      }
    });
  }

  function idbSet(key, val) {
    return openIDB().then(function(db) {
      if (!db) return false;
      return new Promise(function(resolve) {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(val, key);
          tx.oncomplete = function() { resolve(true); };
          tx.onerror = function() { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function idbGet(key) {
    return openIDB().then(function(db) {
      if (!db) return null;
      return new Promise(function(resolve) {
        try {
          const tx = db.transaction(DB_STORE, 'readonly');
          const req = tx.objectStore(DB_STORE).get(key);
          req.onsuccess = function() { resolve(req.result || null); };
          req.onerror = function() { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function serializeState() {
    return {
      workerName: state.workerName,
      defaultRate: state.defaultRate,
      theme: state.theme,
      records: state.records,
      savedAt: Date.now()
    };
  }

  function saveAllStorages() {
    const payload = serializeState();
    const jsonStr = JSON.stringify(payload);
    try { localStorage.setItem(STORAGE_KEY, jsonStr); } catch (e) {}
    try { window.name = 'OBVALKA_STATE:' + jsonStr; } catch (e) {}
    return idbSet(STORAGE_KEY, payload);
  }

  function getBackupsList() {
    let list = [];
    try {
      const raw = localStorage.getItem(BACKUPS_KEY);
      if (raw) list = JSON.parse(raw);
    } catch (e) {}
    return Array.isArray(list) ? list : [];
  }

  function saveBackupsList(list) {
    const trimmed = list.slice(0, 25);
    try { localStorage.setItem(BACKUPS_KEY, JSON.stringify(trimmed)); } catch (e) {}
    return idbSet(BACKUPS_KEY, trimmed);
  }

  function createBackup(tag) {
    const now = new Date();
    const label = pad2(now.getDate()) + '.' + pad2(now.getMonth() + 1) + '.' + now.getFullYear() +
      ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + (tag ? ' ' + tag : '');
    const snap = serializeState();
    const recCount = countRecords(snap.records);
    const list = getBackupsList();
    list.unshift({
      id: 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label: label,
      count: recCount,
      data: snap
    });
    return saveBackupsList(list);
  }

  function maybeAutoDailyBackup() {
    const today = new Date();
    const todayKey = toKey(today.getFullYear(), today.getMonth(), today.getDate());
    let last = '';
    try { last = localStorage.getItem(AUTO_BACKUP_DATE_KEY) || ''; } catch (e) {}
    if (last !== todayKey) {
      try { localStorage.setItem(AUTO_BACKUP_DATE_KEY, todayKey); } catch (e) {}
      createBackup('(авто)');
    }
  }

  function loadInitialData() {
    let lsData = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) lsData = normalizeDataset(JSON.parse(raw));
    } catch (e) {}

    let wnData = null;
    try {
      if (window.name && window.name.indexOf('OBVALKA_STATE:') === 0) {
        wnData = normalizeDataset(JSON.parse(window.name.slice('OBVALKA_STATE:'.length)));
      }
    } catch (e) {}

    return Promise.all([idbGet(STORAGE_KEY), idbGet(BACKUPS_KEY)]).then(function(res) {
      const idbData = res[0] ? normalizeDataset(res[0]) : null;
      const idbBackups = Array.isArray(res[1]) ? res[1] : [];
      const lsBackups = getBackupsList();

      if (idbBackups.length > lsBackups.length) {
        try { localStorage.setItem(BACKUPS_KEY, JSON.stringify(idbBackups)); } catch (e) {}
      } else if (lsBackups.length > idbBackups.length) {
        idbSet(BACKUPS_KEY, lsBackups);
      }

      const candidates = [lsData, idbData, wnData].filter(Boolean);
      if (candidates.length > 0) {
        candidates.sort(function(a, b) {
          return countRecords(b.records) - countRecords(a.records);
        });
        const best = candidates[0];
        state.workerName = best.workerName || '';
        state.defaultRate = best.defaultRate || 9.5;
        state.theme = best.theme || 'dark';
        state.records = best.records || {};
        saveAllStorages();
      }
    });
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(function() {
      el.classList.remove('show');
    }, 2400);
  }

  function applyTheme() {
    document.body.setAttribute('data-theme', state.theme);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
  }

  function getPeriodDates() {
    const y = state.viewYear;
    const m = state.viewMonth;
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    if (state.isCustomRange && state.selectedDates.length > 0) {
      return state.selectedDates.slice().sort();
    }

    if (state.periodMode === 'day') {
      return state.selectedDates.length ? [state.selectedDates[0]] : [toKey(y, m, 1)];
    }

    if (state.periodMode === 'week') {
      const anchor = parseKey(state.anchorDate || toKey(y, m, 1));
      const dt = new Date(anchor.y, anchor.m, anchor.d);
      const dow = (dt.getDay() + 6) % 7;
      const start = new Date(dt);
      start.setDate(dt.getDate() - dow);
      const arr = [];
      for (let i = 0; i < 7; i++) {
        const cur = new Date(start);
        cur.setDate(start.getDate() + i);
        arr.push(toKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
      }
      return arr;
    }

    if (state.periodMode === 'biweek') {
      const anchor = parseKey(state.anchorDate || toKey(y, m, 1));
      const startDay = anchor.d <= 15 ? 1 : 16;
      const endDay = anchor.d <= 15 ? 15 : daysInMonth;
      const arr = [];
      for (let d = startDay; d <= endDay; d++) {
        arr.push(toKey(y, m, d));
      }
      return arr;
    }

    if (state.periodMode === 'month') {
      const arr = [];
      for (let d = 1; d <= daysInMonth; d++) {
        arr.push(toKey(y, m, d));
      }
      return arr;
    }

    if (state.periodMode === 'year') {
      const arr = [];
      for (let mo = 0; mo < 12; mo++) {
        const dim = new Date(y, mo + 1, 0).getDate();
        for (let d = 1; d <= dim; d++) {
          arr.push(toKey(y, mo, d));
        }
      }
      return arr;
    }

    return state.selectedDates.slice();
  }

  function getPeriodLabel(dates) {
    if (!dates || dates.length === 0) return '';
    if (state.periodMode === 'year' && !state.isCustomRange) {
      return state.viewYear + ' год';
    }
    if (state.periodMode === 'month' && !state.isCustomRange) {
      return MONTHS_NOM[state.viewMonth] + ' ' + state.viewYear;
    }
    if (dates.length === 1) {
      return formatDateGen(dates[0]);
    }
    const first = dates[0];
    const last = dates[dates.length - 1];
    return formatDateShort(first) + ' – ' + formatDateShort(last);
  }

  function renderCalendar() {
    const titleEl = document.getElementById('monthTitle');
    const verEl = document.getElementById('verBadge');
    if (titleEl) titleEl.textContent = MONTHS_NOM[state.viewMonth] + ' ' + state.viewYear;
    if (verEl) verEl.textContent = APP_VERSION;

    const grid = document.getElementById('daysGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const y = state.viewYear;
    const m = state.viewMonth;
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();

    const activeDates = getPeriodDates();
    const activeSet = new Set(activeDates);
    const primaryDate = state.anchorDate || (state.selectedDates[0] || toKey(y, m, 1));

    for (let i = firstDow - 1; i >= 0; i--) {
      const d = prevDays - i;
      const cell = document.createElement('div');
      cell.className = 'day-cell other-month';
      cell.textContent = d;
      grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = toKey(y, m, d);
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.dataset.date = key;
      cell.textContent = d;

      const dayRecs = state.records[key] || [];
      const hasWork = dayRecs.some(function(r) { return !r.isOff && r.weight > 0; });
      const hasOff = dayRecs.some(function(r) { return r.isOff; });

      if (hasWork) cell.classList.add('has-data');
      if (hasOff && !hasWork) cell.classList.add('is-off');

      if (key === primaryDate && (state.periodMode === 'day' || state.isCustomRange)) {
        cell.classList.add('selected');
      } else if (activeSet.has(key)) {
        if (state.periodMode === 'day' && !state.isCustomRange) {
          cell.classList.add('selected');
        } else {
          cell.classList.add('in-range');
          if (key === primaryDate) cell.classList.add('selected');
        }
      }

      grid.appendChild(cell);
    }

    const totalCells = firstDow + daysInMonth;
    const rem = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let d = 1; d <= rem; d++) {
      const cell = document.createElement('div');
      cell.className = 'day-cell other-month';
      cell.textContent = d;
      grid.appendChild(cell);
    }
  }

  function renderRecordsAndTotals() {
    const dates = getPeriodDates();
    const label = getPeriodLabel(dates);
    const modeNames = {
      day: 'ДЕНЬ',
      week: 'НЕДЕЛЯ',
      biweek: '2Х НЕДЕЛИ',
      month: 'МЕСЯЦ',
      year: 'ГОД'
    };
    const headTitle = state.isCustomRange
      ? 'ЗАПИСИ (' + label.toUpperCase() + ')'
      : 'ЗАПИСИ (' + (modeNames[state.periodMode] || 'ДЕНЬ') + (dates.length === 1 ? ' (' + label.toUpperCase() + ')' : '') + ')';

    const recHeaderEl = document.getElementById('recordsHeader');
    if (recHeaderEl) recHeaderEl.textContent = headTitle;

    const totalTitleEl = document.getElementById('totalPeriodTitle');
    if (totalTitleEl) {
      totalTitleEl.textContent = 'ИТОГ ЗА ' + (state.isCustomRange ? label.toUpperCase() : (modeNames[state.periodMode] || 'ДЕНЬ')) +
        (dates.length === 1 ? ' (' + label.toUpperCase() + ')' : '');
    }

    let totalBoxes = 0;
    let totalWeight = 0;
    let totalPay = 0;
    let totalCount = 0;

    const listEl = document.getElementById('recordsList');
    if (listEl) listEl.innerHTML = '';

    dates.forEach(function(dateKey) {
      const list = state.records[dateKey];
      if (!Array.isArray(list) || list.length === 0) return;

      list.forEach(function(rec, idx) {
        totalCount++;
        if (!rec.isOff) {
          totalBoxes += rec.boxes || 0;
          totalWeight = round1(totalWeight + (rec.weight || 0));
          totalPay = round2(totalPay + (rec.pay || 0));
        }

        if (listEl) {
          const row = document.createElement('div');
          row.className = 'rec-item' + (rec.isOff ? ' off-row' : '');

          const info = document.createElement('div');
          info.className = 'rec-text';
          if (rec.isOff) {
            info.textContent = formatDateShort(dateKey) + ': Выходной';
          } else {
            const boxPart = rec.boxes > 0 ? rec.boxes + ' кор. • ' : '';
            info.textContent = formatDateShort(dateKey) + ': ' + boxPart + rec.weight + ' кг × ' + rec.rate + ' ₽ = ' + rec.pay + ' ₽';
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'rec-del-btn';
          delBtn.textContent = '✕';
          delBtn.title = 'Удалить запись';
          delBtn.onclick = function() {
            undoStack.push(JSON.stringify(state.records));
            state.records[dateKey].splice(idx, 1);
            if (state.records[dateKey].length === 0) delete state.records[dateKey];
            saveAllStorages();
            refreshUI();
          };

          row.appendChild(info);
          row.appendChild(delBtn);
          listEl.appendChild(row);
        }
      });
    });

    const countEl = document.getElementById('recordsCountBadge');
    if (countEl) countEl.textContent = totalCount + ' ШТ.';

    const totStatsEl = document.getElementById('totalStatsLine');
    if (totStatsEl) totStatsEl.textContent = totalBoxes + ' кор. • ' + totalWeight + ' кг';

    const totPayEl = document.getElementById('totalPayLine');
    if (totPayEl) totPayEl.textContent = totalPay + ' ₽';

    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
      if (undoStack.length > 0) {
        undoBtn.style.display = 'inline-flex';
        undoBtn.textContent = '↩ Отмена (' + undoStack.length + ')';
      } else {
        undoBtn.style.display = 'none';
      }
    }

    const selLabel = document.getElementById('selectedDateLabel');
    if (selLabel) {
      const target = state.anchorDate || (dates[0] || toKey(state.viewYear, state.viewMonth, 1));
      selLabel.textContent = formatDateGen(target);
    }
  }

  function updateLiveShiftPreview() {
    const boxes = Math.round(parseNum(document.getElementById('boxesInput').value));
    const boxWeight = parseNum(document.getElementById('weightInput').value);
    const rate = parseNum(document.getElementById('rateInput').value);

    const totalW = boxes > 0 ? round1(boxes * boxWeight) : round1(boxWeight);
    const totalP = round2(totalW * rate);

    const wEl = document.getElementById('shiftWeightPreview');
    const pEl = document.getElementById('shiftPayPreview');
    if (wEl) wEl.textContent = totalW + ' кг';
    if (pEl) pEl.textContent = totalP + ' ₽';
  }

  function refreshUI() {
    document.querySelectorAll('.period-btn').forEach(function(btn) {
      btn.classList.toggle('active', !state.isCustomRange && btn.dataset.mode === state.periodMode);
    });
    renderCalendar();
    renderRecordsAndTotals();
    updateLiveShiftPreview();
  }

  function buildReport(isFull) {
    const dates = getPeriodDates();
    const label = getPeriodLabel(dates);
    const name = (state.workerName || '').trim();
    const lines = [];

    if (name) lines.push(name);

    let sumBoxes = 0;
    let sumWeight = 0;
    let sumPay = 0;
    const dayRows = [];

    dates.forEach(function(dateKey) {
      const list = state.records[dateKey];
      if (!Array.isArray(list) || list.length === 0) return;

      let dBoxes = 0;
      let dWeight = 0;
      let dPay = 0;
      let hasWork = false;
      let hasOff = false;

      list.forEach(function(r) {
        if (r.isOff) {
          hasOff = true;
        } else {
          hasWork = true;
          dBoxes += r.boxes || 0;
          dWeight = round1(dWeight + (r.weight || 0));
          dPay = round2(dPay + (r.pay || 0));
        }
      });

      if (hasWork) {
        sumBoxes += dBoxes;
        sumWeight = round1(sumWeight + dWeight);
        sumPay = round2(sumPay + dPay);
        dayRows.push(formatDateShort(dateKey) + ' | ' + dBoxes + 'кор | ' + dWeight + 'кг | ' + dPay + '₽');
      } else if (hasOff) {
        dayRows.push(formatDateShort(dateKey) + ' | Выходной');
      }
    });

    if (!isFull) {
      if (state.isCustomRange && dates.length > 1) {
        lines.push(label);
      }
      lines.push('Вес: ' + sumWeight + ' кг ' + sumBoxes + ' кор.');
      return lines.join('\n');
    }

    lines.push('Период: ' + label);
    dayRows.forEach(function(r) { lines.push(r); });
    lines.push('ИТОГ: ' + sumBoxes + 'кор | ' + sumWeight + 'кг | ' + sumPay + '₽');
    return lines.join('\n');
  }

  function copyTextSilently(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() {});
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function openReportPreview(isFull) {
    currentReportText = buildReport(isFull);
    const box = document.getElementById('reportPreviewText');
    if (box) box.textContent = currentReportText;
    const modal = document.getElementById('reportModal');
    if (modal) modal.classList.add('open');
  }

  function shareReportSystem() {
    const text = currentReportText;
    copyTextSilently(text);
    const modal = document.getElementById('reportModal');
    if (modal) modal.classList.remove('open');

    if (navigator.share) {
      navigator.share({ text: text }).catch(function() {});
      return;
    }

    try {
      const intentUrl = 'intent:#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=' +
        encodeURIComponent(text) + ';end';
      window.location.href = intentUrl;
    } catch (e) {
      showToast('Отчёт скопирован в буфер');
    }
  }

  function openConfirm(msg, onYes) {
    const textEl = document.getElementById('confirmText');
    if (textEl) textEl.textContent = msg;
    pendingConfirmAction = onYes;
    const modal = document.getElementById('confirmModal');
    if (modal) modal.classList.add('open');
  }

  function renderBackupsModal() {
    const list = getBackupsList();
    const container = document.getElementById('backupsList');
    if (!container) return;
    container.innerHTML = '';

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-msg">Сохранённых копий пока нет</div>';
      return;
    }

    list.forEach(function(bk, idx) {
      const item = document.createElement('div');
      item.className = 'backup-item';

      const meta = document.createElement('div');
      meta.className = 'backup-meta';
      const cnt = typeof bk.count === 'number' ? bk.count : countRecords(bk.data && bk.data.records);
      meta.innerHTML = '<strong>' + (bk.label || 'Копия') + '</strong><span>Записей: ' + cnt + '</span>';

      const actions = document.createElement('div');
      actions.className = 'backup-actions';

      const restBtn = document.createElement('button');
      restBtn.className = 'btn-restore-item';
      restBtn.textContent = 'Восстановить';
      restBtn.onclick = function() {
        const norm = normalizeDataset(bk.data);
        if (norm) {
          state.workerName = norm.workerName || state.workerName;
          state.defaultRate = norm.defaultRate || state.defaultRate;
          state.records = norm.records || {};
          const nameInp = document.getElementById('workerNameInput');
          const rateInp = document.getElementById('rateInput');
          if (nameInp) nameInp.value = state.workerName;
          if (rateInp) rateInp.value = state.defaultRate;
          saveAllStorages();
          refreshUI();
          document.getElementById('backupsModal').classList.remove('open');
          showToast('База восстановлена');
        }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-del-backup';
      delBtn.textContent = '✕';
      delBtn.onclick = function() {
        openConfirm('Удалить эту сохранённую базу? Вы уверены?', function() {
          const cur = getBackupsList();
          cur.splice(idx, 1);
          saveBackupsList(cur).then(function() {
            renderBackupsModal();
            showToast('Копия удалена');
          });
        });
      };

      actions.appendChild(restBtn);
      actions.appendChild(delBtn);
      item.appendChild(meta);
      item.appendChild(actions);
      container.appendChild(item);
    });
  }

  function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function runUpdateFlow() {
    if (window.location.protocol === 'file:') {
      showToast('Обновление работает только при запуске с сайта/APK');
      return;
    }

    const overlay = document.getElementById('updateOverlay');
    const stepText = document.getElementById('updateStepText');
    if (overlay) overlay.classList.add('open');

    function setStep(t) {
      if (stepText) stepText.textContent = t;
    }

    setStep('Шаг 1/4: Сохранение базы в память...');
    createBackup('(перед обн.)')
      .then(function() { return saveAllStorages(); })
      .then(function() { return delay(800); })
      .then(function() {
        setStep('Шаг 2/4: Проверка целостности данных...');
        return delay(800);
      })
      .then(function() {
        setStep('Шаг 3/4: Очистка старого кэша...');
        const tasks = [];
        if ('caches' in window) {
          tasks.push(
            caches.keys().then(function(keys) {
              return Promise.all(keys.map(function(k) { return caches.delete(k); }));
            })
          );
        }
        if ('serviceWorker' in navigator) {
          tasks.push(
            navigator.serviceWorker.getRegistrations().then(function(regs) {
              return Promise.all(regs.map(function(r) { return r.unregister(); }));
            })
          );
        }
        return Promise.all(tasks).then(function() { return delay(800); });
      })
      .then(function() {
        setStep('Шаг 4/4: Проверка новой версии на GitHub...');
        return fetch(REPO_RAW_BASE + 'app.js?t=' + Date.now(), { cache: 'no-store' })
          .then(function(r) { return r.ok ? r.text() : ''; })
          .catch(function() { return ''; });
      })
      .then(function(remoteCode) {
        const match = remoteCode.match(/APP_VERSION\s*=\s*'([^']+)'/);
        const remoteVer = match ? match[1] : '';
        if (remoteVer && remoteVer === APP_VERSION) {
          if (overlay) overlay.classList.remove('open');
          showToast('У вас актуальная версия ' + APP_VERSION);
        } else {
          setStep('Загрузка обновления...');
          setTimeout(function() {
            window.location.reload(true);
          }, 600);
        }
      });
  }

  function bindEvents() {
    document.getElementById('prevMonthBtn').onclick = function() {
      state.viewMonth--;
      if (state.viewMonth < 0) {
        state.viewMonth = 11;
        state.viewYear--;
      }
      state.isCustomRange = false;
      refreshUI();
    };

    document.getElementById('nextMonthBtn').onclick = function() {
      state.viewMonth++;
      if (state.viewMonth > 11) {
        state.viewMonth = 0;
        state.viewYear++;
      }
      state.isCustomRange = false;
      refreshUI();
    };

    document.getElementById('themeBtn').onclick = function() {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      saveAllStorages();
    };

    document.getElementById('updateBtn').onclick = runUpdateFlow;

    document.querySelectorAll('.period-btn').forEach(function(btn) {
      btn.onclick = function() {
        state.periodMode = btn.dataset.mode;
        state.isCustomRange = false;
        refreshUI();
      };
    });

    const grid = document.getElementById('daysGrid');
    function getCellDateFromEvent(e) {
      const touch = e.touches && e.touches[0] ? e.touches[0] : e;
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.classList.contains('day-cell') && el.dataset.date) {
        return el.dataset.date;
      }
      return null;
    }

    function selectRangeBetween(d1, d2) {
      if (d1 === d2) {
        state.isCustomRange = false;
        state.periodMode = 'day';
        state.anchorDate = d1;
        state.selectedDates = [d1];
        return;
      }
      const start = d1 < d2 ? d1 : d2;
      const end = d1 < d2 ? d2 : d1;
      const p1 = parseKey(start);
      const p2 = parseKey(end);
      const cur = new Date(p1.y, p1.m, p1.d);
      const stop = new Date(p2.y, p2.m, p2.d);
      const arr = [];
      while (cur <= stop) {
        arr.push(toKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
        cur.setDate(cur.getDate() + 1);
      }
      state.isCustomRange = true;
      state.anchorDate = d2;
      state.selectedDates = arr;
    }

    grid.addEventListener('pointerdown', function(e) {
      const d = e.target && e.target.dataset ? e.target.dataset.date : null;
      if (!d) return;
      isDragging = true;
      dragStartDate = d;
      selectRangeBetween(d, d);
      refreshUI();
    });

    window.addEventListener('pointermove', function(e) {
      if (!isDragging || !dragStartDate) return;
      const d = getCellDateFromEvent(e);
      if (d && d !== state.anchorDate) {
        selectRangeBetween(dragStartDate, d);
        refreshUI();
      }
    });

    window.addEventListener('pointerup', function() {
      isDragging = false;
      dragStartDate = null;
    });

    document.getElementById('dayOffBtn').onclick = function() {
      const target = state.anchorDate || state.selectedDates[0];
      if (!target) return;
      undoStack.push(JSON.stringify(state.records));
      if (!state.records[target]) state.records[target] = [];
      state.records[target].push({ isOff: true, boxes: 0, boxWeight: 0, weight: 0, rate: 0, pay: 0 });
      maybeAutoDailyBackup();
      saveAllStorages();
      refreshUI();
      showToast('Выходной отмечен');
    };

    document.getElementById('addRecordBtn').onclick = function() {
      const target = state.anchorDate || state.selectedDates[0];
      if (!target) return;
      const boxes = Math.round(parseNum(document.getElementById('boxesInput').value));
      const boxWeight = parseNum(document.getElementById('weightInput').value);
      const rate = parseNum(document.getElementById('rateInput').value) || state.defaultRate;

      const totalW = boxes > 0 ? round1(boxes * boxWeight) : round1(boxWeight);
      if (totalW <= 0) {
        showToast('Введите вес или коробки');
        return;
      }
      const totalP = round2(totalW * rate);

      undoStack.push(JSON.stringify(state.records));
      if (!state.records[target]) state.records[target] = [];
      state.records[target].push({
        isOff: false,
        boxes: boxes,
        boxWeight: boxWeight,
        weight: totalW,
        rate: rate,
        pay: totalP
      });

      document.getElementById('boxesInput').value = '';
      document.getElementById('weightInput').value = '';
      maybeAutoDailyBackup();
      saveAllStorages();
      refreshUI();
      showToast('Запись добавлена');
    };

    document.getElementById('undoBtn').onclick = function() {
      if (undoStack.length === 0) return;
      const prev = undoStack.pop();
      try {
        state.records = JSON.parse(prev);
        saveAllStorages();
        refreshUI();
        showToast('Действие отменено');
      } catch (e) {}
    };

    document.getElementById('workerNameInput').addEventListener('input', function(e) {
      state.workerName = e.target.value;
      saveAllStorages();
    });

    document.getElementById('rateInput').addEventListener('input', function(e) {
      const r = parseNum(e.target.value);
      if (r > 0) state.defaultRate = r;
      saveAllStorages();
      updateLiveShiftPreview();
    });

    document.getElementById('boxesInput').addEventListener('input', updateLiveShiftPreview);
    document.getElementById('weightInput').addEventListener('input', updateLiveShiftPreview);

    document.getElementById('fullReportBtn').onclick = function() { openReportPreview(true); };
    document.getElementById('shortReportBtn').onclick = function() { openReportPreview(false); };

    document.getElementById('cancelReportBtn').onclick = function() {
      document.getElementById('reportModal').classList.remove('open');
    };
    document.getElementById('sendReportBtn').onclick = shareReportSystem;

    document.getElementById('saveBackupBtn').onclick = function() {
      createBackup('').then(function() {
        saveAllStorages();
        showToast('База сохранена');
      });
    };

    document.getElementById('openBackupsBtn').onclick = function() {
      renderBackupsModal();
      document.getElementById('backupsModal').classList.add('open');
    };

    document.getElementById('closeBackupsBtn').onclick = function() {
      document.getElementById('backupsModal').classList.remove('open');
    };

    document.getElementById('confirmYesBtn').onclick = function() {
      document.getElementById('confirmModal').classList.remove('open');
      if (typeof pendingConfirmAction === 'function') {
        const fn = pendingConfirmAction;
        pendingConfirmAction = null;
        fn();
      }
    };

    document.getElementById('confirmNoBtn').onclick = function() {
      pendingConfirmAction = null;
      document.getElementById('confirmModal').classList.remove('open');
    };

    document.getElementById('exportCodeBtn').onclick = function() {
      const payload = JSON.stringify(serializeState());
      const encoded = btoa(unescape(encodeURIComponent(payload)));
      const area = document.getElementById('transferCodeArea');
      if (area) area.value = encoded;
      copyTextSilently(encoded);
      showToast('Код базы скопирован');
    };

    document.getElementById('importCodeBtn').onclick = function() {
      const area = document.getElementById('transferCodeArea');
      const code = area ? area.value.trim() : '';
      if (!code) {
        showToast('Вставьте код базы в поле');
        return;
      }
      try {
        const decoded = decodeURIComponent(escape(atob(code)));
        const parsed = normalizeDataset(JSON.parse(decoded));
        if (!parsed) throw new Error('bad');
        state.workerName = parsed.workerName || state.workerName;
        state.defaultRate = parsed.defaultRate || state.defaultRate;
        state.records = parsed.records || {};
        document.getElementById('workerNameInput').value = state.workerName;
        document.getElementById('rateInput').value = state.defaultRate;
        saveAllStorages();
        refreshUI();
        document.getElementById('backupsModal').classList.remove('open');
        showToast('База успешно загружена по коду');
      } catch (e) {
        showToast('Ошибка: неверный код базы');
      }
    };
  }

  function init() {
    loadInitialData().then(function() {
      applyTheme();
      const nameInp = document.getElementById('workerNameInput');
      const rateInp = document.getElementById('rateInput');
      if (nameInp) nameInp.value = state.workerName;
      if (rateInp) rateInp.value = state.defaultRate;
      bindEvents();
      refreshUI();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
