// === animations.js ===
// Scroll-triggered animations, row scroll-reveal, edge scale, capture group animations,
// and directional page entrance. Depends on: utils.js (_cssDur), reveal.js.
// globals: initScrollAnimations, initRowScrollReveal, initEdgeScale,
//          initCaptureGroupAnimations, initPageEntrance

// --- Directional entrance state ---
// _tabEnterClass: per-element class for current tab-switch entrance (horizontal).
// Set by initPageEntrance() in nav.js; consumed by initScrollAnimations() for above-fold leaders.
// Scroll-revealed elements never receive it — they always animate vertically.
let _tabEnterClass = null;
// Preserved copy so async content loads (e.g. grid fetch after SPA nav) still get the direction.
// _tabEnterClass is consumed by the first initScrollAnimations call; _lastTabEnterClass survives.
let _lastTabEnterClass = null;

// Re-apply the saved entrance direction for async content loads (grid, etc.).
function _reapplyEntranceDir(root) {
    if (_lastTabEnterClass) { _tabEnterClass = _lastTabEnterClass; _lastTabEnterClass = null; }
    initScrollAnimations(root, true);
}

// --- Scroll-triggered animations (IntersectionObserver) ---
// scroll-ready is set on <html> in base.html so elements are hidden from first paint.
// On DOMContentLoaded (or htmx swap), we trigger animate-in via a single rAF to
// guarantee the hidden state has been composited before transitioning.
// On initial page load, above-the-fold elements are staggered for a cascade entrance.
function initScrollAnimations(root, forceStagger = false) {
    const scope = root || document;
    const isInitialLoad = !root || forceStagger;
    const els = scope.querySelectorAll('.anim-blur-rise, .anim-blur-scale, .anim-slide-blur, .anim-drop, .anim-pop, .anim-grow');
    if (!els.length) return;

    // For htmx partial swaps (root provided), use rAF so the new DOM is composited
    // before we read rects. For initial page load (DCL), first paint has already
    // happened so we can run synchronously — avoids a 500ms+ rAF delay caused by
    // other DCL handlers running between our call and the next animation frame.
    const run = isInitialLoad && !root ? fn => fn() : fn => requestAnimationFrame(fn);

    run(() => {
        const viewH = window.innerHeight;
        // Shared timing — used by both above-fold cascade and scroll observer batches.
        // CSS --i stagger is bypassed (transitionDelay forced to '0ms') so JS setTimeout
        // is the sole timing source. This prevents the CSS delay from stacking on top of
        // the observer firing time, which caused visible lag (row 15 → 750ms wait after
        // entering the viewport).
        const stagger = _cssDur('--stagger') || 50;
        const unit = Math.round(stagger * 0.8); // ~48ms per element — above 50ms visual-perception threshold

        const observer = new IntersectionObserver((entries) => {
            // Batch and sort by vertical position so elements cascade top-to-bottom.
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            visible.forEach((entry, idx) => {
                observer.unobserve(entry.target);
                setTimeout(() => {
                    entry.target.style.transitionDelay = '0ms';
                    entry.target.classList.add('animate-in');
                }, idx * unit);
            });
        }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });

        const aboveFold = [];

        els.forEach(el => {
            if (el.classList.contains('animate-in')) return;
            // Captures by-game elements are grouped and sequenced by initCaptureGroupAnimations
            if (el.closest('.captures-game-group')) return;
            const rect = el.getBoundingClientRect();
            // Skip elements inside display:none containers — their rect is (0,0,0,0).
            if (rect.width === 0 && rect.height === 0) return;
            const isGameRow = el.classList.contains('game-row');
            const rowTop = isGameRow ? _scrollRevealTopExit : 0;
            const rowBot = isGameRow ? viewH : viewH + 120;
            if (rect.top > rowTop && rect.top < rowBot) {
                aboveFold.push(el);
            } else if (!isGameRow) {
                observer.observe(el);
            } else {
                el.dataset.revealed = '1';
            }
        });

        if (isInitialLoad && aboveFold.length > 0) {
            // Global DOM-order stagger: one unified cascade from top to bottom.
            const aboveFoldSet = new Set(aboveFold);
            const MAX_CASCADE = 500;

            const leaders = [];
            const dependents = [];
            aboveFold.forEach(el => {
                let ancestor = el.parentElement;
                let isDependent = false;
                while (ancestor) {
                    if (aboveFoldSet.has(ancestor)) { isDependent = true; break; }
                    ancestor = ancestor.parentElement;
                }
                (isDependent ? dependents : leaders).push(el);
            });

            // Dependents: instantly commit to animate-in state, hidden by parent's opacity.
            if (dependents.length) {
                if (_tabEnterClass) dependents.forEach(el => el.classList.add(_tabEnterClass));
                dependents.forEach(el => el.style.transition = 'none');
                dependents.forEach(el => el.classList.add('animate-in'));
                dependents[0].offsetHeight; // single reflow commits all at once
                dependents.forEach(el => el.style.transition = '');
            }

            // Leaders: stagger sequentially in DOM order.
            const leaderUnit = leaders.length <= 8
                ? Math.max(unit, 80)
                : Math.max(Math.floor(MAX_CASCADE / leaders.length), 12);

            if (_tabEnterClass) leaders.forEach(el => el.classList.add(_tabEnterClass));

            leaders.forEach((el, idx) => {
                el.style.transitionDelay = '0ms';
                if (idx === 0 && isInitialLoad && !root) {
                    el.classList.add('animate-in');
                } else {
                    setTimeout(() => el.classList.add('animate-in'), idx * leaderUnit);
                }
            });

            // Consume the direction — only the first initScrollAnimations call uses it.
            _tabEnterClass = null;
        } else {
            aboveFold.forEach(el => el.classList.add('animate-in'));
        }
    });
}

// --- Persistent scroll-reveal for game rows ---
// Dual IntersectionObserver for persistent scroll-reveal on game rows.
//   Entry: fires when row enters visible area → adds animate-in
//   Exit:  fires 60px before edge → removes animate-in (visible fade-out)
let _rowEntryObs = null;
let _rowExitObs = null;
// Shared with initScrollAnimations so initial cascade uses the same zone.
let _cachedNavH = 56;
let _cachedTheadH = 35;
let _scrollRevealTopExit = 56 + 35 + 60;

function _refreshScrollRevealHeights() {
    const nav = document.querySelector('.xbox-nav');
    const thead = document.querySelector('.game-table thead');
    _cachedNavH = nav ? nav.offsetHeight : 56;
    _cachedTheadH = thead ? thead.offsetHeight : 35;
    _scrollRevealTopExit = _cachedNavH + _cachedTheadH + 60;
}
window.addEventListener('resize', _refreshScrollRevealHeights, { passive: true });
document.addEventListener('DOMContentLoaded', _refreshScrollRevealHeights);

function initRowScrollReveal(scope) {
    const container = scope || document;
    const rows = container.querySelectorAll('.game-row.anim-blur-rise');
    if (!rows.length) return;

    if (_rowEntryObs) _rowEntryObs.disconnect();
    if (_rowExitObs) _rowExitObs.disconnect();

    const topInset = _cachedNavH + _cachedTheadH;

    // viewMid relative to the visible area (below nav+thead, above bottom)
    const viewMid = (topInset + window.innerHeight) / 2;

    // Entry — at the viewport edge, inset by the top chrome.
    _rowEntryObs = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const el = entry.target;
            if (!entry.isIntersecting || !el.dataset.revealed) continue;
            el.style.transitionDelay = '0ms';
            el.classList.toggle('reveal-top', entry.boundingClientRect.top < viewMid);
            el.classList.add('animate-in');
        }
    }, { threshold: 0.05, rootMargin: `-${topInset}px 0px 0px 0px` });

    // Exit — inset so fade starts while row is still visible.
    _rowExitObs = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const el = entry.target;
            if (entry.isIntersecting) {
                if (el.dataset.revealed && !el.classList.contains('animate-in')) {
                    el.style.transitionDelay = '0ms';
                    el.classList.toggle('reveal-top', entry.boundingClientRect.top < viewMid);
                    el.classList.add('animate-in');
                }
            } else if (el.classList.contains('animate-in')) {
                el.classList.remove('tab-enter-forward', 'tab-enter-back');
                el.dataset.revealed = '1';
                el.classList.toggle('reveal-top', entry.boundingClientRect.top < viewMid);
                el.classList.remove('animate-in');
            }
        }
    }, { threshold: 0.05, rootMargin: `-${_scrollRevealTopExit}px 0px -60px 0px` });

    rows.forEach(row => {
        _rowEntryObs.observe(row);
        _rowExitObs.observe(row);
    });
}

// --- Edge proximity scale for game rows ---
// Continuously shrinks rows as they approach the top/bottom exit boundaries.
let _edgeScaleCleanup = null;
let _edgeScaleRowsObs = null;

function initEdgeScale() {
    if (_edgeScaleCleanup) _edgeScaleCleanup();

    const nav = document.querySelector('.xbox-nav');
    const thead = document.querySelector('.game-table thead');
    const navH = nav ? nav.offsetHeight : 56;
    const theadH = thead ? thead.offsetHeight : 35;
    const topBound = navH + theadH + 60;
    const fadeZone = 160;
    const minScale = 0.96;
    const ACTIVE_MARGIN = 220;
    const allRows = Array.from(document.querySelectorAll('.game-row.anim-blur-rise'));
    if (!allRows.length) return;
    const activeRows = new Set();

    const rowDocTop = new Float32Array(allRows.length);
    const rowHeight  = new Float32Array(allRows.length);
    const rowIdx     = new Map();

    function seedRowPositions() {
        const scrollY = window.scrollY;
        for (let i = 0; i < allRows.length; i++) {
            const r = allRows[i].getBoundingClientRect();
            rowDocTop[i] = r.top + scrollY;
            rowHeight[i] = r.height;
        }
    }

    if (_edgeScaleRowsObs) _edgeScaleRowsObs.disconnect();

    function seedActiveRows() {
        const scrollY = window.scrollY;
        const vpH = window.innerHeight;
        const minDocTop = scrollY - ACTIVE_MARGIN;
        const maxDocTop = scrollY + vpH + ACTIVE_MARGIN;
        for (let i = 0; i < allRows.length; i++) {
            const docTop = rowDocTop[i];
            if (docTop + rowHeight[i] >= minDocTop && docTop <= maxDocTop) activeRows.add(allRows[i]);
            else activeRows.delete(allRows[i]);
        }
    }

    _edgeScaleRowsObs = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) activeRows.add(entry.target);
            else activeRows.delete(entry.target);
        }
    }, { threshold: 0, rootMargin: `${ACTIVE_MARGIN}px 0px ${ACTIVE_MARGIN}px 0px` });

    for (let i = 0; i < allRows.length; i++) {
        rowIdx.set(allRows[i], i);
        _edgeScaleRowsObs.observe(allRows[i]);
    }
    seedRowPositions();
    seedActiveRows();

    let ticking = false;

    function update() {
        ticking = false;
        if (!activeRows.size) return;
        const vpH = window.innerHeight;
        const scrollY = window.scrollY;
        const botBound = vpH - 60;

        for (const row of activeRows) {
            if (!row.isConnected) {
                activeRows.delete(row);
                continue;
            }
            const i = rowIdx.get(row);
            const rTop = rowDocTop[i] - scrollY;
            const rHeight = rowHeight[i];
            let compensate = 0;
            if (!row.classList.contains('animate-in')) {
                compensate = row.classList.contains('reveal-top') ? 48 : -48;
            }
            const rowMid = rTop + compensate + rHeight * 0.5;

            const fromTop = rowMid - topBound;
            const fromBot = botBound - rowMid;
            const closest = Math.min(fromTop, fromBot);

            let s;
            if (closest >= fadeZone) {
                s = 1;
            } else if (closest <= 0) {
                s = minScale;
            } else {
                const t = closest / fadeZone;
                s = minScale + (1 - minScale) * (1 - (1 - t) * (1 - t));
            }

            const nextScale = s.toFixed(4);
            if (row.__edgeScale !== nextScale) {
                row.__edgeScale = nextScale;
                row.style.setProperty('--edge-scale', nextScale);
            }
        }
    }

    function onScroll() {
        if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }
    function onResize() {
        seedRowPositions();
        seedActiveRows();
        onScroll();
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    update();

    _edgeScaleCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        if (_edgeScaleRowsObs) {
            _edgeScaleRowsObs.disconnect();
            _edgeScaleRowsObs = null;
        }
        _edgeScaleCleanup = null;
    };
}

// --- Captures by-game group animations ---
// Handles the by-game view's group-aware stagger so each element has no transforming/opacity
// parent — required for backdrop-filter (glass) to composite correctly.
function _fireGroupElements(group, baseDelay, itemUnit) {
    const animEls = Array.from(group.querySelectorAll(
        '.anim-blur-rise, .anim-blur-scale, .anim-slide-blur, .anim-drop, .anim-pop, .anim-grow'
    )).filter(el => !el.classList.contains('animate-in'));
    if (!animEls.length) return;
    animEls.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
    });
    animEls.forEach((el, idx) => {
        el.style.transitionDelay = '0ms';
        setTimeout(() => el.classList.add('animate-in'), baseDelay + idx * itemUnit);
    });
}

function initCaptureGroupAnimations(scope) {
    const groups = Array.from((scope || document).querySelectorAll('.captures-game-group'));
    if (!groups.length) return;
    requestAnimationFrame(() => {
        const stagger = _cssDur('--stagger') || 60;
        const groupUnit = Math.max(stagger, 80);
        const itemUnit  = Math.round(stagger * 0.8);
        const viewH = window.innerHeight;
        const aboveGroups = [];
        const belowGroups = [];
        groups.forEach(group => {
            const rect = group.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            if (rect.top < viewH + 40) aboveGroups.push(group);
            else belowGroups.push(group);
        });
        aboveGroups.forEach((group, gIdx) => {
            _fireGroupElements(group, gIdx * groupUnit, itemUnit);
        });
        const observer = new IntersectionObserver((entries) => {
            entries.filter(e => e.isIntersecting).forEach(entry => {
                observer.unobserve(entry.target);
                _fireGroupElements(entry.target, 0, itemUnit);
            });
        }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
        belowGroups.forEach(group => observer.observe(group));
    });
}

// --- Reset animations helper (used by library view toggle) ---
function _resetAnimations(scope) {
    const sel = '.anim-blur-rise, .anim-blur-scale, .anim-slide-blur, .anim-drop, .anim-pop, .anim-grow';
    const els = Array.from(scope.querySelectorAll(sel));
    if (!els.length) return;
    els.forEach(el => {
        el.style.transition = 'none';
        el.classList.remove('animate-in', 'reveal-top', 'tab-enter-forward', 'tab-enter-back');
        el.style.transitionDelay = '';
        delete el.dataset.revealed;
    });
    scope.offsetHeight; // single forced reflow commits the hidden state
    els.forEach(el => el.style.transition = '');
}
