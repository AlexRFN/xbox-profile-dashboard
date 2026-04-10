// === captures.js ===
// Captures page: view toggle (all/by-game), expand/collapse per-game groups,
// select mode, bulk download, sync captures SSE.
// globals: setCapturesView, expandCaptureGame, collapseCaptureGame,
//          toggleSelectMode, toggleCaptureCard, selectAllCaptures,
//          clearCaptureSelection, updateSelectCount, downloadSelectedCaptures,
//          syncCaptures

// FLIP helper: makes a button travel from fromTop (old viewport Y) to its natural position.
// Record fromTop BEFORE the layout change, call this AFTER the button is in the DOM.
function _flipButton(btn, fromTop) {
    if (!btn || fromTop == null) return;
    const toTop = btn.getBoundingClientRect().top;
    const deltaY = fromTop - toTop;
    if (Math.abs(deltaY) < 2) return; // no meaningful movement
    const dur = _cssDur('--dur-normal');
    const cs = getComputedStyle(document.documentElement);
    const easeOut  = cs.getPropertyValue('--ease-out').trim();
    const easeSoft = cs.getPropertyValue('--ease-spring-soft').trim();
    // Place button at old position, invisible
    btn.style.transition = 'none';
    btn.style.opacity = '0';
    btn.style.transform = `translateY(${deltaY}px)`;
    btn.offsetWidth; // commit initial state
    // Animate to natural position with fade-in
    btn.style.transition = `opacity ${dur}ms ${easeOut}, transform ${dur}ms ${easeSoft}`;
    btn.style.opacity = '';
    btn.style.transform = '';
    btn.addEventListener('transitionend', () => { btn.style.transition = ''; }, { once: true });
}

function _pressBtn(btn) {
    if (!btn) return;
    btn.classList.add('btn-press');
    btn.addEventListener('animationend', () => btn.classList.remove('btn-press'), { once: true });
}

// --- Captures game expand/collapse ---
function expandCaptureGame(titleId, btn) {
    const grid = document.getElementById(`game-captures-${titleId}`);
    if (!grid || grid.dataset.expanding) return;
    grid.dataset.expanding = '1';

    _pressBtn(btn);

    // Record button position BEFORE layout changes (grid.innerHTML shifts everything down)
    const fromTop = btn ? btn.getBoundingClientRect().top : null;
    const prevCount = grid.querySelectorAll('.capture-card').length;

    fetch(`/api/captures/game/${encodeURIComponent(titleId)}`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(html => {
            grid.innerHTML = html;
            const allCards = Array.from(grid.querySelectorAll('.capture-card'));

            // Already-visible preview cards: instant, no re-animation
            const alreadyShown = allCards.slice(0, prevCount);
            if (alreadyShown.length) {
                alreadyShown.forEach(el => el.style.transition = 'none');
                alreadyShown.forEach(el => el.classList.add('animate-in'));
                alreadyShown[0].offsetHeight; // single reflow
                alreadyShown.forEach(el => el.style.transition = '');
            }

            // New cards: rapid stagger — quick cascade, clearly sequential
            const unit = 15;
            allCards.slice(prevCount).forEach((el, idx) => {
                el.style.transitionDelay = '0ms';
                setTimeout(() => el.classList.add('animate-in'), idx * unit);
            });

            initRevealHighlight(grid);
            _lightboxDirty = true;

            // Swap button → "Show less", then FLIP it from old position to new
            const wrap = grid.closest('.captures-game-group');
            const oldBtn = wrap?.querySelector('.captures-show-all');
            if (oldBtn) {
                const total = oldBtn.dataset.total || allCards.length;
                const newBtn = document.createElement('button');
                newBtn.className = 'outline captures-show-all anim-pop animate-in';
                newBtn.dataset.total = total;
                newBtn.dataset.titleId = titleId;
                newBtn.textContent = 'Show less';
                newBtn.onclick = () => collapseCaptureGame(titleId, newBtn);
                oldBtn.replaceWith(newBtn);
                initRevealHighlight(wrap);
                _flipButton(newBtn, fromTop);
                requestGlassPanelsUpdate();
            }
            delete grid.dataset.expanding;
        })
        .catch(() => { delete grid.dataset.expanding; });
}

function collapseCaptureGame(titleId, btn) {
    const grid = document.getElementById(`game-captures-${titleId}`);
    if (!grid) return;
    if (grid.dataset.collapsing) return;

    _pressBtn(btn);

    const fromTop = btn ? btn.getBoundingClientRect().top : null;

    const allCards = Array.from(grid.querySelectorAll('.capture-card'));
    const cardsToRemove = allCards.slice(6);
    if (!cardsToRemove.length) { _finishCollapse(titleId, grid, fromTop); return; }

    grid.dataset.collapsing = '1';

    const unit = 8;
    const reversed = [...cardsToRemove].reverse();

    reversed.forEach((el, idx) => {
        setTimeout(() => {
            el.style.transitionDelay = '0ms';
            el.classList.remove('animate-in');
        }, idx * unit);
    });

    const animDur = _cssDur('--dur-normal');
    setTimeout(() => {
        cardsToRemove.forEach(el => el.remove());
        delete grid.dataset.collapsing;
        _finishCollapse(titleId, grid, fromTop);
    }, (reversed.length - 1) * unit + animDur + 30);
}

function _finishCollapse(titleId, grid, fromTop) {
    const wrap = grid.closest('.captures-game-group');
    const oldBtn = wrap?.querySelector('.captures-show-all');
    if (!oldBtn) return;
    const total = oldBtn.dataset.total;
    const newBtn = document.createElement('button');
    newBtn.className = 'outline captures-show-all anim-pop animate-in';
    newBtn.dataset.total = total;
    newBtn.dataset.titleId = titleId;
    newBtn.textContent = `Show all ${total}`;
    newBtn.onclick = () => expandCaptureGame(titleId, newBtn);
    oldBtn.replaceWith(newBtn);
    initRevealHighlight(wrap);
    _flipButton(newBtn, fromTop);
    requestGlassPanelsUpdate();
}

// --- Captures view toggle ---
function setCapturesView(view) {
    localStorage.setItem('capturesView', view);
    if (_selectMode) toggleSelectMode();
    const allWrap = document.getElementById('captures-all-wrap');
    const byGameWrap = document.getElementById('captures-by-game-wrap');
    if (!allWrap || !byGameWrap) return;

    const capToggle = document.querySelector('.view-toggle-captures');
    if (capToggle) {
        capToggle.querySelectorAll('.view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === view);
        });
        updateToggleSlider(capToggle);
    }

    // Show the target view and re-trigger scroll animations
    const showWrap = view === 'by-game' ? byGameWrap : allWrap;
    const hideWrap = view === 'by-game' ? allWrap : byGameWrap;
    hideWrap.style.display = 'none';
    showWrap.style.display = '';

    // Lazy-load by-game content on first toggle
    if (view === 'by-game' && !byGameWrap.children.length) {
        fetch('/api/captures/by-game')
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
            .then(html => {
            byGameWrap.innerHTML = html;
            _lightboxDirty = true;
            initRevealHighlight(byGameWrap);
            requestAnimationFrame(() => {
                initCaptureGroupAnimations(byGameWrap);
                requestGlassPanelsUpdate();
            });
        })
            .catch(() => {});
        return;
    }

    // Reset and replay entrance animations on the incoming view
    showWrap.querySelectorAll('.animate-in').forEach(el => {
        el.classList.remove('animate-in');
    });
    if (view === 'by-game') {
        requestAnimationFrame(() => {
            initCaptureGroupAnimations(showWrap);
            requestGlassPanelsUpdate();
        });
    } else {
        requestAnimationFrame(() => {
            initScrollAnimations(showWrap, true);
            requestGlassPanelsUpdate();
        });
    }
}

// --- Capture Select Mode ---
let _selectMode = false;
let _selectedCaptures = new Set();
let _downloadStaggerCancel = null;

function toggleSelectMode() {
    _selectMode = !_selectMode;
    document.body.classList.toggle('select-mode', _selectMode);
    const btn = document.getElementById('select-mode-btn');
    const bar = document.getElementById('captures-select-bar');
    if (btn) btn.innerHTML = _selectMode
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:-2px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:-2px"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg> Select';
    if (bar) bar.style.display = _selectMode ? '' : 'none';
    const topDl = document.getElementById('download-selected-top');
    if (topDl) topDl.style.display = _selectMode ? '' : 'none';
    if (window.invalidateGlassRects) window.invalidateGlassRects();
    if (!_selectMode) clearCaptureSelection();
}

function toggleCaptureCard(card) {
    const id = card.dataset.contentId;
    if (!id) return;
    if (_selectedCaptures.has(id)) {
        _selectedCaptures.delete(id);
        card.classList.remove('selected');
    } else {
        _selectedCaptures.add(id);
        card.classList.add('selected');
    }
    updateSelectCount();
}

function selectAllCaptures() {
    document.querySelectorAll('.capture-card[data-content-id]').forEach(card => {
        if (card.offsetParent !== null) { // only visible cards
            _selectedCaptures.add(card.dataset.contentId);
            card.classList.add('selected');
        }
    });
    updateSelectCount();
}

function clearCaptureSelection() {
    _selectedCaptures.clear();
    document.querySelectorAll('.capture-card.selected').forEach(c => c.classList.remove('selected'));
    updateSelectCount();
}

function updateSelectCount() {
    const countEl = document.getElementById('select-count');
    const dlBtn = document.getElementById('download-selected-btn');
    const topDl = document.getElementById('download-selected-top');
    const n = _selectedCaptures.size;
    if (countEl) countEl.textContent = n + ' selected';
    if (dlBtn) dlBtn.disabled = n === 0;
    if (topDl) {
        topDl.disabled = n === 0;
        const span = topDl.querySelector('.dl-count');
        if (span) span.textContent = n > 0 ? '(' + n + ')' : '';
    }
}

function _captureFilename(game, dateStr) {
    const safeName = (game || 'capture').replace(/[<>:"/\\|?*]+/g, '').trim().replace(/\s+/g, '_');
    let datePart = '';
    try {
        const dt = new Date(dateStr);
        datePart = `_${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}_${String(dt.getHours()).padStart(2,'0')}-${String(dt.getMinutes()).padStart(2,'0')}-${String(dt.getSeconds()).padStart(2,'0')}`;
    } catch (e) {}
    return safeName + datePart + '.png';
}

function _downloadCapture(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = '/api/captures/download?url=' + encodeURIComponent(url) + '&filename=' + encodeURIComponent(filename);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
}

function downloadSelectedCaptures() {
    const cards = document.querySelectorAll('.capture-card[data-content-id]');
    const toDownload = [];
    cards.forEach(card => {
        if (_selectedCaptures.has(card.dataset.contentId)) {
            toDownload.push({
                url: card.dataset.full,
                filename: _captureFilename(card.dataset.game, card.dataset.date),
            });
        }
    });
    if (toDownload.length === 0) return;
    let i = 0;
    let timer = null;
    _downloadStaggerCancel = () => { clearTimeout(timer); _downloadStaggerCancel = null; };
    const tick = () => {
        if (i >= toDownload.length) {
            _downloadStaggerCancel = null;
            showToast('Downloaded ' + toDownload.length + ' capture' + (toDownload.length > 1 ? 's' : ''));
            return;
        }
        _downloadCapture(toDownload[i].url, toDownload[i].filename);
        i++;
        timer = setTimeout(tick, 300);
    };
    tick();
}

// --- Sync Captures (SSE streaming) ---
async function syncCaptures() {
    const btn = document.getElementById('sync-captures-btn');
    if (!btn) return;

    _abortActiveStream();
    _activeStreamAbort = new AbortController();

    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Fetching...';
    btn.disabled = true;

    try {
        await _readSSEStream('/api/sync/screenshots', (data) => {
            if (data.type === 'phase') {
                btn.textContent = data.message;
            } else if (data.type === 'progress') {
                btn.textContent = `Page ${data.page} (${data.fetched} screenshots)...`;
            } else if (data.type === 'finished') {
                showToast(data.message);
                updateRateBadge(data.rate_used);
                if (data.total_screenshots > 0) softRefresh(1000);
            }
        }, _activeStreamAbort.signal);
    } catch (e) {
        if (e.name !== 'AbortError') showToast('Error: ' + e.message, true);
    } finally {
        _activeStreamAbort = null;
        btn.setAttribute('aria-busy', 'false');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -2px"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Sync Captures';
        btn.disabled = false;
    }
}
