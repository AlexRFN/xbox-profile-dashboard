// === timeline.js ===
// Timeline: quick nav pills, date filters, calendar picker (cross-month range),
// continuation fix (adopts loose events after Load More).
// globals: setTimelineRange, clearTimelineFilters, clearDateFilter,
//          initTimelineContinuationFix, initTimelineCalendar,
//          calGo, calNav, openCal, closeCal, calCancelRange, updateCalStatus, highlightCalRange

// --- Timeline quick nav pills ---
function _localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function setTimelineRange(btn) {
    const range = btn.dataset.range;
    const fromEl = document.getElementById('timeline-date-from');
    const toEl = document.getElementById('timeline-date-to');
    if (!fromEl || !toEl) return;

    const now = new Date();
    let dateFrom = '', dateTo = '';

    if (range === 'this-month') {
        dateFrom = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
        dateTo = _localDateStr(now);
    } else if (range === 'last-month') {
        const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        dateFrom = _localDateStr(lm);
        dateTo = _localDateStr(lmEnd);
    } else if (range === 'this-year') {
        dateFrom = now.getFullYear() + '-01-01';
        dateTo = _localDateStr(now);
    }
    // 'all' clears both

    fromEl.value = dateFrom;
    toEl.value = dateTo;

    // Update active pill
    btn.closest('.quick-nav-pills').querySelectorAll('.quick-nav-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');

    // Clear the calendar filter pill if exists
    const pill = document.querySelector('#timeline-filters .filter-pill');
    if (pill) pill.remove();

    // Trigger htmx reload via the event_type select (has hx-trigger="change" + hx-include)
    const typeSelect = document.querySelector('#timeline-filters [name="event_type"]');
    if (typeSelect) {
        htmx.trigger(typeSelect, 'change');
    }
}

function _resetQuickNavPills() {
    document.querySelectorAll('.quick-nav-pill').forEach(p => p.classList.toggle('active', p.dataset.range === 'all'));
}

// --- Clear timeline filters ---
function clearTimelineFilters() {
    const filters = document.getElementById('timeline-filters');
    if (!filters) return;
    filters.querySelectorAll('input, select').forEach(el => { el.value = ''; });
    const pill = filters.querySelector('.filter-pill');
    if (pill) pill.remove();
    _resetQuickNavPills();
    const typeSelect = filters.querySelector('[name="event_type"]');
    if (typeSelect) htmx.trigger(typeSelect, 'change');
}

function clearDateFilter() {
    const from = document.getElementById('timeline-date-from');
    const to = document.getElementById('timeline-date-to');
    if (from) from.value = '';
    if (to) to.value = '';
    const pill = document.querySelector('#timeline-filters .filter-pill');
    if (pill) pill.remove();
    _resetQuickNavPills();
    // Also clear URL params
    const url = new URL(window.location);
    url.searchParams.delete('date');
    url.searchParams.delete('date_from');
    url.searchParams.delete('date_to');
    history.replaceState(null, '', url);
    const typeSelect = document.querySelector('#timeline-filters [name="event_type"]');
    if (typeSelect) htmx.trigger(typeSelect, 'change');
}

// --- Floating timeline month header ---
// After Load More, the htmx partial appends continuation events as loose children
// of #timeline (outside any .timeline-month). This function moves them into the
// last .timeline-month so the sticky header keeps working naturally — no floating
// clone needed.
let _timelineContFixInit = false;
function initTimelineContinuationFix() {
    if (_timelineContFixInit) return;
    if (!document.getElementById('timeline')) return;
    _timelineContFixInit = true;

    function adoptLooseEvents() {
        const timeline = document.getElementById('timeline');
        if (!timeline) return;
        // Find all .timeline-event that are direct children of #timeline (not inside .timeline-month)
        const loose = timeline.querySelectorAll(':scope > .timeline-event');
        if (!loose.length) return;

        // Find the last .timeline-month that precedes the first loose event
        let target = null;
        let node = loose[0].previousElementSibling;
        while (node) {
            if (node.classList.contains('timeline-month')) { target = node; break; }
            node = node.previousElementSibling;
        }
        if (!target) return;

        // Move each loose event into the target month container
        for (const ev of loose) {
            target.appendChild(ev);
        }
    }

    document.body.addEventListener('htmx:afterSettle', () => {
        requestAnimationFrame(adoptLooseEvents);
    });
}

// --- Timeline calendar picker ---
// rangeStart: date string when first click of a cross-month range is pending
const _cal = { el: null, dropdown: null, visible: false, year: 0, month: 0, cache: {}, drag: null, rangeStart: null };
const _calMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];

let _calDocClickInit = false;
let _calMouseupInit = false;
function initTimelineCalendar() {
    const container = document.getElementById('timeline-calendar');
    if (!container) return;
    _cal.el = container;
    _cal.dropdown = container.querySelector('.calendar-dropdown');
    const now = new Date();
    _cal.year = now.getFullYear();
    _cal.month = now.getMonth();

    container.querySelector('.calendar-toggle-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        _cal.visible ? closeCal() : openCal();
    });

    if (!_calDocClickInit) {
        _calDocClickInit = true;
        document.addEventListener('click', (e) => {
            if (_cal.visible && _cal.el && _cal.el.isConnected && e.target.isConnected && !_cal.el.contains(e.target)) closeCal();
        });
    }

    function getDay(el) {
        return el?.closest?.('.cal-day:not(.cal-empty):not(.cal-future)') || null;
    }

    // Click: first click sets rangeStart, second click completes range.
    // If both clicks are same day, navigate as single day.
    // Drag within a month still works for quick same-month ranges.
    _cal.dropdown.addEventListener('mousedown', (e) => {
        const day = getDay(e.target);
        if (!day) return;
        e.preventDefault();
        _cal.drag = { start: day.dataset.date, end: day.dataset.date, moved: false };
        highlightCalRange(day.dataset.date, day.dataset.date);
    });

    _cal.dropdown.addEventListener('mousemove', (e) => {
        if (!_cal.drag) {
            // Hover preview when rangeStart is pending
            if (_cal.rangeStart) {
                const day = getDay(e.target);
                if (day) highlightCalRange(_cal.rangeStart, day.dataset.date);
            }
            return;
        }
        const day = getDay(e.target);
        if (!day || day.dataset.date === _cal.drag.end) return;
        _cal.drag.moved = true;
        _cal.drag.end = day.dataset.date;
        // If rangeStart pending, extend from that instead
        const from = _cal.rangeStart || _cal.drag.start;
        highlightCalRange(from, day.dataset.date);
    });

    if (!_calMouseupInit) {
        _calMouseupInit = true;
        document.addEventListener('mouseup', () => {
            if (!_cal.drag) return;
            const { start, end, moved } = _cal.drag;
            _cal.drag = null;

            if (moved) {
                // Dragged within month — complete the range (include rangeStart if pending)
                const from = _cal.rangeStart || start;
                _cal.rangeStart = null;
                const [lo, hi] = from <= end ? [from, end] : [end, from];
                calGo(lo, hi);
            } else {
                // Simple click
                if (_cal.rangeStart) {
                    // Second click — complete cross-month range
                    const [lo, hi] = _cal.rangeStart <= start ? [_cal.rangeStart, start] : [start, _cal.rangeStart];
                    _cal.rangeStart = null;
                    calGo(lo, hi);
                } else {
                    // First click — set as range start, wait for second
                    _cal.rangeStart = start;
                    highlightCalRange(start, start);
                    updateCalStatus();
                }
            }
        });
    }

    // Touch: quick tap = single day or range end, longpress = begin drag
    let calLP = null;
    _cal.dropdown.addEventListener('touchstart', (e) => {
        const day = getDay(e.target);
        if (!day) return;
        const d = day.dataset.date;
        clearTimeout(calLP);
        calLP = setTimeout(() => {
            calLP = null;
            _cal.drag = { start: d, end: d, moved: false };
            const from = _cal.rangeStart || d;
            highlightCalRange(from, d);
            if (navigator.vibrate) navigator.vibrate(30);
        }, 400);
    }, { passive: true });

    _cal.dropdown.addEventListener('touchmove', (e) => {
        if (!_cal.drag) { clearTimeout(calLP); return; }
        e.preventDefault();
        const touch = e.touches[0];
        const day = getDay(document.elementFromPoint(touch.clientX, touch.clientY));
        if (!day || day.dataset.date === _cal.drag.end) return;
        _cal.drag.moved = true;
        _cal.drag.end = day.dataset.date;
        const from = _cal.rangeStart || _cal.drag.start;
        highlightCalRange(from, day.dataset.date);
    }, { passive: false });

    _cal.dropdown.addEventListener('touchend', (e) => {
        if (_cal.drag) {
            const { start, end, moved } = _cal.drag;
            _cal.drag = null;
            if (moved) {
                const from = _cal.rangeStart || start;
                _cal.rangeStart = null;
                const [lo, hi] = from <= end ? [from, end] : [end, from];
                calGo(lo, hi);
            } else {
                // Longpress without drag = set range start
                if (_cal.rangeStart) {
                    const [lo, hi] = _cal.rangeStart <= start ? [_cal.rangeStart, start] : [start, _cal.rangeStart];
                    _cal.rangeStart = null;
                    calGo(lo, hi);
                } else {
                    _cal.rangeStart = start;
                    highlightCalRange(start, start);
                    updateCalStatus();
                }
            }
        } else if (calLP) {
            clearTimeout(calLP);
            calLP = null;
            const day = getDay(e.target);
            if (!day) return;
            if (_cal.rangeStart) {
                const [lo, hi] = _cal.rangeStart <= day.dataset.date ? [_cal.rangeStart, day.dataset.date] : [day.dataset.date, _cal.rangeStart];
                _cal.rangeStart = null;
                calGo(lo, hi);
            } else {
                calGo(day.dataset.date, day.dataset.date);
            }
        }
    });
}

function calGo(from, to) {
    startFullNav('/timeline?date_from=' + from + '&date_to=' + to);
}

let _calDayCache = null;
function highlightCalRange(from, to) {
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    if (!_calDayCache) _calDayCache = _cal.dropdown.querySelectorAll('.cal-day[data-date]');
    _calDayCache.forEach(d => {
        const inRange = d.dataset.date >= lo && d.dataset.date <= hi;
        const isAnchor = _cal.rangeStart && d.dataset.date === _cal.rangeStart;
        d.classList.toggle('cal-selected', inRange);
        d.classList.toggle('cal-range-anchor', isAnchor);
    });
}

function updateCalStatus() {
    let bar = _cal.dropdown.querySelector('.cal-status');
    if (_cal.rangeStart) {
        const d = new Date(_cal.rangeStart + 'T00:00:00');
        const label = _calMonths[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear();
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'cal-status';
            _cal.dropdown.appendChild(bar);
        }
        bar.innerHTML = 'From <strong>' + label + '</strong> — click end date <button class="cal-cancel-range" onclick="calCancelRange()">Cancel</button>';
    } else if (bar) {
        bar.remove();
    }
}

function calCancelRange() {
    _cal.rangeStart = null;
    _cal.dropdown.querySelectorAll('.cal-day').forEach(d => {
        d.classList.remove('cal-selected', 'cal-range-anchor');
    });
    const bar = _cal.dropdown.querySelector('.cal-status');
    if (bar) bar.remove();
}

function openCal() {
    _cal.visible = true;
    _cal.rangeStart = null;
    _cal.dropdown.classList.add('open');
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    renderCal();
}

function closeCal() {
    _cal.visible = false;
    _cal.rangeStart = null;
    _cal.dropdown.classList.remove('open');
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    _calDayCache = null;
}

function calNav(delta) {
    _cal.month += delta;
    if (_cal.month < 0) { _cal.month = 11; _cal.year--; }
    if (_cal.month > 11) { _cal.month = 0; _cal.year++; }
    renderCal();
}

async function renderCal() {
    const { year, month } = _cal;
    const key = year + '-' + month;
    if (!_cal.cache[key]) {
        try {
            const r = await fetch('/api/activity/month?year=' + year + '&month=' + (month + 1));
            _cal.cache[key] = await r.json();
        } catch { _cal.cache[key] = {}; }
    }
    const activity = _cal.cache[key];
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);
    const mm = String(month + 1).padStart(2, '0');

    let html = '<div class="cal-header">' +
        '<button class="cal-nav" onclick="calNav(-1)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg></button>' +
        '<span class="cal-title">' + _calMonths[month] + ' ' + year + '</span>' +
        '<button class="cal-nav" onclick="calNav(1)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>' +
        '</div><div class="cal-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div><div class="cal-days">';

    for (let i = 0; i < firstDow; i++) html += '<div class="cal-day cal-empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const ds = year + '-' + mm + '-' + String(d).padStart(2, '0');
        const count = activity[d] || 0;
        const future = ds > todayStr;
        const today = ds === todayStr;
        let cls = 'cal-day';
        if (future) cls += ' cal-future';
        if (today) cls += ' cal-today';
        if (count > 0) cls += ' cal-active';
        // Mark as selected/anchor if rangeStart is pending and this day is in range
        if (_cal.rangeStart) {
            if (ds === _cal.rangeStart) cls += ' cal-range-anchor cal-selected';
        }
        html += '<div class="' + cls + '" data-date="' + ds + '" data-count="' + count + '">' +
            '<span class="cal-day-num">' + d + '</span>' +
            (count > 0 ? '<span class="cal-dot" title="' + count + ' achievement' + (count !== 1 ? 's' : '') + '"></span>' : '') +
            '</div>';
    }
    html += '</div>';
    _cal.dropdown.innerHTML = html;
    _calDayCache = null; // invalidate cached NodeList after DOM rebuild
    updateCalStatus();
}
