# Third-party notices

## MediaPipe Tasks Vision (runtime + models)

MiniMe uses [MediaPipe](https://github.com/google-ai-edge/mediapipe) for face and hand tracking:

- `@mediapipe/tasks-vision` 1.2.3 (JavaScript + WebAssembly runtime)
- `face_landmarker.task` and `hand_landmarker.task` models

Copyright Google LLC. Licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0

These files are not stored in this repository; `tools/fetch_mediapipe.sh` downloads the pinned
versions (checked against SHA-256 hashes) at build time, and release builds bundle them unmodified.

## Artwork

The characters, room, desk and hand drawings in `art/` and `web/assets/` were generated with
ChatGPT image generation for this project and are released under this project's MIT license.
