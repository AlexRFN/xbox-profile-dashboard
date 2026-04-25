/**
 * WebGPU Liquid Glass — single GPU pipeline for aurora + glass material.
 *
 * Architecture (identical to WebGL2 version, different API):
 *   Pass 1: Aurora → RT_AURORA (half-res)
 *   Pass 2: Kawase Blur → RT_BLUR (half-res, ping-pong, 2 passes)
 *   Pass 3: Composite → Screen (full viewport)
 *            - Full-screen quad draws aurora from RT_AURORA
 *            - Glass panel quads: complete glass material (blur + saturate + tint + specular)
 *
 * Falls back to glass.js (WebGL2) if WebGPU is unavailable.
 */
(function () {
    'use strict';

    // ====================================================================
    // WebGPU init — synchronous capability check, then async setup
    // ====================================================================
    var canvas = document.getElementById('aurora-canvas');
    if (!canvas) return;

    // Skip if WebGL2 version already claimed the canvas
    if (document.documentElement.classList.contains('glass-refract')) return;

    function loadWebGL2Fallback() {
        window.__webgpuPending = false;
        var s = document.createElement('script');
        s.src = canvas.getAttribute('data-fallback-src') || '/static/js/glass.js';
        document.body.appendChild(s);
    }

    if (!navigator.gpu) { loadWebGL2Fallback(); return; } // No WebGPU — load WebGL2 fallback

    // Synchronously signal WebGPU intent — prevents a race if glass.js were also loaded
    window.__webgpuPending = true;

    (async function init() {


    var adapter, device, ctx;
    try {
        adapter = await navigator.gpu.requestAdapter();
        if (!adapter) { loadWebGL2Fallback(); return; }
        device = await adapter.requestDevice();
        if (!device) { loadWebGL2Fallback(); return; }
        ctx = canvas.getContext('webgpu');
        if (!ctx) { loadWebGL2Fallback(); return; }
    } catch (e) {
        console.warn('Glass: WebGPU init failed, falling back to WebGL2', e);
        loadWebGL2Fallback();
        return;
    }

    // HDR: rgba16float + extended tone mapping so values >1.0 reach high nits.
    // scRGB ref white = 1.0 = 80 nits; 10.0 = 800 nits.
    // SDR: fall back to preferred format + standard tone mapping.
    var _isHDR = window.matchMedia('(dynamic-range: high)').matches;
    var presentFormat = _isHDR ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device: device,
        format: presentFormat,
        alphaMode: 'opaque',
        toneMapping: { mode: _isHDR ? 'extended' : 'standard' }
    });

    document.documentElement.classList.add('glass-refract');


    // ====================================================================
    // Constants
    // ====================================================================
    var PI = Math.PI, TAU = PI * 2;
    var HALF_RES = 4;          // quarter-res aurora + blur (smooth gradient upscales cleanly)
    var BLUR_PASSES = 2;
    var MAX_PANELS = 128;
    var MAX_CACHED = 512;
    var IOR = 1.52;
    var THICKNESS = 85.0;
    var BEZEL = 60.0;
    var SPECULAR = 0.50;
    var SHADOW_MARGIN = 6.0;
    // HDR: 800 nits / 80 nits ref white = 10.0; peak revealAlpha = 2.6 → 10.0/2.6 ≈ 3.85
    // SDR: clamps at 1.0 anyway, keep original 2.5
    var REVEAL_MULT = _isHDR ? 3.85 : 2.5;

    // ====================================================================
    // WGSL Shaders
    // ====================================================================

    // -- Fullscreen quad vertex (shared by aurora, blit, blur) --
    var QUAD_VS_WGSL = /* wgsl */`
struct VSOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOutput {
    // Triangle strip: 0=(-1,-1), 1=(1,-1), 2=(-1,1), 3=(1,1)
    let x = f32((vi & 1u)) * 2.0 - 1.0;
    let y = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
    var out: VSOutput;
    out.position = vec4f(x, y, 0.0, 1.0);
    // UV: x maps normally (0→1), y is flipped because WebGPU viewport Y=0 is top
    // but clip Y=-1 is bottom. UV(0,0) = top-left of texture = viewport top = clip Y=+1.
    out.uv = vec2f(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    return out;
}
`;

    // -- Aurora fragment --
    var AURORA_FS_WGSL = /* wgsl */`
struct AuroraUniforms {
    nodes: array<vec4f, 5>,   // xy = position, zw = unused
    colors: array<vec4f, 5>,  // rgb = linear color, w = k falloff
};

@group(0) @binding(0) var<uniform> u: AuroraUniforms;

fn s2l(c: f32) -> f32 {
    if (c <= 0.04045) { return c / 12.92; }
    return pow((c + 0.055) / 1.055, 2.4);
}

fn l2s(c: f32) -> f32 {
    if (c <= 0.0031308) { return c * 12.92; }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let BASE_W: f32 = 0.16;
    var wSum: f32 = BASE_W;
    let bgL = vec3f(0.0, s2l(1.0 / 255.0), 0.0);
    var acc = bgL * BASE_W;
    var bloom = vec3f(0.0);

    for (var i = 0u; i < 5u; i++) {
        let nodePos = u.nodes[i].xy;
        let nodeColor = u.colors[i].rgb;
        let k = u.colors[i].w;
        let d = uv - nodePos;
        let d2 = dot(d, d);
        let w = exp(-d2 * k);
        wSum += w;
        acc += nodeColor * w;
        bloom += nodeColor * w * 0.01;
    }

    let m = acc / wSum;
    var col = vec3f(l2s(m.r), l2s(m.g), l2s(m.b)) + bloom;
    let inf = clamp(wSum - BASE_W, 0.0, 1.0);
    let cv = uv - 0.5;
    let dd = length(cv) * 1.28;
    let vig = max(1.0 - pow(min(dd, 1.0), 1.6), 0.24);
    col *= vig * (0.12 + 0.88 * inf) * 0.94;

    return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

    // -- Blit fragment (with dithering) --
    var BLIT_FS_WGSL = /* wgsl */`
@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

fn ign(p: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@fragment fn fs(@builtin(position) fragCoord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
    var col = textureSampleLevel(tex, texSampler, uv, 0.0).rgb;
    let n = ign(fragCoord.xy);
    col += (n - 0.5) / 255.0;
    return vec4f(col, 1.0);
}
`;

    // -- Kawase blur fragment --
    var BLUR_FS_WGSL = /* wgsl */`
struct BlurUniforms {
    texelSize: vec2f,
    offset: f32,
    _pad: f32,
};

@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: BlurUniforms;

@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let o = (params.offset + 0.5) * params.texelSize;
    return 0.25 * (
        textureSampleLevel(tex, texSampler, uv + vec2f(-o.x, -o.y), 0.0) +
        textureSampleLevel(tex, texSampler, uv + vec2f(-o.x,  o.y), 0.0) +
        textureSampleLevel(tex, texSampler, uv + vec2f( o.x, -o.y), 0.0) +
        textureSampleLevel(tex, texSampler, uv + vec2f( o.x,  o.y), 0.0)
    );
}
`;

    // -- Glass vertex (instanced panels) --
    var GLASS_VS_WGSL = /* wgsl */`
struct GlassUniforms {
    viewport: vec2f,
    mouse: vec2f,
    time: f32,
    _pad: f32,
};

struct PanelData {
    rect: vec4f,        // x, y, w, h
    extra: vec4f,       // radius, saturation, brightness, tintAlpha
    opacReveal: vec2f,  // opacity, reveal
    _pad: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: GlassUniforms;
@group(0) @binding(1) var<storage, read> panels: array<PanelData>;

struct VSOutput {
    @builtin(position) position: vec4f,
    @location(0) localPos: vec2f,
    @location(1) panelSize: vec2f,
    @location(2) blurUV: vec2f,
    @location(3) screenPos: vec2f,
    @location(4) radius: f32,
    @location(5) saturation: f32,
    @location(6) brightness: f32,
    @location(7) tintAlpha: f32,
    @location(8) opacity: f32,
    @location(9) reveal: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOutput {
    let x = f32((vi & 1u)) * 2.0 - 1.0;
    let y = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
    let aPos = vec2f(x, y);

    let panel = panels[ii];
    let hs = panel.rect.zw * 0.5;
    let ctr = panel.rect.xy + hs;
    let hsExpanded = hs + ${SHADOW_MARGIN.toFixed(1)};
    let pos = ctr + aPos * hsExpanded;

    var out: VSOutput;
    out.localPos = aPos * hsExpanded;
    out.panelSize = hs;
    out.screenPos = pos;
    out.radius = panel.extra.x;
    out.saturation = panel.extra.y;
    out.brightness = panel.extra.z;
    out.tintAlpha = panel.extra.w;
    out.opacity = panel.opacReveal.x;
    out.reveal = panel.opacReveal.y;
    // UV into blur texture: viewport-relative (WebGPU: no Y-flip needed,
    // texture UV(0,0) = top-left = viewport Y=0)
    out.blurUV = vec2f(pos.x / uniforms.viewport.x, pos.y / uniforms.viewport.y);
    // To NDC
    var ndc = (pos / uniforms.viewport) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    out.position = vec4f(ndc, 0.0, 1.0);
    return out;
}
`;

    // -- Glass fragment (GlassUniforms + PanelData structs defined in VS above) --
    var GLASS_FS_WGSL = /* wgsl */`
// GlassUniforms struct is defined in the vertex shader (same module)
@group(0) @binding(2) var blurSampler: sampler;
@group(0) @binding(3) var blurTex: texture_2d<f32>;

fn rboxSDF(p: vec2f, b: vec2f, r: f32) -> f32 {
    let q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

fn surfaceHeight(t: f32) -> f32 {
    let s = 1.0 - t;
    return sqrt(sqrt(1.0 - s * s * s * s));
}

@fragment fn fs(
    @location(0) localPos: vec2f,
    @location(1) panelSize: vec2f,
    @location(2) blurUV: vec2f,
    @location(3) screenPos: vec2f,
    @location(4) radius: f32,
    @location(5) saturation: f32,
    @location(6) brightness: f32,
    @location(7) tintAlpha: f32,
    @location(8) opacity: f32,
    @location(9) reveal: f32,
) -> @location(0) vec4f {
    let sd = rboxSDF(localPos, panelSize, radius);

    // Drop shadow outside glass
    if (sd > 0.0) {
        if (sd > ${SHADOW_MARGIN.toFixed(1)}) { discard; }
        let shadowFalloff = exp(-sd * sd / 18.0);
        let shadowAlpha = 0.08 * shadowFalloff;
        return vec4f(0.0, 0.0, 0.0, shadowAlpha * opacity);
    }

    // Edge alpha — 1.5px soft ramp
    let distFromEdge = -sd;
    let alpha = smoothstep(0.0, 1.5, distFromEdge);

    // Bezel zone
    let bezel = min(${BEZEL.toFixed(1)}, min(radius, min(panelSize.x, panelSize.y)) - 1.0);
    let t = clamp(distFromEdge / bezel, 0.0, 1.0);

    // Surface height + numerical derivative
    let h = surfaceHeight(t);
    let dt: f32 = 0.001;
    let h2 = surfaceHeight(min(t + dt, 1.0));
    let dh = (h2 - h) / dt;

    // Depth-varying thickness (thicker at edges → stronger refraction in bezel zone)
    let thicknessLocal = ${THICKNESS.toFixed(1)} * (1.0 + (1.0 - h * h) * 0.4);

    // Snell's law refraction (algebraic — eliminates atan, sin, asin, 2×tan)
    let x_s = dh * (thicknessLocal / bezel);
    let invSqrtX2p1 = inverseSqrt(1.0 + x_s * x_s);
    let sinI = x_s * invSqrtX2p1;
    var sinR = sinI / ${IOR.toFixed(1)};
    sinR = clamp(sinR, -1.0, 1.0);
    let cosR = sqrt(1.0 - sinR * sinR);
    let displacement = h * thicknessLocal * (x_s - sinR / max(cosR, 0.001));

    // Fresnel (Schlick's approximation — edge reflectivity vs center transparency)
    let cosTheta = invSqrtX2p1;
    let omc = 1.0 - cosTheta;
    let omc2 = omc * omc;
    let fresnel = 0.04 + 0.96 * omc2 * omc2 * omc;

    // Analytical SDF gradient (eliminates 2 rboxSDF calls per fragment)
    let q_g = abs(localPos) - panelSize + radius;
    var grad: vec2f;
    if (q_g.x > 0.0 && q_g.y > 0.0) {
        grad = sign(localPos) * normalize(q_g);
    } else if (q_g.x > q_g.y) {
        grad = vec2f(sign(localPos.x), 0.0);
    } else {
        grad = vec2f(0.0, sign(localPos.y));
    }

    // Refraction displacement with per-channel chromatic aberration
    let baseOffset = -grad * displacement / uniforms.viewport;
    let blurred = vec3f(
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset * 1.006, 0.0).r,
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset, 0.0).g,
        textureSampleLevel(blurTex, blurSampler, blurUV + baseOffset * 0.998, 0.0).b
    );

    // Saturation boost
    let lum = dot(blurred, vec3f(0.2126, 0.7152, 0.0722));
    let saturated = mix(vec3f(lum), blurred, saturation);

    // Brightness multiply
    var transmitted = saturated * brightness;

    let rimFalloff = 1.0 - smoothstep(0.0, bezel * 0.4, distFromEdge);

    // Energy conservation: transmitted light reduces as Fresnel reflection increases
    transmitted *= (1.0 - fresnel);

    // Beer's law absorption — applied after Fresnel (only absorbed light is transmitted light)
    let absorption = (1.0 - h) * 0.06;
    transmitted *= mix(vec3f(1.0), vec3f(0.96, 0.97, 1.0), absorption);

    // Frosted glass scattering (tintAlpha is per-panel haze, independent of Fresnel)
    var col = mix(transmitted, vec3f(1.0), tintAlpha);

    // Inner shadow — applied before specular so it only darkens transmitted light
    let innerShadow = 1.0 - smoothstep(0.0, bezel * 0.6, distFromEdge);
    col *= mix(1.0, 0.7, innerShadow * 0.3);

    // Anisotropic specular — highlights stretch along edge tangent direction
    let rimDot = abs(dot(grad, vec2f(0.5812, -0.8137)));
    let tangent = vec2f(-grad.y, grad.x);
    let tangentDot = abs(dot(tangent, vec2f(0.5812, -0.8137)));
    let aniso = mix(rimDot, tangentDot, 0.15);
    let rimBase = aniso * rimFalloff;
    let specHighlight = rimBase * sqrt(rimBase);
    col += vec3f(specHighlight * ${SPECULAR.toFixed(2)} * (0.3 + 0.7 * fresnel));

    // Inner rim
    let innerRim = smoothstep(0.0, 2.0, distFromEdge) * (1.0 - smoothstep(2.0, 5.0, distFromEdge));
    col += vec3f(innerRim * 0.15 * ${SPECULAR.toFixed(2)});

    // Fake environment reflection — subtle sky gradient modulated by Fresnel
    let envUp = grad.y * -0.5 + 0.5;
    let envColor = mix(vec3f(0.6, 0.65, 0.75), vec3f(0.85, 0.9, 1.0), envUp);
    col += envColor * fresnel * 0.03;

    // Pointer reveal — early exit when no reveal active (saves 9 exp() on ~70% of fragments)
    if (reveal > 0.001) {
        let panelCenter = screenPos - localPos;
        let mouseLocal = uniforms.mouse - panelCenter;
        let refractedPos = localPos - grad * displacement * 0.18;
        let fragDist = length(refractedPos - mouseLocal);

        let panelDiag = length(panelSize);
        let ps = max(panelDiag / 280.0, 0.25);
        let ps2 = ps * ps;

        let caustic = 1.0 + abs(dh) * h * 1.5;

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

        // Reveal light transmits through glass — attenuate by Fresnel exit
        let revealTransmit = 1.0 - fresnel;
        col += reveal * revealLight * ${REVEAL_MULT.toFixed(2)} * revealTransmit;

        let edgeProx = 1.0 - smoothstep(0.0, 4.0, distFromEdge);
        let rimCaustic = abs(dh) * h * 2.0;
        let rimDist = exp(-d2 / (2000.0 * ps2));
        col += reveal * vec3f(0.2, 0.9, 0.45) * rimCaustic * rimDist * edgeProx * ${REVEAL_MULT.toFixed(2)} * revealTransmit;
    }

    // Ambient caustic shimmer — multi-layer interference like light through thick glass
    let st = screenPos * 0.005;
    let t_s = uniforms.time * 0.35;
    let c1 = sin(dot(st, vec2f(1.0, 0.7)) + t_s);
    let c2 = sin(dot(st, vec2f(-0.8, 1.1)) + t_s * 1.3 + 2.1);
    let c3 = sin(dot(st, vec2f(0.6, -0.9)) * 1.8 + t_s * 0.7 + 4.3);
    let causticRaw = c1 + c2 + c3;
    let causticBright = max(causticRaw - 0.8, 0.0);
    col += col * causticBright * 0.04;

    // Surface grain (Interleaved Gradient Noise — better quality than sin-hash)
    let grain = fract(52.9829189 * fract(dot(screenPos, vec2f(0.06711056, 0.00583715))));
    col += col * (grain - 0.5) * 0.04;

    return vec4f(col, alpha * opacity);
}
`;

    // ====================================================================
    // Pipeline creation helpers
    // ====================================================================
    function createFullscreenPipelineAsync(label, fsCode, bindGroupLayout, targetFormat, blend) {
        var module = device.createShaderModule({
            label: label,
            code: QUAD_VS_WGSL + '\n' + fsCode
        });
        var desc = {
            label: label,
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module: module, entryPoint: 'vs' },
            fragment: {
                module: module,
                entryPoint: 'fs',
                targets: [{ format: targetFormat }]
            },
            primitive: { topology: 'triangle-strip' }
        };
        if (blend) {
            desc.fragment.targets[0].blend = blend;
        }
        return device.createRenderPipelineAsync(desc);
    }

    // ====================================================================
    // Bind group layouts
    // ====================================================================

    // Aurora: uniform buffer
    var auroraLayout = device.createBindGroupLayout({
        label: 'aurora',
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
        ]
    });

    // Blit + Blur: sampler + texture (+ optional uniform for blur)
    var blitLayout = device.createBindGroupLayout({
        label: 'blit',
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        ]
    });

    var blurLayout = device.createBindGroupLayout({
        label: 'blur',
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
        ]
    });

    // Glass: uniform + storage + sampler + texture
    var glassLayout = device.createBindGroupLayout({
        label: 'glass',
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        ]
    });

    // ====================================================================
    // Pipelines
    // ====================================================================
    var halfResFormat = 'rgba8unorm';

    // Shader modules are cheap to create synchronously; pipeline compilation is the
    // expensive GPU JIT step — kick all four off in parallel via createRenderPipelineAsync
    // so the JS thread is never blocked waiting for the driver to compile shaders.
    var glassModule = device.createShaderModule({
        label: 'glass',
        code: GLASS_VS_WGSL + '\n' + GLASS_FS_WGSL
    });

    // Declared here, assigned inside Promise.all below.
    var auroraPipeline, blitPipeline, blurPipeline, glassPipeline;

    // ====================================================================
    // Shared sampler
    // ====================================================================
    var linearSampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
    });

    // ====================================================================
    // Uniform buffers
    // ====================================================================
    // Aurora uniforms: 5 * vec4 (nodes xy + pad) + 5 * vec4 (color rgb + k) = 160 bytes
    var auroraUniformBuf = device.createBuffer({
        label: 'aurora uniforms',
        size: 160,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var auroraUniformData = new Float32Array(40); // 10 vec4s

    // Blur uniforms: vec2 texelSize + f32 offset + f32 pad = 16 bytes
    // Two buffers — one per blur pass — so both are correct when GPU executes the command buffer
    var blurUniformBufs = [
        device.createBuffer({ label: 'blur uniforms 0', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        device.createBuffer({ label: 'blur uniforms 1', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    ];
    var blurUniformData = new Float32Array(4);

    // Glass uniforms: vec2 viewport + vec2 mouse + f32 time + f32 pad = 24 bytes (round to 32)
    var glassUniformBuf = device.createBuffer({
        label: 'glass uniforms',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var glassUniformData = new Float32Array(8);

    // Panel storage buffer: each panel = rect(4) + extra(4) + opacReveal(2) + pad(2) = 12 floats = 48 bytes
    var PANEL_STRIDE = 12; // floats per panel
    var panelStorageBuf = device.createBuffer({
        label: 'panel storage',
        size: MAX_PANELS * PANEL_STRIDE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    var panelStorageData = new Float32Array(MAX_PANELS * PANEL_STRIDE);

    // ====================================================================
    // Render targets (half-res)
    // ====================================================================
    var vpW = 0, vpH = 0, halfW = 0, halfH = 0;
    var texAurora = null, viewAurora = null;
    var texBlur = [null, null], viewBlur = [null, null];
    var auroraBindGroup = null;
    var blitBindGroup = null;
    var blurBindGroups = [null, null]; // [pass0: aurora→blur0, pass1: blur0→blur1]
    var glassBindGroup = null; // cached — only recreated on resize

    function createRT(w, h) {
        var tex = device.createTexture({
            size: [w, h],
            format: halfResFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        return tex;
    }

    // Track canvas size via ResizeObserver to avoid forced reflow every frame
    var _pendingW = 0, _pendingH = 0, _resizePending = false;
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function (entries) {
            var cr = entries[0].contentRect;
            var rw = Math.round(cr.width);
            var rh = Math.round(cr.height);
            if (rw !== vpW || rh !== vpH) {
                _pendingW = rw; _pendingH = rh; _resizePending = true;
            }
        }).observe(canvas);
    }

    function resizeTargets() {
        // Use cached ResizeObserver values to avoid forced reflow from clientWidth/clientHeight
        var newW, newH;
        if (_resizePending) {
            newW = _pendingW; newH = _pendingH; _resizePending = false;
        } else if (vpW === 0) {
            // First call — no observer data yet, must read DOM
            newW = canvas.clientWidth; newH = canvas.clientHeight;
        } else {
            return; // No resize detected
        }
        if (newW === vpW && newH === vpH) return;
        vpW = newW; vpH = newH;

        canvas.width = vpW;
        canvas.height = vpH;

        halfW = Math.max(Math.round(vpW / HALF_RES), 1);
        halfH = Math.max(Math.round(vpH / HALF_RES), 1);

        // Force aurora pass on the next render — new textures are empty/black and the
        // blit would show a blank frame if the render happens to be a non-aurora frame.
        _auroraFrame = 0;

        // Destroy old textures
        if (texAurora) texAurora.destroy();
        if (texBlur[0]) texBlur[0].destroy();
        if (texBlur[1]) texBlur[1].destroy();

        // Create new render targets
        texAurora = createRT(halfW, halfH);
        viewAurora = texAurora.createView();
        for (var j = 0; j < 2; j++) {
            texBlur[j] = createRT(halfW, halfH);
            viewBlur[j] = texBlur[j].createView();
        }

        // Rebuild bind groups that reference these textures
        auroraBindGroup = device.createBindGroup({
            layout: auroraLayout,
            entries: [{ binding: 0, resource: { buffer: auroraUniformBuf } }]
        });

        blitBindGroup = device.createBindGroup({
            layout: blitLayout,
            entries: [
                { binding: 0, resource: linearSampler },
                { binding: 1, resource: viewAurora }
            ]
        });

        // Blur bind groups: pass 0 reads aurora, pass 1 reads blur[0]
        // Each uses its own uniform buffer so offset values are correct at GPU execution time
        blurBindGroups[0] = device.createBindGroup({
            layout: blurLayout,
            entries: [
                { binding: 0, resource: linearSampler },
                { binding: 1, resource: viewAurora },
                { binding: 2, resource: { buffer: blurUniformBufs[0] } }
            ]
        });
        blurBindGroups[1] = device.createBindGroup({
            layout: blurLayout,
            entries: [
                { binding: 0, resource: linearSampler },
                { binding: 1, resource: viewBlur[0] },
                { binding: 2, resource: { buffer: blurUniformBufs[1] } }
            ]
        });

        // Glass bind group references blur texture view
        var lastBlur = (BLUR_PASSES - 1) % 2;
        glassBindGroup = device.createBindGroup({
            layout: glassLayout,
            entries: [
                { binding: 0, resource: { buffer: glassUniformBuf } },
                { binding: 1, resource: { buffer: panelStorageBuf } },
                { binding: 2, resource: linearSampler },
                { binding: 3, resource: viewBlur[lastBlur] }
            ]
        });
    }

    // ====================================================================
    // Node physics (identical to WebGL2 version)
    // ====================================================================
    function srgbToLinear(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    var nodes = [
        { r: 0,   g: 200, b: 70,  ax: 0.15, ay: 0.20 },
        { r: 0,   g: 180, b: 220, ax: 0.75, ay: 0.30 },
        { r: 130, g: 20,  b: 210, ax: 0.85, ay: 0.80 },
        { r: 20,  g: 160, b: 80,  ax: 0.10, ay: 0.85 },
        { r: 200, g: 120, b: 0,   ax: 0.50, ay: 0.55 }
    ];

    var SOFT_MIN = -0.08, SOFT_MAX = 1.08;
    var SPRING = 0.055, DAMPING = 0.885, MAX_SPEED = 0.008;

    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('aurora')); } catch (e) {}

    nodes.forEach(function (n, idx) {
        n.x = n.ax; n.y = n.ay;
        n.phaseX = Math.random() * TAU;
        n.phaseY = Math.random() * TAU;
        n.freqX = 0.24 + idx * 0.030 + Math.random() * 0.06;
        n.freqY = 0.22 + idx * 0.026 + Math.random() * 0.06;
        n.ampX = 0.13 + Math.random() * 0.10;
        n.ampY = 0.11 + Math.random() * 0.09;
        n.k = 24 + Math.random() * 16;
        n.lr = srgbToLinear(n.r / 255);
        n.lg = srgbToLinear(n.g / 255);
        n.lb = srgbToLinear(n.b / 255);
        if (saved && saved.length === nodes.length) {
            if (Number.isFinite(saved[idx].x)) n.x = saved[idx].x;
            if (Number.isFinite(saved[idx].y)) n.y = saved[idx].y;
            n.vx = Number.isFinite(saved[idx].vx) ? saved[idx].vx : 0;
            n.vy = Number.isFinite(saved[idx].vy) ? saved[idx].vy : 0;
        } else {
            var spd = 0.003 + Math.random() * 0.002;
            var ang = Math.random() * TAU;
            n.vx = Math.cos(ang) * spd;
            n.vy = Math.sin(ang) * spd;
        }
        n.x = Math.max(SOFT_MIN, Math.min(SOFT_MAX, n.x));
        n.y = Math.max(SOFT_MIN, Math.min(SOFT_MAX, n.y));
    });

    function updatePhysics(ts) {
        var dtRatio = _frameDt * 60;
        var dampingDt = Math.pow(DAMPING, dtRatio);
        var maxSpd = MAX_SPEED * dtRatio;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var tx = n.ax + Math.sin((ts * n.freqX * TAU) + n.phaseX) * n.ampX;
            var ty = n.ay + Math.cos((ts * n.freqY * TAU) + n.phaseY) * n.ampY;
            n.vx += (tx - n.x) * SPRING * dtRatio;
            n.vy += (ty - n.y) * SPRING * dtRatio;
            n.vx *= dampingDt; n.vy *= dampingDt;
            var s = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (s > maxSpd) { n.vx = (n.vx / s) * maxSpd; n.vy = (n.vy / s) * maxSpd; }
            n.x += n.vx * dtRatio; n.y += n.vy * dtRatio;
            if (n.x < SOFT_MIN) { n.x = SOFT_MIN; n.vx = Math.abs(n.vx) * 0.55; }
            if (n.x > SOFT_MAX) { n.x = SOFT_MAX; n.vx = -Math.abs(n.vx) * 0.55; }
            if (n.y < SOFT_MIN) { n.y = SOFT_MIN; n.vy = Math.abs(n.vy) * 0.55; }
            if (n.y > SOFT_MAX) { n.y = SOFT_MAX; n.vy = -Math.abs(n.vy) * 0.55; }
        }
    }

    // ====================================================================
    // Theme-aware tier system (identical to WebGL2 version)
    // ====================================================================
    var TIER_NAME_MAP = {
        'article': 'surface', '.friend-card': 'surface', '.stat-card': 'surface',
        '.timeline-event-card': 'surface', '.ach-grid-card': 'surface', '.ach-card': 'surface',
        '.showcase-card': 'surface', '.near-completion-row': 'surface', '.lib-grid-card': 'surface',
        '.grid-rows .game-row': 'nested', '.grid-rows .recent-row': 'nested',
        '.captures-game-header': 'surface',
        '.sidebar-widget': 'chrome',
        '.cmd-panel': 'overlay', '.shortcuts-panel': 'overlay', '.captures-select-bar': 'overlay', '.calendar-dropdown': 'overlay',
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
        // Canvas no longer dimmed by .aurora opacity — values tuned for direct output.
        // Hierarchy: surface (recessive) < nested < chrome (persistent) < overlay (floating) < button (interactive)
        dark: {
            surface: {sat:1.80, bright:0.78, tint:0.04},  // subtle — content panels recede
            nested:  {sat:2.20, bright:0.88, tint:0.07},  // slightly lifted from parent surface
            control: {sat:1.90, bright:0.85, tint:0.05},  // form inputs — subtle lift, readable
            chrome:  {sat:2.00, bright:0.92, tint:0.06},  // persistent UI, always readable
            overlay: {sat:2.40, bright:0.96, tint:0.08},  // floating — draws the eye
            button:  {sat:2.60, bright:1.00, tint:0.07}   // interactive — highest prominence
        }
    };

    var _hasP3 = window.matchMedia('(color-gamut: p3)').matches;
    var SRGB_SAT_CAP = { button: 3.50, overlay: 3.10, chrome: 2.80, control: 2.60, nested: 3.20, surface: 2.40 };
    var _reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
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

    var _themeObserver = new MutationObserver(function () {
        detectTheme();
        _layoutDirty = true;
    });
    _themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme']
    });

    // ====================================================================
    // Mouse tracking
    // ====================================================================
    var _mouseX = -9999, _mouseY = -9999;
    document.addEventListener('mousemove', function (e) {
        _mouseX = e.clientX;
        _mouseY = e.clientY;
    }, { passive: true });
    document.addEventListener('mouseleave', function () {
        _mouseX = -9999;
        _mouseY = -9999;
    });


    // ====================================================================
    // Panel position tracking (identical to WebGL2 version)
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
        '.captures-select-bar', '.calendar-dropdown'
    ].join(',');

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
        '.filters-inline button', '.cal-nav', '.quick-nav-pill',
        '.captures-select-bar'
    ].join(',');

    var _isMobile = false;
    var _cachedEls = [];
    var _cachedRadius = new Float32Array(MAX_CACHED);
    var _cachedTierValues = [];
    var _cachedHasAnim = new Uint8Array(MAX_CACHED);
    var _cachedAnimIn = new Uint8Array(MAX_CACHED);
    var _cachedInMain = new Uint8Array(MAX_CACHED);
    var _cachedAnimAncestor = [];
    var _fullyOpaque = new Uint8Array(MAX_CACHED);
    var _cachedReveal = new Uint8Array(MAX_CACHED);
    var _revealAnim = new Float32Array(MAX_CACHED);   // smooth 0→1 reveal intensity per panel
    var _cachedZIndex = new Float32Array(MAX_CACHED);
    var _cachedSticky = new Uint8Array(MAX_CACHED);   // 1 = sticky, re-read rect on scroll
    var _cachedFixed  = new Uint8Array(MAX_CACHED);   // 1 = fixed, viewport rect is scroll-invariant
    var _mainEl = null;
    var _layoutDirty = true;
    var _anyAnimating = false; // true while any panel is mid-entrance or reveal-fading
    var panelCount = 0;

    // Rect cache: avoid getBoundingClientRect on every frame during scroll-only updates.
    // Normal-flow + sticky panels store doc-relative top (top += scrollY); fixed panels
    // store viewport top because their visual position does not track scroll.
    var _rectDocTop = new Float32Array(MAX_CACHED);
    var _rectLeft   = new Float32Array(MAX_CACHED);
    var _rectWidth  = new Float32Array(MAX_CACHED);
    var _rectHeight = new Float32Array(MAX_CACHED);
    var _rectScrollY = 0;
    var _rectValid = false;
    // Per-panel freshness: 1 means this panel's rect was read by our own
    // getBoundingClientRect() call (time-consistent with the frame's scrollY).
    // 0 means "never read" or "invalidated" — forces a fresh read before first render,
    // preventing the spawn-snap where a new panel renders one frame at stale/zero coords.
    var _rectFresh = new Uint8Array(MAX_CACHED);

    // Viewport culling: IntersectionObserver marks panels that are offscreen so
    // collectPanels can skip their per-frame getBoundingClientRect entirely.
    // Sticky/fixed panels bypass this check (they always stay visible).
    var _inViewport = new Uint8Array(MAX_CACHED);
    // Per-panel keyframe-animation flag. Set when @keyframes runs on the panel
    // (or on an ancestor that wraps it). Forces per-frame rect re-read ONLY for
    // panels whose visual position is actually moving.
    var _animActive = new Uint8Array(MAX_CACHED);
    var _elIndex = new Map(); // element → current index in _cachedEls
    var _ancestorToIdx = new Map(); // ancestor el → Array<idx> of panels nested under it
    function _markAnim(target, val) {
        var idx = _elIndex.get(target);
        if (idx !== undefined) {
            _animActive[idx] = val;
            if (val) { _fullyOpaque[idx] = 0; _anyAnimating = true; }
            else _fullyOpaque[idx] = 1;
            return;
        }
        var arr = _ancestorToIdx.get(target);
        if (arr) {
            for (var ai = 0; ai < arr.length; ai++) {
                _animActive[arr[ai]] = val;
                if (val) _fullyOpaque[arr[ai]] = 0;
                else _fullyOpaque[arr[ai]] = 1;
            }
            if (val) _anyAnimating = true;
            return;
        }
        // Fallback: target is an unregistered ancestor (e.g. <main> running
        // tab-switch keyframes). Walk cached panels and mark any that are
        // descendants. Covers SPA navigation, reflow-inducing ancestor anims,
        // and any wrapper not tracked in _ancestorToIdx.
        if (!target || typeof target.contains !== 'function') return;
        for (var i = 0; i < _cachedEls.length; i++) {
            if (target.contains(_cachedEls[i])) {
                _animActive[i] = val;
                if (val) { _fullyOpaque[i] = 0; _rectFresh[i] = 0; }
                else _fullyOpaque[i] = 1;
            }
        }
        if (val) _anyAnimating = true;
    }
    function _onTransitionStart(e) {
        if (e.propertyName && e.propertyName !== 'opacity') return;
        var idx = _elIndex.get(e.target);
        if (idx === undefined) return;
        _fullyOpaque[idx] = 0;
        _anyAnimating = true;
    }
    function _onAnimStart(e) { _markAnim(e.target, 1); }
    function _onAnimEnd(e) { _markAnim(e.target, 0); }
    if (typeof document !== 'undefined') {
        // transitionend/transitioncancel are not observed — collectPanels lazily
        // detects the fully-opaque state from getComputedStyle on the trailing
        // frame and sets _fullyOpaque[i], so a listener here adds no signal.
        document.addEventListener('transitionrun', _onTransitionStart, true);
        document.addEventListener('transitionstart', _onTransitionStart, true);
        document.addEventListener('animationstart', _onAnimStart, true);
        document.addEventListener('animationend', _onAnimEnd, true);
        document.addEventListener('animationcancel', _onAnimEnd, true);
    }
    var _glassIO = (typeof IntersectionObserver !== 'undefined')
        ? new IntersectionObserver(function (entries) {
            for (var e = 0; e < entries.length; e++) {
                var entry = entries[e];
                var i = _elIndex.get(entry.target);
                if (i === undefined) continue;
                _inViewport[i] = entry.isIntersecting ? 1 : 0;
                // Do NOT prime from entry.boundingClientRect: that rect is captured when
                // the intersection state changed (past), while window.scrollY is "now" —
                // combining them yields a time-desynced doc-relative top. collectPanels
                // will read a fresh rect via _rectFresh[i] = 0 on first eligible frame.
                if (!entry.isIntersecting) _rectFresh[i] = 0;
            }
        }, { rootMargin: '200px 0px', threshold: 0 })
        : null;

    // Panel-level ResizeObserver: catches layout changes not covered by
    // animation / transition / scroll events — e.g. a glass button whose
    // text content changes (sync button: "Sync" -> "Updating 5/100 games…"),
    // reflowing itself and shifting its flex siblings. Any panel resize
    // invalidates ALL _rectFresh: a single flex reflow can shift every
    // sibling's position without resizing them, so own-resize alone isn't
    // enough. Uint8Array.fill is effectively free.
    var _glassRO = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(function () {
            if (_cachedEls.length === 0) return;
            _rectFresh.fill(0);
            _anyAnimating = true;  // wake the render loop for one frame
        })
        : null;

    function cacheElements() {
        _anyAnimating = true;         // DOM changed — stay awake until collectPanels confirms idle
        _layoutDirty = false;
        _rectValid = false;           // invalidate rect cache on layout change
        _rectFresh.fill(0);           // every panel must be re-read before first render
        _cachedEls = [];
        _cachedTierValues = [];
        _fullyOpaque.fill(0);
        _revealAnim.fill(0);
        _cachedAnimAncestor = [];
        if (_glassIO) _glassIO.disconnect();
        if (_glassRO) _glassRO.disconnect();
        _elIndex.clear();
        _ancestorToIdx.clear();
        // Default to visible so cold-start first frame renders all panels before
        // IO callback fires. IO will downgrade offscreen panels to 0 shortly after.
        _inViewport.fill(1);
        _animActive.fill(0);
        if (_isMobile) { panelCount = 0; return; }
        if (!_mainEl) _mainEl = document.querySelector('main');

        var els = document.querySelectorAll(GLASS_SEL);
        for (var i = 0; i < els.length && _cachedEls.length < MAX_CACHED; i++) {
            var el = els[i];
            var closestArt = el.closest('article');
            if (closestArt && el !== closestArt && el.matches('select, input, textarea') && !el.closest('.tracking-form')) continue;
            var idx = _cachedEls.length;
            var style = getComputedStyle(el);
            _cachedRadius[idx] = ((parseFloat(style.borderTopLeftRadius) || 0) +
                (parseFloat(style.borderTopRightRadius) || 0) +
                (parseFloat(style.borderBottomLeftRadius) || 0) +
                (parseFloat(style.borderBottomRightRadius) || 0)) * 0.25;
            var _tn = getTierName(el);
            _cachedTierValues[idx] = getTierValues(_tn);
            _cachedReveal[idx] = el.matches(REVEAL_SEL) ? 1 : 0;
            _cachedZIndex[idx] = parseFloat(style.zIndex) || 0;
            var pos = style.position;
            _cachedSticky[idx] = pos === 'sticky' ? 1 : 0;
            _cachedFixed[idx] = pos === 'fixed' ? 1 : 0;
            var cl = el.classList;
            _cachedHasAnim[idx] = (cl.contains('anim-blur-rise') || cl.contains('anim-drop') ||
                cl.contains('anim-pop') || cl.contains('anim-blur-scale') ||
                cl.contains('anim-slide-blur') || cl.contains('anim-grow')) ? 1 : 0;
            _cachedAnimIn[idx] = cl.contains('animate-in') ? 1 : 0;
            _cachedAnimAncestor[idx] = _cachedHasAnim[idx] ? null
                : el.parentElement && el.parentElement.closest('.anim-blur-rise,.anim-drop,.anim-pop,.anim-blur-scale,.anim-slide-blur,.anim-grow');
            _cachedInMain[idx] = (_mainEl && _mainEl.contains(el)) ? 1 : 0;
            _cachedEls.push(el);
            _elIndex.set(el, idx);
            if (_cachedAnimAncestor[idx]) {
                var anc = _cachedAnimAncestor[idx];
                var alist = _ancestorToIdx.get(anc);
                if (!alist) { alist = []; _ancestorToIdx.set(anc, alist); }
                alist.push(idx);
            }
            if (_glassIO) _glassIO.observe(el);
            if (_glassRO) _glassRO.observe(el);
        }
        // Observe layout container(s) too: catches content that appears/disappears
        // BETWEEN glass panels (e.g. sync-progress text span filling in during a
        // running sync). No glass panel resizes, but its siblings shift — only a
        // container-height change reveals that. Prefer <main>; fall back to body.
        if (_glassRO) {
            var _layoutRoot = _mainEl || document.body;
            if (_layoutRoot) _glassRO.observe(_layoutRoot);
        }
        // Cold start: CSS animations can begin before this module evaluates, so
        // animationstart events were missed. Seed per-panel _animActive from
        // currently-running animations; animationend events drain it naturally.
        if (document.getAnimations) {
            try {
                var running = document.getAnimations();
                for (var ga = 0; ga < running.length; ga++) {
                    var anim = running[ga];
                    var ps = anim.playState;
                    if (ps !== 'running' && ps !== 'pending') continue;
                    var eff = anim.effect;
                    var tgt = eff && eff.target;
                    if (!tgt) continue;
                    var ti = _elIndex.get(tgt);
                    if (ti !== undefined) {
                        _animActive[ti] = 1;
                        _fullyOpaque[ti] = 0;
                        continue;
                    }
                    var alist2 = _ancestorToIdx.get(tgt);
                    if (alist2) {
                        for (var aj = 0; aj < alist2.length; aj++) {
                            _animActive[alist2[aj]] = 1;
                            _fullyOpaque[alist2[aj]] = 0;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    // Temp arrays for z-sorted panel collection
    var _sortIndices = new Int32Array(MAX_PANELS);
    var _sortZ = new Float32Array(MAX_PANELS);
    // Temp storage for unsorted panel data before packing into GPU buffer
    var _sortRects = new Float32Array(MAX_PANELS * 4);
    var _sortExtra = new Float32Array(MAX_PANELS * 4);
    var _sortOR = new Float32Array(MAX_PANELS * 2);

    function collectPanels(curScrollY) {
        // Six non-frame() call sites (initial render, visibilitychange, prewarmGlassPanels
        // in both renderers) invoke this bare. Without a default, curScrollY is undefined
        // and `rTop + undefined = NaN` poisons _rectDocTop — next frame reads back NaN,
        // which survives the viewport cull (all NaN comparisons are false) and uploads
        // to the GPU as garbage rect coords.
        if (curScrollY === undefined) curScrollY = window.scrollY;
        var visCount = 0;

        var mainSlideAnimating = _mainEl && (
            _mainEl.classList.contains('tab-exit-forward') ||
            _mainEl.classList.contains('tab-exit-back') ||
            _mainEl.classList.contains('tab-switch-forward') ||
            _mainEl.classList.contains('tab-switch-back'));
        var mainFadeExiting = _mainEl && !mainSlideAnimating && _mainEl.style.opacity === '0';
        // "Exiting" here means any main-level animation where child panel rects need
        // fresh per-frame reads (main is transforming, so children's visual position moves).
        var mainExiting = mainSlideAnimating || mainFadeExiting;
        // Tab-exit is a pure transform animation — opacity stays 1.0 throughout.
        // Only call getComputedStyle for fade-exit (opacity transition) so we don't
        // pay a forced style recalculation on every frame during the common directional
        // tab switch (which accounts for the vast majority of SPA navigations).
        var mainOpacity = mainFadeExiting ? parseFloat(getComputedStyle(_mainEl).opacity) : 1.0;

        // Rect cache: reuse cached document-relative rects when only scroll changed.
        // Global freshRead only for main-element fade/slide or cache invalidation.
        // Per-panel animation tracking (_animActive) handles entrance cascades, and
        // _rectFresh[i]=0 invalidation covers spawns, IO-driven visibility changes,
        // and ancestor-anim fallbacks — so no periodic safety-net re-read is needed.
        var freshRead = !_rectValid || mainExiting;

        for (var i = 0; i < _cachedEls.length; i++) {
            if (visCount >= MAX_PANELS) break;
            if (_cachedHasAnim[i]) {
                var hasAnimIn = _cachedEls[i].classList.contains('animate-in');
                if (!_cachedAnimIn[i]) {
                    // Not yet revealed — skip until animate-in appears
                    if (hasAnimIn) {
                        _cachedAnimIn[i] = 1; _fullyOpaque[i] = 0;
                        // CSS animation is about to run but `animationstart` fires async
                        // (next frame). Mark active + invalidate rect NOW so every frame of
                        // the entrance keyframes re-reads the moving rect. Without this,
                        // subsequent frames read stale cache until animationstart lands,
                        // producing the spawn-snap.
                        _animActive[i] = 1; _rectFresh[i] = 0; _anyAnimating = true;
                    } else continue;
                } else if (!hasAnimIn) {
                    // Was revealed, now exiting — force opacity read so glass fades with CSS
                    _fullyOpaque[i] = 0;
                }
            }
            if (_cachedAnimAncestor[i]) {
                var ancHasAnimIn = _cachedAnimAncestor[i].classList.contains('animate-in');
                if (!ancHasAnimIn) continue;
                // Ancestor just revealed — same async-animationstart race as above.
                // Mark child panel active so its rect is re-read every frame while
                // the ancestor's entrance keyframes play.
                if (!_animActive[i]) { _animActive[i] = 1; _rectFresh[i] = 0; _anyAnimating = true; }
            }
            // Skip main children only when fully invisible (opacity ≈ 0)
            if (mainExiting && _cachedInMain[i] && mainOpacity < 0.01) continue;

            // Viewport cull: IntersectionObserver has marked this panel offscreen.
            // Sticky panels bypass because their viewport position can change on scroll
            // even when the intersection state is stale between callbacks.
            if (!_inViewport[i] && !_cachedSticky[i]) continue;

            // Exiting elements (e.g. toast dismiss): read computed opacity so glass fades with CSS transition
            var isExiting = _cachedEls[i].classList.contains('exit');

            // Use cached rects when scroll-only; always re-read for sticky or fresh frames.
            // Fixed panels keep the same viewport rect across scroll, so their cached
            // viewport-space top can be reused until some other invalidation lands.
            var rLeft, rTop, rWidth, rHeight;
            if (freshRead || isExiting || _cachedSticky[i] || _animActive[i] || !_rectFresh[i]) {
                var rect = _cachedEls[i].getBoundingClientRect();
                rLeft = rect.left; rTop = rect.top; rWidth = rect.width; rHeight = rect.height;
                // Normal flow + sticky panels cache doc-relative top so scroll-only frames
                // can derive viewport top cheaply. Fixed panels cache viewport top directly.
                // curScrollY here is live window.scrollY (read at top of render path) so
                // it's frame-consistent with rect.top above — no cache pollution.
                _rectLeft[i]   = rLeft;
                _rectDocTop[i] = _cachedFixed[i] ? rTop : (rTop + curScrollY);
                _rectWidth[i]  = rWidth;
                _rectHeight[i] = rHeight;
                _rectFresh[i]  = 1;   // time-consistent rect/scrollY pair now cached
            } else {
                rLeft   = _rectLeft[i];
                rTop    = _cachedFixed[i] ? _rectDocTop[i] : (_rectDocTop[i] - curScrollY);
                rWidth  = _rectWidth[i];
                rHeight = _rectHeight[i];
            }
            if (rWidth < 10 || rHeight < 10) continue;
            if (rTop + rHeight < -50 || rTop > vpH + 50) continue;
            if (rLeft + rWidth < -50 || rLeft > vpW + 50) continue;

            var idx4 = visCount * 4;
            _sortRects[idx4]     = rLeft;
            _sortRects[idx4 + 1] = rTop;
            _sortRects[idx4 + 2] = rWidth;
            _sortRects[idx4 + 3] = rHeight;

            var tv = _cachedTierValues[i];
            _sortExtra[idx4]     = Math.min(_cachedRadius[i], rWidth * 0.5, rHeight * 0.5);
            _sortExtra[idx4 + 1] = tv.sat;
            _sortExtra[idx4 + 2] = tv.bright;
            _sortExtra[idx4 + 3] = tv.tint;

            var animTarget = isExiting ? _cachedEls[i]
                : (_cachedHasAnim[i] ? _cachedEls[i] : _cachedAnimAncestor[i]);
            var or2 = visCount * 2;
            if (isExiting) {
                // Always read opacity during exit — element is fading out
                _fullyOpaque[i] = 0;
                _sortOR[or2] = parseFloat(getComputedStyle(_cachedEls[i]).opacity);
            } else {
                _sortOR[or2] = animTarget && !_fullyOpaque[i]
                    ? parseFloat(getComputedStyle(animTarget).opacity) : 1.0;
                if (_sortOR[or2] >= 0.99) _fullyOpaque[i] = 1;
            }
            // Apply main's exit opacity so glass fades with page transition
            if (mainExiting && _cachedInMain[i]) {
                _sortOR[or2] *= mainOpacity;
                _fullyOpaque[i] = 0;
            }
            // Smooth reveal fade — lerp toward 1 when mouse inside, 0 when outside
            var revealTarget = 0;
            if (_cachedReveal[i] && _mouseX > -9000) {
                if (_mouseX >= rLeft && _mouseX <= rLeft + rWidth &&
                    _mouseY >= rTop && _mouseY <= rTop + rHeight) {
                    revealTarget = 1;
                }
            }
            var revealSpeed = revealTarget ? 3.0 : 4.0;
            _revealAnim[i] += (revealTarget - _revealAnim[i]) * Math.min(revealSpeed * _frameDt, 1.0);
            if (_revealAnim[i] < 0.002) _revealAnim[i] = 0;
            _sortOR[or2 + 1] = _revealAnim[i];

            _sortZ[visCount] = _cachedZIndex[i];
            _sortIndices[visCount] = visCount;
            visCount++;
        }

        // Mark rect cache valid after a full read
        if (freshRead) {
            _rectValid = true;
            _rectScrollY = curScrollY;
        }

        // Z-sort (painter's algorithm)
        var needsSort = false;
        for (var zi = 0; zi < visCount; zi++) {
            if (_sortZ[zi] !== 0) { needsSort = true; break; }
        }

        panelCount = visCount;

        // Pack into storage buffer format: rect(4) + extra(4) + opacReveal(2) + pad(2) = 12 floats
        if (needsSort) {
            for (var a = 1; a < visCount; a++) {
                var keyIdx = _sortIndices[a];
                var keyZ = _sortZ[keyIdx];
                var b = a - 1;
                while (b >= 0 && _sortZ[_sortIndices[b]] > keyZ) {
                    _sortIndices[b + 1] = _sortIndices[b];
                    b--;
                }
                _sortIndices[b + 1] = keyIdx;
            }
            for (var s = 0; s < visCount; s++) {
                var si = _sortIndices[s];
                var dOff = s * PANEL_STRIDE;
                var s4 = si * 4, s2 = si * 2;
                panelStorageData[dOff]      = _sortRects[s4];
                panelStorageData[dOff + 1]  = _sortRects[s4 + 1];
                panelStorageData[dOff + 2]  = _sortRects[s4 + 2];
                panelStorageData[dOff + 3]  = _sortRects[s4 + 3];
                panelStorageData[dOff + 4]  = _sortExtra[s4];
                panelStorageData[dOff + 5]  = _sortExtra[s4 + 1];
                panelStorageData[dOff + 6]  = _sortExtra[s4 + 2];
                panelStorageData[dOff + 7]  = _sortExtra[s4 + 3];
                panelStorageData[dOff + 8]  = _sortOR[s2];
                panelStorageData[dOff + 9]  = _sortOR[s2 + 1];
                panelStorageData[dOff + 10] = 0; // pad
                panelStorageData[dOff + 11] = 0; // pad
            }
        } else {
            for (var p = 0; p < visCount; p++) {
                var pOff = p * PANEL_STRIDE;
                var p4 = p * 4, p2 = p * 2;
                panelStorageData[pOff]      = _sortRects[p4];
                panelStorageData[pOff + 1]  = _sortRects[p4 + 1];
                panelStorageData[pOff + 2]  = _sortRects[p4 + 2];
                panelStorageData[pOff + 3]  = _sortRects[p4 + 3];
                panelStorageData[pOff + 4]  = _sortExtra[p4];
                panelStorageData[pOff + 5]  = _sortExtra[p4 + 1];
                panelStorageData[pOff + 6]  = _sortExtra[p4 + 2];
                panelStorageData[pOff + 7]  = _sortExtra[p4 + 3];
                panelStorageData[pOff + 8]  = _sortOR[p2];
                panelStorageData[pOff + 9]  = _sortOR[p2 + 1];
                panelStorageData[pOff + 10] = 0;
                panelStorageData[pOff + 11] = 0;
            }
        }
    }

    // ====================================================================
    // Render pipeline
    // ====================================================================
    var _auroraFrame = 0;
    var _lastRenderMouseX = -9999, _lastRenderMouseY = -9999;
    var _lastRenderScrollY = 0;

    function render(doAurora) {
        var canvasTexture;
        try {
            canvasTexture = ctx.getCurrentTexture();
        } catch (e) {
            return; // Canvas lost / swap chain not ready — skip frame
        }
        var canvasView = canvasTexture.createView();

        var encoder = device.createCommandEncoder({ label: 'frame' });

        // Pass 1+2: Aurora + Blur (every 2nd frame, controlled by frame())
        if (doAurora) {
            // Upload aurora uniforms
            for (var i = 0; i < 5; i++) {
                // nodes: vec4(x, y, 0, 0)
                auroraUniformData[i * 4]     = nodes[i].x;
                auroraUniformData[i * 4 + 1] = nodes[i].y;
                auroraUniformData[i * 4 + 2] = 0;
                auroraUniformData[i * 4 + 3] = 0;
                // colors: vec4(lr, lg, lb, k)
                auroraUniformData[20 + i * 4]     = nodes[i].lr;
                auroraUniformData[20 + i * 4 + 1] = nodes[i].lg;
                auroraUniformData[20 + i * 4 + 2] = nodes[i].lb;
                auroraUniformData[20 + i * 4 + 3] = nodes[i].k;
            }
            device.queue.writeBuffer(auroraUniformBuf, 0, auroraUniformData);

            // Pass 1: Aurora → RT_AURORA
            var auroraPass = encoder.beginRenderPass({
                label: 'aurora',
                colorAttachments: [{
                    view: viewAurora,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 }
                }]
            });
            auroraPass.setPipeline(auroraPipeline);
            auroraPass.setBindGroup(0, auroraBindGroup);
            auroraPass.draw(4);
            auroraPass.end();

            // Pass 2: Kawase blur (ping-pong)
            for (var bpu = 0; bpu < BLUR_PASSES; bpu++) {
                blurUniformData[0] = 1.0 / halfW;
                blurUniformData[1] = 1.0 / halfH;
                blurUniformData[2] = bpu;
                blurUniformData[3] = 0;
                device.queue.writeBuffer(blurUniformBufs[bpu], 0, blurUniformData);
            }
            for (var bp = 0; bp < BLUR_PASSES; bp++) {

                var dst = bp % 2;
                var blurPass = encoder.beginRenderPass({
                    label: 'blur ' + bp,
                    colorAttachments: [{
                        view: viewBlur[dst],
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: { r: 0, g: 0, b: 0, a: 1 }
                    }]
                });
                blurPass.setPipeline(blurPipeline);
                blurPass.setBindGroup(0, blurBindGroups[bp]);
                blurPass.draw(4);
                blurPass.end();
            }
        }

        // Pass 3: Composite → screen
        // 3a: Blit aurora
        var compositePass = encoder.beginRenderPass({
            label: 'composite',
            colorAttachments: [{
                view: canvasView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        });
        compositePass.setPipeline(blitPipeline);
        compositePass.setBindGroup(0, blitBindGroup);
        compositePass.draw(4);

        // 3b: Glass panels (instanced)
        if (panelCount > 0) {
            // Upload glass uniforms
            glassUniformData[0] = vpW;
            glassUniformData[1] = vpH;
            glassUniformData[2] = _mouseX;
            glassUniformData[3] = _mouseY;
            glassUniformData[4] = _time;
            device.queue.writeBuffer(glassUniformBuf, 0, glassUniformData);

            // Upload panel storage
            device.queue.writeBuffer(panelStorageBuf, 0,
                panelStorageData, 0, panelCount * PANEL_STRIDE);

            compositePass.setPipeline(glassPipeline);
            compositePass.setBindGroup(0, glassBindGroup);
            compositePass.draw(4, panelCount);
        }

        compositePass.end();

        device.queue.submit([encoder.finish()]);
    }

    // ====================================================================
    // Animation loop
    // ====================================================================
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var _prevFrameTime = 0;
    var _frameDt = 0.016;
    var _time = 0;
    // Simulation time: accumulates only capped frame deltas so blob targets never jump
    // ahead of what the spring integrator has actually stepped through. Prevents the
    // "pauses then accelerates" artifact when the main thread drops frames during SPA nav.
    var _simTime = 0;

    function frame(t) {
        if (!reduced) requestAnimationFrame(frame);
        // Skip all work while paused (SPA nav) or hidden (browser tab switch).
        // Canvas holds its last presented frame — no blank flash, zero GPU submissions.
        if (document.hidden || _glassPaused) return;

        _frameDt = _prevFrameTime ? Math.min((t - _prevFrameTime) * 0.001, 0.1) : 0.016;
        _prevFrameTime = t;
        _time = t * 0.001;
        _simTime += _frameDt;  // advances by at most 100ms per frame — never wall-clock jumps

        if (window.lenis && !window.__lenisOwnRaf) window.lenis.raf(t);

        // Drain queued row-reveal DOM mutations AFTER lenis.raf. IntersectionObserver
        // callbacks fire between frames and push their class/style writes into this
        // queue instead of applying directly. Running them before lenis.raf would
        // leave invalidations pending when scrollTo reads layout, forcing a sync
        // style recalc. Running them after means the invalidations flush during the
        // browser's natural post-rAF layout phase — no forced reflow.
        var q = window.__rowMutationQueue;
        if (q && q.length) {
            for (var mi = 0; mi < q.length; mi++) { try { q[mi](); } catch (_) {} }
            q.length = 0;
        }

        resizeTargets();
        updatePhysics(_simTime);

        // Determine aurora parity before any early-return so the counter stays accurate.
        var doAurora = (_auroraFrame++ & 1) === 0;

        // Cooldown: skip heavy layout work for a few frames after DOM changes
        if (_layoutCooldown > 0) { _layoutCooldown--; render(doAurora); return; }

        // Idle-skip uses the scroll-event cache: a plain JS variable, no layout
        // query. Approximate equality is fine — at worst one extra render frame.
        var frameScrollY = _cachedScrollY;

        // Fast-path idle skip: if no animations are running, scroll/mouse are unchanged,
        // and this isn't an aurora frame, skip collectPanels + render entirely.
        // Done BEFORE cacheElements() so idle frames don't pay the layout-flush cost
        // of getComputedStyle on every cached panel — they aren't going to render anyway.
        if (!doAurora && !_anyAnimating &&
            frameScrollY === _lastRenderScrollY &&
            _mouseX === _lastRenderMouseX && _mouseY === _lastRenderMouseY) return;

        // Render path — live window.scrollY for frame-consistent positioning.
        // Both cache *writes* (rect.top + scrollY → _rectDocTop) AND draw-math
        // (rTop = _rectDocTop - scrollY) MUST use the same scrollY: the actual
        // value the next paint will commit. _cachedScrollY can lag during fast
        // scroll because passive scroll events are batched ~1 frame behind the
        // browser's running scroll position, which makes the canvas glass
        // overlay visibly trail the CSS DOM during scroll. The reflow this
        // forces is intrinsic on most pages anyway — the sticky nav panel
        // re-reads its rect every render frame, which already flushes layout.
        frameScrollY = window.scrollY;

        // Rebuild the panel cache only on frames that will actually render. Aurora
        // frames bypass the early-return above, so cache stays in sync within ≤16ms
        // of any DOM mutation that flipped _layoutDirty.
        if (_layoutDirty) cacheElements();

        collectPanels(frameScrollY);

        // Update idle flag: false once all visible panels confirm fully opaque and no reveals.
        _anyAnimating = false;
        for (var _ai = 0; _ai < _cachedEls.length; _ai++) {
            if (_cachedAnimIn[_ai] && !_fullyOpaque[_ai]) { _anyAnimating = true; break; }
            if (_revealAnim[_ai] > 0.002) { _anyAnimating = true; break; }
        }

        // Secondary render-skip: ran collectPanels but output would still be identical.
        if (!doAurora) {
            // Compare against scroll at last render, not at last rect-read — _rectScrollY
            // is updated inside collectPanels() so it would match window.scrollY on the
            // same frame, masking the position change and skipping visible scroll updates.
            var canSkip = frameScrollY === _lastRenderScrollY;
            if (canSkip) {
                for (var _sci = 0; _sci < _cachedEls.length; _sci++) {
                    if (_revealAnim[_sci] > 0.002) { canSkip = false; break; }
                    if (_cachedAnimIn[_sci] && !_fullyOpaque[_sci]) { canSkip = false; break; }
                }
            }
            if (canSkip && (_mouseX !== _lastRenderMouseX || _mouseY !== _lastRenderMouseY)) canSkip = false;
            if (canSkip) return;
        }

        render(doAurora);
        _lastRenderScrollY = frameScrollY;
        _lastRenderMouseX = _mouseX;
        _lastRenderMouseY = _mouseY;
    }

    // ====================================================================
    // All four pipelines compile in parallel off the JS thread.
    // The initial render is deferred until they all resolve — on iGPU this avoids
    // blocking the main thread during driver JIT compilation (can be 100-500ms).
    // The CSS aurora background remains visible underneath the hidden canvas,
    // so the page is never blank while shaders compile.
    // ====================================================================
    Promise.all([
        createFullscreenPipelineAsync('aurora', AURORA_FS_WGSL, auroraLayout, halfResFormat, null),
        createFullscreenPipelineAsync('blit',   BLIT_FS_WGSL,   blitLayout,   presentFormat, null),
        createFullscreenPipelineAsync('blur',   BLUR_FS_WGSL,   blurLayout,   halfResFormat, null),
        device.createRenderPipelineAsync({
            label: 'glass',
            layout: device.createPipelineLayout({ bindGroupLayouts: [glassLayout] }),
            vertex: { module: glassModule, entryPoint: 'vs' },
            fragment: {
                module: glassModule,
                entryPoint: 'fs',
                targets: [{
                    format: presentFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }
                    }
                }]
            },
            primitive: { topology: 'triangle-strip' }
        })
    ]).then(function (pipelines) {
        auroraPipeline = pipelines[0];
        blitPipeline   = pipelines[1];
        blurPipeline   = pipelines[2];
        glassPipeline  = pipelines[3];

        // First render — deferred one frame so the browser can paint LCP first.
        requestAnimationFrame(function () {
            resizeTargets();
            updatePhysics(0);
            cacheElements();
            collectPanels();
            _auroraFrame = 0; // ensure first render includes aurora pass
            render(true);

            // Fade in canvas over the CSS aurora now that glass is ready
            canvas.style.opacity = '1';
            var _hideStyle = document.getElementById('aurora-canvas-hide');
            if (_hideStyle) _hideStyle.remove();

            if (!reduced) requestAnimationFrame(frame);
        });
    }).catch(function (err) {
        console.error('[glass-webgpu] pipeline compilation failed:', err);
        // CSS aurora background remains visible — page is still usable without glass
    });

    // ====================================================================
    // Events
    // ====================================================================
    window.addEventListener('resize', function () { _layoutDirty = true; });

    // Cache scroll position from the scroll event so the idle-skip equality
    // check in frame() doesn't have to query layout. Render-path math reads
    // window.scrollY live for frame-consistency.
    var _cachedScrollY = window.scrollY;
    window.addEventListener('scroll', function () { _cachedScrollY = window.scrollY; }, { passive: true });
    // htmx SPA nav often resets scroll via `show:window:top` or
    // `lenis.scrollTo(0, { immediate: true })`, but the resulting scroll event
    // can fire after the next rAF runs. Re-seed synchronously on afterSwap so
    // the idle-skip check doesn't compare a stale cached value against the
    // (newly reset) _lastRenderScrollY and false-positive into skipping a
    // render that should have happened.
    document.body.addEventListener('htmx:afterSwap', function () { _cachedScrollY = window.scrollY; });
    window.addEventListener('pageshow', function () { _cachedScrollY = window.scrollY; });

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && glassPipeline) {
            resizeTargets();
            _layoutDirty = true;
            // _prevFrameTime reset so the next frame() call recomputes _frameDt from scratch
            // rather than treating the hidden duration as one giant delta.
            _prevFrameTime = 0;
            updatePhysics(_simTime);  // resume from where simulation left off — no jump
            cacheElements();
            collectPanels();
            render(true); // force aurora on visibility resume for a fresh frame
            // Re-seed scroll cache: scroll events don't fire while the tab is hidden,
            // so the cache may be stale across a long visibility switch.
            _cachedScrollY = window.scrollY;
        }
    });

    // ====================================================================
    // sessionStorage persistence
    // ====================================================================
    window.addEventListener('pagehide', function () {
        try {
            sessionStorage.setItem('aurora', JSON.stringify(nodes.map(function (n) {
                return { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
            })));
        } catch (e) {}
    });

    // ====================================================================
    // Public API
    // ====================================================================
    var _glassPaused = false;
    var _layoutCooldown = 0;
    var _panelUpdateQueued = false;
    window.updateGlassPanels = function () {
        if (_panelUpdateQueued) return;
        _panelUpdateQueued = true;
        requestAnimationFrame(function () {
            _panelUpdateQueued = false;
            // Defer glass recalculation by a few frames after major DOM changes
            // so the browser can paint new content first without layout thrashing
            _layoutDirty = true;
            if (_layoutCooldown < 3) _layoutCooldown = 3;
        });
    };
    // Synchronous variant: sets dirty flags immediately so the glass loop picks up
    // new panels on its very next RAF tick (~16ms) rather than after 5 frames (~83ms).
    // Safe to call when the DOM swap has already settled (e.g. htmx:afterSwap).
    window.updateGlassPanelsNow = function () { _layoutDirty = true; _layoutCooldown = 0; };
    // Pre-warm: synchronously scan + build GPU panel list so compositor layers are
    // allocated before animations start. Call immediately after a DOM swap when the
    // new elements are already laid out. Eliminates the first-frame stutter caused by
    // getBoundingClientRect + GPU buffer allocation coinciding with animate-in.
    window.prewarmGlassPanels = function () {
        if (_glassPaused) return;
        _layoutDirty = false;
        _layoutCooldown = 0;
        cacheElements();
        collectPanels();
    };
    window.pauseGlass = function () { _glassPaused = true; };
    window.resumeGlass = function () {
        _glassPaused = false;
        _layoutDirty = true;
        _prevFrameTime = 0; // discard gap so first resumed frame gets a clean 16ms delta
    };
    // Lightweight rect-only invalidation — use for show/hide toggles where the
    // element list hasn't changed. Avoids the expensive cacheElements re-scan.
    window.invalidateGlassRects = function () { _rectValid = false; };

    // ====================================================================
    // Mobile toggle
    // ====================================================================
    var mobileQuery = window.matchMedia('(max-width: 768px)');
    function handleMobile(mq) {
        _isMobile = mq.matches;
        if (_isMobile) {
            document.documentElement.classList.remove('glass-refract');
            _cachedEls = []; panelCount = 0;
        } else {
            document.documentElement.classList.add('glass-refract');
        }
        _layoutDirty = true;
    }
    handleMobile(mobileQuery);
    mobileQuery.addEventListener('change', handleMobile);

    })(); // end async init()
})();
