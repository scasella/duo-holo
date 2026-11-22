// Page shell for the web build: finds the fold, runs the dance, and feeds the renderer.
import { Renderer, Stage, parseModel } from './renderer.js';
import { Animator } from './animator.js';
import { ViewerTracker, observationFor } from './viewer.js';
import { HeadCamera } from './camera.js';
import { clamp, smoothstep } from './vec.js';

const RAD = Math.PI / 180;
const query = new URLSearchParams(location.search);
const number = (key) => (query.has(key) && query.get(key) !== '' ? parseFloat(query.get(key)) : null);

/** URL overrides mirroring the native app's launch arguments, e.g. ?time=2.5&eye=0,34,2600&angle=100 */
const options = {
  time: number('time'),
  eye: query.has('eye') ? query.get('eye').split(',').map(Number) : null,   // azimuth deg, elevation deg, distance pt
  angle: number('angle'),
  yaw: number('yaw'),
  reveal: number('reveal'),
  debug: number('debug') || 0,
  dpr: number('dpr'),
  diorama: query.has('diorama'),
  stage: query.get('stage'),
  report: query.has('report'),
  // Testing without a camera:
  //   'sim'      a simulated viewer drives the tracker directly;  'simoff' the same viewer, tracking ignored
  //   'selftest' load the face detector and run it on a drawn face
  //   'fakecam'  replace the camera with a video of a drawn face moving about, then track it
  track: query.get('track'),
  sway: number('sway'),               // size of the simulated viewer's movement, 1 = default
};

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

let started = false;
function report(data) {
  if (options.report) fetch('/report', { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
}
/** Shows a start-up failure. Once the hologram is running, stray errors (Safari reports opaque
 *  "Script error." events from its own injected scripts) are only logged. */
function fail(message) {
  report({ error: String(message), started });
  if (started) return;
  const box = $('error');
  box.textContent = 'The hologram could not start.\n' + message;
  box.classList.add('on');
}
addEventListener('error', (e) => { if (e.message && e.message !== 'Script error.') fail(e.message); });
addEventListener('unhandledrejection', (e) => fail(e.reason && e.reason.message ? e.reason.message : String(e.reason)));

// ------------------------------------------------------------------ settings

const defaults = { hinge: 100, foldNudge: 0, stage: 'auto', tracking: false, gain: 1, flipX: false, flipY: false };
const settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem('holo.settings') || '{}')); } catch { /* private mode */ }
const save = () => { try { localStorage.setItem('holo.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

// ------------------------------------------------------------------- layout

const touch = navigator.maxTouchPoints > 0;
let layout = null;

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches;
}

/** Works out where the page sits on the physical screen. The fold runs across the middle of the
 *  screen, and on iOS the window's outer height is the height of that screen. In a browser tab
 *  the page starts below Safari's toolbar (outer minus inner height). As a Home Screen app the
 *  page starts at the top of the screen, though its viewport can stop a little short of the
 *  bottom, so the canvas is sized to the screen rather than to the viewport. */
function measure() {
  const W = window.innerWidth;
  let H = window.innerHeight;
  let screenH = H, pageTop = 0;
  const outer = window.outerHeight;
  if (touch && outer >= H && outer - H < 400) {
    screenH = outer;
    if (isStandalone()) H = outer;
    else pageTop = outer - H;
  }
  const posture = navigator.devicePosture ? navigator.devicePosture.type : null;
  const mode = options.stage || settings.stage;
  let wantFolded;
  if (options.diorama || mode === 'flat') wantFolded = false;
  else if (mode === 'folded') wantFolded = true;
  else if (posture) wantFolded = posture === 'folded';
  // No posture API (it needs https): assume a half-open Duo when the window has its unfolded shape.
  else wantFolded = touch && W >= 600 && W <= 720 && screenH >= 900 && screenH <= 1000;

  const cap = options.dpr || 2;                       // cap the backing store: phones have little GPU memory to spare
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
  const pxPerPt = pw / W;
  let foldY = screenH / 2 - pageTop + settings.foldNudge;
  foldY = Math.round(foldY * pxPerPt) / pxPerPt;      // land on a pixel row so the two halves meet exactly
  const folded = wantFolded && screenH > W * 1.05 && foldY > H * 0.2 && foldY < H * 0.8;
  layout = { W, H, pw, ph, pxPerPt, foldY, folded, screenTop: -pageTop };
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  $('guide').style.top = foldY + 'px';
}

// ------------------------------------------------------------------ viewer

const DEFAULT_EYE = [0, 34 * RAD, 2600];             // azimuth, elevation, distance (pt)
// The dragged viewpoint is remembered: with tracking on it is the correction for where this
// phone's camera really sits, which does not change between visits.
const savedEye = Array.isArray(settings.eye) && settings.eye.length === 3 && settings.eye.every(Number.isFinite) ? settings.eye : null;
const eye = (savedEye || DEFAULT_EYE).slice();
let smoothedEye = eye.slice();
let smoothedTheta = settings.hinge * RAD;

function resetEye() {
  eye[0] = DEFAULT_EYE[0]; eye[1] = DEFAULT_EYE[1]; eye[2] = DEFAULT_EYE[2];
  delete settings.eye;
  save();
}

/** Where a viewer sits for a given azimuth, elevation and distance, in stage coordinates. */
function seatFor(e, folded, H) {
  const d = [Math.sin(e[0]) * Math.cos(e[1]), Math.sin(e[1]), Math.cos(e[0]) * Math.cos(e[1])];
  return folded ? [d[0] * e[2], d[1] * e[2], d[2] * e[2]] : [d[0] * e[2], H * 0.42 + d[1] * e[2], d[2] * e[2]];
}

// Viewer tracking. With the camera on, the viewpoint follows the viewer's head and dragging
// becomes a correction on top of it; with it off, the viewpoint is wherever it was dragged to.
const tracker = new ViewerTracker();
const camera = new HeadCamera();
let trackState = HeadCamera.supported() ? 'off' : 'unsupported';   // unsupported | off | camera | model | on | denied | failed
let trackError = '';
let viewerNow = null;                                 // smoothed eye position used for drawing
let acquiredAt = -1e9;                                // when the viewer was first seen (for easing in)

/** A stand-in for the camera: a viewer who drifts around their seat on a known path, reported
 *  the way a face detector would report them. Lets the whole tracking chain be tested. */
const simulatedViewer = {
  truth: null,                                        // where the simulated eyes really are (stage coordinates)
  path(t) {
    const k = options.sway === null ? 1 : options.sway;
    return [700 * k * Math.sin(2 * Math.PI * t / 8), 240 * k * Math.sin(2 * Math.PI * t / 5.3), 280 * k * Math.sin(2 * Math.PI * t / 6.1)];
  },
  observe(t, base, theta, cameraPosition) {
    const d = this.path(t);
    this.truth = [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
    return observationFor(this.truth, theta, cameraPosition);
  },
};
const simulated = options.track === 'sim' || options.track === 'simoff';

async function startTracking() {
  if (trackState === 'unsupported' || trackState === 'camera' || trackState === 'model' || trackState === 'on') return;
  trackError = '';
  try {
    tracker.reset();
    await camera.start((stage) => { trackState = stage; syncControls(); }, settings.cameraId || null);
    trackState = 'on';
    settings.tracking = true;
    save();
    camera.cameraCount().then((n) => { $('switchCam').hidden = n < 2; });
  } catch (e) {
    camera.stop();
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    trackState = denied ? 'denied' : 'failed';
    const none = e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
    trackError = none ? 'No camera was found.' : (e && e.message) || String(e);
    report({ tracking: trackState, error: trackError });
  }
  syncControls();
}

function stopTracking() {
  camera.stop();
  if (trackState !== 'unsupported') trackState = 'off';
  settings.tracking = false;
  save();
  syncControls();
}

const pointers = new Map();
let gesture = null, lastTap = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
  startGesture();
  closePanel();
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p || !gesture) return;
  p.x = e.clientX; p.y = e.clientY;
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    eye[0] = clamp(gesture.az - (p.x - gesture.x) * 0.004, -1.1, 1.1);
    eye[1] = clamp(gesture.el + (p.y - gesture.y) * 0.003, 0.10, 1.25);
  } else if (pts.length >= 2 && gesture.spread > 0) {
    const spread = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    eye[2] = clamp(gesture.dist / Math.max(spread / gesture.spread, 0.05), 1200, 6000);
  }
});
function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && gesture) { settings.eye = eye.slice(); save(); }
  if (p && e.type === 'pointerup' && pointers.size === 0) {
    const now = performance.now();
    const quick = now - p.t0 < 280 && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 12;
    if (quick && lastTap && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      resetEye();
      lastTap = null;
    } else {
      lastTap = quick ? { t: now, x: e.clientX, y: e.clientY } : null;
    }
  }
  startGesture();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
function startGesture() {
  const pts = [...pointers.values()];
  if (pts.length === 0) { gesture = null; return; }
  gesture = {
    az: eye[0], el: eye[1], dist: eye[2], x: pts[0].x, y: pts[0].y,
    spread: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
  };
}
// keep Safari from zooming or scrolling the page, which would move the fold
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => { if (!e.target.closest('#panel')) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- controls

const more = $('more'), panel = $('panel');
let idleTimer = 0;
function wake() {
  more.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!panel.classList.contains('open')) more.classList.add('idle'); }, 4000);
}
function closePanel() {
  panel.classList.remove('open');
  more.setAttribute('aria-expanded', 'false');
  wake();
}
more.addEventListener('click', () => {
  const open = panel.classList.toggle('open');
  more.setAttribute('aria-expanded', String(open));
  wake();
});
let guideTimer = 0;
const loadedAt = performance.now();
function trackStatusText() {
  switch (trackState) {
    case 'unsupported': return 'Needs the https link: the camera is not available to pages loaded over plain http.';
    case 'off': return 'Uses the front camera to keep her in place as you move. Video is analysed on this phone and never leaves it.';
    case 'camera': return 'Starting the camera…';
    case 'model': return 'Loading face tracking…';
    case 'on': return tracker.found ? 'Following you, about ' + Math.round(tracker.distanceCm) + ' cm from the camera.'
      : 'Looking for your face. Keep the half with the camera upright and facing you.';
    case 'denied': return 'Camera access was blocked. Allow the camera for this site, then turn this on again.';
    default: return 'Tracking could not start. ' + trackError;
  }
}
function syncControls() {
  const active = trackState === 'camera' || trackState === 'model' || trackState === 'on';
  for (const b of $('trackMode').children) {
    b.setAttribute('aria-pressed', String((b.dataset.on === '1') === active));
    b.disabled = trackState === 'unsupported';
  }
  $('trackStatus').textContent = trackStatusText();
  $('trackTools').hidden = trackState !== 'on';
  $('trackHelp').hidden = trackState !== 'on';
  $('gain').value = settings.gain; $('gainOut').textContent = Math.round(settings.gain * 100) + '%';
  for (const b of $('flips').children) b.setAttribute('aria-pressed', String(!!settings[b.dataset.flip]));
  tracker.gain = settings.gain; tracker.flipX = settings.flipX; tracker.flipY = settings.flipY;
  // offer tracking up front for the first while after loading, until it is switched on
  const offer = (trackState === 'off' || trackState === 'denied' || trackState === 'failed')
    && !simulated && performance.now() - loadedAt < 30000;
  $('follow').hidden = !offer;
  $('angle').value = settings.hinge; $('angleOut').textContent = Math.round(settings.hinge) + '°';
  $('fold').value = settings.foldNudge;
  $('foldOut').textContent = (settings.foldNudge > 0 ? '+' : '') + settings.foldNudge;
  for (const b of $('stageMode').children) b.setAttribute('aria-pressed', String(b.dataset.mode === settings.stage));
  const drag = active ? 'Drag to fine-tune where she stands.' : 'Drag to move your viewpoint, pinch to change distance.';
  $('tip').textContent = touch && !isStandalone() ? 'For full screen: Share, then Add to Home Screen. ' + drag : drag;
}
$('angle').addEventListener('input', (e) => { settings.hinge = parseFloat(e.target.value); save(); syncControls(); });
$('fold').addEventListener('input', (e) => {
  settings.foldNudge = parseFloat(e.target.value); save(); syncControls(); measure();
  $('guide').classList.add('on');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => $('guide').classList.remove('on'), 1600);
});
$('stageMode').addEventListener('click', (e) => {
  const mode = e.target.dataset.mode;
  if (!mode) return;
  settings.stage = mode; save(); syncControls(); measure();
});
$('reset').addEventListener('click', resetEye);
$('defaults').addEventListener('click', () => {
  Object.assign(settings, defaults, { tracking: settings.tracking });
  syncControls(); measure(); resetEye();
});
$('trackMode').addEventListener('click', (e) => {
  if (e.target.dataset.on === '1') startTracking();
  else if (e.target.dataset.on === '0') stopTracking();
});
$('follow').addEventListener('click', startTracking);
$('switchCam').addEventListener('click', async () => {
  if (trackState !== 'on') return;
  try {
    if (await camera.switchCamera()) {
      tracker.reset();
      settings.cameraId = camera.deviceId;
      save();
    }
  } catch (e) {
    trackError = (e && e.message) || String(e);
    stopTracking();
    trackState = 'failed';
    syncControls();
  }
});
$('gain').addEventListener('input', (e) => { settings.gain = parseFloat(e.target.value); save(); syncControls(); });
$('flips').addEventListener('click', (e) => {
  const key = e.target.dataset.flip;
  if (!key) return;
  settings[key] = !settings[key]; save(); syncControls();
});
setTimeout(syncControls, 30500);                      // retire the up-front offer
syncControls();
wake();

// The phone stops the camera while the page is in the background; pick it up again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || trackState !== 'on') return;
  if (camera.live) {
    camera.video.play().catch(() => {});
  } else {
    camera.stop();
    trackState = 'off';
    startTracking();
  }
});

// keep the screen on where the browser allows it (secure origins only)
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* denied */ }
}
document.addEventListener('visibilitychange', keepAwake);
canvas.addEventListener('pointerdown', () => { if (!wakeLock || wakeLock.released) keepAwake(); });

// -------------------------------------------------------------------- start

let renderer, animator, model;
let lastTime = 0, startTime = 0, revealStart = 0, wasFolded = null, running = true;

function frame(nowMs) {
  if (!running) return;
  requestAnimationFrame(frame);
  try { draw(nowMs); } catch (e) { running = false; started = false; fail(e.message || String(e)); }
}

let uiRefreshed = 0;
const stats = { frames: 0, since: 0, fps: 0, eye };
window.holoStats = stats;                             // for testing: frame rate and the current viewpoint
window.holoCamera = camera;

function draw(nowMs) {
  stats.frames += 1;
  if (nowMs - stats.since >= 4000) {
    if (stats.since) {
      stats.fps = Math.round(stats.frames * 10000 / (nowMs - stats.since)) / 10;
      const r = canvas.getBoundingClientRect(), vv = window.visualViewport;
      report({
        fps: stats.fps, canvas: [canvas.width, canvas.height], folded: layout.folded, foldY: layout.foldY,
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
        client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
        vv: vv ? [vv.width, vv.height, vv.offsetTop, vv.pageTop, vv.scale] : null,
        rect: [r.left, r.top, r.width, r.height], scroll: [scrollX, scrollY], standalone: isStandalone(),
        tracking: trackState, found: tracker.found, detectMs: Math.round(camera.detectMs * 10) / 10, detector: camera.mode,
      });
    }
    stats.frames = 0;
    stats.since = nowMs;
  }
  const now = nowMs / 1000;
  const dt = clamp(now - lastTime, 0, 0.05);
  lastTime = now;
  const frozen = options.time !== null;
  const time = frozen ? options.time : now - startTime;
  const { W, H, pw, ph, pxPerPt, foldY, folded } = layout;
  renderer.resize(pw, ph);

  // Stage layout: folded (wall + floor halves) or a diorama behind a single upright panel.
  const hinge = clamp(options.angle !== null ? options.angle : settings.hinge, 55, 160) * RAD;
  const targetTheta = folded ? hinge : Math.PI / 2;
  const modeChanged = wasFolded !== folded;
  smoothedTheta += (targetTheta - smoothedTheta) * (frozen || modeChanged ? 1 : 1 - Math.exp(-dt * 14));
  if (modeChanged) {                                  // (re)materialise whenever the stage changes shape
    wasFolded = folded;
    revealStart = time;
  }
  const reveal = options.reveal !== null ? options.reveal
    : (frozen ? 1.3 : smoothstep(0, 1, (time - revealStart - 0.25) / 1.7) * 1.3);

  let seatTarget = eye.slice();
  if (options.eye && options.eye.length === 3) seatTarget = [options.eye[0] * RAD, options.eye[1] * RAD, options.eye[2]];
  else if (!folded) seatTarget[1] = Math.min(seatTarget[1], 12 * RAD);
  const k = frozen ? 1 : 1 - Math.exp(-dt * 10);
  for (let i = 0; i < 3; i++) smoothedEye[i] += (seatTarget[i] - smoothedEye[i]) * k;
  // where the viewer is assumed to sit when nothing is tracking them
  const seat = seatFor(smoothedEye, folded, H);

  // Follow the viewer. The camera is taken to be at the top centre of the raised half.
  const theta = folded ? smoothedTheta : Math.PI / 2;
  const camUp = folded ? foldY - layout.screenTop - 10 : H - 10;
  const cameraPosition = [0, Math.sin(theta) * camUp, Math.cos(theta) * camUp];
  let tracked = null;
  if (simulated) {
    tracker.smoothing = !frozen;
    if (frozen) tracker.reset();
    tracker.observe(simulatedViewer.observe(time, seat, theta, cameraPosition), time);
    if (options.track === 'sim') tracked = tracker.position(theta, cameraPosition);
  } else if (trackState === 'on') {
    const seen = camera.poll(nowMs);
    if (seen !== undefined) tracker.observe(seen, now);
    else if (now - tracker.lastSeen > 1) tracker.found = false;   // frames stopped arriving
    tracked = tracker.position(theta, cameraPosition);
  }
  let target = seat;
  if (tracked) {
    // dragging nudges the tracked viewpoint: add how far the seat was moved from its default
    const base = seatFor(folded ? DEFAULT_EYE : [0, Math.min(DEFAULT_EYE[1], 12 * RAD), DEFAULT_EYE[2]], folded, H);
    target = [tracked[0] + seat[0] - base[0], tracked[1] + seat[1] - base[1], tracked[2] + seat[2] - base[2]];
    // keep the eye in front of both halves of the display
    const out = -Math.cos(theta) * target[1] + Math.sin(theta) * target[2];
    if (out < 400) { target[1] += -Math.cos(theta) * (400 - out); target[2] += Math.sin(theta) * (400 - out); }
    target[1] = Math.max(target[1], 150);
    if (acquiredAt < -1e8) acquiredAt = now;
  } else {
    acquiredAt = -1e9;
  }
  if (!viewerNow || frozen) {
    viewerNow = target.slice();
  } else {
    // ease in over the first second after the viewer is found, then follow closely
    const rate = tracked ? 5 + 20 * smoothstep(0, 1, now - acquiredAt) : 5;
    const follow = 1 - Math.exp(-dt * rate);
    for (let i = 0; i < 3; i++) viewerNow[i] += (target[i] - viewerNow[i]) * follow;
  }
  if (trackState === 'on' && nowMs - uiRefreshed > 120) {
    uiRefreshed = nowMs;
    $('trackStatus').textContent = trackStatusText();
    if (panel.classList.contains('open')) {
      camera.drawPreview($('preview'));
      const v = camera.video;
      $('trackDetails').textContent = 'Details: ' + [
        camera.mode === 'worker' ? 'background detector' : 'detector on main thread',
        Math.round(camera.detectMs) + ' ms per look',
        (stats.fps || '–') + ' fps',
        v && v.videoWidth ? 'camera ' + v.videoWidth + '×' + v.videoHeight : 'no video yet',
      ].join(', ') + (camera.note ? ' (' + camera.note + ')' : '');
    }
  }
  const viewer = viewerNow;
  stats.viewer = viewer;
  stats.truth = simulated ? simulatedViewer.truth : null;

  let stage, room, charPos, charHeight, ringRadius;
  if (folded) {
    stage = new Stage(W, H, foldY, smoothedTheta, viewer);
    room = [0, Math.cos(smoothedTheta), Math.sin(smoothedTheta), 0];
    // sized from the shorter half so the figure fits when the page isn't centred on the fold
    const half = Math.min(foldY, H - foldY);
    charPos = [0, 0, half * 0.31];
    charHeight = half * 1.0;
    ringRadius = Math.min(W * 0.15, half * 0.24);
  } else {
    stage = new Stage(W, H, H, Math.PI / 2, viewer);
    room = [-W * 1.0, 0, 1, 1];
    charPos = [0, 0, -W * 0.45];
    charHeight = H * 0.60;
    ringRadius = W * 0.20;
  }

  animator.yawOverride = options.yaw !== null ? options.yaw * RAD : null;
  animator.viewerAzimuth = Math.atan2(viewer[0], viewer[2]);   // she looks at wherever the viewer is
  animator.update(time);
  renderer.render({
    stage, pxPerPt, time, room, charPos, charHeight, ringRadius, reveal,
    palette: animator.palette, beat: animator.beatPulse, debug: options.debug,
    face: [animator.blink, animator.mouth, animator.gaze[0], animator.gaze[1]],
  });
}

/** Testing aid: draws the frame for `time` and posts it to the dev server as <name>.png.
 *  Returns where the viewer was assumed to be and (for a simulated viewer) where they really were. */
window.holoRender = async (time, name) => {
  running = false;                                    // stop the live loop; frames are produced on request
  options.time = time;
  draw(performance.now());
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  await fetch('/frame/' + name + '.png', { method: 'POST', body: blob });
  return { viewer: stats.viewer, truth: stats.truth, theta: smoothedTheta };
};

async function start() {
  measure();
  renderer = new Renderer(canvas);
  const response = await fetch('character.holo');
  if (!response.ok) throw new Error('character.holo did not load (' + response.status + ')');
  model = parseModel(await response.arrayBuffer());
  renderer.setModel(model);
  animator = new Animator(model.joints);
  startTime = performance.now() / 1000;
  lastTime = startTime;
  requestAnimationFrame(frame);
  started = true;
  report({ started: true, hdr: renderer.hdr, samples: renderer.samples, standalone: isStandalone(), layout,
    secure: window.isSecureContext, posture: navigator.devicePosture ? navigator.devicePosture.type : null, tracking: trackState });
  keepAwake();
  if (options.track === 'selftest') selfTest();
  else if (options.track === 'fakecam') fakeCamera();
  else if (settings.tracking && !simulated && trackState === 'off') startTracking();
}

/** Testing aid: stands in for the camera with a video of the drawn face moving on a known path,
 *  then starts tracking as a person would, so the whole camera pipeline runs. */
function fakeCamera() {
  const face = testFace();
  const feed = document.createElement('canvas');
  feed.width = 480; feed.height = 640;
  const g = feed.getContext('2d');
  const t0 = performance.now();
  const offset = (ms) => [90 * Math.sin(2 * Math.PI * ms / 6000), 40 * Math.sin(2 * Math.PI * ms / 4300)];
  const paint = () => {
    const [dx, dy] = offset(performance.now() - t0);
    g.fillStyle = '#5b6a78'; g.fillRect(0, 0, 480, 640);
    g.drawImage(face.canvas, dx, dy);
  };
  paint();
  setInterval(paint, 33);
  navigator.mediaDevices.getUserMedia = async () => feed.captureStream(30);
  trackState = 'off';
  const samples = [];
  const sampler = setInterval(() => {
    const [dx] = offset(performance.now() - t0);
    samples.push({ faceU: +((300 + dx) / 480).toFixed(3), viewerX: stats.viewer ? Math.round(stats.viewer[0]) : null, found: tracker.found });
    if (samples.length === 40) {
      clearInterval(sampler);
      report({ fakecam: true, state: trackState, detector: camera.mode, note: camera.note, detectMs: +camera.detectMs.toFixed(1),
        distanceCm: tracker.distanceCm && Math.round(tracker.distanceCm), fps: stats.fps, samples });
    }
  }, 250);
  startTracking();
}

/** Draws a plain cartoon face the detector recognises, for testing without a camera.
 *  Returns the canvas and where its eyes are, in the detector's terms. */
function testFace() {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 640;
  const g = c.getContext('2d');
  const cx = 300, cy = 250;
  g.fillStyle = '#5b6a78'; g.fillRect(0, 0, 480, 640);
  g.fillStyle = '#3a2a22'; g.beginPath(); g.ellipse(cx, cy - 20, 98, 120, 0, 0, 7); g.fill();
  const skin = g.createRadialGradient(cx - 20, cy - 10, 10, cx, cy, 130);
  skin.addColorStop(0, '#f0c8a8'); skin.addColorStop(1, '#c99672');
  g.fillStyle = skin; g.beginPath(); g.ellipse(cx, cy + 10, 82, 108, 0, 0, 7); g.fill();
  g.fillStyle = '#3a2a22'; g.beginPath(); g.ellipse(cx, cy - 80, 90, 46, 0, Math.PI, 0); g.fill();
  for (const sx of [-1, 1]) {
    g.fillStyle = '#fff'; g.beginPath(); g.ellipse(cx + sx * 34, cy - 8, 17, 9, 0, 0, 7); g.fill();
    g.fillStyle = '#3b2a1a'; g.beginPath(); g.arc(cx + sx * 34, cy - 8, 8, 0, 7); g.fill();
    g.strokeStyle = '#2c1e16'; g.lineWidth = 5; g.beginPath(); g.moveTo(cx + sx * 16, cy - 30); g.lineTo(cx + sx * 54, cy - 34); g.stroke();
  }
  g.strokeStyle = '#a87458'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx - 8, cy + 34); g.lineTo(cx + 8, cy + 36); g.stroke();
  g.strokeStyle = '#9c4a4a'; g.lineWidth = 7; g.beginPath(); g.moveTo(cx - 28, cy + 66); g.quadraticCurveTo(cx, cy + 78, cx + 28, cy + 66); g.stroke();
  g.fillStyle = '#c99672'; g.fillRect(cx - 30, cy + 110, 60, 60);
  g.fillStyle = '#334'; g.fillRect(cx - 150, cy + 160, 300, 300);
  return { canvas: c, aspect: 480 / 640, u: cx / 480, v: (cy - 8) / 640, ipd: 68 / 480 };
}

/** Loads the face detector and runs it on a drawn face, to check the whole detection path
 *  works in this browser without needing a camera. */
async function selfTest() {
  const result = { selftest: true };
  try {
    const t0 = performance.now();
    await camera.loadDetector();
    result.loadMs = Math.round(performance.now() - t0);
    result.mode = camera.mode;
    const face = testFace();
    let seen = null;
    for (let i = 0; i < 12; i++) seen = await camera.detectOnce(face.canvas, face.aspect);
    result.detectMs = Math.round(camera.detectMs * 10) / 10;
    result.seen = seen && { u: +seen.u.toFixed(3), v: +seen.v.toFixed(3), ipd: +seen.ipd.toFixed(3) };
    result.expected = { u: +face.u.toFixed(3), v: +face.v.toFixed(3), ipd: +face.ipd.toFixed(3) };
    result.ok = !!seen && Math.abs(seen.u - face.u) < 0.03 && Math.abs(seen.v - face.v) < 0.03 && Math.abs(seen.ipd - face.ipd) < 0.03;
    if (camera.note) result.note = camera.note;
  } catch (e) {
    result.ok = false;
    result.error = (e && e.message) || String(e);
    if (camera.note) result.note = camera.note;
  }
  window.holoSelfTest = result;
  report(result);
}

addEventListener('resize', measure);
if (window.visualViewport) visualViewport.addEventListener('resize', measure);
if (navigator.devicePosture) navigator.devicePosture.addEventListener('change', measure);
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
canvas.addEventListener('webglcontextrestored', () => location.reload());

start().catch((e) => fail(e.message || String(e)));
