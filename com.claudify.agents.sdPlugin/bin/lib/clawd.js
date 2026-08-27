/**
 * Clawd, the Claude Code mascot, moving on a key.
 *
 * The pose table, the colours and the block-quadrant drawing below are Claude
 * Code's own: it draws Clawd as three rows of Unicode quadrant blocks in
 * clawd_body over clawd_background. Rather than set that text in a font Stream
 * Deck may not have, each block character is decoded into the quadrants it
 * fills and drawn as rects -- exact at any size, and independent of font
 * coverage.
 *
 * What Clawd *does* with those poses is a setting: he is a crab, so he wiggles
 * and scuttles sideways by default, and Claude Code's own vertical jump is one
 * of the choices rather than the only one. See ANIMATIONS.
 */
import { CENTER, SIZE, cornerDot, svgDocument, toDataUri } from './canvas.js';
import { speedFactor } from './settings.js';

/** From Claude Code's theme: clawd_body rgb(215,119,87), clawd_background black. */
export const CLAWD_BODY = '#d77757';
export const CLAWD_BACKGROUND = '#000000';
/** Clawd, but asleep. */
const CLAWD_DIM = '#6b5147';
const POOF = '#5c6070';
const FONT = "Arial, Helvetica, 'DejaVu Sans', sans-serif";

/** Claude Code's frame interval, and the base for the jump. */
export const CLAWD_FRAME_MS = 60;

/**
 * Claude Code's pose table verbatim, plus the two single-claw poses the wave
 * needs. Each row is drawn as segments: the "E" segment carries the background
 * fill that shapes Clawd's face, the L/R segments are body-coloured only.
 *
 * A raised claw pulls that side of the body in, which is why arms-up drops both
 * of row 2's outer blocks and each single claw drops only its own.
 */
const POSES = {
  default: { r1L: ' ▐', r1E: '▛███▛█', r1R: '', r2L: '▝▜', r2R: '█▀' },
  'look-left': { r1L: ' ▐', r1E: '▟███▟█', r1R: '', r2L: '▝▜', r2R: '█▀' },
  'look-right': { r1L: ' ▐', r1E: '█▟███▟', r1R: '', r2L: '▝▜', r2R: '█▀' },
  'arms-up': { r1L: '▗▟', r1E: '▛███▛█', r1R: '▄', r2L: ' ▜', r2R: '█▘' },
  'claw-left': { r1L: '▗▟', r1E: '▛███▛█', r1R: '', r2L: ' ▜', r2R: '█▀' },
  'claw-right': { r1L: ' ▐', r1E: '▛███▛█', r1R: '▙', r2L: '▝▜', r2R: '█▘' },
  // A glance sideways. Claude Code's look-left/look-right move the eyes to the
  // top of the head, where they open onto the shell's edge and read as a bite
  // taken out of it; at key size the eyes have to stay enclosed, so these move
  // them one quadrant along the row they already sit in.
  'peek-left': { r1L: ' ▐', r1E: '▜███▜█', r1R: '', r2L: '▝▜', r2R: '█▀' },
  'peek-right': { r1L: ' ▐', r1E: '█▜███▜', r1R: '', r2L: '▝▜', r2R: '█▀' },
  // Idling: a plain, notch-free face -- sleepEyes() draws the closed eyes on
  // top, since the quadrant grid is too coarse for a thin dash.
  sleep: { r1L: ' ▐', r1E: '██████', r1R: '', r2L: '▝▜', r2R: '█▀' },
};

/** Row 2 is the same for every pose: the body block between the two sides. */
const BODY_BLOCK = '█████';

/** Which of the four quadrants each block character fills: TL 8, TR 4, BL 2, BR 1. */
const QUADRANTS = {
  ' ': 0b0000,
  '█': 0b1111, // full block
  '▀': 0b1100, // upper half
  '▄': 0b0011, // lower half
  '▌': 0b1010, // left half
  '▐': 0b0101, // right half
  '▖': 0b0010, // lower left
  '▗': 0b0001, // lower right
  '▘': 0b1000, // upper left
  '▙': 0b1011, // upper left + lower left + lower right
  '▚': 0b1001, // upper left + lower right
  '▛': 0b1110, // upper left + upper right + lower left
  '▜': 0b1101, // upper left + upper right + lower right
  '▝': 0b0100, // upper right
  '▞': 0b0110, // upper right + lower left
  '▟': 0b0111, // upper right + lower left + lower right
};

/* --------------------------------------------------------------- layout ---- */

/** Character cells: 9 wide, 3 tall -- head/arms, body, legs. */
const COLUMNS = 9;
const ROWS = 3;
const CELL_W = 12;
// Terminal cells are about twice as tall as they are wide; keeping that ratio
// is what makes the sprite read as Clawd rather than a squashed copy.
const CELL_H = 24;

const ORIGIN_X = (SIZE - COLUMNS * CELL_W) / 2;
// The legs are drawn short -- '▝' fills only a cell's top half -- so the sprite
// at rest is visually 2.5 cells tall, not 3; centring on the full 3 would sit
// Clawd noticeably high. Centres him at rest (offset 0); the crouch (offset 1)
// then dips a further cell below that, needing no row reserved above it.
const SPRITE_H = 2 * CELL_H + CELL_H / 2;
const ORIGIN_Y = (SIZE - SPRITE_H) / 2;

/**
 * Every sideways move is a whole quadrant, never less: half a cell is 6px, and
 * anything finer would put the sprite off its own pixel grid and blur it.
 */
const STEP = CELL_W / 2;
/** As far as Clawd can travel and still sit inside the card. */
const REACH = 2 * STEP;

/**
 * Row 3 is the legs: one character per column, so a stance can put a leg
 * anywhere across the sprite's width. Written as the columns the legs stand in
 * rather than as a row of glyphs -- four legs are easier to place than to count.
 * '▝' is a short leg, '▐' a long one.
 */
const legs = (columns, glyph = '▝') =>
  Array.from({ length: COLUMNS }, (_, column) => (columns.includes(column) ? glyph : ' ')).join('');

/** `tuck` is Claude Code's own stance; the rest are Clawd's shuffle. */
const STANCES = {
  tuck: legs([2, 3, 5, 6]),
  splay: legs([1, 3, 5, 7]),
  wide: legs([0, 3, 5, 8]),
  tall: legs([2, 3, 5, 6], '▐'),
  'stride-left': legs([1, 2, 5, 6]),
  'stride-right': legs([2, 3, 6, 7]),
};

/* ------------------------------------------------------------ sequences ---- */

const frame = (pose, feet, { x = 0, feetX = 0, offset = 0, poof = null } = {}) => ({
  pose,
  feet,
  x,
  feetX,
  offset,
  ...(poof ? { poof } : {}),
});

const hold = (pose, offset, count, x = 0) =>
  Array.from({ length: count }, () => ({ pose, offset, x, feet: 'tuck', feetX: 0 }));

/** Claude Code's crouch: two frames low, with a puff either side. */
const crouch = (x = 0) => [
  { pose: 'default', offset: 1, x, feet: 'tuck', feetX: 0, poof: 'dot' },
  { pose: 'default', offset: 1, x, feet: 'tuck', feetX: 0, poof: 'wave' },
];

/**
 * Claude Code's "jump" sequence: crouch with a puff, spring up with arms up,
 * land -- twice. Twelve frames, and it loops seamlessly.
 */
export const DANCE = [
  ...crouch(),
  ...hold('arms-up', 0, 3),
  ...hold('default', 0, 1),
  ...crouch(),
  ...hold('arms-up', 0, 3),
  ...hold('default', 0, 1),
];

/**
 * The wiggle: Clawd rocks a quadrant either way, dwelling at each end, while
 * his legs shuffle between spread and tucked on every frame and slide half a
 * cell under him. Six frames, so the rock is symmetrical and seamless.
 */
const WIGGLE = [
  frame('peek-left', 'splay', { x: -STEP }),
  frame('default', 'tuck', { x: 0, feetX: STEP }),
  frame('peek-right', 'splay', { x: STEP }),
  frame('peek-right', 'tuck', { x: STEP, feetX: -STEP }),
  frame('default', 'splay', { x: 0 }),
  frame('peek-left', 'tuck', { x: -STEP, feetX: STEP }),
];

/**
 * The scuttle: sideways across the key and back, the way a crab actually
 * travels -- weight shifting onto the trailing legs, and a look in the
 * direction of travel.
 */
const SCUTTLE = [
  frame('peek-right', 'stride-left', { x: 0, feetX: -STEP }),
  frame('peek-right', 'splay', { x: STEP }),
  frame('peek-right', 'stride-left', { x: REACH, feetX: -STEP }),
  frame('peek-right', 'wide', { x: REACH }),
  frame('default', 'splay', { x: STEP }),
  frame('peek-left', 'stride-right', { x: 0, feetX: STEP }),
  frame('peek-left', 'splay', { x: -STEP }),
  frame('peek-left', 'stride-right', { x: -REACH, feetX: STEP }),
  frame('peek-left', 'wide', { x: -REACH }),
  frame('default', 'splay', { x: -STEP }),
];

/** The wave: planted wide, claws raised one after the other. */
const WAVE = [
  frame('claw-left', 'wide', { x: -STEP }),
  frame('claw-left', 'tall', { x: -STEP }),
  frame('default', 'tuck', { x: 0 }),
  frame('claw-right', 'wide', { x: STEP }),
  frame('claw-right', 'tall', { x: STEP }),
  frame('default', 'tuck', { x: 0 }),
];

/** A shimmy in place: no travel, just the legs and claws going at double time. */
const SHIMMY = [
  frame('default', 'splay', { x: 0 }),
  frame('claw-left', 'tuck', { x: 0, feetX: -STEP }),
  frame('default', 'wide', { x: 0 }),
  frame('claw-right', 'tuck', { x: 0, feetX: STEP }),
];

/**
 * What Clawd can be set to do while agents work. `ms` is that move's own
 * unhurried pace; the speed setting scales it.
 */
export const ANIMATIONS = {
  wiggle: { sequence: WIGGLE, ms: 70 },
  scuttle: { sequence: SCUTTLE, ms: 80 },
  shimmy: { sequence: SHIMMY, ms: 90 },
  wave: { sequence: WAVE, ms: 110 },
  jump: { sequence: DANCE, ms: CLAWD_FRAME_MS },
};

export const DEFAULT_ANIMATION = 'wiggle';

/** The real moves 'random' can land on -- everything ANIMATIONS actually names. */
const MOVE_NAMES = Object.keys(ANIMATIONS);

/**
 * A concrete move for the 'random' setting to resolve to. `exclude` keeps a
 * fresh pick from repeating the move Clawd just finished, so back-to-back
 * choices always read as a change.
 */
export function pickRandomMove(exclude) {
  const pool = exclude ? MOVE_NAMES.filter((name) => name !== exclude) : MOVE_NAMES;
  return pool[Math.floor(Math.random() * pool.length)] ?? MOVE_NAMES[0];
}

const animationFor = (settings = {}) =>
  ANIMATIONS[settings.clawdAnimation] ?? ANIMATIONS[DEFAULT_ANIMATION];

/** How often the mascot key pushes a frame, once the speed setting is applied. */
export function clawdFrameMs(settings = {}) {
  return Math.max(20, Math.round(animationFor(settings).ms * speedFactor(settings.speed)));
}

const STILL = [{ pose: 'default', offset: 0, x: 0, feet: 'tuck', feetX: 0 }];
/** Clawd at rest with his eyes closed, for the idle state. */
const SLEEP = [{ pose: 'sleep', offset: 0, x: 0, feet: 'tuck', feetX: 0 }];

/* -------------------------------------------------------------- drawing ---- */

function quadrants(character, x, y, color) {
  const bits = QUADRANTS[character];
  if (!bits) return '';

  const w = CELL_W / 2;
  const h = CELL_H / 2;
  let out = '';
  // All coordinates land on integers, so abutting quadrants leave no seam.
  if (bits & 0b1000) out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
  if (bits & 0b0100) out += `<rect x="${x + w}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
  if (bits & 0b0010) out += `<rect x="${x}" y="${y + h}" width="${w}" height="${h}" fill="${color}"/>`;
  if (bits & 0b0001) out += `<rect x="${x + w}" y="${y + h}" width="${w}" height="${h}" fill="${color}"/>`;
  return out;
}

/**
 * Draw one run of characters starting at a cell. `background` fills the whole
 * cell first, which is how Clawd's face is shaped.
 */
function segment(text, column, row, offsetX, body, background) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const x = ORIGIN_X + (column + i) * CELL_W + offsetX;
    const y = ORIGIN_Y + row * CELL_H;
    if (background) {
      out += `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${background}"/>`;
    }
    out += quadrants(text[i], x, y, body);
  }
  return out;
}

/** The puffs Claude Code shows either side of Clawd as it lands. */
function poof(kind) {
  const y = ORIGIN_Y + 2 * CELL_H + CELL_H / 2;
  const marks = [ORIGIN_X + CELL_W / 2, ORIGIN_X + (COLUMNS - 1) * CELL_W + CELL_W / 2];

  return marks
    .map((x) =>
      kind === 'dot'
        ? `<circle cx="${x}" cy="${y}" r="2.2" fill="${POOF}"/>`
        : `<path d="M ${x - 5} ${y} q 2.5 -3.5 5 0 q 2.5 3.5 5 0" fill="none" ` +
          `stroke="${POOF}" stroke-width="1.6" stroke-linecap="round"/>`,
    )
    .join('');
}

/**
 * Closed eyes for the sleep pose, drawn directly rather than through the
 * quadrant grid: its 6x12 quadrants are too coarse for a dash this thin, so
 * this paints straight over the face's solid fill instead.
 */
function sleepEyes(row, dx) {
  const w = 9;
  const h = 3;
  const y = ORIGIN_Y + row * CELL_H + CELL_H / 2 - h / 2 + 4;
  return [2, 6]
    .map((col) => ORIGIN_X + col * CELL_W + dx + (CELL_W - w) / 2)
    .map((x) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${CLAWD_BACKGROUND}"/>`)
    .join('');
}

/** The "zZ" Clawd shows above his head while idling, small z first, big Z above it. */
function sleepMark() {
  const x = ORIGIN_X + COLUMNS * CELL_W - 20;
  return (
    `<text x="${x}" y="40" font-family="${FONT}" font-size="10" font-weight="bold" fill="${POOF}">z</text>` +
    `<text x="${x + 12}" y="26" font-family="${FONT}" font-size="15" font-weight="bold" fill="${POOF}">Z</text>`
  );
}

/**
 * @param {{pose: string, offset?: number, x?: number, feet?: string, feetX?: number, poof?: string}} frame
 * @param {{body?: string, badge?: string, sleep?: boolean, background?: string}} [options]
 */
export function renderClawd(frame, { body = CLAWD_BODY, badge = null, sleep = false, background } = {}) {
  const pose = POSES[frame.pose] ?? POSES.default;
  const stance = STANCES[frame.feet] ?? STANCES.tuck;
  const row = frame.offset ?? 0;
  const dx = frame.x ?? 0;

  // Row 1: left arm, then the face block, then the right arm.
  let art = segment(pose.r1L, 0, row, dx, body);
  art += segment(pose.r1E, pose.r1L.length, row, dx, body, CLAWD_BACKGROUND);
  art += segment(pose.r1R, pose.r1L.length + pose.r1E.length, row, dx, body);

  // Row 2: body sides around the filled block.
  art += segment(pose.r2L, 0, row + 1, dx, body);
  art += segment(BODY_BLOCK, pose.r2L.length, row + 1, dx, body, CLAWD_BACKGROUND);
  art += segment(pose.r2R, pose.r2L.length + BODY_BLOCK.length, row + 1, dx, body);

  // Row 3: legs. They can slide under the body, which is the shuffle.
  art += segment(stance, 0, row + 2, dx + (frame.feetX ?? 0), body);

  if (frame.poof && row > 0) art += poof(frame.poof);
  if (badge) art += cornerDot(badge);
  if (sleep) art += sleepEyes(row, dx) + sleepMark();

  return svgDocument(art, background);
}

/* ----------------------------------------------------------------- face ---- */

const BADGES = { blocked: '#fbbf24', error: '#f87171' };

/** What Clawd is doing, given a summary from classify.js and the key's settings. */
export function clawdView(summary, settings = {}) {
  if (!summary.ok) {
    // Skipped, not broken: don't raise a red flag over a poll that
    // deliberately declined to wake a sleeping WSL distro.
    if (summary.error === 'wsl-asleep') return { sequence: STILL, body: CLAWD_DIM, badge: null, state: 'empty' };
    return { sequence: STILL, body: CLAWD_DIM, badge: BADGES.error, state: 'error' };
  }
  // Still means not progressing, the same as on the ring key -- so a blocked
  // agent stops the dance and raises a flag rather than changing Clawd's colour.
  if (summary.blocked > 0) return { sequence: STILL, body: CLAWD_BODY, badge: BADGES.blocked, state: 'blocked' };
  if (summary.working > 0) {
    return { sequence: animationFor(settings).sequence, body: CLAWD_BODY, badge: null, state: 'working' };
  }
  if (summary.total === 0) return { sequence: STILL, body: CLAWD_DIM, badge: null, state: 'empty' };
  // Nothing is working or blocked: every agent is just sitting there, so
  // Clawd naps -- eyes closed, a "zZ" over his head -- rather than idling
  // with the same open-eyed pose as an empty key.
  return { sequence: SLEEP, body: CLAWD_BODY, badge: null, state: 'idle', sleep: true };
}

const frameCache = new Map();

/** Every frame this face needs, in order. One image when Clawd is holding still. */
export function clawdFrames(summary, settings = {}) {
  const view = clawdView(summary, settings);
  const moving = view.sequence.length > 1 && settings.animate !== false;
  const move = ANIMATIONS[settings.clawdAnimation] ? settings.clawdAnimation : DEFAULT_ANIMATION;
  const background = settings.background ?? 'transparent';
  const cacheKey = `${view.state}|${moving ? move : 'still'}|${background}`;

  let frames = frameCache.get(cacheKey);
  if (!frames) {
    // A view's own sequence is already a single still frame unless it's a
    // working animation; only a working view with animation turned off needs
    // to fall back to the generic default-pose STILL instead of its (unused)
    // animated sequence.
    const sequence = moving ? view.sequence : view.sequence.length > 1 ? STILL : view.sequence;
    frames = sequence.map((frame) =>
      toDataUri(
        renderClawd(frame, { body: view.body, badge: view.badge, sleep: view.sleep, background }),
      ),
    );
    frameCache.set(cacheKey, frames);
  }
  return frames;
}
