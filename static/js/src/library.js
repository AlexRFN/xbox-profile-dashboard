// === library.js ===
// Library view toggle (table/grid), clickable rows, export links,
// htmx event handlers for library/table swaps.
// globals: restoreLibraryView, setLibraryView, initClickableRows, updateExportLinks
// sets: _gridDirty, _tableDirty (read by nav.js htmx:afterSwap handler)

let _currentLibView = localStorage.getItem('libraryView') || 'table';
let _viewToggleSwap = false;
// Dirty flags: true = content needs re-fetch, false = cached content is current.
// Table starts clean (server-rendered); grid starts dirty (never fetched).
let _gridDirty = true;
let _tableDirty = false;
const LIBRARY_VIEW_CONFIG = {
    table: { endpoint: '/api/library/table', target: '#game-table-body' },
    grid: { endpoint: '/api/library/grid', target: '#library-grid-wrap' },
};

function _currentLibraryFilters() {
    return Object.fromEntries(
        Array.from(document.querySelectorAll('#filters [name]'))
            .filter(el => el.name && el.value)
            .map(el => [el.name, el.value])
    );
}

function _libraryViewConfig(view) {
    return LIBRARY_VIEW_CONFIG[view] || LIBRARY_VIEW_CONFIG.table;
}

function _libraryViewElements() {
    return {
        tableWrap: document.getElementById('library-table-wrap'),
        gridWrap: document.getElementById('library-grid-wrap'),
        toggle: document.getElementById('view-toggle'),
        filtersEl: document.getElementById('filters'),
    };
}

function _setLibraryToggleState(toggle, view) {
    if (!toggle) return;
    toggle.querySelectorAll('.view-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    updateToggleSlider(toggle);
}

function _syncLibraryRequestBindings(view, filtersEl) {
    // Bail on non-library pages. `.library-filter-input` is the shared chrome class
    // for any filter control (timeline/achievements reuse it); the library's own
    // filter container is `#filters` (aliased to filtersEl). If it's missing we're
    // on a different page and must not touch inputs that look similar.
    // Infinite-scroll sentinels need no retargeting — each view's sentinel is a
    // fixed element baked with its own endpoint and swap target.
    if (!filtersEl) return;
    const { endpoint, target } = _libraryViewConfig(view);
    filtersEl.querySelectorAll('.library-filter-input').forEach(el => {
        el.setAttribute('hx-get', endpoint);
        el.setAttribute('hx-target', target);
    });

    requestAnimationFrame(() => {
        htmx.process(filtersEl);
    });
}

function _ensureLibraryTableHeadVisible(tableWrap) {
    const thead = tableWrap?.querySelector('thead .anim-drop');
    if (thead && !thead.classList.contains('animate-in')) {
        thead.style.transitionDelay = '0ms';
        thead.classList.add('animate-in');
    }
}

function _loadLibraryGridView(gridWrap) {
    gridWrap.innerHTML = '';
    // Detached elements remain in _cachedEls — force a fresh rect read so stale glass
    // panels don't linger at old positions until the periodic _RECT_MAX_AGE flush.
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    gridWrap.style.display = '';
    gridWrap.style.minHeight = '100vh';

    return htmx.ajax('GET', '/api/library/grid', {
        target: '#library-grid-wrap',
        swap: 'innerHTML',
        values: _currentLibraryFilters(),
    }).finally(() => {
        gridWrap.style.minHeight = '';
        _viewToggleSwap = false;
    });
}

function _loadLibraryTableView(tableWrap, gridWrap) {
    tableWrap.style.display = '';
    gridWrap.style.display = 'none';
    _ensureLibraryTableHeadVisible(tableWrap);

    return htmx.ajax('GET', '/api/library/table', {
        target: '#game-table-body',
        swap: 'innerHTML',
        values: _currentLibraryFilters(),
    }).finally(() => {
        _viewToggleSwap = false;
    });
}

// Synchronous early-restore for the saved view. Mirrors the inline <script> in
// library_content.html so the SSR and SPA-nav paths behave identically: hide the
// table wrap, show the (empty) grid wrap with reserved height, and kick off the
// /api/library/grid prefetch. Call this BEFORE entrance animations run so the
// user never sees the table flash on SPA navigation back to /library when grid
// is the saved preference. Idempotent: bails if grid is already populated.
function applyEarlyLibraryView() {
    if (localStorage.getItem('libraryView') !== 'grid') return;
    const tableWrap = document.getElementById('library-table-wrap');
    const gw = document.getElementById('library-grid-wrap');
    if (!tableWrap || !gw) return;  // not on /library
    const toggle = document.getElementById('view-toggle');

    tableWrap.style.display = 'none';
    gw.style.display = '';
    if (toggle) {
        toggle.querySelectorAll('.view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === 'grid');
        });
        // Reposition the sliding indicator over the grid button — without this
        // the slider stays parked over Table from the SSR-rendered active class.
        if (typeof updateToggleSlider === 'function') updateToggleSlider(toggle);
    }

    // Already populated (e.g. cached restore via history) — no fetch needed.
    if (gw.children.length) return;

    gw.style.minHeight = '100vh';
    const params = new URLSearchParams();
    document.querySelectorAll('#filters [name]').forEach(el => {
        if (el.name && el.value) params.set(el.name, el.value);
    });
    const qs = params.toString();
    fetch('/api/library/grid' + (qs ? '?' + qs : ''))
        .then(r => r.text())
        .then(html => {
            if (gw.children.length) return;  // htmx beat us
            gw.innerHTML = html;
            gw.style.minHeight = '';
            if (typeof htmx !== 'undefined') htmx.process(gw);
            if (typeof onInlineGridLoad === 'function') onInlineGridLoad(gw);
        });
}

function restoreLibraryView() {
    _prewarmTried = false;  // fresh entry to /library — allow prewarm again
    if (_currentLibView === 'grid' && document.getElementById('library-table-wrap')) {
        const gridWrap = document.getElementById('library-grid-wrap');
        // Grid already clean and populated — inline fetch or a prior htmx swap fully
        // initialized it (glass, animations, direction). Calling setLibraryView here
        // would reset and re-animate without the entrance direction.
        if (gridWrap && !_gridDirty && gridWrap.children.length > 0) {
            const { filtersEl } = _libraryViewElements();
            _syncLibraryRequestBindings('grid', filtersEl);
            prewarmLibraryOffView();
            return;
        }
        setLibraryView('grid');
    } else {
        const { filtersEl } = _libraryViewElements();
        _syncLibraryRequestBindings(_currentLibView, filtersEl);
    }
    prewarmLibraryOffView();
}

// Background-populate the off-view so the first toggle is instant.
// Runs once per library page load; filter/page changes invalidate via dirty flags.
let _prewarmTried = false;
function prewarmLibraryOffView() {
    if (_prewarmTried) return;
    const { tableWrap, gridWrap } = _libraryViewElements();
    if (!tableWrap || !gridWrap) return;
    _prewarmTried = true;

    const run = () => {
        const values = _currentLibraryFilters();
        // Suppress dirty-flag cross-flip inside the swap handlers.
        _viewToggleSwap = true;
        // Re-sync filter bindings to the currently visible view after the swap —
        // the prewarm response was for the off-view endpoint.
        const restore = () => {
            _viewToggleSwap = false;
            const { filtersEl } = _libraryViewElements();
            _syncLibraryRequestBindings(_currentLibView, filtersEl);
        };

        if (_currentLibView === 'table' && _gridDirty) {
            // gridWrap is display:none at rest — htmx.ajax only updates innerHTML,
            // so it stays hidden throughout the swap. Its sentinel hides with it
            // and arms when the grid view is shown.
            htmx.ajax('GET', '/api/library/grid', {
                target: '#library-grid-wrap',
                swap: 'innerHTML',
                values,
            }).finally(() => { gridWrap.style.display = 'none'; restore(); });
        } else if (_currentLibView === 'grid' && !document.querySelector('#game-table-body .game-row')) {
            htmx.ajax('GET', '/api/library/table', {
                target: '#game-table-body',
                swap: 'innerHTML',
                values,
            }).finally(() => { tableWrap.style.display = 'none'; restore(); });
        } else {
            _viewToggleSwap = false;
        }
    };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 1200);
}

function setLibraryView(view) {
    _currentLibView = view;
    localStorage.setItem('libraryView', view);

    const { tableWrap, gridWrap, toggle, filtersEl } = _libraryViewElements();
    if (!tableWrap || !gridWrap) return;

    _setLibraryToggleState(toggle, view);
    _syncLibraryRequestBindings(view, filtersEl);

    if (view === 'grid') {
        tableWrap.style.display = 'none';
        if (!_gridDirty && gridWrap.children.length > 0) {
            gridWrap.style.display = '';
            _showCachedGridView(gridWrap);
        } else {
            _viewToggleSwap = true;
            _loadLibraryGridView(gridWrap);
        }
    } else {
        gridWrap.style.display = 'none';
        if (!_tableDirty && document.querySelector('#game-table-body .game-row')) {
            tableWrap.style.display = '';
            _ensureLibraryTableHeadVisible(tableWrap);
            _showCachedTableView(tableWrap);
        } else {
            _viewToggleSwap = true;
            _loadLibraryTableView(tableWrap, gridWrap);
        }
    }
}

// --- Clickable game rows with click flash (delegated) ---
let _clickableRowsDelegated = false;

function initClickableRows() {
    // Set ARIA attributes on new rows
    document.querySelectorAll('.game-row[data-href], .recent-row[data-href]').forEach(row => {
        row.setAttribute('role', 'link');
        row.setAttribute('tabindex', '0');
    });
    // Delegate once on document.body — survives htmx swaps
    if (_clickableRowsDelegated) return;
    _clickableRowsDelegated = true;
    document.body.addEventListener('click', (e) => {
        const row = e.target.closest('.game-row[data-href], .recent-row[data-href]');
        if (!row) return;
        if (e.target.closest('select') || e.target.closest('a') || e.target.closest('button')) return;
        row.classList.add('row-click');
        startSpaNav(row.dataset.href);
    });
    document.body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.game-row[data-href], .recent-row[data-href]');
        if (!row) return;
        e.preventDefault();
        row.classList.add('row-click');
        startSpaNav(row.dataset.href);
    });
}

// --- Update export links with current filters ---
function updateExportLinks() {
    const filtersEl = document.getElementById('filters');
    if (!filtersEl) return;
    const params = new URLSearchParams();
    filtersEl.querySelectorAll('input, select').forEach(el => {
        if (el.name && el.value) params.set(el.name, el.value);
    });
    const qs = params.toString();
    const csvLink = document.getElementById('export-csv');
    const jsonLink = document.getElementById('export-json');
    if (csvLink) csvLink.href = '/api/export/csv' + (qs ? '?' + qs : '');
    if (jsonLink) jsonLink.href = '/api/export/json' + (qs ? '?' + qs : '');
}

function _syncLibraryResultCount(target) {
    const hidden = target.querySelector('[data-total]');
    const countEl = document.getElementById('result-count');
    if (hidden && countEl) {
        countEl.textContent = hidden.dataset.total;
    }
}

function _resumeLibraryGlassAfterTableSwap() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (window.resumeGlass) window.resumeGlass();
        // resumeGlass() sets _layoutDirty=true — cacheElements() runs on the next glass
        // frame without any cooldown. requestGlassPanelsUpdate() would add a 3-frame
        // delay, making glass lag behind the newly visible table rows.
    }));
}

function _scrollToTopAfterLibrarySwap() {
    if (window.lenis) {
        window.lenis.scrollTo(0);
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function _handleLibraryTableBeforeRequest(target) {
    if (_viewToggleSwap) return;
    if (window.pauseGlass) window.pauseGlass();
    target.classList.add('table-loading');
}

function _showCachedGridView(gridWrap) {
    _resetAnimations(gridWrap, () => {
        if (_currentLibView !== 'grid' || !gridWrap.isConnected || gridWrap.style.display === 'none') return;
        initAmbientGlow(gridWrap);
        updateExportLinks();
        if (window.invalidateGlassRects) window.invalidateGlassRects();
        initRevealHighlight(gridWrap);
        _reapplyEntranceDir(gridWrap);
        initBlurhash(gridWrap);
    });
}

function _showCachedTableView(tableWrap) {
    const tbody = document.getElementById('game-table-body');
    if (!tbody) return;
    _resetAnimations(tbody, () => {
        if (_currentLibView !== 'table' || !tbody.isConnected || tableWrap.style.display === 'none') return;
        initClickableRows();
        initScrollAnimations(tbody, true);
        initRowScrollReveal(tbody);
        initEdgeScale();
        _syncLibraryResultCount(tbody);
        updateExportLinks();
        if (window.invalidateGlassRects) window.invalidateGlassRects();
        _scrollToTopAfterLibrarySwap();
        initRevealHighlight(tbody);
        initBlurhash(tbody);
    });
}

function _handleLibraryTableSwap(target) {
    target.classList.remove('table-loading');
    _tableDirty = false;
    if (!_viewToggleSwap) _gridDirty = true; // filter change → grid is now stale
    initClickableRows();
    // View toggle (_viewToggleSwap=true): forceStagger so rows cascade in like a fresh load.
    // Filter/page change (_viewToggleSwap=false): no stagger — all rows swap simultaneously.
    initScrollAnimations(target, _viewToggleSwap);
    initRowScrollReveal(target);
    initEdgeScale();
    _syncLibraryResultCount(target);
    updateExportLinks();
    _resumeLibraryGlassAfterTableSwap();
    _scrollToTopAfterLibrarySwap();
}

function _handleLibraryGridSwap(target) {
    _gridDirty = false;
    if (!_viewToggleSwap) _tableDirty = true; // filter change → table is now stale
    initAmbientGlow(target);
    updateExportLinks();
    // updateGlassPanelsNow() skips the 3-frame cooldown — the htmx swap is complete so
    // getBoundingClientRect() is stable. Eliminates the ~66ms "stale panels" window.
    if (window.updateGlassPanelsNow) window.updateGlassPanelsNow();
    else requestGlassPanelsUpdate();
}

// Called by library.html's inline grid fetch — equivalent to an htmx grid swap
// but without firing htmx:afterSwap. Keeps dirty flags, glass, and animations in sync.
window.onInlineGridLoad = function(gw) {
    _handleLibraryGridSwap(gw);
    _reapplyEntranceDir(gw);  // apply SPA nav entrance direction if available
    initRevealHighlight(gw);
    initBlurhash(gw);
    // The inline fetch bypasses htmx's response pipeline, so the sentinel that
    // arrived in the HTML was never seen by the htmx:afterSwap rescan — observe it.
    if (typeof initInfiniteScroll === 'function') initInfiniteScroll(gw);
    // setLibraryView wasn't called for this path (restoreLibraryView returned early),
    // so sync filter htmx bindings to grid endpoints manually.
    const { filtersEl } = _libraryViewElements();
    _syncLibraryRequestBindings('grid', filtersEl);
};

// Show a toast for failed htmx partial requests (filter changes, etc.). Append
// failures are owned by infinite.js's inline retry UX — skip them here so the
// generic toast doesn't stack on top of the Retry control.
document.body.addEventListener('htmx:responseError', (evt) => {
    if (evt.detail.elt?.classList?.contains('inf-sentinel')) return;
    const status = evt.detail.xhr?.status;
    showToast(status ? `Request failed (${status})` : 'Request failed', true);
});

document.body.addEventListener('htmx:sendError', (evt) => {
    if (evt.detail.elt?.classList?.contains('inf-sentinel')) return;
    showToast('Network error — check your connection', true);
});

// Skeleton loading states + library/timeline before-request handlers
document.body.addEventListener('htmx:beforeRequest', (evt) => {
    const target = evt.detail.target;
    if (!target) return;
    // Library table: pause glass and fade existing rows as loading indicator.
    // Skip during view toggles — filters/buttons stay on screen, no need to pause glass.
    if (target.id === 'game-table-body' && !_viewToggleSwap) {
        _handleLibraryTableBeforeRequest(target);
    }
    // Timeline: inject skeleton cards
    if (target.id === 'timeline-events') {
        let html = '';
        for (let i = 0; i < 3; i++) {
            html += '<div class="skeleton-card" style="--i:' + i + ';margin-bottom:0.75rem"><div class="skeleton-bone" style="width:30%"></div><div class="skeleton-bone" style="width:80%"></div><div class="skeleton-bone" style="width:60%"></div></div>';
        }
        target.innerHTML = html;
    }
});

// Re-init modules after an infinite-scroll append. The sentinel swapped ITSELF
// (outerHTML) for the new items, so evt.detail.target is the detached sentinel,
// not the list container — which conveniently keeps appends out of the filter-
// swap handlers below (no scroll-to-top, no table-loading fade, no dirty-flag
// flips).
//
// Appends land mid-scroll, so the budget is one frame: only revealAppended
// (observer setup — required before the new items can scroll into view) runs
// in the swap task; everything else defers to idle. The new content sits
// ≥1200px below the viewport (sentinel prefetch margin), so observers and
// decorations arriving a few frames late are unobservable.
// Two pipelines are deliberately NOT re-run here:
//   initScrollAnimations — destructive (disconnects the page-wide observer,
//     bumps the generation), which orphans below-fold elements outside the
//     container and cancels the entrance cascade when a prefetch lands during
//     page entry. revealAppended (infinite.js) is the additive equivalent.
//   initRevealHighlight — every list container uses one delegated mousemove
//     listener (reveal-container / .grid-rows) and items carry reveal-item in
//     markup; re-running it cost ~70ms per append and grew with list size.
function _appendIdle(fn) {
    if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 50);
}

function _handleInfiniteAppend(sentinelId) {
    if (sentinelId === 'library-table-sentinel') {
        const tbody = document.getElementById('game-table-body');
        if (!tbody) return;
        revealAppended(tbody);
        _appendIdle(() => {
            if (!tbody.isConnected) return;
            initClickableRows();
            initRowScrollReveal(tbody);
            initEdgeScale();
            initBlurhash(tbody);
            initOffscreenAnimationPause(tbody);
            // Rows are glass panels (.grid-rows .game-row) — register the new batch.
            requestGlassPanelsUpdate();
        });
    } else if (sentinelId === 'library-grid-sentinel') {
        const wrap = document.getElementById('library-grid-wrap');
        if (!wrap) return;
        revealAppended(wrap);
        _appendIdle(() => {
            if (!wrap.isConnected) return;
            initAmbientGlow(wrap);
            initBlurhash(wrap);
            initOffscreenAnimationPause(wrap);
            requestGlassPanelsUpdate();
        });
    } else if (sentinelId === 'captures-sentinel') {
        const grid = document.getElementById('captures-grid');
        if (!grid) return;
        revealAppended(grid);
        _lightboxDirty = true;
        _appendIdle(() => {
            if (!grid.isConnected) return;
            initBlurhash(grid);
            requestGlassPanelsUpdate();
        });
    } else if (sentinelId === 'ach-sentinel') {
        const wrap = document.getElementById('ach-grid-wrap');
        if (!wrap) return;
        // Merge before animations init so the moved cards' positions are final.
        if (typeof _mergeAchGroupContinuations === 'function') _mergeAchGroupContinuations(wrap);
        revealAppended(wrap);
        _appendIdle(() => {
            if (!wrap.isConnected) return;
            initBlurhash(wrap);
            initOffscreenAnimationPause(wrap);
            requestGlassPanelsUpdate();
        });
    } else if (sentinelId === 'timeline-sentinel') {
        const timeline = document.getElementById('timeline');
        if (!timeline) return;
        revealAppended(timeline);
        _appendIdle(() => {
            if (!timeline.isConnected) return;
            initBlurhash(timeline);
            requestGlassPanelsUpdate();
        });
    }
}

// htmx 2 fires htmx:afterSwap once PER INSERTED NODE — a 50-row append or
// filter swap dispatches it 51 times, all in the same task, all with the same
// detail.target (measured live). Without coalescing, every branch below runs
// 51× per swap and the stacked re-init work lands as a 50–110ms long task.
// One handling per target per synchronous batch; the microtask reset re-arms
// before any genuinely separate swap (always ≥1 task away) can occur.
const _swapHandled = new WeakSet();
function _alreadyHandledThisSwap(target) {
    if (_swapHandled.has(target)) return true;
    _swapHandled.add(target);
    queueMicrotask(() => _swapHandled.delete(target));
    return false;
}

// Re-init rows + update result count + retrigger animations after htmx swaps
document.body.addEventListener('htmx:afterSwap', (evt) => {
    // SPA page swaps (#main) are fully handled by the dedicated handler in nav.js — skip here
    if (evt.detail.target.id === 'main') return;

    if (_alreadyHandledThisSwap(evt.detail.target)) return;

    // Lenis debounces its ResizeObserver ~250ms, so a swap that grows the page
    // (infinite-scroll append) leaves wheel input clamped to the stale scroll
    // limit — measured up to ~270ms of dead scroll pinned at the old bottom.
    // Refresh Lenis dimensions in the same task as the DOM change — but via
    // dimensions.resize(), NOT the public resize(): the latter also runs
    // `animatedScroll = targetScroll = actualScroll`, which collapses any
    // in-flight scroll tween to the current position. Appends prefetch ~1200px
    // before the bottom, so they almost always land mid-glide; the full resize()
    // was snapping targetScroll back and killing scroll momentum on every append.
    // dimensions.resize() refreshes width/height/scrollHeight (and thus the wheel
    // limit) without touching the animation. Verified: target preserved, limit
    // updated. nav.js's resize() stays — it's paired with scrollTo(0, immediate).
    if (window.lenis && window.lenis.dimensions) window.lenis.dimensions.resize();

    // Infinite-scroll appends route to the dedicated light-weight re-init.
    if (evt.detail.target.classList && evt.detail.target.classList.contains('inf-sentinel')) {
        _handleInfiniteAppend(evt.detail.target.id);
        return;
    }

    if (evt.detail.target.id === 'game-table-body') {
        _handleLibraryTableSwap(evt.detail.target);
    }
    // Grid view swap — reinit animations + glow + glass panels
    if (evt.detail.target.id === 'library-grid-wrap') {
        _handleLibraryGridSwap(evt.detail.target);
    }
    // Achievements/timeline filter swaps replace glass panel content
    if (evt.detail.target.id === 'ach-grid-wrap' || evt.detail.target.id === 'timeline') {
        requestGlassPanelsUpdate();
    }
    // Heatmap year/rolling toggle re-emits the nav buttons (.hm-tab, .hm-year-btn).
    // Without a rescan, the old buttons stay in _cachedEls (DOM-detached, invisible)
    // and the new buttons have no GPU panel entry — only the CSS backdrop-filter
    // fallback paints, which reads visually as the buttons "dropping behind" the
    // article's GPU glass.
    if (evt.detail.target.id === 'heatmap-content') {
        requestGlassPanelsUpdate();
    }
    // Timeline filter swap — fresh h3 nodes arrive via OOB; re-run countup
    if (evt.detail.target.id === 'timeline') {
        animateCountUp();
    }
    // Re-init reveal highlight, scroll animations, and blurhash on swapped content
    initRevealHighlight(evt.detail.target);
    // Re-observe new long-list rows for off-screen animation pause
    initOffscreenAnimationPause(evt.detail.target);
    if (evt.detail.target.id === 'library-grid-wrap') {
        const _gridTarget = evt.detail.target;
        if (_lastTabEnterClass && !_viewToggleSwap) {
            // SPA nav arrival (restoreLibraryView) — apply entrance direction
            _reapplyEntranceDir(_gridTarget);
        } else {
            // Manual view toggle — JS stagger so transitionDelay = '0ms' is set upfront.
            // CSS --i stagger must NOT be left active: it staggers the EXIT animation too,
            // causing cards to slide out at different times when the user navigates away.
            _lastTabEnterClass = null;
            requestAnimationFrame(() => {
                const cards = Array.from(_gridTarget.querySelectorAll('.anim-pop'));
                const stagger = _cssDur('--stagger') || 60;
                const unit = cards.length <= 8
                    ? Math.max(Math.round(stagger * 0.8), 80)
                    : Math.max(Math.floor(500 / cards.length), 12);
                cards.forEach((el, idx) => {
                    el.style.transitionDelay = '0ms'; // suppress CSS --i so exit is simultaneous
                    setTimeout(() => el.classList.add('animate-in'), idx * unit);
                });
            });
        }
        initBlurhash(_gridTarget);
    } else if (evt.detail.target.id !== 'game-table-body'
            && evt.detail.target.id !== 'captures-grid'
            && evt.detail.target.id !== 'heatmap-content') {
        // initScrollAnimations() is destructive: it disconnects the global scroll
        // observer + bumps _scrollAnimGen, invalidating any in-flight reveal timers.
        // Skip for swap targets that hold no .anim-* elements (heatmap-content's
        // children are static — only nav buttons + grid cells). Without this skip,
        // a heatmap swap orphans every below-fold card on the page.
        initScrollAnimations(evt.detail.target);
        initBlurhash(evt.detail.target);
    } else {
        initBlurhash(evt.detail.target);
    }
});
