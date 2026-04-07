// === nav.js ===
// SPA navigation: htmx:confirm exit animation, htmx:afterSwap re-init,
// non-SPA link exit, nav pill slide, scroll-aware nav, page entrance direction.
// globals: initNavPillTrack, initScrollNav
// sets: _tabEnterClass, _lastTabEnterClass (consumed by animations.js)

const NAV_ORDER = { '/': 0, '/library': 1, '/achievements': 2, '/timeline': 3, '/captures': 4, '/friends': 5 };

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
    const fromIdx = NAV_ORDER[fromPath] ?? -1;
    const toIdx = NAV_ORDER[toPath] ?? -1;
    if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
        return toIdx > fromIdx ? 'forward' : 'back';
    }
    return null;
}

let _mainEl = null;
function _getMain() { return _mainEl || (_mainEl = document.querySelector('main')); }

let _pendingSpaNavTimer = null;
let _spaNavGen = 0;

function _slidePillTo(el) {
    const pill = document.querySelector('.nav-pill');
    const track = document.getElementById('nav-pill-track');
    if (!pill || !track || !el) return;

    const pillRect = pill.getBoundingClientRect();
    const linkRect = el.getBoundingClientRect();
    const trackLeft = linkRect.left - pillRect.left;

    track.style.transition = 'left var(--dur-pill) var(--ease-pill), width var(--dur-pill) var(--ease-pill)';
    track.style.left = trackLeft + 'px';
    track.style.width = linkRect.width + 'px';

    const glow = track.querySelector('.nav-pill-glow');
    const firstLink = pill.querySelector('.nav-link');
    if (glow && firstLink) {
        const contentStart = firstLink.getBoundingClientRect().left - pillRect.left;
        glow.style.transition = 'left var(--dur-pill) var(--ease-pill)';
        glow.style.left = (contentStart - trackLeft - track.clientLeft) + 'px';
    }
}

document.body.addEventListener('htmx:confirm', (evt) => {
    const el = evt.detail.elt;
    if (!el.hasAttribute('hx-get') || !el.closest('.nav-inner')) return;

    evt.preventDefault();

    if (_pendingSpaNavTimer) {
        clearTimeout(_pendingSpaNavTimer);
        _pendingSpaNavTimer = null;
    }
    _spaNavGen++;

    const main = _getMain();

    if (el.closest('.nav-pill')) _slidePillTo(el);

    const toPath = el.getAttribute('hx-get');

    // Same-page nav (e.g. clicking Library while already on Library)
    if (toPath === location.pathname) {
        if (document.getElementById('library-table-wrap')) {
            if (main) {
                main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
                main.style.opacity = '0';
            }
            const gen = _spaNavGen;
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
        return;
    }

    const dir = _navDirection(location.pathname, toPath);
    if (dir) sessionStorage.setItem('nav-dir', dir);
    if (main && dir) {
        main.classList.add(dir === 'forward' ? 'tab-exit-forward' : 'tab-exit-back');
    } else if (main) {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
        main.style.opacity = '0';
    }

    window.scrollTo(0, 0);
    if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

    if (window.pauseGlass) window.pauseGlass();

    const exitDelay = dir ? _cssDur('--dur-fast') : _cssDur('--dur-micro');
    _pendingSpaNavTimer = setTimeout(() => {
        _pendingSpaNavTimer = null;
        evt.detail.issueRequest();
    }, exitDelay);
});

// --- SPA post-swap: re-initialize page modules after htmx swaps <main> ---
const PAGE_BODY_CLASSES = ['page-game-detail', 'auto-fetch-friends'];

function _processSPAMeta(main) {
    const meta = main.querySelector('#spa-meta');
    if (!meta) return;
    document.title = meta.dataset.title || 'Xbox Profile';
    PAGE_BODY_CLASSES.forEach(cls => document.body.classList.remove(cls));
    (meta.dataset.bodyClass || '').split(' ').filter(Boolean).forEach(cls => document.body.classList.add(cls));
    updateRateBadge(meta.dataset.rateUsed || '0');
    _updateNavActive(meta.dataset.pagePath);
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
        if (oldScript.src) {
            s.src = oldScript.src;
            if (oldScript.defer) s.defer = true;
        } else {
            s.textContent = oldScript.textContent;
        }
        document.body.appendChild(s);
        setTimeout(() => s.remove(), 100);
    });
    scriptTpl.remove();
}

function _updateNavActive(path) {
    const pill = document.querySelector('.nav-pill');
    if (!pill) return;
    pill.querySelectorAll('.nav-link').forEach(link => {
        const href = link.getAttribute('href');
        const isActive = href === path || (href === '/library' && path.startsWith('/game/'));
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
    const active = pill.querySelector('.nav-link.active');
    if (active) _slidePillTo(active);
}

document.body.addEventListener('htmx:afterSwap', (evt) => {
    // Only process SPA page swaps, not library table / timeline partial swaps
    if (evt.detail.target.id !== 'main') return;

    const main = evt.detail.target;

    _processSPAMeta(main);
    _processSPAOverlay(main);
    _executeSPAScripts(main);

    main.classList.remove('tab-exit-forward', 'tab-exit-back');
    main.style.opacity = '';
    main.style.transition = '';

    // Reset library dirty flags — every SPA nav to the library page needs fresh content.
    _gridDirty = true;
    _tableDirty = false;

    window.scrollTo(0, 0);
    if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

    main.querySelectorAll('.animate-in').forEach(el => el.classList.remove('animate-in'));
    _lightboxDirty = true;

    // Re-initialize page modules — staggered across frames to avoid aurora jank:
    //   This frame: entrance direction + scroll animations (visual-critical)
    //   Next rAF:   glass re-cache + reveal highlight + blurhash
    //   Idle:       everything else (non-visual-critical)
    initPageEntrance();
    initScrollAnimations(main, true);
    initCaptureGroupAnimations(main);

    const gen = _spaNavGen;
    requestAnimationFrame(() => {
        if (gen !== _spaNavGen) return;
        if (window.resumeGlass) window.resumeGlass();
        initRevealHighlight();
        initBlurhash(main);
        fireCompletionConfetti();

        const _idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
        _idle(() => {
            initAmbientGlow();
            initClickableRows();
            initRowScrollReveal();
            initEdgeScale();
            animateCountUp();
            initHeatmapTooltip();
            initTimelineCalendar();
            initTimelineContinuationFix();
            restoreLibraryView();
            if (typeof updateExportLinks === 'function') updateExportLinks();
            if (document.body.classList.contains('auto-fetch-friends')) fetchFriends();
        });
    });
});

// --- Non-SPA link exit animation (game detail, etc.) ---
document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') ||
        link.getAttribute('href').startsWith('#') ||
        link.getAttribute('href').startsWith('javascript') ||
        link.hasAttribute('hx-get') || link.hasAttribute('hx-post')) return;
    const href = link.getAttribute('href');
    if (!href.startsWith('/')) return;
    e.preventDefault();

    const destPath = href.split('?')[0];
    const dir = _navDirection(location.pathname, destPath);
    if (dir) sessionStorage.setItem('nav-dir', dir);
    const main = _getMain();
    if (main) {
        main.style.transition = 'opacity var(--dur-micro) var(--ease-exit)';
        main.style.opacity = '0';
    }
    setTimeout(() => { window.location.href = href; }, _cssDur('--dur-micro'));
});

// --- Nav pill track: position the sliding indicator behind the active link ---
function initNavPillTrack() {
    const pill = document.querySelector('.nav-pill');
    const track = document.getElementById('nav-pill-track');
    const active = pill?.querySelector('.nav-link.active');
    if (!pill || !track || !active) return;

    function position() {
        const pillRect   = pill.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const glow       = track.querySelector('.nav-pill-glow');
        const firstLink  = pill.querySelector('.nav-link');
        const firstLeft  = firstLink ? firstLink.getBoundingClientRect().left : pillRect.left;
        const clientLeft = glow ? track.clientLeft : 0;

        const trackLeft = activeRect.left - pillRect.left;
        track.style.left  = trackLeft + 'px';
        track.style.width = activeRect.width + 'px';
        if (glow) glow.style.left = (firstLeft - pillRect.left - trackLeft - clientLeft) + 'px';
    }

    position();
    if (document.fonts?.ready) {
        document.fonts.ready.then(position).catch(() => {});
    }
}

// --- Scroll-aware nav: add/remove .scrolled class ---
let _scrollNavInit = false;
function initScrollNav() {
    if (_scrollNavInit) return;
    const nav = document.getElementById('xbox-nav');
    if (!nav) return;
    _scrollNavInit = true;

    let scrolled = false;
    const threshold = 20;

    function check(scrollY) {
        const isScrolled = scrollY > threshold;
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
