/**
 * Glass renderer shared core — pipeline-agnostic helpers.
 *
 * Loaded before glass-webgpu.js (and the dynamically-loaded glass.js fallback).
 * Exposes window.__glassCore with constants, selectors, the tier-aware theme
 * system, and a few pure helpers shared between the WebGPU and WebGL2 drivers.
 *
 * Drivers destructure into local vars at the top of their IIFE so the rest of
 * their code is unchanged — single source of truth, zero rename churn.
 *
 * Refraction model (slope-field displacement, adaptive Gaussian blur pyramid,
 * luma-gated edge reflection, directional specular rim) adapted from liquid-dom
 * by Andrew Prifer — https://github.com/AndrewPrifer/liquid-dom. Re-derived and
 * re-tuned for this project's quarter-res aurora backdrop; not a verbatim copy.
 */
(function (global) {
    'use strict';

    // ====================================================================
    // Algorithm constants — must match the values baked into shader strings.
    // ====================================================================
    var HALF_RES = 4;            // quarter-res aurora + blur
    var MAX_PANELS = 128;

    // Adaptive blur pyramid (ported from AndrewPrifer/liquid-dom — ADAPTIVE_BLUR_PERF.md).
    // Level 0 is a separable 13-tap σ=3 Gaussian at half-res; each higher level is a
    // box-downsample (one level at a time) followed by the same Gaussian, so effective
    // full-res radius ≈ DENSE_RADIUS_PX * 2^level. Per-tier blur radii select a level via
    // log2(radius / DENSE_RADIUS_PX); panels sample that (fractional) level by LOD.
    // Max pyramid levels (bounded again by the actual half-res dimensions at runtime).
    var BLUR_MIP_MAX = 4;
    var DENSE_RADIUS_PX = 6;     // radius represented by level 0 (their 13-tap dense radius)
    // Separable Gaussian — liquid-dom's 13-tap σ=3 default. Collapsed to 7 texture
    // fetches via bilinear tap pairing: one centre sample + three symmetric pairs.
    // Weights are normalized to sum to 1; offsets are in texels of the source level.
    var GAUSS = {
        center: 0.137020,
        pairWeight: [0.239336, 0.139439, 0.052710],
        pairOffset: [1.458430, 3.403984, 5.351689]
    };

    var MAX_CACHED = 512;
    var IOR = 1.5;   // liquid-dom Container.ior default (ground truth; was 3.0 stylized)
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

    // `blurRadius` is the desired backdrop blur radius in CSS px, mirroring the
    // per-tier radii declared in tokens.css that the GPU path previously ignored.
    // getTierValues() converts it to a pyramid level via log2(radius/DENSE_RADIUS_PX)
    // (their radius→level selection); panels sample that fractional level by LOD.
    // DENSE_RADIUS_PX (6) is the level-0 radius, so radii <= 6 read the base level.
    var TIER_VALUES = {
        dark: {
            surface: {sat:1.80, bright:0.78, tint:0.04, blurRadius:6.0},
            nested:  {sat:2.20, bright:0.88, tint:0.07, blurRadius:6.0},
            control: {sat:1.90, bright:0.85, tint:0.05, blurRadius:6.0},
            chrome:  {sat:2.00, bright:0.92, tint:0.06, blurRadius:7.6},
            overlay: {sat:2.40, bright:0.96, tint:0.08, blurRadius:9.4},
            button:  {sat:2.60, bright:1.00, tint:0.07, blurRadius:7.4}
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
        // Radius → fractional pyramid level (their selection: log2(radius/denseRadius)).
        var r = v.blurRadius || DENSE_RADIUS_PX;
        var blurLod = Math.max(0, Math.log2(r / DENSE_RADIUS_PX));
        return { sat: sat, bright: v.bright, tint: tint, blur: blurLod };
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
        // Geometry + optics (also exported as plain JS — see top of file).
        IOR:                          { type: 'float', value: IOR },
        THICKNESS:                    { type: 'float', value: THICKNESS },
        BEZEL:                        { type: 'float', value: BEZEL },
        SPECULAR:                     { type: 'float', value: SPECULAR },
        SHADOW_MARGIN:                { type: 'float', value: SHADOW_MARGIN },
        REVEAL_MULT:                  { type: 'float', value: REVEAL_MULT },

        EDGE_AA_PX:                   { type: 'float', value: 1.5 },
        THICKNESS_EDGE_BOOST:         { type: 'float', value: 0.4 },

        // Refraction normal sourced from a pre-blurred float slope field (liquid-dom).
        // The field stores raw signed slope premultiplied by fill in rgba16float
        // (≈ their displacement field); SLOPE_ENCODE_MAX just clamps the bevel slope
        // to avoid extreme grazing angles (~tan 85°). DISP_SLAB_SCALE tunes the
        // refract()+slab displacement magnitude (ray.xy/-ray.z * surfaceHeight * scale).
        SLOPE_ENCODE_MAX:             { type: 'float', value: 12.0 },
        // liquid-dom ground-truth displacement model (renderer/core.ts + GLASS_SHADER):
        //   surfaceHeight = REFRACT_THICKNESS + convexSquircleHeight(distFromEdge/REFRACT_BEZEL)*REFRACT_BEZEL
        //   displacement  = refractedRay.xy / -refractedRay.z * surfaceHeight * DISP_SLAB_SCALE
        // Their Container defaults: thickness 90, bezelWidth 14, displacementFactor 1 (CSS px).
        DISP_SLAB_SCALE:              { type: 'float', value: 1.0 },  // their displacementFactor
        REFRACT_THICKNESS:            { type: 'float', value: 90.0 }, // their thickness (base height, px)
        REFRACT_BEZEL:                { type: 'float', value: 14.0 }, // their bezelWidth (rim band, px)

        SHADOW_BASE_ALPHA:            { type: 'float', value: 0.22 },
        SHADOW_FALLOFF_SIGMA2:        { type: 'float', value: 18.0 },
        SHADOW_LUM_SCALE:             { type: 'float', value: 0.25 },
        SHADOW_CHROMA_SCALE:          { type: 'float', value: 0.9 },

        // Fresnel (Schlick) — F0 is dielectric base reflectance; F90 ≈ 1−F0.
        FRESNEL_F0:                   { type: 'float', value: 0.04 },

        // Chromatic aberration strength — R/B sample the backdrop at (1 ± CA_STRENGTH)×
        // the green refraction offset. NOTE: physical per-channel dispersion (refract at
        // IOR ± δ) is invisible here — the backdrop is the heavily-blurred low-frequency
        // aurora (σ ≈ 12px screen), so the sub-σ per-channel offset difference carries no
        // color to split, and IOR−δ caps out near 1.0 (~δ=0.4) before it could overcome
        // the blur. A direct ± multiplier on the offset is what actually reads. Defaulted
        // strong because IOR=1.5 displaces less than the old 3.0. Dial: 0.2 (subtle) →
        // 0.35 (clear) → 0.6 (prismatic). Most visible between aurora blobs / on art panels.
        CA_STRENGTH:                  { type: 'float', value: 0.35 },

        // Luma-gated edge reflection (liquid-dom GLASS_SHADER reflection term).
        // Sample the blurred backdrop offset along the rim normal; reveal it only
        // where the reflected sample is bright AND the refracted sample beneath is
        // dark. REFLECTION_OFFSET_PX = their reflectionOffset (specularSecondary.z).
        // PRESENCE/ACCEPT bands are their exact smoothstep thresholds.
        REFLECTION_OFFSET_PX:         { type: 'float', value: 18.0 },
        REFLECT_PRESENCE_LO:          { type: 'float', value: 0.2 },
        REFLECT_PRESENCE_HI:          { type: 'float', value: 0.85 },
        REFLECT_ACCEPT_LO:            { type: 'float', value: 0.35 },
        REFLECT_ACCEPT_HI:            { type: 'float', value: 0.85 },
        // Rim band the reflection is confined to (px from edge). Their gate is a
        // ~1px directional specular band; we use a small distance band since our
        // specular model is cursor-driven, not static-light.
        REFLECT_BAND_PX:              { type: 'float', value: 8.0 },

        ABSORPTION:                   { type: 'float', value: 0.06 },
        ABSORPTION_TINT:              { type: 'vec3',  value: [0.96, 0.97, 1.0] },

        // Adaptive tint (liquid-dom ADAPTIVE_TINT.md). The frosted-glass tint target
        // is a NEUTRAL grayscale whose brightness tracks the backdrop luminance instead
        // of a fixed white — so dark backdrops get dark tint (no milky fog) and bright
        // backdrops brighten to match. luminance → smoothstep(LO,HI) → LEVEL_MIN + n*RANGE.
        // We do it per-pixel in-shader (we already have `lum`), so no CPU metrics/debounce.
        TINT_LUM_LO:                  { type: 'float', value: 0.08 },
        TINT_LUM_HI:                  { type: 'float', value: 0.92 },
        TINT_LEVEL_MIN:               { type: 'float', value: 0.10 },
        TINT_LEVEL_RANGE:             { type: 'float', value: 0.75 },
        // Their "optional floor": above this backdrop luminance, don't let the tint be
        // darker than the backdrop itself (tintLevel = max(mapped, lum)). Keeps bright
        // backdrops from being dulled by the tint. Below it, use the mapped value as-is.
        TINT_FLOOR_LUM:               { type: 'float', value: 0.50 },
        // Gamma fix: their thresholds are authored for LINEAR luminance, but our blur
        // target is gamma-encoded (rgba8unorm). Linearize the tint luminance only
        // (~sRGB→linear) so the curve sits where they intended. 1.0 = no conversion.
        TINT_GAMMA:                   { type: 'float', value: 2.2 },

        INNER_SHADOW_STRENGTH:        { type: 'float', value: 0.3 },
        INNER_SHADOW_FLOOR:           { type: 'float', value: 0.7 },
        // Fraction of bezel width across which the inner shadow fades.
        INNER_SHADOW_BEZEL_FRAC:      { type: 'float', value: 0.6 },

        // Cursor-driven rim highlight band.
        RIM_EDGE_PROX_PX:             { type: 'float', value: 3.0 },
        RIM_DIRECTIONAL_LO:           { type: 'float', value: 0.35 },
        RIM_DIRECTIONAL_HI:           { type: 'float', value: 0.80 },
        // Backdrop-adaptive highlight intensity smoothstep band.
        BACKDROP_ADAPT_LO:            { type: 'float', value: 0.05 },
        BACKDROP_ADAPT_HI:            { type: 'float', value: 0.25 },

        HIGHLIGHT_BASE_MUL:           { type: 'float', value: 3.5 },
        HIGHLIGHT_BASE_ADD:           { type: 'float', value: 0.375 },
        HIGHLIGHT_CHROMA_MUL:         { type: 'float', value: 1.5 },
        HIGHLIGHT_LOCALPOS_DAMPEN:    { type: 'float', value: 0.4 },
        HIGHLIGHT_DARK_BACKDROP_FLOOR:{ type: 'float', value: 0.3 },

        SPEC_CREST_COLOR:             { type: 'vec3',  value: [0.95, 0.97, 1.0] },
        SPEC_CREST_INTENSITY:         { type: 'float', value: 1.4 },

        // Directional dark falloff (perpendicular to light direction).
        DIRECTIONAL_SHADOW_STRENGTH:  { type: 'float', value: 0.45 },
        DIR_SHADOW_EDGE_PROX_PX:      { type: 'float', value: 6.0 },
        DIR_SHADOW_LO:                { type: 'float', value: 0.50 },
        DIR_SHADOW_HI:                { type: 'float', value: 0.85 },

        // Inner rim hairline ramp (px from edge).
        INNER_RIM_INTENSITY:          { type: 'float', value: 0.15 },
        INNER_RIM_LO_PX:              { type: 'float', value: 2.0 },
        INNER_RIM_HI_PX:              { type: 'float', value: 5.0 },

        ENV_COLOR_LOW:                { type: 'vec3',  value: [0.6, 0.65, 0.75] },
        ENV_COLOR_HIGH:               { type: 'vec3',  value: [0.85, 0.9, 1.0] },
        ENV_INTENSITY:                { type: 'float', value: 0.03 },

        REVEAL_RIM_COLOR:             { type: 'vec3',  value: [0.2, 0.9, 0.45] },
        // Reveal-stage standalone tunables. The 8-layer Gaussian/color/weight
        // stack inside the reveal `if` is still inline — it's a coupled visual
        // signature and needs array support before it can land here.
        REVEAL_EPSILON:               { type: 'float', value: 0.001 },
        REVEAL_REFRACT_SCALE:         { type: 'float', value: 0.18 },
        REVEAL_PANEL_DIAG_REF:        { type: 'float', value: 280.0 },
        REVEAL_PANEL_DIAG_FLOOR:      { type: 'float', value: 0.25 },
        REVEAL_CAUSTIC_BOOST:         { type: 'float', value: 1.5 },
        REVEAL_RIM_CAUSTIC_BOOST:     { type: 'float', value: 2.0 },
        REVEAL_EDGE_PROX_PX:          { type: 'float', value: 4.0 },
        REVEAL_RIM_SIGMA:             { type: 'float', value: 2000.0 },

        // Ambient breathing on panel-local UVs.
        BREATH_AMOUNT:                { type: 'float', value: 0.07 },
        BREATH_SPATIAL_SCALE:         { type: 'float', value: 0.012 },
        BREATH_TIME_SCALE:            { type: 'float', value: 0.45 },

        // Multi-layer caustic interference.
        CAUSTIC_INTENSITY:            { type: 'float', value: 0.04 },
        CAUSTIC_SPATIAL_SCALE:        { type: 'float', value: 0.005 },
        CAUSTIC_TIME_SCALE:           { type: 'float', value: 0.35 },
        CAUSTIC_THRESHOLD:            { type: 'float', value: 0.8 },

        GRAIN_INTENSITY:              { type: 'float', value: 0.04 },

        // Shared math constants used in the FS body (luminance weights, IGN hash).
        LUMA_WEIGHTS:                 { type: 'vec3',  value: [0.2126, 0.7152, 0.0722] },
        IGN_DOT:                      { type: 'vec2',  value: [0.06711056, 0.00583715] },
        IGN_HASH:                     { type: 'float', value: 52.9829189 }
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
            } else if (c.type === 'vec2') {
                out += 'const ' + name + ': vec2f = vec2f(' +
                    fmtFloat(c.value[0]) + ', ' + fmtFloat(c.value[1]) + ');\n';
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
            } else if (c.type === 'vec2') {
                out += 'const vec2 ' + name + '=vec2(' +
                    fmtFloat(c.value[0]) + ',' + fmtFloat(c.value[1]) + ');\n';
            } else if (c.type === 'vec3') {
                out += 'const vec3 ' + name + '=vec3(' +
                    fmtFloat(c.value[0]) + ',' + fmtFloat(c.value[1]) + ',' + fmtFloat(c.value[2]) + ');\n';
            }
        }
        return out;
    }

    // ====================================================================
    // Glass FS body — co-located WGSL/GLSL chunks for each pipeline stage.
    //
    // HOW THIS WORKS
    //   Each entry is { name, wgsl, glsl }. buildGlassFSBody(lang) concatenates
    //   the chunks in array order; the driver's GLASS_FS template substitutes
    //   the result into a single function body. Both language variants live
    //   side-by-side per stage so edits to one prompt edits to the other.
    //
    // STAGE FLOW
    //   Stages run in one shared function scope. Variables declared in earlier
    //   stages are visible in later ones:
    //     surfaceSlope produces  h, dh, thicknessLocal
    //     refraction   produces  dispR, dispG, dispB, displacement, invSqrtX2p1
    //                            (normal sourced from the pre-blurred slope field)
    //     fresnel      produces  fresnel
    //     sdfGradient  produces  grad
    //     colorGrade   produces  col (mutated by rim/shadow/reveal/ambient)
    //   Reordering stages will break later ones — assume forward dependencies.
    //
    // IDENTIFIER CONVENTIONS
    //   WGSL: localPos, panelSize, blurUV, screenPos, radius, saturation,
    //         brightness, tintAlpha, opacity, reveal, blurLod,
    //         uniforms.viewport, uniforms.mouse, uniforms.time
    //   GLSL: vLocalPos, vPanelSize, vBlurUV, vScreenPos, vRadius, vSaturation,
    //         vBrightness, vTintAlpha, vOpacity, vReveal, vBlurLod,
    //         uViewport, uMouse, uTime
    //
    // ADDING A NEW STAGE
    //   1. Insert { name, wgsl, glsl } in the right position (mind dependencies).
    //   2. WGSL uses 4-space indent; GLSL uses 2-space indent.
    //   3. Each chunk starts with '\n' (blank-line separator from prior stage)
    //      except `preamble` which is the very first content in the function.
    //   4. Each chunk ends with '\n' so the next stage begins on a fresh line.
    //   5. If you need a new tunable constant, add it to GLASS_TUNING — do not
    //      inline numeric literals (the WGSL/GLSL bodies would drift).
    //
    // INSPECTING THE COMPILED BODY
    //   In DevTools: __glassCore.dumpGlassFS('wgsl')  or  ...('glsl')
    //   That returns the exact string the driver pastes into its FS template.
    // ====================================================================
    var GLASS_STAGES = [
        {
            name: 'preamble',
            wgsl: `    let sd = rboxSDF(localPos, panelSize, radius);
`,
            glsl: `  float sd=rboxSDF(vLocalPos,vPanelSize,vRadius);
`
        },
        {
            name: 'dropShadow',
            wgsl: `
    // === Drop shadow (outside panel) ===
    // Color-matched to local backdrop so the cast shadow takes on the hue
    // of what's behind the panel instead of being flat black.
    if (sd > 0.0) {
        if (sd > SHADOW_MARGIN) { discard; }
        let shadowFalloff = exp(-sd * sd / SHADOW_FALLOFF_SIGMA2);
        let shadowAlpha = SHADOW_BASE_ALPHA * shadowFalloff;
        let shadowBackdrop = textureSampleLevel(blurTex, blurSampler, blurUV, 0.0).rgb;
        // Boost chroma while preserving low luminance — keeps the shadow dark
        // but emphasizes color cast from whatever's behind the panel.
        let shadowLum = dot(shadowBackdrop, LUMA_WEIGHTS);
        let shadowChroma = shadowBackdrop - vec3f(shadowLum);
        let shadowColor = max(vec3f(shadowLum) * SHADOW_LUM_SCALE + shadowChroma * SHADOW_CHROMA_SCALE, vec3f(0.0));
        return vec4f(shadowColor, shadowAlpha * opacity);
    }
`,
            glsl: `
  // === Drop shadow (outside panel) ===
  if(sd>0.0){
    if(sd>SHADOW_MARGIN)discard;
    float shadowFalloff=exp(-sd*sd/SHADOW_FALLOFF_SIGMA2);
    float shadowAlpha=SHADOW_BASE_ALPHA*shadowFalloff;
    vec3 shadowBackdrop=textureLod(uBlurTex,vBlurUV,0.0).rgb;
    float shadowLum=dot(shadowBackdrop,LUMA_WEIGHTS);
    vec3 shadowChroma=shadowBackdrop-vec3(shadowLum);
    vec3 shadowColor=max(vec3(shadowLum)*SHADOW_LUM_SCALE+shadowChroma*SHADOW_CHROMA_SCALE,vec3(0.0));
    fragColor=vec4(shadowColor,shadowAlpha*vOpacity);
    return;
  }
`
        },
        {
            name: 'edgeBezel',
            wgsl: `
    // === Edge alpha + bezel zone ===
    let distFromEdge = -sd;
    let alpha = smoothstep(0.0, EDGE_AA_PX, distFromEdge);
    // Bezel slab clamped by both corner radius and panel size — keeps it
    // inside the rounded area so the SDF's diagonal discontinuity stays
    // hidden, and scales down on small panels so buttons act like small glass.
    let bezel = max(1.0, min(BEZEL, min(radius, min(panelSize.x, panelSize.y)) - 1.0));
    let t = clamp(distFromEdge / bezel, 0.0, 1.0);
`,
            glsl: `
  // === Edge alpha + bezel zone ===
  float distFromEdge=-sd;
  float alpha=smoothstep(0.0,EDGE_AA_PX,distFromEdge);
  float bezel=max(1.0,min(BEZEL,min(vRadius,min(vPanelSize.x,vPanelSize.y))-1.0));
  float t=clamp(distFromEdge/bezel,0.0,1.0);
`
        },
        {
            name: 'surfaceSlope',
            wgsl: `
    // === Surface profile + slope ===
    let h = surfaceHeight(t);
    let dt: f32 = 0.001;
    let h2 = surfaceHeight(min(t + dt, 1.0));
    let dh = (h2 - h) / dt;
    // Depth-varying thickness — edge gets a boost to strengthen rim bending.
    let thicknessLocal = THICKNESS * (1.0 + (1.0 - h * h) * THICKNESS_EDGE_BOOST);
`,
            glsl: `
  // === Surface profile + slope ===
  float h=surfaceHeight(t);
  float dt=0.001;
  float h2=surfaceHeight(min(t+dt,1.0));
  float dh=(h2-h)/dt;
  float thicknessLocal=THICKNESS*(1.0+(1.0-h*h)*THICKNESS_EDGE_BOOST);
`
        },
        {
            name: 'refraction',
            wgsl: `
    // === Refraction (clean normal from pre-blurred slope field; refract()+slab) ===
    // Decode the premultiplied slope field, rebuild a 3D normal, refract a
    // straight-down ray, and project it through the local glass height. Ported from
    // liquid-dom — the pre-blurred normal removes the inline-gradient quantization
    // that limited the effect before. (Chromatic aberration is applied below as an
    // offset multiplier, not per-channel IOR — see CA_STRENGTH for why.)
    let slopeField = textureSampleLevel(slopeTex, blurSampler, blurUV, 0.0);
    // Float field stores raw premultiplied slope (slope*fill, fill) — un-premultiply.
    let surfaceSlope = select(
        vec2f(0.0),
        slopeField.xy / max(slopeField.a, 0.0001),
        slopeField.a > 0.001
    );
    let refractNormal = normalize(vec3f(surfaceSlope, 1.0));
    let invSqrtX2p1 = refractNormal.z;                 // incidence cosine → Fresnel
    // surfaceHeight = thickness + convexSquircleHeight(bezelProgress)*bezelWidth (their
    // globals.glass.x + profileHeight). Thickness dominates (~90px); the bevel adds a
    // small ramp. Displacement = bend(normal) × height, concentrated in the rim band.
    let bezelProg = clamp(distFromEdge / REFRACT_BEZEL, 0.0, 1.0);
    let csU = 1.0 - bezelProg;
    let profH = sqrt(max(1.0 - csU * csU * csU * csU, 0.0001));   // convexSquircle height
    let surfaceHeightVal = REFRACT_THICKNESS + profH * REFRACT_BEZEL;
    let down = vec3f(0.0, 0.0, -1.0);
    let rayG = refract(down, refractNormal, 1.0 / IOR);
    let dispG = rayG.xy / max(-rayG.z, 0.0001) * surfaceHeightVal * DISP_SLAB_SCALE;
    // Chromatic aberration: spread R/B along the SAME refraction vector. Physical
    // per-channel refract(IOR ± δ) is washed out here — the backdrop is the heavily-
    // blurred low-frequency aurora, so sub-σ per-channel offsets carry no color to
    // separate. A direct ± multiplier on the offset is what actually reads (see CA_STRENGTH).
    let dispR = dispG * (1.0 + CA_STRENGTH);
    let dispB = dispG * (1.0 - CA_STRENGTH);
    let displacement = length(dispG);                  // scalar for reveal/secondary
`,
            glsl: `
  // === Refraction (clean normal from pre-blurred slope field; refract()+slab) ===
  vec4 slopeField=textureLod(uSlopeTex,vBlurUV,0.0);
  vec2 surfaceSlope=slopeField.a>0.001
    ? slopeField.xy/max(slopeField.a,0.0001)
    : vec2(0.0);
  vec3 refractNormal=normalize(vec3(surfaceSlope,1.0));
  float invSqrtX2p1=refractNormal.z;
  float bezelProg=clamp(distFromEdge/REFRACT_BEZEL,0.0,1.0);
  float csU=1.0-bezelProg;
  float profH=sqrt(max(1.0-csU*csU*csU*csU,0.0001));
  float surfaceHeightVal=REFRACT_THICKNESS+profH*REFRACT_BEZEL;
  vec3 down=vec3(0.0,0.0,-1.0);
  vec3 rayG=refract(down,refractNormal,1.0/IOR);
  vec2 dispG=rayG.xy/max(-rayG.z,0.0001)*surfaceHeightVal*DISP_SLAB_SCALE;
  // CA: spread R/B along the same vector (physical dispersion is washed out by the
  // blurred aurora — see WGSL note + CA_STRENGTH).
  vec2 dispR=dispG*(1.0+CA_STRENGTH);
  vec2 dispB=dispG*(1.0-CA_STRENGTH);
  float displacement=length(dispG);
`
        },
        {
            name: 'fresnel',
            wgsl: `
    // === Fresnel (Schlick) ===
    let cosTheta = invSqrtX2p1;
    let omc = 1.0 - cosTheta;
    let omc2 = omc * omc;
    let fresnel = FRESNEL_F0 + (1.0 - FRESNEL_F0) * omc2 * omc2 * omc;
`,
            glsl: `
  // === Fresnel (Schlick) ===
  float cosTheta=invSqrtX2p1;
  float omc=1.0-cosTheta;
  float omc2=omc*omc;
  float fresnel=FRESNEL_F0+(1.0-FRESNEL_F0)*omc2*omc2*omc;
`
        },
        {
            name: 'sdfGradient',
            wgsl: `
    // === SDF gradient (finite differences) ===
    // Used as the surface-normal direction for refraction sampling. Continuous
    // everywhere on the SDF, so wide bezels don't expose the axis-switch seam
    // the analytical formulation produced near diagonals.
    let sd_dx = rboxSDF(localPos + vec2f(0.5, 0.0), panelSize, radius);
    let sd_dy = rboxSDF(localPos + vec2f(0.0, 0.5), panelSize, radius);
    // Length-guard the normalize: along a wide panel's horizontal medial axis the
    // forward +0.5 difference straddles the abs() vertex symmetrically, so both
    // components are exactly 0 → normalize(0,0) = NaN → black band after blur.
    let gradVec = vec2f(sd_dx - sd, sd_dy - sd);
    let gradLen = length(gradVec);
    let grad = select(vec2f(0.0, 0.0), gradVec / gradLen, gradLen > 1e-5);
`,
            glsl: `
  // === SDF gradient (finite differences) ===
  float sd_dx=rboxSDF(vLocalPos+vec2(0.5,0.0),vPanelSize,vRadius);
  float sd_dy=rboxSDF(vLocalPos+vec2(0.0,0.5),vPanelSize,vRadius);
  // Length-guard the normalize (see WGSL note): medial-axis forward diff → (0,0) → NaN → black.
  vec2 gradVec=vec2(sd_dx-sd,sd_dy-sd);
  float gradLen=length(gradVec);
  vec2 grad=gradLen>1e-5 ? gradVec/gradLen : vec2(0.0);
`
        },
        {
            name: 'backdropSample',
            wgsl: `
    // === Backdrop sampling (per-channel refracted offset) ===
    // Each channel samples the blurred backdrop at its own refracted displacement
    // (vectors from the refraction stage). blurLod selects the mip level; clamped.
    let invVp = 1.0 / uniforms.viewport;
    var blurred = vec3f(
        textureSampleLevel(blurTex, blurSampler, blurUV + dispR * invVp, blurLod).r,
        textureSampleLevel(blurTex, blurSampler, blurUV + dispG * invVp, blurLod).g,
        textureSampleLevel(blurTex, blurSampler, blurUV + dispB * invVp, blurLod).b
    );
    // Sharp backdrop art: panels flagged with blurLod < 0 carry a full-res image
    // in backdropTex (screen-space). Sample it sharp PER CHANNEL at the same R/G/B
    // refracted offsets as the aurora — the art has real edges/contrast, so this is
    // where chromatic aberration actually reads (the smooth aurora can't show it).
    // Coverage (alpha) is taken from the green/true sample.
    if (blurLod < 0.0) {
        let artR = textureSampleLevel(backdropTex, blurSampler, blurUV + dispR * invVp, 0.0);
        let artG = textureSampleLevel(backdropTex, blurSampler, blurUV + dispG * invVp, 0.0);
        let artB = textureSampleLevel(backdropTex, blurSampler, blurUV + dispB * invVp, 0.0);
        let artRGB = vec3f(artR.r, artG.g, artB.b);
        blurred = blurred * (1.0 - artG.a) + artRGB;
    }
`,
            glsl: `
  // === Backdrop sampling (per-channel refracted offset) ===
  vec2 invVp=1.0/uViewport;
  vec3 blurred=vec3(
    textureLod(uBlurTex,vBlurUV+dispR*invVp,vBlurLod).r,
    textureLod(uBlurTex,vBlurUV+dispG*invVp,vBlurLod).g,
    textureLod(uBlurTex,vBlurUV+dispB*invVp,vBlurLod).b
  );
  // Sharp backdrop art: panels flagged with vBlurLod < 0 carry a full-res image
  // in uBackdropTex (screen-space). Sample PER CHANNEL so chromatic aberration reads
  // on the art's real edges (the smooth aurora can't show it). Alpha from green.
  if (vBlurLod < 0.0) {
    vec4 artR = texture(uBackdropTex, vBlurUV + dispR*invVp);
    vec4 artG = texture(uBackdropTex, vBlurUV + dispG*invVp);
    vec4 artB = texture(uBackdropTex, vBlurUV + dispB*invVp);
    vec3 artRGB = vec3(artR.r, artG.g, artB.b);
    blurred = blurred * (1.0 - artG.a) + artRGB;
  }
`
        },
        {
            name: 'colorGrade',
            wgsl: `
    // === Color grading ===
    let lum = dot(blurred, LUMA_WEIGHTS);
    let saturated = mix(vec3f(lum), blurred, saturation);
    var transmitted = saturated * brightness;
    // Beer's law absorption — slight cool tint at thicker (lower-h) areas.
    let absorption = (1.0 - h) * ABSORPTION;
    transmitted *= mix(vec3f(1.0), ABSORPTION_TINT, absorption);
    // Adaptive frosted tint (liquid-dom ADAPTIVE_TINT.md): tint toward a NEUTRAL gray
    // whose level follows the backdrop luminance, not fixed white — dark backdrop gets
    // dark tint (no white fog), bright backdrop brightens to match.
    // Linearized luminance for the tint curve (their thresholds are linear; our blur is gamma).
    let tintLum = dot(pow(blurred, vec3f(TINT_GAMMA)), LUMA_WEIGHTS);
    let tintMapped = TINT_LEVEL_MIN + smoothstep(TINT_LUM_LO, TINT_LUM_HI, tintLum) * TINT_LEVEL_RANGE;
    // Their floor: on bright backdrops (lum >= TINT_FLOOR_LUM) don't tint darker than the backdrop.
    let tintLevel = select(tintMapped, max(tintMapped, tintLum), tintLum >= TINT_FLOOR_LUM);
    var col = mix(transmitted, vec3f(tintLevel), tintAlpha);
    // Inner shadow — darkens transmitted light before specular is added.
    let innerShadow = 1.0 - smoothstep(0.0, bezel * INNER_SHADOW_BEZEL_FRAC, distFromEdge);
    col *= mix(1.0, INNER_SHADOW_FLOOR, innerShadow * INNER_SHADOW_STRENGTH);
`,
            glsl: `
  // === Color grading ===
  float lum=dot(blurred,LUMA_WEIGHTS);
  vec3 saturated=mix(vec3(lum),blurred,vSaturation);
  vec3 transmitted=saturated*vBrightness;
  float absorption=(1.0-h)*ABSORPTION;
  transmitted*=mix(vec3(1.0),ABSORPTION_TINT,absorption);
  // Adaptive frosted tint (see WGSL note): neutral gray tracking backdrop luminance.
  float tintLum=dot(pow(blurred,vec3(TINT_GAMMA)),LUMA_WEIGHTS);  // linearize (their thresholds are linear)
  float tintMapped=TINT_LEVEL_MIN+smoothstep(TINT_LUM_LO,TINT_LUM_HI,tintLum)*TINT_LEVEL_RANGE;
  float tintLevel=tintLum>=TINT_FLOOR_LUM ? max(tintMapped,tintLum) : tintMapped;  // their bright-backdrop floor
  vec3 col=mix(transmitted,vec3(tintLevel),vTintAlpha);
  float innerShadow=1.0-smoothstep(0.0,bezel*INNER_SHADOW_BEZEL_FRAC,distFromEdge);
  col*=mix(1.0,INNER_SHADOW_FLOOR,innerShadow*INNER_SHADOW_STRENGTH);
`
        },
        {
            name: 'edgeReflection',
            wgsl: `
    // === Edge reflection (luma-gated rim reflection) ===
    // Sample the blurred backdrop offset along the rim normal (grad). Reveal it
    // where the reflected sample is bright AND the refracted sample beneath is
    // dark (presence × acceptance). Spatially gated to the rim by a distance band.
    let reflectedUv = blurUV + grad * REFLECTION_OFFSET_PX * invVp;
    let reflectedColor = textureSampleLevel(blurTex, blurSampler, reflectedUv, blurLod).rgb;
    let refractedLuma = dot(blurred, LUMA_WEIGHTS);
    let reflectedLuma = dot(reflectedColor, LUMA_WEIGHTS);
    let reflectionPresence = smoothstep(REFLECT_PRESENCE_LO, REFLECT_PRESENCE_HI, reflectedLuma);
    let refractionAcceptance = 1.0 - smoothstep(REFLECT_ACCEPT_LO, REFLECT_ACCEPT_HI, refractedLuma);
    let reflectionBlend = reflectionPresence * refractionAcceptance;
    let edgeReflectMask = 1.0 - smoothstep(0.0, REFLECT_BAND_PX, distFromEdge);
    col = mix(col, reflectedColor, edgeReflectMask * reflectionBlend);
`,
            glsl: `
  // === Edge reflection (luma-gated rim reflection) ===
  vec2 reflectedUv=vBlurUV+grad*REFLECTION_OFFSET_PX*invVp;
  vec3 reflectedColor=textureLod(uBlurTex,reflectedUv,vBlurLod).rgb;
  float refractedLuma=dot(blurred,LUMA_WEIGHTS);
  float reflectedLuma=dot(reflectedColor,LUMA_WEIGHTS);
  float reflectionPresence=smoothstep(REFLECT_PRESENCE_LO,REFLECT_PRESENCE_HI,reflectedLuma);
  float refractionAcceptance=1.0-smoothstep(REFLECT_ACCEPT_LO,REFLECT_ACCEPT_HI,refractedLuma);
  float reflectionBlend=reflectionPresence*refractionAcceptance;
  float edgeReflectMask=1.0-smoothstep(0.0,REFLECT_BAND_PX,distFromEdge);
  col=mix(col,reflectedColor,edgeReflectMask*reflectionBlend);
`
        },
        {
            name: 'rimHighlight',
            wgsl: `
    // === Cursor-driven rim highlight ===
    // Each rim pixel computes its own vector toward the cursor; abs(dot) gives
    // a symmetric dual hot spot. Edge proximity gates the effect to the rim.
    let edgeProx = 1.0 - smoothstep(0.0, RIM_EDGE_PROX_PX, distFromEdge);
    // panelCenter and mouseLocal are also consumed by the reveal stage below.
    let panelCenter = screenPos - localPos;
    let mouseLocal = uniforms.mouse - panelCenter;
    // localPos contribution dampened — pure per-pixel gives point-light focus
    // as the cursor approaches; pure per-panel is uniform along edges.
    let highlightPixelToCursor = mouseLocal - localPos * HIGHLIGHT_LOCALPOS_DAMPEN + vec2f(0.5, 0.5);
    let highlightMouseDir = normalize(highlightPixelToCursor);
    let directional = abs(dot(grad, highlightMouseDir));
    let directionalPeaked = smoothstep(RIM_DIRECTIONAL_LO, RIM_DIRECTIONAL_HI, directional);
    let highlightAlpha = edgeProx * directionalPeaked;
    // Backdrop-adaptive intensity: bright backdrop = emphasized highlight,
    // dark backdrop = subdued. Uses pre-tint saturated sample so the response
    // tracks transmitted content, not the post-rim-effects color.
    let backdropLum = max(dot(saturated, LUMA_WEIGHTS), 0.0);
    let backdropFactor = smoothstep(BACKDROP_ADAPT_LO, BACKDROP_ADAPT_HI, backdropLum);
    // Hue-preserving target: cap luminance at 1.0 to prevent white-out,
    // then re-add amplified chroma so channels stay differentiated.
    let highlightBase = col * HIGHLIGHT_BASE_MUL + vec3f(HIGHLIGHT_BASE_ADD);
    let highlightBaseLum = dot(highlightBase, LUMA_WEIGHTS);
    let highlightBaseChroma = highlightBase - vec3f(highlightBaseLum);
    let highlightTarget = vec3f(min(highlightBaseLum, 1.0)) + highlightBaseChroma * HIGHLIGHT_CHROMA_MUL;
    col = mix(col, highlightTarget, highlightAlpha * mix(HIGHLIGHT_DARK_BACKDROP_FLOOR, 1.0, backdropFactor));

    // White Fresnel specular crest — sits on top of the color rim. Wider falloff
    // (directional²) than the color rim's smoothstep so it stays visible alongside.
    let specLobe = directional * directional;
    let specAlpha = edgeProx * specLobe * fresnel;
    col += SPEC_CREST_COLOR * specAlpha * SPEC_CREST_INTENSITY;
`,
            glsl: `
  // === Cursor-driven rim highlight ===
  float edgeProx=1.0-smoothstep(0.0,RIM_EDGE_PROX_PX,distFromEdge);
  vec2 panelCenter=vScreenPos-vLocalPos;
  vec2 mouseLocal=uMouse-panelCenter;
  vec2 highlightPixelToCursor=mouseLocal-vLocalPos*HIGHLIGHT_LOCALPOS_DAMPEN+vec2(0.5,0.5);
  vec2 highlightMouseDir=normalize(highlightPixelToCursor);
  float directional=abs(dot(grad,highlightMouseDir));
  float directionalPeaked=smoothstep(RIM_DIRECTIONAL_LO,RIM_DIRECTIONAL_HI,directional);
  float highlightAlpha=edgeProx*directionalPeaked;
  float backdropLum=max(dot(saturated,LUMA_WEIGHTS),0.0);
  float backdropFactor=smoothstep(BACKDROP_ADAPT_LO,BACKDROP_ADAPT_HI,backdropLum);
  vec3 highlightBase=col*HIGHLIGHT_BASE_MUL+vec3(HIGHLIGHT_BASE_ADD);
  float highlightBaseLum=dot(highlightBase,LUMA_WEIGHTS);
  vec3 highlightBaseChroma=highlightBase-vec3(highlightBaseLum);
  vec3 highlightTarget=vec3(min(highlightBaseLum,1.0))+highlightBaseChroma*HIGHLIGHT_CHROMA_MUL;
  col=mix(col,highlightTarget,highlightAlpha*mix(HIGHLIGHT_DARK_BACKDROP_FLOOR,1.0,backdropFactor));
  float specLobe=directional*directional;
  float specAlpha=edgeProx*specLobe*fresnel;
  col+=SPEC_CREST_COLOR*specAlpha*SPEC_CREST_INTENSITY;
`
        },
        {
            name: 'dirShadow',
            wgsl: `
    // === Directional dark falloff ===
    // Perpendicular rim arc (normal sideways to light direction) darkens, giving
    // the panel a sense of being lit from a specific direction. Wider edge band
    // than the highlight for a softer gradient.
    let shadowEdgeProx = 1.0 - smoothstep(0.0, DIR_SHADOW_EDGE_PROX_PX, distFromEdge);
    let shadowDirectional = 1.0 - directional;
    let shadowPeaked = smoothstep(DIR_SHADOW_LO, DIR_SHADOW_HI, shadowDirectional);
    let shadowAlpha = shadowEdgeProx * shadowPeaked;
    col *= 1.0 - shadowAlpha * DIRECTIONAL_SHADOW_STRENGTH;
`,
            glsl: `
  // === Directional dark falloff ===
  float shadowEdgeProx=1.0-smoothstep(0.0,DIR_SHADOW_EDGE_PROX_PX,distFromEdge);
  float shadowDirectional=1.0-directional;
  float shadowPeaked=smoothstep(DIR_SHADOW_LO,DIR_SHADOW_HI,shadowDirectional);
  float shadowAlpha=shadowEdgeProx*shadowPeaked;
  col*=1.0-shadowAlpha*DIRECTIONAL_SHADOW_STRENGTH;
`
        },
        {
            name: 'innerRim',
            wgsl: `
    // === Inner rim hairline ===
    // Continuous 2–5 px stripe inside the edge — defines panel shape
    // independent of cursor lighting.
    let innerRim = smoothstep(0.0, INNER_RIM_LO_PX, distFromEdge) * (1.0 - smoothstep(INNER_RIM_LO_PX, INNER_RIM_HI_PX, distFromEdge));
    col += vec3f(innerRim * INNER_RIM_INTENSITY * SPECULAR);
`,
            glsl: `
  // === Inner rim hairline ===
  float innerRim=smoothstep(0.0,INNER_RIM_LO_PX,distFromEdge)*(1.0-smoothstep(INNER_RIM_LO_PX,INNER_RIM_HI_PX,distFromEdge));
  col+=vec3(innerRim*INNER_RIM_INTENSITY*SPECULAR);
`
        },
        {
            name: 'envReflection',
            wgsl: `
    // === Environment reflection ===
    // Subtle sky gradient modulated by Fresnel.
    let envUp = grad.y * -0.5 + 0.5;
    let envColor = mix(ENV_COLOR_LOW, ENV_COLOR_HIGH, envUp);
    col += envColor * fresnel * ENV_INTENSITY;
`,
            glsl: `
  // === Environment reflection ===
  float envUp=grad.y*-0.5+0.5;
  vec3 envColor=mix(ENV_COLOR_LOW,ENV_COLOR_HIGH,envUp);
  col+=envColor*fresnel*ENV_INTENSITY;
`
        },
        {
            name: 'reveal',
            wgsl: `
    // === Pointer reveal (early-exit when inactive) ===
    // Saves 9 exp() calls on the ~70% of fragments with no active reveal.
    if (reveal > REVEAL_EPSILON) {
        // panelCenter / mouseLocal computed once in the rim-highlight stage above.
        let refractedPos = localPos - grad * displacement * REVEAL_REFRACT_SCALE;
        let fragDist = length(refractedPos - mouseLocal);

        let panelDiag = length(panelSize);
        let ps = max(panelDiag / REVEAL_PANEL_DIAG_REF, REVEAL_PANEL_DIAG_FLOOR);
        let ps2 = ps * ps;

        let caustic = 1.0 + abs(dh) * h * REVEAL_CAUSTIC_BOOST;

        let d2 = fragDist * fragDist;
        let g0 = exp(-d2 / (80.0 * ps2));
        let g1 = exp(-d2 / (250.0 * ps2));
        let g2 = exp(-d2 / (800.0 * ps2));
        let g3 = exp(-d2 / (2500.0 * ps2));
        let g4 = exp(-d2 / (8000.0 * ps2));
        let g5 = exp(-d2 / (25000.0 * ps2));
        let g6 = exp(-d2 / (80000.0 * ps2));
        let g7 = exp(-d2 / (250000.0 * ps2));

        let surfaceMod = h * h;

        let revealLight = (
            vec3f(0.85, 1.0, 0.88) * g0 * 1.8 +
            vec3f(0.60, 0.98, 0.70) * g1 * 1.2 +
            vec3f(0.38, 0.94, 0.52) * g2 * 0.85 +
            vec3f(0.22, 0.88, 0.40) * g3 * 0.60 +
            vec3f(0.12, 0.75, 0.32) * g4 * 0.40 +
            vec3f(0.06, 0.55, 0.22) * g5 * 0.25 +
            vec3f(0.03, 0.38, 0.14) * g6 * 0.15 +
            vec3f(0.01, 0.22, 0.08) * g7 * 0.08
        ) * caustic * surfaceMod;

        // Reveal light transmits through glass — attenuate by Fresnel exit.
        let revealTransmit = 1.0 - fresnel;
        col += reveal * revealLight * REVEAL_MULT * revealTransmit;

        let revealEdgeProx = 1.0 - smoothstep(0.0, REVEAL_EDGE_PROX_PX, distFromEdge);
        let rimCaustic = abs(dh) * h * REVEAL_RIM_CAUSTIC_BOOST;
        let rimDist = exp(-d2 / (REVEAL_RIM_SIGMA * ps2));
        col += reveal * REVEAL_RIM_COLOR * rimCaustic * rimDist * revealEdgeProx * REVEAL_MULT * revealTransmit;
    }
`,
            glsl: `
  // === Pointer reveal (early-exit when inactive) ===
  if(vReveal>REVEAL_EPSILON){
    vec2 refractedPos=vLocalPos-grad*displacement*REVEAL_REFRACT_SCALE;
    float fragDist=length(refractedPos-mouseLocal);
    float panelDiag=length(vPanelSize);
    float ps=max(panelDiag/REVEAL_PANEL_DIAG_REF,REVEAL_PANEL_DIAG_FLOOR);
    float ps2=ps*ps;
    float caustic=1.0+abs(dh)*h*REVEAL_CAUSTIC_BOOST;
    float d2=fragDist*fragDist;
    float g0=exp(-d2/(80.0*ps2));
    float g1=exp(-d2/(250.0*ps2));
    float g2=exp(-d2/(800.0*ps2));
    float g3=exp(-d2/(2500.0*ps2));
    float g4=exp(-d2/(8000.0*ps2));
    float g5=exp(-d2/(25000.0*ps2));
    float g6=exp(-d2/(80000.0*ps2));
    float g7=exp(-d2/(250000.0*ps2));
    float surfaceMod=h*h;
    vec3 revealLight=(
      vec3(0.85,1.0,0.88)*g0*1.8+
      vec3(0.60,0.98,0.70)*g1*1.2+
      vec3(0.38,0.94,0.52)*g2*0.85+
      vec3(0.22,0.88,0.40)*g3*0.60+
      vec3(0.12,0.75,0.32)*g4*0.40+
      vec3(0.06,0.55,0.22)*g5*0.25+
      vec3(0.03,0.38,0.14)*g6*0.15+
      vec3(0.01,0.22,0.08)*g7*0.08
    )*caustic*surfaceMod;
    float revealTransmit=1.0-fresnel;
    col+=vReveal*revealLight*REVEAL_MULT*revealTransmit;
    float revealEdgeProx=1.0-smoothstep(0.0,REVEAL_EDGE_PROX_PX,distFromEdge);
    float rimCaustic=abs(dh)*h*REVEAL_RIM_CAUSTIC_BOOST;
    float rimDist=exp(-d2/(REVEAL_RIM_SIGMA*ps2));
    col+=vReveal*REVEAL_RIM_COLOR*rimCaustic*rimDist*revealEdgeProx*REVEAL_MULT*revealTransmit;
  }
`
        },
        {
            name: 'ambient',
            wgsl: `
    // === Ambient surface life ===
    // Low-frequency breathing (~±7%, ~3.5s cycle) so the surface feels alive
    // instead of printed. Two decorrelated sines on panel-local space.
    let breathPos = localPos * BREATH_SPATIAL_SCALE;
    let breathTime = uniforms.time * BREATH_TIME_SCALE;
    let breath = sin(breathPos.x + breathPos.y + breathTime) * 0.5
               + sin(breathPos.x - breathPos.y * 0.7 + breathTime * 0.65 + 1.3) * 0.5;
    col *= 1.0 + breath * BREATH_AMOUNT;
    // Multi-layer caustic interference — light through thick glass.
    let st = screenPos * CAUSTIC_SPATIAL_SCALE;
    let t_s = uniforms.time * CAUSTIC_TIME_SCALE;
    let c1 = sin(dot(st, vec2f(1.0, 0.7)) + t_s);
    let c2 = sin(dot(st, vec2f(-0.8, 1.1)) + t_s * 1.3 + 2.1);
    let c3 = sin(dot(st, vec2f(0.6, -0.9)) * 1.8 + t_s * 0.7 + 4.3);
    let causticBright = max(c1 + c2 + c3 - CAUSTIC_THRESHOLD, 0.0);
    col += col * causticBright * CAUSTIC_INTENSITY;
    // Surface grain (Interleaved Gradient Noise).
    let grain = fract(IGN_HASH * fract(dot(screenPos, IGN_DOT)));
    col += col * (grain - 0.5) * GRAIN_INTENSITY;
`,
            glsl: `
  // === Ambient surface life ===
  vec2 breathPos=vLocalPos*BREATH_SPATIAL_SCALE;
  float breathTime=uTime*BREATH_TIME_SCALE;
  float breath=sin(breathPos.x+breathPos.y+breathTime)*0.5+sin(breathPos.x-breathPos.y*0.7+breathTime*0.65+1.3)*0.5;
  col*=1.0+breath*BREATH_AMOUNT;
  vec2 st=gl_FragCoord.xy*CAUSTIC_SPATIAL_SCALE;
  float t_s=uTime*CAUSTIC_TIME_SCALE;
  float c1=sin(dot(st,vec2(1.0,0.7))+t_s);
  float c2=sin(dot(st,vec2(-0.8,1.1))+t_s*1.3+2.1);
  float c3=sin(dot(st,vec2(0.6,-0.9))*1.8+t_s*0.7+4.3);
  float causticBright=max(c1+c2+c3-CAUSTIC_THRESHOLD,0.0);
  col+=col*causticBright*CAUSTIC_INTENSITY;
  float grain=fract(IGN_HASH*fract(dot(gl_FragCoord.xy,IGN_DOT)));
  col+=col*(grain-0.5)*GRAIN_INTENSITY;
`
        },
        {
            name: 'output',
            wgsl: `
    return vec4f(col, alpha * opacity);
`,
            glsl: `
  fragColor=vec4(col,alpha*vOpacity);
`
        }
    ];

    function buildGlassFSBody(lang) {
        var out = '';
        for (var i = 0; i < GLASS_STAGES.length; i++) {
            out += GLASS_STAGES[i][lang];
        }
        return out;
    }

    // Debug helper — call from DevTools to inspect the exact FS body string
    // the driver pastes into its template. Returns the body (also logs it,
    // so `__glassCore.dumpGlassFS('wgsl')` is one line in the console).
    // For the full compilable source you also need the driver's bindings +
    // helper fns (rboxSDF, surfaceHeight); this dumps only the function body.
    function dumpGlassFS(lang) {
        var body = buildGlassFSBody(lang || 'wgsl');
        if (typeof console !== 'undefined' && console.log) console.log(body);
        return body;
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
                    // Idle gate: the finalize below (canvas pre-blur + GPU texture
                    // upload) is main-thread work that otherwise lands mid-entrance-
                    // animation on first page view. The fetch/decode above already
                    // overlapped the animation; only the CPU tail waits for idle.
                    return new Promise(function (resolve) {
                        if (global.requestIdleCallback) {
                            global.requestIdleCallback(function () { resolve(img); }, { timeout: 600 });
                        } else {
                            setTimeout(function () { resolve(img); }, 200);
                        }
                    });
                })
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

    // ====================================================================
    // Cache-window selection — infinite scroll can put thousands of glass
    // candidates in the DOM (library rows, timeline events, achievement
    // cards), far past MAX_CACHED. Registering the first 512 in document
    // order means everything below ~page 9 silently loses glass. Instead,
    // when over budget, keep the MAX_CACHED candidates nearest the viewport
    // center; a per-frame staleness check (cacheWindowStale) re-caches when
    // the user scrolls toward the edge of the kept window.
    //
    // Under budget (every page at normal depth) this is a length check and
    // an early return — zero added cost. Over budget it costs one
    // getBoundingClientRect per candidate at cacheElements time only; the
    // per-frame draw path is untouched. Fixed/sticky chrome reads as
    // viewport-relative, so it always scores near the center and is kept.
    // ====================================================================
    var _winLimited = false;
    var _winCenter = 0;   // doc-space viewport center at selection time
    var _winRadius = 0;   // distance of the farthest kept candidate

    function selectCacheWindow(els, max) {
        if (els.length <= max) { _winLimited = false; return els; }
        var scrollY = global.scrollY || 0;
        var viewCenter = scrollY + (global.innerHeight || 0) / 2;
        var scored = new Array(els.length);
        for (var i = 0; i < els.length; i++) {
            var r = els[i].getBoundingClientRect();
            scored[i] = { i: i, el: els[i], d: Math.abs(scrollY + r.top + r.height / 2 - viewCenter) };
        }
        scored.sort(function (a, b) { return a.d - b.d; });
        var keep = scored.slice(0, max);
        _winLimited = true;
        _winCenter = viewCenter;
        _winRadius = keep[keep.length - 1].d;
        // Restore document order — downstream code assumes DOM-ish ordering
        // for things like first/last-row radius styling heuristics.
        keep.sort(function (a, b) { return a.i - b.i; });
        var out = new Array(keep.length);
        for (var k = 0; k < keep.length; k++) out[k] = keep[k].el;
        return out;
    }

    // True when the viewport center has drifted past half the kept window's
    // radius — time to re-center the registry. Hysteresis of radius/2 keeps
    // re-caches rare (a 512-row window spans ~14k px → one re-cache per ~7k
    // px of scroll, and appends re-cache anyway via the layout-dirty path).
    function cacheWindowStale(scrollY, viewportH) {
        if (!_winLimited) return false;
        return Math.abs(scrollY + viewportH / 2 - _winCenter) > _winRadius * 0.5;
    }

    global.__glassCore = {
        // Algorithm constants
        HALF_RES: HALF_RES,
        BLUR_MIP_MAX: BLUR_MIP_MAX,
        DENSE_RADIUS_PX: DENSE_RADIUS_PX,
        GAUSS: GAUSS,
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
        // Cache-window selection (infinite scroll)
        selectCacheWindow: selectCacheWindow,
        cacheWindowStale: cacheWindowStale,
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
        emitGlassConstsGLSL: emitGlassConstsGLSL,
        GLASS_STAGES: GLASS_STAGES,
        buildGlassFSBody: buildGlassFSBody,
        dumpGlassFS: dumpGlassFS
    };
})(window);
