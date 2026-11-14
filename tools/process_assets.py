#!/usr/bin/env python3
"""Turns the raw ChatGPT images in art/raw into rig-ready assets in web/assets.

Heads: trimmed, plus a 'face mask' (the skin area found by flood fill from the
face centre) that the renderer uses to keep animated eyes/mouth inside the face,
under the bangs. Measurements end up in web/assets/manifest.js.
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / 'art' / 'raw', ROOT / 'web' / 'assets'
OUT.mkdir(parents=True, exist_ok=True)


def trim(im, pad=8):
    a = np.array(im)[:, :, 3]
    ys, xs = np.where(a > 8)
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
           min(xs.max() + pad + 1, im.width), min(ys.max() + pad + 1, im.height))
    return im.crop(box), box


def face_mask(im, seed, thresh=38):
    """Flood-fill the skin region from `seed`; returns an L-mode mask."""
    rgb = Image.new('RGB', im.size, (0, 0, 0))
    rgb.paste(im.convert('RGB'), mask=im.split()[3])
    marker = (0, 255, 0)
    ImageDraw.floodfill(rgb, seed, marker, thresh=thresh)
    arr = np.array(rgb)
    m = np.all(arr == marker, axis=2).astype(np.uint8) * 255
    mask = Image.fromarray(m, 'L')
    # close tiny holes (highlight specks), then pull 2px inside the outline, then soften
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    mask = mask.filter(ImageFilter.MinFilter(5))
    return mask.filter(ImageFilter.GaussianBlur(1.2))


def skin_color(im, mask):
    a = np.array(im.convert('RGB')).reshape(-1, 3)
    m = np.array(mask).reshape(-1) > 200
    c = np.median(a[m], axis=0).astype(int)
    return '#%02x%02x%02x' % tuple(c)


def process_head(name, seed_rel=(0.5, 0.62)):
    src = Image.open(RAW / f'{name}.png').convert('RGBA')
    im, box = trim(src)
    seed = (int(im.width * seed_rel[0]), int(im.height * seed_rel[1]))
    mask = face_mask(im, seed)
    m = np.array(mask) > 128
    ys, xs = np.where(m)
    # face extents: use rows/cols with substantial coverage to ignore stray pixels
    face = dict(x0=int(xs.min()), x1=int(xs.max()), y0=int(ys.min()), y1=int(ys.max()))
    # widest row of the face gives the cheek line
    widths = m.sum(axis=1)
    cheek_y = int(np.argmax(widths))
    row = np.where(m[cheek_y])[0]
    face.update(cheekY=cheek_y, cheekX0=int(row.min()), cheekX1=int(row.max()))
    # chin: lowest skin pixel near the centre column
    cx = (face['x0'] + face['x1']) // 2
    col = np.where(m[:, cx])[0]
    face.update(cx=cx, chinY=int(col.max()), foreheadY=int(col.min()))
    im.save(OUT / f'{name}.png', optimize=True)
    white = Image.new('RGBA', im.size, (255, 255, 255, 0))
    white.putalpha(mask)
    white.save(OUT / f'{name}_mask.png', optimize=True)
    # debug preview
    dbg = im.copy()
    tint = Image.new('RGBA', im.size, (0, 255, 120, 110))
    dbg.paste(tint, mask=mask.point(lambda v: 110 if v > 128 else 0))
    d = ImageDraw.Draw(dbg)
    d.line([(face['cheekX0'], cheek_y), (face['cheekX1'], cheek_y)], fill=(255, 0, 0, 255), width=3)
    d.line([(cx, face['foreheadY']), (cx, face['chinY'])], fill=(0, 0, 255, 255), width=3)
    (ROOT / 'art' / 'debug').mkdir(exist_ok=True)
    dbg.save(ROOT / 'art' / 'debug' / f'{name}_mask.png')
    return dict(src=f'assets/{name}.png', mask=f'assets/{name}_mask.png', w=im.width, h=im.height,
                skin=skin_color(im, mask), face=face)


def process_armless(name):
    """Body without arms: also find the sleeve caps (arm roots) and the sweater colour."""
    d = process_simple(name)
    im = Image.open(OUT / f'{name}.png').convert('RGBA')
    a = np.array(im)
    al = a[:, :, 3] > 128
    h = al.shape[0]
    rows = range(0, int(h * 0.6))
    y = max(rows, key=lambda r: np.count_nonzero(al[r]))
    xs = np.where(al[y])[0]
    sample = a[int(h * 0.62), d['neckX'] - int(d['w'] * 0.13), :3]
    d.update(shoulderY=int(y), shoulderX0=int(xs.min()), shoulderX1=int(xs.max()),
             color='#%02x%02x%02x' % tuple(int(v) for v in sample))
    return d


def process_simple(name):
    src = Image.open(RAW / f'{name}.png').convert('RGBA')
    im, _ = trim(src)
    im.save(OUT / f'{name}.png', optimize=True)
    a = np.array(im)[:, :, 3] > 128
    # neck: topmost opaque rows → their horizontal centre
    top = int(np.where(a.any(axis=1))[0].min())
    row = np.where(a[top + 6])[0]
    return dict(src=f'assets/{name}.png', w=im.width, h=im.height,
                neckX=int((row.min() + row.max()) / 2), neckTop=top, neckW=int(row.max() - row.min()))


def process_background(name):
    # 2x Lanczos upscale + light sharpening so it stays crisp on Retina screens
    im = Image.open(RAW / f'{name}.png').convert('RGB')
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    im.save(OUT / f'{name}.jpg', quality=90, optimize=True, progressive=True)
    return dict(src=f'assets/{name}.jpg', w=im.width, h=im.height)


def process_desk(name):
    im = Image.open(RAW / f'{name}.png').convert('RGBA')
    a = np.array(im)[:, :, 3]
    # desk edge: first row (from the top) where most of the width is opaque
    rows = (a > 200).mean(axis=1)
    edge = int(np.argmax(rows > 0.9))
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    im.save(OUT / f'{name}.png', optimize=True)
    return dict(src=f'assets/{name}.png', w=im.width, h=im.height, edge=round(edge / a.shape[0], 4))


HAND_POSES = [['open', 'fist', 'point', 'peace'], ['thumbsUp', 'ok', 'rock', 'relaxed']]
# Which side the thumb is on in each drawing (checked by eye); for thumbsUp: are the curled fingers right of the thumb?
HAND_THUMB_LEFT = {'open': True, 'fist': True, 'point': True, 'peace': True, 'ok': True, 'rock': True, 'relaxed': True}
HAND_FINGERS_RIGHT = True


def runs(v):
    out, start = [], None
    for i, x in enumerate(v):
        if x and start is None:
            start = i
        if not x and start is not None:
            out.append((start, i - 1)); start = None
    if start is not None:
        out.append((start, len(v) - 1))
    return out


def process_hands():
    """Split the 4x2 hand sprite sheet into one image per pose, with a wrist anchor."""
    im = Image.open(RAW / 'hands.png').convert('RGBA')
    al = np.array(im)[:, :, 3] > 40
    cols, rows = runs(al.any(axis=0)), runs(al.any(axis=1))
    assert len(cols) == 4 and len(rows) == 2, (cols, rows)
    (OUT / 'hands').mkdir(exist_ok=True)
    poses = {}
    for r, (y0, y1) in enumerate(rows):
        for c, (x0, x1) in enumerate(cols):
            name = HAND_POSES[r][c]
            cell = im.crop((x0, y0, x1 + 1, y1 + 1))
            spr, _ = trim(cell, pad=4)
            a = np.array(spr)[:, :, 3] > 128
            h = a.shape[0]
            bottom = np.where(a.any(axis=1))[0].max()
            band = a[max(bottom - int(h * 0.08), 0):bottom + 1]
            xs = np.where(band.any(axis=0))[0]
            spr.save(OUT / 'hands' / f'{name}.png', optimize=True)
            poses[name] = dict(src=f'assets/hands/{name}.png', w=spr.width, h=spr.height,
                               ax=round(float(xs.mean()), 1), ay=round(bottom - h * 0.05, 1),
                               thumbLeft=HAND_THUMB_LEFT.get(name, True))
            if name == 'thumbsUp':
                poses[name]['fingersRight'] = HAND_FINGERS_RIGHT
    return dict(ref=poses['open']['h'], poses=poses)


if __name__ == '__main__':
    manifest = {}
    for kid in ('girl', 'boy'):
        if (RAW / f'{kid}_head.png').exists():
            manifest[f'{kid}_head'] = process_head(f'{kid}_head')
        if (RAW / f'{kid}_body.png').exists():
            manifest[f'{kid}_body'] = process_simple(f'{kid}_body')
        if (RAW / f'{kid}_body_armless.png').exists():
            manifest[f'{kid}_body_armless'] = process_armless(f'{kid}_body_armless')
    for bg in ('background', 'background_night'):
        if (RAW / f'{bg}.png').exists():
            manifest[bg] = process_background(bg)
    if (RAW / 'desk.png').exists():
        manifest['desk'] = process_desk('desk')
    if (RAW / 'hands.png').exists():
        manifest['hands'] = process_hands()
    (OUT / 'manifest.js').write_text('window.ASSETS = ' + json.dumps(manifest, indent=2) + ';\n')
    print(json.dumps(manifest, indent=2))
