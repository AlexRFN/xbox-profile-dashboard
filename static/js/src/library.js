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

function _currentLibraryPage() {
    const active = document.querySelector('#pagination a.active');
    const match = active?.getAttribute('hx-get')?.match(/page=(\d+)/);
    return match ? match[1] : '1';
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
        paginationEl: document.getElementById('pagination'),
    };
}

function _setLibraryToggleState(toggle, view) {
    if (!toggle) return;
    toggle.querySelectorAll('.view-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    updateToggleSlider(toggle);
}

function _syncLibraryRequestBindings(view, filtersEl, paginationEl) {
    const { endpoint, target } = _libraryViewConfig(view);
    document.querySelectorAll('.library-filter-input').forEach(el => {
        el.setAttribute('hx-get', endpoint);
        el.setAttribute('hx-target', target);
    });

    document.querySelectorAll('#pagination a[hx-get]').forEach(a => {
        const page = a.getAttribute('hx-get').match(/page=(\d+)/);
        if (page) {
            a.setAttribute('hx-get', endpoint + '?page=' + page[1]);
            a.setAttribute('hx-target', target);
        }
    });

    requestAnimationFrame(() => {
        if (filtersEl) htmx.process(filtersEl);
        if (paginationEl) htmx.process(paginationEl);
    });
}

function _ensureLibraryTableHeadVisible(tableWrap) {
    const thead = tableWrap?.querySelector('thead .anim-drop');
    if (thead && !thead.classList.contains('animate-in')) {
        thead.style.transitionDelay = '0ms';
        thead.classList.add('animate-in');
    }
}

function _loadLibraryGridView(gridWrap, paginationEl) {
    gridWrap.innerHTML = '';
    // Detached elements remain in _cachedEls — force a fresh rect read so stale glass
    // panels don't linger at old positions until the periodic _RECT_MAX_AGE flush.
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    gridWrap.style.display = '';
    gridWrap.style.minHeight = '100vh';
    if (paginationEl) paginationEl.style.display = 'none';

    return htmx.ajax('GET', `/api/library/grid?page=${_currentLibraryPage()}`, {
        target: '#library-grid-wrap',
        swap: 'innerHTML',
        values: _currentLibraryFilters(),
    }).finally(() => {
        gridWrap.style.minHeight = '';
        if (paginationEl) paginationEl.style.display = '';
        _viewToggleSwap = false;
    });
}

function _loadLibraryTableView(tableWrap, gridWrap) {
    tableWrap.style.display = '';
    gridWrap.style.display = 'none';
    _ensureLibraryTableHeadVisible(tableWrap);

    return htmx.ajax('GET', `/api/library/table?page=${_currentLibraryPage()}`, {
        target: '#game-table-body',
        swap: 'innerHTML',
        values: _currentLibraryFilters(),
    }).finally(() => {
        _viewToggleSwap = false;
    });
}

function restoreLibraryView() {
    if (_currentLibView === 'grid' && document.getElementById('library-table-wrap')) {
        const gridWrap = document.getElementById('library-grid-wrap');
        // Grid already clean and populated — inline fetch or a prior htmx swap fully
        // initialized it (glass, animations, direction). Calling setLibraryView here
        // would reset and re-animate without the entrance direction.
        if (gridWrap && !_gridDirty && gridWrap.children.length > 0) return;
        setLibraryView('grid');
    }
}

function setLibraryView(view) {
    _currentLibView = view;
    localStorage.setItem('libraryView', view);

    const { tableWrap, gridWrap, toggle, filtersEl, paginationEl } = _libraryViewElements();
    if (!tableWrap || !gridWrap) return;

    _setLibraryToggleState(toggle, view);
    _syncLibraryRequestBindings(view, filtersEl, paginationEl);

    if (view === 'grid') {
        tableWrap.style.display = 'none';
        if (!_gridDirty && gridWrap.children.length > 0) {
            gridWrap.style.display = '';
            if (paginationEl) paginationEl.style.display = 'none';
            _showCachedGridView(gridWrap);
        } else {
            _viewToggleSwap = true;
            _loadLibraryGridView(gridWrap, paginationEl);
        }
    } else {
        gridWrap.style.display = 'none';
        if (!_tableDirty && document.querySelector('#game-table-body .game-row')) {
            tableWrap.style.display = '';
            _ensureLibraryTableHeadVisible(tableWrap);
            if (paginationEl) paginationEl.style.display = '';
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
        setTimeout(() => { startFullNav(row.dataset.href); }, 150);
    });
    document.body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.game-row[data-href], .recent-row[data-href]');
        if (!row) return;
        e.preventDefault();
        row.classList.add('row-click');
        setTimeout(() => { startFullNav(row.dataset.href); }, 150);
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
    _resetAnimations(gridWrap);
    initAmbientGlow(gridWrap);
    updateExportLinks();
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    initRevealHighlight(gridWrap);
    _reapplyEntranceDir(gridWrap);
    initBlurhash(gridWrap);
}

function _showCachedTableView(tableWrap) {
    const tbody = document.getElementById('game-table-body');
    if (!tbody) return;
    _resetAnimations(tbody);
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
    // The grid response includes an OOB pagination element (oob=true — no anim-blur-rise,
    // links target the grid endpoint). Because the inline fetch uses gw.innerHTML = html
    // instead of htmx's response pipeline, htmx.process() does NOT run OOB swaps — the
    // element ends up as a child of #library-grid-wrap (left-aligned in the card flex
    // layout) instead of replacing the top-level #pagination. Extract and move it now.
    const oobPg = gw.querySelector('[hx-swap-oob][id="pagination"]');
    if (oobPg) {
        const topLevelPg = Array.from(document.querySelectorAll('#pagination'))
            .find(el => !gw.contains(el));
        oobPg.remove();
        oobPg.removeAttribute('hx-swap-oob');
        if (topLevelPg) topLevelPg.replaceWith(oobPg);
    }

    _handleLibraryGridSwap(gw);
    _reapplyEntranceDir(gw);  // apply SPA nav entrance direction if available
    initRevealHighlight(gw);
    initBlurhash(gw);
    // setLibraryView wasn't called for this path (restoreLibraryView returned early),
    // so sync filter htmx bindings to grid endpoints manually.
    const { filtersEl, paginationEl } = _libraryViewElements();
    _syncLibraryRequestBindings('grid', filtersEl, paginationEl);
};

// Show a toast for failed htmx partial requests (filter changes, pagination, load-more, etc.)
document.body.addEventListener('htmx:responseError', (evt) => {
    const status = evt.detail.xhr?.status;
    showToast(status ? `Request failed (${status})` : 'Request failed', true);
});

document.body.addEventListener('htmx:sendError', () => {
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

// Re-init rows + update result count + retrigger animations after htmx swaps
document.body.addEventListener('htmx:afterSwap', (evt) => {
    // SPA page swaps (#main) are fully handled by the dedicated handler in nav.js — skip here
    if (evt.detail.target.id === 'main') return;

    if (evt.detail.target.id === 'game-table-body') {
        _handleLibraryTableSwap(evt.detail.target);
    }
    // Captures all-grid swap (load more)
    if (evt.detail.target.id === 'captures-grid') {
        initScrollAnimations(evt.detail.target);
        _lightboxDirty = true;
    }
    // Grid view swap — reinit animations + glow + glass panels
    if (evt.detail.target.id === 'library-grid-wrap') {
        _handleLibraryGridSwap(evt.detail.target);
    }
    // Timeline stats OOB swap — re-trigger countup
    if (evt.detail.target.id === 'timeline-stats') {
        animateCountUp();
    }
    // Achievements pagination + timeline load-more append new glass panels
    if (evt.detail.target.id === 'ach-grid-wrap' || evt.detail.target.id === 'timeline') {
        requestGlassPanelsUpdate();
    }
    // Re-init reveal highlight, scroll animations, and blurhash on swapped content
    initRevealHighlight(evt.detail.target);
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
    } else if (evt.detail.target.id !== 'game-table-body' && evt.detail.target.id !== 'captures-grid') {
        initScrollAnimations(evt.detail.target);
        initBlurhash(evt.detail.target);
    } else {
        initBlurhash(evt.detail.target);
    }
});
