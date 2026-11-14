// MiniMe tracker — camera + MediaPipe (face mesh with 52 blendshapes, two hands) running in the page.
// Produces screen-space parameters for rig.js:
//   rig.setFace({yaw,pitch,roll,lean,px,py,eyeL,eyeR,sqL,sqR,gx,gy,browL,browR,browIn,jaw,smileL,smileR,frown,pucker,funnel,puff,mouthX})
//   rig.setHands([{side:'L'|'R', pts:[[x,y]×21] (face-relative: 1 = your face width, origin = between your eyes), gesture}])
//   rig.event('wave'|'thumbsUp'|'peace'|'heart'|'rock'|'ok'|'point'|'thumbsDown')

const post = (msg) => { try { window.webkit?.messageHandlers?.minime?.postMessage(msg); } catch (_) { /* browser */ } };
const log = (level, ...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  post({ type: 'log', level, msg: s });
  (level === 'error' ? console.error : console.log)('[tracker]', s);
};
window.addEventListener('error', (e) => log('error', 'page error:', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => log('error', 'unhandled:', String(e.reason && (e.reason.stack || e.reason))));

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const settings = () => (window.rig && window.rig.settings) || { mirror: true, debug: false };

const T = {
  ready: false, wantActive: false, stream: null, face: null, hands: null, delegate: '',
  video: document.createElement('video'),
  neutral: null, warm: [], lastFace: null, missing: 0, frameNo: 0, lastTs: 0,
  swapLR: 0,                 // evidence about MediaPipe's Left/Right blendshape convention
  handHist: { L: [], R: [] }, gestureRun: {}, lastEvent: {},
  stats: { frames: 0, faces: 0, hands: 0, faceMs: 0, handMs: 0, t0: performance.now() },
  lastParams: null, lastHands: [],
};
Object.assign(T.video, { muted: true, playsInline: true, autoplay: true });
T.video.setAttribute('playsinline', '');
Object.assign(T.video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
document.body.appendChild(T.video);

// ------------------------------------------------------------------ setup
// Preferred: MediaPipe runs in a Web Worker (keeps drawing smooth). Fallback: on the main thread.
const workers = { face: null, hands: null };
function startWorker(kind, delegate) {
  const w = new Worker('mp-worker.js');
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(kind + ' worker timeout')), 45000);
    w.onmessage = (e) => {
      if (e.data.type === 'ready') { clearTimeout(to); w.onmessage = onWorkerMessage; resolve({ w, delegate: e.data.delegate }); }
      else if (e.data.type === 'error') { clearTimeout(to); w.terminate(); reject(new Error(e.data.error)); }
    };
    w.onerror = (e) => { clearTimeout(to); w.terminate(); reject(new Error(e.message || 'worker error')); };
    w.postMessage({ type: 'init', kind, delegate });
  });
}
async function init() {
  try {
    // face on the CPU (fastest for it), hands on the GPU — in parallel
    const [f, h] = await Promise.all([startWorker('face', 'CPU'), startWorker('hands', 'GPU')]);
    workers.face = f.w; workers.hands = h.w;
    T.delegate = `face ${f.delegate} · hands ${h.delegate} (workers)`;
    T.mode = 'worker';
  } catch (e) {
    log('warn', 'workers unavailable, running on the main thread:', String(e));
    for (const k in workers) { if (workers[k]) workers[k].terminate(); workers[k] = null; }
    try {
      const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', location.href).href);
      const make = async (delegate) => ({
        face: await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: 'models/face_landmarker.task', delegate },
          runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        }),
        hands: await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate },
          runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        }),
      });
      try { Object.assign(T, await make('GPU')); T.delegate = 'GPU'; }
      catch (e2) { Object.assign(T, await make('CPU')); T.delegate = 'CPU'; }
      T.mode = 'main';
    } catch (e3) {
      log('error', 'MediaPipe init failed:', String((e3 && e3.stack) || e3));
      post({ type: 'trackerFailed', error: String(e3) });
      return;
    }
  }
  T.ready = true;
  log('info', 'MediaPipe ready:', T.delegate);
  if (T.wantActive) startCamera();
}

async function startCamera() {
  if (T.stream || !T.ready) return;
  try {
    T.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
    });
  } catch (e) {
    log('error', 'camera:', e.name, e.message);
    post({ type: 'camera', state: e.name === 'NotAllowedError' ? 'denied' : 'nocamera' });
    T.stream = null;
    return;
  }
  if (!T.wantActive) { stopCamera(); return; }
  post({ type: 'camera', state: 'ok' });
  T.video.srcObject = T.stream;
  try { await T.video.play(); } catch (e) { log('warn', 'video.play', String(e)); }
  schedule();
}

function stopCamera() {
  if (T.stream) T.stream.getTracks().forEach((t) => t.stop());
  T.stream = null;
  T.video.srcObject = null;
  T.busy = { face: false, hands: false };
  window.rig && rig.setFace(null);
  window.rig && rig.setHands([]);
}

function schedule() {
  if (!T.stream) return;
  if (T.video.requestVideoFrameCallback) T.video.requestVideoFrameCallback(step);
  else requestAnimationFrame(step);
}

function step() {
  if (!T.stream) return;
  try { processFrame(); } catch (e) { log('error', 'process:', String((e && e.stack) || e)); }
  schedule();
}

// ------------------------------------------------------------------ per frame
function processFrame() {
  const v = T.video;
  if (v.readyState < 2 || !v.videoWidth) return;
  const ts = Math.max(performance.now(), T.lastTs + 1);
  T.lastTs = ts;
  T.frameNo++;
  const recording = window.rig && rig.isRecording && rig.isRecording();
  const doHands = T.frameNo % (recording ? 3 : 2) === 0;   // hands at a lower rate (they're heavier)

  if (T.mode === 'worker') {
    const busy = T.busy || (T.busy = { face: false, hands: false });
    const send = (kind) => {
      if (busy[kind] && performance.now() - (busy[kind + 'Since'] || 0) < 1500) return;
      busy[kind] = true; busy[kind + 'Since'] = performance.now();
      createImageBitmap(v).then((bitmap) => workers[kind].postMessage({ type: 'frame', bitmap, ts }, [bitmap]))
        .catch((e) => { busy[kind] = false; log('warn', 'bitmap', String(e)); });
    };
    send('face');
    if (doHands) send('hands');
    return;
  }
  T.stats.frames++;
  let t0 = performance.now();
  const fr = T.face.detectForVideo(v, ts);
  T.stats.faceMs += performance.now() - t0;
  handleFace(fr, v.videoWidth, v.videoHeight);
  if (doHands) {
    t0 = performance.now();
    const hr = T.hands.detectForVideo(v, ts);
    T.stats.handMs += performance.now() - t0;
    handleHands(hr, v.videoWidth, v.videoHeight);
  }
  if (settings().debug) drawDebug(fr);
  reportStatus();
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'frameError') { if (T.busy) T.busy[m.kind] = false; log('warn', 'worker frame:', m.error); return; }
  if (m.type !== 'result') return;
  if (T.busy) T.busy[m.kind] = false;
  if (!T.stream) return;
  if (m.kind === 'face') {
    T.stats.frames++;
    T.stats.faceMs += m.ms;
    handleFace(m.out, m.w, m.h);
    T.lastFaceRes = m.out;
    if (settings().debug) drawDebug(m.out);
    reportStatus();
  } else {
    T.stats.handFrames = (T.stats.handFrames || 0) + 1;
    T.stats.handMs += m.ms;
    handleHands(m.out, m.w, m.h);
  }
}

const NEUTRAL_KEYS = ['yaw', 'pitch', 'cx', 'cy', 'width'];

function handleFace(res, W, H) {
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  if (!lm) {
    if (++T.missing === 6) { window.rig && rig.setFace(null); T.lastFace = null; }
    return;
  }
  T.missing = 0;
  T.stats.faces++;
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H, z: lm[i].z * W });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // --- head pose from 3D landmarks (image space: x right, y down, z away from camera)
  const a1 = sub(P(454), P(234)), a2 = sub(P(263), P(33));            // image-left → image-right
  const ax = a1.x + a2.x, ay = a1.y + a2.y, az = a1.z + a2.z;
  const b1 = sub(P(10), P(152)), b2 = sub(P(168), P(199));            // chin → forehead
  const by = b1.y + b2.y, bz = b1.z + b2.z;
  const raw = {
    yaw: Math.atan2(az, ax),          // + = nose toward image right
    pitch: Math.atan2(bz, -by),       // + = looking up
    roll: Math.atan2(ay, ax),         // + = clockwise
    cx: P(168).x / W, cy: P(168).y / H,
    width: Math.hypot(ax / 2, ay / 2, az / 2) / W,
  };
  T.lastFace = { c: P(168), fw: d2(P(234), P(454)), W, H };

  // --- blendshapes (raw scores)
  const Braw = {};
  for (const c of (res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories) || []) Braw[c.categoryName] = c.score;

  // neutral pose + resting expression: average of the first frames (or after "calibrate"),
  // then a slow drift so the camera angle and your resting face don't read as an expression
  if (!T.neutral) {
    T.warm.push({ raw, B: Braw });
    if (T.warm.length < 15) return;
    T.neutral = {}; T.base = {};
    for (const k of NEUTRAL_KEYS) T.neutral[k] = T.warm.reduce((s, w) => s + w.raw[k], 0) / T.warm.length;
    for (const k in Braw) T.base[k] = Math.min(T.warm.reduce((s, w) => s + (w.B[k] || 0), 0) / T.warm.length, 0.6);
    // a laptop camera sits above the screen: looking at the screen ≈ facing it, slightly looking down
    if (!T.explicitCalib) {
      T.neutral.yaw = clamp(T.neutral.yaw, -0.12, 0.12);
      T.neutral.pitch = clamp(T.neutral.pitch, -0.35, 0.05);
    }
    T.explicitCalib = false;
    T.warm = [];
    log('info', 'neutral', T.neutral);
  } else {
    const a = 1 / (30 * 90);   // ~90 s time constant
    for (const k of NEUTRAL_KEYS) T.neutral[k] += (raw[k] - T.neutral[k]) * a;
    for (const k in Braw) {     // only learn from near-resting values, so held expressions aren't absorbed
      const b = T.base[k] || 0;
      if (Braw[k] < b + 0.06) T.base[k] = Math.min(b + (Braw[k] - b) * 0.003, 0.6);
    }
  }
  const N = T.neutral, mirror = settings().mirror;
  const sx = mirror ? -1 : 1;
  const B = {};
  for (const k in Braw) { const b = T.base[k] || 0; B[k] = clamp((Braw[k] - b) / (1 - b), 0, 1); }

  // Which eye is MediaPipe's "Left"? Learn it from landmark eye openness (helps winks map to the right eye).
  const earImgL = d2(P(159), P(145)) / Math.max(d2(P(33), P(133)), 1);
  const earImgR = d2(P(386), P(374)) / Math.max(d2(P(263), P(362)), 1);
  const ev = (earImgL - earImgR) * ((Braw.eyeBlinkLeft || 0) - (Braw.eyeBlinkRight || 0));
  if (Math.abs(earImgL - earImgR) > 0.08) T.swapLR = clamp(T.swapLR + ev * 10, -5, 5);
  const leftIsImgRight = T.swapLR > -1;      // default: ARKit convention (subject's left = image right)
  // per-side value on the image-left / image-right side
  const img = (base) => {
    const l = B[base + 'Left'] || 0, r = B[base + 'Right'] || 0;
    return leftIsImgRight ? { L: r, R: l } : { L: l, R: r };
  };
  const scr = (base) => { const v = img(base); return mirror ? { L: v.R, R: v.L } : v; };

  const blink = scr('eyeBlink'), wide = scr('eyeWide'), squint = scr('eyeSquint');
  const open = (b, w) => clamp(1 - (b - 0.22) / 0.36, 0, 1) + w * 0.5;
  const smile = scr('mouthSmile'), frown = scr('mouthFrown');
  const browDown = scr('browDown'), browUp = scr('browOuterUp');
  const inner = B.browInnerUp || 0;
  // gaze: image-space x from the look-in/out blendshapes of both eyes
  const lookIn = img('eyeLookIn'), lookOut = img('eyeLookOut');
  const gxImg = ((lookIn.L - lookOut.L) + (lookOut.R - lookIn.R)) / 2;   // + = toward image right
  const gy = ((B.eyeLookDownLeft || 0) + (B.eyeLookDownRight || 0) - (B.eyeLookUpLeft || 0) - (B.eyeLookUpRight || 0)) / 2;
  const mouthXImg = leftIsImgRight ? (B.mouthLeft || 0) - (B.mouthRight || 0) : (B.mouthRight || 0) - (B.mouthLeft || 0);

  const out = {
    src: 'mp',
    yaw: sx * (raw.yaw - N.yaw),
    pitch: raw.pitch - N.pitch,
    roll: sx * raw.roll,
    lean: raw.width / N.width - 1,
    px: clamp(sx * (raw.cx - N.cx) * 2.4, -1, 1),
    py: clamp((raw.cy - N.cy) * 2.4, -1, 1),
    eyeL: open(blink.L, wide.L), eyeR: open(blink.R, wide.R),
    sqL: squint.L, sqR: squint.R,
    gx: clamp(sx * gxImg * 1.8, -1, 1), gy: clamp(gy * 1.6, -1, 1),
    browL: clamp(browUp.L * 1.3 + inner * 0.7 - browDown.L * 1.6, -1, 1),
    browR: clamp(browUp.R * 1.3 + inner * 0.7 - browDown.R * 1.6, -1, 1),
    browIn: inner,
    jaw: B.jawOpen || 0,
    smileL: smile.L, smileR: smile.R, frown: (frown.L + frown.R) / 2,
    pucker: B.mouthPucker || 0, funnel: B.mouthFunnel || 0, puff: B.cheekPuff || 0,
    mouthX: clamp(sx * mouthXImg * 1.5, -1, 1),
  };
  T.lastParams = out;
  window.rig && rig.setFace(out);
}

// ------------------------------------------------------------------ hands
function handleHands(res, W, H) {
  const list = res.landmarks || [];
  const F = T.lastFace;
  const mirror = settings().mirror;
  if (!list.length || !F) { T.lastHands = []; window.rig && rig.setHands([]); trackGestures([]); return; }
  T.stats.hands += list.length;
  const hands = list.map((lm) => {
    const px = lm.map((p) => ({ x: p.x * W, y: p.y * H }));
    const pts = px.map((p) => [((p.x - F.c.x) / F.fw) * (mirror ? -1 : 1), (p.y - F.c.y) / F.fw]);
    return { side: '', pts, px, gesture: classify(px) };
  });
  // Which of the kid's arms? Decided by where the hand is on screen (MediaPipe's left/right label is
  // unreliable): two hands → left one / right one; one hand → its side of your face, with hysteresis.
  if (hands.length >= 2) {
    hands.sort((a, b) => a.pts[0][0] - b.pts[0][0]);
    hands[0].side = 'L'; hands[1].side = 'R';
    hands.length = 2;
  } else {
    const h = hands[0], x = h.pts[0][0];
    h.side = x < -0.25 ? 'L' : x > 0.25 ? 'R' : (T.lastSide || (x < 0 ? 'L' : 'R'));
    T.lastSide = h.side;
  }
  if (hands.length === 2 && isHeart(hands[0].px, hands[1].px)) hands.forEach((h) => (h.gesture = 'heart'));
  T.lastHands = hands;
  window.rig && rig.setHands(hands.map(({ side, pts, gesture }) => ({ side, pts, gesture })));
  trackGestures(hands);
}

function fingers(p) {
  const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
  const palm = d(0, 9);
  const ext = (tip, pip, mcp) => d(tip, 0) > d(pip, 0) * 1.1 && d(tip, mcp) > d(pip, mcp) * 1.25;
  return {
    palm,
    thumb: d(4, 17) > d(3, 17) * 1.05 && d(4, 5) > palm * 0.42,
    index: ext(8, 6, 5), middle: ext(12, 10, 9), ring: ext(16, 14, 13), pinky: ext(20, 18, 17),
    pinch: d(4, 8) < palm * 0.32,
  };
}

function classify(p) {
  const f = fingers(p);
  const n = [f.index, f.middle, f.ring, f.pinky].filter(Boolean).length;
  if (f.pinch && f.middle && f.ring && f.pinky) return 'ok';
  if (n === 4) return 'open';
  if (n === 0) {
    if (f.thumb && p[4].y < p[2].y - f.palm * 0.35 && p[4].y < p[5].y) return 'thumbsUp';
    if (f.thumb && p[4].y > p[2].y + f.palm * 0.35) return 'thumbsDown';
    return 'fist';
  }
  if (f.index && f.middle && !f.ring && !f.pinky) return 'peace';
  if (f.index && !f.middle && !f.ring && f.pinky) return 'rock';
  if (f.index && !f.middle && !f.ring && !f.pinky) return 'point';
  return 'other';
}

function isHeart(a, b) {
  const palm = (Math.hypot(a[0].x - a[9].x, a[0].y - a[9].y) + Math.hypot(b[0].x - b[9].x, b[0].y - b[9].y)) / 2;
  const tipsIdx = Math.hypot(a[8].x - b[8].x, a[8].y - b[8].y);
  const tipsTh = Math.hypot(a[4].x - b[4].x, a[4].y - b[4].y);
  return tipsIdx < palm * 0.55 && tipsTh < palm * 0.55 && (a[8].y + b[8].y) < (a[4].y + b[4].y);
}

function trackGestures(hands) {
  const now = performance.now() / 1000;
  const seen = new Set();
  for (const h of hands) {
    seen.add(h.gesture);
    // wave: an open hand moving side to side
    const hist = T.handHist[h.side];
    hist.push({ t: now, x: h.pts[0][0], open: h.gesture === 'open' });
    while (hist.length && now - hist[0].t > 1.3) hist.shift();
    if (hist.length > 8 && hist.every((s) => s.open)) {
      let turns = 0, dir = 0, ext = hist[0].x, span = 0;
      for (const s of hist) {
        const dx = s.x - ext;
        if (Math.abs(dx) > 0.12) { const nd = Math.sign(dx); if (dir && nd !== dir) turns++; dir = nd; span = Math.max(span, Math.abs(dx)); ext = s.x; }
      }
      if (turns >= 2) fire('wave', now);
    }
  }
  for (const g of ['thumbsUp', 'peace', 'heart', 'rock', 'ok']) {
    T.gestureRun[g] = seen.has(g) ? (T.gestureRun[g] || 0) + 1 : 0;
    if (T.gestureRun[g] === (g === 'heart' ? 3 : 5)) fire(g, now);
  }
}

function fire(name, now) {
  if (now - (T.lastEvent[name] || 0) < 2.2) return;
  T.lastEvent[name] = now;
  window.rig && rig.event(name);
}

// ------------------------------------------------------------------ debug view & status
let dbgCanvas = null, dbgLast = 0;
function drawDebug(fr) {
  const now = performance.now();
  if (now - dbgLast < 90) return;
  dbgLast = now;
  const host = document.getElementById('debug');
  if (!dbgCanvas) { dbgCanvas = document.createElement('canvas'); dbgCanvas.width = 240; dbgCanvas.height = 180; dbgCanvas.style.cssText = 'display:block;border-radius:8px;margin-bottom:6px'; }
  if (host && dbgCanvas.parentNode !== host) host.prepend(dbgCanvas);
  const g = dbgCanvas.getContext('2d'), w = 240, h = 180;
  g.save();
  if (settings().mirror) { g.translate(w, 0); g.scale(-1, 1); }
  g.drawImage(T.video, 0, 0, w, h);
  const lm = fr.faceLandmarks && fr.faceLandmarks[0];
  g.fillStyle = 'rgba(120,255,200,0.9)';
  if (lm) for (let i = 0; i < lm.length; i += 3) g.fillRect(lm[i].x * w - 0.6, lm[i].y * h - 0.6, 1.2, 1.2);
  g.strokeStyle = 'rgba(255,170,90,0.95)'; g.lineWidth = 1.5;
  const chains = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];
  for (const hnd of T.lastHands) {
    for (const ch of chains) { g.beginPath(); ch.forEach((k, j) => { const p = hnd.px[k]; const x = p.x / T.video.videoWidth * w, y = p.y / T.video.videoHeight * h; j ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
  }
  g.restore();
  g.fillStyle = '#fff'; g.font = '11px ui-monospace, Menlo'; g.fillText(T.lastHands.map((x) => x.side + ':' + x.gesture).join('  '), 6, h - 6);
}

function reportStatus() {
  const s = T.stats, now = performance.now();
  if (now - s.t0 < 2000) return;
  const secs = (now - s.t0) / 1000;
  const data = {
    delegate: T.delegate, fps: +(s.frames / secs).toFixed(1), faceFps: +(s.faces / secs).toFixed(1),
    faceMs: +(s.faceMs / Math.max(s.frames, 1)).toFixed(1), handMs: +(s.handMs / Math.max(s.handFrames || s.frames / 2, 1)).toFixed(1), handFps: +((s.handFrames || 0) / secs).toFixed(1),
    hands: T.lastHands.map((h) => h.side + ':' + h.gesture), swapLR: +T.swapLR.toFixed(2), neutral: T.neutral,
    params: T.lastParams && Object.fromEntries(Object.entries(T.lastParams).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])),
  };
  Object.assign(s, { frames: 0, faces: 0, hands: 0, faceMs: 0, handMs: 0, handFrames: 0, t0: now });
  if (settings().debug) post({ type: 'status', data });
  T.status = data;
}

// ------------------------------------------------------------------ public API
window.tracker = {
  get video() { return T.stream ? T.video : null; },
  get status() { return T.status; },
  setActive(on) {
    T.wantActive = !!on;
    if (on) startCamera(); else stopCamera();
  },
  calibrate() {
    T.neutral = null; T.warm = []; T.explicitCalib = true;
    window.rig && rig.toast(rig.tr('calibrated'));
  },
};

init();
// In a normal browser (no native app) just start right away.
if (!(window.MINIME && window.MINIME.native)) window.tracker.setActive(true);
