// === reveal.js ===
// Fluent Reveal Highlight: tracks mouse and applies radial light gradient on cards/rows.
// globals: initRevealHighlight

// Tracks mouse position and applies a radial light gradient on cards/rows
let _revealPending = null;
function _revealRaf() {
    const p = _revealPending;
    if (!p) return;
    _revealPending = null;
    const rect = p.rect;
    const x = p.cx - rect.left;
    const y = p.cy - rect.top;
    p.item.style.setProperty('--reveal-x', x + 'px');
    p.item.style.setProperty('--reveal-y', y + 'px');
    const relX = (x / rect.width * 2 - 1) * 5;
    const relY = (y / rect.height * 2 - 1) * 5;
    p.item.style.setProperty('--rim-x', relX.toFixed(1) + 'px');
    p.item.style.setProperty('--rim-y', relY.toFixed(1) + 'px');
}

function initRevealHighlight(root) {
    const scope = root || document;
    if (_revealFinePointer) _initRevealScrollWatch();
    // rAF-batched: coalesce rapid mousemove into one layout read per frame
    function _revealMove(item, e) {
        if (!_revealCanTrack()) return;
        const schedule = !_revealPending;
        _revealPending = { item, cx: e.clientX, cy: e.clientY, rect: item.getBoundingClientRect() };
        if (schedule) requestAnimationFrame(_revealRaf);
    }

    scope.querySelectorAll('.reveal-container').forEach(container => {
        if (container.dataset.revealInit) return;
        container.dataset.revealInit = '1';
        if (!_revealFinePointer) return;
        container.addEventListener('mousemove', (e) => {
            const item = e.target.closest('.reveal-item');
            if (!item) return;
            _revealMove(item, e);
        });
    });

    // Standalone reveal items (not in a container)
    scope.querySelectorAll('.reveal-item:not(.reveal-container .reveal-item)').forEach(item => {
        if (item.dataset.revealInit) return;
        item.dataset.revealInit = '1';
        if (!_revealFinePointer) return;
        item.addEventListener('mousemove', (e) => _revealMove(item, e));
    });

    // Auto-init reveal for interactive elements (buttons, nav, badges, inputs, cards)
    scope.querySelectorAll('.nav-link, .nav-profile-chip, .view-btn, button.outline, a.outline, .theme-toggle, .rate-limit-badge, .library-filter-input, .ach-card, .rarity-strip-item, .captures-game-header, .quick-nav-pill, .hm-tab, .hm-year-btn').forEach(item => {
        if (item.dataset.revealInit) return;
        item.classList.add('reveal-item');
        item.dataset.revealInit = '1';
        if (!_revealFinePointer) return;
        item.addEventListener('mousemove', (e) => _revealMove(item, e));
    });

    // Grid-rows mode: rows are reveal-items — delegate on the grid-rows container
    scope.querySelectorAll('.grid-rows').forEach(wrap => {
        // Mark rows as reveal-items (needed for CSS pseudo-elements)
        wrap.querySelectorAll('.game-row, .recent-row').forEach(row => {
            if (!row.classList.contains('reveal-item')) row.classList.add('reveal-item');
        });
        // Single delegated listener instead of per-row
        if (!wrap.dataset.revealInit) {
            wrap.dataset.revealInit = '1';
            if (!_revealFinePointer) return;
            wrap.addEventListener('mousemove', (e) => {
                const row = e.target.closest('.game-row, .recent-row');
                if (row) _revealMove(row, e);
            });
        }
    });
    // Standard table mode fallback — event delegation on tbody
    scope.querySelectorAll('#library-table-wrap:not(.grid-rows) #game-table-body, .recent-table-wrap:not(.grid-rows) .recent-table tbody').forEach(tbody => {
        if (tbody.dataset.rowGlow) return;
        tbody.dataset.rowGlow = '1';
        if (!_revealFinePointer) return;
        tbody.addEventListener('mousemove', (e) => {
            const row = e.target.closest('.game-row, .recent-row');
            if (!row) return;
            _revealMove(row, e);
        });
    });

    // Focus-tracking for form inputs — reveal follows cursor while typing
    scope.querySelectorAll('input[type="search"], input[type="text"], input[type="date"], select, textarea').forEach(input => {
        if (input.dataset.revealFocus) return;
        input.dataset.revealFocus = '1';
        input.classList.add('reveal-focus');
        if (!_revealFinePointer) return;
        input.addEventListener('mousemove', (e) => {
            const rect = input.getBoundingClientRect();
            input.style.setProperty('--reveal-x', (e.clientX - rect.left) + 'px');
            input.style.setProperty('--reveal-y', (e.clientY - rect.top) + 'px');
        });
    });
}
