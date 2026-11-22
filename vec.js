// Small vector / quaternion / matrix helpers. Vectors are [x, y, z], quaternions [x, y, z, w],
// matrices column-major Float32Array(16).

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [a[0], a[1], a[2]];
};
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mix = (a, b, t) => a + (b - a) * t;
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const QID = [0, 0, 0, 1];

/** Hamilton product: (a * b) rotates by b first, then a. */
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qaxis = (angle, axis) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
export const qact = (q, v) => {
  // v + 2w(u x v) + 2 u x (u x v)
  const u = [q[0], q[1], q[2]];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return [v[0] + 2 * (q[3] * uv[0] + uuv[0]), v[1] + 2 * (q[3] * uv[1] + uuv[1]), v[2] + 2 * (q[3] * uv[2] + uuv[2])];
};
/** Shortest-arc rotation taking unit vector a onto unit vector b. */
export const qfromto = (a, b) => {
  const d = dot(a, b);
  if (d > 0.99999) return [0, 0, 0, 1];
  if (d < -0.99999) {
    let axis = cross(a, [1, 0, 0]);
    if (length(axis) < 1e-3) axis = cross(a, [0, 0, 1]);
    return qaxis(Math.PI, normalize(axis));
  }
  return qaxis(Math.acos(d), normalize(cross(a, b)));
};
export const qslerp = (a, b, t) => {
  let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (c < 0) { c = -c; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (c > 0.9995) {
    const q = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(c), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
};
/** Quaternion from an orthonormal basis given as columns x, y, z. */
export const qbasis = (x, y, z) => {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** Writes the rigid transform (rotation q, translation t) into out[offset...] as a column-major mat4. */
export const writeRigid = (out, offset, q, t) => {
  const [x, y, z, w] = q;
  out[offset] = 1 - 2 * (y * y + z * z); out[offset + 1] = 2 * (x * y + z * w); out[offset + 2] = 2 * (x * z - y * w); out[offset + 3] = 0;
  out[offset + 4] = 2 * (x * y - z * w); out[offset + 5] = 1 - 2 * (x * x + z * z); out[offset + 6] = 2 * (y * z + x * w); out[offset + 7] = 0;
  out[offset + 8] = 2 * (x * z + y * w); out[offset + 9] = 2 * (y * z - x * w); out[offset + 10] = 1 - 2 * (x * x + y * y); out[offset + 11] = 0;
  out[offset + 12] = t[0]; out[offset + 13] = t[1]; out[offset + 14] = t[2]; out[offset + 15] = 1;
};

export const mat4mul = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
};
