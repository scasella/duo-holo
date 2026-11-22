// GLSL ES 3.00 port of DuoHolo/Resources/Shaders.msl. Keep the two in step.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

const COMMON = `
uniform mat4 uViewProjWall;
uniform mat4 uViewProjFloor;
uniform vec4 uEye;       // xyz world-space eye, w = time (s)
uniform vec4 uScreen;    // width pt, height pt, pixels per point, fold y (pt from top)
uniform vec4 uRoom;      // virtual wall z, cos(theta), sin(theta), mode (0 = folded, 1 = diorama)
uniform vec4 uRing;      // floor ring centre x, z, radius, intensity
uniform vec4 uLight;     // key light direction xyz, w = beat pulse 0..1
uniform vec4 uFace;      // blink 0..1, mouth open 0..1, gaze x, gaze y
uniform vec4 uTweak;     // debug mode, flicker, character height (pt), reveal height 0..1.3
uniform mat4 uModel;
uniform vec4 uParams;    // panel (0 wall, 1 floor), mirror (0/1), outline width px (0 = fill), opacity
uniform vec4 uViewport;  // viewport width, height in pixels

const vec3 kHolo = vec3(0.22, 0.80, 1.0);

float sat(float x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
// smoothstep falling from 1 at lo to 0 at hi (GLSL leaves smoothstep with reversed edges undefined)
float fall(float hi, float lo, float x) { return 1.0 - smoothstep(lo, hi, x); }
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float hash11(float x) { return fract(sin(x * 127.1 + 3.7) * 43758.5453); }
vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
`;

// ------------------------------------------------------------------- character

export const VS_CHARACTER = HEAD + `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aMaterial;   // bytes as floats 0..255
layout(location = 4) in vec4 aJoints;     // bytes as floats 0..255
layout(location = 5) in vec4 aWeights;
layout(location = 6) in vec2 aUv;
` + COMMON + `
uniform mat4 uJoints[64];

out vec3 vWorld;
out vec3 vNormal;
out vec4 vColor;
out vec2 vUv;
out float vEmissive;
flat out int vMat;

void main() {
    ivec4 j = ivec4(aJoints + 0.5);
    mat4 skin = uJoints[j.x] * aWeights.x + uJoints[j.y] * aWeights.y
              + uJoints[j.z] * aWeights.z + uJoints[j.w] * aWeights.w;
    vec4 wp = uModel * (skin * vec4(aPosition, 1.0));
    vec3 wn = normalize((uModel * (skin * vec4(aNormal, 0.0))).xyz);
    if (uParams.y > 0.5) {             // mirror in the floor
        wp.y = -wp.y;
        wn.y = -wn.y;
    }
    mat4 vp;
    if (uParams.x < 0.5) { vp = uViewProjWall; } else { vp = uViewProjFloor; }
    vec4 clip = vp * wp;
    float outline = uParams.z * (aMaterial.z / 128.0);
    if (uParams.z > 0.0) {
        vec4 c2 = vp * (wp + vec4(wn, 0.0));
        vec2 d = (c2.xy / c2.w - clip.xy / clip.w) * uViewport.xy;
        d = d / max(length(d), 1e-5);
        clip.xy += d * (2.0 * outline / uViewport.xy) * clip.w;
    }
    gl_Position = clip;
    vWorld = wp.xyz;
    vNormal = wn;
    vColor = aColor;
    vUv = aUv;
    vEmissive = aMaterial.y / 64.0;
    vMat = int(aMaterial.x + 0.5);
}
`;

export const FS_CHARACTER = HEAD + COMMON + `
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColor;
in vec2 vUv;
in float vEmissive;
flat in int vMat;
out vec4 fragColor;

float ell(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float aa(float d) {
    float w = fwidth(d) * 0.8 + 1e-5;
    return 1.0 - smoothstep(-w, w, d);
}

// Paints eyes, brows, mouth and blush onto the face in its own uv space
// (u across, v up, origin between the eyes, 1 unit = 10 cm).
vec3 paintFace(vec3 base, vec2 uv, float front, vec4 face, float lit) {
    vec3 col = base;
    float mask = smoothstep(0.18, 0.42, front);
    float blink = face.x;
    float open = 1.0 - blink;

    for (int i = 0; i < 2; i++) {
        float s = i == 0 ? -1.0 : 1.0;
        vec2 b = (uv - vec2(0.54 * s, -0.27)) / vec2(0.19, 0.095);
        col = mix(col, vec3(1.0, 0.47, 0.56), 0.34 * exp(-dot(b, b) * 1.6) * mask);
    }

    vec3 lashCol = vec3(0.035, 0.022, 0.11);
    for (int i = 0; i < 2; i++) {
        float s = i == 0 ? -1.0 : 1.0;
        vec2 q = uv - vec2(0.425 * s, -0.005);
        q.x *= s;                               // +x = outer corner
        q.y -= q.x * 0.12;                      // outer corner lifts a little
        vec2 er = vec2(0.205, 0.262 * max(open, 0.05));
        float dEye = ell(q, er);

        // sclera, shaded by the upper lid
        vec3 sc = mix(vec3(0.62, 0.68, 0.92), vec3(1.0), fall(0.17, -0.06, q.y / max(open, 0.2)));
        // iris
        vec2 ip = q - vec2(-0.016 + face.z * 0.045 * s, -0.012 + face.w * 0.035);
        vec2 ir = vec2(0.170, 0.236);
        float dI = ell(ip, ir);
        float t = sat(ip.y / ir.y * 0.5 + 0.5);
        vec3 iris = mix(vec3(0.16, 0.86, 1.0), vec3(0.30, 0.10, 0.72), smoothstep(0.08, 0.80, t));
        iris = mix(iris, vec3(0.70, 0.98, 1.0), fall(0.30, 0.0, t) * 0.55);
        iris = mix(iris, vec3(0.06, 0.03, 0.22), smoothstep(-0.040, -0.004, dI));
        float dP = ell(ip - vec2(0.0, 0.014), vec2(0.064, 0.100));
        iris = mix(iris, vec3(0.03, 0.02, 0.12), aa(dP));
        float h1 = aa(length((ip - vec2(-0.066, 0.100)) / vec2(1.0, 1.15)) - 0.054);
        float h2 = aa(length(ip - vec2(0.068, -0.104)) - 0.026);
        vec3 eye = mix(sc, iris, aa(dI));
        eye = mix(eye, vec3(1.0), max(h1, h2 * 0.9));
        eye *= mix(0.80, 1.0, lit);
        col = mix(col, eye, aa(dEye) * mask);

        // upper lash line with an outer wing; collapses to a curve when blinking
        float up = smoothstep(-0.07, 0.03, q.y / max(open, 0.25));
        float thick = mix(0.012, 0.030, smoothstep(-0.18, 0.16, q.x));
        float lash = aa(abs(dEye - 0.008) - thick) * up;
        vec2 wq = q - vec2(0.200, 0.052 * open);
        float wing = aa(ell(vec2(wq.x * 0.90 - wq.y * 0.44, wq.x * 0.44 + wq.y * 0.90), vec2(0.060, 0.016)));
        float low = aa(abs(dEye - 0.004) - 0.006) * fall(0.02, -0.10, q.y) * smoothstep(-0.05, 0.12, q.x) * open;
        col = mix(col, lashCol, sat(max(lash, wing) + low * 0.55) * mask);

        // brow
        vec2 bq = q - vec2(0.01, 0.372);
        bq.y += bq.x * bq.x * 0.9 - bq.x * 0.06;
        float brow = aa(ell(bq, vec2(0.165, 0.011)));
        col = mix(col, vec3(0.42, 0.36, 0.72), brow * 0.75 * mask);
    }

    // mouth: a smile line that opens into an ellipse
    float mo = face.y;
    vec2 m = uv - vec2(0.0, -0.455);
    float smile = aa(abs(m.y + 0.022 - m.x * m.x * 2.6) - 0.0065) * fall(0.105, 0.085, abs(m.x));
    vec2 mr = vec2(0.085 - 0.012 * mo, 0.012 + 0.085 * mo);
    float dM = ell(m - vec2(0.0, -0.03 * mo), mr);
    vec3 inner = mix(vec3(0.50, 0.08, 0.16), vec3(0.95, 0.42, 0.48), fall(0.0, -0.9, (m.y + 0.03 * mo) / mr.y) * 0.8);
    col = mix(col, vec3(0.50, 0.14, 0.22), smoothstep(0.0, 0.15, 0.15 - mo) * smile * mask);
    col = mix(col, inner, aa(dM) * smoothstep(0.05, 0.25, mo) * mask);
    return col;
}

void main() {
    float time = uEye.w;
    bool mirror = uParams.y > 0.5;
    float y = mirror ? -vWorld.y : vWorld.y;
    float hRaw = y / max(uTweak.z, 1.0);
    float h = sat(hRaw);

    // materialise from the floor up: nothing exists above the reveal front yet
    float reveal = uTweak.w;
    if (hRaw > reveal) { discard; }
    float front = exp(-sq((reveal - hRaw) / 0.022)) * step(reveal, 1.25);

    // legs dissolve into light towards the floor
    float legs = smoothstep(0.015, 0.34, h);
    float alpha = mix(0.34, 1.0, legs) * uParams.w;
    float flick = 1.0 - uTweak.y * (0.5 + 0.5 * sin(time * 47.0)) * 0.05;

    if (uParams.z > 0.0) {                         // silhouette line
        vec3 oc = mix(kHolo, toLinear(vColor.rgb), 0.18) * 1.55 + kHolo * front * 3.0;
        float a = alpha * 0.92 * flick;
        if (mirror) { a *= 0.30 * exp(-y / (0.07 * uTweak.z)) * fall(0.30, 0.12, h); }
        fragColor = vec4(oc * a, a);
        return;
    }

    vec3 N = normalize(vNormal);
    vec3 V = normalize(uEye.xyz - vWorld);
    if (mirror) { V.y = -V.y; N.y = -N.y; }
    vec3 L = normalize(uLight.xyz);
    float ndl = dot(N, L);
    float ndv = sat(dot(N, V));
    float lit = smoothstep(-0.03, 0.09, ndl);

    vec3 albedo = toLinear(vColor.rgb);
    int mat = vMat;
    vec3 shade = vec3(0.56, 0.62, 0.92);
    if (mat == 1 || mat == 2) { shade = vec3(0.90, 0.70, 0.82); }
    if (mat == 3) { shade = vec3(0.56, 0.52, 0.94); }

    vec3 col;
    if (mat == 4) {
        col = albedo * (0.55 + vEmissive * (0.85 + 0.25 * uLight.w));
    } else {
        if (mat == 2) {
            albedo = paintFace(albedo, vUv, vColor.a, uFace, 1.0);
            lit = mix(lit, 1.0, 0.55 * smoothstep(0.2, 0.5, vColor.a));
        }
        col = albedo * mix(shade, vec3(1.0), lit);
        col *= 1.0 + 0.07 * smoothstep(0.55, 0.80, ndl);

        vec3 H = normalize(L + V);
        float ndh = sat(dot(N, H));
        if (mat == 3) {                            // hair: soft toon sheen
            float sheen = smoothstep(0.86, 0.93, ndh) * 0.30 + smoothstep(0.965, 0.985, ndh) * 0.25;
            col += vec3(0.85, 0.92, 1.0) * sheen * lit;
        } else if (mat == 5) {                     // glossy boots
            col += vec3(0.8, 0.95, 1.0) * smoothstep(0.955, 0.975, ndh) * 0.55;
        }
        col += albedo * vEmissive * (0.9 + 0.3 * uLight.w);

        // holographic rim
        float rim = pow(1.0 - ndv, 2.6);
        float rimAmt = (mat == 2) ? 0.18 : 0.55;
        col += kHolo * rim * rimAmt;
    }

    // projection artefacts: fine scanlines and a slow sweep travelling up the figure
    float scan = 0.5 + 0.5 * sin(y * 1.45 - time * 7.0);
    col *= 1.0 + 0.045 * (scan - 0.5);
    float sweepY = fract(time * 0.16) * 1.5 - 0.25;
    float sweep = exp(-sq((h - sweepY) / 0.030));
    col += kHolo * sweep * 0.22;

    col += kHolo * front * 2.6;

    // cool the whole figure slightly and push the feet towards pure light
    col *= vec3(0.93, 0.98, 1.05);
    float lum = dot(col, vec3(0.25, 0.6, 0.15));
    col = mix(kHolo * (0.35 + lum * 1.15), col, mix(0.25, 1.0, legs));

    alpha *= flick;
    if (mirror) {
        alpha *= 0.42 * exp(-y / (0.07 * uTweak.z)) * fall(0.30, 0.12, h);
        col = mix(col, kHolo * lum * 1.4, 0.5);
    }
    fragColor = vec4(col * alpha, alpha);
}
`;

// ------------------------------------------------------------------- particles

// Motes of light drifting up from the ring. Entirely procedural: position comes from the
// instance id and time, and each mote is a camera-facing quad projected through the panel's
// own off-axis view so it floats in the same space as the figure.
export const VS_PARTICLE = HEAD + COMMON + `
out vec2 vQ;
out vec3 vTint;

void main() {
    float id = float(gl_InstanceID);
    float h1 = hash11(id * 1.31 + 0.7), h2 = hash11(id * 2.17 + 3.1);
    float h3 = hash11(id * 3.73 + 8.9), h4 = hash11(id * 5.11 + 1.3);
    float time = uEye.w;
    float H = uTweak.z, R = uRing.z;
    float life = fract(h1 + time * (0.045 + 0.065 * h2));
    float ang = h3 * 6.2831853 + time * (0.20 + 0.45 * h4) * (h2 > 0.5 ? 1.0 : -1.0);
    float rad = R * (0.30 + 0.95 * sqrt(h4)) * (1.0 + 0.12 * sin(time * 0.7 + id));
    vec3 p = vec3(uRing.x + cos(ang) * rad, life * H * (0.45 + 0.75 * h2), uRing.y + sin(ang) * rad);
    p.x += sin(time * 1.3 + id * 2.0) * 3.0;
    float fade = smoothstep(0.0, 0.10, life) * fall(1.0, 0.55, life);
    float twinkle = 0.65 + 0.35 * sin(time * (3.0 + 5.0 * h3) + id);
    float size = (0.9 + 2.2 * h3 * h3) * 3.2;

    vec2 c = vec2((gl_VertexID & 1) != 0 ? 1.0 : -1.0, (gl_VertexID & 2) != 0 ? 1.0 : -1.0);
    vec3 toEye = normalize(uEye.xyz - p);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
    vec3 up = cross(toEye, right);
    vec3 wp = p + (right * c.x + up * c.y) * size;
    mat4 vp;
    if (uParams.x < 0.5) { vp = uViewProjWall; } else { vp = uViewProjFloor; }
    gl_Position = vp * vec4(wp, 1.0);
    vQ = c;
    vec3 tint = h1 > 0.8 ? vec3(1.0, 0.55, 0.85) : (h1 > 0.45 ? vec3(0.85, 0.95, 1.0) : kHolo);
    vTint = tint * fade * twinkle * (0.55 + 0.9 * h4) * min(uTweak.w, 1.0);
}
`;

export const FS_PARTICLE = HEAD + `
in vec2 vQ;
in vec3 vTint;
out vec4 fragColor;
void main() {
    float d2 = dot(vQ, vQ);
    float a = exp(-d2 * 9.0) * 1.6 + exp(-d2 * 2.4) * 0.22;
    a *= 1.0 - smoothstep(0.7, 1.0, d2);
    fragColor = vec4(vTint * a, 0.0);      // additive: leaves the layer's coverage untouched
}
`;

// ------------------------------------------------------------------ fullscreen

// vUv has its origin at the bottom-left (GL texture space).
export const VS_QUAD = HEAD + `
out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    vUv = p;
}
`;

export const FS_SCENE = HEAD + COMMON + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uCharTex;

// The dot lattice. lat is a position on a stage surface in points, measured from the fold and
// the centre line; dots sit half a pitch either side of both, so none lands on the crease.
vec3 lattice(vec2 lat, float time, float pxPerPt, vec2 ringRel, float beat) {
    const float pitch = 30.4;
    vec2 g = lat / pitch;
    vec2 cell = floor(g);
    vec2 f = (fract(g) - 0.5) * pitch;
    float d = length(f);
    float h1 = hash21(cell);
    float h2 = hash21(cell + 17.3);
    float h3 = hash21(cell + 91.7);
    float tw = 0.70 + 0.30 * sin(time * (0.5 + h1 * 1.9) + h2 * 40.0);
    tw *= 0.78 + 0.22 * h3;
    float r = 1.35 + 0.55 * h2;
    float e = 0.55 / pxPerPt + 0.12;
    float core = 1.0 - smoothstep(r - e, r + e, d);
    float halo = exp(-d * d / 40.0) * 0.085;
    vec3 tint = vec3(0.80, 0.87, 1.0);
    if (h3 > 0.90) { tint = vec3(0.35, 0.70, 1.0); }
    else if (h3 > 0.84) { tint = vec3(0.55, 1.0, 0.92); }
    else if (h3 < 0.05) { tint = vec3(0.95, 0.60, 1.0); }
    // a ripple of light that leaves the ring on every beat
    float rd = length(ringRel);
    float ripple = exp(-sq((rd - beat * 520.0) / 46.0)) * (1.0 - beat) * 0.9;
    float glow = exp(-rd * rd / (2.0 * 150.0 * 150.0)) * 0.35;
    vec3 c = tint * (core * 1.25 + halo) * tw;
    c += kHolo * (core * 1.4 + halo) * (ripple + glow);
    return c;
}

vec3 floorRing(vec2 rp, float R, float time, float beat, float intensity) {
    float rr = length(rp);
    float ang = atan(rp.y, rp.x);
    vec3 c = vec3(0.0);
    vec3 blue = vec3(0.16, 0.50, 1.0);
    // pool of light under the feet
    c += blue * exp(-rr * rr / (2.0 * 0.50 * R * 0.50 * R)) * 0.30;
    c += kHolo * exp(-rr * rr / (2.0 * 0.20 * R * 0.20 * R)) * 0.16;
    // main ring
    float d1 = rr - R;
    c += kHolo * (exp(-d1 * d1 / 2.4) * 1.9 + exp(-d1 * d1 / 90.0) * 0.36) * (0.85 + 0.35 * beat);
    // inner ring, broken into arcs that drift round
    float d2 = rr - R * 0.76;
    float arcs = smoothstep(0.30, 0.36, fract(ang / 6.2831853 * 3.0 + time * 0.07));
    c += blue * (exp(-d2 * d2 / 1.6) * 1.3 + exp(-d2 * d2 / 60.0) * 0.20) * arcs;
    // outer ring of dots
    float n = 44.0;
    float a2 = ang / 6.2831853 * n - time * 0.35;
    float arc = (fract(a2) - 0.5) * (6.2831853 * rr / n);
    vec2 dd = vec2(arc, rr - R * 1.20);
    c += vec3(0.75, 0.9, 1.0) * (1.0 - smoothstep(1.2, 2.1, length(dd))) * 1.1;
    // expanding pulse on the beat
    float dp = rr - R * (1.0 + beat * 0.55);
    c += kHolo * exp(-dp * dp / 30.0) * (1.0 - beat) * 0.55;
    return c * intensity;
}

void main() {
    float time = uEye.w;
    vec2 pt = vec2(vUv.x, 1.0 - vUv.y) * uScreen.xy;      // points from the top-left
    float foldY = uScreen.w;
    float x = pt.x - uScreen.x * 0.5;
    float cosT = uRoom.y, sinT = uRoom.z;
    vec3 wallDir = vec3(0.0, sinT, cosT);

    // where this pixel physically sits in the world
    bool onWall = pt.y < foldY;
    vec3 P;
    if (uRoom.w < 0.5) {
        P = onWall ? vec3(x, 0.0, 0.0) + (foldY - pt.y) * wallDir : vec3(x, 0.0, pt.y - foldY);
    } else {
        P = vec3(x, foldY - pt.y, 0.0);
    }

    // look through the pixel into the stage: a floor plane and a back wall
    vec3 ro = uEye.xyz;
    vec3 rd = normalize(P - ro);
    vec3 wallOrigin = vec3(0.0, 0.0, uRoom.x);
    vec3 nW = vec3(0.0, -cosT, sinT);
    float tF = rd.y < -1e-5 ? -ro.y / rd.y : 1e9;
    vec3 hF = ro + rd * tF;
    float tW = dot(wallOrigin - ro, nW) / min(dot(rd, nW), -1e-5);
    vec3 hW = ro + rd * tW;
    bool floorHit = tF < 1e8 && dot(hF - wallOrigin, nW) >= 0.0;

    float beat = uLight.w;
    vec3 col = vec3(0.0);
    vec2 ringC = uRing.xy;
    if (floorHit) {
        vec2 fp = vec2(hF.x, hF.z - uRoom.x);
        col += lattice(fp, time, uScreen.z, vec2(hF.x, hF.z) - ringC, beat);
        col += floorRing(vec2(hF.x, hF.z) - ringC, uRing.z, time, beat, uRing.w);
    } else {
        float up = dot(hW - wallOrigin, wallDir);
        vec2 wp = vec2(hW.x, -up);
        col += lattice(wp, time, uScreen.z, vec2(hW.x, -up - (ringC.y - uRoom.x)), beat);
    }

    // a faint column of projected light standing on the ring
    {
        float Rc = uRing.z * 0.98;
        float Hc = uTweak.z * 1.12;
        vec2 oc = ro.xz - ringC;
        vec2 dc = rd.xz;
        float A = dot(dc, dc), B = dot(oc, dc), C = dot(oc, oc) - Rc * Rc;
        float disc = B * B - A * C;
        if (disc > 0.0 && A > 1e-6) {
            float sqd = sqrt(disc);
            float t0 = (-B - sqd) / A, t1 = (-B + sqd) / A;
            float ta = (0.0 - ro.y) / rd.y, tb = (Hc - ro.y) / rd.y;
            t0 = max(t0, min(ta, tb));
            t1 = min(t1, max(ta, tb));
            float len = max(t1 - max(t0, 0.0), 0.0);
            float ym = ro.y + rd.y * (max(t0, 0.0) + t1) * 0.5;
            float falloff = exp(-max(ym, 0.0) / (0.50 * uTweak.z)) * fall(Hc, Hc * 0.55, ym);
            float edge = pow(sat(disc / (A * Rc * Rc)), 2.2);   // soft sides: densest along the axis
            col += vec3(0.12, 0.55, 1.0) * len * 0.00030 * edge * falloff * uRing.w * (0.85 + 0.25 * beat) * min(uTweak.w, 1.0);
        }
    }

    if (uTweak.x > 0.5 && uTweak.x < 1.5) {        // debug: fold line + panel tint
        col += onWall ? vec3(0.05, 0.0, 0.0) : vec3(0.0, 0.04, 0.0);
        col += vec3(1.0, 0.2, 0.2) * (1.0 - smoothstep(0.0, 1.0, abs(pt.y - foldY)));
    }

    vec4 ch = texture(uCharTex, vUv);
    col = col * (1.0 - ch.a) + ch.rgb;
    fragColor = vec4(col, 1.0);
}
`;

// ----------------------------------------------------------------------- bloom

export const FS_BLOOM_DOWN = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec4 uBloom;     // texel size xy, threshold (0 = none), knee
void main() {
    vec2 t = uBloom.xy;
    vec3 c = texture(uSrc, vUv).rgb * 4.0;
    c += texture(uSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(-1.0, 1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(1.0, 1.0)).rgb;
    c /= 8.0;
    if (uBloom.z > 0.0) {                           // soft threshold on the first pass
        float br = max(c.r, max(c.g, c.b));
        float knee = uBloom.w;
        float soft = clamp(br - uBloom.z + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee + 1e-4);
        c *= max(soft, br - uBloom.z) / max(br, 1e-4);
    }
    fragColor = vec4(c, 1.0);
}
`;

export const FS_BLOOM_UP = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec4 uBloom;     // texel size xy, gain
void main() {
    vec2 t = uBloom.xy;
    vec3 c = texture(uSrc, vUv).rgb * 4.0;
    c += texture(uSrc, vUv + t * vec2(-1.0, 0.0)).rgb * 2.0;
    c += texture(uSrc, vUv + t * vec2(1.0, 0.0)).rgb * 2.0;
    c += texture(uSrc, vUv + t * vec2(0.0, -1.0)).rgb * 2.0;
    c += texture(uSrc, vUv + t * vec2(0.0, 1.0)).rgb * 2.0;
    c += texture(uSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(1.0, -1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(-1.0, 1.0)).rgb;
    c += texture(uSrc, vUv + t * vec2(1.0, 1.0)).rgb;
    fragColor = vec4(c / 16.0 * uBloom.z, 1.0);
}
`;

// ----------------------------------------------------------------------- final

export const FS_FINAL = HEAD + COMMON + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloomTex;

vec3 softClip(vec3 x) {
    const float k = 0.72;
    vec3 over = max(x - k, vec3(0.0));
    return min(x, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}
vec3 toSRGB(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, vec3(lessThan(c, vec3(0.0031308))));
}
void main() {
    vec3 c = texture(uScene, vUv).rgb;
    vec3 b = texture(uBloomTex, vUv).rgb;
    c += b * 0.30;
    c = softClip(c);
    c = toSRGB(c);
    c += (hash21(vUv * uScreen.xy * uScreen.z + uEye.w) - 0.5) / 255.0;
    fragColor = vec4(c, 1.0);
}
`;
