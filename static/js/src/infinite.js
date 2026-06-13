// === infinite.js ===
// Infinite scroll: a single shared IntersectionObserver watches .inf-sentinel
// elements and fires their htmx request (hx-trigger="inf-load once") when they
// come within _INF_MARGIN of the viewport — content is fetched well before the
// user reaches the bottom, so scrolling never waits on the network.
//
// Each sentinel replaces ITSELF (hx-swap="outerHTML") with the next page of
// items plus a fresh sentinel pointing at the page after — or nothing when the
// list is exhausted. No OOB swaps, and no race with filter changes: a filter's
// innerHTML swap detaches any in-flight sentinel, so a late append response
// lands on a disconnected node and is a harmless no-op.
//
// Sentinels inside a display:none view (library table/grid toggle) have no
// layout box, so the observer never reports them intersecting; they arm
// automatically when their view becomes visible.
// globals: initInfiniteScroll, revealAppended, _mergeAchGroupContinuations
// depends on: animations.js (ANIM_SEL, _queueReveal)

const _INF_MARGIN = '1200px 0px';
let _infObs = null;
const _infSeen = new WeakSet();

// Fire a sentinel's htmx request, retrying until the swap replaces it.
// htmx attaches the inf-load listener during SETTLE (~20ms after the swap
// inserts the sentinel), but IntersectionObserver callbacks can run in the
// next rendering frame — triggering into that window loses the event and the
// append chain silently dies (reproduced: chain stalled at page 4 with an
// armed-but-deaf sentinel). Retrying is safe: hx-trigger="once" removes the
// listener after the first real fire, so extra triggers are no-ops, and a
// successful swap detaches the element, which stops the loop.
function _fireSentinel(el) {
    let tries = 0;
    const attempt = () => {
        if (!el.isConnected || typeof htmx === 'undefined') return;
        htmx.trigger(el, 'inf-load');
        if (++tries < 8) setTimeout(attempt, 150);
    };
    attempt();
}

function _infObserver() {
    if (_infObs) return _infObs;
    _infObs = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            _infObs.unobserve(el);
            if (!el.isConnected) continue;
            _fireSentinel(el);
        }
    }, { rootMargin: _INF_MARGIN });
    return _infObs;
}

function initInfiniteScroll(root) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    const els = scope.querySelectorAll('.inf-sentinel[hx-get]');
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (_infSeen.has(el)) continue;
        _infSeen.add(el);
        _infObserver().observe(el);
    }
}

// New sentinels arrive via htmx swaps (appends, filter swaps, SPA navs) and
// preload.js's short-circuit navigations. Scanning the whole document is
// cheap — at most a handful of sentinels exist at once, and the WeakSet
// skips already-observed ones.
//
// BOTH afterSwap and afterSettle are required. preload.js's hover-cache
// short-circuit and popstate restore dispatch a synthetic afterSwap and never
// settle — listening only on afterSettle left every preload-path navigation
// with an unobserved (dead) sentinel until refresh. The afterSwap path is
// race-safe: preload.js runs htmx.process() synchronously before dispatching,
// and on the real XHR path _fireSentinel's retry covers the ~20ms settle gap.
document.addEventListener('htmx:afterSwap', () => initInfiniteScroll(document));
document.addEventListener('htmx:afterSettle', () => initInfiniteScroll(document));
document.addEventListener('DOMContentLoaded', () => initInfiniteScroll(document));

// Drop observations for sentinels about to be removed by a swap — the IO holds
// strong refs to its targets, which would keep the detached subtree alive
// (same pattern as initOffscreenAnimationPause's beforeSwap hook).
document.body.addEventListener('htmx:beforeSwap', (evt) => {
    if (!_infObs) return;
    const target = evt.target;
    if (!target || !target.querySelectorAll) return;
    if (target.classList && target.classList.contains('inf-sentinel')) _infObs.unobserve(target);
    const stale = target.querySelectorAll('.inf-sentinel');
    for (let i = 0; i < stale.length; i++) _infObs.unobserve(stale[i]);
});

// ─── Append reveal pipeline ───────────────────────────────────────────────────
// initScrollAnimations() is the wrong tool after an infinite-scroll append: it
// disconnects the page-wide scroll observer and bumps the generation counter,
// which (a) orphans every below-fold element OUTSIDE the appended container —
// their observer is gone, animate-in never arrives, they stay invisible — and
// (b) cancels the entrance cascade's pending timers when an append lands during
// page entry. The 1200px prefetch margin makes mid-entrance appends the common
// case (the timeline fires page 2 on load), so appends get their own purely
// ADDITIVE observer: it only ever watches not-yet-animated elements inside
// appended content and reveals them through the same rAF-capped queue
// (_queueReveal, 4 mutations/frame) the global pipeline uses.
let _appendRevealObs = null;
const _appendRevealSeen = new WeakSet();

function _appendRevealObserver() {
    if (_appendRevealObs) return _appendRevealObs;
    _appendRevealObs = new IntersectionObserver((entries) => {
        // House reveal cadence (mirrors initScrollAnimations' IO path): entries
        // landing in the same observer batch reveal top-to-bottom, ~48ms apart,
        // so appended items cascade in like every other scroll reveal instead
        // of popping in same-frame clumps. Slow scrolling separates entries
        // across batches naturally; the stagger only shapes fast-scroll bursts.
        const visible = entries.filter(e => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (!visible.length) return;
        const unit = Math.round((_cssDur('--stagger') || 50) * 0.8);
        visible.forEach((entry, idx) => {
            _appendRevealObs.unobserve(entry.target);
            if (idx === 0) { _queueReveal(entry.target); return; }
            setTimeout(() => {
                if (entry.target.isConnected) _queueReveal(entry.target);
            }, idx * unit);
        });
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    return _appendRevealObs;
}

function revealAppended(container) {
    const els = container.querySelectorAll(ANIM_SEL);
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.classList.contains('animate-in') || _appendRevealSeen.has(el)) continue;
        _appendRevealSeen.add(el);
        if (el.classList.contains('game-row')) {
            // Library rows use the dual row observers (initRowScrollReveal) for
            // persistent reveal/unreveal — mirror initScrollAnimations' below-fold
            // row handling: mark revealed, let the entry observer add animate-in.
            el.dataset.revealed = '1';
        } else {
            _appendRevealObserver().observe(el);
        }
    }
}

// Filter swaps replace containers holding observed-but-unrevealed elements;
// drop those observations so the IO doesn't pin the detached subtree in memory.
document.body.addEventListener('htmx:beforeSwap', (evt) => {
    if (!_appendRevealObs) return;
    const target = evt.target;
    if (!target || !target.querySelectorAll) return;
    const stale = target.querySelectorAll(ANIM_SEL);
    for (let i = 0; i < stale.length; i++) _appendRevealObs.unobserve(stale[i]);
});

// After a grouped-achievements append, the new batch can start with the same
// group (game/rarity) the previous page ended with. Merge adjacent duplicate
// groups so the header doesn't repeat at page boundaries — move the new
// group's cards into the previous group's grid and drop the duplicate shell.
function _mergeAchGroupContinuations(wrap) {
    const groups = wrap.querySelectorAll(':scope > [data-key]');
    for (let i = 1; i < groups.length; i++) {
        const prev = groups[i - 1];
        const cur = groups[i];
        if (prev.dataset.key !== cur.dataset.key || !prev.isConnected) continue;
        const prevGrid = prev.querySelector(':scope > .ach-grid');
        const curGrid = cur.querySelector(':scope > .ach-grid');
        if (prevGrid && curGrid) {
            while (curGrid.firstChild) prevGrid.appendChild(curGrid.firstChild);
        }
        cur.remove();
    }
}

// ─── Append-failure recovery ──────────────────────────────────────────────────
// `inf-load once` burns its trigger on the first fire regardless of outcome, and
// the observer unobserves the sentinel after firing — so a failed append (5xx or
// dropped connection) leaves a deaf, unobserved sentinel and the chain is dead
// until a full reload. Recover by re-arming: a sentinel CLONE is a fresh node
// with no consumed-`once` state, so cloning + htmx.process + re-observe revives
// the chain (a re-observed sentinel still in view re-fires next frame). One
// silent auto-retry absorbs a transient blip; a second failure swaps in a visible
// Retry control. responseError = HTTP non-2xx, sendError = network failure —
// both leave the sentinel un-swapped.
const _INF_RETRY_DELAY = 1500;

function _reviveSentinel(dead) {
    const fresh = dead.cloneNode(true);
    fresh.dataset.infRetries = String(parseInt(dead.dataset.infRetries || '0', 10) + 1);
    dead.replaceWith(fresh);
    if (typeof htmx !== 'undefined') htmx.process(fresh);
    _infObserver().observe(fresh);
    _infSeen.add(fresh);
}

function _showInfRetry(dead) {
    const isRow = dead.tagName === 'TR';
    // A fresh sentinel kept aside for when the user clicks Retry (counter reset).
    const reborn = dead.cloneNode(true);
    reborn.dataset.infRetries = '0';

    const retry = document.createElement(isRow ? 'tr' : 'div');
    retry.className = 'inf-retry';
    let host = retry;
    if (isRow) {
        const td = document.createElement('td');
        const oldTd = dead.querySelector('td');
        td.colSpan = oldTd ? oldTd.colSpan : 7;
        retry.appendChild(td);
        host = td;
    }
    host.innerHTML = '<span>Couldn’t load more.</span><button type="button" class="inf-retry-btn">Retry</button>';
    dead.replaceWith(retry);

    host.querySelector('.inf-retry-btn').addEventListener('click', () => {
        retry.replaceWith(reborn);
        if (typeof htmx !== 'undefined') htmx.process(reborn);
        _infObserver().observe(reborn);
        _infSeen.add(reborn);
        _fireSentinel(reborn);  // user asked for it — fire now, don't wait for re-intersect
    }, { once: true });
}

function _onSentinelError(evt) {
    const el = evt.detail && evt.detail.elt;
    if (!el || !el.classList || !el.classList.contains('inf-sentinel') || !el.isConnected) return;
    if (parseInt(el.dataset.infRetries || '0', 10) < 1) {
        setTimeout(() => { if (el.isConnected) _reviveSentinel(el); }, _INF_RETRY_DELAY);
    } else {
        _showInfRetry(el);
    }
}

document.body.addEventListener('htmx:responseError', _onSentinelError);
document.body.addEventListener('htmx:sendError', _onSentinelError);
