/**
 * Clawd's two seconds of celebration, for when an agent finishes its work.
 *
 * He jumps -- Claude Code's own DANCE, so the hop is the one Clawd already
 * knows -- while blowing a paper party horn that unrolls and rolls back up,
 * and the key rains confetti over him. Then the burst simply stops and the key
 * goes back to drawing whatever is actually happening; nothing here touches
 * that state, it only sits in front of it for PARTY_MS.
 *
 * As everywhere else on these keys, the motion is a run of pre-rendered frames
 * pushed one at a time (see canvas.js): the SVG itself never animates. Unlike
 * the other moves, though, the burst is a fixed number of frames at a fixed
 * interval: the speed setting cannot be allowed to stretch or squeeze it,
 * because "two seconds" is the point of it.
 *
 * What the speed setting does move is Clawd himself. Every frame here is a
 * moment in time rather than a step in a sequence, so the hop and the horn are
 * read off the clock at whatever pace the key is set to -- exactly the pace the
 * jump would run at as an ordinary move -- while the confetti and the two
 * seconds go their own way.
 */
import { SIZE, toDataUri } from './canvas.js';
import { ANIMATIONS, CLAWD_BODY, DANCE, LAYOUT, renderClawd } from './clawd.js';
import { speedFactor } from './settings.js';

/** How long a celebration lasts, and how often it pushes a frame. */
export const PARTY_MS = 2000;
export const PARTY_FRAME_MS = 50;
const FRAMES = PARTY_MS / PARTY_FRAME_MS;

/**
 * How long Clawd holds one pose of the jump, at the key's chosen speed. This is
 * the jump's own interval whichever move the key is set to: the party is always
 * the jump, so 'Wiggle' and 'Claw wave' change nothing here -- only 'Speed'
 * does. Floored the same way clawdFrameMs is, so 'Frantic' cannot ask for a
 * pose faster than anything could draw one.
 */
const poseMs = (settings) =>
  Math.max(20, Math.round(ANIMATIONS.jump.ms * speedFactor(settings.speed)));

/**
 * The one frame the burst comes down to when the key is set not to animate:
 * mid-jump, horn out, confetti already spread across the key. Chosen rather
 * than computed -- it is the moment 700ms in that catches all three at once.
 * A still frame has no speed, so it is always drawn at the ordinary one.
 */
const PEAK_FRAME = 14;

const round = (value) => Math.round(value * 10) / 10;

/* ------------------------------------------------------------- confetti ---- */

/**
 * Party colours: Clawd's own, then a spread that stays legible against every
 * background the key offers -- including a transparent one, over whatever the
 * deck itself is showing. None of them is a horn colour, so a piece of confetti
 * in front of the horn stays a piece of confetti.
 */
const CONFETTI = ['#d77757', '#fbbf24', '#5eead4', '#a78bfa', '#fb7185', '#60a5fa', '#f8fafc'];

/**
 * A fixed seed, deliberately: every burst is the same burst. That is what lets
 * the frames be rendered once and cached, and it makes the whole thing a pure
 * function of its settings the way every other face here is.
 */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * The pieces, decided once at load. Each falls at its own pace from its own
 * moment, swaying and turning as it goes, so the rain never reads as a grid
 * coming down.
 */
const PIECES = (() => {
  const next = random(0x5eed17);
  return Array.from({ length: 26 }, (_, i) => ({
    x: 6 + next() * (SIZE - 12),
    // Staggered starts: the burst opens with a handful and keeps going rather
    // than dumping everything in frame one.
    delay: Math.floor(next() * 13),
    fall: 4.5 + next() * 3,
    sway: 3 + next() * 7,
    swayRate: 0.22 + next() * 0.3,
    size: 4 + next() * 3,
    // Below 1 the piece is a streamer rather than a square.
    ratio: 0.45 + next() * 0.85,
    angle: next() * Math.PI,
    spin: (next() - 0.5) * 0.9,
    color: CONFETTI[i % CONFETTI.length],
  }));
})();

/**
 * One piece: a rectangle turned by `angle`, written out as an absolute path.
 * A transform would say it in a third of the characters, but Stream Deck's
 * rasteriser is not to be trusted with one -- see canvas.js.
 */
function piece(cx, cy, w, h, angle, color) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ]
    .map(([x, y]) => `${round(cx + x * cos - y * sin)} ${round(cy + x * sin + y * cos)}`)
    .join(' L ');
  return `<path d="M ${points} Z" fill="${color}"/>`;
}

/** Every piece that is in the air on this frame. */
function confetti(t) {
  let out = '';
  for (const p of PIECES) {
    const age = t - p.delay;
    if (age < 0) continue;
    // Starts above the key, so pieces fall in rather than appearing.
    const y = -10 + age * p.fall;
    if (y > SIZE + 10) continue;
    out += piece(
      p.x + Math.sin(age * p.swayRate) * p.sway,
      y,
      p.size,
      p.size * p.ratio,
      p.angle + age * p.spin,
      p.color,
    );
  }
  return out;
}

/* ----------------------------------------------------------------- horn ---- */

const HORN_TUBE = '#f4b942';
const HORN_TIP = '#f87171';
const HORN_MOUTH = '#c98a2e';

/** Out to the right and a little up: far enough to read, short enough to fit. */
const DIRECTION = { x: 0.94, y: -0.34 };
const ACROSS = { x: -DIRECTION.y, y: DIRECTION.x };
const HORN_MAX = 30;
/**
 * One blow, in poses of the jump rather than in milliseconds: the horn keeps
 * time with Clawd, so slowing him down draws the blow out with him instead of
 * leaving him hopping in slow motion against a horn going at full tilt.
 */
const BLOW_POSES = 8;

const along = (x, y, distance) => ({
  x: x + DIRECTION.x * distance,
  y: y + DIRECTION.y * distance,
});

/** How far the horn is unrolled at this moment: out, back, and again. */
function hornLength(elapsed, pose) {
  const blow = BLOW_POSES * pose;
  return HORN_MAX * Math.sin((Math.PI * (elapsed % blow)) / blow);
}

/** A tapering section of the tube, between two distances along it. */
function band(x, y, from, to, halfFrom, halfTo, color) {
  const a = along(x, y, from);
  const b = along(x, y, to);
  const points = [
    [a.x + ACROSS.x * halfFrom, a.y + ACROSS.y * halfFrom],
    [b.x + ACROSS.x * halfTo, b.y + ACROSS.y * halfTo],
    [b.x - ACROSS.x * halfTo, b.y - ACROSS.y * halfTo],
    [a.x - ACROSS.x * halfFrom, a.y - ACROSS.y * halfFrom],
  ]
    .map(([px, py]) => `${round(px)} ${round(py)}`)
    .join(' L ');
  return `<path d="M ${points} Z" fill="${color}"/>`;
}

/**
 * The horn, at Clawd's mouth. `dy` is the frame's own crouch: the jump drops
 * the sprite a whole cell, and the horn has to go down with it.
 */
function horn(elapsed, pose, dy) {
  const x = LAYOUT.ORIGIN_X + 7.7 * LAYOUT.CELL_W;
  const y = LAYOUT.ORIGIN_Y + 0.95 * LAYOUT.CELL_H + dy;
  const mouthpiece = `<circle cx="${round(x)}" cy="${round(y)}" r="3.6" fill="${HORN_MOUTH}"/>`;
  const length = hornLength(elapsed, pose);

  // Between blows it is a rolled-up coil sitting at his mouth.
  if (length < 5) {
    const curl = along(x, y, 5);
    return (
      `<circle cx="${round(curl.x)}" cy="${round(curl.y)}" r="4.4" fill="none" ` +
      `stroke="${HORN_TUBE}" stroke-width="2.6"/>` +
      mouthpiece
    );
  }

  // It widens as it goes out, so a full blow flares and a half one does not.
  const half = (distance) => 3 + (2.6 * distance) / HORN_MAX;
  const neck = length * 0.72;
  return (
    band(x, y, 0, neck, half(0), half(neck), HORN_TUBE) +
    band(x, y, neck, length, half(neck), half(length), HORN_TIP) +
    mouthpiece
  );
}

/* --------------------------------------------------------------- frames ---- */

/**
 * Frame `t` of a burst running at `pose` milliseconds to the jump's pose.
 *
 * The hop is sampled from the clock rather than stepped through, so a slow
 * setting holds each pose across several frames and a fast one passes several
 * poses between frames. The confetti still counts in frames: it is falling on
 * the key, not dancing on it, and the two seconds it takes to clear are the
 * same two seconds whatever Clawd is doing underneath.
 */
function renderParty(t, pose, background) {
  const elapsed = t * PARTY_FRAME_MS;
  const frame = DANCE[Math.floor(elapsed / pose) % DANCE.length];
  return renderClawd(frame, {
    body: CLAWD_BODY,
    background,
    // Drawn over Clawd: the horn is in front of his face, and confetti falls
    // in front of all of it.
    extras: horn(elapsed, pose, (frame.offset ?? 0) * LAYOUT.CELL_H) + confetti(t),
  });
}

const frameCache = new Map();

/**
 * The whole burst, in order -- or the single peak frame when the key is set not
 * to animate, so that a deck the user has asked to hold still still marks the
 * moment instead of flickering through a jump.
 */
export function partyFrames(settings = {}) {
  const background = settings.background ?? 'transparent';
  const still = settings.animate === false;
  // A still frame has no pace, so every speed shares the one image.
  const pose = still ? ANIMATIONS.jump.ms : poseMs(settings);
  const cacheKey = `${background}|${still ? 'still' : pose}`;

  let frames = frameCache.get(cacheKey);
  if (!frames) {
    const order = still ? [PEAK_FRAME] : Array.from({ length: FRAMES }, (_, t) => t);
    frames = order.map((t) => toDataUri(renderParty(t, pose, background)));
    frameCache.set(cacheKey, frames);
  }
  return frames;
}

/**
 * How often the burst pushes a frame. Fixed, unlike every other face here: the
 * speed setting moves Clawd within the two seconds (see poseMs), it does not
 * get to decide how long the two seconds are.
 */
export const partyFrameMs = () => PARTY_FRAME_MS;
