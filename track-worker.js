// Face detection off the main thread, so looking for the viewer never costs a rendered frame.
// A classic worker: the detector's loader relies on importScripts.
importScripts('vendor/mediapipe/vision_bundle.js');

let detector = null;

/** Nearest face (widest gap between the eyes) as an observation for viewer.js.
 *  Kept in step with pickFace in camera.js. */
function pickFace(detections, aspect) {
  let best = null;
  for (const d of detections) {
    const k = d.keypoints;
    if (!k || k.length < 2) continue;
    const ipd = Math.hypot(k[0].x - k[1].x, (k[0].y - k[1].y) / aspect);
    if (!best || ipd > best.ipd) {
      best = { u: (k[0].x + k[1].x) / 2, v: (k[0].y + k[1].y) / 2, ipd, aspect, eyes: [[k[0].x, k[0].y], [k[1].x, k[1].y]] };
    }
  }
  return best;
}

async function init() {
  const base = new URL('vendor/mediapipe/', self.location.href).href;
  const files = await Vision.FilesetResolver.forVisionTasks(base + 'wasm');
  const options = {
    baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  };
  if (typeof OffscreenCanvas !== 'undefined') options.canvas = new OffscreenCanvas(1, 1);
  detector = await Vision.FaceDetector.createFromOptions(files, options);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await init();
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'frame') {
      const t0 = performance.now();
      const result = detector.detectForVideo(m.bitmap, m.t);
      const face = pickFace(result.detections, m.aspect);
      m.bitmap.close();
      self.postMessage({ type: 'result', face, ms: performance.now() - t0, id: m.id });
    }
  } catch (err) {
    if (m.bitmap && m.bitmap.close) m.bitmap.close();
    self.postMessage({ type: 'error', message: (err && err.message) || String(err), during: m.type, id: m.id });
  }
};
