// === utils.js ===
// Shared utilities: htmx guards, perf guards, CSS duration helper, common helpers.

// Add SPA header to all htmx requests targeting #main (including history restores)
document.body.addEventListener('htmx:configRequest', (evt) => {
    if (evt.detail.target && evt.detail.target.id === 'main') {
        evt.detail.headers['X-SPA-Nav'] = 'true';
    }
});

// --- Guard: detect full-page response swapped into #main (nesting bug) ---
// If the server returns a full HTML document instead of a partial (e.g. due to
// missing htmx headers after a redirect, SW cache mismatch, or race condition),
// extract just the <main> content instead of nesting the entire document.
document.body.addEventListener('htmx:beforeSwap', (evt) => {
    if (evt.detail.target.id !== 'main') return;
    const text = evt.detail.xhr?.responseText;
    if (text && text.trimStart().substring(0, 50).includes('<!DOCTYPE')) {
        // Response is a full HTML page — extract <main> content and swap that instead
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const mainContent = doc.querySelector('#main');
        if (mainContent) {
            evt.detail.serverResponse = mainContent.innerHTML;
        }
        // If no #main found, let it swap as-is (shouldn't happen but safer than reload)
    }
});

// --- Shared perf guards for reveal + glass update batching ---
const _revealFinePointer = window.matchMedia('(pointer: fine)').matches
    || window.matchMedia('(any-pointer: fine)').matches;
let _revealScrollWatchInit = false;
let _revealScrollSuppressUntil = 0;
let _glassPanelsUpdateQueued = false;

function _initRevealScrollWatch() {
    if (_revealScrollWatchInit) return;
    _revealScrollWatchInit = true;
    window.addEventListener('scroll', () => {
        _revealScrollSuppressUntil = performance.now() + 90;
    }, { passive: true });
}

function _revealCanTrack() {
    return _revealFinePointer && performance.now() >= _revealScrollSuppressUntil;
}

function requestGlassPanelsUpdate() {
    if (typeof window.updateGlassPanels !== 'function') return;
    if (_glassPanelsUpdateQueued) return;
    _glassPanelsUpdateQueued = true;
    requestAnimationFrame(() => {
        _glassPanelsUpdateQueued = false;
        window.updateGlassPanels();
    });
}

// --- CSS duration helper ---
// Read a CSS duration token (e.g. '--dur-fast') as milliseconds — cached.
// Used by animations, nav, and captures.
const _cssDurCache = {};
function _cssDur(prop) {
    if (prop in _cssDurCache) return _cssDurCache[prop];
    const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    let v = parseFloat(raw) || 0;
    if (raw.endsWith('s') && !raw.endsWith('ms')) v *= 1000;
    _cssDurCache[prop] = v;
    return v;
}

// Prevent browser from restoring scroll position on reload — always start at top.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.scrollTo(0, 0);
if (window.lenis) window.lenis.scrollTo(0, { immediate: true });

// --- Global image error handler (replaces inline onerror attributes) ---
document.addEventListener('error', (e) => {
    if (e.target.tagName !== 'IMG') return;
    const img = e.target;
    // Skip lightbox img — it starts with src="" which triggers a spurious error
    if (img.id === 'lightbox-img') return;
    // Grid cards: add fallback class to parent
    if (img.closest('.lib-grid-art')) {
        img.parentElement.classList.add('no-img');
    }
    img.style.display = 'none';
}, true);

// --- Soft page refresh (full reload after sync operations) ---
function softRefresh(delayMs = 0) {
    setTimeout(() => location.reload(), delayMs);
}

// --- Toggle slider helper ---
// Used by library view toggle and captures view toggle.
function updateToggleSlider(container) {
    if (!container) return;
    const active = container.querySelector('.view-btn.active');
    if (!active) return;
    // Batch all reads before any writes to avoid interleaved forced reflows.
    const x = active.offsetLeft, w = active.offsetWidth, h = active.offsetHeight, top = active.offsetTop;
    container.style.setProperty('--slider-x', x + 'px');
    container.style.setProperty('--slider-w', w + 'px');
    container.style.setProperty('--slider-h', h + 'px');
    container.style.setProperty('--slider-top', top + 'px');
    if (!container.classList.contains('slider-ready')) {
        requestAnimationFrame(() => container.classList.add('slider-ready'));
    }
}
