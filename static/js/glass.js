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

    document.documentElement.classList.add('glass-refract');

    // ====================================================================
    // Constants
    // ====================================================================
    var PI = Math.PI, TAU = PI * 2;
    var HALF_RES = 4;          // quarter-res aurora + blur (smooth gradient upscales cleanly)
    var BLUR_PASSES = 2;
    var MAX_PANELS = 128;   // max panels drawn per frame
    var MAX_CACHED = 512;   // max elements tracked (all glass-eligible DOM elements)
    var IOR = 1.52;
    var THICKNESS = 85.0;
    var BEZEL = 60.0;
    var SPECULAR = 0.50;

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

    var BLIT_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vUV;\n' +
        'out vec4 fragColor;\n' +
        'uniform sampler2D uTex;\n' +
        // Interleaved gradient noise (Jorge Jimenez, 2014) — no texture tap, no banding
        'float ign(vec2 p){\n' +
        '  return fract(52.9829189*fract(dot(p,vec2(0.06711056,0.00583715))));\n' +
        '}\n' +
        'void main(){\n' +
        '  vec3 col=texture(uTex,vUV).rgb;\n' +
        // Dither: ±0.5/255 triangular noise to break 8-bit banding
        '  float n=ign(gl_FragCoord.xy);\n' +
        '  col+=(n-0.5)/255.0;\n' +
        '  fragColor=vec4(col,1.0);\n' +
        '}\n';

    var BLUR_FS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 vUV;\n' +
        'out vec4 fragColor;\n' +
        'uniform sampler2D uTex;\n' +
        'uniform vec2 uTexelSize;\n' +
        'uniform float uOffset;\n' +
        'void main(){\n' +
        '  vec2 o=(uOffset+0.5)*uTexelSize;\n' +
        '  fragColor=0.25*(\n' +
        '    texture(uTex,vUV+vec2(-o.x,-o.y))+\n' +
        '    texture(uTex,vUV+vec2(-o.x, o.y))+\n' +
        '    texture(uTex,vUV+vec2( o.x,-o.y))+\n' +
        '    texture(uTex,vUV+vec2( o.x, o.y)));\n' +
        '}\n';

    var SHADOW_MARGIN = 6.0;  // px — quad expansion for drop shadow

    var GLASS_VS =
        '#version 300 es\n' +
        'precision mediump float;\n' +
        'in vec2 aPos;\n' +
        'in vec4 aPanelRect;\n' +   // x,y,w,h in pixels (instanced)
        'in vec4 aPanelExtra;\n' +  // radius, saturation, brightness, tintAlpha (instanced)
        'in vec2 aOpacReveal;\n' +    // x=CSS opacity, y=reveal flag (instanced)
        'uniform vec2 uViewport;\n' +
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
        'void main(){\n' +
        '  vec2 hs=aPanelRect.zw*0.5;\n' +
        '  vec2 ctr=aPanelRect.xy+hs;\n' +
        // Expand quad by shadow margin so exterior drop shadow has room to render
        '  vec2 hsExpanded=hs+' + SHADOW_MARGIN.toFixed(1) + ';\n' +
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
        'uniform sampler2D uBlurTex;\n' +
        'uniform vec2 uViewport;\n' +
        'uniform vec2 uMouse;\n' +       // screen-space mouse position (px)
        'uniform float uTime;\n' +
        'out vec4 fragColor;\n' +
        // Rounded box SDF
        'float rboxSDF(vec2 p,vec2 b,float r){\n' +
        '  vec2 q=abs(p)-b+r;\n' +
        '  return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r;\n' +
        '}\n' +
        // Quartic dome surface profile (from original liquid glass)
        'float surfaceHeight(float t){\n' +
        '  float s=1.0-t;\n' +
        '  return sqrt(sqrt(1.0-s*s*s*s));\n' +
        '}\n' +
        'void main(){\n' +
        '  float sd=rboxSDF(vLocalPos,vPanelSize,vRadius);\n' +
        // Drop shadow outside glass (gaussian falloff, matches original)
        '  if(sd>0.0){\n' +
        '    if(sd>' + SHADOW_MARGIN.toFixed(1) + ')discard;\n' +
        '    float shadowFalloff=exp(-sd*sd/18.0);\n' +
        '    float shadowAlpha=0.08*shadowFalloff;\n' +
        '    fragColor=vec4(0.0,0.0,0.0,shadowAlpha*vOpacity);\n' +
        '    return;\n' +
        '  }\n' +
        // Edge alpha — match original: 1.5px soft ramp from boundary inward
        '  float distFromEdge=-sd;\n' +
        '  float alpha=smoothstep(0.0,1.5,distFromEdge);\n' +
        // Bezel zone — match original: min(bezel, min(radius, min(halfW, halfH)) - 1)
        '  float bezel=min(' + BEZEL.toFixed(1) + ',min(vRadius,min(vPanelSize.x,vPanelSize.y))-1.0);\n' +
        '  float t=clamp(distFromEdge/bezel,0.0,1.0);\n' +
        // Surface height + numerical derivative for slope
        '  float h=surfaceHeight(t);\n' +
        '  float dt=0.001;\n' +
        '  float h2=surfaceHeight(min(t+dt,1.0));\n' +
        '  float dh=(h2-h)/dt;\n' +
        // Depth-varying thickness (thicker at edges → stronger refraction in bezel zone)
        '  float thicknessLocal=' + THICKNESS.toFixed(1) + '*(1.0+(1.0-h*h)*0.4);\n' +
        // Snell's law refraction (algebraic — eliminates atan, sin, asin, 2×tan)
        '  float x_s=dh*(thicknessLocal/bezel);\n' +
        '  float invSqrtX2p1=inversesqrt(1.0+x_s*x_s);\n' +
        '  float sinI=x_s*invSqrtX2p1;\n' +
        '  float sinR=sinI/' + IOR.toFixed(1) + ';\n' +
        '  sinR=clamp(sinR,-1.0,1.0);\n' +
        '  float cosR=sqrt(1.0-sinR*sinR);\n' +
        '  float displacement=h*thicknessLocal*(x_s-sinR/max(cosR,0.001));\n' +
        // Fresnel (Schlick's approximation — edge reflectivity vs center transparency)
        '  float cosTheta=invSqrtX2p1;\n' +
        '  float omc=1.0-cosTheta;\n' +
        '  float omc2=omc*omc;\n' +
        '  float fresnel=0.04+0.96*omc2*omc2*omc;\n' +
        // Analytical SDF gradient (eliminates 2 rboxSDF calls per fragment)
        '  vec2 q_g=abs(vLocalPos)-vPanelSize+vRadius;\n' +
        '  vec2 grad;\n' +
        '  if(q_g.x>0.0&&q_g.y>0.0){\n' +
        '    grad=sign(vLocalPos)*normalize(q_g);\n' +
        '  }else if(q_g.x>q_g.y){\n' +
        '    grad=vec2(sign(vLocalPos.x),0.0);\n' +
        '  }else{\n' +
        '    grad=vec2(0.0,sign(vLocalPos.y));\n' +
        '  }\n' +
        // Refraction displacement with per-channel chromatic aberration
        '  vec2 baseOffset=-grad*displacement/uViewport;\n' +
        '  vec3 blurred=vec3(\n' +
        '    texture(uBlurTex,vBlurUV+baseOffset*1.006).r,\n' +
        '    texture(uBlurTex,vBlurUV+baseOffset).g,\n' +
        '    texture(uBlurTex,vBlurUV+baseOffset*0.998).b\n' +
        '  );\n' +
        // 2. Saturation boost
        '  float lum=dot(blurred,vec3(0.2126,0.7152,0.0722));\n' +
        '  vec3 saturated=mix(vec3(lum),blurred,vSaturation);\n' +
        // 3. Brightness multiply
        '  vec3 transmitted=saturated*vBrightness;\n' +
        '  float rimFalloff=1.0-smoothstep(0.0,bezel*0.4,distFromEdge);\n' +
        // 4. Energy conservation: transmitted light reduces as Fresnel reflection increases
        '  transmitted*=(1.0-fresnel);\n' +
        // 5. Beer's law absorption — applied after Fresnel (only absorbed light is transmitted light)
        '  float absorption=(1.0-h)*0.06;\n' +
        '  transmitted*=mix(vec3(1.0),vec3(0.96,0.97,1.0),absorption);\n' +
        // 6. Frosted glass scattering (tintAlpha is per-panel haze, independent of Fresnel)
        '  vec3 col=mix(transmitted,vec3(1.0),vTintAlpha);\n' +
        // 7. Inner shadow — applied before specular so it only darkens transmitted light
        '  float innerShadow=1.0-smoothstep(0.0,bezel*0.6,distFromEdge);\n' +
        '  col*=mix(1.0,0.7,innerShadow*0.3);\n' +
        // 8. Anisotropic specular — highlights stretch along edge tangent
        '  float rimDot=abs(dot(grad,vec2(0.5812,-0.8137)));\n' +
        '  vec2 tangent=vec2(-grad.y,grad.x);\n' +
        '  float tangentDot=abs(dot(tangent,vec2(0.5812,-0.8137)));\n' +
        '  float aniso=mix(rimDot,tangentDot,0.15);\n' +
        '  float rimBase=aniso*rimFalloff;\n' +
        '  float specHighlight=rimBase*sqrt(rimBase);\n' +
        '  col+=vec3(specHighlight*' + SPECULAR.toFixed(2) + '*(0.3+0.7*fresnel));\n' +
        // 9. Inner rim (thin bright line just inside edge, from original)
        '  float innerRim=smoothstep(0.0,2.0,distFromEdge)*(1.0-smoothstep(2.0,5.0,distFromEdge));\n' +
        '  col+=vec3(innerRim*0.15*' + SPECULAR.toFixed(2) + ');\n' +
        // 10. Fake environment reflection — subtle sky gradient modulated by Fresnel
        '  float envUp=grad.y*-0.5+0.5;\n' +
        '  vec3 envColor=mix(vec3(0.6,0.65,0.75),vec3(0.85,0.9,1.0),envUp);\n' +
        '  col+=envColor*fresnel*0.03;\n' +
        // Edge prismatic dispersion — additive colored rim where refraction is steepest
        // Pointer reveal — early exit when no reveal active (saves 9 exp() on ~70% of fragments)
        '  if(vReveal>0.001){\n' +
        '    vec2 panelCenter=vScreenPos-vLocalPos;\n' +
        '    vec2 mouseLocal=uMouse-panelCenter;\n' +
        '    vec2 refractedPos=vLocalPos-grad*displacement*0.18;\n' +
        '    float fragDist=length(refractedPos-mouseLocal);\n' +
        '    float panelDiag=length(vPanelSize);\n' +
        '    float ps=max(panelDiag/280.0,0.25);\n' +
        '    float ps2=ps*ps;\n' +
        '    float caustic=1.0+abs(dh)*h*1.5;\n' +
        '    float d2=fragDist*fragDist;\n' +
        '    float g0=exp(-d2/(80.0*ps2));\n' +
        '    float g1=exp(-d2/(250.0*ps2));\n' +
        '    float g2=exp(-d2/(800.0*ps2));\n' +
        '    float g3=exp(-d2/(2500.0*ps2));\n' +
        '    float g4=exp(-d2/(8000.0*ps2));\n' +
        '    float g5=exp(-d2/(25000.0*ps2));\n' +
        '    float g6=exp(-d2/(80000.0*ps2));\n' +
        '    float g7=exp(-d2/(250000.0*ps2));\n' +
        '    float surfaceMod=h*h;\n' +
        '    vec3 revealLight=(\n' +
        '      vec3(0.85,1.0,0.88)*g0*1.8+\n' +
        '      vec3(0.60,0.98,0.70)*g1*1.2+\n' +
        '      vec3(0.38,0.94,0.52)*g2*0.85+\n' +
        '      vec3(0.22,0.88,0.40)*g3*0.60+\n' +
        '      vec3(0.12,0.75,0.32)*g4*0.40+\n' +
        '      vec3(0.06,0.55,0.22)*g5*0.25+\n' +
        '      vec3(0.03,0.38,0.14)*g6*0.15+\n' +
        '      vec3(0.01,0.22,0.08)*g7*0.08\n' +
        '    )*caustic*surfaceMod;\n' +
        '    float revealTransmit=1.0-fresnel;\n' +
        '    col+=vReveal*revealLight*2.5*revealTransmit;\n' +
        '    float edgeProx=1.0-smoothstep(0.0,4.0,distFromEdge);\n' +
        '    float rimCaustic=abs(dh)*h*2.0;\n' +
        '    float rimDist=exp(-d2/(2000.0*ps2));\n' +
        '    col+=vReveal*vec3(0.2,0.9,0.45)*rimCaustic*rimDist*edgeProx*2.5*revealTransmit;\n' +
        '  }\n' +
        // 9. Ambient caustic shimmer — multi-layer interference like light through thick glass
        '  vec2 st=gl_FragCoord.xy*0.005;\n' +
        '  float t_s=uTime*0.35;\n' +
        '  float c1=sin(dot(st,vec2(1.0,0.7))+t_s);\n' +
        '  float c2=sin(dot(st,vec2(-0.8,1.1))+t_s*1.3+2.1);\n' +
        '  float c3=sin(dot(st,vec2(0.6,-0.9))*1.8+t_s*0.7+4.3);\n' +
        '  float causticRaw=c1+c2+c3;\n' +
        '  float causticBright=max(causticRaw-0.8,0.0);\n' +
        '  col+=col*causticBright*0.04;\n' +
        // 10. Surface grain (Interleaved Gradient Noise — better quality than sin-hash)
        '  float grain=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));\n' +
        '  col+=col*(grain-0.5)*0.04;\n' +
        // Output — alpha from SDF antialiasing, interior is opaque
        '  fragColor=vec4(col,alpha*vOpacity);\n' +
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
    var auroraProg = build(QUAD_VS, AURORA_FS);
    var blitProg   = build(QUAD_VS, BLIT_FS);
    var blurProg   = build(QUAD_VS, BLUR_FS);
    var glassProg  = build(GLASS_VS, GLASS_FS);

    if (!auroraProg || !blitProg || !blurProg || !glassProg) {
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
    var blurU = {
        tex: gl.getUniformLocation(blurProg, 'uTex'),
        texelSize: gl.getUniformLocation(blurProg, 'uTexelSize'),
        offset: gl.getUniformLocation(blurProg, 'uOffset')
    };
    var glassU = {
        aPos:      gl.getAttribLocation(glassProg, 'aPos'),
        panelRect: gl.getAttribLocation(glassProg, 'aPanelRect'),
        panelExtra:gl.getAttribLocation(glassProg, 'aPanelExtra'),
        opacReveal:gl.getAttribLocation(glassProg, 'aOpacReveal'),
        blurTex:   gl.getUniformLocation(glassProg, 'uBlurTex'),
        viewport:  gl.getUniformLocation(glassProg, 'uViewport'),
        mouse:     gl.getUniformLocation(glassProg, 'uMouse'),
        time:      gl.getUniformLocation(glassProg, 'uTime')
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

    var auroraVAO = makeQuadVAO(auroraProg);
    var blitVAO   = makeQuadVAO(blitProg);
    var blurVAO   = makeQuadVAO(blurProg);

    // Glass VAO with instanced panel data
    var panelRectBuf  = gl.createBuffer();
    var panelExtraBuf = gl.createBuffer();
    var panelORBuf    = gl.createBuffer();  // opacity + reveal packed as vec2
    var panelRectData  = new Float32Array(MAX_PANELS * 4);  // draw buffer (GPU)
    var panelExtraData = new Float32Array(MAX_PANELS * 4);  // draw buffer (GPU)
    var panelORData    = new Float32Array(MAX_PANELS * 2);  // [opacity, reveal] per panel
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
    gl.bindVertexArray(null);

    // ====================================================================
    // Framebuffers
    // ====================================================================
    var vpW = 0, vpH = 0, halfW = 0, halfH = 0;
    var fboAurora = null, texAurora = null;
    var fboBlur = [null, null], texBlur = [null, null];

    function makeFBO(w, h) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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

        // Recreate FBOs at half-res
        if (texAurora) gl.deleteTexture(texAurora);
        if (fboAurora) gl.deleteFramebuffer(fboAurora);
        var a = makeFBO(halfW, halfH);
        fboAurora = a.fbo; texAurora = a.tex;

        for (var j = 0; j < 2; j++) {
            if (texBlur[j]) gl.deleteTexture(texBlur[j]);
            if (fboBlur[j]) gl.deleteFramebuffer(fboBlur[j]);
            var b = makeFBO(halfW, halfH);
            fboBlur[j] = b.fbo; texBlur[j] = b.tex;
        }
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
    // Theme-aware tier system
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
            surface: {sat:1.80, bright:0.78, tint:0.04},
            nested:  {sat:2.20, bright:0.88, tint:0.07},
            control: {sat:1.90, bright:0.85, tint:0.05},
            chrome:  {sat:2.00, bright:0.92, tint:0.06},
            overlay: {sat:2.40, bright:0.96, tint:0.08},
            button:  {sat:2.60, bright:1.00, tint:0.07}
        },
    };

    // P3 gamut: cap saturation on sRGB displays to avoid oversaturation
    var _hasP3 = window.matchMedia('(color-gamut: p3)').matches;
    var SRGB_SAT_CAP = { button: 3.50, overlay: 3.10, chrome: 2.80, control: 2.60, nested: 3.20, surface: 2.40 };

    // Reduced transparency: high tintAlpha for solid appearance
    var _reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

    var _currentTheme = 'dark';

    function detectTheme() {
        _currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    }

    function getTierValues(tierName) {
        var themeVals = TIER_VALUES[_currentTheme] || TIER_VALUES.dark;
        var v = themeVals[tierName] || themeVals.surface;
        var sat = v.sat;
        // Cap saturation on sRGB displays
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
    // Panel position tracking
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

    // Elements that get the pointer reveal glow (interactive items, not structural containers)
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
    var _cachedSticky = new Uint8Array(MAX_CACHED);   // 1 = sticky/fixed, always re-read rect
    var _mainEl = null;
    var _layoutDirty  = true;
    var _anyAnimating = false; // true while any panel is mid-entrance or reveal-fading

    // Rect cache: avoid getBoundingClientRect on every frame during scroll-only updates.
    var _rectDocTop = new Float32Array(MAX_CACHED);
    var _rectLeft   = new Float32Array(MAX_CACHED);
    var _rectWidth  = new Float32Array(MAX_CACHED);
    var _rectHeight = new Float32Array(MAX_CACHED);
    var _rectScrollY = 0;
    var _rectValid = false;
    var _rectAge = 0;
    var _RECT_MAX_AGE = 8;

    function cacheElements() {
        _anyAnimating = true;         // DOM changed — stay awake until collectPanels confirms idle
        _layoutDirty = false;
        _rectValid = false;           // invalidate rect cache on layout change
        _cachedEls = [];
        _cachedTierValues = [];
        _fullyOpaque.fill(0);
        _revealAnim.fill(0);
        _cachedAnimAncestor = [];
        if (_isMobile) { panelCount = 0; return; }
        if (!_mainEl) _mainEl = document.querySelector('main');

        var els = document.querySelectorAll(GLASS_SEL);
        for (var i = 0; i < els.length && _cachedEls.length < MAX_CACHED; i++) {
            var el = els[i];
            var closestArt = el.closest('article');
            if (closestArt && el !== closestArt && el.matches('select, input, textarea') && !el.closest('.tracking-form')) continue;
            var idx = _cachedEls.length;
            var style = getComputedStyle(el);
            // Average all 4 corner radii to handle asymmetric borders (e.g. table first/last row)
            _cachedRadius[idx] = ((parseFloat(style.borderTopLeftRadius) || 0) +
                (parseFloat(style.borderTopRightRadius) || 0) +
                (parseFloat(style.borderBottomLeftRadius) || 0) +
                (parseFloat(style.borderBottomRightRadius) || 0)) * 0.25;
            _cachedTierValues[idx] = getTierValues(getTierName(el));
            _cachedReveal[idx] = el.matches(REVEAL_SEL) ? 1 : 0;
            _cachedZIndex[idx] = parseFloat(style.zIndex) || 0;
            var pos = style.position;
            _cachedSticky[idx] = (pos === 'sticky' || pos === 'fixed') ? 1 : 0;
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
            _cachedEls.push(el);
        }
    }

    // Temp arrays for z-sorted panel collection (reused each frame)
    var _sortIndices = new Int32Array(MAX_PANELS);
    var _sortZ       = new Float32Array(MAX_PANELS);
    var _sortRects   = new Float32Array(MAX_PANELS * 4);
    var _sortExtra   = new Float32Array(MAX_PANELS * 4);
    var _sortOR      = new Float32Array(MAX_PANELS * 2);

    function collectPanels() {
        var visCount = 0;

        var mainSlideExiting = _mainEl && (
            _mainEl.classList.contains('tab-exit-forward') ||
            _mainEl.classList.contains('tab-exit-back'));
        var mainFadeExiting = _mainEl && !mainSlideExiting && _mainEl.style.opacity === '0';
        var mainExiting = mainSlideExiting || mainFadeExiting;
        // Tab-exit is a pure transform animation — opacity stays 1.0 throughout.
        // Only call getComputedStyle for fade-exit (opacity transition) so we don't
        // pay a forced style recalculation on every frame during the common directional
        // tab switch (which accounts for the vast majority of SPA navigations).
        var mainOpacity = mainFadeExiting ? parseFloat(getComputedStyle(_mainEl).opacity) : 1.0;

        // Rect cache: reuse cached document-relative rects when only scroll changed.
        var curScrollY = window.scrollY;
        var hasActiveAnim = mainExiting;
        if (!hasActiveAnim) {
            for (var ai = 0; ai < _cachedEls.length; ai++) {
                var maybeAnimating = (_cachedHasAnim[ai] && !_cachedAnimIn[ai]) || !_fullyOpaque[ai];
                if (!maybeAnimating) continue;
                // Offscreen anim candidates don't require full fresh rect reads each frame.
                if (!_rectValid) { hasActiveAnim = true; break; }
                var atop = _rectDocTop[ai] - curScrollY;
                var ah = _rectHeight[ai];
                if (atop + ah < -80 || atop > vpH + 80) continue;
                hasActiveAnim = true;
                break;
            }
        }
        var freshRead = !_rectValid || hasActiveAnim || (++_rectAge >= _RECT_MAX_AGE);
        if (freshRead) _rectAge = 0;

        for (var i = 0; i < _cachedEls.length; i++) {
            if (visCount >= MAX_PANELS) break;
            if (_cachedHasAnim[i]) {
                var hasAnimIn = _cachedEls[i].classList.contains('animate-in');
                if (!_cachedAnimIn[i]) {
                    if (hasAnimIn) { _cachedAnimIn[i] = 1; _fullyOpaque[i] = 0; }
                    else continue;
                } else if (!hasAnimIn) {
                    _fullyOpaque[i] = 0;
                }
            }

            if (_cachedAnimAncestor[i] && !_cachedAnimAncestor[i].classList.contains('animate-in')) continue;

            if (mainExiting && _cachedInMain[i] && mainOpacity < 0.01) continue;

            var isExiting = _cachedEls[i].classList.contains('exit');

            // Use cached rects when scroll-only; always re-read for sticky/fixed or fresh frames
            var rLeft, rTop, rWidth, rHeight;
            if (freshRead || isExiting || _cachedSticky[i]) {
                var rect = _cachedEls[i].getBoundingClientRect();
                rLeft = rect.left; rTop = rect.top; rWidth = rect.width; rHeight = rect.height;
                _rectLeft[i]   = rLeft;
                _rectDocTop[i] = rTop + curScrollY;
                _rectWidth[i]  = rWidth;
                _rectHeight[i] = rHeight;
            } else {
                rLeft   = _rectLeft[i];
                rTop    = _rectDocTop[i] - curScrollY;
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

        // Check if any panel has non-zero z (fast path: skip sort when all equal)
        var needsSort = false;
        for (var zi = 0; zi < visCount; zi++) {
            if (_sortZ[zi] !== 0) { needsSort = true; break; }
        }

        panelCount = visCount;

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

            // Pack sorted data into GPU buffers
            for (var s = 0; s < visCount; s++) {
                var si = _sortIndices[s];
                var d4 = s * 4, s4 = si * 4;
                panelRectData[d4]     = _sortRects[s4];
                panelRectData[d4 + 1] = _sortRects[s4 + 1];
                panelRectData[d4 + 2] = _sortRects[s4 + 2];
                panelRectData[d4 + 3] = _sortRects[s4 + 3];
                panelExtraData[d4]     = _sortExtra[s4];
                panelExtraData[d4 + 1] = _sortExtra[s4 + 1];
                panelExtraData[d4 + 2] = _sortExtra[s4 + 2];
                panelExtraData[d4 + 3] = _sortExtra[s4 + 3];
                var d2 = s * 2, s2 = si * 2;
                panelORData[d2]     = _sortOR[s2];
                panelORData[d2 + 1] = _sortOR[s2 + 1];
            }
        } else {
            // No z-index variation — copy directly (no reorder needed)
            panelRectData.set(_sortRects.subarray(0, visCount * 4));
            panelExtraData.set(_sortExtra.subarray(0, visCount * 4));
            panelORData.set(_sortOR.subarray(0, visCount * 2));
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

    function render(doAurora) {
        // Pass 1+2: Aurora + Blur — only every 2nd frame, controlled by frame()
        if (doAurora) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboAurora);
            gl.viewport(0, 0, halfW, halfH);
            gl.useProgram(auroraProg);
            gl.bindVertexArray(auroraVAO);
            setAuroraUniforms();
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindVertexArray(null);

            // Kawase blur (ping-pong, 2 passes)
            gl.useProgram(blurProg);
            gl.bindVertexArray(blurVAO);
            gl.uniform2f(blurU.texelSize, 1.0 / halfW, 1.0 / halfH);
            var srcTex = texAurora;
            for (var p = 0; p < BLUR_PASSES; p++) {
                var dst = p % 2;
                gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlur[dst]);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, srcTex);
                gl.uniform1i(blurU.tex, 0);
                gl.uniform1f(blurU.offset, p);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                srcTex = texBlur[dst];
            }
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

            // Bind blurred aurora texture (last blur pass output)
            var lastBlur = (BLUR_PASSES - 1) % 2;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texBlur[lastBlur]);
            gl.uniform1i(glassU.blurTex, 0);

            // Upload instance data (3 buffers: rect, extra, opacity+reveal)
            gl.bindBuffer(gl.ARRAY_BUFFER, panelRectBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelRectData.subarray(0, panelCount * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelExtraBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelExtraData.subarray(0, panelCount * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, panelORBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, panelORData.subarray(0, panelCount * 2));

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

        // Skip all work while paused (SPA nav) or hidden (browser tab switch).
        // Canvas holds its last presented frame — no blank flash, zero GPU submissions.
        if (document.hidden || _glassPaused) return;

        _frameDt = _prevFrameTime ? Math.min((t - _prevFrameTime) * 0.001, 0.1) : 0.016;
        _prevFrameTime = t;
        _time = t * 0.001;
        _simTime += _frameDt;  // advances by at most 100ms per frame — never wall-clock jumps

        // Drive Lenis smooth scroll on same rAF tick as WebGL —
        // scroll position + panel rects + render all happen in one frame.
        if (window.lenis && !window.__lenisOwnRaf) window.lenis.raf(t);

        resizeFBOs();
        updatePhysics(_simTime);

        // Determine aurora parity before any early-return so the counter stays accurate.
        var doAurora = (_auroraFrame++ & 1) === 0;

        // Cooldown: skip heavy layout work for a few frames after DOM changes
        if (_layoutCooldown > 0) { _layoutCooldown--; render(doAurora); return; }
        if (_layoutDirty) cacheElements();

        // Fast-path idle skip: if no animations are running, scroll/mouse are unchanged,
        // and this isn't an aurora frame, skip collectPanels + render entirely.
        if (!doAurora && !_anyAnimating &&
            window.scrollY === _lastRenderScrollY &&
            _mouseX === _lastRenderMouseX && _mouseY === _lastRenderMouseY) return;

        collectPanels();

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
            var canSkip = window.scrollY === _lastRenderScrollY;
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
        _lastRenderScrollY = window.scrollY;
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
        collectPanels();
        _auroraFrame = 0; // ensure first render includes aurora pass
        render(true);

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


    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            resizeFBOs();
            _layoutDirty = true;
            _prevFrameTime = 0;
            updatePhysics(_simTime);  // resume from where simulation left off — no jump
            cacheElements();
            collectPanels();
            render(true); // force aurora on visibility resume for a fresh frame
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
    window.invalidateGlassRects = function () { _rectValid = false; _rectAge = _RECT_MAX_AGE; };

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
