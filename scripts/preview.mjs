#!/usr/bin/env node
/**
 * Renders every key state to build/preview/index.html so both faces can be
 * checked in a browser instead of on the hardware.
 *
 * Neither face can animate inside its SVG -- Stream Deck rasterises each frame
 * -- so the page flips through the real frames with CSS.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'build', 'preview');
const LIB = join(ROOT, 'com.claudify.agents.sdPlugin', 'bin', 'lib');

const { viewFor, renderKey, THICKNESS, SPIN_PERIOD_MS, SPIN_FRAME_MS } = await import(
  join(LIB, 'render.js')
);
const { clawdView, renderClawd, clawdFrameMs, ANIMATIONS, DEFAULT_ANIMATION } = await import(
  join(LIB, 'clawd.js'),
);
const { SPEEDS } = await import(join(LIB, 'settings.js'));
const { renderBars } = await import(join(LIB, 'usage', 'bars.js'));
const { renderGauge } = await import(join(LIB, 'usage', 'gauge.js'));

const SUMMARIES = {
  clear: { ok: true, total: 0, working: 0, blocked: 0, idle: 0 },
  working: { ok: true, total: 2, working: 1, blocked: 0, idle: 1 },
  blocked: { ok: true, total: 3, working: 1, blocked: 1, idle: 1 },
  idle: { ok: true, total: 2, working: 0, blocked: 0, idle: 2 },
  many: { ok: true, total: 12, working: 9, blocked: 0, idle: 3 },
  error: { ok: false, error: 'claude-not-found' },
};

mkdirSync(OUT, { recursive: true });

let flipCss = '';
let flipId = 0;

/**
 * A tile. Given more than one frame it becomes a flipbook at `frameMs`, which
 * is the interval the plugin pushes them at.
 */
function tile(label, frames, frameMs) {
  if (frames.length === 1) {
    return `<figure><div class="key">${frames[0]}</div><figcaption>${label}</figcaption></figure>`;
  }

  const id = `flip${(flipId += 1)}`;
  const period = frames.length * frameMs;
  const slice = (100 / frames.length).toFixed(3);
  flipCss +=
    `\n  #${id} .fr { animation: ${id}-flip ${period}ms steps(1, end) infinite; }` +
    frames
      .map((_, i) => `\n  #${id} .fr:nth-child(${i + 1}) { animation-delay: ${i * frameMs}ms; }`)
      .join('') +
    `\n  @keyframes ${id}-flip { 0%, ${slice}% { opacity: 1 } ${slice}%, 100% { opacity: 0 } }`;

  return (
    `<figure><div class="key flip" id="${id}">` +
    frames.map((svg) => `<div class="fr">${svg}</div>`).join('') +
    `</div><figcaption>${label}</figcaption></figure>`
  );
}

/* ------------------------------------------------------------ ring face ---- */

const SPIN_FRAMES = SPIN_PERIOD_MS / SPIN_FRAME_MS;

const ringFramesFor = (summary, options) => {
  const view = viewFor(summary);
  return view.spin
    ? Array.from({ length: SPIN_FRAMES }, (_, i) => renderKey(view, i / SPIN_FRAMES, options))
    : [renderKey(view, 0, options)];
};

const ringTiles = Object.entries(SUMMARIES)
  .map(([name, summary]) => tile(name, ringFramesFor(summary, { showMark: true }), SPIN_FRAME_MS))
  .join('\n');

const thicknessTiles = Object.keys(THICKNESS)
  .map((thickness) =>
    tile(
      `${thickness} (${THICKNESS[thickness]})`,
      ringFramesFor(SUMMARIES.working, { thickness, showMark: true }),
      SPIN_FRAME_MS,
    ),
  )
  .join('\n');

const markTiles = [true, false]
  .map((showMark) =>
    tile(
      showMark ? 'mark on' : 'mark off',
      ringFramesFor(SUMMARIES.working, { showMark }),
      SPIN_FRAME_MS,
    ),
  )
  .join('\n');

/* ---------------------------------------------------------- clawd face ---- */

const clawdFramesFor = (summary, settings) => {
  const view = clawdView(summary, settings);
  return view.sequence.map((frame) => renderClawd(frame, { body: view.body, badge: view.badge }));
};

const clawdTiles = Object.entries(SUMMARIES)
  .map(([name, summary]) =>
    tile(name, clawdFramesFor(summary, {}), clawdFrameMs({ clawdAnimation: DEFAULT_ANIMATION })),
  )
  .join('\n');

/** Every move Clawd can be set to, each at its own pace. */
const moveTiles = Object.entries(ANIMATIONS)
  .map(([clawdAnimation, animation]) =>
    tile(
      `${clawdAnimation} (${animation.sequence.length} &times; ${clawdFrameMs({ clawdAnimation })}ms)`,
      clawdFramesFor(SUMMARIES.working, { clawdAnimation }),
      clawdFrameMs({ clawdAnimation }),
    ),
  )
  .join('\n');

/** The wiggle at every speed the setting offers. */
const speedTiles = Object.keys(SPEEDS)
  .map((speed) =>
    tile(
      `${speed} (${clawdFrameMs({ speed })}ms)`,
      clawdFramesFor(SUMMARIES.working, { speed }),
      clawdFrameMs({ speed }),
    ),
  )
  .join('\n');

/* ---------------------------------------------------------- usage faces ---- */

/** A fixed clock, so the countdown tiles do not change between runs. */
const USAGE_NOW = new Date('2026-08-28T10:00:00.000Z');

const usageSnapshot = (session, weekly, over = {}) => ({
  session: { usedPercent: session, resetAt: '2026-08-28T18:30:00.000Z' },
  weekly: { usedPercent: weekly, resetAt: '2026-09-01T09:00:00.000Z' },
  status: 'ok',
  updatedAt: USAGE_NOW.toISOString(),
  stale: false,
  thresholds: { warning: 70, critical: 90 },
  ...over,
});

const USAGE_STATES = {
  quiet: usageSnapshot(12, 30),
  warming: usageSnapshot(74, 55),
  critical: usageSnapshot(93, 88),
  spent: usageSnapshot(100, 96),
  stale: usageSnapshot(42, 68, { stale: true }),
  'no data': usageSnapshot(null, null),
  'login required': usageSnapshot(null, null, { status: 'auth' }),
  'rate limited': usageSnapshot(null, null, { status: 'rateLimited' }),
};

const barsTiles = Object.entries(USAGE_STATES)
  .map(([name, snapshot]) => tile(name, [renderBars(snapshot)], 0))
  .join('\n');

const gaugeTiles = Object.entries(USAGE_STATES)
  .map(([name, snapshot]) =>
    tile(name, [renderGauge(snapshot, { window: 'session', resetInfo: 'dateTime' }, USAGE_NOW)], 0),
  )
  .join('\n');

/** The reset line is the only thing that moves the ring, so it gets its own row. */
const resetTiles = ['none', 'dateTime', 'countdown', 'both']
  .map((resetInfo) =>
    tile(
      resetInfo,
      [renderGauge(USAGE_STATES.warming, { window: 'weekly', resetInfo }, USAGE_NOW)],
      0,
    ),
  )
  .join('\n');

/** Every background the setting offers, on both faces. */
const backgroundTiles = ['transparent', 'blue', 'gray']
  .flatMap((background) => [
    tile(`bars / ${background}`, [renderBars(USAGE_STATES.warming, { background })], 0),
    tile(
      `ring / ${background}`,
      [renderGauge(USAGE_STATES.warming, { background, window: 'session', resetInfo: 'countdown' }, USAGE_NOW)],
      0,
    ),
  ])
  .join('\n');

/* ---------------------------------------------------------------- page ---- */

const page = `<!doctype html>
<meta charset="utf-8">
<title>Claude Agents key states</title>
<style>
  body { margin:0; padding:40px; background:#101018; color:#e6e8ef;
         font:14px/1.5 system-ui, sans-serif; }
  h1 { font-size:20px; margin:0 0 8px; }
  p.note { color:#8b90a2; margin:0 0 28px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em;
       color:#8b90a2; margin:40px 0 18px; border-top:1px solid #262631; padding-top:16px; }
  .grid { display:flex; flex-wrap:wrap; gap:24px; }
  figure { margin:0; text-align:center; }
  .key { position:relative; width:144px; height:144px; border-radius:14px; overflow:hidden; }
  .key svg { display:block; width:100%; height:auto; }
  .flip .fr { position:absolute; inset:0; opacity:0; }
  figcaption { margin-top:9px; color:#8b90a2; font-size:12px; }
  @media (prefers-reduced-motion: reduce) {
    .flip .fr { animation:none !important; opacity:0; }
    .flip .fr:first-child { opacity:1; }
  }${flipCss}
</style>
<h1>Claude Agents &mdash; key states</h1>
<p class="note">
  Animated tiles flip through the frames the plugin really pushes:
  ${SPIN_FRAMES} at ${SPIN_FRAME_MS}ms for the ring, and Clawd's chosen move at its own pace.
  Both scale with the speed setting.
</p>

<h2>Ring</h2>
<div class="grid">
${ringTiles}
</div>

<h2>Ring thickness</h2>
<div class="grid">
${thicknessTiles}
</div>

<h2>Claude mark</h2>
<div class="grid">
${markTiles}
</div>

<h2>Clawd</h2>
<div class="grid">
${clawdTiles}
</div>

<h2>Clawd's moves</h2>
<div class="grid">
${moveTiles}
</div>

<h2>Speed (the wiggle)</h2>
<div class="grid">
${speedTiles}
</div>

<h2>Usage &mdash; both windows</h2>
<div class="grid">
${barsTiles}
</div>

<h2>Usage &mdash; one window</h2>
<div class="grid">
${gaugeTiles}
</div>

<h2>Usage &mdash; reset line</h2>
<div class="grid">
${resetTiles}
</div>

<h2>Usage &mdash; backgrounds</h2>
<div class="grid">
${backgroundTiles}
</div>
`;

writeFileSync(join(OUT, 'index.html'), page);
console.log(`wrote ${join(OUT, 'index.html')}`);
