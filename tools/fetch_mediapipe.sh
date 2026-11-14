#!/bin/bash
# Downloads the pinned MediaPipe Tasks Vision runtime + models into web/ and verifies their checksums.
# MediaPipe is Apache-2.0 (see THIRD_PARTY_NOTICES.md).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.2.3
TGZ_URL="https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${VERSION}.tgz"
TGZ_SHA=469602650dab70256df387983ea44e85fa66020335bae85a54fa8fda062ca0a0
FACE_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
FACE_SHA=64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff
HAND_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
HAND_SHA=fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1

VENDOR=web/vendor/mediapipe
MODELS=web/models
if [ -f "$VENDOR/wasm/vision_wasm_internal.wasm" ] && [ -f "$MODELS/face_landmarker.task" ] && [ -f "$MODELS/hand_landmarker.task" ]; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() { # url sha out
  echo "↓ $(basename "$3")"
  curl -fsSL "$1" -o "$3"
  echo "$2  $3" | shasum -a 256 -c --quiet -
}
fetch "$TGZ_URL" "$TGZ_SHA" "$TMP/tasks-vision.tgz"
mkdir -p "$TMP/pkg" "$VENDOR/wasm" "$MODELS"
tar -xzf "$TMP/tasks-vision.tgz" -C "$TMP/pkg"
cp "$TMP/pkg/package/vision_bundle.mjs" "$VENDOR/"
cp "$TMP/pkg/package/vision_bundle.cjs" "$VENDOR/vision_bundle_worker.js"   # classic-worker friendly copy
cp "$TMP/pkg/package/wasm/vision_wasm_internal.js" "$TMP/pkg/package/wasm/vision_wasm_internal.wasm" "$VENDOR/wasm/"
fetch "$FACE_URL" "$FACE_SHA" "$MODELS/face_landmarker.task"
fetch "$HAND_URL" "$HAND_SHA" "$MODELS/hand_landmarker.task"
echo "MediaPipe ${VERSION} ready."
