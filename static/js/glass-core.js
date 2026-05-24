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
        // Geometry + optics (also exported as plain JS — see top of file).
        IOR:                          { type: 'float', value: IOR },
        THICKNESS:                    { type: 'float', value: THICKNESS },
        BEZEL:                        { type: 'float', value: BEZEL },
        SPECULAR:                     { type: 'float', value: SPECULAR },
        SHADOW_MARGIN:                { type: 'float', value: SHADOW_MARGIN },
        REVEAL_MULT:                  { type: 'float', value: REVEAL_MULT },

        EDGE_AA_PX:                   { type: 'float', value: 1.5 },
        THICKNESS_EDGE_BOOST:         { type: 'float', value: 0.4 },

        SHADOW_BASE_ALPHA:            { type: 'float', value: 0.22 },
        SHADOW_FALLOFF_SIGMA2:        { type: 'float', value: 18.0 },
        SHADOW_LUM_SCALE:             { type: 'float', value: 0.25 },
        SHADOW_CHROMA_SCALE:          { type: 'float', value: 0.9 },

        // Fresnel (Schlick) — F0 is dielectric base reflectance; F90 ≈ 1−F0.
        FRESNEL_F0:                   { type: 'float', value: 0.04 },

        // Chromatic aberration — R/B channel sample-offset multipliers.
        CA_R_SCALE:                   { type: 'float', value: 1.05 },
        CA_B_SCALE:                   { type: 'float', value: 0.95 },

        ABSORPTION:                   { type: 'float', value: 0.06 },
        ABSORPTION_TINT:              { type: 'vec3',  value: [0.96, 0.97, 1.0] },

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
    //     refraction   produces  displacement, cosR
    //     fresnel      produces  fresnel
    //     sdfGradient  produces  grad
    //     colorGrade   produces  col (mutated by rim/shadow/reveal/ambient)
    //   Reordering stages will break later ones — assume forward dependencies.
    //
    // IDENTIFIER CONVENTIONS
    //   WGSL: localPos, panelSize, blurUV, screenPos, radius, saturation,
    //         brightness, tintAlpha, opacity, reveal,
    //         uniforms.viewport, uniforms.mouse, uniforms.time
    //   GLSL: vLocalPos, vPanelSize, vBlurUV, vScreenPos, vRadius, vSaturation,
    //         vBrightness, vTintAlpha, vOpacity, vReveal,
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
    vec3 shadowBackdrop=texture(uBlurTex,vBlurUV).rgb;
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
    // === Snell refraction (algebraic) ===
    // tan(slope) = dh directly — no atan/asin/tan needed.
    let x_s = dh;
    let invSqrtX2p1 = inverseSqrt(1.0 + x_s * x_s);
    let sinI = x_s * invSqrtX2p1;
    var sinR = sinI / IOR;
    sinR = clamp(sinR, -1.0, 1.0);
    let cosR = sqrt(1.0 - sinR * sinR);
    let displacement = h * thicknessLocal * (x_s - sinR / max(cosR, 0.001));
`,
            glsl: `
  // === Snell refraction (algebraic) ===
  float x_s=dh;
  float invSqrtX2p1=inversesqrt(1.0+x_s*x_s);
  float sinI=x_s*invSqrtX2p1;
  float sinR=sinI/IOR;
  sinR=clamp(sinR,-1.0,1.0);
  float cosR=sqrt(1.0-sinR*sinR);
  float displacement=h*thicknessLocal*(x_s-sinR/max(cosR,0.001));
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
    let grad = normalize(vec2f(sd_dx - sd, sd_dy - sd));
`,
            glsl: `
  // === SDF gradient (finite differences) ===
  float sd_dx=rboxSDF(vLocalPos+vec2(0.5,0.0),vPanelSize,vRadius);
  float sd_dy=rboxSDF(vLocalPos+vec2(0.0,0.5),vPanelSize,vRadius);
  vec2 grad=normalize(vec2(sd_dx-sd,sd_dy-sd));
`
        },
        {
            name: 'backdropSample',
            wgsl: `
    // === Backdrop sampling with chromatic aberration ===
    // CA at ±5% — wide enough to read as wet-glass shimmer at the rim, narrow
    // enough that the SDF gradient's pixel-quantization doesn't expose colored
    // fringes on corners.
    let baseOffset = -grad * displacement / uniforms.viewport;
    let blurred = vec3f(
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset * CA_R_SCALE, 0.0).r,
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset, 0.0).g,
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset * CA_B_SCALE, 0.0).b
    );
`,
            glsl: `
  // === Backdrop sampling with chromatic aberration ===
  vec2 baseOffset=-grad*displacement/uViewport;
  vec3 blurred=vec3(
    texture(uBlurTex,vBlurUV+baseOffset*CA_R_SCALE).r,
    texture(uBlurTex,vBlurUV+baseOffset).g,
    texture(uBlurTex,vBlurUV+baseOffset*CA_B_SCALE).b
  );
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
    // Frosted glass haze (per-panel, independent of Fresnel).
    var col = mix(transmitted, vec3f(1.0), tintAlpha);
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
  vec3 col=mix(transmitted,vec3(1.0),vTintAlpha);
  float innerShadow=1.0-smoothstep(0.0,bezel*INNER_SHADOW_BEZEL_FRAC,distFromEdge);
  col*=mix(1.0,INNER_SHADOW_FLOOR,innerShadow*INNER_SHADOW_STRENGTH);
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
        emitGlassConstsGLSL: emitGlassConstsGLSL,
        GLASS_STAGES: GLASS_STAGES,
        buildGlassFSBody: buildGlassFSBody,
        dumpGlassFS: dumpGlassFS
    };
})(window);
