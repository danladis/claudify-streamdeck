/**
 * The ring face: a ring, a number, and a colour. Nothing else, unless the
 * Claude mark is switched on -- and that sits in the corner, clear of the ring.
 *
 * See canvas.js for why animation is a list of frames rather than anything
 * inside the SVG.
 */
import { CENTER, CORNER, escapeXml, svgDocument, toDataUri } from './canvas.js';
import { claudeMark } from './claudemark.js';
import { speedFactor } from './settings.js';

const RING_R = 50;

/** Ring stroke widths, thinnest to thickest. 'normal' is the default. */
export const THICKNESS = {
  hairline: 3.5,
  thin: 4.5,
  normal: 5.5,
  thick: 7,
  heavy: 9,
};

export const strokeFor = (name) => THICKNESS[name] ?? THICKNESS.normal;

/** How much of the ring the spinner covers. */
const SPIN_ARC = 0.308;
/** One revolution, and how often a frame is pushed. 15 frames per turn. */
export const SPIN_PERIOD_MS = 1200;
export const SPIN_FRAME_MS = 80;
const SPIN_FRAMES = Math.round(SPIN_PERIOD_MS / SPIN_FRAME_MS);

/**
 * How often the ring key pushes a frame, once the speed setting is applied. The
 * frame count is fixed, so a faster frame is a faster revolution.
 */
export function spinFrameMs(settings = {}) {
  return Math.max(20, Math.round(SPIN_FRAME_MS * speedFactor(settings.speed)));
}

const FONT = "Arial, Helvetica, 'DejaVu Sans', sans-serif";

const RING_TRACK = '#242438';

const ACCENTS = {
  working: '#4ade80',
  blocked: '#fbbf24',
  idle: '#dfe3ee',
  empty: '#4b5563',
  error: '#f87171',
};

function digitSize(text) {
  if (text.length <= 1) return 62;
  if (text.length === 2) return 56;
  if (text.length === 3) return 42;
  return 27;
}

/** Point on the ring, measured in turns clockwise from 12 o'clock. */
function pointAt(turn) {
  const angle = turn * Math.PI * 2;
  return {
    x: (CENTER + RING_R * Math.sin(angle)).toFixed(2),
    y: (CENTER - RING_R * Math.cos(angle)).toFixed(2),
  };
}

/** A stroked arc of `length` turns starting at `start`, clockwise. */
function arc(start, length, color, stroke) {
  if (length <= 0) return '';
  if (length >= 0.999) {
    return `<circle cx="${CENTER}" cy="${CENTER}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`;
  }
  const from = pointAt(start);
  const to = pointAt(start + length);
  const largeArc = length > 0.5 ? 1 : 0;
  return (
    `<path d="M ${from.x} ${from.y} A ${RING_R} ${RING_R} 0 ${largeArc} 1 ${to.x} ${to.y}" ` +
    `fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
  );
}

function number(value, color) {
  const size = digitSize(value);
  // Arial's cap height is ~0.716em, so this baseline puts the digits' optical
  // centre on the centre of the ring.
  const baseline = Math.round(CENTER + 0.358 * size);
  return (
    `<text x="${CENTER}" y="${baseline}" text-anchor="middle" font-family="${FONT}" ` +
    `font-size="${size}" font-weight="bold" fill="${color}">${escapeXml(value)}</text>`
  );
}

/**
 * @param {object} view
 * @param {'working'|'blocked'|'idle'|'empty'|'error'} view.state
 * @param {string} view.value  The agent count, or "!" when unreadable.
 * @param {boolean} [view.spin] Whether this face animates.
 * @param {number} [phase] Rotation of the spinner, in turns.
 * @param {{thickness?: string, showMark?: boolean, background?: string}} [options]
 */
export function renderKey(view, phase = 0, options = {}) {
  const accent = ACCENTS[view.state] ?? ACCENTS.idle;
  const stroke = strokeFor(options.thickness);

  let ring;
  if (view.spin) ring = arc(phase % 1, SPIN_ARC, accent, stroke);
  // A still ring means stopped, a moving one means working. Amber does not
  // spin: an agent waiting on you is not making progress.
  else if (view.state === 'blocked' || view.state === 'error') ring = arc(0, 1, accent, stroke);
  else ring = '';

  return svgDocument(
    `<circle cx="${CENTER}" cy="${CENTER}" r="${RING_R}" fill="none" stroke="${RING_TRACK}" stroke-width="${stroke}"/>` +
      ring +
      number(view.value, accent) +
      (options.showMark ? claudeMark(CORNER.x, CORNER.y, CORNER.r) : ''),
    options.background,
  );
}

/** Map a summary from classify.js onto the key face. */
export function viewFor(summary) {
  if (!summary.ok) {
    // Skipped, not broken: don't raise a red flag over a poll that
    // deliberately declined to wake a sleeping WSL distro.
    if (summary.error === 'wsl-asleep') return { state: 'empty', value: '0' };
    return { state: 'error', value: '!' };
  }

  const { total, working, blocked } = summary;

  // Blocked wins: an agent waiting on you is the one fact worth interrupting for.
  if (blocked > 0) return { state: 'blocked', value: String(total) };
  if (working > 0) return { state: 'working', value: String(total), spin: true };
  if (total === 0) return { state: 'empty', value: '0' };
  return { state: 'idle', value: String(total) };
}

const frameCache = new Map();

/**
 * Every frame this face needs, in order: one image for a still face, a full
 * revolution's worth for a spinning one. Frames depend only on the state, the
 * count and the look, so they are rendered once and replayed.
 */
export function ringFrames(summary, settings = {}) {
  const view = viewFor(summary);
  const spin = Boolean(view.spin) && settings.animate !== false;
  const thickness = settings.thickness ?? 'normal';
  const showMark = settings.showMark !== false;
  const background = settings.background ?? 'transparent';
  const cacheKey = `${view.state}|${view.value}|${spin ? 1 : 0}|${thickness}|${showMark ? 1 : 0}|${background}`;

  let frames = frameCache.get(cacheKey);
  if (!frames) {
    const options = { thickness, showMark, background };
    frames = spin
      ? Array.from({ length: SPIN_FRAMES }, (_, i) =>
          toDataUri(renderKey(view, i / SPIN_FRAMES, options)),
        )
      : [toDataUri(renderKey(view, 0, options))];
    frameCache.set(cacheKey, frames);
  }
  return frames;
}

export { toDataUri };
