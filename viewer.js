// Viewer tracking: turns observations of the viewer's head into an eye position for the
// projection, so the figure stays put in space as the viewer moves (motion parallax).
//
// An observation is what a face detector sees in one front-camera frame:
//   { u, v, ipd, aspect }
//   u, v    midpoint between the eyes in the frame, 0..1 from the top-left as delivered
//   ipd     distance between the pupils as a fraction of the frame width
//   aspect  frame width / height
// or null when no face was found.
//
// Assumptions, none of which can be read from the browser: the camera sits at the top centre of
// the raised (wall) half of the display and looks straight out of it; its field of view and the
// viewer's pupil distance are typical. Errors in these shift or scale the estimate by a few
// centimetres, which the sensitivity setting and dragging the viewpoint correct.
import { add, scale } from './vec.js';

export const PT_PER_MM = 153 / 25.4;      // screen points per millimetre (about 153 points per inch)

/** One Euro filter: steady when still, quick when moving. */
class OneEuro {
  constructor(minCutoff, beta) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = 1.0;
    this.x = null; this.dx = 0; this.t = 0;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (x - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

/** Focal length in frame widths for a camera whose longer side spans `fovLong` degrees. */
function focal(aspect, fovLong) {
  const long = Math.max(1, 1 / aspect);
  return (long / 2) / Math.tan(fovLong * Math.PI / 360);
}

export class ViewerTracker {
  constructor() {
    this.fovLong = 74;           // degrees across the frame's longer side
    this.ipdMm = 63;             // average adult pupil distance
    this.gain = 1;               // sideways / up-down sensitivity
    this.flipX = false;
    this.flipY = false;
    this.smoothing = true;
    this.lead = 0.05;            // seconds of look-ahead, to offset camera and smoothing delay
    this.reset();
  }

  reset() {
    this.head = null;            // latest head position in camera space, points
    this.found = false;
    this.lastSeen = -1e9;
    // sideways and up-down respond quickly; distance comes from a small measurement and is noisy
    this.filters = [new OneEuro(1.0, 0.005), new OneEuro(1.0, 0.005), new OneEuro(0.3, 0.0008)];
  }

  /** Head position in camera space (points): x to the right of the frame, y down the frame,
   *  z out along the optical axis. Null if the observation is not believable. */
  headFromObservation(o) {
    if (!(o.ipd > 0.012)) return null;
    const f = focal(o.aspect, this.fovLong);
    const mm = f * this.ipdMm / o.ipd;
    if (mm < 120 || mm > 1600) return null;
    const z = mm * PT_PER_MM;
    return [(o.u - 0.5) / f * z, (o.v - 0.5) / o.aspect / f * z, z];
  }

  observe(o, t) {
    let p = o ? this.headFromObservation(o) : null;
    if (!p) { this.found = false; return; }
    if (this.smoothing) {
      p = p.map((x, i) => this.filters[i].filter(x, t));
      // sideways and up-down: aim slightly ahead along the current (smoothed) motion
      for (let i = 0; i < 2; i++) p[i] += Math.max(-200, Math.min(200, this.filters[i].dx * this.lead));
    }
    this.head = p;
    this.found = true;
    this.lastSeen = t;
  }

  /** Distance from the camera to the viewer in centimetres, or null. */
  get distanceCm() { return this.head ? this.head[2] / PT_PER_MM / 10 : null; }

  /** The viewer's eye position in stage coordinates (points) for a wall half tilted at `theta`
   *  with the camera at `camera`, or null if the viewer has not been seen yet. The last known
   *  position is kept while the face is briefly lost. */
  position(theta, camera) {
    if (!this.head) return null;
    // The front camera looks back at the viewer, so its right is the viewer's left; frame y runs down.
    const right = (this.flipX ? 1 : -1) * this.gain * this.head[0];
    const up = (this.flipY ? 1 : -1) * this.gain * this.head[1];
    const wallUp = [0, Math.sin(theta), Math.cos(theta)];
    const wallOut = [0, -Math.cos(theta), Math.sin(theta)];
    return add(add(add(camera, [right, 0, 0]), scale(wallUp, up)), scale(wallOut, this.head[2]));
  }
}

/** What the camera would report for a viewer whose eyes are at `eye` (stage coordinates), under
 *  the tracker's own assumptions. Used to test the tracking chain without a camera. */
export function observationFor(eye, theta, camera, aspect = 0.75, fovLong = 74, ipdMm = 63) {
  const rel = [eye[0] - camera[0], eye[1] - camera[1], eye[2] - camera[2]];
  const wallUp = [0, Math.sin(theta), Math.cos(theta)];
  const wallOut = [0, -Math.cos(theta), Math.sin(theta)];
  const z = rel[1] * wallOut[1] + rel[2] * wallOut[2];
  const x = -rel[0];
  const y = -(rel[1] * wallUp[1] + rel[2] * wallUp[2]);
  const f = focal(aspect, fovLong);
  return { u: 0.5 + x / z * f, v: 0.5 + y / z * f * aspect, ipd: f * ipdMm * PT_PER_MM / z, aspect };
}
