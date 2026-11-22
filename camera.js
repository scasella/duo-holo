// Front camera + face detection, producing head observations for viewer.js.
// Frames are analysed on the device (MediaPipe's BlazeFace detector, running as WebAssembly)
// and are never stored or sent anywhere.
//
// Detection normally runs in a worker so it cannot hold up drawing. If the worker cannot be
// set up, the detector runs on the main thread instead, at a lower rate.

const here = (path) => new URL(path, import.meta.url).href;

/** Nearest face (widest gap between the eyes) as an observation for viewer.js.
 *  Kept in step with pickFace in track-worker.js. */
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

export class HeadCamera {
  constructor() {
    this.video = null;
    this.stream = null;
    this.mode = null;            // 'worker' or 'main' once the detector is loaded
    this.worker = null;
    this.detector = null;        // main-thread detector (fallback)
    this.ready = false;
    this.busy = false;           // a frame is with the worker
    this.result = undefined;     // latest unread result from the worker
    this.frameId = 0;
    this.lastVideoTime = -1;
    this.lastRun = 0;
    this.detectMs = 0;           // running average cost of one detection
    this.eyes = null;            // last detected eye points [[u, v], [u, v]] for the preview
    this.scratch = null;         // 2D canvas used when a video frame cannot be grabbed directly
    this.grabViaCanvas = false;
    this.note = '';              // why the fallback was taken, if it was
  }

  /** The camera is only available to pages loaded over https (or from localhost). */
  static supported() {
    return window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** Opens a camera: the one with `deviceId` if given and still present, otherwise the
   *  front-facing one, otherwise whatever the device has. */
  async open(deviceId) {
    const size = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
    const attempts = [{ facingMode: 'user', ...size }, true];
    if (deviceId) attempts.unshift({ deviceId: { exact: deviceId }, ...size });
    let failure;
    for (const video of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (e) {
        failure = e;
        // only a camera that is missing or cannot meet the request is worth another try
        if (!e || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      }
    }
    throw failure;
  }

  /** The camera in use, or null. */
  get deviceId() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    return track && track.getSettings ? track.getSettings().deviceId || null : null;
  }

  /** How many cameras the device offers. */
  async cameraCount() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
    } catch { return 0; }
  }

  /** Moves to the device's next camera, for phones where the first pick is not the one facing
   *  the viewer. Resolves true if the camera changed. */
  async switchCamera() {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (list.length < 2 || !this.video) return false;
    const current = list.findIndex((d) => d.deviceId === this.deviceId);
    const next = list[(current + 1) % list.length];
    const old = this.stream;
    old.getTracks().forEach((t) => t.stop());        // phones allow one open camera at a time
    this.stream = await this.open(next.deviceId);
    this.video.srcObject = this.stream;
    await this.video.play();
    this.lastVideoTime = -1;
    this.eyes = null;
    return true;
  }

  /** Opens the camera and loads the detector. `onStage` is told 'camera' then 'model'. */
  async start(onStage = () => {}, deviceId = null) {
    onStage('camera');
    this.stream = await this.open(deviceId);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    // kept in the page, but out of sight: some browsers stop decoding a video that is not displayed
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    video.srcObject = this.stream;
    document.body.appendChild(video);
    this.video = video;
    await video.play();

    onStage('model');
    await this.loadDetector();
    this.ready = true;
  }

  /** Loads the detector: in a worker if possible, otherwise on the main thread. */
  async loadDetector() {
    if (this.mode) return;
    try {
      await this.startWorker();
      this.mode = 'worker';
    } catch (e) {
      this.note = 'worker unavailable: ' + ((e && e.message) || e);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      await this.loadMainDetector();
      this.mode = 'main';
    }
  }

  startWorker() {
    return new Promise((resolve, reject) => {
      if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
        reject(new Error('no worker or image bitmap support'));
        return;
      }
      const worker = new Worker(here('./track-worker.js'));
      const timer = setTimeout(() => reject(new Error('timed out')), 25000);
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker failed to load')); };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          worker.onerror = null;
          resolve();
        } else if (m.type === 'result') {
          this.busy = false;
          this.detectMs = this.detectMs ? this.detectMs * 0.9 + m.ms * 0.1 : m.ms;
          this.eyes = m.face ? m.face.eyes : null;
          this.result = m.face ? { u: m.face.u, v: m.face.v, ipd: m.face.ipd, aspect: m.face.aspect } : null;
          if (this.onResult) this.onResult(this.result);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          this.busy = false;
          if (m.during === 'init') reject(new Error(m.message));
          else this.note = 'detection error: ' + m.message;
        }
      };
      this.worker = worker;
      worker.postMessage({ type: 'init' });
    });
  }

  async loadMainDetector() {
    if (this.detector) return;
    const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks(here('./vendor/mediapipe/wasm'));
    this.detector = await vision.FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: here('./vendor/mediapipe/blaze_face_short_range.tflite'), delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
  }

  /** True while the camera is delivering frames. */
  get live() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** Call once per rendered frame. Returns an observation, null (a frame was examined and had
   *  no face in it), or undefined when there is nothing new. */
  poll(nowMs) {
    const video = this.video;
    if (!this.ready || !video || video.readyState < 2 || !video.videoWidth) return undefined;
    const aspect = video.videoWidth / video.videoHeight;

    if (this.mode === 'worker') {
      if (!this.busy && video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;
        this.send(video, aspect, nowMs);
      }
      const r = this.result;
      this.result = undefined;
      return r;
    }

    if (video.currentTime === this.lastVideoTime) return undefined;
    // on the main thread a look costs drawing time: at most 30 a second, fewer if a look is slow
    const minGap = this.detectMs > 9 ? 66 : 30;
    if (nowMs - this.lastRun < minGap) return undefined;
    this.lastVideoTime = video.currentTime;
    this.lastRun = nowMs;
    return this.detectHere(video, aspect, nowMs);
  }

  /** Hands one frame to the worker. `source` is a video or canvas. */
  send(source, aspect, nowMs) {
    this.busy = true;
    const id = ++this.frameId;
    this.grab(source).then((bitmap) => {
      if (!this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, aspect, t: nowMs, id }, [bitmap]);
    }).catch((e) => {
      // could not get frames across: carry on with the detector on the main thread
      this.busy = false;
      this.note = 'frame grab failed: ' + ((e && e.message) || e);
      this.loadMainDetector().then(() => { this.mode = 'main'; if (this.worker) this.worker.terminate(); this.worker = null; });
    });
  }

  /** A transferable copy of the current frame, directly if the browser allows it, otherwise by
   *  drawing it to a small canvas first. */
  async grab(source) {
    if (!this.grabViaCanvas) {
      try { return await createImageBitmap(source); } catch { this.grabViaCanvas = true; }
    }
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const w = Math.min(sw, 480), h = Math.round(w * sh / sw);
    if (!this.scratch) this.scratch = document.createElement('canvas');
    if (this.scratch.width !== w || this.scratch.height !== h) { this.scratch.width = w; this.scratch.height = h; }
    this.scratch.getContext('2d').drawImage(source, 0, 0, w, h);
    return createImageBitmap(this.scratch);
  }

  /** Runs the main-thread detector on any image source; `aspect` is its width / height. */
  detectHere(source, aspect, nowMs) {
    const t0 = performance.now();
    const found = this.detector.detectForVideo(source, nowMs);
    const cost = performance.now() - t0;
    this.detectMs = this.detectMs ? this.detectMs * 0.9 + cost * 0.1 : cost;
    const face = pickFace(found.detections, aspect);
    this.eyes = face ? face.eyes : null;
    return face ? { u: face.u, v: face.v, ipd: face.ipd, aspect } : null;
  }

  /** Testing aid: runs the loaded detector once on `source` (a canvas) and resolves with the observation. */
  detectOnce(source, aspect) {
    if (this.mode !== 'worker') return Promise.resolve(this.detectHere(source, aspect, performance.now()));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.onResult = null; reject(new Error('no answer from the worker: ' + this.note)); }, 8000);
      this.onResult = (r) => { clearTimeout(timer); this.onResult = null; this.result = undefined; resolve(r); };
      this.send(source, aspect, performance.now());
    });
  }

  /** Draws the camera's view, mirrored like a selfie, with the detected eyes marked. */
  drawPreview(canvas) {
    const video = this.video;
    if (!video || !video.videoWidth) return;
    const w = canvas.width, h = Math.round(canvas.width * video.videoHeight / video.videoWidth);
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    if (this.eyes) {
      ctx.fillStyle = '#6ef0ff';
      for (const [u, v] of this.eyes) {
        ctx.beginPath();
        ctx.arc(u * w, v * h, Math.max(2.5, w * 0.022), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Releases the camera. The loaded detector is kept for next time. */
  stop() {
    this.ready = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) { this.video.srcObject = null; this.video.remove(); }
    this.video = null;
    this.eyes = null;
    this.result = undefined;
    this.busy = false;
    this.lastVideoTime = -1;
  }
}
