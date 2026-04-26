// === nav.js ===
// SPA navigation: htmx:confirm exit animation, htmx:afterSwap re-init,
// non-SPA link exit, nav pill slide, scroll-aware nav, page entrance direction.
// globals: initNavPillTrack, initScrollNav
// sets: _tabEnterClass, _lastTabEnterClass (consumed by animations.js)

const NAV_ORDER = { '/': 0, '/library': 1, '/achievements': 2, '/timeline': 3, '/captures': 4, '/friends': 5 };

const TAB_EXIT_FWD  = 'tab-exit-forward';
const TAB_EXIT_BACK = 'tab-exit-back';
const ALL_EXIT_CLASSES = [TAB_EXIT_FWD, TAB_EXIT_BACK];

function _navPathname(urlish) {
    if (!urlish) return window.location.pathname;
    try {
        return new URL(urlish, window.location.origin).pathname || window.location.pathname;
    } catch {
        const clean = String(urlish).split('#')[0].split('?')[0];
        return clean.startsWith('/') ? clean : window.location.pathname;
    }
}

function _navActivePath(urlish) {
    const path = _navPathname(urlish);
    if (path.startsWith('/game/')) return '/library';
    if (path.startsWith('/timeline')) return '/timeline';
    return path;
}

// Page entrance — two modes, same per-element stagger, different axis:
//   Fresh load  → vertical (rise/drop/pop as defined in CSS)
//   Tab switch  → horizontal (per-element .tab-enter-forward / .tab-enter-back)
function initPageEntrance() {
    const dir = sessionStorage.getItem('nav-dir');
    sessionStorage.removeItem('nav-dir');
    _tabEnterClass = dir === 'forward' ? 'tab-enter-forward'
                   : dir === 'back'    ? 'tab-enter-back'
                   : null;
    _lastTabEnterClass = _tabEnterClass;
}

function _navDirection(fromPath, toPath) {
    const fromIdx = NAV_ORDER[_navActivePath(fromPath)] ?? -1;
    const toIdx = NAV_ORDER[_navActivePath(toPath)] ?? -1;
    return (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx)
        ? (toIdx > fromIdx ? 'forward' : 'back')
        : null;
}

// ─── Navigation state ─────────────────────────────────────────────────────────
let _mainEl = null;
function _getMain() { return _mainEl || (_mainEl = document.querySelector('main')); }

let _pendingSpaNavTimer = null;
let _spaNavGen = 0;
let _spaNavInFlight = false;

// Position the pill track over `el`. Uses offsetLeft/offsetWidth (integer layout
// values, stable across font swaps) and sets CSS custom properties instead of inline
// left/width. .pill-animate gates the transition so initial paint and ResizeObserver
// updates snap while clicks animate.
function _positionPill(el, animate) {
    const track = document.getElementById('nav-pill-track');
    if (!track || !el) return;
    // Read geometry first, then write — toggling pill-animate invalidates layout,
    // and reading offsetLeft/offsetWidth after the toggle forces a synchronous
    // reflow. Reads first means a single layout pass for both values.
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    track.classList.toggle('pill-animate', !!animate);
    track.style.setProperty('--pill-x', x + 'px');
    track.style.setProperty('--pill-w', w + 'px');
}

function _setNavClasses(path) {
    const pill = document.querySelector('.nav-pill');
    if (!pill) return;
    const activePath = _navActivePath(path);
    pill.querySelectorAll('.nav-link').forEach(link => {
        const href = link.getAttribute('href');
        const isActive = href === activePath;
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
}

function startFullNav(urlish) {
    const href = String(urlish);
    const dir = _navDirection(window.location.href, href);
    if (dir) sessionStorage.setItem('nav-dir', dir);
    else sessionStorage.removeItem('nav-dir');

    try { sessionStorage.setItem('pill-from-path', _navActivePath(location.pathname)); } catch (e) {}

    const main = _getMain();
    if (main) {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
        main.style.opacity = '0';
    }
    setTimeout(() => { window.location.href = href; }, _cssDur('--dur-micro'));
}

// Programmatic SPA nav — used by row clicks on tables that can't host an <a>.
// Builds a temporary hx-get anchor, processes it, clicks it, then cleans up.
// This runs the full htmx flow (confirm → exit anim → issueRequest → afterSwap)
// so entrance animations, glass prewarm, and preload cache all behave identically
// to clicking a real nav/game link.
function startSpaNav(urlish) {
    const href = String(urlish);
    if (!window.htmx) { startFullNav(href); return; }
    const a = document.createElement('a');
    a.setAttribute('hx-get', href);
    a.setAttribute('hx-target', '#main');
    a.setAttribute('hx-swap', 'innerHTML show:window:top');
    a.setAttribute('hx-push-url', 'true');
    a.setAttribute('hx-headers', '{"X-SPA-Nav":"true"}');
    a.style.display = 'none';
    document.body.appendChild(a);
    try { htmx.process(a); } catch (_) {}
    a.click();
    // Must outlive htmx's confirm→exit-delay→issueRequest chain. Directional
    // nav waits --dur-fast (~250ms) before firing the request; removing the
    // source element before then aborts the flow mid-exit (frozen page).
    setTimeout(() => { try { a.remove(); } catch (_) {} }, 2000);
}
window.startSpaNav = startSpaNav;

function _bindHistoryNavSync() {
    if (window.__navHistorySyncBound) return;
    window.__navHistorySyncBound = true;

    // Intercept pushState/replaceState to update .active classes only — the pill was
    // already positioned by the htmx:confirm handler, re-sliding would restart the transition.
    const wrapHistoryMethod = (methodName) => {
        const original = history[methodName];
        history[methodName] = function(...args) {
            const result = original.apply(this, args);
            _setNavClasses(window.location.href);
            return result;
        };
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    // popstate (back/forward): full update with animation — no confirm handler fires.
    window.addEventListener('popstate', () => _updateNavActive(window.location.href, true));
}

// ─── Same-page navigation (e.g. Library → Library) ───────────────────────────
// Fades out, resets library state, then fades back in — no actual htmx request.
function _handleSamePageNav(gen) {
    const main = _getMain();
    if (main) {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
        main.style.opacity = '0';
    }
    _pendingSpaNavTimer = setTimeout(() => {
        _pendingSpaNavTimer = null;
        if (gen !== _spaNavGen) return;
        if (main) { main.style.opacity = ''; main.style.transition = ''; }
        _gridDirty = true;
        _tableDirty = true;
        if (window.resumeGlass) window.resumeGlass();
        setLibraryView(_currentLibView);
    }, _cssDur('--dur-micro'));
}

// ─── SPA exit animation ───────────────────────────────────────────────────────
// Directional nav: slide main off-screen via CSS class (per-child translate+opacity).
// Non-directional nav (game detail): zoom out + fade <main> as a whole — scale
// mirrors the entrance --scale-rise so the page "retracts" before the game page's
// own entrance animation lands. Applied inline to avoid per-child selectors
// interfering with the htmx confirm → issueRequest handshake.
function _applySpaExitAnimation(main, dir) {
    if (!main) return;
    if (dir) {
        main.classList.add(dir === 'forward' ? TAB_EXIT_FWD : TAB_EXIT_BACK);
    } else {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-out)';
        main.style.opacity = '0';
    }
}

// ─── htmx:confirm — intercept SPA nav clicks ─────────────────────────────────
document.body.addEventListener('htmx:confirm', (evt) => {
    const el = evt.detail.elt;
    // Match any SPA link: must target #main. Covers nav bar, game cards, and any
    // future SPA-routed element. Non-SPA hx-get calls (filters, partial swaps)
    // target other elements and are ignored here.
    if (!el.hasAttribute('hx-get') || el.getAttribute('hx-target') !== '#main') return;

    evt.preventDefault();

    if (_pendingSpaNavTimer) { clearTimeout(_pendingSpaNavTimer); _pendingSpaNavTimer = null; }
    _spaNavGen++;

    const main = _getMain();
    const toPath = el.getAttribute('hx-get');

    if (el.closest('.nav-pill')) _positionPill(el, true);

    // Same-page nav (e.g. clicking Library while already on Library).
    if (toPath === location.pathname) {
        if (document.getElementById('library-table-wrap')) _handleSamePageNav(_spaNavGen);
        return;
    }

    // Game detail is a deep-link, not a sibling tab — fade in/out instead of
    // the horizontal tab slide. Leaving a game page via nav still uses slide.
    const isToGameDetail = toPath && toPath.startsWith('/game/');
    const dir = isToGameDetail ? null : _navDirection(location.pathname, toPath);
    if (dir) sessionStorage.setItem('nav-dir', dir);
    else sessionStorage.removeItem('nav-dir');

    // Pause glass before the exit animation starts — removes GPU glass work from
    // the INP presentation-delay critical path on nav interactions.
    if (window.pauseGlass) window.pauseGlass();
    _applySpaExitAnimation(main, dir);
    // Resume in the next rAF so glass still tracks panels during the slide/fade out.
    requestAnimationFrame(() => { if (window.resumeGlass) window.resumeGlass(); });

    _spaNavInFlight = true;
    // Directional nav (tab slide) needs full --dur-fast to fully exit before swap;
    // non-directional (game fade) uses --dur-micro to stay under htmx's ~200ms
    // issueRequest invalidation window.
    const exitDelay = dir ? _cssDur('--dur-fast') : _cssDur('--dur-micro');
    _pendingSpaNavTimer = setTimeout(() => {
        _pendingSpaNavTimer = null;
        // Scroll reset deferred to end of exit animation — so the slide/fade plays
        // from the user's current scroll position instead of teleporting to top first.
        // Jump lands under cover of the imminent innerHTML swap, so no visible flash.
        window.scrollTo(0, 0);
        if (window.lenis) window.lenis.scrollTo(0, { immediate: true });
        if (window.pauseGlass) window.pauseGlass();
        evt.detail.issueRequest();
    }, exitDelay);
});

// ─── SPA post-swap: re-initialize page modules after htmx swaps <main> ───────
const PAGE_BODY_CLASSES = ['page-game-detail', 'auto-fetch-friends'];

// Fallback used by historyRestore when the cached HTML predates #spa-meta (e.g.
// the page was first reached via full-page SSR, not an htmx swap).
function _bodyClassesForPath(path) {
    const classes = [];
    if (path.startsWith('/game/')) classes.push('page-game-detail');
    if (path === '/friends') classes.push('auto-fetch-friends');
    return classes;
}

function _applyBodyClasses(classes) {
    PAGE_BODY_CLASSES.forEach(cls => document.body.classList.remove(cls));
    classes.forEach(cls => document.body.classList.add(cls));
}

function _processSPAMeta(main) {
    const meta = main.querySelector('#spa-meta');
    if (!meta) return;
    document.title = meta.dataset.title || 'Xbox Profile';
    _applyBodyClasses((meta.dataset.bodyClass || '').split(' ').filter(Boolean));
    updateRateBadge(meta.dataset.rateUsed || '0');
    // Update classes + reposition pill. For nav-pill clicks the pill was already
    // pre-slid in htmx:confirm (no-op here). For programmatic nav via startSpaNav
    // (heatmap, calendar, cmd-palette, tracking) the click source is outside
    // .nav-pill, so this is the only chance to move the pill to the new tab.
    _updateNavActive(meta.dataset.pagePath, true);
    meta.remove();
}

function _processSPAOverlay(main) {
    const overlayContainer = document.getElementById('spa-overlay-container');
    if (!overlayContainer) return;
    overlayContainer.innerHTML = '';
    const overlayContent = main.querySelector('#lightbox');
    if (overlayContent) overlayContainer.appendChild(overlayContent);
}

function _executeSPAScripts(main) {
    const scriptTpl = main.querySelector('#spa-scripts');
    if (!scriptTpl) return;
    const scripts = scriptTpl.content
        ? scriptTpl.content.querySelectorAll('script')
        : scriptTpl.querySelectorAll('script');
    scripts.forEach(oldScript => {
        const s = document.createElement('script');
        const cleanup = () => s.remove();
        if (oldScript.src) {
            s.src = oldScript.src;
            if (oldScript.defer) s.defer = true;
            s.onload = cleanup;
            s.onerror = cleanup;
        } else {
            s.textContent = oldScript.textContent;
        }
        document.body.appendChild(s);
        if (!oldScript.src) cleanup(); // inline scripts execute synchronously
    });
    scriptTpl.remove();
}

function _updateNavActive(path, animate) {
    _setNavClasses(path);
    const active = document.querySelector('.nav-pill .nav-link.active');
    if (active) _positionPill(active, animate);
}

// Clear all exit-animation state left behind by _applySpaExitAnimation. Called
// from both afterSwap (forward nav) and htmx:historyRestore (back/forward nav).
function _clearExitState(main) {
    if (!main) return;
    main.classList.remove(...ALL_EXIT_CLASSES);
    main.style.opacity = '';
    main.style.transition = '';
}

// Run the full re-init pipeline on a freshly-swapped <main>. Shared by afterSwap
// and historyRestore so cached back-nav content gets glass, entrance, reveal, and
// idle-deferred modules just like a forward nav does.
function _reinitMain(main) {
    _clearExitState(main);

    _gridDirty = true;
    _tableDirty = false;

    window.scrollTo(0, 0);
    if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

    main.querySelectorAll('.animate-in').forEach(el => el.classList.remove('animate-in'));
    _lightboxDirty = true;

    // Re-initialize page modules in priority order:
    //   This frame: glass resume + prewarm, then entrance direction + scroll animations
    //   Next rAF:   reveal highlight + blurhash + ambient glow
    //   Idle:       non-visual-critical modules
    //
    // Glass must prewarm BEFORE initPageEntrance so the GPU panel list is populated
    // in the same frame that the tab-switch class triggers the CSS entrance. Deferring
    // prewarm to the next rAF left glass 1 frame behind CSS on tab switches.
    if (window.resumeGlass) window.resumeGlass();
    if (window.prewarmGlassPanels) window.prewarmGlassPanels();

    initPageEntrance();
    initScrollAnimations(main, true);
    initCaptureGroupAnimations(main);

    const gen = _spaNavGen;
    requestAnimationFrame(() => {
        if (gen !== _spaNavGen) return;
        // Scope to new content only — nav elements are already initialized from DOMContentLoaded
        initRevealHighlight(main);
        fireCompletionConfetti();

        // Run immediately in this rAF — lightweight, starts as cards become visible.
        animateCountUp();
        initHeatmapTooltip();
        initClickableRows();
        // Blurhash: O(1) dominant-color fast path per image + async Worker dispatch.
        // Safe to call here — nothing blocks; full decode happens off-thread.
        initBlurhash(main);
        // Ambient glow: O(1) per card via blurhash DC component (no canvas, no image decode).
        initAmbientGlow(main);
        // Pause infinite decorative animations when off-screen (idempotent, scoped).
        initOffscreenAnimationPause(main);

        // Delay truly CPU-heavy idle tasks until AFTER the entrance cascade completes.
        // Worst case: ≤8 above-fold leaders × 80ms/step = ~640ms. Without this guard,
        // requestIdleCallback fires between the first few steps (browser idle between
        // 80ms gaps) and heavy tasks (ambient glow, scroll reveal) cause a visible
        // mid-cascade pause — "1-3 tiles appear, freeze, then the rest animate".
        const CASCADE_WAIT = 680;
        const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
        setTimeout(() => idle(() => {
            if (gen !== _spaNavGen) return;
            initRowScrollReveal();
            initEdgeScale();
            initTimelineCalendar();
            initTimelineContinuationFix();
            restoreLibraryView();
            if (typeof prewarmCapturesOffView === 'function') prewarmCapturesOffView();
            if (typeof updateExportLinks === 'function') updateExportLinks();
            if (document.body.classList.contains('auto-fetch-friends')) fetchFriends();
        }), CASCADE_WAIT);
    });
}

document.body.addEventListener('htmx:afterSwap', (evt) => {
    if (evt.detail.target.id !== 'main') return;

    const main = evt.detail.target;
    _spaNavInFlight = false;

    _processSPAMeta(main);
    _processSPAOverlay(main);
    _executeSPAScripts(main);

    _reinitMain(main);
});

// Back/forward nav: htmx swaps cached HTML into the history target and fires
// historyRestore (NOT afterSwap). Without this handler, the exit classes from
// the forward nav stay on <main>, body classes from the previous page remain,
// and no entrance animation fires — children stay invisible and the dark aurora
// shows through = "black flash on back". Mirror the afterSwap pipeline here.
document.body.addEventListener('htmx:historyRestore', () => {
    _spaNavGen++;
    _spaNavInFlight = false;
    const main = _getMain();
    if (!main) return;
    // Prefer #spa-meta if cached (SPA-swapped entry); otherwise derive body classes
    // from URL so pages first reached via SSR (no #spa-meta in cache) still look right.
    const hasMeta = !!main.querySelector('#spa-meta');
    if (hasMeta) {
        _processSPAMeta(main);
    } else {
        _applyBodyClasses(_bodyClassesForPath(location.pathname));
        _setNavClasses(location.pathname);
    }
    _processSPAOverlay(main);
    _executeSPAScripts(main);
    sessionStorage.removeItem('nav-dir'); // back-nav shouldn't replay a tab-slide entrance
    _reinitMain(main);
});

document.body.addEventListener('htmx:afterSettle', (evt) => {
    if (evt.detail.target.id !== 'main') return;
    _setNavClasses(location.pathname);
});

// ─── SPA navigation error recovery ───────────────────────────────────────────
// If the htmx request for #main fails, htmx:afterSwap never fires so _spaNavInFlight
// stays true — the pill ResizeObserver silently ignores all resize events until the
// next successful nav. Main is also left in its exit state (opacity 0 or tab-exit
// class). Restore both here so the page remains usable after network errors.
function _recoverSpaNav(evt) {
    if (evt.detail.target?.id !== 'main') return;
    _spaNavInFlight = false;
    _clearExitState(_getMain());
}

document.body.addEventListener('htmx:responseError', _recoverSpaNav);
document.body.addEventListener('htmx:sendError', _recoverSpaNav);

// ─── Non-SPA link exit (game detail, external pages) ─────────────────────────
document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') ||
        link.getAttribute('href').startsWith('#') ||
        link.getAttribute('href').startsWith('javascript') ||
        link.hasAttribute('hx-get') || link.hasAttribute('hx-post')) return;
    const href = link.getAttribute('href');
    if (!href.startsWith('/')) return;
    e.preventDefault();
    startFullNav(href);
});

// ─── Nav pill track ───────────────────────────────────────────────────────────
// Single ResizeObserver handles font swaps and window resizes. If the user arrived
// via startFullNav (which saves 'pill-from-path'), the inline first-paint script
// parked the track at the FROM link — we schedule a slide to the active link so
// the pill appears to travel across tabs visually.
let _pillInitialSlidePending = false;

function initNavPillTrack() {
    const pill = document.querySelector('.nav-pill');
    if (!pill) return;
    _bindHistoryNavSync();

    const fromPath = sessionStorage.getItem('pill-from-path');
    sessionStorage.removeItem('pill-from-path');
    const currentNavPath = _navActivePath(location.pathname);
    const shouldSlideIn = fromPath && _navActivePath(fromPath) !== currentNavPath;

    if (shouldSlideIn) {
        _pillInitialSlidePending = true;
        // Double rAF: let the browser commit the FROM position from the inline
        // script before flipping to TO and starting the transition.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const active = pill.querySelector('.nav-link.active');
            if (active) _positionPill(active, true);
            setTimeout(() => { _pillInitialSlidePending = false; }, _cssDur('--dur-pill') + 32);
        }));
    }

    new ResizeObserver(() => {
        if (_spaNavInFlight || _pillInitialSlidePending) return;
        const active = pill.querySelector('.nav-link.active');
        if (active) _positionPill(active, false);
    }).observe(pill);
}

// ─── Scroll-aware nav ─────────────────────────────────────────────────────────
let _scrollNavInit = false;

function initScrollNav() {
    if (_scrollNavInit) return;
    const nav = document.getElementById('xbox-nav');
    if (!nav) return;
    _scrollNavInit = true;

    const THRESHOLD = 20;
    let scrolled = false;

    function check(scrollY) {
        const isScrolled = scrollY > THRESHOLD;
        if (isScrolled !== scrolled) {
            scrolled = isScrolled;
            nav.classList.toggle('scrolled', scrolled);
        }
    }

    // Defer initial scrollY read off the critical path; reading window.scrollY
    // synchronously at init time forces layout if styles are dirty.
    requestAnimationFrame(() => check(window.scrollY));

    // Scroll-idle gate for always-visible nav animations (nav-liquid-sweep, nav-glow-pulse).
    // Adds is-scrolling on <html> while scrolling; removes after 200ms idle. CSS pauses
    // the persistent loops while present — the user's eye is on scrolling content, not the nav.
    const html = document.documentElement;
    let scrollIdleTimer = 0;
    const SCROLL_IDLE_MS = 200;
    function bumpScrollIdle() {
        if (!html.classList.contains('is-scrolling')) html.classList.add('is-scrolling');
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => {
            html.classList.remove('is-scrolling');
            scrollIdleTimer = 0;
        }, SCROLL_IDLE_MS);
    }

    if (window.lenis) {
        window.lenis.on('scroll', ({ scroll }) => { check(scroll); bumpScrollIdle(); });
    } else {
        let scrollRaf = false;
        window.addEventListener('scroll', () => {
            bumpScrollIdle();
            if (!scrollRaf) {
                scrollRaf = true;
                requestAnimationFrame(() => { scrollRaf = false; check(window.scrollY); });
            }
        }, { passive: true });
    }
}
