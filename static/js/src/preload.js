// === preload.js ===
// Nav-link hover prefetch: warm the SPA response into an in-memory cache, then
// short-circuit the real XHR when the user clicks. On cache hit, we replace
// #main innerHTML directly, call htmx.process to wire hx-* on new nodes, and
// dispatch a synthetic htmx:afterSwap so nav.js's re-init pipeline (exit-state
// cleanup, entrance, glass prewarm, reveal, blurhash, etc.) runs unchanged.
//
// All nav links use plain URLs (no query params), so preloaded responses match
// what the XHR would fetch. Client-side filter/view restoration runs in
// nav.js's idle cascade AFTER the swap, independent of cache vs network source.

(function () {
    'use strict';
    if (!window.htmx) return;

    // Own the whole history pipeline ourselves. htmx's default pipeline
    // (cache in localStorage, restore via Wt/Gt) doesn't mesh with our
    // beforeRequest short-circuit — the cache never fills from short-circuit
    // navs, and on Back htmx falls into Gt which historically mis-targeted
    // the swap. Disabling it forces every pushState/replaceState through us
    // and routes popstate through the handler below.
    try { htmx.config.historyEnabled = false; } catch (_) {}
    // htmx installs window.onpopstate unconditionally at load; clear it so our
    // addEventListener below is the only popstate path.
    try { window.onpopstate = null; } catch (_) {}

    const TTL_MS = 30_000;
    const HOVER_DEBOUNCE_NAV_MS = 40;
    const HOVER_DEBOUNCE_GAME_MS = 150;
    const MAX_CACHE = 24;
    const NAV_SEL = '.nav-link[hx-get], .nav-brand[hx-get], .nav-profile-chip[hx-get], .back-link[hx-get]';
    const GAME_SEL = '[hx-get^="/game/"][hx-target="#main"]';
    const LINK_SEL = NAV_SEL + ', ' + GAME_SEL;

    const cache = new Map(); // url -> { text, ts, pending } — insertion order = LRU
    let hoverTimer = null;
    let hoverTargetUrl = null;

    function trimCache() {
        while (cache.size > MAX_CACHE) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    }

    function isFresh(entry) {
        return entry && (Date.now() - entry.ts) <= TTL_MS;
    }

    function prefetch(url) {
        const existing = cache.get(url);
        if (existing && (existing.pending || isFresh(existing))) return;

        const entry = { text: null, ts: Date.now(), pending: null };
        const req = fetch(url, {
            headers: {
                'X-SPA-Nav': 'true',
                'HX-Request': 'true',
                'HX-Target': 'main'
            },
            credentials: 'same-origin'
        })
            .then(r => r.ok ? r.text() : null)
            .catch(() => null)
            .then(text => {
                entry.text = text;
                entry.ts = Date.now();
                entry.pending = null;
                if (text == null) cache.delete(url);
                return text;
            });
        entry.pending = req;
        cache.set(url, entry);
        trimCache();
    }

    function takeFresh(url) {
        const entry = cache.get(url);
        if (!entry || entry.pending || !isFresh(entry) || entry.text == null) return null;
        cache.delete(url); // one-shot — prevent stale reuse after nav
        return entry.text;
    }

    document.body.addEventListener('mouseover', (e) => {
        const link = e.target.closest(LINK_SEL);
        if (!link) return;
        const url = link.getAttribute('hx-get');
        if (!url || url === location.pathname) return;
        if (hoverTargetUrl === url) return;
        hoverTargetUrl = url;
        const delay = link.matches(NAV_SEL) ? HOVER_DEBOUNCE_NAV_MS : HOVER_DEBOUNCE_GAME_MS;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => prefetch(url), delay);
    }, { passive: true });

    document.body.addEventListener('mouseout', (e) => {
        const link = e.target.closest(LINK_SEL);
        if (!link) return;
        if (hoverTargetUrl === link.getAttribute('hx-get')) hoverTargetUrl = null;
    }, { passive: true });

    // Touch devices: prime on touchstart (press-in before release).
    document.body.addEventListener('touchstart', (e) => {
        const link = e.target.closest(LINK_SEL);
        if (!link) return;
        const url = link.getAttribute('hx-get');
        if (!url || url === location.pathname) return;
        prefetch(url);
    }, { passive: true });

    // Short-circuit htmx XHR when cache has a fresh response. The real request
    // would fire ~250ms after click (post-exit animation); by then the fetch
    // started on hover is usually complete.
    //
    // We dispatch a synthetic htmx:afterSwap instead of calling htmx.swap —
    // htmx.swap's event shape differs from the XHR-driven path enough that
    // nav.js's afterSwap handler doesn't run (entrance, opacity clear, glass
    // prewarm all skipped), which leaves <main> stuck in its exit state.
    document.body.addEventListener('htmx:beforeRequest', (evt) => {
        const cfg = evt.detail && evt.detail.requestConfig;
        if (!cfg || !cfg.elt) return;
        if (cfg.elt.getAttribute('hx-target') !== '#main') return;

        const url = cfg.path;
        const text = takeFresh(url);
        if (text == null) return;

        const main = document.getElementById('main');
        if (!main) return;

        evt.preventDefault();

        if (cfg.elt.getAttribute('hx-push-url') === 'true') {
            try { history.pushState({ htmx: true }, '', url); } catch (_) {}
        }

        try {
            main.innerHTML = text;
            if (typeof htmx.process === 'function') htmx.process(main);
            main.dispatchEvent(new CustomEvent('htmx:afterSwap', {
                bubbles: true,
                cancelable: false,
                detail: { target: main, elt: main, requestConfig: cfg }
            }));
        } catch (_) {
            // Recover: fire a fresh request without the cache short-circuit.
            htmx.ajax('GET', url, { target: '#main', swap: 'innerHTML' });
        }
    });

    // With htmx.historyEnabled=false, htmx won't push URLs for the non-short-circuit
    // path (cache miss, normal XHR). Mirror that behaviour ourselves by pushing on
    // afterSwap when the initiating element asked for it.
    document.body.addEventListener('htmx:afterSwap', (evt) => {
        const cfg = evt.detail && evt.detail.requestConfig;
        if (!cfg || !cfg.elt || !cfg.elt.getAttribute) return;
        if (cfg.elt.getAttribute('hx-push-url') !== 'true') return;
        const path = cfg.path;
        if (!path) return;
        const current = location.pathname + location.search;
        if (current === path) return;
        try { history.pushState({ spa: true }, '', path); } catch (_) {}
    });

    // Stamp the initial entry so Back from page #2 lands here (otherwise
    // popstate sees state=null and does nothing, and the browser just shows
    // a stale bfcache-ish main).
    try {
        if (!history.state || !history.state.spa) {
            history.replaceState({ spa: true }, '', location.href);
        }
    } catch (_) {}

    // Own popstate: fetch a fresh SPA partial and swap it into #main.
    // Never a full-page reload (which would lose client state); never a
    // DOM diff against potentially-stale cache (which gave us nested navs).
    let popInFlight = 0;
    window.addEventListener('popstate', (e) => {
        if (e.state && !e.state.spa && !e.state.htmx) return;
        const main = document.getElementById('main');
        if (!main) return;
        const url = location.pathname + location.search;
        const gen = ++popInFlight;

        const run = (text) => {
            if (gen !== popInFlight) return; // superseded by a newer pop
            try {
                main.innerHTML = text;
                if (typeof htmx.process === 'function') htmx.process(main);
                main.dispatchEvent(new CustomEvent('htmx:afterSwap', {
                    bubbles: true,
                    cancelable: false,
                    detail: { target: main, elt: main, requestConfig: { path: url, elt: main, verb: 'get' } }
                }));
            } catch (_) {
                location.reload();
            }
        };

        const cached = takeFresh(url);
        if (cached != null) { run(cached); return; }

        fetch(url, {
            headers: {
                'X-SPA-Nav': 'true',
                'HX-Request': 'true',
                'HX-Target': 'main'
            },
            credentials: 'same-origin'
        })
            .then(r => r.ok ? r.text() : null)
            .then(text => { if (text != null) run(text); else location.reload(); })
            .catch(() => location.reload());
    });
})();
