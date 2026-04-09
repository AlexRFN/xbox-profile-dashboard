// === heatmap.js ===
// Heatmap tooltip and drag-to-range selection.
// Delegated on .heatmap-card — survives htmx content swaps.
// globals: initHeatmapTooltip

let _hmDrag = null;
let _hmObsRef = null;
let _hmMouseupInit = false;

function initHeatmapTooltip() {
    if (_hmObsRef) { _hmObsRef.disconnect(); _hmObsRef = null; }
    const card = document.querySelector('.heatmap-card');
    if (!card) return;
    function getCell(el) {
        return el?.closest?.('.hm-cell:not(.hm-hidden):not(.hm-legend-cell)') || null;
    }

    // --- Tooltip ---
    card.addEventListener('mouseover', (e) => {
        if (_hmDrag) return;
        const cell = getCell(e.target);
        if (!cell || !cell.dataset.date) return;
        const tooltip = card.querySelector('.heatmap-tooltip');
        if (!tooltip) return;
        const count = parseInt(cell.dataset.count, 10) || 0;
        const d = new Date(cell.dataset.date + 'T00:00:00');
        const formatted = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        tooltip.textContent = count === 0
            ? `No achievements on ${formatted}`
            : `${count} achievement${count !== 1 ? 's' : ''} on ${formatted}`;
        const cardRect = card.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        tooltip.classList.add('visible');
        const tipW = tooltip.offsetWidth;
        const tipH = tooltip.offsetHeight;
        let left = cellRect.left - cardRect.left + cellRect.width / 2 - tipW / 2;
        left = Math.max(4, Math.min(left, cardRect.width - tipW - 4));
        let top = cellRect.top - cardRect.top - tipH - 6;
        if (top < 0) top = cellRect.bottom - cardRect.top + 6;
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    }, { passive: true });

    card.addEventListener('mouseout', (e) => {
        if (!e.target.closest('.hm-cell')) return;
        const tooltip = card.querySelector('.heatmap-tooltip');
        if (tooltip) tooltip.classList.remove('visible');
    }, { passive: true });

    // --- Drag selection helpers ---
    // Cache heatmap cells — re-query only when content swaps (MutationObserver)
    let _hmCells = Array.from(card.querySelectorAll('.hm-cell[data-date]'));
    _hmObsRef = new MutationObserver(() => {
        _hmCells = Array.from(card.querySelectorAll('.hm-cell[data-date]'));
    });
    _hmObsRef.observe(card, { childList: true, subtree: true });

    function highlightRange(from, to) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        for (let i = 0; i < _hmCells.length; i++) {
            const cell = _hmCells[i];
            cell.classList.toggle('hm-selected',
                !cell.classList.contains('hm-hidden') && cell.dataset.date >= lo && cell.dataset.date <= hi);
        }
    }

    function clearHighlight() {
        _hmCells.forEach(cell => cell.classList.remove('hm-selected'));
    }

    function finishDrag() {
        if (!_hmDrag) return;
        const { start, end } = _hmDrag;
        _hmDrag = null;
        card.classList.remove('hm-dragging');
        clearHighlight();
        const [from, to] = start <= end ? [start, end] : [end, start];
        const hasAct = Array.from(card.querySelectorAll('.hm-cell[data-count]')).some(c =>
            c.dataset.date >= from && c.dataset.date <= to && parseInt(c.dataset.count) > 0);
        if (hasAct) {
            startFullNav('/timeline?date_from=' + from + '&date_to=' + to);
        }
    }

    // --- Desktop: mousedown → drag → mouseup ---
    card.addEventListener('mousedown', (e) => {
        const cell = getCell(e.target);
        if (!cell) return;
        e.preventDefault();
        const tooltip = card.querySelector('.heatmap-tooltip');
        if (tooltip) tooltip.classList.remove('visible');
        _hmDrag = { start: cell.dataset.date, end: cell.dataset.date };
        card.classList.add('hm-dragging');
        highlightRange(cell.dataset.date, cell.dataset.date);
    });

    card.addEventListener('mousemove', (e) => {
        if (!_hmDrag) return;
        const cell = getCell(e.target);
        if (!cell || cell.dataset.date === _hmDrag.end) return;
        _hmDrag.end = cell.dataset.date;
        highlightRange(_hmDrag.start, _hmDrag.end);
    });

    if (!_hmMouseupInit) {
        _hmMouseupInit = true;
        document.addEventListener('mouseup', () => {
            if (_hmDrag) finishDrag();
        });
    }

    // --- Mobile: longpress (400ms) → drag ---
    let longPressTimer = null;

    card.addEventListener('touchstart', (e) => {
        const cell = getCell(e.target);
        if (!cell) return;
        const startDate = cell.dataset.date;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            _hmDrag = { start: startDate, end: startDate };
            card.classList.add('hm-dragging');
            highlightRange(startDate, startDate);
            if (navigator.vibrate) navigator.vibrate(30);
        }, 400);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
        if (!_hmDrag) { clearTimeout(longPressTimer); return; }
        e.preventDefault();
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const cell = getCell(el);
        if (!cell || cell.dataset.date === _hmDrag.end) return;
        _hmDrag.end = cell.dataset.date;
        highlightRange(_hmDrag.start, _hmDrag.end);
    }, { passive: false });

    card.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        if (_hmDrag) finishDrag();
    });

    card.addEventListener('touchcancel', () => {
        clearTimeout(longPressTimer);
        _hmDrag = null;
        card.classList.remove('hm-dragging');
        clearHighlight();
    });
}
