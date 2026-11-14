/* MiniMe rig — a 2.5D puppet kid that copies the face and hands sent by tracker.js (or the native fallback).
 *
 *   rig.configure({character, debug, mirror, tracking, timeOfDay})
 *   rig.setFace(params | null)      rig.setHands([{side, pts, gesture}])      rig.event(name)
 *   rig.record({seconds, layout:'split'|'scene'})      rig.photo('split'|'scene')
 * Open index.html?demo in a browser to drive it with the mouse (keys: s k p o b w h t v H g d).
 */
(() => {
  'use strict';

  const ASSETS = window.ASSETS || {};
  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const dbgEl = $('debug'), dbgPre = dbgEl.querySelector('pre');
  const bgEl = $('bg'), bgNightEl = $('bgNight'), fgEl = $('fg');

  // ---------------------------------------------------------------- characters
  const KIDS = {
    girl: {
      head: 'girl_head', bodies: ['girl_body_armless', 'girl_body'],
      iris: ['#2b1309', '#8e4a26', '#f4bd80'], line: '#55291b', brow: '#7a4027',
      lashes: true, blush: '255,118,136', mouth: '#7a2a30', tongue: '#f3868f', sleeve: '#f9a8b0',
    },
    boy: {
      head: 'boy_head', bodies: ['boy_body_armless', 'boy_body'],
      iris: ['#1e1009', '#6b3e22', '#d8a068'], line: '#4a2718', brow: '#4f2a19',
      lashes: false, blush: '255,132,132', mouth: '#7a2a30', tongue: '#f3868f', sleeve: '#8cb5dc',
    },
  };
  // Face layout. x: multiples of the face width (fw) from the centre line; y: fraction from bangs (0) to chin (1).
  const GEO = {
    eyeX: 0.25, eyeY: 0.445, eyeW: 0.205, eyeH: 0.27,
    browDY: -0.185, browW: 0.13,
    noseY: 0.635, mouthY: 0.78, mouthW: 0.125,
    blushX: 0.305, blushY: 0.655, blushRX: 0.078, blushRY: 0.042,
  };
  const HAND_SIZE = 0.47;    // character hand size relative to its face width (user hand ≈ 0.95 face widths)

  const STRINGS = {
    en: { noRec: 'Video recording is not supported', recFail: 'Couldn’t start recording', videoSaved: '✅ Video saved to your Desktop',
          photoSaved: '📸 Photo saved to your Desktop', saveFail: '❌ Couldn’t save', calibrated: '🎯 Calibrated' },
    fa: { noRec: 'ضبط ویدیو پشتیبانی نمی‌شود', recFail: 'ضبط ویدیو شروع نشد', videoSaved: '✅ ویدیو روی دسکتاپ ذخیره شد',
          photoSaved: '📸 عکس روی دسکتاپ ذخیره شد', saveFail: '❌ ذخیره نشد', calibrated: '🎯 کالیبره شد' },
  };
  const tr = (key) => (STRINGS[settings.lang] || STRINGS.en)[key] || key;
  const settings = { character: 'girl', debug: false, tracking: true, mirror: true, timeOfDay: 'auto',
                     lang: (navigator.language || 'en').startsWith('fa') ? 'fa' : 'en',
                     scale: 1, offsetX: 0, zoom: 1, noBlink: false };
  const demo = /[?&]demo/.test(location.search);

  // ---------------------------------------------------------------- helpers
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  // `window.__virtualTime` (ms) lets tools render frames deterministically (used to make the README GIFs).
  const now = () => (window.__virtualTime ?? performance.now()) / 1000;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const DEG = 180 / Math.PI;
  const loadImage = (src) => new Promise((res) => {
    if (!src) return res(null);
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const post = (msg) => { try { window.webkit?.messageHandlers?.minime?.postMessage(msg); } catch (_) { /* browser */ } };

  // ---------------------------------------------------------------- assets
  const kids = {};
  async function loadKid(name) {
    if (kids[name]) return kids[name];
    const cfg = KIDS[name];
    const hm = ASSETS[cfg.head];
    const bm = cfg.bodies.map((b) => ASSETS[b]).find(Boolean);
    if (!hm) return null;
    const [head, mask, body] = await Promise.all([loadImage(hm.src), loadImage(hm.mask), loadImage(bm && bm.src)]);
    if (!head) return null;
    const f = hm.face;
    const k = {
      name, cfg, head, mask, body, hm, bm, armless: !!(bm && bm.shoulderY),
      fw: f.cheekX1 - f.cheekX0, cx: f.cx, top: f.foreheadY, chin: f.chinY,
      skin: hm.skin || '#fbc9ac', sleeve: (bm && bm.color) || cfg.sleeve,
      q: 0, layers: null,
    };
    kids[name] = k;
    return k;
  }
  function ensureLayers(k, q) {
    if (k.layers && Math.abs(k.q - q) < 0.04) return;
    k.q = q;
    const w = Math.ceil(k.head.width * q), h = Math.ceil(k.head.height * q);
    k.layers = { F: makeCanvas(w, h), A: makeCanvas(w, h), B: makeCanvas(w, h), C: makeCanvas(w, h) };
  }

  // ---------------------------------------------------------------- state
  const NEUTRAL = { yaw: 0, pitch: 0, roll: 0, lean: 0, px: 0, py: 0, eyeL: 1, eyeR: 1, sqL: 0, sqR: 0, gx: 0, gy: 0,
                    browL: 0, browR: 0, browIn: 0, jaw: 0, smileL: 0, smileR: 0, frown: 0, pucker: 0, funnel: 0,
                    puff: 0, mouthX: 0 };
  let target = { ...NEUTRAL };
  const cur = { ...NEUTRAL };
  let source = '';
  let lastFaceAt = -1e9;
  const startedAt = now();
  let asleep = false, wakeAt = -1e9, popAt = -1e9;
  let kid = null;
  const boost = { smile: 0, smileUntil: 0, blush: 0, blushUntil: 0, wink: '', winkUntil: 0 };

  const arms = { L: { side: 'L', target: null, seenAt: -1e9, pts: null, w: 0, gesture: '', pose: '', poseCand: '', poseCount: 0 },
                 R: { side: 'R', target: null, seenAt: -1e9, pts: null, w: 0, gesture: '', pose: '', poseCand: '', poseCount: 0 } };

  // ---------------------------------------------------------------- public API
  window.rig = {
    settings,
    configure(opts) {
      const prev = settings.character;
      Object.assign(settings, opts || {});
      dbgEl.style.display = settings.debug ? 'block' : 'none';
      if (settings.character !== prev || !kid) selectKid(settings.character);
      updateTimeOfDay();
    },
    setFace(f) {
      if (!f) { lastFaceAt = Math.min(lastFaceAt, now() - 0.7); return; }
      source = f.src || 'vision';
      target = { ...NEUTRAL, ...f };
      lastFaceAt = now();
    },
    setHands(list) {
      const t = now();
      for (const h of list || []) {
        const a = arms[h.side];
        if (!a) continue;
        a.target = h.pts; a.seenAt = t; a.gesture = h.gesture || '';
        const pose = POSE_OF[a.gesture] || 'relaxed';
        if (pose === a.poseCand) a.poseCount++; else { a.poseCand = pose; a.poseCount = 1; }
        if (a.poseCount >= 2 || !a.pose) a.pose = a.poseCand;
      }
    },
    event(name) { onGesture(name); },
    isRecording: () => rec.active,
    setTracking(on) { settings.tracking = !!on; },
    toast,
    tr: (k) => tr(k),
    record: (o) => startRecording(o || {}),
    photo: (layout) => takePhoto(layout || 'split'),
    /** Renders the current frame into a new canvas: layout 'scene' (whole room) or 'portrait' (kid close-up). */
    renderNow: () => render(),
    still(layout = 'scene', w = 1600, h = 1000) { const c = makeCanvas(w, h); composeFrame(c.getContext('2d'), layout, w, h); return c; },
  };

  async function selectKid(name) {
    const k = (await loadKid(name)) || (await loadKid(name === 'girl' ? 'boy' : 'girl'));
    if (k) { kid = k; popAt = now(); }
  }

  // ---------------------------------------------------------------- face parts
  function drawEye(g, k, ex, ey, ew, eh, open, squint, gx, gy, side, happy) {
    const c = k.cfg;
    const wide = clamp(open - 1, 0, 0.45);
    const rx = ew / 2, ry = (eh / 2) * (1 + wide * 0.35), lw = eh * 0.078;
    const cornerY = ey + (eh / 2) * 0.14;
    const outer = ex + side * rx;
    g.lineCap = 'round'; g.lineJoin = 'round';

    if (open < 0.12) {                                   // closed
      g.strokeStyle = c.line; g.lineWidth = lw;
      g.beginPath();
      if (happy) {
        g.moveTo(ex - rx * 0.88, cornerY + ry * 0.12);
        g.quadraticCurveTo(ex, ey - ry * 0.7, ex + rx * 0.88, cornerY + ry * 0.12);
      } else {
        g.moveTo(ex - rx * 0.9, cornerY);
        g.quadraticCurveTo(ex, cornerY + ry * 0.55, ex + rx * 0.9, cornerY);
      }
      g.stroke();
      if (c.lashes && !happy) {
        g.lineWidth = lw * 0.6;
        g.beginPath(); g.moveTo(ex + side * rx * 0.86, cornerY + ry * 0.02);
        g.lineTo(ex + side * rx * 1.1, cornerY + ry * 0.16); g.stroke();
      }
      return;
    }

    const o = Math.min(open, 1);
    const hu = (cornerY - (ey - ry)) * o;
    const hl = (ey + ry - cornerY) * (1 - 0.62 * squint);
    const xl = ex - rx, xr = ex + rx;
    const upper = () => {
      g.moveTo(xl, cornerY);
      g.bezierCurveTo(xl + rx * 0.02, cornerY - hu * 1.33, xr - rx * 0.02, cornerY - hu * 1.33, xr, cornerY);
    };

    g.save();
    g.beginPath(); upper();
    g.bezierCurveTo(xr - rx * 0.05, cornerY + hl * 1.33, xl + rx * 0.05, cornerY + hl * 1.33, xl, cornerY);
    g.closePath();
    g.fillStyle = '#fffaf5'; g.fill();
    g.clip();

    const ix = ex + gx * rx * 0.32, iy = ey + ry * 0.08 + gy * ry * 0.16;
    const irx = rx * (0.8 - wide * 0.18), iry = ry * (0.86 - wide * 0.2);
    const grad = g.createLinearGradient(0, iy - iry, 0, iy + iry);
    grad.addColorStop(0, c.iris[0]); grad.addColorStop(0.5, c.iris[1]); grad.addColorStop(1, c.iris[2]);
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(ix, iy, irx, iry, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = c.iris[0]; g.lineWidth = lw * 0.5; g.stroke();
    g.fillStyle = c.iris[0];
    const ps = 1 - wide * 0.6;
    g.beginPath(); g.ellipse(ix, iy + iry * 0.06, irx * 0.42 * ps, iry * 0.47 * ps, 0, 0, Math.PI * 2); g.fill();
    const glow = g.createRadialGradient(ix, iy + iry * 0.6, 0, ix, iy + iry * 0.6, irx * 0.9);
    glow.addColorStop(0, 'rgba(255,214,160,0.55)'); glow.addColorStop(1, 'rgba(255,214,160,0)');
    g.fillStyle = glow; g.beginPath(); g.ellipse(ix, iy, irx, iry, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.beginPath(); g.ellipse(ix - irx * 0.3, iy - iry * 0.36, irx * 0.36, iry * 0.29, -0.35, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(ix + irx * 0.38, iy + iry * 0.4, irx * 0.14, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.beginPath(); g.arc(ix + irx * 0.2, iy - iry * 0.58, irx * 0.08, 0, Math.PI * 2); g.fill();
    const lidTop = cornerY - hu;
    const sh = g.createLinearGradient(0, lidTop, 0, lidTop + eh * 0.32);
    sh.addColorStop(0, 'rgba(95,45,30,0.38)'); sh.addColorStop(1, 'rgba(95,45,30,0)');
    g.fillStyle = sh; g.fillRect(xl - 2, lidTop - 2, ew + 4, eh * 0.36);
    g.restore();

    g.strokeStyle = c.line;
    g.lineWidth = lw; g.beginPath(); upper(); g.stroke();
    g.lineWidth = lw * 1.5;
    g.beginPath();
    g.moveTo(ex + side * rx * 0.25, cornerY - hu * 0.98);
    g.quadraticCurveTo(ex + side * rx * 0.85, cornerY - hu * 0.85, outer, cornerY);
    g.stroke();
    g.lineWidth = lw * 0.8;
    g.beginPath(); g.moveTo(outer - side * rx * 0.04, cornerY - hu * 0.12);
    g.quadraticCurveTo(outer + side * rx * 0.14, cornerY - hu * 0.2, outer + side * rx * 0.26, cornerY - hu * 0.42);
    g.stroke();
    if (c.lashes) {
      g.lineWidth = lw * 0.55;
      g.beginPath(); g.moveTo(outer - side * rx * 0.2, cornerY - hu * 0.62);
      g.quadraticCurveTo(outer + side * rx * 0.02, cornerY - hu * 0.8, outer + side * rx * 0.16, cornerY - hu * 0.98);
      g.stroke();
    }
    g.strokeStyle = 'rgba(120,62,40,0.5)'; g.lineWidth = lw * 0.45;
    g.beginPath();
    g.moveTo(ex - rx * 0.28, cornerY + hl * 0.93);
    g.quadraticCurveTo(ex, cornerY + hl * 1.04, ex + rx * 0.28, cornerY + hl * 0.93);
    g.stroke();
  }

  function drawBrow(g, k, bx, by, bw, raise, inner, side) {
    const lift = raise * bw * 0.34;
    const arch = bw * (0.13 + 0.1 * Math.max(raise, 0));
    const innerDrop = Math.max(-raise, 0) * bw * 0.24 - inner * bw * 0.22;   // frown ↓ / worried ↑
    const innerX = bx - side * bw / 2, outerX = bx + side * bw / 2;
    const y = by - lift;
    g.strokeStyle = k.cfg.brow; g.lineCap = 'round'; g.lineWidth = bw * 0.12;
    g.beginPath();
    g.moveTo(innerX, y + arch * 0.35 + innerDrop);
    g.quadraticCurveTo(bx, y - arch, outerX, y + arch * 0.55 - innerDrop * 0.2);
    g.stroke();
  }

  function drawMouth(g, k, mx, my, mw, M) {
    const c = k.cfg;
    mx += M.shift * mw * 0.45;
    const s = (M.cornerL + M.cornerR) / 2, sp = Math.max(s, 0);
    const round = Math.max(M.pucker, M.funnel);
    const half = (mw / 2) * (1 + 0.5 * sp) * (1 - 0.5 * round) * (1 - 0.3 * M.open * (1 - sp));
    const yL = my - M.cornerL * mw * 0.14, yR = my - M.cornerR * mw * 0.14;
    const lx = mx - half, rx = mx + half;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = c.line; g.lineWidth = mw * 0.08;

    if (M.puff > 0.4 && M.open < 0.2) {                 // puffed cheeks: lips pressed together
      g.beginPath(); g.moveTo(mx - mw * 0.16, my);
      g.quadraticCurveTo(mx, my - mw * 0.06, mx + mw * 0.16, my); g.stroke();
      return;
    }
    if (M.pucker > 0.42 && M.open < 0.28) {             // kissy lips
      const r = mw * 0.21;
      g.fillStyle = '#ee7a8a';
      g.beginPath(); g.ellipse(mx, my, r * 1.05, r * 0.86, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.lineWidth = mw * 0.05;
      g.beginPath(); g.moveTo(mx - r * 0.62, my); g.quadraticCurveTo(mx, my + r * 0.28, mx + r * 0.62, my); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.beginPath(); g.ellipse(mx - r * 0.35, my - r * 0.4, r * 0.22, r * 0.12, -0.4, 0, Math.PI * 2); g.fill();
      return;
    }
    if (M.open < 0.06) {
      g.beginPath(); g.moveTo(lx, yL);
      g.quadraticCurveTo(mx, (yL + yR) / 2 + mw * (0.04 + 0.36 * s), rx, yR);
      g.stroke();
      return;
    }
    const depth = mw * (0.14 + 0.95 * M.open) * (1 + 0.25 * round);
    const topBend = mw * (0.14 * s - 0.28 * M.open * (1 - sp)) - round * mw * 0.18 * M.open;
    const path = () => {
      g.beginPath(); g.moveTo(lx, yL);
      g.quadraticCurveTo(mx, (yL + yR) / 2 + topBend, rx, yR);
      g.bezierCurveTo(rx - half * 0.05, yR + depth * 1.3, lx + half * 0.05, yL + depth * 1.3, lx, yL);
      g.closePath();
    };
    g.save();
    path(); g.fillStyle = c.mouth; g.fill(); g.clip();
    g.fillStyle = c.tongue;
    g.beginPath(); g.ellipse(mx, (yL + yR) / 2 + depth * 1.02, half * 0.72, depth * 0.42, 0, 0, Math.PI * 2); g.fill();
    if (M.open > 0.3 && s > 0.25) {
      g.fillStyle = '#fffaf5';
      g.fillRect(lx, Math.min(yL, yR) + Math.min(topBend, 0) - 4, half * 2, depth * 0.16 + 4);
    }
    g.restore();
    path(); g.stroke();
  }

  function drawFeatures(g, k, P) {
    const { fw, cx, cfg } = k;
    const fy = (t) => k.top + (k.chin - k.top) * t;
    const ey = fy(GEO.eyeY), ew = GEO.eyeW * fw, eh = GEO.eyeH * fw;

    const ba = clamp(0.3 + 0.32 * Math.max(P.smile, 0) + P.blush + P.puff * 0.35 + (P.asleep ? 0.1 : 0), 0, 0.95);
    const br = 1 + P.puff * 0.45;
    for (const side of [-1, 1]) {
      const bx = cx + side * GEO.blushX * fw * (1 + P.puff * 0.08), by = fy(GEO.blushY);
      const R = GEO.blushRX * fw * br;
      const rg = g.createRadialGradient(bx, by, 0, bx, by, R);
      rg.addColorStop(0, `rgba(${cfg.blush},${ba})`); rg.addColorStop(1, `rgba(${cfg.blush},0)`);
      g.fillStyle = rg;
      g.save(); g.translate(bx, by); g.scale(1, (GEO.blushRY / GEO.blushRX) * (1 + P.puff * 0.6)); g.translate(-bx, -by);
      g.beginPath(); g.arc(bx, by, R, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    for (const side of [-1, 1]) {
      const ex = cx + side * GEO.eyeX * fw;
      const L = side < 0;
      drawEye(g, k, ex, ey, ew, eh, L ? P.eyeL : P.eyeR, L ? P.sqL : P.sqR, P.gx, P.gy, side, P.happy);
      drawBrow(g, k, ex + side * fw * 0.01, ey + GEO.browDY * fw, GEO.browW * fw, L ? P.browL : P.browR, P.browIn, side);
    }
    g.fillStyle = 'rgba(214,118,92,0.55)';
    g.beginPath(); g.ellipse(cx, fy(GEO.noseY), fw * 0.013, fw * 0.009, 0, 0, Math.PI * 2); g.fill();
    drawMouth(g, k, cx, fy(GEO.mouthY), GEO.mouthW * fw, P.mouth);
  }

  // Puffed cheeks: little round bulges that stick out past the face outline.
  function drawPuff(g, k, amount) {
    if (amount < 0.05) return;
    const fy = (t) => k.top + (k.chin - k.top) * t;
    const r = k.fw * 0.11 * amount, y = fy(0.7);
    for (const side of [-1, 1]) {
      const x = k.cx + side * (k.fw * 0.47);
      g.fillStyle = k.skin; g.strokeStyle = k.cfg.line; g.lineWidth = k.fw * 0.011;
      g.beginPath(); g.ellipse(x, y, r, r * 1.15, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x, y, r, r * 1.15, 0, side < 0 ? Math.PI * 0.55 : -Math.PI * 0.45, side < 0 ? Math.PI * 1.45 : Math.PI * 0.45); g.stroke();
    }
  }

  // ---------------------------------------------------------------- 2.5D warps
  const warpMapX = (x, cx, R, d) => { const u = (x - cx) / R; return Math.abs(u) >= 1 ? x : cx + R * (u + d * (1 - u * u)); };
  function warpX(src, dst, cx, R, d) {
    const w = src.width, h = src.height, g = dst.getContext('2d');
    g.clearRect(0, 0, w, h);
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w, Math.ceil(cx + R));
    if (x0 > 0) g.drawImage(src, 0, 0, x0, h, 0, 0, x0, h);
    if (x1 < w) g.drawImage(src, x1, 0, w - x1, h, x1, 0, w - x1, h);
    const N = 64, step = (x1 - x0) / N;
    for (let i = 0; i < N; i++) {
      const sx = x0 + i * step, a = warpMapX(sx, cx, R, d), b = warpMapX(sx + step, cx, R, d);
      const sw = Math.min(step + 1, w - sx);
      g.drawImage(src, sx, 0, sw, h, a, 0, (b - a) * (sw / step), h);
    }
  }
  function warpY(src, dst, cy, R, p) {
    const w = src.width, h = src.height, g = dst.getContext('2d');
    g.clearRect(0, 0, w, h);
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h, Math.ceil(cy + R));
    if (y0 > 0) g.drawImage(src, 0, 0, w, y0, 0, 0, w, y0);
    if (y1 < h) g.drawImage(src, 0, y1, w, h - y1, 0, y1, w, h - y1);
    const N = 48, step = (y1 - y0) / N;
    for (let i = 0; i < N; i++) {
      const sy = y0 + i * step, a = warpMapX(sy, cy, R, p), b = warpMapX(sy + step, cy, R, p);
      const sh = Math.min(step + 1, h - sy);
      g.drawImage(src, 0, sy, w, sh, 0, a, w, (b - a) * (sh / step));
    }
  }
  const warpParams = (k, P) => ({
    d: clamp(P.yaw / 0.6, -1, 1) * 0.36, R: (k.fw / 2) * 1.06,
    p: clamp(-P.pitch / 0.42, -1, 1) * 0.3, Rv: k.chin / 2,
  });

  function renderHead(k, P) {
    const q = k.q, L = k.layers;
    const gF = L.F.getContext('2d');
    gF.setTransform(1, 0, 0, 1, 0, 0);
    gF.globalCompositeOperation = 'source-over';
    gF.clearRect(0, 0, L.F.width, L.F.height);
    gF.setTransform(q, 0, 0, q, 0, 0);
    drawFeatures(gF, k, P);
    gF.setTransform(1, 0, 0, 1, 0, 0);
    if (k.mask) {
      gF.globalCompositeOperation = 'destination-in';
      gF.drawImage(k.mask, 0, 0, L.F.width, L.F.height);
      gF.globalCompositeOperation = 'source-over';
    }
    const gA = L.A.getContext('2d');
    gA.setTransform(1, 0, 0, 1, 0, 0);
    gA.clearRect(0, 0, L.A.width, L.A.height);
    gA.drawImage(k.head, 0, 0, L.A.width, L.A.height);
    gA.drawImage(L.F, 0, 0);
    if (P.puff > 0.05) { gA.setTransform(q, 0, 0, q, 0, 0); drawPuff(gA, k, P.puff); gA.setTransform(1, 0, 0, 1, 0, 0); }

    let out = L.A;
    const { d, R, p, Rv } = warpParams(k, P);
    if (Math.abs(d) > 0.002) { warpX(L.A, L.B, k.cx * q, R * q, d); out = L.B; }
    if (Math.abs(p) > 0.002) {
      const dst = out === L.B ? L.C : L.B;
      warpY(out, dst, Rv * q, Rv * q, p);
      out = dst;
    }
    return out;
  }

  // ---------------------------------------------------------------- hands & arms
  // An open hand (face-relative units, fingers up) used for the demo and as the resting pose.
  const OPEN_HAND = [[0, 0], [-0.17, -0.08], [-0.28, -0.2], [-0.36, -0.32], [-0.42, -0.42], [-0.14, -0.45], [-0.16, -0.64],
    [-0.17, -0.75], [-0.18, -0.85], [-0.02, -0.48], [-0.02, -0.69], [-0.02, -0.81], [-0.02, -0.92], [0.1, -0.45],
    [0.11, -0.63], [0.12, -0.74], [0.12, -0.83], [0.2, -0.4], [0.23, -0.53], [0.25, -0.61], [0.26, -0.69]];
  const CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

  function chibify(P) {             // shorter, chubbier fingers
    for (const ch of CHAINS) {
      for (let i = 1; i < ch.length; i++) {
        const a = ch[i - 1], b = ch[i];
        const f = i === 1 ? 0.8 : 0.78;
        P[b] = [P[a][0] + (P[b][0] - P[a][0]) * f, P[a][1] + (P[b][1] - P[a][1]) * f];
      }
    }
    return P;
  }

  function drawHand(g, P, skin, line, fw) {
    const fWidth = fw * 0.085, ol = fw * 0.013;
    const palm = [0, 1, 5, 9, 13, 17];
    g.lineCap = 'round'; g.lineJoin = 'round';
    const palmPath = () => { g.beginPath(); palm.forEach((i, j) => (j ? g.lineTo(P[i][0], P[i][1]) : g.moveTo(P[i][0], P[i][1]))); g.closePath(); };
    const chain = (ch, from) => { g.beginPath(); g.moveTo(P[from][0], P[from][1]); ch.forEach((i) => g.lineTo(P[i][0], P[i][1])); };
    for (const pass of [0, 1]) {
      const col = pass ? skin : line, extra = pass ? 0 : ol * 2;
      g.strokeStyle = col; g.fillStyle = col;
      palmPath(); g.lineWidth = fWidth * 1.1 + extra; g.fill(); g.stroke();
      chain([2, 3, 4], 1); g.lineWidth = fWidth * 1.12 + extra; g.stroke();
      for (const ch of CHAINS.slice(1)) { chain(ch.slice(1), ch[0]); g.lineWidth = fWidth + extra; g.stroke(); }
    }
    // tiny knuckle creases so fingers read as separate
    g.strokeStyle = 'rgba(150,80,60,0.35)'; g.lineWidth = ol * 0.8;
    for (const ch of CHAINS.slice(1)) {
      const [a, b] = [P[ch[0]], P[ch[1]]];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
      const n = Math.hypot(dx, dy) || 1, nx = -dy / n, ny = dx / n;
      g.beginPath(); g.moveTo(mx - nx * fWidth * 0.22, my - ny * fWidth * 0.22); g.lineTo(mx + nx * fWidth * 0.22, my + ny * fWidth * 0.22); g.stroke();
    }
  }

  function armGeom(S, P, fw) {
    const Wr = P[0];
    const len = Math.hypot(Wr[0] - S[0], Wr[1] - S[1]);
    let hx = P[9][0] - Wr[0], hy = P[9][1] - Wr[1];
    const hn = Math.hypot(hx, hy) || 1; hx /= hn; hy /= hn;
    return { Wr, len, hx, hy, armW: fw * 0.17, ol: fw * 0.012 };
  }
  function drawArm(g, S, P, side, sleeve, line, fw) {
    const { Wr, len, hx, hy, armW, ol } = armGeom(S, P, fw);
    const c1 = [S[0] + side * len * 0.2, S[1] + len * 0.36];
    const c2 = [Wr[0] - hx * len * 0.36, Wr[1] - hy * len * 0.36];
    g.lineCap = 'round';
    const path = () => { g.beginPath(); g.moveTo(S[0], S[1]); g.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], Wr[0], Wr[1]); };
    path(); g.strokeStyle = line; g.lineWidth = armW + ol * 2; g.stroke();
    path(); g.strokeStyle = shade(sleeve, -0.07); g.lineWidth = armW; g.stroke();
    path(); g.strokeStyle = sleeve; g.lineWidth = armW * 0.72; g.stroke();
    path(); g.strokeStyle = shade(sleeve, 0.07); g.lineWidth = armW * 0.3; g.globalAlpha = 0.7; g.stroke(); g.globalAlpha = 1;
  }
  /** Knitted cuff over the wrist (drawn after the hand so it covers the wrist edge). */
  function drawCuff(g, S, P, sleeve, line, fw) {
    const { Wr, hx, hy, armW, ol } = armGeom(S, P, fw);
    const L = armW * 0.62, Wd = armW * 1.12;
    const cx = Wr[0] - hx * armW * 0.22, cy = Wr[1] - hy * armW * 0.22;
    g.save();
    g.translate(cx, cy); g.rotate(Math.atan2(hy, hx));
    g.fillStyle = shade(sleeve, -0.04); g.strokeStyle = line; g.lineWidth = ol * 2;
    roundRect(g, -L / 2, -Wd / 2, L, Wd, Math.min(L, Wd) * 0.42); g.fill(); g.stroke();
    g.strokeStyle = shade(sleeve, -0.16); g.lineWidth = ol * 1.1;
    for (let i = -2; i <= 2; i++) { const y = (i / 2.6) * Wd * 0.42; g.beginPath(); g.moveTo(-L * 0.36, y); g.lineTo(L * 0.36, y); g.stroke(); }
    g.restore();
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => clamp(Math.round(v + 255 * amt), 0, 255);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function updateArms(t, dt) {
    for (const a of Object.values(arms)) {
      const present = t - a.seenAt < 0.35 && settings.tracking;
      a.w += ((present ? 1 : 0) - a.w) * (1 - Math.exp(-dt * (present ? 9 : 4)));
      if (present && a.target) {
        if (!a.pts) a.pts = a.target.map((p) => p.slice());
        const r = 1 - Math.exp(-dt * 22);
        for (let i = 0; i < 21; i++) { a.pts[i][0] += (a.target[i][0] - a.pts[i][0]) * r; a.pts[i][1] += (a.target[i][1] - a.pts[i][1]) * r; }
      }
    }
  }

  // Your hand position is measured in "your face widths" from between your eyes. The kid is a chibi
  // (huge head, tiny body), so near the face we keep face scale (hand on cheek → hand on cheek) and
  // lower down we switch to body scale (hand at your shoulder → hand at the kid's shoulder).
  function mapChibi(x, y) {
    const ax = Math.abs(x);
    const headX = Math.sign(x) * (ax <= 0.6 ? ax * 0.95 : 0.57 + (ax - 0.6) * 0.55);
    const bodyX = x * 0.4;
    const X = lerp(headX, bodyX, smoothstep(0.45, 1.3, y));
    const Y = y <= 0.55 ? y * 0.95 : 0.52 + (y - 0.55) * 0.45;
    return [X, Y];
  }

  /** Character-space hand points for one arm (blend between resting and tracked). */
  function handPoints(a, F, shoulder) {
    const side = a.side === 'L' ? -1 : 1;
    const s = F.fw * HAND_SIZE;
    const rest = [shoulder[0] + side * F.fw * 0.08, shoulder[1] + F.fw * 1.15];
    const restPts = OPEN_HAND.map(([x, y]) => [rest[0] - side * x * s * 0.9, rest[1] - y * s * 0.9]);   // hanging down
    if (a.w < 0.01 || !a.pts) return restPts;
    const w0 = a.pts[0];
    const [mx, my] = mapChibi(w0[0], w0[1]);
    let wx = F.cx + mx * F.fw, wy = F.cy + my * F.fw;
    const maxLen = F.fw * 1.15, dx = wx - shoulder[0], dy = wy - shoulder[1], dl = Math.hypot(dx, dy);
    if (dl > maxLen) { wx = shoulder[0] + dx / dl * maxLen; wy = shoulder[1] + dy / dl * maxLen; }
    const tracked = a.pts.map(([x, y]) => [wx + (x - w0[0]) * s, wy + (y - w0[1]) * s]);
    const w = smoothstep(0, 1, a.w);
    return tracked.map((p, i) => [lerp(restPts[i][0], p[0], w), lerp(restPts[i][1], p[1], w)]);
  }

  // Hand drawings from the sprite sheet (same art style as the kids), picked by gesture and rotated to match.
  const POSE_OF = { open: 'open', fist: 'fist', point: 'point', peace: 'peace', thumbsUp: 'thumbsUp', thumbsDown: 'thumbsUp',
                    ok: 'ok', rock: 'rock', heart: 'relaxed', other: 'relaxed' };
  const handImgs = {};
  const HANDS = ASSETS.hands;
  if (HANDS) for (const [name, spr] of Object.entries(HANDS.poses)) loadImage(spr.src).then((im) => { if (im) handImgs[name] = im; });

  function drawHandSprite(g, a, P, fw) {
    const pose = a.w > 0.35 ? (a.pose || 'relaxed') : 'relaxed';
    const spr = HANDS && HANDS.poses[pose], im = handImgs[pose];
    if (!spr || !im) return false;
    const v = (i, j) => [P[j][0] - P[i][0], P[j][1] - P[i][1]];
    const cross = (u, w) => u[0] * w[1] - u[1] * w[0];
    let axis, flip;
    if (pose === 'thumbsUp') {
      axis = v(2, 4);                                   // the thumb points "up" in the drawing
      flip = (cross(axis, v(2, 9)) > 0) !== !!spr.fingersRight;
    } else {
      axis = pose === 'point' ? v(5, 8) : v(0, 9);
      flip = (cross(v(0, 9), v(17, 5)) > 0) === !!spr.thumbLeft;
    }
    const ang = Math.atan2(axis[0], -axis[1]);
    const sc = (fw * 0.42) / HANDS.ref;
    g.save();
    g.translate(P[0][0], P[0][1]);
    g.rotate(ang);
    g.scale(flip ? -sc : sc, sc);
    g.drawImage(im, -spr.ax, -spr.ay, spr.w, spr.h);
    g.restore();
    return true;
  }

  // ---------------------------------------------------------------- effects
  const fx = [];
  function spawn(kind, o) { fx.push({ kind, t0: now(), life: 1.6, size: 1, rot: 0, vx: 0, vy: 0, ...o }); }

  function heartPath(g, s) {
    g.beginPath();
    g.moveTo(0, s * 0.35);
    g.bezierCurveTo(-s * 0.05, s * 0.3, -s * 0.55, s * 0.05, -s * 0.5, -s * 0.2);
    g.bezierCurveTo(-s * 0.45, -s * 0.48, -s * 0.08, -s * 0.5, 0, -s * 0.22);
    g.bezierCurveTo(s * 0.08, -s * 0.5, s * 0.45, -s * 0.48, s * 0.5, -s * 0.2);
    g.bezierCurveTo(s * 0.55, s * 0.05, s * 0.05, s * 0.3, 0, s * 0.35);
    g.closePath();
  }
  function starPath(g, s, points = 5, inner = 0.45) {
    g.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 ? s * inner : s, a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }

  function drawFx(g, t, S, F) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i], age = (t - e.t0) / e.life;
      if (age >= 1) { fx.splice(i, 1); continue; }
      if (age < 0) continue;
      const pop = Math.min(1, age * 6), fade = age > 0.75 ? 1 - (age - 0.75) / 0.25 : 1;
      const ax = e.attach ? F.cx : 0, ay = e.attach ? F.cy : 0;
      const x = ax + e.x + e.vx * age * e.life + (e.wobble ? Math.sin(age * 9 + e.t0) * e.wobble * S : 0);
      const y = ay + e.y + e.vy * age * e.life;
      g.save();
      g.globalAlpha = fade;
      g.translate(x, y);
      const sz = e.size * S * (0.5 + 0.5 * easeBack(pop));
      g.lineJoin = 'round';
      switch (e.kind) {
        case 'heart':
          g.rotate(Math.sin(age * 6 + e.t0) * 0.2);
          heartPath(g, sz * 46); g.fillStyle = e.color || '#ff6f91'; g.fill();
          g.lineWidth = sz * 5; g.strokeStyle = '#fff'; g.stroke();
          g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(-sz * 11, -sz * 9, sz * 6, sz * 4, -0.6, 0, 7); g.fill();
          break;
        case 'star':
          g.rotate(e.rot + age * 3);
          starPath(g, sz * 26); g.fillStyle = '#ffd84d'; g.fill(); g.lineWidth = sz * 4; g.strokeStyle = '#fff'; g.stroke();
          break;
        case 'sparkle': {
          const tw = 0.6 + 0.4 * Math.sin(age * 20);
          g.scale(tw, tw); starPath(g, sz * 22, 4, 0.28); g.fillStyle = e.color || '#fff6b0'; g.fill();
          g.lineWidth = sz * 2.5; g.strokeStyle = 'rgba(255,200,80,.9)'; g.stroke();
          break;
        }
        case 'mark':
          g.rotate(-0.12);
          starPath(g, sz * 44, 10, 0.72); g.fillStyle = '#fff3a8'; g.fill(); g.lineWidth = sz * 3; g.strokeStyle = '#f2b636'; g.stroke();
          g.font = `900 ${sz * 52}px ui-rounded, system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = '#e8344f'; g.fillText(e.text || '!', 0, sz * 3);
          break;
        case 'anger':
          g.strokeStyle = '#e8344f'; g.lineWidth = sz * 7; g.lineCap = 'round';
          for (let j = 0; j < 4; j++) {
            g.save(); g.rotate(j * Math.PI / 2);
            g.beginPath(); g.moveTo(sz * 8, sz * 22); g.quadraticCurveTo(sz * 9, sz * 9, sz * 22, sz * 8); g.stroke();
            g.restore();
          }
          break;
        case 'tear':
          g.fillStyle = '#8fd0ff'; g.strokeStyle = '#fff'; g.lineWidth = sz * 3;
          g.beginPath(); g.moveTo(0, -sz * 14); g.quadraticCurveTo(sz * 11, sz * 4, 0, sz * 10); g.quadraticCurveTo(-sz * 11, sz * 4, 0, -sz * 14); g.fill(); g.stroke();
          break;
        case 'zzz':
          g.font = `800 ${(26 + 26 * age) * e.size * S}px "Arial Rounded MT Bold", ui-rounded, system-ui`;
          g.lineWidth = 6 * S; g.strokeStyle = '#fff'; g.fillStyle = '#8f7ad8';
          g.globalAlpha = Math.sin(age * Math.PI);
          g.strokeText('Z', 0, 0); g.fillText('Z', 0, 0);
          break;
        case 'bubble': {
          g.font = `800 ${34 * S}px ui-rounded, "SF Pro Rounded", system-ui`;
          const tw = g.measureText(e.text).width, bw = tw + 40 * S, bh = 62 * S;
          g.scale(easeBack(pop), easeBack(pop));
          g.fillStyle = '#fff'; g.strokeStyle = 'rgba(140,90,70,.35)'; g.lineWidth = 3 * S;
          roundRect(g, -bw / 2, -bh / 2, bw, bh, bh / 2); g.fill(); g.stroke();
          g.beginPath(); g.moveTo(-bw * 0.18 * e.dir, bh / 2 - 2); g.lineTo(-bw * 0.32 * e.dir, bh / 2 + 18 * S); g.lineTo(-bw * 0.02 * e.dir, bh / 2 - 2); g.fill();
          g.fillStyle = '#6b3a2a'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(e.text, 0, 2 * S);
          break;
        }
      }
      g.restore();
    }
  }
  const easeBack = (x) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // Gesture reactions (from tracker.js)
  let lastGeom = null;
  let L0 = { neckX: 0 };
  function onGesture(name) {
    const G = lastGeom;
    if (!G) return;
    const S = G.S, t = now();
    const bubble = (text) => spawn('bubble', { attach: true, x: G.fw * 0.75, y: -G.fw * 0.95, text, life: 2.4, dir: 1 });
    switch (name) {
      case 'wave':
        bubble('Hi! 👋'); boost.smile = 0.7; boost.smileUntil = t + 1.8; break;
      case 'thumbsUp':
        bubble('👍'); boost.smile = 0.6; boost.smileUntil = t + 1.5;
        for (let i = 0; i < 7; i++) spawn('star', { attach: true, x: rnd(-1, 1) * G.fw * 0.8, y: -G.fw * rnd(0.3, 0.9), vx: rnd(-60, 60) * S, vy: rnd(-160, -60) * S, life: rnd(1.1, 1.7), size: rnd(0.7, 1.2), rot: rnd(0, 6), t0: t + i * 0.05 });
        break;
      case 'thumbsDown': bubble('👎'); break;
      case 'peace':
        bubble('✌️'); boost.wink = 'R'; boost.winkUntil = t + 0.6;
        for (let i = 0; i < 6; i++) spawn('sparkle', { attach: true, x: rnd(-1, 1) * G.fw * 0.9, y: -G.fw * rnd(0, 0.9), life: rnd(0.8, 1.4), size: rnd(0.7, 1.3), t0: t + i * 0.06 });
        break;
      case 'heart':
        boost.blush = 0.35; boost.blushUntil = t + 3; boost.smile = 0.5; boost.smileUntil = t + 2.5;
        for (let i = 0; i < 12; i++) spawn('heart', { attach: true, x: rnd(-0.6, 0.6) * G.fw, y: G.fw * rnd(0.1, 0.6), vx: rnd(-50, 50) * S, vy: rnd(-240, -130) * S, wobble: 14, life: rnd(1.6, 2.4), size: rnd(0.6, 1.2), t0: t + i * 0.09 });
        break;
      case 'rock': bubble('🤘'); break;
      case 'ok': bubble('👌'); break;
      default: break;
    }
  }

  // Expression reactions (computed from the face itself)
  const exState = { kissAt: 0, surpriseAt: 0, angryAt: 0, angryHold: 0, winkAt: 0, winkHold: 0, laughAt: 0, sadAt: 0 };
  function expressionFx(t, dt, P, G) {
    const S = G.S;
    if (P.mouth.pucker > 0.5 && P.mouth.open < 0.3 && t - exState.kissAt > 0.75) {
      exState.kissAt = t;
      spawn('heart', { x: G.mouth[0] - G.F.cx + G.fw * 0.08, y: G.mouth[1] - G.F.cy, attach: true, vx: rnd(40, 90) * S, vy: -150 * S, wobble: 12, life: 1.8, size: 0.75 });
    }
    const surprised = P.mouth.open > 0.5 && (Math.max(P.eyeL, P.eyeR) > 1.08 || (P.browL + P.browR) / 2 > 0.45);
    if (surprised && t - exState.surpriseAt > 2.5) { exState.surpriseAt = t; spawn('mark', { attach: true, x: G.fw * 0.62, y: -G.fw * 0.85, life: 1.3, size: 1 }); }
    const angry = (P.browL + P.browR) / 2 < -0.45 && P.smile < 0.25;
    exState.angryHold = angry ? exState.angryHold + dt : 0;
    if (exState.angryHold > 0.35 && t - exState.angryAt > 2.2) { exState.angryAt = t; spawn('anger', { attach: true, x: G.fw * 0.42, y: -G.fw * 0.62, life: 1.6, size: 1 }); }
    const winking = Math.min(P.eyeL, P.eyeR) < 0.25 && Math.max(P.eyeL, P.eyeR) > 0.7;
    exState.winkHold = winking ? exState.winkHold + dt : 0;
    if (exState.winkHold > 0.12 && t - exState.winkAt > 1.2) {
      exState.winkAt = t;
      const ex = P.eyeL < P.eyeR ? -1 : 1;
      spawn('sparkle', { attach: true, x: ex * G.fw * 0.42, y: -G.fw * 0.12, life: 0.9, size: 1.2 });
    }
    if (P.smile > 0.85 && P.mouth.open > 0.3 && t - exState.laughAt > 0.45) {
      exState.laughAt = t;
      spawn('sparkle', { attach: true, x: rnd(-1, 1) * G.fw * 0.8, y: -G.fw * rnd(0.1, 0.8), life: 0.9, size: rnd(0.6, 1.1) });
    }
    if (P.frown > 0.45 && P.browIn > 0.35 && t - exState.sadAt > 2.5) {
      exState.sadAt = t;
      spawn('tear', { attach: true, x: -G.fw * 0.3, y: G.fw * 0.12, vy: 90 * S, life: 1.2, size: 0.9 });
    }
  }

  // ---------------------------------------------------------------- layout
  let W = 0, H = 0, dpr = 1;
  let box = { x: 0, y: 0, w: 1, h: 1 }, boxKey = '';
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    layoutForeground();
    boxKey = '';
  }
  window.addEventListener('resize', resize);

  const scene = { deskTop: 0.86 };
  function layoutForeground() {
    const fg = ASSETS.desk;
    if (fg && fgEl.naturalWidth) {
      const w = Math.max(W, H * 1.2);
      const h = w * fgEl.naturalHeight / fgEl.naturalWidth;
      fgEl.style.width = w + 'px';
      fgEl.style.bottom = '0px';
      scene.deskTop = clamp((H - h * (1 - (fg.edge || 0.8)) + 4) / H, 0.7, 0.92);
    }
  }

  function layout(k) {
    const S = (H / 1000) * settings.scale;
    const faceW = 300 * S;
    const headK = faceW / k.fw;
    const bodyK = k.body ? (faceW * (k.armless ? 1.06 : 1.0)) / k.body.width : 0;
    const bodyH = k.body ? k.body.height * bodyK : 0;
    const deskTop = H * scene.deskTop;
    const bodyTop = deskTop - bodyH * 0.8;
    return { S, headK, bodyK, bodyH, deskTop, bodyTop, neckX: W * (0.5 + settings.offsetX),
             chinY: bodyTop + bodyH * 0.075 };
  }

  function updateBox(k, L) {
    const key = [W, H, dpr, k.name, settings.scale, settings.offsetX, settings.zoom, scene.deskTop].join('|');
    if (key === boxKey) return;
    boxKey = key;
    if (settings.zoom > 1) {
      box = { x: 0, y: 0, w: W, h: H };
    } else {
      const headW = k.head.width * L.headK, headUp = k.chin * L.headK;
      const halfW = Math.max(headW * 0.95, 300 * L.S * 1.9);
      const top = Math.max(0, L.chinY - headUp * 1.75);
      const x0 = Math.max(0, L.neckX - halfW), x1 = Math.min(W, L.neckX + halfW);
      box = { x: Math.floor(x0), y: Math.floor(top), w: Math.ceil(x1 - x0), h: Math.ceil(H - top) };
    }
    Object.assign(canvas.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
    canvas.width = Math.round(box.w * dpr); canvas.height = Math.round(box.h * dpr);
  }

  // ---------------------------------------------------------------- behaviour
  let nextBlink = now() + 2, blinkStart = -1;
  function autoBlink(t) {
    if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
    if (blinkStart < 0) return 1;
    const p = (t - blinkStart) / 0.18;
    if (p >= 1) { blinkStart = -1; nextBlink = t + (Math.random() < 0.15 ? 0.25 : 2.2 + Math.random() * 3.8); return 1; }
    return p < 0.45 ? 1 - p / 0.45 : (p - 0.45) / 0.55;
  }

  let gazeTarget = { x: 0, y: 0 }, nextGaze = 0;
  function idlePose(t, searching) {
    if (t > nextGaze) {
      gazeTarget = { x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.35 };
      nextGaze = t + 1.2 + Math.random() * 2.8;
    }
    const amp = searching ? 1.6 : 1;
    return {
      ...NEUTRAL,
      yaw: (0.14 * Math.sin(t * 0.37) + 0.05 * Math.sin(t * 1.13)) * amp + gazeTarget.x * 0.1,
      pitch: 0.06 * Math.sin(t * 0.51) + gazeTarget.y * 0.1,
      roll: 0.07 * Math.sin(t * 0.29 + 1),
      gx: gazeTarget.x, gy: gazeTarget.y,
      smileL: searching ? 0 : 0.15, smileR: searching ? 0 : 0.15,
      browL: searching ? 0.25 : 0, browR: searching ? 0.25 : 0,
    };
  }
  function sleepPose(t) {
    const breath = Math.sin(t * 2 * Math.PI / 4.2);
    return { ...NEUTRAL, eyeL: 0, eyeR: 0, pitch: -0.3, roll: 0.17 + 0.025 * breath, yaw: 0.03,
             jaw: 0.12 + 0.06 * breath, funnel: 0.5, browL: -0.1, browR: -0.1 };
  }

  const RATES = { yaw: 16, pitch: 16, roll: 16, lean: 7, px: 7, py: 7, eyeL: 38, eyeR: 38, sqL: 18, sqR: 18,
                  gx: 18, gy: 18, browL: 16, browR: 16, browIn: 14, jaw: 28, smileL: 16, smileR: 16, frown: 12,
                  pucker: 16, funnel: 16, puff: 12, mouthX: 14 };

  // ---------------------------------------------------------------- main loop
  let last = now();
  function frame() {
    requestAnimationFrame(frame);
    if (window.__virtualTime != null) return;
    const t0 = now();
    if (t0 - last < (asleep ? 1 / 16 : 1 / 32)) return;
    render();
  }
  function render() {
    const t = now(), dt = clamp(t - last, 0, 0.1);
    last = t;
    if (!kid) return;

    const live = demo || (settings.tracking && t - lastFaceAt < 0.6);
    const absent = t - Math.max(lastFaceAt, startedAt);
    let tgt, mode;
    if (live) {
      if (asleep) { asleep = false; wakeAt = t; }
      tgt = { ...target };
      if (source !== 'mp') {   // the fallback tracker is noisy: snap and symmetrise the eyes
        let eL = smoothstep(0.16, 0.7, tgt.eyeL), eR = smoothstep(0.16, 0.7, tgt.eyeR);
        if (Math.abs(eL - eR) < 0.45) eL = eR = (eL + eR) / 2;
        tgt.eyeL = eL; tgt.eyeR = eR;
      }
      mode = 'live';
    } else if (settings.tracking && absent > 7) {
      asleep = true; tgt = sleepPose(t); mode = 'asleep';
    } else {
      tgt = idlePose(t, settings.tracking && absent > 1.5); mode = settings.tracking ? 'looking' : 'idle';
    }

    const slow = asleep ? 0.22 : 1;
    for (const key in RATES) {
      const r = 1 - Math.exp(-dt * RATES[key] * slow);
      cur[key] += ((tgt[key] ?? NEUTRAL[key]) - cur[key]) * r;
    }
    updateArms(t, dt);

    let blink = 1;
    if (!asleep && !settings.noBlink && (mode !== 'live' || source !== 'mp')) blink = autoBlink(t);
    const wake = clamp(1 - (t - wakeAt) / 0.9, 0, 1);
    const wakeEnv = Math.sin(wake * Math.PI);
    const sBoost = t < boost.smileUntil ? boost.smile : 0;
    const smileAvg = (cur.smileL + cur.smileR) / 2;
    const smile = clamp(0.3 + smileAvg * 1.05 + sBoost - cur.frown * 0.9, -0.8, 1);
    const winkL = t < boost.winkUntil && boost.wink === 'L', winkR = t < boost.winkUntil && boost.wink === 'R';
    const P = {
      yaw: clamp(cur.yaw, -0.9, 0.9), pitch: clamp(cur.pitch, -0.7, 0.7), roll: clamp(cur.roll, -0.6, 0.6),
      eyeL: winkL ? 0 : Math.min(cur.eyeL, blink) + wakeEnv * 0.25 + Math.max(cur.lean - 0.45, 0) * 0.2,
      eyeR: winkR ? 0 : Math.min(cur.eyeR, blink) + wakeEnv * 0.25 + Math.max(cur.lean - 0.45, 0) * 0.2,
      sqL: clamp(Math.max(cur.sqL * 0.7, (smile - 0.55) * 1.3), 0, 0.75),
      sqR: clamp(Math.max(cur.sqR * 0.7, (smile - 0.55) * 1.3), 0, 0.75),
      browL: clamp(cur.browL + wakeEnv * 0.9, -1, 1), browR: clamp(cur.browR + wakeEnv * 0.9, -1, 1),
      browIn: clamp(cur.browIn, 0, 1),
      gx: clamp(cur.gx, -1, 1), gy: clamp(cur.gy, -1, 1),
      smile, frown: cur.frown, puff: smoothstep(0.25, 0.7, cur.puff),
      blush: t < boost.blushUntil ? boost.blush : 0,
      happy: smile > 0.6, asleep,
      mouth: {
        open: clamp(smoothstep(0.04, 0.75, cur.jaw) + wakeEnv * 0.25, 0, 1),
        cornerL: clamp(0.3 + cur.smileL * 1.05 + sBoost - cur.frown * 0.9, -0.8, 1),
        cornerR: clamp(0.3 + cur.smileR * 1.05 + sBoost - cur.frown * 0.9, -0.8, 1),
        pucker: cur.pucker, funnel: cur.funnel, puff: smoothstep(0.25, 0.7, cur.puff), shift: cur.mouthX,
      },
    };
    P.mouth.smile = smile;

    // ----- geometry
    const k = kid, L = layout(k);
    L0 = { ...L, fw: k.fw * L.headK, faceCY: L.chinY - (k.chin - (k.top + (k.chin - k.top) * 0.45)) * L.headK };
    ensureLayers(k, clamp(L.headK * dpr, 0.35, 1));
    updateBox(k, L);
    const headCanvas = renderHead(k, P);

    const pop = clamp((t - popAt) / 0.45, 0, 1);
    const popScale = 1 - 0.18 * Math.sin(pop * Math.PI) * (1 - pop);
    const breath = Math.sin(t * 2 * Math.PI / (asleep ? 4.2 : 3.4));
    const hop = -Math.sin(wake * Math.PI) * 22 * L.S;
    const charScale = (1 + clamp(cur.lean, -0.35, 0.9) * 0.5) * popScale;
    const shiftX = clamp(cur.px, -1, 1) * 70 * L.S, shiftY = clamp(cur.py, -1, 1) * 25 * L.S;
    const anchorX = L.neckX, anchorY = L.chinY;

    const base = new DOMMatrix([dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr]);
    let view = base;
    if (settings.zoom > 1) {
      view = base.translate(W / 2, H / 2).scale(settings.zoom)
        .translate(-L.neckX, -(L.chinY - (k.chin - k.top) * 0.5 * L.headK));
    }
    const charM = new DOMMatrix().translate(anchorX + shiftX, anchorY + shiftY).scale(charScale).translate(-anchorX, -anchorY);

    const bw = k.body ? k.body.width * L.bodyK : 0, bh = L.bodyH;
    const bodyM = charM.translate(L.neckX, L.bodyTop + bh + hop * 0.6)
      .rotate((P.roll * 0.1 + P.yaw * 0.03) * DEG)
      .scale(1, 1 + breath * 0.012).translate(-bw / 2, -bh).scale(L.bodyK || 1);

    const pivotSrcY = k.chin - k.fw * 0.12;
    const headM = charM.translate(L.neckX + P.yaw * 14 * L.S + shiftX * 0.0,
      L.chinY - k.fw * 0.12 * L.headK - P.pitch * 12 * L.S + hop - breath * 1.6 * L.S)
      .rotate(P.roll * DEG)
      .scale(1 - Math.abs(P.yaw) * 0.04, 1 - Math.abs(P.pitch) * 0.045)
      .translate(-k.cx * L.headK, -pivotSrcY * L.headK).scale(L.headK);

    const W_ = warpParams(k, P);
    const headPt = (u, v) => headM.transformPoint(new DOMPoint(warpMapX(u, k.cx, W_.R, W_.d), warpMapX(v, W_.Rv, W_.Rv, W_.p)));
    const fyS = (f) => k.top + (k.chin - k.top) * f;
    const fc = headPt(k.cx, fyS(0.45));
    const fwScreen = k.fw * L.headK * charScale;
    const F = { cx: fc.x, cy: fc.y, fw: fwScreen };
    const mouthPt = headPt(k.cx, fyS(GEO.mouthY));
    lastGeom = { S: L.S, fw: fwScreen, F, mouth: [mouthPt.x, mouthPt.y] };

    // shoulders (on the body image) for the arms
    let shoulders = null;
    if (k.armless) {
      const bm = k.bm, inset = (bm.shoulderX1 - bm.shoulderX0) * 0.07;
      const sL = bodyM.transformPoint(new DOMPoint(bm.shoulderX0 + inset, bm.shoulderY));
      const sR = bodyM.transformPoint(new DOMPoint(bm.shoulderX1 - inset, bm.shoulderY));
      shoulders = { L: [sL.x, sL.y], R: [sR.x, sR.y] };
    }

    // ----- draw
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const handPts = {};
    if (shoulders) {
      for (const side of ['L', 'R']) handPts[side] = handPoints(arms[side], F, shoulders[side]);
      ctx.setTransform(view);
      for (const side of ['L', 'R']) drawArm(ctx, shoulders[side], handPts[side], side === 'L' ? -1 : 1, k.sleeve, k.cfg.line, fwScreen);
    }
    if (k.body) {
      ctx.setTransform(view.multiply(bodyM));
      ctx.drawImage(k.body, 0, 0);
    }
    ctx.setTransform(view.multiply(headM));
    ctx.drawImage(headCanvas, 0, 0, k.head.width, k.head.height);

    ctx.setTransform(view);
    if (shoulders) {
      for (const side of ['L', 'R']) {
        if (!drawHandSprite(ctx, arms[side], handPts[side], fwScreen)) drawHand(ctx, chibify(handPts[side].map((p) => p.slice())), k.skin, k.cfg.line, fwScreen);
        drawCuff(ctx, shoulders[side], handPts[side], k.sleeve, k.cfg.line, fwScreen);
      }
    }

    if (mode === 'live') expressionFx(t, dt, P, lastGeom);
    if (mode === 'asleep' && t - (frame.lastZ || 0) > 1.3) {
      frame.lastZ = t;
      spawn('zzz', { attach: true, x: fwScreen * 0.6, y: -fwScreen * 0.45, vx: 30 * L.S, vy: -55 * L.S, wobble: 10, life: 3.4, size: rnd(1.3, 1.8) });
    }
    drawFx(ctx, t, L.S, F);

    if (!(ASSETS.desk && fgEl.naturalWidth)) {
      ctx.setTransform(view);
      ctx.fillStyle = '#d9a77a'; ctx.fillRect(0, L.deskTop, W, H - L.deskTop);
    }
    if (rec.active) rec.compose();
    if (settings.debug) drawDebug(mode);
  }

  let dbgLast = 0;
  function drawDebug(mode) {
    const t = now();
    if (t - dbgLast < 0.15) return;
    dbgLast = t;
    const f = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);
    let s = `mode ${mode}   src ${source || '-'}\n`;
    const keys = Object.keys(NEUTRAL);
    for (let i = 0; i < keys.length; i += 2) {
      const a = keys[i], b = keys[i + 1];
      s += `${a.padEnd(7)}${f(cur[a])}   ${b ? b.padEnd(7) + f(cur[b]) : ''}\n`;
    }
    s += `hands  L ${arms.L.w.toFixed(2)} ${arms.L.gesture.padEnd(9)} R ${arms.R.w.toFixed(2)} ${arms.R.gesture}`;
    const st = window.tracker && tracker.status;
    if (st) s += `\n${st.delegate} ${st.fps} fps · face ${st.faceMs} ms · hands ${st.handMs} ms`;
    dbgPre.textContent = s;
  }

  // ---------------------------------------------------------------- toast & countdown
  let toastTimer = 0;
  function toast(text, ms = 1800) {
    const el = $('toast');
    el.textContent = text; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- day / night
  function updateTimeOfDay() {
    const hasNight = !!ASSETS.background_night;
    const h = new Date().getHours();
    const night = hasNight && (settings.timeOfDay === 'night' || (settings.timeOfDay === 'auto' && (h >= 19 || h < 6)));
    bgNightEl.style.opacity = night ? '1' : '0';
    document.body.classList.toggle('night', night);
  }
  setInterval(updateTimeOfDay, 60 * 1000);

  // ---------------------------------------------------------------- recording & photos
  function coverRect(iw, ih, W_, H_) {
    const s = Math.max(W_ / iw, H_ / ih);
    return { x: (W_ - iw * s) / 2, y: (H_ - ih * s) / 2, w: iw * s, h: ih * s };
  }
  /** Draws the whole wallpaper scene (viewport coordinates) into g, cropped to src rect → dst rect. */
  function drawScene(g, src, dst) {
    const s = dst.w / src.w;
    g.save();
    g.beginPath(); g.rect(dst.x, dst.y, dst.w, dst.h); g.clip();
    g.setTransform(s, 0, 0, s, dst.x - src.x * s, dst.y - src.y * s);
    const night = document.body.classList.contains('night');
    const bgImg = night && bgNightEl.naturalWidth ? bgNightEl : bgEl;
    if (bgImg.naturalWidth) { const r = coverRect(bgImg.naturalWidth, bgImg.naturalHeight, W, H); g.drawImage(bgImg, r.x, r.y, r.w, r.h); }
    else { g.fillStyle = '#f7e6d6'; g.fillRect(0, 0, W, H); }
    g.drawImage(canvas, box.x, box.y, box.w, box.h);
    if (fgEl.naturalWidth && fgEl.style.display !== 'none') { const r = fgEl.getBoundingClientRect(); g.drawImage(fgEl, r.x, r.y, r.width, r.height); }
    g.restore();
  }
  function sceneCrop(aspect) {      // a crop of the viewport centred on the character
    let h = H * 0.98, w = h * aspect;
    if (w > W) { w = W; h = w / aspect; }
    const cx = clamp(W * (0.5 + settings.offsetX), w / 2, W - w / 2);
    return { x: cx - w / 2, y: H - h, w, h };
  }
  function composeFrame(g, layout, CW, CH) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fbe9dc'; g.fillRect(0, 0, CW, CH);
    if (layout === 'scene') { drawScene(g, sceneCrop(CW / CH), { x: 0, y: 0, w: CW, h: CH }); return; }
    if (layout === 'portrait' && L0.fw) {               // close-up around the kid's head and hands
      const h = L0.fw * 2.75, w = h * CW / CH;
      drawScene(g, { x: L0.neckX - w / 2, y: L0.faceCY - h * 0.46, w, h }, { x: 0, y: 0, w: CW, h: CH });
      return;
    }
    const split = Math.round(CH * 0.6);
    drawScene(g, sceneCrop(CW / split), { x: 0, y: 0, w: CW, h: split });
    // the real person, mirrored like a selfie
    const v = window.tracker && tracker.video;
    const pad = 36, rx = pad, ry = split + pad * 0.6, rw = CW - pad * 2, rh = CH - split - pad * 1.6;
    g.save();
    roundRect(g, rx, ry, rw, rh, 44); g.clip();
    if (v && v.videoWidth) {
      const r = coverRect(v.videoWidth, v.videoHeight, rw, rh);
      g.translate(rx + rw, ry); g.scale(-1, 1);
      g.drawImage(v, rw - r.x - r.w, r.y, r.w, r.h);
    } else { g.fillStyle = '#e9cfc0'; g.fillRect(rx, ry, rw, rh); }
    g.restore();
    g.lineWidth = 8; g.strokeStyle = '#fff'; roundRect(g, rx, ry, rw, rh, 44); g.stroke();
    const chip = (text, x, y) => {
      g.font = '800 40px ui-rounded, "SF Pro Rounded", system-ui';
      const w = g.measureText(text).width + 44;
      g.fillStyle = 'rgba(255,255,255,.92)'; roundRect(g, x, y, w, 64, 32); g.fill();
      g.fillStyle = '#6b3a2a'; g.textBaseline = 'middle'; g.fillText(text, x + 22, y + 34);
    };
    chip('MiniMe 🧸', 30, 30);
    chip('me', rx + 24, ry + rh - 88);
  }

  const rec = {
    active: false, canvas: null, g: null, layout: 'split', recorder: null, chunks: [],
    compose() { if (this.g) composeFrame(this.g, this.layout, this.canvas.width, this.canvas.height); },
  };
  function pickMime() {
    const types = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    return types.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  async function startRecording({ seconds = 10, layout = 'split', test = false, noCountdown = false }) {
    if (rec.active) return;
    const mime = pickMime();
    if (!mime) { toast(tr('noRec')); post({ type: 'recording', active: false }); return; }
    const count = $('count');
    for (const n of noCountdown ? [] : ['3', '2', '1']) {
      count.textContent = n; count.classList.add('show');
      await new Promise((r) => setTimeout(r, 650)); count.classList.remove('show');
      await new Promise((r) => setTimeout(r, 200));
    }
    const [CW, CH] = layout === 'scene' ? [1920, 1080] : [1080, 1920];
    rec.canvas = makeCanvas(CW, CH); rec.g = rec.canvas.getContext('2d'); rec.layout = layout;
    rec.compose();
    const stream = rec.canvas.captureStream(30);
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 }); }
    catch (e) { toast(tr('recFail')); post({ type: 'recording', active: false }); return; }
    rec.chunks = [];
    recorder.ondataavailable = (e) => e.data && e.data.size && rec.chunks.push(e.data);
    const done = new Promise((r) => (recorder.onstop = r));
    rec.active = true; rec.recorder = recorder;
    $('rec').style.display = 'flex';
    recorder.start(500);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    recorder.stop();
    await done;
    rec.active = false; $('rec').style.display = 'none';
    stream.getTracks().forEach((tr) => tr.stop());
    post({ type: 'recording', active: false });
    const blob = new Blob(rec.chunks, { type: mime.split(';')[0] });
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const ok = await upload(blob, test ? `test.${ext}` : `MiniMe-${stamp()}.${ext}`, test);
    post({ type: 'log', level: 'info', msg: `recorded ${mime} ${blob.size} bytes, saved=${ok}` });
    if (!test) toast(ok ? tr('videoSaved') : tr('saveFail'), 2600);
  }

  async function takePhoto(layout) {
    const [CW, CH] = layout === 'scene' ? [1920, 1080] : [1080, 1920];
    const c = makeCanvas(CW, CH);
    composeFrame(c.getContext('2d'), layout, CW, CH);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const ok = blob && (await upload(blob, `MiniMe-${stamp()}.png`));
    toast(ok ? tr('photoSaved') : tr('saveFail'), 2400);
  }

  async function upload(blob, name, test = false) {
    const token = window.MINIME && window.MINIME.token;
    if (!token) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      return true;
    }
    try {
      const r = await fetch('/save?name=' + encodeURIComponent(name) + (test ? '&test=1' : ''), {
        method: 'POST', headers: { 'X-MiniMe-Token': token, 'Content-Type': 'application/octet-stream' }, body: blob,
      });
      return r.ok;
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------- demo / preview mode
  if (demo) {
    let fakeHand = false;
    window.addEventListener('mousemove', (e) => {
      target.yaw = (e.clientX / W - 0.5) * 1.2;
      target.pitch = -(e.clientY / H - 0.5) * 0.9;
      target.gx = target.yaw;
      if (fakeHand) {
        const hx = (e.clientX - W / 2) / (300 * H / 1000) * 0.9, hy = (e.clientY - H * 0.45) / (300 * H / 1000);
        rig.setHands([{ side: 'R', pts: OPEN_HAND.map(([x, y]) => [hx + x, hy + y]), gesture: 'open' }]);
      }
    });
    window.addEventListener('mousedown', () => { target.jaw = 0.8; });
    window.addEventListener('mouseup', () => { target.jaw = 0; });
    const toggle = (key, v = 1) => { target[key] = target[key] > 0.5 ? 0 : v; };
    window.addEventListener('keydown', (e) => {
      if (e.key === 's') { toggle('smileL'); target.smileR = target.smileL; }
      if (e.key === 'k') toggle('pucker');
      if (e.key === 'p') toggle('puff');
      if (e.key === 'o') { toggle('jaw', 0.9); target.eyeL = target.eyeR = target.jaw ? 1.4 : 1; target.browL = target.browR = target.jaw ? 1 : 0; }
      if (e.key === 'b') { target.eyeL = target.eyeR = 0; setTimeout(() => (target.eyeL = target.eyeR = 1), 180); }
      if (e.key === 'w') onGesture('wave');
      if (e.key === 'h') onGesture('heart');
      if (e.key === 't') onGesture('thumbsUp');
      if (e.key === 'v') onGesture('peace');
      if (e.key === 'H') fakeHand = !fakeHand;
      if (e.key === 'g') rig.configure({ character: settings.character === 'girl' ? 'boy' : 'girl' });
      if (e.key === 'd') rig.configure({ debug: !settings.debug });
    });
    setInterval(() => { lastFaceAt = now(); source = 'mp'; }, 200);
  }

  // ---------------------------------------------------------------- boot
  if (ASSETS.background) bgEl.src = ASSETS.background.src;
  if (ASSETS.background_night) bgNightEl.src = ASSETS.background_night.src;
  if (ASSETS.desk) { fgEl.onload = () => { layoutForeground(); boxKey = ''; }; fgEl.src = ASSETS.desk.src; }
  resize();
  const params = new URLSearchParams(location.search);
  rig.configure({ character: params.get('kid') || settings.character, debug: params.has('debug'),
                  timeOfDay: params.get('tod') || settings.timeOfDay });
  requestAnimationFrame(frame);
})();
