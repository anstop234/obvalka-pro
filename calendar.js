(function(){
  const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const state = {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    period: 'day',
    startDate: null,
    endDate: null,
    isDragging: false,
    dragStart: null,
    records: {}
  };

  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function toKey(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromKey(k){ const p = k.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }

  if (!state.startDate) {
    const today = toKey(new Date());
    state.startDate = today;
    state.endDate = today;
  }

  function renderCalendar() {
    const grid = document.getElementById('calGrid') || document.querySelector('.cal-grid');
    if (!grid) return;

    const titleEl = document.getElementById('calTitle') || document.querySelector('.cal-title');
    if (titleEl) {
      const verSpan = titleEl.querySelector('.ver-tag, span');
      const verHTML = verSpan ? ' ' + verSpan.outerHTML : '';
      titleEl.innerHTML = MONTHS[state.month] + ' ' + state.year + verHTML;
    }

    const firstDay = new Date(state.year, state.month, 1);
    let startOffset = firstDay.getDay() - 1;
    if (startOffset < 0) startOffset = 6;

    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
    const prevMonthDays = new Date(state.year, state.month, 0).getDate();

    const s1 = state.startDate || '';
    const s2 = state.endDate || s1;
    const minK = s1 <= s2 ? s1 : s2;
    const maxK = s1 <= s2 ? s2 : s1;

    let html = '';
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
      let dayNum, m = state.month, y = state.year, isOther = false;
      if (i < startOffset) {
        dayNum = prevMonthDays - startOffset + i + 1;
        m = state.month - 1;
        if (m < 0) { m = 11; y--; }
        isOther = true;
      } else if (i >= startOffset + daysInMonth) {
        dayNum = i - (startOffset + daysInMonth) + 1;
        m = state.month + 1;
        if (m > 11) { m = 0; y++; }
        isOther = true;
      } else {
        dayNum = i - startOffset + 1;
      }

      const key = y + '-' + pad(m + 1) + '-' + pad(dayNum);
      let cls = 'day-cell';
      if (isOther) cls += ' other-month';
      if (minK && maxK && key >= minK && key <= maxK) {
        cls += (key === minK || key === maxK) ? ' selected active' : ' in-range selected';
      }

      const recs = state.records[key] || [];
      let dotHTML = '';
      if (recs.length > 0) {
        const isOff = recs.some(r => r.isOff || r.off || (Number(r.boxes || r.b || 0) === 0 && Number(r.weight || r.totalWeight || r.w || 0) === 0));
        dotHTML = '<span class="day-dot ' + (isOff ? 'off' : 'work') + '"></span>';
      }

      html += '<div class="' + cls + '" data-date="' + key + '">' + dayNum + dotHTML + '</div>';
    }

    grid.innerHTML = html;
  }

  function notifyApp() {
    if (typeof window.onCalendarChange === 'function') {
      window.onCalendarChange({
        year: state.year,
        month: state.month,
        period: state.period,
        startDate: state.startDate,
        endDate: state.endDate
      });
    }
    document.dispatchEvent(new CustomEvent('calendar:change', { detail: Object.assign({}, state) }));
  }

  function setPeriodRange(period) {
    state.period = period;
    const base = state.startDate ? fromKey(state.startDate) : new Date(state.year, state.month, 1);
    if (period === 'day') {
      const k = toKey(base);
      state.startDate = k; state.endDate = k;
    } else if (period === 'week') {
      const dow = (base.getDay() + 6) % 7;
      const mon = new Date(base); mon.setDate(base.getDate() - dow);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      state.startDate = toKey(mon); state.endDate = toKey(sun);
    } else if (period === '2weeks') {
      const d = base.getDate();
      const y = base.getFullYear(), m = base.getMonth();
      if (d <= 15) {
        state.startDate = toKey(new Date(y, m, 1));
        state.endDate = toKey(new Date(y, m, 15));
      } else {
        state.startDate = toKey(new Date(y, m, 16));
        state.endDate = toKey(new Date(y, m + 1, 0));
      }
    } else if (period === 'month') {
      state.startDate = toKey(new Date(state.year, state.month, 1));
      state.endDate = toKey(new Date(state.year, state.month + 1, 0));
    } else if (period === 'year') {
      state.startDate = toKey(new Date(state.year, 0, 1));
      state.endDate = toKey(new Date(state.year, 11, 31));
    }
    renderCalendar();
    notifyApp();
  }

  function bindEvents() {
    const grid = document.getElementById('calGrid') || document.querySelector('.cal-grid');
    if (grid) {
      grid.addEventListener('pointerdown', function(e) {
        const cell = e.target.closest('.day-cell');
        if (!cell) return;
        const d = cell.getAttribute('data-date');
        state.isDragging = true;
        state.dragStart = d;
        state.startDate = d;
        state.endDate = d;
        state.period = 'day';
        renderCalendar();
        notifyApp();
      });

      grid.addEventListener('pointermove', function(e) {
        if (!state.isDragging) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el && el.closest('.day-cell');
        if (!cell) return;
        const d = cell.getAttribute('data-date');
        if (d && d !== state.endDate) {
          state.endDate = d;
          renderCalendar();
          notifyApp();
        }
      });

      window.addEventListener('pointerup', function() {
        if (state.isDragging) {
          state.isDragging = false;
          if (state.startDate > state.endDate) {
            const tmp = state.startDate;
            state.startDate = state.endDate;
            state.endDate = tmp;
          }
          renderCalendar();
          notifyApp();
        }
      });
    }

    const prevBtn = document.getElementById('prevMonth') || document.querySelector('[data-dir="-1"]');
    const nextBtn = document.getElementById('nextMonth') || document.querySelector('[data-dir="1"]');
    if (prevBtn) prevBtn.addEventListener('click', function() {
      state.month--;
      if (state.month < 0) { state.month = 11; state.year--; }
      if (state.period === 'month' || state.period === 'year') setPeriodRange(state.period);
      else { renderCalendar(); notifyApp(); }
    });
    if (nextBtn) nextBtn.addEventListener('click', function() {
      state.month++;
      if (state.month > 11) { state.month = 0; state.year++; }
      if (state.period === 'month' || state.period === 'year') setPeriodRange(state.period);
      else { renderCalendar(); notifyApp(); }
    });

    document.querySelectorAll('[data-period]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setPeriodRange(btn.getAttribute('data-period'));
      });
    });
  }

  window.ObvalkaCalendar = {
    render: renderCalendar,
    setRecords: function(recs) { state.records = recs || {}; renderCalendar(); },
    setRange: function(s, e, p) {
      if (s) { state.startDate = s; const d = fromKey(s); state.year = d.getFullYear(); state.month = d.getMonth(); }
      if (e) state.endDate = e;
      if (p) state.period = p;
      renderCalendar();
    },
    getState: function() { return Object.assign({}, state); }
  };

  function init() {
    renderCalendar();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
