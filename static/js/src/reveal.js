// === reveal.js ===
// Fluent Reveal Highlight: tracks mouse and applies radial light gradient on cards/rows.
// globals: initRevealHighlight

// Tracks mouse position and applies a radial light gradient on cards/rows
let _revealPending = null;
function _revealRaf() {
    const p = _revealPending;
    if (!p) return;
    _revealPending = null;
    // Read rect at frame boundary — not during mousemove — so forced layout
    // only happens once per rAF cycle regardless of how many events coalesced.
    const rect = p.item.getBoundingClientRect();
    // Integer px for the gradient center — the radial falloff spans 200+ pixels,
    // so sub-pixel precision is visually invisible but costs a style invalidation
    // on every sub-pixel mouse jitter.
    const x = Math.round(p.cx - rect.left);
    const y = Math.round(p.cy - rect.top);
    // 0.5 px for the rim-light offset — offsets span [-5, +5] with a 28 px blur,
    // so 0.5 px steps are indistinguishable from continuous motion.
    const relX = Math.round((x / rect.width * 2 - 1) * 10) * 0.5;
    const relY = Math.round((y / rect.height * 2 - 1) * 10) * 0.5;
    // Push-site coalesce: skip the whole write batch when none of the four
    // quantized values changed since the last frame. Common during stationary
    // hover where mousemove still fires on sub-pixel jitter.
    const item = p.item;
    if (item._rvX === x && item._rvY === y && item._rmX === relX && item._rmY === relY) return;
    item._rvX = x; item._rvY = y; item._rmX = relX; item._rmY = relY;
    item.style.setProperty('--reveal-x', x + 'px');
    item.style.setProperty('--reveal-y', y + 'px');
    item.style.setProperty('--rim-x', relX + 'px');
    item.style.setProperty('--rim-y', relY + 'px');
}

function initRevealHighlight(root) {
    const scope = root || document;
    if (_revealFinePointer) _initRevealScrollWatch();
    // rAF-batched: coalesce rapid mousemove into one layout read per frame.
    // Only cursor coords are captured here — getBoundingClientRect is deferred
    // to _revealRaf so the forced layout happens once at the frame boundary,
    // not once per mousemove event.
    function _revealMove(item, e) {
        if (!_revealCanTrack()) return;
        const schedule = !_revealPending;
        _revealPending = { item, cx: e.clientX, cy: e.clientY };
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

    // Focus-tracking for form inputs — reveal follows cursor while typing.
    // Routes through the same _revealMove → rAF path as all other reveal items so
    // getBoundingClientRect is read once per frame (not once per mousemove event)
    // and the CSS custom-property write is deferred until rAF, avoiding read+write
    // interleaving that forces synchronous layout flushes.
    scope.querySelectorAll('input[type="search"], input[type="text"], input[type="date"], select, textarea').forEach(input => {
        if (input.dataset.revealFocus) return;
        input.dataset.revealFocus = '1';
        input.classList.add('reveal-focus');
        if (!_revealFinePointer) return;
        input.addEventListener('mousemove', (e) => _revealMove(input, e));
    });
}
