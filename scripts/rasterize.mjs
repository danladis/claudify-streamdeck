#!/usr/bin/env node
/**
 * Rasterises the SVG the faces emit, so a key can be looked at instead of
 * trusted. Deliberately narrow: it understands only the shapes render.js,
 * clawd.js and party.js actually produce -- rect, circle, and paths of
 * M/L/Q/A/Z.
 *
 * <text> is not rendered; its slot is marked with a faint bar. The number is
 * already proven on the device, and a font rasteriser is not worth carrying.
 *
 *   node scripts/rasterize.mjs      # writes build/raster/*.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'com.claudify.agents.sdPlugin', 'bin', 'lib');
const OUT = join(ROOT, 'build', 'raster');

const { encodePng } = await import(join(ROOT, 'scripts', 'icons.mjs'));

const num = (value) => Number(value);

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

function attrs(tag) {
  const out = {};
  for (const [, key, value] of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[key] = value;
  return out;
}

/* ------------------------------------------------------------- geometry ---- */

/** Flatten an endpoint-parameterised circular arc into points. */
function flattenArc(points, from, to, radius, largeArc, sweep) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  const offset = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  // Two candidate centres; largeArc and sweep together pick one.
  const dir = largeArc === sweep ? -1 : 1;
  const cx = (x1 + x2) / 2 + (dir * offset * -(y2 - y1)) / (chord || 1);
  const cy = (y1 + y2) / 2 + (dir * offset * (x2 - x1)) / (chord || 1);

  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  if (sweep === 1 && a2 < a1) a2 += Math.PI * 2;
  if (sweep === 0 && a2 > a1) a2 -= Math.PI * 2;

  for (let s = 1; s <= 72; s += 1) {
    const a = a1 + ((a2 - a1) * s) / 72;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
}

/** Path data to a list of point runs. */
function flattenPath(d) {
  const tokens = d.match(/[MLQAZ]|-?[\d.]+/g) ?? [];
  const runs = [];
  let run = [];
  let cursor = [0, 0];
  let i = 0;

  while (i < tokens.length) {
    const op = tokens[i++];
    if (op === 'M') {
      if (run.length > 1) runs.push(run);
      cursor = [num(tokens[i++]), num(tokens[i++])];
      run = [cursor];
    } else if (op === 'L') {
      cursor = [num(tokens[i++]), num(tokens[i++])];
      run.push(cursor);
    } else if (op === 'Q') {
      const [cx, cy] = [num(tokens[i++]), num(tokens[i++])];
      const [x, y] = [num(tokens[i++]), num(tokens[i++])];
      const [sx, sy] = cursor;
      for (let s = 1; s <= 12; s += 1) {
        const t = s / 12;
        const u = 1 - t;
        run.push([u * u * sx + 2 * u * t * cx + t * t * x, u * u * sy + 2 * u * t * cy + t * t * y]);
      }
      cursor = [x, y];
    } else if (op === 'A') {
      const radius = num(tokens[i++]);
      i += 2; // ry (same) and x-axis-rotation (always 0 here)
      const largeArc = num(tokens[i++]);
      const sweep = num(tokens[i++]);
      const to = [num(tokens[i++]), num(tokens[i++])];
      flattenArc(run, cursor, to, radius, largeArc, sweep);
      cursor = to;
    } else if (op === 'Z') {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

const insideRuns = (runs, x, y) => {
  let inside = false;
  for (const points of runs) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
};

const distanceToRuns = (runs, x, y) => {
  let best = Infinity;
  for (const points of runs) {
    for (let i = 1; i < points.length; i += 1) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
};

/* --------------------------------------------------------------- layers ---- */

function parse(svg) {
  const layers = [];

  for (const [tag] of svg.matchAll(/<(?:rect|circle|path|text)\b[^>]*\/?>/g)) {
    const a = attrs(tag);
    const fill = a.fill && a.fill !== 'none' ? hex(a.fill) : null;
    const stroke = a.stroke && a.stroke !== 'none' ? hex(a.stroke) : null;
    const width = a['stroke-width'] ? num(a['stroke-width']) : 1;

    if (tag.startsWith('<rect')) {
      const [x, y, w, h, r] = [num(a.x ?? 0), num(a.y ?? 0), num(a.width), num(a.height), num(a.rx ?? 0)];
      const inside = (px, py) => {
        if (px < x || px > x + w || py < y || py > y + h) return false;
        const dx = Math.max(x + r - px, 0, px - (x + w - r));
        const dy = Math.max(y + r - py, 0, py - (y + h - r));
        return dx === 0 || dy === 0 || Math.hypot(dx, dy) <= r;
      };
      if (fill) layers.push({ rgb: fill, inside });
      if (stroke) {
        const inner = (px, py) =>
          px > x + width && px < x + w - width && py > y + width && py < y + h - width;
        layers.push({ rgb: stroke, inside: (px, py) => inside(px, py) && !inner(px, py) });
      }
    } else if (tag.startsWith('<circle')) {
      const [cx, cy, r] = [num(a.cx), num(a.cy), num(a.r)];
      const distance = (px, py) => Math.hypot(px - cx, py - cy);
      if (fill) layers.push({ rgb: fill, inside: (px, py) => distance(px, py) <= r });
      if (stroke) {
        layers.push({ rgb: stroke, inside: (px, py) => Math.abs(distance(px, py) - r) <= width / 2 });
      }
    } else if (tag.startsWith('<path')) {
      const runs = flattenPath(a.d);
      if (fill) layers.push({ rgb: fill, inside: (px, py) => insideRuns(runs, px, py) });
      if (stroke) {
        layers.push({ rgb: stroke, inside: (px, py) => distanceToRuns(runs, px, py) <= width / 2 });
      }
    } else if (tag.startsWith('<text')) {
      const [x, y, size] = [num(a.x), num(a.y), num(a['font-size'] ?? 12)];
      layers.push({
        rgb: fill ?? [128, 128, 128],
        alpha: 0.3,
        inside: (px, py) => Math.abs(px - x) < size * 0.3 && py < y && py > y - size * 0.72,
      });
    }
  }

  return layers;
}

const SAMPLES = 3;

/** `scale` zooms for inspection; the SVG's own coordinates are 144 across. */
export function rasterize(svg, { scale = 1 } = {}) {
  const layers = parse(svg);
  const size = Math.round(144 * scale);
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let [r, g, b, a] = [0, 0, 0, 0];

      for (const layer of layers) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy += 1) {
          for (let sx = 0; sx < SAMPLES; sx += 1) {
            const x = (px + (sx + 0.5) / SAMPLES) / scale;
            const y = (py + (sy + 0.5) / SAMPLES) / scale;
            if (layer.inside(x, y)) hits += 1;
          }
        }
        if (!hits) continue;

        const alpha = (hits / (SAMPLES * SAMPLES)) * (layer.alpha ?? 1);
        const [lr, lg, lb] = layer.rgb;
        r = lr * alpha + r * (1 - alpha);
        g = lg * alpha + g * (1 - alpha);
        b = lb * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      }

      const o = (py * size + px) * 4;
      rgba[o] = Math.round(r);
      rgba[o + 1] = Math.round(g);
      rgba[o + 2] = Math.round(b);
      rgba[o + 3] = Math.round(a * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ---------------------------------------------------------------- main ---- */

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { renderKey, viewFor } = await import(join(LIB, 'render.js'));
  const { renderClawd, ANIMATIONS, DANCE, CLAWD_BODY } = await import(join(LIB, 'clawd.js'));

  mkdirSync(OUT, { recursive: true });

  const still = (pose) => renderClawd({ pose, offset: 0, x: 0 }, { body: CLAWD_BODY });

  const jobs = [
    ['ring-working-mark', renderKey({ state: 'working', value: '2', spin: true }, 0.08, { showMark: true })],
    ['ring-blocked-heavy', renderKey({ state: 'blocked', value: '3' }, 0, { thickness: 'heavy', showMark: true })],
    ['ring-empty-nomark', renderKey(viewFor({ ok: true, total: 0, working: 0, blocked: 0, idle: 0 }), 0, { showMark: false })],
    ['clawd-default', still('default')],
    ['clawd-arms-up', still('arms-up')],
    ['clawd-look-right', still('look-right')],
    ['clawd-peek-right', still('peek-right')],
    ['clawd-claw-right', still('claw-right')],
    ['clawd-crouch', renderClawd(DANCE[0], { body: CLAWD_BODY })],
    // The wiggle in full: the frames to check the legs really shuffle.
    ...ANIMATIONS.wiggle.sequence.map((frame, i) => [
      `clawd-wiggle-${i}`,
      renderClawd(frame, { body: CLAWD_BODY }),
    ]),
    ['clawd-scuttle-far', renderClawd(ANIMATIONS.scuttle.sequence[3], { body: CLAWD_BODY })],
  ];

  // The celebration, every fourth frame: enough to see the horn go out and come
  // back, and the confetti clear the key by the end.
  const { partyFrames, PARTY_FRAME_MS } = await import(join(LIB, 'party.js'));
  const partySvgs = partyFrames({}).map((uri) =>
    Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8'),
  );
  for (let i = 0; i < partySvgs.length; i += 4) {
    jobs.push([`party-${String(i * PARTY_FRAME_MS).padStart(4, '0')}ms`, partySvgs[i]]);
  }

  for (const [name, svg] of jobs) {
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, rasterize(svg));
    console.log(file);
  }
}
