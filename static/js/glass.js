/**
 * WebGL Liquid Glass — single GPU pipeline for aurora + glass material.
 *
 * Architecture:
 *   Pass 1: Aurora → FBO_AURORA (half-res)
 *   Pass 2: Kawase Blur → FBO_BLUR (half-res, ping-pong, 2 passes)
 *   Pass 3: Composite → Screen (full viewport)
 *            - Full-screen quad draws aurora from FBO_AURORA
 *            - Glass panel quads: complete glass material (blur + saturate + tint + specular)
 *
 * Layering:
 *   z-index 0: WebGL canvas (position:fixed, full viewport)
 *              - Non-glass regions: aurora mesh gradient
 *              - Glass panel regions: full glass material (replaces aurora)
 *   z-index 1+: DOM content
 *              - Glass panels: transparent background + bevel + noise + content (CSS only)
 */
(function () {
    'use strict';

    var canvas = document.getElementById('aurora-canvas');
    if (!canvas) return;

    // Skip if WebGPU version claimed (or is claiming) the canvas
    if (document.documentElement.classList.contains('glass-refract')) return;
    if (window.__webgpuPending) return;

    var gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false
    });
    if (!gl) return;

    // Software rasterizers (SwiftShader, llvmpipe) run the entire blur pipeline
    // on the CPU — profiled at 200ms+ per frame in software-GL environments.
    // The static CSS aurora fallback is strictly better there, so bail before
    // claiming the glass-refract class.
    var _dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
    var _renderer = String(
        (_dbgInfo && gl.getParameter(_dbgInfo.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''
    );
    if (/swiftshader|llvmpipe|softpipe|software/i.test(_renderer)) return;

    // Float render targets (slope field stores raw signed slope). Near-universal in
    // WebGL2; if absent the slope field falls back to rgba8 and refraction goes flat
    // (no artifacts, just no lensing) rather than breaking.
    var _floatRT = gl.getExtension('EXT_color_buffer_float');

    document.documentElement.classList.add('glass-refract');

    // ====================================================================
    // Shared core — single source of truth for constants, selectors, tier system.
    // ====================================================================
    var core = window.__glassCore;
    if (!core) { console.error('Glass: glass-core.js must load before this script'); return; }
    var PI = Math.PI, TAU = PI * 2;
    var HALF_RES = core.HALF_RES;
    var MAX_PANELS = core.MAX_PANELS;
    var MAX_CACHED = core.MAX_CACHED;
    // IOR / THICKNESS / BEZEL / SPECULAR / SHADOW_MARGIN / REVEAL_MULT are
    // emitted into the shader const block via core.emitGlassConstsGLSL().
    var BACKDROP_TEX_SIZE = core.BACKDROP_TEX_SIZE;
    var BACKDROP_PREBLUR_PX = core.BACKDROP_PREBLUR_PX;
    var BACKDROP_BRIGHTNESS = core.BACKDROP_BRIGHTNESS;
    var BACKDROP_SATURATE = core.BACKDROP_SATURATE;
    var BACKDROP_MAX_TEXTURES = core.BACKDROP_MAX_TEXTURES;

    // ====================================================================
    // Shader sources
    // ====================================================================
    var QUAD_VS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 aPos;\n' +
        'out vec2 vUV;\n' +
        'void main() {\n' +
        '    vUV = aPos * 0.5 + 0.5;\n' +
        '    gl_Position = vec4(aPos, 0.0, 1.0);\n' +
        '}\n';

    var AURORA_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vUV;\n' +
        'out vec4 fragColor;\n' +
        'uniform vec2  uNodes[5];\n' +
        'uniform vec3  uColors[5];\n' +
        'uniform float uK[5];\n' +
        'float s2l(float c){return c<=0.04045?c/12.92:pow((c+0.055)/1.055,2.4);}\n' +
        'float l2s(float c){return c<=0.0031308?c*12.92:1.055*pow(c,1.0/2.4)-0.055;}\n' +
        'void main(){\n' +
        '  float BASE_W=0.16;\n' +
        '  float wSum=BASE_W;\n' +
        '  vec3 bgL=vec3(0.0,s2l(1.0/255.0),0.0);\n' +
        '  vec3 acc=bgL*BASE_W;\n' +
        '  vec3 bloom=vec3(0.0);\n' +
        '  for(int i=0;i<5;i++){\n' +
        '    vec2 d=vUV-uNodes[i];\n' +
        '    float d2=dot(d,d);\n' +
        '    float w=exp(-d2*uK[i]);\n' +
        '    wSum+=w;\n' +
        '    acc+=uColors[i]*w;\n' +
        '    bloom+=uColors[i]*w*0.01;\n' +
        '  }\n' +
        '  vec3 m=acc/wSum;\n' +
        '  vec3 col=vec3(l2s(m.r),l2s(m.g),l2s(m.b))+bloom;\n' +
        '  float inf=clamp(wSum-BASE_W,0.0,1.0);\n' +
        '  vec2 cv=vUV-0.5;\n' +
        '  float dd=length(cv)*1.28;\n' +
        '  float vig=max(1.0-pow(min(dd,1.0),1.6),0.24);\n' +
        '  col*=vig*(0.12+0.88*inf)*0.94;\n' +
        '  fragColor=vec4(clamp(col,0.0,1.0),1.0);\n' +
        '}\n';

    // Prepend the full tuning block — shader compiler dead-strips unused consts.
    var BLIT_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vUV;\n' +
        'out vec4 fragColor;\n' +
        'uniform sampler2D uTex;\n' +
        core.emitGlassConstsGLSL() +
        // Interleaved gradient noise (Jorge Jimenez, 2014) — no texture tap, no banding
        'float ign(vec2 p){\n' +
        '  return fract(IGN_HASH*fract(dot(p,IGN_DOT)));\n' +
        '}\n' +
        'void main(){\n' +
        '  vec3 col=texture(uTex,vUV).rgb;\n' +
        // Dither: ±0.5/255 triangular noise to break 8-bit banding
        '  float n=ign(gl_FragCoord.xy);\n' +
        '  col+=(n-0.5)/255.0;\n' +
        '  fragColor=vec4(col,1.0);\n' +
        '}\n';

    // -- Separable Gaussian (σ=2, 7 bilinear fetches) — ported from liquid-dom --
    // uDir is (1,0) for horizontal, (0,1) for vertical; offsets in destination texels.
    // uSrcLod selects the source mip level (the H pass reads the finer level at the
    // coarser texel size, folding the pyramid downsample into the blur).
    var GAUSS_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vUV;\n' +
        'out vec4 fragColor;\n' +
        'uniform sampler2D uTex;\n' +
        'uniform vec2 uTexelSize;\n' +
        'uniform vec2 uDir;\n' +
        'uniform float uSrcLod;\n' +
        'void main(){\n' +
        '  vec2 d=uDir*uTexelSize;\n' +
        '  vec4 acc=textureLod(uTex,vUV,uSrcLod)*' + core.GAUSS.center + ';\n' +
        '  vec2 o0=d*' + core.GAUSS.pairOffset[0] + ';\n' +
        '  acc+=(textureLod(uTex,vUV+o0,uSrcLod)+textureLod(uTex,vUV-o0,uSrcLod))*' + core.GAUSS.pairWeight[0] + ';\n' +
        '  vec2 o1=d*' + core.GAUSS.pairOffset[1] + ';\n' +
        '  acc+=(textureLod(uTex,vUV+o1,uSrcLod)+textureLod(uTex,vUV-o1,uSrcLod))*' + core.GAUSS.pairWeight[1] + ';\n' +
        '  vec2 o2=d*' + core.GAUSS.pairOffset[2] + ';\n' +
        '  acc+=(textureLod(uTex,vUV+o2,uSrcLod)+textureLod(uTex,vUV-o2,uSrcLod))*' + core.GAUSS.pairWeight[2] + ';\n' +
        '  fragColor=acc;\n' +
        '}\n';

    // -- Backdrop pass (per-panel image into FBO_AURORA before blur) --
    // Operates in half-res pixel space throughout: caller divides viewport-pixel
    // rect/radius by HALF_RES before upload so SDF, geometry, and target all share
    // the same coordinate system.
    var BACKDROP_VS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 aPos;\n' +
        'uniform vec4 uRect;\n' +    // x, y, w, h — half-res pixels
        'uniform vec4 uRadii;\n' +   // radius (half-res px), opacity, texAspect, _pad
        'uniform vec2 uVp;\n' +      // halfW, halfH
        'out vec2 vLocalPos;\n' +
        'out vec2 vBaseUv;\n' +
        'out vec2 vPanelHalfSize;\n' +
        'out float vRadius;\n' +
        'out float vOpacity;\n' +
        'out float vTexAspect;\n' +
        'void main(){\n' +
        '  vec2 halfSize=uRect.zw*0.5;\n' +
        '  vec2 center=uRect.xy+halfSize;\n' +
        '  vec2 pos=center+aPos*halfSize;\n' +
        '  vLocalPos=aPos*halfSize;\n' +
        '  vPanelHalfSize=halfSize;\n' +
        '  vBaseUv=vec2((aPos.x+1.0)*0.5,(aPos.y+1.0)*0.5);\n' +
        '  vRadius=uRadii.x;\n' +
        '  vOpacity=uRadii.y;\n' +
        '  vTexAspect=uRadii.z;\n' +
        '  vec2 ndc=(pos/uVp)*2.0-1.0;\n' +
        '  ndc.y=-ndc.y;\n' +
        '  gl_Position=vec4(ndc,0.0,1.0);\n' +
        '}\n';

    var BACKDROP_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vLocalPos;\n' +
        'in vec2 vBaseUv;\n' +
        'in vec2 vPanelHalfSize;\n' +
        'in float vRadius;\n' +
        'in float vOpacity;\n' +
        'in float vTexAspect;\n' +
        'uniform sampler2D uTex;\n' +
        'out vec4 fragColor;\n' +
        'float rboxSDF(vec2 p,vec2 b,float r){\n' +
        '  vec2 q=abs(p)-b+r;\n' +
        '  return min(max(q.x,q.y),0.0)+length(max(q,vec2(0.0)))-r;\n' +
        '}\n' +
        'void main(){\n' +
        // Inset half a quarter-res pixel so the whole edge ramp sits inside the
        // geometric panel — otherwise the Kawase blur smears half-alpha pixels
        // outward past the glass shader's clip and the image bleeds.
        '  float sd=rboxSDF(vLocalPos,vPanelHalfSize,vRadius)+0.5;\n' +
        '  if(sd>0.0)discard;\n' +
        // Cover-style UV sampling, mirroring CSS background-size:cover.
        '  float panelAspect=vPanelHalfSize.x/vPanelHalfSize.y;\n' +
        '  vec2 uvMul=vec2(1.0,1.0);\n' +
        '  if(panelAspect>vTexAspect)uvMul.y=vTexAspect/panelAspect;\n' +
        '  else uvMul.x=panelAspect/vTexAspect;\n' +
        '  vec2 uv=(vBaseUv-0.5)*uvMul+0.5;\n' +
        '  float edge=smoothstep(0.0,1.5,-sd);\n' +
        '  vec3 col=texture(uTex,uv).rgb;\n' +
        '  float a=edge*vOpacity;\n' +
        '  fragColor=vec4(col*a,a);\n' +    // pre-multiplied
        '}\n';

    // -- Slope-field prepass FS (liquid-dom DISPLACEMENT_FIELD_SHADER, per-panel) --
    // Reuses GLASS_VS. Writes the bevel slope (SDF gradient × profile derivative)
    // encoded + premultiplied by fill; the renderer blurs it so the glass pass reads
    // a clean normal instead of an inline finite-difference gradient.
    var SLOPE_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vLocalPos;\n' +
        'in vec2 vPanelSize;\n' +
        'in float vRadius;\n' +
        'out vec4 fragColor;\n' +
        core.emitGlassConstsGLSL() +
        'float rboxSDF(vec2 p, vec2 b, float r){ vec2 q=abs(p)-b+r; return min(max(q.x,q.y),0.0)+length(max(q,vec2(0.0)))-r; }\n' +
        'void main(){\n' +
        '  float sd=rboxSDF(vLocalPos,vPanelSize,vRadius);\n' +
        '  float distFromEdge=-sd;\n' +
        '  float fill=smoothstep(0.0,EDGE_AA_PX,distFromEdge);\n' +
        '  if(fill<=0.0){ discard; }\n' +
        // liquid-dom: slope = SDF gradient × convexSquircle derivative over bezelWidth.
        '  float bezelProg=clamp(distFromEdge/REFRACT_BEZEL,0.0,1.0);\n' +
        '  float u=1.0-bezelProg;\n' +
        '  float inside=max(1.0-u*u*u*u,0.0001);\n' +
        '  float deriv=2.0*u*u*u/sqrt(inside);\n' +
        '  float dh=min(deriv,SLOPE_ENCODE_MAX);\n' +
        '  float sx=rboxSDF(vLocalPos+vec2(0.5,0.0),vPanelSize,vRadius);\n' +
        '  float sy=rboxSDF(vLocalPos+vec2(0.0,0.5),vPanelSize,vRadius);\n' +
        // Length-guard the normalize (see WGSL slope FS note): wide-panel medial axis
        // → forward diff (0,0) → NaN → Gaussian-blurred into a black band.
        '  vec2 gradVec=vec2(sx-sd,sy-sd);\n' +
        '  float gradLen=length(gradVec);\n' +
        '  vec2 grad=gradLen>1e-5 ? gradVec/gradLen : vec2(0.0);\n' +
        '  vec2 surfaceSlope=grad*dh;\n' +
        '  fragColor=vec4(surfaceSlope*fill,0.0,fill);\n' +    // raw premultiplied slope (float field)
        '}\n';

    var GLASS_VS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 aPos;\n' +
        'in vec4 aPanelRect;\n' +   // x,y,w,h in pixels (instanced). y is doc-top when aScrollMul=1, screen-top when aScrollMul=0.
        'in vec4 aPanelExtra;\n' +  // radius, saturation, brightness, tintAlpha (instanced)
        'in vec2 aOpacReveal;\n' +    // x=CSS opacity, y=reveal flag (instanced)
        'in float aScrollMul;\n' +    // 0 fixed/sticky/animating/exit, 1 stable (instanced)
        'in float aBlurLod;\n' +      // tier blur LOD into the blur mip chain (instanced)
        'uniform vec2 uViewport;\n' +
        'uniform float uScrollY;\n' +    // doc-space scroll (mirrors FS uniform)

        'out vec2 vLocalPos;\n' +
        'out vec2 vPanelSize;\n' +
        'out vec2 vBlurUV;\n' +
        'out vec2 vScreenPos;\n' +
        'out float vRadius;\n' +
        'out float vSaturation;\n' +
        'out float vBrightness;\n' +
        'out float vTintAlpha;\n' +
        'out float vOpacity;\n' +
        'out float vReveal;\n' +
        'out float vBlurLod;\n' +
        // Tuning constants — synthesized from core.GLASS_TUNING (single source of truth).
        // VS only needs SHADOW_MARGIN, but the compiler dead-strips the rest.
        core.emitGlassConstsGLSL() +
        'void main(){\n' +
        // Stable panels store doc-relative y; shader subtracts scrollY each frame so
        // the buffer stays bit-identical during pure scroll. Non-stable panels have
        // aScrollMul=0 and ride with their CPU-computed viewport y.
        '  float panelY=aPanelRect.y - uScrollY * aScrollMul;\n' +
        '  vec2 hs=aPanelRect.zw*0.5;\n' +
        '  vec2 ctr=vec2(aPanelRect.x, panelY)+hs;\n' +
        // Expand quad by shadow margin so exterior drop shadow has room to render
        '  vec2 hsExpanded=hs+SHADOW_MARGIN;\n' +
        '  vec2 pos=ctr+aPos*hsExpanded;\n' +
        '  vLocalPos=aPos*hsExpanded;\n' +  // local coords include shadow margin
        '  vPanelSize=hs;\n' +              // SDF uses actual panel half-size (not expanded)
        '  vScreenPos=pos;\n' +
        '  vRadius=aPanelExtra.x;\n' +
        '  vSaturation=aPanelExtra.y;\n' +
        '  vBrightness=aPanelExtra.z;\n' +
        '  vTintAlpha=aPanelExtra.w;\n' +
        '  vOpacity=aOpacReveal.x;\n' +
        '  vReveal=aOpacReveal.y;\n' +
        '  vBlurLod=aBlurLod;\n' +
        // UV into blur texture: viewport-relative, Y-flipped for GL
        '  vBlurUV=vec2(pos.x/uViewport.x, 1.0-pos.y/uViewport.y);\n' +
        // To NDC
        '  vec2 ndc=(pos/uViewport)*2.0-1.0;\n' +
        '  ndc.y=-ndc.y;\n' +
        '  gl_Position=vec4(ndc,0.0,1.0);\n' +
        '}\n';

    var GLASS_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vLocalPos;\n' +
        'in vec2 vPanelSize;\n' +
        'in vec2 vBlurUV;\n' +
        'in vec2 vScreenPos;\n' +
        'in float vRadius;\n' +
        'in float vSaturation;\n' +
        'in float vBrightness;\n' +
        'in float vTintAlpha;\n' +
        'in float vOpacity;\n' +
        'in float vReveal;\n' +
        'in float vBlurLod;\n' +
        'uniform sampler2D uBlurTex;\n' +
        'uniform sampler2D uBackdropTex;\n' +
        'uniform sampler2D uSlopeTex;\n' +
        'uniform vec2 uViewport;\n' +
        'uniform vec2 uMouse;\n' +       // screen-space mouse position (px)
        'uniform float uTime;\n' +
        'uniform float uScrollY;\n' +    // doc-space scroll offset; mirrors VS uScrollY
        'out vec4 fragColor;\n' +
        // Tuning constants — synthesized from core.GLASS_TUNING (single source of truth).
        core.emitGlassConstsGLSL() +
        // Signed-distance to a rounded box centered at origin, half-extents b,
        // radius r. Negative inside, zero on boundary, positive outside.
        'float rboxSDF(vec2 p,vec2 b,float r){\n' +
        '  vec2 q=abs(p)-b+r;\n' +
        '  return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r;\n' +
        '}\n' +
        // Quartic dome profile — radial slope from 0 at center to vertical at edge.
        'float surfaceHeight(float t){\n' +
        '  float s=1.0-t;\n' +
        '  return sqrt(sqrt(1.0-s*s*s*s));\n' +
        '}\n' +
        'void main(){\n' +
        core.buildGlassFSBody('glsl') +
        '}\n';

    // ====================================================================
    // Shader utilities
    // ====================================================================
    function compile(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('Glass shader:', gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }
    function link(vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.error('Glass link:', gl.getProgramInfoLog(p));
            gl.deleteProgram(p);
            return null;
        }
        return p;
    }
    function build(vsSrc, fsSrc) {
        var vs = compile(gl.VERTEX_SHADER, vsSrc);
        var fs = compile(gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;
        return link(vs, fs);
    }

    // ====================================================================
    // Build programs
    // ====================================================================
    var auroraProg   = build(QUAD_VS, AURORA_FS);
    var blitProg     = build(QUAD_VS, BLIT_FS);
    var gaussProg    = build(QUAD_VS, GAUSS_FS);
    var glassProg    = build(GLASS_VS, GLASS_FS);
    var slopeProg    = build(GLASS_VS, SLOPE_FS);
    var backdropProg = build(BACKDROP_VS, BACKDROP_FS);

    if (!auroraProg || !blitProg || !gaussProg || !glassProg || !slopeProg || !backdropProg) {
        console.error('Glass: shader compilation failed');
        document.documentElement.classList.remove('glass-refract');
        return;
    }

    // ====================================================================
    // Locations
    // ====================================================================
    var auroraU = { nodes: [], colors: [], k: [] };
    for (var i = 0; i < 5; i++) {
        auroraU.nodes[i]  = gl.getUniformLocation(auroraProg, 'uNodes[' + i + ']');
        auroraU.colors[i] = gl.getUniformLocation(auroraProg, 'uColors[' + i + ']');
        auroraU.k[i]      = gl.getUniformLocation(auroraProg, 'uK[' + i + ']');
    }
    var blitU = { tex: gl.getUniformLocation(blitProg, 'uTex') };
    var gaussU = {
        tex: gl.getUniformLocation(gaussProg, 'uTex'),
        texelSize: gl.getUniformLocation(gaussProg, 'uTexelSize'),
        dir: gl.getUniformLocation(gaussProg, 'uDir'),
        srcLod: gl.getUniformLocation(gaussProg, 'uSrcLod')
    };
    var glassU = {
        aPos:      gl.getAttribLocation(glassProg, 'aPos'),
        panelRect: gl.getAttribLocation(glassProg, 'aPanelRect'),
        panelExtra:gl.getAttribLocation(glassProg, 'aPanelExtra'),
        opacReveal:gl.getAttribLocation(glassProg, 'aOpacReveal'),
        scrollMul: gl.getAttribLocation(glassProg, 'aScrollMul'),
        blurLod:   gl.getAttribLocation(glassProg, 'aBlurLod'),
        blurTex:   gl.getUniformLocation(glassProg, 'uBlurTex'),
        backdropTex: gl.getUniformLocation(glassProg, 'uBackdropTex'),
        slopeTex:  gl.getUniformLocation(glassProg, 'uSlopeTex'),
        viewport:  gl.getUniformLocation(glassProg, 'uViewport'),
        mouse:     gl.getUniformLocation(glassProg, 'uMouse'),
        time:      gl.getUniformLocation(glassProg, 'uTime'),
        scrollY:   gl.getUniformLocation(glassProg, 'uScrollY')
    };
    // Slope prepass shares the glass VS; query its own attribute locations (a
    // separate program may bind them differently, and unused ones may be dropped).
    var slopeA = {
        aPos:      gl.getAttribLocation(slopeProg, 'aPos'),
        panelRect: gl.getAttribLocation(slopeProg, 'aPanelRect'),
        panelExtra:gl.getAttribLocation(slopeProg, 'aPanelExtra'),
        opacReveal:gl.getAttribLocation(slopeProg, 'aOpacReveal'),
        scrollMul: gl.getAttribLocation(slopeProg, 'aScrollMul'),
        blurLod:   gl.getAttribLocation(slopeProg, 'aBlurLod')
    };
    var slopeU = {
        viewport: gl.getUniformLocation(slopeProg, 'uViewport'),
        scrollY:  gl.getUniformLocation(slopeProg, 'uScrollY')
    };
    var backdropU = {
        rect:      gl.getUniformLocation(backdropProg, 'uRect'),
        radii:     gl.getUniformLocation(backdropProg, 'uRadii'),
        vp:        gl.getUniformLocation(backdropProg, 'uVp'),
        tex:       gl.getUniformLocation(backdropProg, 'uTex')
    };

    // ====================================================================
    // Geometry
    // ====================================================================
    var quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    var quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    // ====================================================================
    // VAOs
    // ====================================================================
    function makeQuadVAO(prog) {
        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        var loc = gl.getAttribLocation(prog, 'aPos');
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return vao;
    }

    var auroraVAO   = makeQuadVAO(auroraProg);
    var blitVAO     = makeQuadVAO(blitProg);
    var gaussVAO    = makeQuadVAO(gaussProg);
    var backdropVAO = makeQuadVAO(backdropProg);

    // Glass VAO with instanced panel data
    var panelRectBuf  = gl.createBuffer();
    var panelExtraBuf = gl.createBuffer();
    var panelORBuf    = gl.createBuffer();  // opacity + reveal packed as vec2
    var panelMulBuf   = gl.createBuffer();  // scrollMul — float per panel
    var panelBlurBuf  = gl.createBuffer();  // blurLod — float per panel
    var panelRectData  = new Float32Array(MAX_PANELS * 4);  // draw buffer (GPU)
    var panelExtraData = new Float32Array(MAX_PANELS * 4);  // draw buffer (GPU)
    var panelORData    = new Float32Array(MAX_PANELS * 2);  // [opacity, reveal] per panel
    var panelMulData   = new Float32Array(MAX_PANELS);      // scrollMul per panel
    var panelBlurData  = new Float32Array(MAX_PANELS);      // blurLod per panel
    var panelCount = 0;

    var glassVAO = gl.createVertexArray();
    gl.bindVertexArray(glassVAO);
    // Quad verts
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(glassU.aPos);
    gl.vertexAttribPointer(glassU.aPos, 2, gl.FLOAT, false, 0, 0);
    // Panel rect (per-instance)
    gl.bindBuffer(gl.ARRAY_BUFFER, panelRectBuf);
    gl.bufferData(gl.ARRAY_BUFFER, panelRectData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glassU.panelRect);
    gl.vertexAttribPointer(glassU.panelRect, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(glassU.panelRect, 1);
    // Panel extra (per-instance) — vec4: radius, saturation, brightness, tintAlpha
    gl.bindBuffer(gl.ARRAY_BUFFER, panelExtraBuf);
    gl.bufferData(gl.ARRAY_BUFFER, panelExtraData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glassU.panelExtra);
    gl.vertexAttribPointer(glassU.panelExtra, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(glassU.panelExtra, 1);
    // Per-panel opacity+reveal (vec2, instanced)
    gl.bindBuffer(gl.ARRAY_BUFFER, panelORBuf);
    gl.bufferData(gl.ARRAY_BUFFER, panelORData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glassU.opacReveal);
    gl.vertexAttribPointer(glassU.opacReveal, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(glassU.opacReveal, 1);
    // Per-panel scrollMul (float, instanced)
    gl.bindBuffer(gl.ARRAY_BUFFER, panelMulBuf);
    gl.bufferData(gl.ARRAY_BUFFER, panelMulData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glassU.scrollMul);
    gl.vertexAttribPointer(glassU.scrollMul, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(glassU.scrollMul, 1);
    // Per-panel blur LOD (float, instanced)
    gl.bindBuffer(gl.ARRAY_BUFFER, panelBlurBuf);
    gl.bufferData(gl.ARRAY_BUFFER, panelBlurData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glassU.blurLod);
    gl.vertexAttribPointer(glassU.blurLod, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(glassU.blurLod, 1);
    gl.bindVertexArray(null);

    // Slope prepass VAO — reuses the same instanced VBOs, bound to slopeProg's
    // attribute locations (some VS-only attributes may be inactive → location -1).
    var slopeVAO = gl.createVertexArray();
    gl.bindVertexArray(slopeVAO);
    function slopeAttr(loc, buf, size, instanced) {
        if (loc < 0) return; // attribute optimized out of slopeProg
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        if (instanced) gl.vertexAttribDivisor(loc, 1);
    }
    slopeAttr(slopeA.aPos, quadBuf, 2, false);
    slopeAttr(slopeA.panelRect, panelRectBuf, 4, true);
    slopeAttr(slopeA.panelExtra, panelExtraBuf, 4, true);
    slopeAttr(slopeA.opacReveal, panelORBuf, 2, true);
    slopeAttr(slopeA.scrollMul, panelMulBuf, 1, true);
    slopeAttr(slopeA.blurLod, panelBlurBuf, 1, true);
    gl.bindVertexArray(null);

    // ====================================================================
    // Framebuffers
    // ====================================================================
    var vpW = 0, vpH = 0, halfW = 0, halfH = 0;
    var fboAurora = null, texAurora = null;
    // Sharp backdrop target — full-res, screen-space. Art panels sample this (not the
    // quarter-res blurred aurora) so product art reads crisp under the glass.
    var fboBackdrop = null, texBackdrop = null;
    // Slope field (liquid-dom): per-panel bevel slope, blurred, so the glass pass
    // reads a clean normal. Half-res; rebuilt every frame (panels move on scroll).
    // NOTE: the slope-blur kernel is in TEXELS, so screen-space blur radius scales
    // with SLOPE_RES (~pairOffset × SLOPE_RES). RES=2 → ~11px blur spreads the bevel
    // slope inward (broad displaced rim); RES=1 halves it (~5px) and collapses
    // displacement to a thin edge strip. Keep 2 — full-res field needs a wider blur.
    var SLOPE_RES = 2;
    var slopeW = 0, slopeH = 0;
    var fboSlope = null, texSlope = null;
    var fboSlopeScratch = null, texSlopeScratch = null;
    // Slope-field validity: the field is a pure function of (panel VBO cells,
    // scrollY, viewport) — slopeProg's only uniforms are uViewport + uScrollY.
    // Re-render only when an input changed; on idle aurora frames (static panels,
    // animated background) the cached texture is reused, skipping 3 passes over
    // a half-res RGBA16F target — the largest per-frame bandwidth item on iGPUs
    // with shared memory.
    var _slopeValid = false, _slopeScrollY = -1, _slopePanelCount = -1;
    // Adaptive Gaussian blur pyramid (liquid-dom). A = final pyramid (glass samples
    // it by per-tier LOD); B = scratch holding the horizontal-pass result. Both are
    // mip-complete via texStorage2D so each level is both an FBO target and a
    // textureLod source.
    var blurMipCount = 1;
    var texBlurA = null, texBlurB = null;
    var fboBlurA = [], fboBlurB = [];   // one framebuffer per pyramid level

    function makeFBO(w, h, float) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // Float field (slope) needs signed storage; rgba16f if the ext is present.
        if (float && _floatRT) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { fbo: fbo, tex: tex };
    }

    // Mip-complete pyramid texture + one framebuffer per level. Trilinear min
    // filter so the glass shader samples fractional pyramid levels via LOD.
    function makePyramid(w, h, levels) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var fbos = [];
        for (var L = 0; L < levels; L++) {
            var fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, L);
            fbos.push(fbo);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex: tex, fbos: fbos };
    }

    // Half-res dimensions of pyramid level L.
    function mipDims(level) {
        return [
            Math.max(1, Math.floor(halfW / Math.pow(2, level))),
            Math.max(1, Math.floor(halfH / Math.pow(2, level)))
        ];
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

    function resizeFBOs() {
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

        // Force aurora pass on the next render — new FBOs are empty/black and the
        // blit would show a blank frame if the render happens to be a non-aurora frame.
        _auroraFrame = 0;

        // Recreate aurora FBO at half-res
        if (texAurora) gl.deleteTexture(texAurora);
        if (fboAurora) gl.deleteFramebuffer(fboAurora);
        var a = makeFBO(halfW, halfH);
        fboAurora = a.fbo; texAurora = a.tex;

        // Full-res screen-space backdrop target (art panels sample this sharp).
        if (texBackdrop) gl.deleteTexture(texBackdrop);
        if (fboBackdrop) gl.deleteFramebuffer(fboBackdrop);
        var bdt = makeFBO(vpW, vpH);
        fboBackdrop = bdt.fbo; texBackdrop = bdt.tex;

        // Half-res slope field + H-pass scratch.
        slopeW = Math.max(Math.round(vpW / SLOPE_RES), 1);
        slopeH = Math.max(Math.round(vpH / SLOPE_RES), 1);
        if (texSlope) gl.deleteTexture(texSlope);
        if (fboSlope) gl.deleteFramebuffer(fboSlope);
        if (texSlopeScratch) gl.deleteTexture(texSlopeScratch);
        if (fboSlopeScratch) gl.deleteFramebuffer(fboSlopeScratch);
        var sl = makeFBO(slopeW, slopeH, true);
        fboSlope = sl.fbo; texSlope = sl.tex;
        var sls = makeFBO(slopeW, slopeH, true);
        fboSlopeScratch = sls.fbo; texSlopeScratch = sls.tex;
        _slopeValid = false; // fresh textures hold garbage — force a slope render

        // Rebuild the blur pyramid (A = final, B = scratch), bounded by half-res dims.
        blurMipCount = Math.max(1, Math.min(
            core.BLUR_MIP_MAX,
            Math.floor(Math.log2(Math.max(halfW, halfH))) + 1
        ));
        if (texBlurA) gl.deleteTexture(texBlurA);
        if (texBlurB) gl.deleteTexture(texBlurB);
        for (var da = 0; da < fboBlurA.length; da++) gl.deleteFramebuffer(fboBlurA[da]);
        for (var db = 0; db < fboBlurB.length; db++) gl.deleteFramebuffer(fboBlurB[db]);
        var pa = makePyramid(halfW, halfH, blurMipCount);
        var pb = makePyramid(halfW, halfH, blurMipCount);
        texBlurA = pa.tex; fboBlurA = pa.fbos;
        texBlurB = pb.tex; fboBlurB = pb.fbos;
    }

    // ====================================================================
    // Node physics (identical to original Canvas2D)
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
    // Theme-aware tier system — values + functions live in glass-core.js.
    // ====================================================================
    var detectTheme = core.detectTheme;
    var getTierName = core.getTierName;
    var getTierValues = core.getTierValues;

    // MutationObserver for theme changes
    var _themeObserver = new MutationObserver(function () {
        detectTheme();
        _layoutDirty = true;
    });
    _themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme']
    });

    // ====================================================================
    // Mouse tracking for pointer reveal glow
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
    // Panel position tracking — selectors live in glass-core.js
    // ====================================================================
    var GLASS_SEL = core.GLASS_SEL;
    var REVEAL_SEL = core.REVEAL_SEL;

    var _isMobile = false;

    // Cache radii + tier values so we only call getComputedStyle on layout changes
    var _cachedEls = [];
    var _cachedRadius = new Float32Array(MAX_CACHED);
    var _cachedTierValues = [];  // array of {sat, bright, tint}
    var _cachedHasAnim = new Uint8Array(MAX_CACHED); // 1 if element has entrance anim class
    var _cachedAnimIn = new Uint8Array(MAX_CACHED);  // 1 once animate-in confirmed (permanent)
    var _cachedInMain = new Uint8Array(MAX_CACHED);  // 1 if element is inside <main>
    var _cachedAnimAncestor = [];                     // animating ancestor element (or null)
    var _fullyOpaque  = new Uint8Array(MAX_CACHED);  // 1 once opacity confirmed >= 0.99 (skip getComputedStyle)
    var _cachedReveal = new Uint8Array(MAX_CACHED);  // 1 = interactive (gets pointer reveal glow)
    var _revealAnim = new Float32Array(MAX_CACHED);   // smooth 0→1 reveal intensity per panel
    var _cachedZIndex = new Float32Array(MAX_CACHED); // z-index for draw order (painter's algorithm)
    var _cachedSticky = new Uint8Array(MAX_CACHED);   // 1 = sticky, viewport top derived arithmetically each frame
    var _cachedFixed  = new Uint8Array(MAX_CACHED);   // 1 = fixed, viewport rect is scroll-invariant
    var _cachedStickyAnc = new Uint8Array(MAX_CACHED); // 1 = has a sticky ancestor — visual position drifts with scroll independent of own docTop, so stable-cache path is unsafe
    // Sticky-specific cache: doc-relative geometry of the natural (un-stuck) position
    // and the bottom of the containing block. Allows arithmetic per-frame viewport-top
    // computation: clamp(stickyOffset, naturalDocTop - scrollY, parentDocBottom - h - scrollY).
    // Avoids one getBoundingClientRect per sticky panel per frame.
    var _stickyTopOffset      = new Float32Array(MAX_CACHED);
    var _stickyNaturalDocTop  = new Float32Array(MAX_CACHED);
    var _stickyParentDocBottom = new Float32Array(MAX_CACHED);
    var _mainEl = null;
    var _layoutDirty  = true;
    var _anyAnimating = false; // true while any panel is mid-entrance or reveal-fading
    // Panel buffer dirty tracking. Pack site uses conditional cell writes
    // (only overwrite when the new value differs from the existing one); any write
    // flips _buffDirty=true; render() then uploads all four panel buffers only if dirty.
    // Sticky-stuck panels keep the same rTop frame after frame, so they cost a few
    // comparisons but no writes and no GPU upload.
    var _buffDirty = true;
    var _lastBuffPanelCount = -1;

    // Rect cache: avoid getBoundingClientRect on every frame during scroll-only updates.
    // Normal-flow + sticky panels store doc-relative top (top += scrollY); fixed panels
    // store viewport top because their visual position does not track scroll.
    var _rectDocTop = new Float32Array(MAX_CACHED);
    var _rectLeft   = new Float32Array(MAX_CACHED);
    var _rectWidth  = new Float32Array(MAX_CACHED);
    var _rectHeight = new Float32Array(MAX_CACHED);
    var _rectScrollY = 0;
    var _rectValid = false;
    // Per-panel freshness: 1 iff rect was read by our own getBoundingClientRect() call
    // (time-consistent with the frame's scrollY). 0 forces a fresh read before first render,
    // preventing spawn-snap where a new panel renders once at stale/zero coords.
    var _rectFresh = new Uint8Array(MAX_CACHED);

    // Viewport culling: IntersectionObserver marks panels that are offscreen so
    // collectPanels can skip their per-frame getBoundingClientRect entirely.
    var _inViewport = new Uint8Array(MAX_CACHED);
    var _elIndex = new Map();
    var _ancestorToIdx = new Map();
    // Per-panel keyframe-animation flag. Set when @keyframes runs on the panel
    // (or on an ancestor that wraps it). Forces per-frame rect re-read ONLY for
    // panels whose visual position is actually moving.
    var _animActive = new Uint8Array(MAX_CACHED);
    var _cachedOpacity = new Float32Array(MAX_CACHED);

    // ====================================================================
    // Backdrop image system
    //
    // Panels with `data-glass-backdrop="<url>"` register an image that gets
    // pre-blurred on upload, then painted into the aurora source texture each
    // frame before refraction runs — so Snell's law + per-channel CA distort
    // the image as if it were behind real glass.
    //
    // URL-keyed and refcounted cache: multiple panels showing the same art
    // share one GPU texture. LRU eviction caps memory at BACKDROP_MAX_TEXTURES.
    // ====================================================================
    // URL→texture cache lives in glass-core; driver supplies the WebGL2 bits.
    var _backdrop = core.createBackdropManager({
        createTexture: function (canvas, tw, th, url) {
            var tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            // RGBA8 (not SRGB8_ALPHA8) — the aurora/blur FBO is RGBA8 and the
            // entire pipeline operates on sRGB-encoded values; image bytes are
            // already sRGB-encoded so we want pass-through, not auto-linearize.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return tex;
        },
        destroyTexture: function (tex) { if (tex) gl.deleteTexture(tex); },
        onImageLoaded: function () { _layoutDirty = true; }
    });
    var _backdropDrawCount = 0;
    var _backdropDrawRect    = new Float32Array(BACKDROP_MAX_TEXTURES * 4);
    var _backdropDrawRadius  = new Float32Array(BACKDROP_MAX_TEXTURES);
    var _backdropDrawOpacity = new Float32Array(BACKDROP_MAX_TEXTURES);
    var _backdropDrawTex     = new Array(BACKDROP_MAX_TEXTURES);

    window.__glassBackdrops = {
        cache: _backdrop.cache,
        pending: _backdrop.pending,
        failed: _backdrop.failed,
        cachedUrl: _backdrop.cachedUrl,
        get drawCount() { return _backdropDrawCount; },
        get drawList() {
            var out = [];
            for (var i = 0; i < _backdropDrawCount; i++) {
                out.push({
                    rect: [_backdropDrawRect[i*4], _backdropDrawRect[i*4+1], _backdropDrawRect[i*4+2], _backdropDrawRect[i*4+3]],
                    radius: _backdropDrawRadius[i],
                    opacity: _backdropDrawOpacity[i]
                });
            }
            return out;
        }
    };

    // Pack visible backdropped panels into a draw list. Walks _cachedEls only
    // when at least one image is loaded; zero loaded images returns in O(1).
    // Geometry is stored in full-res screen pixels: the backdrop pass renders into
    // FBO_BACKDROP (full viewport size).
    function _collectBackdrops(curScrollY) {
        _backdropDrawCount = 0;
        if (_backdrop.cache.size === 0) return;
        var n = _cachedEls.length;
        var inv = 1.0; // RT_BACKDROP is full-res screen-space (was 1/HALF_RES for the aurora)
        for (var i = 0; i < n && _backdropDrawCount < BACKDROP_MAX_TEXTURES; i++) {
            var url = _backdrop.cachedUrl[i];
            if (!url) continue;
            var entry = _backdrop.cache.get(url);
            var elCl = _cachedEls[i].classList;
            if (!entry || !entry.tex) { elCl.remove('glass-bd-on'); continue; }
            // Skip panels that haven't entered yet (collectPanels skips these too).
            if (_cachedHasAnim[i] && !_cachedAnimIn[i]) continue;
            var rTop = _cachedFixed[i] ? _rectDocTop[i] : (_rectDocTop[i] - curScrollY);
            var rLeft = _rectLeft[i];
            var rW = _rectWidth[i];
            var rH = _rectHeight[i];
            if (rTop + rH < -50 || rTop > vpH + 50) { elCl.remove('glass-bd-on'); continue; }
            if (rLeft + rW < -50 || rLeft > vpW + 50) { elCl.remove('glass-bd-on'); continue; }
            var op = _cachedOpacity[i];
            if (op < 0.01) { elCl.remove('glass-bd-on'); continue; }
            elCl.add('glass-bd-on');
            var d4 = _backdropDrawCount * 4;
            _backdropDrawRect[d4]     = rLeft * inv;
            _backdropDrawRect[d4 + 1] = rTop  * inv;
            _backdropDrawRect[d4 + 2] = rW    * inv;
            _backdropDrawRect[d4 + 3] = rH    * inv;
            _backdropDrawRadius[_backdropDrawCount]  = Math.min(_cachedRadius[i], rW * 0.5, rH * 0.5) * inv;
            _backdropDrawOpacity[_backdropDrawCount] = op;
            _backdropDrawTex[_backdropDrawCount]     = entry;
            entry.lastUsed = performance.now();
            _backdropDrawCount++;
        }
    }

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
        // descendants. Covers SPA navigation and any untracked wrapper anim.
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
                // Do NOT prime from entry.boundingClientRect — it was captured at
                // intersection-change time (past), while window.scrollY is "now".
                // collectPanels will issue a fresh read via _rectFresh[i] = 0.
                if (!entry.isIntersecting) _rectFresh[i] = 0;
            }
        }, { rootMargin: '200px 0px', threshold: 0 })
        : null;

    // Panel-level ResizeObserver: catches layout changes not covered by
    // animation / transition / scroll — e.g. sync button's textContent flipping
    // ("Sync" -> "Updating 5/100…") which reflows the flex row. Invalidate ALL
    // _rectFresh because a flex reflow shifts siblings without resizing them.
    var _glassRO = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(function () {
            if (_cachedEls.length === 0) return;
            _rectFresh.fill(0);
            _anyAnimating = true;
        })
        : null;

    // Walks offsetParents to compute document-relative top. offsetTop is unaffected
    // by sticky displacement (which is a paint-time effect), so this gives the
    // panel's "at-rest" position regardless of current scroll.
    function _refreshStickyDocGeom(idx, el) {
        var top = 0;
        var node = el;
        while (node) { top += node.offsetTop || 0; node = node.offsetParent; }
        _stickyNaturalDocTop[idx] = top;
        var parent = el.parentElement || document.body;
        var pTop = 0;
        var pNode = parent;
        while (pNode) { pTop += pNode.offsetTop || 0; pNode = pNode.offsetParent; }
        _stickyParentDocBottom[idx] = pTop + (parent.offsetHeight || 0);
    }

    // Style-derived statics memo: radius, z-index, sticky/fixed, sticky-ancestor
    // and tier name never change for an element's lifetime here, but deriving
    // them costs getComputedStyle calls — including an ancestor walk that paid
    // ~5 of them PER ELEMENT. At 512 registered panels that was ~2,500
    // getComputedStyle calls (~48ms) on every re-cache, which infinite-scroll
    // appends now trigger routinely. The memo drops re-cache cost to O(new
    // elements). Cleared on resize (breakpoints can change radii); tier VALUES
    // stay a live lookup so theme switches keep working.
    var _elStaticMemo = new WeakMap();
    window.addEventListener('resize', function () { _elStaticMemo = new WeakMap(); }, { passive: true });

    function _elStatics(el) {
        var m = _elStaticMemo.get(el);
        if (m) return m;
        var style = getComputedStyle(el);
        var pos = style.position;
        m = {
            radius: ((parseFloat(style.borderTopLeftRadius) || 0) +
                (parseFloat(style.borderTopRightRadius) || 0) +
                (parseFloat(style.borderBottomLeftRadius) || 0) +
                (parseFloat(style.borderBottomRightRadius) || 0)) * 0.25,
            z: parseFloat(style.zIndex) || 0,
            sticky: pos === 'sticky' ? 1 : 0,
            fixed: pos === 'fixed' ? 1 : 0,
            stickyTop: pos === 'sticky' ? (parseFloat(style.top) || 0) : 0,
            stickyAnc: 0,
            tierName: getTierName(el),
            reveal: el.matches(REVEAL_SEL) ? 1 : 0
        };
        // Ancestor position detection — static children of sticky parents need
        // the stuck-offset compensation (see collectPanels), and static children
        // of FIXED parents (captures select-bar buttons) are viewport-anchored:
        // without inheriting the fixed flag they get doc-space coordinates
        // (rect.top + scrollY) and render as glass pinned mid-document.
        if (!m.sticky && !m.fixed) {
            var anc = el.parentElement;
            while (anc && anc !== document.body) {
                var ancPos = getComputedStyle(anc).position;
                if (ancPos === 'sticky') { m.stickyAnc = 1; break; }
                if (ancPos === 'fixed') { m.fixed = 1; break; }
                anc = anc.parentElement;
            }
        }
        _elStaticMemo.set(el, m);
        return m;
    }

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
        _backdrop.resetBindings();
        if (_glassIO) _glassIO.disconnect();
        if (_glassRO) _glassRO.disconnect();
        _elIndex.clear();
        _ancestorToIdx.clear();
        _inViewport.fill(1);
        _animActive.fill(0);
        if (_isMobile) { panelCount = 0; return; }
        if (!_mainEl) _mainEl = document.querySelector('main');

        // Over MAX_CACHED (deep infinite scroll), keep the candidates nearest
        // the viewport instead of the first 512 in document order — otherwise
        // every row/card below ~page 9 silently renders without glass.
        var els = core.selectCacheWindow(document.querySelectorAll(GLASS_SEL), MAX_CACHED);
        for (var i = 0; i < els.length && _cachedEls.length < MAX_CACHED; i++) {
            var el = els[i];
            var closestArt = el.closest('article');
            if (closestArt && el !== closestArt && el.matches('select, input, textarea') && !el.closest('.tracking-form')) continue;
            // aria-hidden subtrees are invisible-but-laid-out UI (e.g. the closed
            // captures select bar) — drawing glass for them produces orphan pills.
            if (el.closest('[aria-hidden="true"]')) continue;
            var idx = _cachedEls.length;
            // Style-derived statics come from the per-element memo (see
            // _elStatics) — only elements never seen before pay getComputedStyle.
            var st = _elStatics(el);
            _cachedRadius[idx] = st.radius;
            _cachedTierValues[idx] = getTierValues(st.tierName);
            _cachedReveal[idx] = st.reveal;
            _cachedZIndex[idx] = st.z;
            _cachedSticky[idx] = st.sticky;
            _cachedFixed[idx] = st.fixed;
            if (st.sticky) {
                _stickyTopOffset[idx] = st.stickyTop;
                _refreshStickyDocGeom(idx, el);
            }
            _cachedStickyAnc[idx] = st.stickyAnc;
            // Cache whether element participates in entrance animations
            var cl = el.classList;
            _cachedHasAnim[idx] = (cl.contains('anim-blur-rise') || cl.contains('anim-drop') ||
                cl.contains('anim-pop') || cl.contains('anim-blur-scale') ||
                cl.contains('anim-slide-blur') || cl.contains('anim-grow')) ? 1 : 0;
            _cachedAnimIn[idx] = cl.contains('animate-in') ? 1 : 0;
            // For elements without own anim class, find nearest animating ancestor
            _cachedAnimAncestor[idx] = _cachedHasAnim[idx] ? null
                : el.parentElement && el.parentElement.closest('.anim-blur-rise,.anim-drop,.anim-pop,.anim-blur-scale,.anim-slide-blur,.anim-grow');
            // Cache whether element is inside <main> (for exit animation detection)
            _cachedInMain[idx] = (_mainEl && _mainEl.contains(el)) ? 1 : 0;
            _backdrop.bindPanel(idx, el);
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
        // BETWEEN glass panels (sync-progress text, etc.). No glass panel resizes,
        // only shifts — container-height change is the only signal.
        if (_glassRO) {
            var _layoutRoot = _mainEl || document.body;
            if (_layoutRoot) _glassRO.observe(_layoutRoot);
        }
        // Cold start: seed per-panel _animActive from currently-running animations
        // (animationstart events were missed before module evaluated).
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

    // Temp arrays for z-sorted panel collection (reused each frame)
    var _sortIndices = new Int32Array(MAX_PANELS);
    var _sortZ       = new Float32Array(MAX_PANELS);
    var _sortRects   = new Float32Array(MAX_PANELS * 4);
    var _sortExtra   = new Float32Array(MAX_PANELS * 4);
    var _sortOR      = new Float32Array(MAX_PANELS * 2);
    // Per-visible-panel scrollMul: 1.0 stable (rect.y is doc-top), 0.0 otherwise.
    var _sortMul     = new Float32Array(MAX_PANELS);
    var _sortBlur    = new Float32Array(MAX_PANELS); // per-panel tier blur LOD → aBlurLod

    // Per-frame opacity cache. Mirrors glass-webgpu.js: when N glass panels share
    // an animation ancestor (entrance cascade in a captures-game-group, dashboard
    // region, etc.), the first panel pays the gCS cost and the rest reuse the
    // parsed value instead of triggering N forced style recalcs on the same node.
    var _opacityCache = new Map();

    function collectPanels(curScrollY) {
        // Bare calls from initial render, visibilitychange, and prewarmGlassPanels
        // need a real scroll sample — undefined propagates to _rectDocTop as NaN
        // and poisons the rect cache on the next frame. Mirrors glass-webgpu.js.
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
        // Per-panel _animActive + _rectFresh invalidation cover entrance cascades,
        // spawns, IO visibility flips, and ancestor-anim fallbacks — no safety net needed.
        var freshRead = !_rectValid || mainExiting;

        // Reset the per-frame opacity cache (.clear() retains capacity, no allocations).
        _opacityCache.clear();

        for (var i = 0; i < _cachedEls.length; i++) {
            if (visCount >= MAX_PANELS) break;
            if (_cachedHasAnim[i]) {
                var hasAnimIn = _cachedEls[i].classList.contains('animate-in');
                if (!_cachedAnimIn[i]) {
                    if (hasAnimIn) {
                        _cachedAnimIn[i] = 1; _fullyOpaque[i] = 0;
                        // CSS animation about to run; animationstart fires async (next frame).
                        // Mark active + invalidate rect now so entrance keyframes re-read
                        // the moving rect every frame — avoids spawn-snap.
                        _animActive[i] = 1; _rectFresh[i] = 0; _anyAnimating = true;
                    } else continue;
                } else if (!hasAnimIn) {
                    // See glass-webgpu.js for rationale: must reset _cachedAnimIn[i] to 0 so
                    // a future class re-add (e.g. library view-toggle calling _resetAnimations
                    // then _reapplyEntranceDir) is detected as a fresh 0→1 entrance and
                    // re-arms _animActive + _rectFresh. Without this, glass panels stay parked
                    // at the start-of-entrance rect while CSS animates correctly.
                    _fullyOpaque[i] = 0;
                    _cachedAnimIn[i] = 0;
                }
            }

            if (_cachedAnimAncestor[i]) {
                if (!_cachedAnimAncestor[i].classList.contains('animate-in')) continue;
                if (!_animActive[i]) { _animActive[i] = 1; _rectFresh[i] = 0; _anyAnimating = true; }
            }

            if (mainExiting && _cachedInMain[i] && mainOpacity < 0.01) continue;

            // Viewport cull: skip offscreen panels (IntersectionObserver-driven).
            // Sticky panels bypass because their viewport position can change on scroll
            // even when the intersection state is stale between callbacks.
            if (!_inViewport[i] && !_cachedSticky[i]) continue;

            var isExiting = _cachedEls[i].classList.contains('exit');

            // Use cached rects when scroll-only; always re-read for fresh frames or animating panels.
            // Fixed panels keep the same viewport rect across scroll, so their cached
            // viewport-space top can be reused until some other invalidation lands.
            // Sticky panels: refresh doc geometry on layout-dirty, then derive viewport-top
            // arithmetically each frame (no per-frame getBoundingClientRect).
            var rLeft, rTop, rWidth, rHeight;
            var stickyArith = _cachedSticky[i] && !_animActive[i] && !isExiting && !freshRead;
            if (!stickyArith && (freshRead || isExiting || _animActive[i] || _cachedStickyAnc[i] || !_rectFresh[i])) {
                var rect = _cachedEls[i].getBoundingClientRect();
                rLeft = rect.left; rTop = rect.top; rWidth = rect.width; rHeight = rect.height;
                _rectLeft[i]   = rLeft;
                _rectDocTop[i] = _cachedFixed[i] ? rTop : (rTop + curScrollY);
                _rectWidth[i]  = rWidth;
                _rectHeight[i] = rHeight;
                _rectFresh[i]  = 1;   // time-consistent rect/scrollY pair now cached
            } else if (stickyArith) {
                // Refresh sticky doc geometry once after layout-dirty (also primes width/height/left).
                if (!_rectFresh[i]) {
                    _refreshStickyDocGeom(i, _cachedEls[i]);
                    var sRect = _cachedEls[i].getBoundingClientRect();
                    _rectLeft[i]   = sRect.left;
                    _rectWidth[i]  = sRect.width;
                    _rectHeight[i] = sRect.height;
                    _rectFresh[i]  = 1;
                }
                rLeft   = _rectLeft[i];
                rWidth  = _rectWidth[i];
                rHeight = _rectHeight[i];
                // viewportTop = clamp(stickyOffset, naturalDocTop - scrollY, parentDocBottom - h - scrollY)
                var unstuckTop = _stickyNaturalDocTop[i] - curScrollY;
                var pushedTop  = _stickyParentDocBottom[i] - rHeight - curScrollY;
                var stuckTop   = _stickyTopOffset[i];
                var capped     = stuckTop < pushedTop ? stuckTop : pushedTop;
                rTop           = unstuckTop > capped ? unstuckTop : capped;
            } else {
                rLeft   = _rectLeft[i];
                rTop    = _cachedFixed[i] ? _rectDocTop[i] : (_rectDocTop[i] - curScrollY);
                rWidth  = _rectWidth[i];
                rHeight = _rectHeight[i];
            }
            if (rWidth < 10 || rHeight < 10) continue;
            if (rTop + rHeight < -50 || rTop > vpH + 50) continue;
            if (rLeft + rWidth < -50 || rLeft > vpW + 50) continue;

            // Stable = no per-frame rect drift. Buffer stores doc-top, shader subtracts
            // uScrollY each frame. Cull/hit-test still use the local viewport rTop.
            var stable = !_cachedSticky[i] && !_cachedFixed[i] && !_animActive[i] && !isExiting && !_cachedStickyAnc[i];
            var idx4 = visCount * 4;
            _sortRects[idx4]     = rLeft;
            _sortRects[idx4 + 1] = stable ? _rectDocTop[i] : rTop;
            _sortRects[idx4 + 2] = rWidth;
            _sortRects[idx4 + 3] = rHeight;
            _sortMul[visCount]   = stable ? 1.0 : 0.0;

            var tv = _cachedTierValues[i];
            // Backdrop-bearing panels show real product imagery — soften the
            // per-tier sat/bright/tint so the picture comes through close to its
            // source instead of being darkened and oversaturated by the glass pass.
            var _tvSat = tv.sat, _tvBright = tv.bright, _tvTint = tv.tint, _tvBlur = tv.blur;
            if (_backdrop.cachedUrl[i]) {
                _tvSat = Math.min(_tvSat, 1.20);
                _tvBright = Math.max(_tvBright, 0.92);
                _tvTint = Math.min(_tvTint, 0.02);
                _tvBlur = -1.0; // sentinel: sample the sharp full-res RT_BACKDROP, not the blurred aurora
            }
            _sortExtra[idx4]     = Math.min(_cachedRadius[i], rWidth * 0.5, rHeight * 0.5);
            _sortExtra[idx4 + 1] = _tvSat;
            _sortExtra[idx4 + 2] = _tvBright;
            _sortExtra[idx4 + 3] = _tvTint;
            _sortBlur[visCount]  = _tvBlur;

            var animTarget = isExiting ? _cachedEls[i]
                : (_cachedHasAnim[i] ? _cachedEls[i] : _cachedAnimAncestor[i]);
            var or2 = visCount * 2;
            if (isExiting) {
                _fullyOpaque[i] = 0;
                var exitEl = _cachedEls[i];
                var cachedExit = _opacityCache.get(exitEl);
                if (cachedExit === undefined) {
                    cachedExit = parseFloat(getComputedStyle(exitEl).opacity);
                    _opacityCache.set(exitEl, cachedExit);
                }
                _sortOR[or2] = cachedExit;
            } else if (animTarget && !_fullyOpaque[i]) {
                var cached = _opacityCache.get(animTarget);
                if (cached === undefined) {
                    cached = parseFloat(getComputedStyle(animTarget).opacity);
                    _opacityCache.set(animTarget, cached);
                }
                _sortOR[or2] = cached;
                if (cached >= 0.99) _fullyOpaque[i] = 1;
            } else {
                _sortOR[or2] = 1.0;
            }
            // Apply main's exit opacity so glass fades with page transition
            if (mainExiting && _cachedInMain[i]) {
                _sortOR[or2] *= mainOpacity;
                _fullyOpaque[i] = 0;
            }
            _cachedOpacity[i] = _sortOR[or2];
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

        // Check if any panel has non-zero z (fast path: skip sort when all equal)
        var needsSort = false;
        for (var zi = 0; zi < visCount; zi++) {
            if (_sortZ[zi] !== 0) { needsSort = true; break; }
        }

        panelCount = visCount;
        // Cells beyond the previous upload boundary hold stale data that
        // was never on the GPU. Conditional-compare would falsely register them as
        // unchanged. Force-upload whenever panelCount grows.
        if (panelCount > _lastBuffPanelCount) _buffDirty = true;

        // CONTRACT: the cell lists in both branches below mirror those in glass-webgpu.js
        // (4 sites total). Adding/removing a panel field must update all four packs plus
        // the matching attribute setup, vertex shader inputs, and instanced buffers.
        if (needsSort) {
            // Sort by z-index (painter's algorithm: low z drawn first, high z on top)
            // Simple insertion sort — fast for nearly-sorted small arrays (typically <100 panels)
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

            // Conditional writes — only overwrite a cell if its new value
            // differs from the existing one (which mirrors the GPU's current contents).
            // Any miss flips _buffDirty=true; render() uploads only if dirty.
            for (var s = 0; s < visCount; s++) {
                var si = _sortIndices[s];
                var d4 = s * 4, s4 = si * 4;
                var d2 = s * 2, s2 = si * 2;
                var nv;
                nv = _sortRects[s4];      if (panelRectData[d4]      !== nv) { panelRectData[d4]      = nv; _buffDirty = true; }
                nv = _sortRects[s4 + 1];  if (panelRectData[d4 + 1]  !== nv) { panelRectData[d4 + 1]  = nv; _buffDirty = true; }
                nv = _sortRects[s4 + 2];  if (panelRectData[d4 + 2]  !== nv) { panelRectData[d4 + 2]  = nv; _buffDirty = true; }
                nv = _sortRects[s4 + 3];  if (panelRectData[d4 + 3]  !== nv) { panelRectData[d4 + 3]  = nv; _buffDirty = true; }
                nv = _sortExtra[s4];      if (panelExtraData[d4]     !== nv) { panelExtraData[d4]     = nv; _buffDirty = true; }
                nv = _sortExtra[s4 + 1];  if (panelExtraData[d4 + 1] !== nv) { panelExtraData[d4 + 1] = nv; _buffDirty = true; }
                nv = _sortExtra[s4 + 2];  if (panelExtraData[d4 + 2] !== nv) { panelExtraData[d4 + 2] = nv; _buffDirty = true; }
                nv = _sortExtra[s4 + 3];  if (panelExtraData[d4 + 3] !== nv) { panelExtraData[d4 + 3] = nv; _buffDirty = true; }
                nv = _sortOR[s2];         if (panelORData[d2]        !== nv) { panelORData[d2]        = nv; _buffDirty = true; }
                nv = _sortOR[s2 + 1];     if (panelORData[d2 + 1]    !== nv) { panelORData[d2 + 1]    = nv; _buffDirty = true; }
                nv = _sortMul[si];        if (panelMulData[s]        !== nv) { panelMulData[s]        = nv; _buffDirty = true; }
                nv = _sortBlur[si];       if (panelBlurData[s]       !== nv) { panelBlurData[s]       = nv; _buffDirty = true; }
            }
        } else {
            // No z-index variation — index in dest matches index in source.
            for (var p = 0; p < visCount; p++) {
                var pd4 = p * 4, pd2 = p * 2;
                var nv2;
                nv2 = _sortRects[pd4];      if (panelRectData[pd4]      !== nv2) { panelRectData[pd4]      = nv2; _buffDirty = true; }
                nv2 = _sortRects[pd4 + 1];  if (panelRectData[pd4 + 1]  !== nv2) { panelRectData[pd4 + 1]  = nv2; _buffDirty = true; }
                nv2 = _sortRects[pd4 + 2];  if (panelRectData[pd4 + 2]  !== nv2) { panelRectData[pd4 + 2]  = nv2; _buffDirty = true; }
                nv2 = _sortRects[pd4 + 3];  if (panelRectData[pd4 + 3]  !== nv2) { panelRectData[pd4 + 3]  = nv2; _buffDirty = true; }
                nv2 = _sortExtra[pd4];      if (panelExtraData[pd4]     !== nv2) { panelExtraData[pd4]     = nv2; _buffDirty = true; }
                nv2 = _sortExtra[pd4 + 1];  if (panelExtraData[pd4 + 1] !== nv2) { panelExtraData[pd4 + 1] = nv2; _buffDirty = true; }
                nv2 = _sortExtra[pd4 + 2];  if (panelExtraData[pd4 + 2] !== nv2) { panelExtraData[pd4 + 2] = nv2; _buffDirty = true; }
                nv2 = _sortExtra[pd4 + 3];  if (panelExtraData[pd4 + 3] !== nv2) { panelExtraData[pd4 + 3] = nv2; _buffDirty = true; }
                nv2 = _sortOR[pd2];         if (panelORData[pd2]        !== nv2) { panelORData[pd2]        = nv2; _buffDirty = true; }
                nv2 = _sortOR[pd2 + 1];     if (panelORData[pd2 + 1]    !== nv2) { panelORData[pd2 + 1]    = nv2; _buffDirty = true; }
                nv2 = _sortMul[p];          if (panelMulData[p]         !== nv2) { panelMulData[p]         = nv2; _buffDirty = true; }
                nv2 = _sortBlur[p];         if (panelBlurData[p]        !== nv2) { panelBlurData[p]        = nv2; _buffDirty = true; }
            }
        }
    }

    // ====================================================================
    // Render pipeline
    // ====================================================================
    function setAuroraUniforms() {
        for (var i = 0; i < 5; i++) {
            gl.uniform2f(auroraU.nodes[i], nodes[i].x, nodes[i].y);
            gl.uniform3f(auroraU.colors[i], nodes[i].lr, nodes[i].lg, nodes[i].lb);
            gl.uniform1f(auroraU.k[i], nodes[i].k);
        }
    }

    // Aurora throttle: nodes move ~0.003 units/frame, so rendering aurora+blur
    // every 2nd frame is visually identical. Glass panels still update rects at 60fps.
    var _auroraFrame = 0;
    var _lastRenderMouseX = -9999, _lastRenderMouseY = -9999;
    var _lastRenderScrollY = 0;

    function render(doAurora, frameScrollY) {
        // Pass 1+2: Aurora + Blur — only every 2nd frame, controlled by frame()
        if (doAurora) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboAurora);
            gl.viewport(0, 0, halfW, halfH);
            gl.useProgram(auroraProg);
            gl.bindVertexArray(auroraVAO);
            setAuroraUniforms();
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindVertexArray(null);

            // Pass 1b: Backdrop art → FBO_BACKDROP (full-res, screen-space), cleared
            // transparent each aurora frame. Art panels sample this sharp; the aurora
            // itself stays a pure gradient so it blurs cleanly. Pre-multiplied alpha.
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboBackdrop);
            gl.viewport(0, 0, vpW, vpH);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (_backdropDrawCount > 0) {
                gl.useProgram(backdropProg);
                gl.bindVertexArray(backdropVAO);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.uniform2f(backdropU.vp, vpW, vpH);
                gl.uniform1i(backdropU.tex, 0);
                gl.activeTexture(gl.TEXTURE0);
                for (var bd = 0; bd < _backdropDrawCount; bd++) {
                    var d4 = bd * 4;
                    gl.uniform4f(backdropU.rect,
                        _backdropDrawRect[d4],     _backdropDrawRect[d4 + 1],
                        _backdropDrawRect[d4 + 2], _backdropDrawRect[d4 + 3]);
                    var bdEntry = _backdropDrawTex[bd];
                    gl.uniform4f(backdropU.radii,
                        _backdropDrawRadius[bd],
                        _backdropDrawOpacity[bd],
                        bdEntry.aspect || 1.0,
                        0.0);
                    gl.bindTexture(gl.TEXTURE_2D, bdEntry.tex);
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                }
                gl.disable(gl.BLEND);
                gl.bindVertexArray(null);
            }
            // Signal CSS layer that GPU is drawing backdrops — CSS overlay hides
            // while its own GPU draw is firing; flips back off on LRU eviction or
            // panel removal.
            var clsHas = document.documentElement.classList.contains('glass-refract-bd-active');
            var clsWant = _backdropDrawCount > 0;
            if (clsWant && !clsHas) document.documentElement.classList.add('glass-refract-bd-active');
            else if (!clsWant && clsHas) document.documentElement.classList.remove('glass-refract-bd-active');

            // Adaptive Gaussian blur pyramid (liquid-dom). Level 0: separable
            // Gaussian over the aurora — H (→B.0) then V (→A.0). Each higher level:
            // H reads the finer level A.(L-1) at the coarser texel size (downsample
            // folded into the blur) → B.L; V blurs B.L → A.L. A holds all levels;
            // glass selects a fractional level per tier via LOD.
            gl.useProgram(gaussProg);
            gl.bindVertexArray(gaussVAO);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(gaussU.tex, 0);

            function gaussPass(fbo, srcTex, dimW, dimH, dirX, dirY, srcLod) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.viewport(0, 0, dimW, dimH);
                gl.bindTexture(gl.TEXTURE_2D, srcTex);
                gl.uniform2f(gaussU.texelSize, 1.0 / dimW, 1.0 / dimH);
                gl.uniform2f(gaussU.dir, dirX, dirY);
                gl.uniform1f(gaussU.srcLod, srcLod);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }

            // Level 0 (half-res).
            gaussPass(fboBlurB[0], texAurora, halfW, halfH, 1.0, 0.0, 0.0); // H
            gaussPass(fboBlurA[0], texBlurB,  halfW, halfH, 0.0, 1.0, 0.0); // V
            // Higher levels.
            for (var L = 1; L < blurMipCount; L++) {
                var td = mipDims(L);
                // H reads finer level L-1 of A at the coarser texel size → B.L.
                gaussPass(fboBlurB[L], texBlurA, td[0], td[1], 1.0, 0.0, L - 1);
                // V blurs B.L at its own resolution → A.L.
                gaussPass(fboBlurA[L], texBlurB, td[0], td[1], 0.0, 1.0, L);
            }
            gl.bindVertexArray(null);
        }

        // Upload panel VBOs now so BOTH the slope prepass and the glass pass read this
        // frame's positions (the slope prepass reuses the glass VS).
        // Capture buffer dirtiness BEFORE the upload consumes it — it's one of
        // the slope field's staleness inputs.
        var panelsChanged = _buffDirty;
        if (panelCount > 0 && _buffDirty) {
            gl.bindBuffer(gl.ARRAY_BUFFER, panelRectBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelRectData.subarray(0, panelCount * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelExtraBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelExtraData.subarray(0, panelCount * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelORBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelORData.subarray(0, panelCount * 2));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelMulBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelMulData.subarray(0, panelCount));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelBlurBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelBlurData.subarray(0, panelCount));
            _lastBuffPanelCount = panelCount;
            _buffDirty = false;
        }

        // Pass 2c: Slope field — prepass renders each panel's bevel slope into
        // texSlope, then a separable Gaussian (H→scratch, V→texSlope) so the glass
        // pass reads a clean normal. Gated on its actual inputs (panel cells /
        // scrollY / panelCount / FBO recreation): on idle aurora frames panels are
        // static and the cached field is byte-identical, so the three half-res
        // RGBA16F passes are skipped entirely.
        if (panelCount > 0 &&
            (panelsChanged || !_slopeValid ||
             _slopeScrollY !== frameScrollY || _slopePanelCount !== panelCount)) {
            _slopeValid = true;
            _slopeScrollY = frameScrollY;
            _slopePanelCount = panelCount;
            gl.useProgram(slopeProg);
            gl.uniform2f(slopeU.viewport, vpW, vpH);
            gl.uniform1f(slopeU.scrollY, frameScrollY);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboSlope);
            gl.viewport(0, 0, slopeW, slopeH);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied
            gl.bindVertexArray(slopeVAO);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, panelCount);
            gl.bindVertexArray(null);
            gl.disable(gl.BLEND);

            // Blur the slope field (separable Gaussian: H → scratch, V → slope).
            gl.useProgram(gaussProg);
            gl.bindVertexArray(gaussVAO);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(gaussU.tex, 0);
            gl.uniform1f(gaussU.srcLod, 0.0);
            gl.uniform2f(gaussU.texelSize, 1.0 / slopeW, 1.0 / slopeH);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboSlopeScratch);
            gl.viewport(0, 0, slopeW, slopeH);
            gl.bindTexture(gl.TEXTURE_2D, texSlope);
            gl.uniform2f(gaussU.dir, 1.0, 0.0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboSlope);
            gl.viewport(0, 0, slopeW, slopeH);
            gl.bindTexture(gl.TEXTURE_2D, texSlopeScratch);
            gl.uniform2f(gaussU.dir, 0.0, 1.0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindVertexArray(null);
        }

        // Pass 3: Composite → screen (full viewport)
        // No gl.clear needed — blit quad overwrites every pixel
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, vpW, vpH);

        // 3a: Full-screen quad draws aurora from FBO_AURORA (bilinear upscale)
        gl.useProgram(blitProg);
        gl.bindVertexArray(blitVAO);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texAurora);
        gl.uniform1i(blitU.tex, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        // 3b: Glass panel quads (instanced) — full glass material replaces aurora
        if (panelCount > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            gl.useProgram(glassProg);
            gl.uniform2f(glassU.viewport, vpW, vpH);
            gl.uniform2f(glassU.mouse, _mouseX, _mouseY);
            gl.uniform1f(glassU.time, _time);
            gl.uniform1f(glassU.scrollY, frameScrollY);   // VS subtracts scrollY * scrollMul

            // Bind the blur pyramid (texBlurA holds all levels; the shader selects
            // a per-tier fractional level via LOD).
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texBlurA);
            gl.uniform1i(glassU.blurTex, 0);
            // Bind the sharp full-res backdrop (art panels sample this when blurLod < 0).
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, texBackdrop);
            gl.uniform1i(glassU.backdropTex, 1);
            // Bind the blurred slope field (clean refraction normal).
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, texSlope);
            gl.uniform1i(glassU.slopeTex, 2);

            gl.bindVertexArray(glassVAO);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, panelCount);
            gl.bindVertexArray(null);

            gl.disable(gl.BLEND);
        }
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

        if (document.hidden) return; // rAF barely fires here anyway — belt and braces

        // Drive Lenis and drain queued row mutations BEFORE the pause gate:
        // pauseGlass() exists to keep GPU work off the nav critical path, but the
        // pause spans the whole SPA fetch window (exit anim -> response -> swap) —
        // scroll must stay alive through it. lenis.raf is ~free when not scrolling.
        window.__glassDrivesLenis = true;
        if (window.lenis && !window.__lenisOwnRaf) window.lenis.raf(t);
        var q = window.__rowMutationQueue;
        if (q && q.length) {
            for (var mi = 0; mi < q.length; mi++) { try { q[mi](); } catch (_) {} }
            q.length = 0;
        }

        // Skip all GPU/render work while paused (SPA nav) or hidden (tab switch).
        // Canvas holds its last presented frame — no blank flash, zero GPU submissions.
        if (_glassPaused) return;

        _frameDt = _prevFrameTime ? Math.min((t - _prevFrameTime) * 0.001, 0.1) : 0.016;
        _prevFrameTime = t;
        _time = t * 0.001;
        _simTime += _frameDt;  // advances by at most 100ms per frame — never wall-clock jumps

        resizeFBOs();
        updatePhysics(_simTime);

        // Determine aurora parity before any early-return so the counter stays accurate.
        var doAurora = (_auroraFrame++ & 1) === 0;

        // Cooldown: skip heavy layout work for a few frames after DOM changes
        if (_layoutCooldown > 0) { _layoutCooldown--; render(doAurora, _cachedScrollY); return; }

        // Read scroll from Lenis's tracked value. Reading window.scrollY here forces
        // a synchronous layout because lenis.raf above has dirtied style state with
        // smooth-scroll writes. lenis.scroll is the animated scroll target Lenis just
        // settled to in its rAF tick — a plain number property, no layout query, and
        // bit-for-bit what the next paint will show. Fallback to window.scrollY only
        // when Lenis isn't loaded yet.
        var lenis = window.lenis;
        var frameScrollY = lenis ? lenis.scroll : window.scrollY;
        _cachedScrollY = frameScrollY;

        // Fast-path idle skip: if no animations are running, scroll/mouse are unchanged,
        // and this isn't an aurora frame, skip collectPanels + render entirely.
        if (!doAurora && !_anyAnimating &&
            frameScrollY === _lastRenderScrollY &&
            _mouseX === _lastRenderMouseX && _mouseY === _lastRenderMouseY) return;

        // Rebuild the panel cache only on frames that will actually render. Aurora
        // frames bypass the early-return above, so cache stays in sync within ≤16ms
        // of any DOM mutation that flipped _layoutDirty.
        // Windowed registry (infinite scroll): when the cache was capped to a
        // window around the viewport, re-center it as the user nears its edge.
        // Scroll frames never take the idle early-return above, so this check
        // runs on every frame where it could possibly flip.
        if (core.cacheWindowStale(frameScrollY, window.innerHeight)) _layoutDirty = true;
        if (_layoutDirty) cacheElements();

        collectPanels(frameScrollY);
        _collectBackdrops(frameScrollY);

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

        render(doAurora, frameScrollY);
        _lastRenderScrollY = frameScrollY;
        _lastRenderMouseX = _mouseX;
        _lastRenderMouseY = _mouseY;
    }

    // ====================================================================
    // Initial render — deferred one frame so the browser can paint LCP first.
    // Canvas starts hidden (opacity:0) with CSS aurora visible underneath,
    // so users see the background immediately; glass overlay fades in next frame.
    // ====================================================================
    requestAnimationFrame(function () {
        resizeFBOs();
        updatePhysics(0);
        cacheElements();
        var initScY = window.scrollY;
        collectPanels(initScY);
        _auroraFrame = 0; // ensure first render includes aurora pass
        render(true, initScY);

        // First frame rendered — fade in canvas over the CSS aurora
        canvas.style.opacity = '1';
        var _hideStyle = document.getElementById('aurora-canvas-hide');
        if (_hideStyle) _hideStyle.remove();

        if (!reduced) requestAnimationFrame(frame);
    });

    // ====================================================================
    // Events: re-cache elements on layout changes (rects read every frame)
    // ====================================================================
    window.addEventListener('resize', function () { _layoutDirty = true; });

    // Font-swap layout-dirty trigger. font-display:swap can repaint text after the
    // ResizeObserver-on-<main> has settled — if main height stays constant but
    // sibling widths shift, the RO fire is unreliable. fonts.ready settles after
    // every font-loading round, so a one-shot rect invalidation here closes the
    // gap. Re-arms via fonts.addEventListener('loadingdone') for late web fonts.
    if (document.fonts) {
        document.fonts.ready.then(function () { _rectValid = false; _rectFresh.fill(0); });
        document.fonts.addEventListener('loadingdone', function () {
            _rectValid = false; _rectFresh.fill(0);
        });
    }

    // _cachedScrollY's only consumer today is the brief _layoutCooldown path. frame()
    // updates it once per tick from the same window.scrollY read it does for itself,
    // so the previous external listeners (scroll/htmx:afterSwap/pageshow) that used
    // to keep this in sync are gone — they were reading window.scrollY during
    // layout-dirty windows and forcing reflows.
    var _cachedScrollY = window.scrollY;

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            resizeFBOs();
            _layoutDirty = true;
            _prevFrameTime = 0;
            updatePhysics(_simTime);  // resume from where simulation left off — no jump
            // One-time scroll read on visibility resume; pass through everywhere so
            // render() gets a defined scrollY rather than implicitly relying on
            // frame()'s closure.
            var scY = window.scrollY;
            cacheElements();
            collectPanels(scY);
            render(true, scY); // force aurora on visibility resume for a fresh frame
            _cachedScrollY = scY;
        }
    });

    // ====================================================================
    // sessionStorage persistence (aurora node positions)
    // ====================================================================
    window.addEventListener('pagehide', function () {
        try {
            sessionStorage.setItem('aurora', JSON.stringify(nodes.map(function (n) {
                return { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
            })));
        } catch (e) {}
    });

    // ====================================================================
    // Public API: called by view toggles in app.js
    // ====================================================================
    var _glassPaused = false;
    var _layoutCooldown = 0;
    var _panelUpdateQueued = false;
    window.updateGlassPanels = function () {
        if (_panelUpdateQueued) return;
        _panelUpdateQueued = true;
        requestAnimationFrame(function () {
            _panelUpdateQueued = false;
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
    window.invalidateGlassRects = function () { _rectValid = false; };

    // ====================================================================
    // Mobile: disable glass panels, toggle .glass-refract class
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

})();
