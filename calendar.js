(function () {
  var gridEl = null;
  var isDragging = false;
  var dragStart = null;
  var touchStartX = 0;
  var touchStartY = 0;

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function toKey(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }

  function getState() {
    if (window.ObvalkaState) return window.ObvalkaState;
    var now = new Date();
    window.ObvalkaState = {
      viewYear: now.getFullYear(),
      viewMonth: now.getMonth(),
      selectedStart: toKey(now.getFullYear(), now.getMonth(), now.getDate()),
      selectedEnd: toKey(now.getFullYear(), now.getMonth(), now.getDate()),
      periodMode: "day",
      records: {}
    };
    return window.ObvalkaState;
  }

  function isBetween(k, a, b) {
    var minK = a <= b ? a : b;
    var maxK = a <= b ? b : a;
    return k >= minK && k <= maxK;
  }

  function notifyChange(isManualRange) {
    if (typeof window.onObvalkaRangeChange === "function") {
      window.onObvalkaRangeChange(isManualRange);
    }
  }

  function renderCalendarGrid() {
    gridEl = document.getElementById("calendarGrid");
    if (!gridEl) return;

    var st = getState();
    var y = st.viewYear;
    var m = st.viewMonth;

    var firstDay = new Date(y, m, 1).getDay();
    var offset = (firstDay + 6) % 7;
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var prevDays = new Date(y, m, 0).getDate();

    var now = new Date();
    var todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());

    var html = [];
    var totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;

    for (var i = 0; i < totalCells; i++) {
      var cellY = y;
      var cellM = m;
      var cellD = 1;
      var otherMonth = false;

      if (i < offset) {
        otherMonth = true;
        cellD = prevDays - offset + 1 + i;
        cellM = m - 1;
        if (cellM < 0) {
          cellM = 11;
          cellY = y - 1;
        }
      } else if (i >= offset + daysInMonth) {
        otherMonth = true;
        cellD = i - offset - daysInMonth + 1;
        cellM = m + 1;
        if (cellM > 11) {
          cellM = 0;
          cellY = y + 1;
        }
      } else {
        cellD = i - offset + 1;
      }

      var k = toKey(cellY, cellM, cellD);
      var classes = ["day-cell"];
      if (otherMonth) classes.push("other-month");
      if (k === todayKey) classes.push("today");
      if (isBetween(k, st.selectedStart, st.selectedEnd)) {
        classes.push("selected");
        if (k === st.selectedStart || k === st.selectedEnd) {
          classes.push("selected-edge");
        }
      }

      var recs = st.records && st.records[k] ? st.records[k] : [];
      var dotHtml = "";
      if (recs.length > 0) {
        var hasOff = false;
        var hasWork = false;
        for (var r = 0; r < recs.length; r++) {
          if (recs[r] && recs[r].isOff) hasOff = true;
          else hasWork = true;
        }
        if (hasWork) {
          dotHtml = '<span class="day-dot work"></span>';
        } else if (hasOff) {
          dotHtml = '<span class="day-dot off"></span>';
        }
      }

      html.push(
        '<div class="' + classes.join(" ") + '" data-date="' + k + '">' +
        '<span>' + cellD + '</span>' +
        dotHtml +
        '</div>'
      );
    }

    gridEl.innerHTML = html.join("");
  }

  function handleSelectStart(dateKey) {
    if (!dateKey) return;
    var st = getState();
    isDragging = true;
    dragStart = dateKey;
    st.selectedStart = dateKey;
    st.selectedEnd = dateKey;
    st.periodMode = "day";
    renderCalendarGrid();
    notifyChange(false);
  }

  function handleSelectMove(dateKey) {
    if (!isDragging || !dateKey || !dragStart) return;
    var st = getState();
    if (dateKey <= dragStart) {
      st.selectedStart = dateKey;
      st.selectedEnd = dragStart;
    } else {
      st.selectedStart = dragStart;
      st.selectedEnd = dateKey;
    }
    st.periodMode = st.selectedStart === st.selectedEnd ? "day" : "custom";
    renderCalendarGrid();
    notifyChange(st.selectedStart !== st.selectedEnd);
  }

  function handleSelectEnd() {
    if (!isDragging) return;
    isDragging = false;
    var st = getState();
    notifyChange(st.selectedStart !== st.selectedEnd);
  }

  function bindGridEvents() {
    var el = document.getElementById("calendarGrid");
    if (!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";

    el.addEventListener("mousedown", function (e) {
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      handleSelectStart(cell.getAttribute("data-date"));
    });

    el.addEventListener("mouseover", function (e) {
      if (!isDragging) return;
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      handleSelectMove(cell.getAttribute("data-date"));
    });

    window.addEventListener("mouseup", function () {
      handleSelectEnd();
    });

    el.addEventListener("touchstart", function (e) {
      if (!e.touches || e.touches.length === 0) return;
      var t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      var cell = e.target.closest(".day-cell");
      if (!cell) return;
      handleSelectStart(cell.getAttribute("data-date"));
    }, { passive: true });

    el.addEventListener("touchmove", function (e) {
      if (!isDragging || !e.touches || e.touches.length === 0) return;
      var t = e.touches[0];
      if (Math.abs(t.clientX - touchStartX) > 6 || Math.abs(t.clientY - touchStartY) > 6) {
        if (e.cancelable) e.preventDefault();
      }
      var target = document.elementFromPoint(t.clientX, t.clientY);
      if (!target) return;
      var cell = target.closest(".day-cell");
      if (!cell) return;
      handleSelectMove(cell.getAttribute("data-date"));
    }, { passive: false });

    el.addEventListener("touchend", function () {
      handleSelectEnd();
    });
  }

  function bootCalendar() {
    renderCalendarGrid();
    bindGridEvents();
  }

  window.renderCalendarGrid = renderCalendarGrid;
  window.bootCalendar = bootCalendar;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootCalendar);
  } else {
    bootCalendar();
  }
})();
