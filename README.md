# Holo

A hologram stage for a half-open foldable phone. The picture is drawn separately for the two
halves of the screen, each with its own off-axis perspective, so a dancing figure appears to
stand in the wedge between them. With head tracking on, the front camera follows the viewer and
the figure stays put as they move.

**Open it:** https://scasella.github.io/duo-holo/

1. Open the link in Safari on the phone, then Share → Add to Home Screen and launch it from
   there for full screen.
2. Half-open the phone with the hinge horizontal and stand it on a table, camera half upright.
3. Tap **Follow my head** and allow the camera.
4. Tap **•••** and set **Hinge angle** to how far the phone is open.

Camera frames are analysed on the device and are never stored or sent anywhere.

## How it is put together

Plain JavaScript modules and WebGL2, with no build step.

- `main.js` — page shell: finds the fold, runs the dance, feeds the renderer
- `renderer.js`, `shaders.js` — the two off-axis views, stage, bloom
- `animator.js` — the dance, leg IK, hair and skirt springs
- `viewer.js`, `camera.js`, `track-worker.js` — head tracking
- `character.holo` — the figure, an original character generated procedurally
- `vendor/mediapipe/` — Google's MediaPipe face detector (Apache 2.0, see its `NOTICE.md`)
