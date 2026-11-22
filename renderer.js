// WebGL2 port of DuoHolo/Renderer.swift.
//
// One frame: the character is drawn into a multisampled layer twice (once per screen half, each
// with its own off-axis projection), the stage shader draws the lattice and ring and composites
// the layer over them, a bloom chain runs on the result, and a final pass tone-maps to the canvas.
import * as S from './shaders.js';
import { sub, dot, cross, normalize, mat4mul } from './vec.js';

const PANEL_WALL = 0, PANEL_FLOOR = 1;

/** Parses a .holo file (see tools/build_character.py). */
export function parseModel(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== 'HOLO0001') throw new Error('not a .holo file');
  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  if (header.stride !== 48) throw new Error('unexpected vertex stride');
  const vbStart = 12 + headerLength;
  const vbEnd = vbStart + header.vertexCount * 48;
  return {
    vertices: bytes.slice(vbStart, vbEnd),
    indices: new Uint32Array(buffer.slice(vbEnd, vbEnd + header.indexCount * 4)),
    indexCount: header.indexCount,
    height: header.height,
    joints: header.joints.map((j) => ({ name: j.name, parent: j.parent, bind: j.pos, tip: j.tip || null })),
  };
}

/** The physical layout of the display as the viewer sees it, in points. World space: origin at
 *  the centre of the fold line, x right, y up from the floor panel, z towards the viewer. */
export class Stage {
  constructor(width, height, foldY, theta, eye) {
    Object.assign(this, { width, height, foldY, theta, eye });
  }
  get wallDir() { return [0, Math.sin(this.theta), Math.cos(this.theta)]; }
  get floorDepth() { return this.height - this.foldY; }

  corners(panel) {
    const hw = this.width / 2, d = this.wallDir, f = this.foldY;
    if (panel === PANEL_WALL) return [[-hw, 0, 0], [hw, 0, 0], [-hw + d[0] * f, d[1] * f, d[2] * f]];
    return [[-hw, 0, this.floorDepth], [hw, 0, this.floorDepth], [-hw, 0, 0]];
  }

  /** Generalised perspective projection: the panel is the image plane and the eye the centre
   *  of projection, so what is drawn lines up with the real world as seen from the eye. */
  viewProjection(panel, near = 30, far = 30000) {
    const [pa, pb, pc] = this.corners(panel);
    const eye = this.eye;
    const vr = normalize(sub(pb, pa)), vu = normalize(sub(pc, pa));
    const vn = normalize(cross(vr, vu));
    const va = sub(pa, eye), vb = sub(pb, eye), vc = sub(pc, eye);
    const d = Math.max(-dot(va, vn), 1);
    const l = dot(vr, va) * near / d, r = dot(vr, vb) * near / d;
    const b = dot(vu, va) * near / d, t = dot(vu, vc) * near / d;
    const proj = new Float32Array([
      2 * near / (r - l), 0, 0, 0,
      0, 2 * near / (t - b), 0, 0,
      (r + l) / (r - l), (t + b) / (t - b), -(far + near) / (far - near), -1,
      0, 0, -2 * far * near / (far - near), 0,
    ]);
    const view = new Float32Array([
      vr[0], vu[0], vn[0], 0,
      vr[1], vu[1], vn[1], 0,
      vr[2], vu[2], vn[2], 0,
      -dot(vr, eye), -dot(vu, eye), -dot(vn, eye), 1,
    ]);
    return mat4mul(proj, view);
  }
}

class Program {
  constructor(gl, vs, fs, name) {
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    this.gl = gl;
    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`${name} link: ${gl.getProgramInfoLog(this.program)}`);
    }
    this.locations = new Map();
  }
  loc(name) {
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locations.get(name);
  }
  use() { this.gl.useProgram(this.program); return this; }
  v4(name, v) { this.gl.uniform4f(this.loc(name), v[0], v[1], v[2], v[3]); return this; }
  m4(name, m) { this.gl.uniformMatrix4fv(this.loc(name), false, m); return this; }
  i1(name, i) { this.gl.uniform1i(this.loc(name), i); return this; }
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    // Half-float render targets carry the glow above 1.0 into the bloom; fall back to 8-bit.
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    this.size = [0, 0];
    this.targets = null;
    this.model = null;

    this.character = new Program(gl, S.VS_CHARACTER, S.FS_CHARACTER, 'character');
    this.particles = new Program(gl, S.VS_PARTICLE, S.FS_PARTICLE, 'particles');
    this.scene = new Program(gl, S.VS_QUAD, S.FS_SCENE, 'scene');
    this.bloomDown = new Program(gl, S.VS_QUAD, S.FS_BLOOM_DOWN, 'bloom down');
    this.bloomUp = new Program(gl, S.VS_QUAD, S.FS_BLOOM_UP, 'bloom up');
    this.final = new Program(gl, S.VS_QUAD, S.FS_FINAL, 'final');
    this.emptyVAO = gl.createVertexArray();
  }

  setModel(model) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, model.vertices, gl.STATIC_DRAW);
    const attributes = [
      [3, gl.FLOAT, false, 0], [3, gl.FLOAT, false, 12], [4, gl.UNSIGNED_BYTE, true, 24],
      [4, gl.UNSIGNED_BYTE, false, 28], [4, gl.UNSIGNED_BYTE, false, 32], [4, gl.UNSIGNED_BYTE, true, 36],
      [2, gl.FLOAT, false, 40],
    ];
    attributes.forEach(([size, type, normalized, offset], i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, type, normalized, 48, offset);
    });
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.model = { vao, indexCount: model.indexCount, height: model.height, jointCount: model.joints.length };
    if (model.joints.length > 64) throw new Error('model has more than 64 joints');
  }

  // ---------------------------------------------------------------- targets

  texture(w, h, hdr) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, hdr ? gl.RGBA16F : gl.RGBA8, Math.max(w, 1), Math.max(h, 1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    return { tex, fbo, w: Math.max(w, 1), h: Math.max(h, 1), ok };
  }

  build(w, h, hdr) {
    const gl = this.gl;
    const t = { hdr, w, h, release: [] };
    // multisampled character layer
    t.msFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo);
    const color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, hdr ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    t.renderbuffers = [color, depth];
    t.char = this.texture(w, h, hdr);
    t.sceneTex = this.texture(w, h, hdr);
    t.bloom = [];
    for (let level = 1; level <= 6; level++) t.bloom.push(this.texture(w >> level, h >> level, hdr));
    ok = ok && t.char.ok && t.sceneTex.ok && t.bloom.every((b) => b.ok);
    t.ok = ok && gl.getError() === gl.NO_ERROR;
    return t;
  }

  destroy(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.msFbo);
    t.renderbuffers.forEach((r) => gl.deleteRenderbuffer(r));
    for (const x of [t.char, t.sceneTex, ...t.bloom]) { gl.deleteTexture(x.tex); gl.deleteFramebuffer(x.fbo); }
  }

  resize(w, h) {
    if (w === this.size[0] && h === this.size[1] && this.targets) return;
    this.destroy(this.targets);
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    while (this.gl.getError() !== this.gl.NO_ERROR) { /* clear stale errors */ }
    let targets = this.build(w, h, this.hdr);
    if (!targets.ok && this.hdr) {          // half-float targets refused: use 8-bit
      this.destroy(targets);
      this.hdr = false;
      targets = this.build(w, h, false);
    }
    if (!targets.ok) throw new Error('could not create render targets');
    this.targets = targets;
  }

  // ------------------------------------------------------------------ frame

  frameUniforms(p, f) {
    p.m4('uViewProjWall', f.viewProjWall).m4('uViewProjFloor', f.viewProjFloor)
      .v4('uEye', f.eye).v4('uScreen', f.screen).v4('uRoom', f.room).v4('uRing', f.ring)
      .v4('uLight', f.light).v4('uFace', f.face).v4('uTweak', f.tweak);
  }

  quad(target, program, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** f: { stage, pxPerPt, time, room, charPos, charHeight, ringRadius, reveal, palette, face, beat, debug } */
  render(f) {
    const gl = this.gl, t = this.targets, model = this.model;
    if (!t) return;
    const [w, h] = this.size;
    const stage = f.stage;
    const light = normalize([-0.45, 0.75, 0.62]);
    const frame = {
      viewProjWall: stage.viewProjection(PANEL_WALL),
      viewProjFloor: stage.viewProjection(PANEL_FLOOR),
      eye: [...stage.eye, f.time],
      screen: [stage.width, stage.height, f.pxPerPt, stage.foldY],
      room: f.room,
      ring: [f.charPos[0], f.charPos[2], f.ringRadius, 1],
      light: [...light, f.beat],
      face: f.face,
      tweak: [f.debug, 1, f.charHeight, f.reveal],
    };

    // Pixel rectangles of the two halves (GL's origin is the bottom-left corner).
    const split = Math.min(Math.max(Math.round(stage.foldY * f.pxPerPt), 0), h);
    const panels = [
      { id: PANEL_WALL, x: 0, y: h - split, w, h: split },
      { id: PANEL_FLOOR, x: 0, y: 0, w, h: h - split },
    ].filter((p) => p.h >= 1);

    // 1. Character layer (premultiplied colour + coverage), one off-axis view per panel.
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (model && f.palette) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.CULL_FACE);
      gl.frontFace(gl.CCW);
      gl.enable(gl.SCISSOR_TEST);
      const p = this.character.use();
      this.frameUniforms(p, frame);
      gl.uniformMatrix4fv(p.loc('uJoints'), false, f.palette);
      const s = f.charHeight / model.height;
      p.m4('uModel', new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, f.charPos[0], f.charPos[1], f.charPos[2], 1]));
      gl.bindVertexArray(model.vao);
      const outline = 1.15 * f.pxPerPt;
      // fill, silhouette line, then the reflection in the floor
      const passes = [[0, 0, gl.BACK], [0, outline, gl.FRONT], [1, 0, gl.FRONT], [1, outline, gl.BACK]];
      for (const panel of panels) {
        gl.viewport(panel.x, panel.y, panel.w, panel.h);
        gl.scissor(panel.x, panel.y, panel.w, panel.h);
        p.v4('uViewport', [panel.w, panel.h, 0, 0]);
        for (const [mirror, width, cull] of passes) {
          gl.cullFace(cull);
          p.v4('uParams', [panel.id, mirror, width, 1]);
          gl.drawElements(gl.TRIANGLES, model.indexCount, gl.UNSIGNED_INT, 0);
        }
      }
      // motes of light, additive, hidden where the figure is in front of them
      const q = this.particles.use();
      this.frameUniforms(q, frame);
      gl.bindVertexArray(this.emptyVAO);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      for (const panel of panels) {
        gl.viewport(panel.x, panel.y, panel.w, panel.h);
        gl.scissor(panel.x, panel.y, panel.w, panel.h);
        q.v4('uParams', [panel.id, 0, 0, 1]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 72);
      }
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
    }
    // resolve the multisampled layer
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.char.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    // 2. Stage (lattice + ring) with the character composited on top.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.char.tex);
    this.frameUniforms(this.scene.use().i1('uCharTex', 0), frame);
    this.quad(t.sceneTex.fbo, this.scene, w, h);

    // 3. Bloom: threshold + downsample chain, then additive upsample.
    let source = t.sceneTex;
    this.bloomDown.use().i1('uSrc', 0);
    t.bloom.forEach((level, i) => {
      gl.bindTexture(gl.TEXTURE_2D, source.tex);
      this.bloomDown.v4('uBloom', [1 / source.w, 1 / source.h, i === 0 ? 0.95 : 0, 0.30]);
      this.quad(level.fbo, this.bloomDown, level.w, level.h);
      source = level;
    });
    this.bloomUp.use().i1('uSrc', 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = t.bloom.length - 2; i >= 0; i--) {
      const src = t.bloom[i + 1];
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      this.bloomUp.v4('uBloom', [1 / src.w, 1 / src.h, 0.72, 0]);
      this.quad(t.bloom[i].fbo, this.bloomUp, t.bloom[i].w, t.bloom[i].h);
    }
    gl.disable(gl.BLEND);

    // 4. Tone map to the display.
    const fin = this.final.use().i1('uScene', 0).i1('uBloomTex', 1);
    this.frameUniforms(fin, frame);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.bloom[0].tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.sceneTex.tex);
    this.quad(null, this.final, w, h);
  }
}
