window.ObvalkaCalendar = (function() {
  const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  const MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function toKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseKey(k) {
    const p = k.split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  function formatRuDay(k) {
    const d = parseKey(k);
    return d.getDate() + " " + MONTHS_GEN[d.getMonth()];
  }
  function formatShortDay(k) {
    const d = parseKey(k);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  function render(state, onSelectRange) {
    const grid = document.getElementById("daysGrid");
    const label = document.getElementById("monthLabel");
    if (!grid || !label) return;
    label.textContent = MONTHS[state.viewMonth] + " " + state.viewYear;
    grid.innerHTML = "";

    const firstDay = new Date(state.viewYear, state.viewMonth, 1);
    let startOffset = firstDay.getDay() - 1;
    if (startOffset < 0) startOffset = 6;
    const startDate = new Date(state.viewYear, state.viewMonth, 1 - startOffset);

    let dragging = false;
    let dragStart = null;

    for (let i = 0; i < 42; i++) {
      const cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const key = toKey(cur);
      const cell = document.createElement("div");
      cell.className = "day-cell";
      if (cur.getMonth() !== state.viewMonth) cell.classList.add("other");

      if (state.rangeStart && state.rangeEnd) {
        if (key === state.rangeStart || key === state.rangeEnd) cell.classList.add("selected");
        else if (key > state.rangeStart && key < state.rangeEnd) cell.classList.add("in-range");
      } else if (key === state.selectedDate) {
        cell.classList.add("selected");
      }

      const num = document.createElement("span");
      num.textContent = cur.getDate();
      cell.appendChild(num);

      const dayRecs = state.records.filter(function(r) { return r.date === key; });
      if (dayRecs.length > 0) {
        const dot = document.createElement("div");
        dot.className = "day-dot";
        if (dayRecs.some(function(r) { return r.isOff; })) dot.classList.add("off");
        cell.appendChild(dot);
      }

      cell.dataset.key = key;
      cell.addEventListener("pointerdown", function(e) {
        e.preventDefault();
        dragging = true;
        dragStart = key;
        onSelectRange(key, key, false);
      });
      cell.addEventListener("pointerenter", function() {
        if (dragging && dragStart) {
          const a = dragStart < key ? dragStart : key;
          const b = dragStart < key ? key : dragStart;
          onSelectRange(a, b, true);
        }
      });
      grid.appendChild(cell);
    }

    const stopDrag = function() { dragging = false; dragStart = null; };
    window.removeEventListener("pointerup", stopDrag);
    window.addEventListener("pointerup", stopDrag);
  }

  return { render: render, toKey: toKey, parseKey: parseKey, formatRuDay: formatRuDay, formatShortDay: formatShortDay };
})();
