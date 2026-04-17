// === animations.js ===
// Scroll-triggered animations, row scroll-reveal, edge scale, capture group animations,
// and directional page entrance. Depends on: utils.js (_cssDur).
// globals: initScrollAnimations, initRowScrollReveal, initEdgeScale,
//          initCaptureGroupAnimations, _resetAnimations, _reapplyEntranceDir

// ─── Shared selector ──────────────────────────────────────────────────────────
const ANIM_SEL = '.anim-blur-rise, .anim-blur-scale, .anim-slide-blur, .anim-drop, .anim-pop, .anim-grow';

// ─── Directional entrance state ───────────────────────────────────────────────
// Written by initPageEntrance() (nav.js) before initScrollAnimations() runs.
// _tabEnterClass     — consumed by the first initScrollAnimations call for above-fold leaders.
// _lastTabEnterClass — survives that call so async content (grid fetched after SPA nav)
//                     can still receive the correct direction via _reapplyEntranceDir.
// Scroll-revealed elements never receive this — they always animate vertically.
let _tabEnterClass = null;
let _lastTabEnterClass = null;

// Re-apply the saved entrance direction for async content (e.g. grid fetched after SPA nav).
// Passes keepGen=true so the global _scrollAnimGen is NOT incremented — this prevents
// cancelling the still-in-flight stagger cascade for the main page elements that were
// queued by the earlier initScrollAnimations(main, true) call.
function _reapplyEntranceDir(root) {
    if (_lastTabEnterClass) {
        _tabEnterClass = _lastTabEnterClass;
        _lastTabEnterClass = null;
    }
    initScrollAnimations(root, true, true);
}

// ─── Scroll-triggered animations ─────────────────────────────────────────────
// scroll-ready is set on <html> in base.html so elements start hidden from first paint.
// animate-in is triggered via rAF (htmx swaps) or synchronously (initial DCL) to
// guarantee the hidden state is composited before transitioning.
//
// Generation counter: incremented on every initScrollAnimations call. Each rAF callback
// and every setTimeout it creates captures the generation at scheduling time and bails
// early if a newer call has since superseded it. This prevents stale timer callbacks
// from firing on old DOM after rapid navigations, and eliminates the observer self-
// reference bug (no module-level unobserve() — each call uses a captured local obs).

let _scrollAnimObs = null;
let _scrollAnimGen = 0;

function initScrollAnimations(root, forceStagger = false, keepGen = false) {
    if (_scrollAnimObs) { _scrollAnimObs.disconnect(); _scrollAnimObs = null; }

    const scope = root || document;
    const isInitialLoad = !root || forceStagger;
    const els = scope.querySelectorAll(ANIM_SEL);
    if (!els.length) return;

    // keepGen: don't increment the global counter. Used by _reapplyEntranceDir for async
    // sub-page content (e.g. grid fetched after SPA nav) so it doesn't cancel the still-
    // in-flight stagger cascade for the main page elements (filters, header, etc.).
    if (!keepGen) ++_scrollAnimGen;
    const gen = _scrollAnimGen;

    // Initial DCL: first paint already happened — run synchronously.
    // htmx swaps: use rAF so new DOM is composited before reading rects.
    const schedule = (isInitialLoad && !root) ? fn => fn() : fn => requestAnimationFrame(fn);

    schedule(() => {
        if (_scrollAnimGen !== gen) return; // superseded by a newer initScrollAnimations call

        const viewH = window.innerHeight;

        // CSS --i stagger is suppressed (transitionDelay forced to '0ms') so JS setTimeout
        // is the sole timing source. Without this, CSS delay stacks on top of observer fire
        // time — visible lag on deeply-indexed rows (e.g. row 15 → 750ms wait).
        const stagger = _cssDur('--stagger') || 50;
        const unit = Math.round(stagger * 0.8); // ~48ms per step, above 50ms perception threshold

        const obs = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            visible.forEach((entry, idx) => {
                obs.unobserve(entry.target); // captured local — never stale
                setTimeout(() => {
                    if (_scrollAnimGen !== gen) return; // stale — discard
                    entry.target.style.transitionDelay = '0ms';
                    entry.target.classList.add('animate-in');
                }, idx * unit);
            });
        }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
        _scrollAnimObs = obs;

        const aboveFold = [];

        els.forEach(el => {
            if (el.classList.contains('animate-in')) return;
            if (el.closest('.captures-game-group')) return; // sequenced by initCaptureGroupAnimations
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return; // skip display:none containers

            const isGameRow = el.classList.contains('game-row');
            const topEdge = isGameRow ? _scrollRevealTopExit : 0;
            const botEdge = isGameRow ? viewH : viewH + 120;

            if (rect.top > topEdge && rect.top < botEdge) {
                aboveFold.push(el);
            } else if (!isGameRow) {
                obs.observe(el);
            } else {
                el.dataset.revealed = '1';
            }
        });

        if (isInitialLoad && aboveFold.length > 0) {
            _cascadeAboveFold(aboveFold, unit, !root, gen);
        } else {
            // Set transitionDelay to '0ms' to suppress the CSS --i stagger before adding
            // animate-in. Without this, the CSS calc(var(--i) * var(--stagger)) rule on
            // .anim-stagger children persists and staggers the EXIT animation when the user
            // navigates away — the same fix applied to grid cards in the htmx:afterSwap handler.
            aboveFold.forEach(el => {
                el.style.transitionDelay = '0ms';
                el.classList.add('animate-in');
            });
        }
    });
}

// Staggered entrance cascade for above-fold elements on initial load or tab switch.
// Splits elements into leaders (top-level animated elements) and dependents (animated
// children of other animated elements). Leaders stagger in DOM order; dependents commit
// instantly, hidden behind their parent's opacity until the parent animates in.
// gen is passed through to setTimeout guards so stale timers from superseded calls bail early.
function _cascadeAboveFold(aboveFold, unit, isFirstPaint, gen) {
    const MAX_CASCADE = 500;
    const aboveFoldSet = new Set(aboveFold);

    const leaders = [];
    const dependents = [];
    for (const el of aboveFold) {
        let ancestor = el.parentElement;
        let isDependent = false;
        while (ancestor) {
            if (aboveFoldSet.has(ancestor)) { isDependent = true; break; }
            ancestor = ancestor.parentElement;
        }
        (isDependent ? dependents : leaders).push(el);
    }

    // Dependents: commit to animate-in instantly with no transition (hidden by parent opacity).
    if (dependents.length) {
        if (_tabEnterClass) dependents.forEach(el => el.classList.add(_tabEnterClass));
        dependents.forEach(el => el.style.transition = 'none');
        dependents.forEach(el => el.classList.add('animate-in'));
        dependents[0].offsetHeight; // single forced reflow commits all at once
        dependents.forEach(el => el.style.transition = '');
    }

    // Leaders: stagger sequentially in DOM order, compressed to fit MAX_CASCADE when many.
    const leaderUnit = leaders.length <= 8
        ? Math.max(unit, 80)
        : Math.max(Math.floor(MAX_CASCADE / leaders.length), 12);

    // Snap leaders to the directional entry position before re-enabling transitions.
    // Adding tab-enter-forward/back changes transform from translateY → translateX, which
    // fires the CSS transition between the two hidden states. When animate-in is added
    // milliseconds later, the interrupted position is still essentially translateY, so
    // the entrance plays as the vertical "fresh load" animation instead of horizontal.
    // transition:none + forced reflow locks in the translateX start position first.
    if (_tabEnterClass && leaders.length) {
        leaders.forEach(el => {
            el.style.transition = 'none';
            el.classList.add(_tabEnterClass);
        });
        leaders[0].offsetHeight; // single forced reflow commits all positions at once
        leaders.forEach(el => el.style.transition = '');
    }

    leaders.forEach((el, idx) => {
        el.style.transitionDelay = '0ms';
        if (idx === 0 && isFirstPaint) {
            el.classList.add('animate-in'); // first element fires synchronously on true page load
        } else {
            const ms = idx * leaderUnit;
            if (ms === 0) {
                // rAF instead of setTimeout(0): fires in the same vsync as the first glass
                // frame so glass and content begin their entrance transitions together,
                // eliminating the ~16ms window where content moves without glass behind it.
                requestAnimationFrame(() => {
                    if (_scrollAnimGen !== gen) return;
                    el.classList.add('animate-in');
                });
            } else {
                setTimeout(() => {
                    if (_scrollAnimGen !== gen) return;
                    el.classList.add('animate-in');
                }, ms);
            }
        }
    });

    _tabEnterClass = null; // consumed — only the first initScrollAnimations call per nav uses it
}

// ─── Row scroll-reveal ────────────────────────────────────────────────────────
// Dual IntersectionObserver for persistent scroll-reveal on game rows:
//   Entry observer — fires when a row enters the visible area → animate-in
//   Exit observer  — fires 60px before the edge → removes animate-in (visible fade-out)
// _scrollRevealTopExit is also consumed by initScrollAnimations for the initial cascade.
//
// viewMid is computed inside each observer callback from live _cachedNav* values so that
// resize events (which update the cache) are reflected without recreating the observers.

let _rowEntryObs = null;
let _rowExitObs = null;
let _cachedNavH = 56;
let _cachedTheadH = 35;
let _scrollRevealTopExit = _cachedNavH + _cachedTheadH + 60;

function _refreshScrollRevealHeights() {
    const nav = document.querySelector('.xbox-nav');
    const thead = document.querySelector('.game-table thead');
    _cachedNavH = nav ? nav.offsetHeight : 56;
    _cachedTheadH = thead ? thead.offsetHeight : 35;
    _scrollRevealTopExit = _cachedNavH + _cachedTheadH + 60;
}

// Debounce the resize handler: _refreshScrollRevealHeights reads offsetHeight on two
// elements — firing on every resize event (up to 60/s during window drag) causes
// unnecessary forced layout reads. A 120ms trailing debounce fires once the user
// pauses, which is sufficient for the scroll-reveal threshold to stay accurate.
let _rrResizeTimer = 0;
window.addEventListener('resize', () => {
    clearTimeout(_rrResizeTimer);
    _rrResizeTimer = setTimeout(_refreshScrollRevealHeights, 120);
}, { passive: true });
document.addEventListener('DOMContentLoaded', _refreshScrollRevealHeights);

function initRowScrollReveal(scope) {
    // Disconnect before the early return so stale observers don't hold library DOM
    // nodes alive when navigating away from the library to a non-library page.
    if (_rowEntryObs) { _rowEntryObs.disconnect(); _rowEntryObs = null; }
    if (_rowExitObs)  { _rowExitObs.disconnect();  _rowExitObs  = null; }

    const container = scope || document;
    const rows = container.querySelectorAll('.game-row.anim-blur-rise');
    if (!rows.length) return;

    const topInset = _cachedNavH + _cachedTheadH;

    // viewMid is read from the cache inside each callback rather than captured here —
    // this keeps it current after window resizes without recreating the observers.
    _rowEntryObs = new IntersectionObserver((entries) => {
        const viewMid = (_cachedNavH + _cachedTheadH + window.innerHeight) / 2;
        for (const entry of entries) {
            const el = entry.target;
            if (!entry.isIntersecting || !el.dataset.revealed) continue;
            el.style.transitionDelay = '0ms';
            el.classList.toggle('reveal-top', entry.boundingClientRect.top < viewMid);
            el.classList.add('animate-in');
        }
    }, { threshold: 0.05, rootMargin: `-${topInset}px 0px 0px 0px` });

    _rowExitObs = new IntersectionObserver((entries) => {
        const viewMid = (_cachedNavH + _cachedTheadH + window.innerHeight) / 2;
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

// ─── Edge proximity scale ─────────────────────────────────────────────────────
// Continuously scales game rows down as they approach the top/bottom viewport edges.
// An IntersectionObserver tracks the nearby-rows set (activeRows) so the rAF loop
// only processes rows near the viewport. --edge-scale is written to each row only
// when the value changes.

let _edgeScaleCleanup = null;
let _edgeScaleRowsObs = null;

function initEdgeScale() {
    if (_edgeScaleCleanup) _edgeScaleCleanup();

    // _cachedNavH/_cachedTheadH are kept fresh by _refreshScrollRevealHeights (DOMContentLoaded
    // + debounced resize). Reading offsetHeight here would duplicate the same forced layout.
    const navH   = _cachedNavH;
    const theadH = _cachedTheadH;
    const topBound = navH + theadH + 60;
    const FADE_ZONE = 160;
    const MIN_SCALE = 0.96;
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

    function seedActiveRows() {
        const scrollY = window.scrollY;
        const vpH = window.innerHeight;
        for (let i = 0; i < allRows.length; i++) {
            const docTop = rowDocTop[i];
            const inRange = docTop + rowHeight[i] >= scrollY - ACTIVE_MARGIN
                         && docTop <= scrollY + vpH + ACTIVE_MARGIN;
            if (inRange) activeRows.add(allRows[i]);
            else activeRows.delete(allRows[i]);
        }
    }

    if (_edgeScaleRowsObs) _edgeScaleRowsObs.disconnect();
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
            if (!row.isConnected) { activeRows.delete(row); continue; }

            const i = rowIdx.get(row);
            const rTop = rowDocTop[i] - scrollY;
            const rHeight = rowHeight[i];

            // Compensate for the entrance transform offset on hidden rows so the
            // scale pivot tracks the row's visual midpoint, not its layout midpoint.
            let compensate = 0;
            if (!row.classList.contains('animate-in')) {
                compensate = row.classList.contains('reveal-top') ? 48 : -48;
            }
            const rowMid = rTop + compensate + rHeight * 0.5;

            const distFromTop = rowMid - topBound;
            const distFromBot = botBound - rowMid;
            const closest = Math.min(distFromTop, distFromBot);

            let s;
            if (closest >= FADE_ZONE) {
                s = 1;
            } else if (closest <= 0) {
                s = MIN_SCALE;
            } else {
                const t = closest / FADE_ZONE;
                s = MIN_SCALE + (1 - MIN_SCALE) * (1 - (1 - t) * (1 - t));
            }

            const nextScale = s.toFixed(4);
            if (row.__edgeScale !== nextScale) {
                row.__edgeScale = nextScale;
                row.style.setProperty('--edge-scale', nextScale);
            }
        }
    }

    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }

    // seedRowPositions calls getBoundingClientRect for every row — debounce at 120ms
    // so continuous window-drag resize only triggers one batch read after the user pauses.
    let _edgeResizeTimer = 0;
    function onResize() {
        clearTimeout(_edgeResizeTimer);
        _edgeResizeTimer = setTimeout(() => { seedRowPositions(); seedActiveRows(); onScroll(); }, 120);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    update();

    _edgeScaleCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        clearTimeout(_edgeResizeTimer); // cancel any pending debounce
        if (_edgeScaleRowsObs) { _edgeScaleRowsObs.disconnect(); _edgeScaleRowsObs = null; }
        _edgeScaleCleanup = null;
    };
}

// ─── Captures by-game group animations ───────────────────────────────────────
// The by-game view sequences each group's elements individually rather than via
// initScrollAnimations — required because animated parent containers would create
// stacking contexts that break backdrop-filter compositing on glass children.
//
// Same gen-counter pattern: incremented on each initCaptureGroupAnimations call,
// passed to _fireGroupElements so stale timers from superseded calls bail early.

let _captureGroupObs = null;
let _captureGroupGen = 0;

function _fireGroupElements(group, baseDelay, itemUnit, gen) {
    const animEls = Array.from(group.querySelectorAll(ANIM_SEL))
        .filter(el => !el.classList.contains('animate-in'));
    if (!animEls.length) return;

    // Pre-read all rects before the sort comparator runs.
    // Sorting with getBoundingClientRect() inside the comparator triggers O(n log n) layout
    // reads — one per comparison. Batching them first reduces that to a single O(n) flush.
    const rectOf = new Map(animEls.map(el => [el, el.getBoundingClientRect()]));
    animEls.sort((a, b) => {
        const ra = rectOf.get(a), rb = rectOf.get(b);
        return (ra.top - rb.top) || (ra.left - rb.left);
    });
    animEls.forEach((el, idx) => {
        el.style.transitionDelay = '0ms';
        setTimeout(() => {
            if (_captureGroupGen !== gen) return; // stale — discard
            el.classList.add('animate-in');
        }, baseDelay + idx * itemUnit);
    });
}

function initCaptureGroupAnimations(scope) {
    if (_captureGroupObs) { _captureGroupObs.disconnect(); _captureGroupObs = null; }

    const groups = Array.from((scope || document).querySelectorAll('.captures-game-group'));
    if (!groups.length) return;

    const gen = ++_captureGroupGen;

    requestAnimationFrame(() => {
        if (_captureGroupGen !== gen) return; // superseded

        const stagger = _cssDur('--stagger') || 60;
        const groupUnit = Math.max(stagger, 80);
        const itemUnit  = Math.round(stagger * 0.8);
        const viewH = window.innerHeight;

        const aboveGroups = [];
        const belowGroups = [];
        for (const group of groups) {
            const rect = group.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            (rect.top < viewH + 40 ? aboveGroups : belowGroups).push(group);
        }

        aboveGroups.forEach((group, gIdx) => _fireGroupElements(group, gIdx * groupUnit, itemUnit, gen));

        const captureObs = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                captureObs.unobserve(entry.target); // captured local — never stale
                _fireGroupElements(entry.target, 0, itemUnit, gen);
            }
        }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
        _captureGroupObs = captureObs;

        belowGroups.forEach(group => captureObs.observe(group));
    });
}

// ─── Reset animations ─────────────────────────────────────────────────────────
// Clears animate-in state before re-triggering (used by library view toggle).
function _resetAnimations(scope) {
    const els = Array.from(scope.querySelectorAll(ANIM_SEL));
    if (!els.length) return;
    els.forEach(el => {
        el.style.transition = 'none';
        el.classList.remove('animate-in', 'reveal-top', 'tab-enter-forward', 'tab-enter-back');
        el.style.transitionDelay = '';
        delete el.dataset.revealed;
    });
    scope.offsetHeight; // forced reflow commits the hidden state before transitions restore
    els.forEach(el => el.style.transition = '');
}
