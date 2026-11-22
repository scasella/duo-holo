# MediaPipe Tasks Vision

These files are redistributed unmodified from Google's MediaPipe project, under the
Apache License 2.0 (see `LICENSE.txt`). The only change is that the source-map comments were
removed from the two bundles.

- `vision_bundle.mjs`, `vision_bundle.js`, `wasm/` — npm package `@mediapipe/tasks-vision` 1.2.3
- `blaze_face_short_range.tflite` — BlazeFace short-range face detector (float16, version 1),
  from `storage.googleapis.com/mediapipe-models/face_detector/`

They are used for head tracking. Camera frames are processed on the device and are not sent anywhere.
