// MediaPipe in a worker, so the wallpaper keeps drawing at full speed.
// One worker runs the face landmarker, another the hand landmarker (they work in parallel).
// Classic worker: the CommonJS bundle only needs an `exports` object.
/* eslint-disable no-var */
var exports = {};
var module = { exports };
importScripts('vendor/mediapipe/vision_bundle_worker.js');
const { FilesetResolver, FaceLandmarker, HandLandmarker } = exports;

let task = null, kind = '';

const OPTIONS = {
  face: (delegate) => ({
    baseOptions: { modelAssetPath: 'models/face_landmarker.task', delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }),
  hands: (delegate) => ({
    baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }),
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    kind = m.kind;
    const Cls = kind === 'face' ? FaceLandmarker : HandLandmarker;
    try {
      const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', self.location.href).href);
      let delegate = m.delegate || 'GPU';
      try { task = await Cls.createFromOptions(fileset, OPTIONS[kind](delegate)); }
      catch (err) { delegate = delegate === 'GPU' ? 'CPU' : 'GPU'; task = await Cls.createFromOptions(fileset, OPTIONS[kind](delegate)); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', error: String((err && err.stack) || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    const { bitmap, ts } = m;
    try {
      const t0 = performance.now();
      const r = task.detectForVideo(bitmap, ts);
      const ms = performance.now() - t0;
      const out = kind === 'face'
        ? { faceLandmarks: r.faceLandmarks, faceBlendshapes: r.faceBlendshapes }
        : { landmarks: r.landmarks, handedness: r.handedness || r.handednesses };
      self.postMessage({ type: 'result', kind, ts, w: bitmap.width, h: bitmap.height, ms, out });
    } catch (err) {
      self.postMessage({ type: 'frameError', kind, error: String(err) });
    } finally {
      bitmap.close();
    }
  }
};
