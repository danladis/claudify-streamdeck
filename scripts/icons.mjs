#!/usr/bin/env node
/**
 * Generates the PNG icons the manifest requires.
 *
 * Stream Deck accepts SVG for action icons and key images, but the plugin's
 * marketplace and category icons must be PNG. Rather than pull in a rasteriser,
 * the icon is defined as a handful of analytic shapes and sampled directly --
 * it is a ring, an arc and a dot, which is exactly what that costs.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMGS = join(ROOT, 'com.claudify.agents.sdPlugin', 'imgs');

// Running this file writes the icons; importing it just borrows encodePng().
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/* ---------------------------------------------------------------- PNG ---- */

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** @param rgba Buffer of width*height*4 bytes. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple
  // and still compresses well for flat-colour art.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ shapes ---- */

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance to an annulus of the given radius and thickness. */
function sdRing(x, y, cx, cy, radius, thickness) {
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - thickness / 2;
}

/**
 * Distance to an arc: the ring, clipped to a sweep starting at 12 o'clock and
 * running clockwise, with round caps added back at both ends.
 */
function sdArc(x, y, cx, cy, radius, thickness, turns) {
  const ring = sdRing(x, y, cx, cy, radius, thickness);
  const angle = (Math.atan2(x - cx, cy - y) + Math.PI * 2) % (Math.PI * 2);
  const sweep = turns * Math.PI * 2;

  let arc = angle <= sweep ? ring : Infinity;
  for (const capAngle of [0, sweep]) {
    const capX = cx + radius * Math.sin(capAngle);
    const capY = cy - radius * Math.cos(capAngle);
    arc = Math.min(arc, Math.hypot(x - capX, y - capY) - thickness / 2);
  }
  return arc;
}

const SAMPLES = 4;

/**
 * Paint `layers` (back to front) into an RGBA buffer, antialiasing by taking
 * SAMPLES x SAMPLES coverage samples per pixel.
 */
function render(size, layers) {
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let [r, g, b] = [0, 0, 0];
      let a = 0;

      for (const layer of layers) {
        let coverage = 0;
        for (let sy = 0; sy < SAMPLES; sy += 1) {
          for (let sx = 0; sx < SAMPLES; sx += 1) {
            const x = px + (sx + 0.5) / SAMPLES;
            const y = py + (sy + 0.5) / SAMPLES;
            if (layer.sd(x, y) <= 0) coverage += 1;
          }
        }
        if (coverage === 0) continue;

        const alpha = coverage / (SAMPLES * SAMPLES);
        const [lr, lg, lb] = layer.rgb;
        r = lr * alpha + r * (1 - alpha);
        g = lg * alpha + g * (1 - alpha);
        b = lb * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      }

      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(r);
      rgba[offset + 1] = Math.round(g);
      rgba[offset + 2] = Math.round(b);
      rgba[offset + 3] = Math.round(a * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/** The full badge: dark card, ring track, green progress arc, centre dot. */
function badge(size) {
  const c = size / 2;
  return render(size, [
    { rgb: hex('#0b0b11'), sd: (x, y) => sdRoundRect(x, y, c, c, c, c, size * 0.22) },
    { rgb: hex('#15151f'), sd: (x, y) => sdRoundRect(x, y, c, c, c - size * 0.035, c - size * 0.035, size * 0.19) },
    { rgb: hex('#242438'), sd: (x, y) => sdRing(x, y, c, c, size * 0.3, size * 0.075) },
    { rgb: hex('#4ade80'), sd: (x, y) => sdArc(x, y, c, c, size * 0.3, size * 0.075, 0.62) },
    { rgb: hex('#e6e8ef'), sd: (x, y) => Math.hypot(x - c, y - c) - size * 0.105 },
  ]);
}

/** Category strip icon: monochrome, no card, readable at 28px. */
function categoryMark(size) {
  const c = size / 2;
  return render(size, [
    { rgb: hex('#d7dae3'), sd: (x, y) => sdRing(x, y, c, c, size * 0.34, size * 0.1) },
    { rgb: hex('#d7dae3'), sd: (x, y) => Math.hypot(x - c, y - c) - size * 0.12 },
  ]);
}

/* ------------------------------------------------------------- write ---- */

const OUTPUTS = IS_MAIN
  ? [
      ['plugin/marketplace.png', badge(256)],
      ['plugin/marketplace@2x.png', badge(512)],
      ['plugin/category.png', categoryMark(28)],
      ['plugin/category@2x.png', categoryMark(56)],
    ]
  : [];

if (IS_MAIN) {
  for (const [name, data] of OUTPUTS) {
    const file = join(IMGS, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    console.log(`${name}  ${data.length} bytes`);
  }

  // The action images come straight from the renderers, so the face Stream Deck
  // shows before a key is configured is the face it will actually draw.
  const LIB = join(ROOT, 'com.claudify.agents.sdPlugin', 'bin', 'lib');
  const { renderKey, viewFor } = await import(join(LIB, 'render.js'));
  const { renderClawd, CLAWD_BODY } = await import(join(LIB, 'clawd.js'));
  const { renderBars } = await import(join(LIB, 'usage', 'bars.js'));
  const { renderGauge } = await import(join(LIB, 'usage', 'gauge.js'));

  // The viewBox stays 144; only the declared size changes, so it scales cleanly.
  const atSize = (svg, size) =>
    svg.replace('width="144" height="144"', `width="${size}" height="${size}"`);

  const idle = { ok: true, total: 0, working: 0, blocked: 0, idle: 0 };
  const ring = renderKey(viewFor(idle), 0, { thickness: 'normal', showMark: true });
  const clawd = renderClawd({ pose: 'default', offset: 0, x: 0 }, { body: CLAWD_BODY });

  // A plausible reading rather than an empty one, so the two usage actions look
  // like themselves in the list. No reset line: the icons are committed to the
  // repo, and a formatted date would rewrite them on every run.
  const sample = {
    session: { usedPercent: 42, resetAt: null },
    weekly: { usedPercent: 68, resetAt: null },
    status: 'ok',
    updatedAt: '',
    stale: false,
  };
  const bars = renderBars(sample);
  const gauge = renderGauge(sample, { window: 'session', resetInfo: 'none' });

  const SVGS = [
    ['actions/count/key.svg', ring],
    ['actions/count/icon.svg', atSize(ring, 40)],
    ['actions/mascot/key.svg', clawd],
    ['actions/mascot/icon.svg', atSize(clawd, 40)],
    ['actions/usage/key.svg', bars],
    ['actions/usage/icon.svg', atSize(bars, 40)],
    ['actions/usage-window/key.svg', gauge],
    ['actions/usage-window/icon.svg', atSize(gauge, 40)],
  ];

  for (const [name, svg] of SVGS) {
    const file = join(IMGS, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${svg}\n`);
    console.log(`${name}  ${svg.length} bytes`);
  }
}
