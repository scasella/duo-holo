// Port of DuoHolo/Animator.swift: a looping dance (keyframed poses with a procedural groove on
// top), two-bone IK for the legs so the feet stay planted, and spring bones for hair and skirt.
// Joint frames are world-aligned in the bind pose.
import {
  add, sub, scale, dot, cross, length, normalize, lerp3, mix, clamp, smoothstep,
  QID, qmul, qinv, qaxis, qact, qfromto, qslerp, qbasis, writeRigid,
} from './vec.js';

const n3 = (x, y, z) => normalize([x, y, z]);

/** A full-body pose in character space (metres; she faces +z, her left is +x). Arm directions
 *  are authored as if for the left arm and mirrored for the right arm when applied. */
function makePose() {
  return {
    hipsPos: [0, -0.012, 0],
    hipsRot: [0, 0, 0],            // pitch, yaw, roll
    spineRot: [0, 0, 0],
    chestRot: [0, 0, 0],
    headRot: [0, 0, 0],
    upperL: [0.34, -0.93, 0.10],
    foreL: [0.26, -0.88, 0.38],
    upperR: [0.34, -0.93, 0.10],
    foreR: [0.26, -0.88, 0.38],
    footL: [0, 0, 0],              // ankle offset from the bind pose
    footR: [0, 0, 0],
    footYawL: 0.16,
    footYawR: 0.16,
    footPitchL: 0,
    footPitchR: 0,
    yaw: 0,
  };
}

function clonePose(p) {
  const q = {};
  for (const k in p) q[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
  return q;
}

const DIRECTIONS = ['upperL', 'foreL', 'upperR', 'foreR'];
const VECTORS = ['hipsPos', 'hipsRot', 'spineRot', 'chestRot', 'headRot', 'footL', 'footR'];
const SCALARS = ['footYawL', 'footYawR', 'footPitchL', 'footPitchR', 'yaw'];

function mixPose(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const p = {};
  for (const k of VECTORS) p[k] = lerp3(a[k], b[k], t);
  for (const k of SCALARS) p[k] = mix(a[k], b[k], t);
  for (const k of DIRECTIONS) {
    // spherical interpolation keeps arms from shortening mid-move
    const x = normalize(a[k]);
    p[k] = qact(qslerp(QID, qfromto(x, normalize(b[k])), t), x);
  }
  return p;
}

const euler = (r) => qmul(qmul(qaxis(r[1], [0, 1, 0]), qaxis(r[0], [1, 0, 0])), qaxis(r[2], [0, 0, 1]));

/** Orientation whose -y axis lies along dir and whose z axis leans towards pole. */
function limbFrame(dir, pole) {
  const y = scale(dir, -1);
  let z = sub(pole, scale(y, dot(pole, y)));
  if (length(z) < 1e-4) z = sub([0, 0, 1], scale(y, y[2]));
  z = normalize(z);
  return qbasis(cross(y, z), y, z);
}

const hash = (x) => {
  const s = Math.sin(x * 127.1 + 11.7) * 43758.547;
  return s - Math.floor(s);
};

export class Animator {
  constructor(joints) {
    this.joints = joints;                      // [{name, parent, bind:[x,y,z], tip?}]
    const n = joints.length;
    this.palette = new Float32Array(16 * n);
    this.worldRot = Array.from({ length: n }, () => QID);
    this.worldPos = Array.from({ length: n }, () => [0, 0, 0]);
    this.local = Array.from({ length: n }, () => QID);
    this.offset = Array.from({ length: n }, () => [0, 0, 0]);
    this.index = new Map(joints.map((j, i) => [j.name, i]));

    this.blink = 0;
    this.mouth = 0;
    this.gaze = [0, 0];
    this.beatPulse = 0;
    this.yawOverride = null;
    this.viewerAzimuth = 0;
    this.bpm = 112;
    this.step = 1 / 120;
    this.simTime = null;
    this.smoothedLook = 0;

    const J = joints;
    const j = (name) => (this.index.has(name) ? this.index.get(name) : -1);
    this.ids = { root: j('root'), hips: j('hips'), spine: j('spine'), chest: j('chest'), neck: j('neck'), head: j('head'), halo: j('halo') };

    this.legs = [];
    this.arms = [];
    for (const side of ['L', 'R']) {
      const u = j('upperLeg.' + side), l = j('lowerLeg.' + side), f = j('foot.' + side);
      if (u >= 0 && l >= 0 && f >= 0) {
        const d1 = sub(J[l].bind, J[u].bind), d2 = sub(J[f].bind, J[l].bind);
        this.legs.push({
          upper: u, lower: l, foot: f, l1: length(d1), l2: length(d2),
          bindUpper: limbFrame(normalize(d1), [0, 0, 1]), bindLower: limbFrame(normalize(d2), [0, 0, 1]),
        });
      }
      const ua = j('upperArm.' + side), la = j('lowerArm.' + side), h = j('hand.' + side);
      if (ua >= 0 && la >= 0 && h >= 0) {
        this.arms.push({ upper: ua, lower: la, hand: h, bindDir: normalize(sub(J[la].bind, J[ua].bind)) });
      }
    }
    this.legIndex = new Map(this.legs.map((leg, i) => [leg.upper, i]));

    this.springs = new Map();
    const addSpring = (name, stiffness, drag, gravity, radius) => {
      const id = j(name);
      if (id < 0) return;
      const child = J.findIndex((x) => x.parent === id);
      const end = child >= 0 ? J[child].bind : J[id].tip;
      if (!end) return;
      const d = sub(end, J[id].bind);
      this.springs.set(id, {
        axis: normalize(d), length: length(d), stiffness, drag, gravity, radius,
        current: [0, 0, 0], previous: [0, 0, 0], started: false,
      });
    };
    const tailStiff = [0, 2.6, 1.5, 1.0, 0.8, 0.7, 0.6];
    for (let k = 1; k < 7; k++) addSpring('tail' + k, tailStiff[k], 0.16, 0.55, 0.045);
    for (const side of ['L', 'R']) {
      addSpring('lock' + side + '0', 2.2, 0.22, 0.35, 0.012);
      addSpring('lock' + side + '1', 1.6, 0.22, 0.35, 0.012);
    }
    for (let k = 0; k < 8; k++) addSpring('skirt' + k, 3.4, 0.20, 0.10, 0.0);

    this.colliders = [];
    const addCollider = (name, offset, radius) => {
      const id = j(name);
      if (id >= 0) this.colliders.push({ joint: id, offset, radius });
    };
    addCollider('head', [0, 0.138, -0.004], 0.131);
    addCollider('chest', [0, 0.050, 0], 0.105);
    addCollider('spine', [0, 0.0, 0], 0.090);
    addCollider('hips', [0, -0.02, 0], 0.125);
    addCollider('hips', [0, -0.13, 0], 0.170);

    this.moves = [this.stepTouch.bind(this), this.wave.bind(this), this.pointAndPose.bind(this), this.spin.bind(this)];
  }

  /** Advances to `time`, stepping at a fixed rate so hair behaves the same at any frame rate. */
  update(time) {
    let t = this.simTime === null ? time - 2.5 : this.simTime;
    if (time < t || time - t > 4) {
      t = time - 2.5;
      for (const s of this.springs.values()) s.started = false;
    }
    let steps = 0;
    while (t + this.step <= time && steps < 600) {
      t += this.step;
      this.simulate(t);
      steps += 1;
    }
    this.simTime = t;
  }

  simulate(t) {
    for (let i = 0; i < this.local.length; i++) { this.local[i] = QID; this.offset[i] = [0, 0, 0]; }
    const beat = t * this.bpm / 60;
    this.beatPulse = Math.pow(1 - (beat - Math.floor(beat)), 2.2);

    let pose = this.choreography(beat);
    if (this.yawOverride !== null) { pose = clonePose(pose); pose.yaw = this.yawOverride; }

    // The head and eyes drift towards wherever the viewer is.
    let rel = this.viewerAzimuth - pose.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const facing = smoothstep(2.0, 1.0, Math.abs(rel));
    this.smoothedLook += (clamp(rel, -0.7, 0.7) * facing - this.smoothedLook) * (1 - Math.exp(-this.step * 6));
    pose.headRot = [pose.headRot[0], pose.headRot[1] + this.smoothedLook * 0.55, pose.headRot[2]];
    this.gaze = [clamp(this.smoothedLook * 0.9, -1, 1), 0.1];

    const bt = (t + 0.7) % 3.1;
    this.blink = bt >= 0 && bt < 0.14 ? Math.sin(bt / 0.14 * Math.PI) : 0;
    const syllable = Math.floor(beat * 2);
    const env = Math.abs(Math.sin(beat * 2 * Math.PI));
    const voiced = hash(syllable) > 0.22 ? 1 : 0;
    this.mouth = 0.08 + voiced * (0.25 + 0.55 * hash(syllable + 31)) * env;

    this.apply(pose, t);
  }

  // ------------------------------------------------------------ choreography

  seg(b, a, c) { return smoothstep(0, 1, (b - a) / (c - a)); }

  choreography(beat) {
    const bars = 8;
    const total = bars * this.moves.length;
    const b = ((beat % total) + total) % total;
    const index = Math.floor(b / bars) % this.moves.length;
    const phase = b - index * bars;
    let pose = this.moves[index](phase);
    const w = this.seg(phase, bars - 0.9, bars);
    if (w > 0) {
      const next = this.moves[(index + 1) % this.moves.length](0);
      // finish any turn on the same side so the blend never unwinds
      next.yaw += Math.round(pose.yaw / (2 * Math.PI)) * 2 * Math.PI;
      pose = mixPose(pose, next, w);
    }
    return pose;
  }

  /** Bounce and sway shared by every move. Lowest on the beat. */
  groove(p, b, bounce = 1, sway = 1) {
    const down = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
    const side = Math.sin(Math.PI * b);
    p.hipsPos[1] -= 0.030 * down * bounce;
    p.hipsPos[0] += 0.022 * side * sway;
    p.hipsRot[2] += 0.060 * side * sway;
    p.hipsRot[1] += 0.050 * side * sway;
    p.spineRot[2] -= 0.040 * side * sway;
    p.chestRot[2] -= 0.035 * side * sway;
    p.chestRot[0] += 0.030 * down * bounce;
    p.headRot[2] += 0.050 * side * sway;
    p.headRot[0] += 0.050 * down * bounce;
  }

  stepTouch(b) {
    const p = makePose();
    const c = b % 4;
    const stride = 0.13;
    // 1: right steps out, 2: left closes, 3: left steps back, 4: right closes
    const r = -stride * (this.seg(c, 0, 0.8) - this.seg(c, 3, 3.8));
    const l = -stride * (this.seg(c, 1, 1.8) - this.seg(c, 2, 2.8));
    const lift = (a) => { const u = (c - a) / 0.8; return u > 0 && u < 1 ? Math.sin(u * Math.PI) : 0; };
    const rl = lift(0) + lift(3), ll = lift(1) + lift(2);
    p.footR = [r, 0.055 * rl, 0.01 * rl];
    p.footL = [l, 0.055 * ll, 0.01 * ll];
    p.footPitchR = 0.5 * rl; p.footPitchL = 0.5 * ll;
    p.hipsPos[0] += (r + l) / 2;
    const s = Math.sin(Math.PI * b / 2 + 0.3);
    p.upperL = n3(0.80, -0.50, 0.30); p.upperR = n3(0.80, -0.50, 0.30);
    p.foreL = n3(0.12 + 0.42 * s, 0.84, 0.46); p.foreR = n3(0.12 - 0.42 * s, 0.84, 0.46);
    p.chestRot[1] = 0.16 * s;
    p.headRot[2] = 0.10 * s;
    p.yaw = 0.14 * Math.sin(Math.PI * b / 4);
    this.groove(p, b);
    return p;
  }

  wave(b) {
    const p = makePose();
    const w = Math.sin(2 * Math.PI * b);
    p.upperR = n3(0.40, 0.88, 0.20);
    p.foreR = n3(0.16 + 0.50 * w, 0.92, 0.22);
    p.upperL = n3(0.80, -0.56, -0.20);
    p.foreL = n3(-0.60, -0.52, 0.60);
    p.hipsPos[0] = 0.030;
    p.hipsRot[2] = 0.09;
    p.spineRot[2] = -0.05;
    p.chestRot[1] = -0.14;
    p.headRot[2] = -0.12 + 0.05 * w;
    p.footR = [-0.035, 0.0, 0.03];
    const tap = Math.max(0, Math.sin(2 * Math.PI * b + Math.PI));
    p.footPitchR = 0.35 * tap;
    p.footR[1] = 0.018 * tap;
    p.yaw = -0.30 + 0.10 * Math.sin(Math.PI * b / 2);
    this.groove(p, b, 1.1, 0.7);
    return p;
  }

  pointAndPose(b) {
    const hipHand = makePose();              // helper: both hands on hips
    hipHand.upperL = n3(0.80, -0.56, -0.20); hipHand.foreL = n3(-0.60, -0.52, 0.60);
    hipHand.upperR = hipHand.upperL.slice(); hipHand.foreR = hipHand.foreL.slice();

    const pointR = clonePose(hipHand);
    pointR.upperR = n3(0.34, 0.02, 0.94); pointR.foreR = n3(0.24, 0.10, 0.97);
    pointR.chestRot = [0.06, 0.34, 0]; pointR.hipsRot[1] = 0.16;
    pointR.hipsPos[0] = 0.03; pointR.headRot = [0, -0.20, 0.08];
    pointR.footR = [-0.03, 0, 0.07]; pointR.yaw = 0.18;

    const pointL = clonePose(hipHand);
    pointL.upperL = n3(0.34, 0.02, 0.94); pointL.foreL = n3(0.24, 0.10, 0.97);
    pointL.chestRot = [0.06, -0.34, 0]; pointL.hipsRot[1] = -0.16;
    pointL.hipsPos[0] = -0.03; pointL.headRot = [0, 0.20, -0.08];
    pointL.footL = [0.03, 0, 0.07]; pointL.yaw = -0.18;

    const up = makePose();
    const s = Math.sin(Math.PI * b);
    up.upperL = n3(0.44, 0.88, 0.10); up.upperR = up.upperL.slice();
    up.foreL = n3(0.10 + 0.30 * s, 0.96, 0.10); up.foreR = n3(0.10 - 0.30 * s, 0.96, 0.10);
    up.chestRot[0] = -0.08; up.headRot[0] = -0.10;
    up.hipsPos[0] = 0.03 * s;

    const peace = makePose();
    peace.upperR = n3(0.62, -0.22, 0.62); peace.foreR = n3(-0.46, 0.80, 0.36);
    peace.upperL = n3(0.74, -0.64, -0.12); peace.foreL = n3(0.84, -0.50, 0.18);
    peace.headRot = [0.02, -0.10, -0.22];
    peace.hipsPos[0] = 0.045; peace.hipsRot[2] = 0.12; peace.spineRot[2] = -0.08; peace.chestRot[2] = -0.06;
    peace.footR = [-0.10, 0.03, 0.02]; peace.footPitchR = 0.75; peace.footYawR = 0.5;
    peace.yaw = 0.20;

    let p = mixPose(pointR, pointL, this.seg(b, 1.6, 2.1));
    p = mixPose(p, up, this.seg(b, 3.5, 4.1));
    p = clonePose(mixPose(p, peace, this.seg(b, 5.6, 6.2)));
    // a little punch on each pointing beat
    const punch = Math.max(0, 1 - (b - Math.floor(b)) * 3) * (b < 4 ? 1 : 0);
    p.chestRot[0] += 0.05 * punch;
    this.groove(p, b, b < 6 ? 1 : 0.5, b < 4 ? 0.3 : (b < 6 ? 1.0 : 0.25));
    return p;
  }

  spin(b) {
    const open = makePose();
    open.upperL = n3(0.90, -0.36, 0.10); open.upperR = open.upperL.slice();
    open.foreL = n3(0.94, -0.26, 0.20); open.foreR = open.foreL.slice();
    open.footR = [0.0, 0.10, -0.06]; open.footPitchR = 0.9;
    open.hipsPos[1] = 0.0;
    open.chestRot[0] = -0.05;

    const heart = makePose();
    heart.upperL = n3(0.50, -0.72, 0.48); heart.upperR = heart.upperL.slice();
    heart.foreL = n3(-0.52, 0.52, 0.68); heart.foreR = heart.foreL.slice();
    heart.headRot = [0.10, 0, 0.10];
    heart.chestRot[0] = 0.06;

    const give = makePose();
    give.upperL = n3(0.74, 0.10, 0.62); give.upperR = give.upperL.slice();
    give.foreL = n3(0.58, 0.52, 0.62); give.foreR = give.foreL.slice();
    give.headRot = [-0.10, 0, -0.06];
    give.chestRot[0] = -0.08;

    let p = mixPose(makePose(), open, this.seg(b, 0.0, 0.5));
    p = mixPose(p, heart, this.seg(b, 3.2, 4.0));
    p = clonePose(mixPose(p, give, this.seg(b, 5.6, 6.3)));
    // one full turn over the first three beats; she rises onto the supporting foot while turning
    const turn = this.seg(b, 0.2, 3.2);
    p.yaw = 2 * Math.PI * turn;
    const spinning = Math.sin(turn * Math.PI);
    p.hipsPos[1] += 0.012 * spinning;
    this.groove(p, b, 1 - 0.8 * spinning, b < 3.5 ? 0.15 : 0.8);
    return p;
  }

  // ------------------------------------------------------------------ solving

  apply(pose, t) {
    const J = this.joints, ids = this.ids, local = this.local, offset = this.offset;
    const worldRot = this.worldRot, worldPos = this.worldPos;
    if (ids.root >= 0) local[ids.root] = qaxis(pose.yaw, [0, 1, 0]);
    if (ids.hips >= 0) { local[ids.hips] = euler(pose.hipsRot); offset[ids.hips] = pose.hipsPos; }
    if (ids.spine >= 0) local[ids.spine] = euler(pose.spineRot);
    if (ids.chest >= 0) local[ids.chest] = euler(pose.chestRot);
    if (ids.neck >= 0) local[ids.neck] = euler(scale(pose.headRot, 0.35));
    if (ids.head >= 0) local[ids.head] = euler(scale(pose.headRot, 0.65));
    if (ids.halo >= 0) {
      local[ids.halo] = qaxis(0.10, [Math.cos(t * 0.9), 0, Math.sin(t * 0.9)]);
      offset[ids.halo] = [0, 0.008 * Math.sin(t * 1.7), 0];
    }
    this.arms.forEach((arm, i) => {
      const m = i === 0 ? 1 : -1;
      const us = i === 0 ? pose.upperL : pose.upperR, fs = i === 0 ? pose.foreL : pose.foreR;
      const u = normalize([us[0] * m, us[1], us[2]]);
      const f = normalize([fs[0] * m, fs[1], fs[2]]);
      const qu = qfromto(arm.bindDir, u);
      local[arm.upper] = qu;
      local[arm.lower] = qmul(qmul(qinv(qu), qfromto(u, f)), qu);
    });

    const step = this.step;
    for (let i = 0; i < J.length; i++) {
      const j = J[i];
      if (j.parent < 0) {
        worldRot[i] = local[i];
        worldPos[i] = add(j.bind, offset[i]);
      } else {
        const p = j.parent;
        worldPos[i] = add(worldPos[p], qact(worldRot[p], add(sub(j.bind, J[p].bind), offset[i])));
        worldRot[i] = qmul(worldRot[p], local[i]);
      }

      const li = this.legIndex.get(i);
      if (li !== undefined && ids.root >= 0) {
        // Two-bone IK from the hip to an ankle target expressed in the root's frame.
        const leg = this.legs[li];
        const left = li === 0;
        const root = ids.root;
        const target = add(worldPos[root], qact(worldRot[root], add(J[leg.foot].bind, left ? pose.footL : pose.footR)));
        const yaw = left ? pose.footYawL : -pose.footYawR;
        const pitch = left ? pose.footPitchL : pose.footPitchR;
        const footRot = qmul(worldRot[root], qaxis(yaw, [0, 1, 0]));
        const pole = qact(footRot, normalize([0, 0.15, 1]));
        const h = worldPos[i];
        let toTarget = sub(target, h);
        const reach = leg.l1 + leg.l2 - 0.002;
        let d = length(toTarget);
        if (d > reach) { toTarget = scale(toTarget, reach / d); d = reach; }
        d = Math.max(d, 0.05);
        const dir = scale(toTarget, 1 / d);
        const cosA = clamp((leg.l1 * leg.l1 + d * d - leg.l2 * leg.l2) / (2 * leg.l1 * d), -1, 1);
        let side = sub(pole, scale(dir, dot(pole, dir)));
        side = length(side) > 1e-4 ? normalize(side) : [0, 0, 1];
        const knee = add(add(h, scale(dir, leg.l1 * cosA)), scale(side, leg.l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA))));
        const ankle = add(h, toTarget);
        const upperRot = qmul(limbFrame(normalize(sub(knee, h)), pole), qinv(leg.bindUpper));
        const lowerRot = qmul(limbFrame(normalize(sub(ankle, knee)), pole), qinv(leg.bindLower));
        worldRot[leg.upper] = upperRot;
        local[leg.lower] = qmul(qinv(upperRot), lowerRot);
        local[leg.foot] = qmul(qinv(lowerRot), qmul(footRot, qaxis(pitch, [1, 0, 0])));
      }

      const s = this.springs.get(i);
      if (s) {
        const parentRot = worldRot[j.parent];
        const rest = qact(parentRot, s.axis);
        const origin = worldPos[i];
        if (!s.started) {
          s.current = add(origin, scale(rest, s.length));
          s.previous = s.current;
          s.started = true;
        }
        let next = add(add(add(s.current, scale(sub(s.current, s.previous), 1 - s.drag)),
          scale(rest, s.stiffness * step)), [0, -s.gravity * step, 0]);
        next = add(origin, scale(normalize(sub(next, origin)), s.length));
        if (s.radius > 0) {
          for (const c of this.colliders) {
            const centre = add(worldPos[c.joint], qact(worldRot[c.joint], c.offset));
            const v = sub(next, centre);
            const dist = length(v);
            const minDist = c.radius + s.radius;
            if (dist < minDist && dist > 1e-5) {
              next = add(centre, scale(v, minDist / dist));
              next = add(origin, scale(normalize(sub(next, origin)), s.length));
            }
          }
        }
        s.previous = s.current;
        s.current = next;
        worldRot[i] = qmul(qfromto(rest, normalize(sub(next, origin))), parentRot);
      }

      writeRigid(this.palette, i * 16, worldRot[i], sub(worldPos[i], qact(worldRot[i], j.bind)));
    }
  }
}
