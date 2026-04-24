// === blurhash.js ===
// Off-main-thread blurhash decoder.
//
// Two-phase strategy:
//   1. Synchronous (O(1)): extract DC component → set background-color immediately.
//      No canvas, no loops — just 4 base83 lookups.
//   2. Worker: full DCT decode runs in a dedicated thread; main thread only does
//      a cheap putImageData when the result arrives.
//
// Images are observed via IntersectionObserver (rootMargin 400px) so off-screen
// items in long lists never get decoded until they're near the viewport.
//
// globals: initBlurhash

// ── Worker source (blob-embedded — no separate served file needed) ────────────
const _BH_WORKER_SRC = /* js */`
'use strict';
const lut = new Uint8Array(128);
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-./:;=?@[]^_{|}~'
    .split('').forEach((c, i) => { lut[c.charCodeAt(0)] = i; });

function d83(s, a, b) {
    let v = 0;
    for (let i = a; i < b; i++) { const c = s.charCodeAt(i); v = v * 83 + (c < 128 ? lut[c] : 0); }
    return v;
}
function toLinear(v) { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function toSRGB(v)   { return Math.max(0, Math.min(255, Math.round(v <= 0.0031308 ? v * 12.92 * 255 : (1.055 * Math.pow(v, 1/2.4) - 0.055) * 255))); }

function decodeDC(val) {
    return [toLinear(val >> 16), toLinear((val >> 8) & 255), toLinear(val & 255)];
}
function decodeAC(val, maxAC) {
    const qR = Math.floor(val / 361), qG = Math.floor(val / 19) % 19, qB = val % 19;
    const s = (q) => Math.sign(q - 9) * Math.pow(Math.abs(q - 9) / 9, 2) * maxAC;
    return [s(qR), s(qG), s(qB)];
}

function decode(hash, w, h) {
    const sf = d83(hash, 0, 1);
    const nX = (sf % 9) + 1, nY = Math.floor(sf / 9) + 1;
    const maxAC = (d83(hash, 1, 2) + 1) / 166;
    const colors = [decodeDC(d83(hash, 2, 6))];
    for (let i = 1; i < nX * nY; i++) colors.push(decodeAC(d83(hash, 4 + i*2, 6 + i*2), maxAC));
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0;
            for (let j = 0; j < nY; j++) {
                for (let i = 0; i < nX; i++) {
                    const basis = Math.cos(Math.PI * x * i / w) * Math.cos(Math.PI * y * j / h);
                    const c = colors[j * nX + i];
                    r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
                }
            }
            const idx = (y * w + x) * 4;
            px[idx] = toSRGB(r); px[idx+1] = toSRGB(g); px[idx+2] = toSRGB(b); px[idx+3] = 255;
        }
    }
    return px;
}

self.onmessage = ({ data: { id, hash } }) => {
    try {
        const px = decode(hash, 16, 16);
        self.postMessage({ id, buf: px.buffer }, [px.buffer]);
    } catch(e) {
        self.postMessage({ id, err: true });
    }
};
`;

// ── Worker singleton ──────────────────────────────────────────────────────────
let _bhWorker = null;
const _bhPending = new Map(); // id → img element

function _getBhWorker() {
    if (_bhWorker) return _bhWorker;
    try {
        const blob = new Blob([_BH_WORKER_SRC], { type: 'application/javascript' });
        const url  = URL.createObjectURL(blob);
        _bhWorker  = new Worker(url);
        URL.revokeObjectURL(url);
        _bhWorker.onmessage = ({ data: { id, buf, err } }) => {
            const img = _bhPending.get(id);
            _bhPending.delete(id);
            if (!img || err) return;
            // Image loaded before the worker finished — nothing to show.
            if (img.complete && img.naturalWidth > 0) return;
            // Cheap main-thread work: create canvas and blit pixels.
            const canvas = document.createElement('canvas');
            canvas.width = 16; canvas.height = 16;
            const ctx = canvas.getContext('2d');
            const id2d = ctx.createImageData(16, 16);
            id2d.data.set(new Uint8ClampedArray(buf));
            ctx.putImageData(id2d, 0, 0);
            img.style.backgroundImage = `url(${canvas.toDataURL()})`;
            img.style.backgroundSize  = 'cover';
        };
        _bhWorker.onerror = () => { _bhWorker = null; }; // reset on error so next call retries
    } catch(e) {
        // Worker creation failed (e.g. strict CSP blocking blob URLs) — degrade silently.
        _bhWorker = { postMessage: () => {} };
    }
    return _bhWorker;
}

// ── DC-component fast path (main thread, O(1)) ────────────────────────────────
// Extracts the dominant color from the blurhash header (bytes 2–5).
// The DC value is stored as a 24-bit sRGB integer — no gamma math needed.
const _bhLut = new Uint8Array(128);
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-./:;=?@[]^_{|}~'
    .split('').forEach((c, i) => { _bhLut[c.charCodeAt(0)] = i; });

function _bhDecode83(s, a, b) {
    let v = 0;
    for (let i = a; i < b; i++) { const c = s.charCodeAt(i); v = v * 83 + (c < 128 ? _bhLut[c] : 0); }
    return v;
}

function _bhDominantColor(hash) {
    const val = _bhDecode83(hash, 2, 6);
    return `rgb(${(val >> 16) & 255},${(val >> 8) & 255},${val & 255})`;
}

// ── IntersectionObserver — triggers full decode when image is near viewport ───
let _bhObserver = null;
let _bhIdCounter = 0;

function _getBhObserver() {
    if (_bhObserver) return _bhObserver;
    _bhObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            _bhObserver.unobserve(img);
            if (img.complete && img.naturalWidth > 0) continue; // already loaded
            const hash = img.dataset.blurhash;
            if (!hash) continue;
            const id = ++_bhIdCounter;
            _bhPending.set(id, img);
            _getBhWorker().postMessage({ id, hash });
        }
    }, { rootMargin: '400px' }); // decode ahead of scroll so placeholder is ready
    return _bhObserver;
}

// ── Public API ────────────────────────────────────────────────────────────────
function initBlurhash(scope) {
    const imgs = (scope || document).querySelectorAll('img[data-blurhash]');
    if (!imgs.length) return;
    const obs = _getBhObserver();
    imgs.forEach(img => {
        if (img.dataset.bhApplied) return;
        const hash = img.dataset.blurhash;
        if (!hash || hash.length < 6) return;
        img.dataset.bhApplied = '1';

        // Phase 1: dominant color in the same frame — no stall, no canvas.
        if (!(img.complete && img.naturalWidth > 0)) {
            img.style.backgroundColor = _bhDominantColor(hash);
        }

        // Clear placeholder styles once the real image arrives.
        // Single cssText write collapses 3 inline-style mutations into 1 style invalidation.
        // Safe because blurhash.js is the only writer of inline styles on these images.
        img.addEventListener('load', () => {
            img.style.cssText = '';
        }, { once: true });

        // Phase 2: full blur — worker does the math when image is near viewport.
        obs.observe(img);
    });
}
