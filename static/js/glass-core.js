/**
 * Glass renderer shared core — pipeline-agnostic helpers.
 *
 * Loaded before glass-webgpu.js (and the dynamically-loaded glass.js fallback).
 * Exposes window.__glassCore with constants, selectors, the tier-aware theme
 * system, and a few pure helpers shared between the WebGPU and WebGL2 drivers.
 *
 * Drivers destructure into local vars at the top of their IIFE so the rest of
 * their code is unchanged — single source of truth, zero rename churn.
 */
(function (global) {
    'use strict';

    // ====================================================================
    // Algorithm constants — must match the values baked into shader strings.
    // ====================================================================
    var HALF_RES = 4;            // quarter-res aurora + blur
    var BLUR_PASSES = 1;
    var MAX_PANELS = 128;
    var MAX_CACHED = 512;
    var IOR = 3.0;
    var THICKNESS = 50.0;
    var BEZEL = 60.0;
    var SPECULAR = 0.50;
    var SHADOW_MARGIN = 6.0;
    var REVEAL_MULT = 2.5;

    // Backdrop image cache
    var BACKDROP_TEX_SIZE = 512;
    var BACKDROP_PREBLUR_PX = 4;
    var BACKDROP_BRIGHTNESS = 1.0;
    var BACKDROP_SATURATE = 1.0;
    var BACKDROP_MAX_TEXTURES = 16;

    // ====================================================================
    // Panel selectors
    // ====================================================================
    var GLASS_SEL = [
        'article', '.friend-card', '.stat-card',
        '.timeline-event-card', '.ach-grid-card',
        '.ach-card', '.showcase-card', '.near-completion-row',
        '.grid-rows .game-row', '.grid-rows .recent-row', '.lib-grid-card',
        '.captures-game-header',
        '.sidebar-widget',
        '.cmd-panel', '.shortcuts-panel',
        'button.outline', 'button.secondary',
        '[role="button"].outline', '[role="button"].secondary',
        'input[type="search"]', 'select',
        '.tracking-form select', '.tracking-form textarea', '.tracking-form input[type="date"]',
        '.view-toggle', '.view-toggle-captures',
        '.hm-tab', '.hm-year-btn', '.calendar-toggle-btn',
        '.filters-inline button', '.rarity-strip-item',
        '.cal-nav', '.quick-nav-pill',
        '.calendar-dropdown'
    ].join(',');

    // Elements that get the pointer reveal glow (interactive items, not structural containers).
    var REVEAL_SEL = [
        '.friend-card', '.timeline-event-card',
        '.ach-grid-card', '.ach-card', '.showcase-card', '.near-completion-row',
        '.grid-rows .game-row', '.grid-rows .recent-row', '.lib-grid-card',
        '.captures-game-header',
        'button.outline', 'button.secondary',
        '[role="button"].outline', '[role="button"].secondary',
        'input[type="search"]', 'select',
        '.tracking-form select', '.tracking-form textarea', '.tracking-form input[type="date"]',
        '.view-toggle', '.view-toggle-captures',
        '.hm-tab', '.hm-year-btn', '.calendar-toggle-btn',
        '.filters-inline button', '.cal-nav', '.quick-nav-pill'
    ].join(',');

    // ====================================================================
    // Theme-aware tier system
    // Hierarchy: surface (recessive) < nested < chrome (persistent)
    //          < overlay (floating) < button (interactive)
    // ====================================================================
    var TIER_NAME_MAP = {
        'article': 'surface', '.friend-card': 'surface', '.stat-card': 'surface',
        '.timeline-event-card': 'surface', '.ach-grid-card': 'surface', '.ach-card': 'surface',
        '.showcase-card': 'surface', '.near-completion-row': 'surface', '.lib-grid-card': 'surface',
        '.grid-rows .game-row': 'nested', '.grid-rows .recent-row': 'nested',
        '.captures-game-header': 'surface',
        '.sidebar-widget': 'chrome',
        '.cmd-panel': 'overlay', '.shortcuts-panel': 'overlay', '.calendar-dropdown': 'overlay',
        'button.outline': 'button', 'button.secondary': 'button',
        '[role="button"].outline': 'button', '[role="button"].secondary': 'button',
        '.tracking-form select': 'control', '.tracking-form textarea': 'control', '.tracking-form input[type="date"]': 'control',
        'input[type="search"]': 'button', 'select': 'button',
        '.view-toggle': 'button', '.view-toggle-captures': 'button',
        '.hm-tab': 'button', '.hm-year-btn': 'button', '.calendar-toggle-btn': 'button',
        '.filters-inline button': 'button', '.rarity-strip-item': 'button',
        '.cal-nav': 'button', '.quick-nav-pill': 'button'
    };

    var TIER_VALUES = {
        dark: {
            surface: {sat:1.80, bright:0.78, tint:0.04},
            nested:  {sat:2.20, bright:0.88, tint:0.07},
            control: {sat:1.90, bright:0.85, tint:0.05},
            chrome:  {sat:2.00, bright:0.92, tint:0.06},
            overlay: {sat:2.40, bright:0.96, tint:0.08},
            button:  {sat:2.60, bright:1.00, tint:0.07}
        }
    };

    // P3 gamut: cap saturation on sRGB displays to avoid oversaturation
    var SRGB_SAT_CAP = { button: 3.50, overlay: 3.10, chrome: 2.80, control: 2.60, nested: 3.20, surface: 2.40 };

    var _hasP3 = global.matchMedia('(color-gamut: p3)').matches;
    var _reducedTransparency = global.matchMedia('(prefers-reduced-transparency: reduce)').matches;
    var _currentTheme = 'dark';

    function detectTheme() {
        _currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    }

    function getTierValues(tierName) {
        var themeVals = TIER_VALUES[_currentTheme] || TIER_VALUES.dark;
        var v = themeVals[tierName] || themeVals.surface;
        var sat = v.sat;
        if (!_hasP3 && SRGB_SAT_CAP[tierName] !== undefined) {
            sat = Math.min(sat, SRGB_SAT_CAP[tierName]);
        }
        var tint = _reducedTransparency ? 0.92 : v.tint;
        return { sat: sat, bright: v.bright, tint: tint };
    }

    function getTierName(el) {
        for (var sel in TIER_NAME_MAP) {
            if (el.matches(sel)) return TIER_NAME_MAP[sel];
        }
        return 'surface';
    }

    detectTheme();

    // ====================================================================
    // Glass FS tuning constants — single source of truth for both shaders.
    //
    // Each entry is { type: 'float'|'vec3', value: number | [r,g,b] }. The
    // emitter functions synthesize the const block in WGSL or GLSL ES 300
    // syntax; drivers prepend the result to their FS source before compile.
    // Keep keys ordered intentionally — emission order matches insertion order
    // (ES2015+ string-key iteration), which preserves the section grouping.
    // ====================================================================
    var GLASS_TUNING = {
        EDGE_AA_PX:                   { type: 'float', value: 1.5 },
        THICKNESS_EDGE_BOOST:         { type: 'float', value: 0.4 },

        SHADOW_BASE_ALPHA:            { type: 'float', value: 0.22 },
        SHADOW_FALLOFF_SIGMA2:        { type: 'float', value: 18.0 },
        SHADOW_LUM_SCALE:             { type: 'float', value: 0.25 },
        SHADOW_CHROMA_SCALE:          { type: 'float', value: 0.9 },

        ABSORPTION:                   { type: 'float', value: 0.06 },
        ABSORPTION_TINT:              { type: 'vec3',  value: [0.96, 0.97, 1.0] },

        INNER_SHADOW_STRENGTH:        { type: 'float', value: 0.3 },
        INNER_SHADOW_FLOOR:           { type: 'float', value: 0.7 },

        HIGHLIGHT_BASE_MUL:           { type: 'float', value: 3.5 },
        HIGHLIGHT_BASE_ADD:           { type: 'float', value: 0.375 },
        HIGHLIGHT_CHROMA_MUL:         { type: 'float', value: 1.5 },
        HIGHLIGHT_LOCALPOS_DAMPEN:    { type: 'float', value: 0.4 },
        HIGHLIGHT_DARK_BACKDROP_FLOOR:{ type: 'float', value: 0.3 },

        SPEC_CREST_COLOR:             { type: 'vec3',  value: [0.95, 0.97, 1.0] },
        SPEC_CREST_INTENSITY:         { type: 'float', value: 1.4 },

        DIRECTIONAL_SHADOW_STRENGTH:  { type: 'float', value: 0.45 },
        INNER_RIM_INTENSITY:          { type: 'float', value: 0.15 },

        ENV_COLOR_LOW:                { type: 'vec3',  value: [0.6, 0.65, 0.75] },
        ENV_COLOR_HIGH:               { type: 'vec3',  value: [0.85, 0.9, 1.0] },
        ENV_INTENSITY:                { type: 'float', value: 0.03 },

        REVEAL_RIM_COLOR:             { type: 'vec3',  value: [0.2, 0.9, 0.45] },

        BREATH_AMOUNT:                { type: 'float', value: 0.07 },
        CAUSTIC_INTENSITY:            { type: 'float', value: 0.04 },
        GRAIN_INTENSITY:              { type: 'float', value: 0.04 }
    };

    // GLSL/WGSL require literals like `1.0`, not `1` — toString drops the
    // decimal point on integer-valued floats.
    function fmtFloat(v) {
        var s = v.toString();
        if (s.indexOf('.') === -1) s += '.0';
        return s;
    }

    function emitGlassConstsWGSL() {
        var out = '';
        for (var name in GLASS_TUNING) {
            var c = GLASS_TUNING[name];
            if (c.type === 'float') {
                out += 'const ' + name + ': f32 = ' + fmtFloat(c.value) + ';\n';
            } else if (c.type === 'vec3') {
                out += 'const ' + name + ': vec3f = vec3f(' +
                    fmtFloat(c.value[0]) + ', ' + fmtFloat(c.value[1]) + ', ' + fmtFloat(c.value[2]) + ');\n';
            }
        }
        return out;
    }

    function emitGlassConstsGLSL() {
        var out = '';
        for (var name in GLASS_TUNING) {
            var c = GLASS_TUNING[name];
            if (c.type === 'float') {
                out += 'const float ' + name + '=' + fmtFloat(c.value) + ';\n';
            } else if (c.type === 'vec3') {
                out += 'const vec3 ' + name + '=vec3(' +
                    fmtFloat(c.value[0]) + ',' + fmtFloat(c.value[1]) + ',' + fmtFloat(c.value[2]) + ');\n';
            }
        }
        return out;
    }

    // ====================================================================
    // Backdrop image cache (URL-keyed + refcounted + LRU).
    //
    // Driver supplies texture create/destroy callbacks; the rest is shared.
    // Returns a per-driver instance — drivers never share GPU texture handles.
    //
    // driver.createTexture(canvas, w, h, url) → texHandle
    // driver.destroyTexture(texHandle)
    // driver.onImageLoaded()  // called when an async image finishes; driver
    //                            typically flips its _layoutDirty flag.
    // ====================================================================
    function createBackdropManager(driver) {
        var cache = new Map();    // url → { tex, lastUsed, refs, aspect }
        var pending = new Map();  // url → { promise }
        var failed = new Set();   // urls that failed to load (CORS, 404) — never retry
        var cachedUrl = new Array(MAX_CACHED);

        function evictLRU() {
            if (cache.size <= BACKDROP_MAX_TEXTURES) return;
            var oldestUrl = null, oldestT = Infinity;
            cache.forEach(function (entry, url) {
                if (entry.refs > 0) return;
                if (entry.lastUsed < oldestT) { oldestT = entry.lastUsed; oldestUrl = url; }
            });
            if (!oldestUrl) return;
            var victim = cache.get(oldestUrl);
            if (victim.tex) driver.destroyTexture(victim.tex);
            cache.delete(oldestUrl);
        }

        function loadImage(url) {
            var existing = cache.get(url);
            if (existing) { existing.lastUsed = performance.now(); return Promise.resolve(existing); }
            if (failed.has(url)) return Promise.resolve(null);
            var p = pending.get(url);
            if (p) return p.promise;

            // <img> path (img-src CSP) instead of fetch (connect-src CSP). Must be
            // CORS-clean for copyExternalImageToTexture / texImage2D. CDN failures
            // land in `failed` and never retry.
            var promise = new Promise(function (resolve, reject) {
                var img = new Image();
                img.crossOrigin = 'anonymous';
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                img.onload = function () { resolve(img); };
                img.onerror = function () { reject(new Error('image load failed')); };
                img.src = url;
            })
                .then(function (img) { return img.decode ? img.decode().then(function () { return img; }) : img; })
                .then(function (img) {
                    // Preserve native aspect — texture tracks the image's natural ratio
                    // (max side = BACKDROP_TEX_SIZE). Shader uses texAspect for
                    // cover-style UV sampling, matching CSS background-size:cover.
                    var iw = img.naturalWidth || img.width || 1;
                    var ih = img.naturalHeight || img.height || 1;
                    var scale = BACKDROP_TEX_SIZE / Math.max(iw, ih);
                    var tw = Math.max(1, Math.round(iw * scale));
                    var th = Math.max(1, Math.round(ih * scale));
                    var canvas = ('OffscreenCanvas' in global)
                        ? new OffscreenCanvas(tw, th)
                        : Object.assign(document.createElement('canvas'), { width: tw, height: th });
                    var cctx = canvas.getContext('2d');
                    cctx.filter = 'blur(' + BACKDROP_PREBLUR_PX + 'px) brightness(' + BACKDROP_BRIGHTNESS + ') saturate(' + BACKDROP_SATURATE + ')';
                    cctx.drawImage(img, 0, 0, tw, th);
                    var tex = driver.createTexture(canvas, tw, th, url);
                    var entry = { tex: tex, lastUsed: performance.now(), refs: 0, aspect: tw / th };
                    cache.set(url, entry);
                    pending.delete(url);
                    evictLRU();
                    if (driver.onImageLoaded) driver.onImageLoaded();
                    return entry;
                })
                .catch(function () {
                    pending.delete(url);
                    failed.add(url);   // permanent — silent CSS-overlay fallback
                    return null;
                });
            pending.set(url, { promise: promise });
            return promise;
        }

        function resolveUrl(el) {
            var raw = el.getAttribute('data-glass-backdrop');
            if (!raw) return null;
            return new URL(raw, document.baseURI).href;
        }

        function bindPanel(idx, el) {
            var url = resolveUrl(el);
            var prev = cachedUrl[idx];
            if (prev && prev !== url) {
                var prevEntry = cache.get(prev);
                if (prevEntry && prevEntry.refs > 0) prevEntry.refs--;
            }
            cachedUrl[idx] = url || undefined;
            if (!url) return;
            var entry = cache.get(url);
            if (entry) {
                if (prev !== url) entry.refs++;
                entry.lastUsed = performance.now();
            } else {
                loadImage(url);
            }
        }

        function resetBindings() {
            cache.forEach(function (entry) { entry.refs = 0; });
            for (var i = 0; i < MAX_CACHED; i++) cachedUrl[i] = undefined;
            document.documentElement.classList.remove('glass-refract-bd-active');
        }

        return {
            cache: cache,
            pending: pending,
            failed: failed,
            cachedUrl: cachedUrl,
            bindPanel: bindPanel,
            resetBindings: resetBindings,
            getUrl: function (idx) { return cachedUrl[idx]; },
            getEntry: function (url) { return cache.get(url); }
        };
    }

    global.__glassCore = {
        // Algorithm constants
        HALF_RES: HALF_RES,
        BLUR_PASSES: BLUR_PASSES,
        MAX_PANELS: MAX_PANELS,
        MAX_CACHED: MAX_CACHED,
        IOR: IOR,
        THICKNESS: THICKNESS,
        BEZEL: BEZEL,
        SPECULAR: SPECULAR,
        SHADOW_MARGIN: SHADOW_MARGIN,
        REVEAL_MULT: REVEAL_MULT,
        BACKDROP_TEX_SIZE: BACKDROP_TEX_SIZE,
        BACKDROP_PREBLUR_PX: BACKDROP_PREBLUR_PX,
        BACKDROP_BRIGHTNESS: BACKDROP_BRIGHTNESS,
        BACKDROP_SATURATE: BACKDROP_SATURATE,
        BACKDROP_MAX_TEXTURES: BACKDROP_MAX_TEXTURES,
        // Selectors
        GLASS_SEL: GLASS_SEL,
        REVEAL_SEL: REVEAL_SEL,
        // Theme/tier
        TIER_VALUES: TIER_VALUES,
        SRGB_SAT_CAP: SRGB_SAT_CAP,
        hasP3: _hasP3,
        reducedTransparency: _reducedTransparency,
        detectTheme: detectTheme,
        getTierName: getTierName,
        getTierValues: getTierValues,
        createBackdropManager: createBackdropManager,
        GLASS_TUNING: GLASS_TUNING,
        emitGlassConstsWGSL: emitGlassConstsWGSL,
        emitGlassConstsGLSL: emitGlassConstsGLSL
    };
})(window);
