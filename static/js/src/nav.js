// === nav.js ===
// SPA navigation: htmx:confirm exit animation, htmx:afterSwap re-init,
// non-SPA link exit, nav pill slide, scroll-aware nav, page entrance direction.
// globals: initNavPillTrack, initScrollNav
// sets: _tabEnterClass, _lastTabEnterClass (consumed by animations.js)

const NAV_ORDER = { '/': 0, '/library': 1, '/achievements': 2, '/timeline': 3, '/captures': 4, '/friends': 5 };

const TAB_EXIT_FWD  = 'tab-exit-forward';
const TAB_EXIT_BACK = 'tab-exit-back';

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
    track.classList.toggle('pill-animate', !!animate);
    track.style.setProperty('--pill-x', el.offsetLeft + 'px');
    track.style.setProperty('--pill-w', el.offsetWidth + 'px');
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
// Directional nav: slide main off-screen via CSS class.
// Non-directional nav: simple opacity fade.
function _applySpaExitAnimation(main, dir) {
    if (main && dir) {
        main.classList.add(dir === 'forward' ? TAB_EXIT_FWD : TAB_EXIT_BACK);
    } else if (main) {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
        main.style.opacity = '0';
    }
}

// ─── htmx:confirm — intercept SPA nav clicks ─────────────────────────────────
document.body.addEventListener('htmx:confirm', (evt) => {
    const el = evt.detail.elt;
    if (!el.hasAttribute('hx-get') || !el.closest('.nav-inner')) return;

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

    const dir = _navDirection(location.pathname, toPath);
    if (dir) sessionStorage.setItem('nav-dir', dir);

    _applySpaExitAnimation(main, dir);

    window.scrollTo(0, 0);
    if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

    _spaNavInFlight = true;
    const exitDelay = dir ? _cssDur('--dur-fast') : _cssDur('--dur-micro');
    _pendingSpaNavTimer = setTimeout(() => {
        _pendingSpaNavTimer = null;
        // Pause glass after exit animation completes — the panels need to render
        // during the slide/fade out. Only freeze once content has fully exited.
        if (window.pauseGlass) window.pauseGlass();
        evt.detail.issueRequest();
    }, exitDelay);
});

// ─── SPA post-swap: re-initialize page modules after htmx swaps <main> ───────
const PAGE_BODY_CLASSES = ['page-game-detail', 'auto-fetch-friends'];

function _processSPAMeta(main) {
    const meta = main.querySelector('#spa-meta');
    if (!meta) return;
    document.title = meta.dataset.title || 'Xbox Profile';
    PAGE_BODY_CLASSES.forEach(cls => document.body.classList.remove(cls));
    (meta.dataset.bodyClass || '').split(' ').filter(Boolean).forEach(cls => document.body.classList.add(cls));
    updateRateBadge(meta.dataset.rateUsed || '0');
    _setNavClasses(meta.dataset.pagePath);
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

document.body.addEventListener('htmx:afterSwap', (evt) => {
    if (evt.detail.target.id !== 'main') return;

    const main = evt.detail.target;
    _spaNavInFlight = false;

    _processSPAMeta(main);
    _processSPAOverlay(main);
    _executeSPAScripts(main);

    main.classList.remove(TAB_EXIT_FWD, TAB_EXIT_BACK);
    main.style.opacity = '';
    main.style.transition = '';

    _gridDirty = true;
    _tableDirty = false;

    window.scrollTo(0, 0);
    if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

    main.querySelectorAll('.animate-in').forEach(el => el.classList.remove('animate-in'));
    _lightboxDirty = true;

    // Re-initialize page modules in priority order:
    //   This frame: entrance direction + scroll animations (visual-critical)
    //   Next rAF:   glass re-cache + reveal highlight + blurhash
    //   Idle:       non-visual-critical modules
    initPageEntrance();
    initScrollAnimations(main, true);
    initCaptureGroupAnimations(main);

    const gen = _spaNavGen;
    requestAnimationFrame(() => {
        if (gen !== _spaNavGen) return;
        if (window.resumeGlass) window.resumeGlass();
        // Prewarm immediately: scan new DOM + build panel list so the very first rendered
        // glass frame after resume has correct panels. Without this, there is a 1-frame
        // window where new DOM elements are visible but glass hasn't re-scanned yet.
        if (window.prewarmGlassPanels) window.prewarmGlassPanels();
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
            if (typeof updateExportLinks === 'function') updateExportLinks();
            if (document.body.classList.contains('auto-fetch-friends')) fetchFriends();
        }), CASCADE_WAIT);
    });
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
    const main = _getMain();
    if (main) {
        main.classList.remove(TAB_EXIT_FWD, TAB_EXIT_BACK);
        main.style.opacity = '';
        main.style.transition = '';
    }
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

    check(window.scrollY);

    if (window.lenis) {
        window.lenis.on('scroll', ({ scroll }) => check(scroll));
    } else {
        let scrollRaf = false;
        window.addEventListener('scroll', () => {
            if (!scrollRaf) {
                scrollRaf = true;
                requestAnimationFrame(() => { scrollRaf = false; check(window.scrollY); });
            }
        }, { passive: true });
    }
}
