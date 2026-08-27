/**
 * The single-window face: one window, large, with a ring and its reset time.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * The ring is open at the bottom, and the window's name sits in the gap -- so
 * the key says which limit it is showing without spending a line on it.
 */
import { CENTER, SIZE, svgDocument, toDataUri } from '../canvas.js';
import { DEFAULT_THRESHOLDS, statusForPercent } from './snapshot.js';
import { TEXT_MUTED, TRACK, accentFor, isFailure, messageFace, messageLines, staleDot, text } from './palette.js';
import { formatCountdown, formatResetTime } from './time.js';

const RADIUS = 46;
const STROKE = 11;

/** 135 degrees to 45, clockwise over the top: three quarters of a turn. */
const START_DEG = 135;
const SWEEP_DEG = 270;

const WINDOW_LABELS = { session: '5H', weekly: '7D' };

function polar(cx, cy, radius, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: (cx + radius * Math.cos(radians)).toFixed(2),
    y: (cy + radius * Math.sin(radians)).toFixed(2),
  };
}

/** A stroked arc of `sweep` degrees clockwise from `start`. */
function arc(cx, cy, radius, start, sweep, color) {
  if (sweep <= 0) return '';
  const from = polar(cx, cy, radius, start);
  const to = polar(cx, cy, radius, start + sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  return (
    `<path d="M ${from.x} ${from.y} A ${radius} ${radius} 0 ${largeArc} 1 ${to.x} ${to.y}" ` +
    `fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`
  );
}

/**
 * The 0, 1 or 2 lines under the ring. No "resets" prefix: on a key the context
 * is obvious, and the word costs a third of the width.
 */
function resetLines(window, settings, now) {
  const lines = [];
  const { resetInfo, dateFormat } = settings;

  if (resetInfo === 'dateTime' || resetInfo === 'both') {
    const at = formatResetTime(window.resetAt, dateFormat);
    if (at) lines.push(at);
  }
  if (resetInfo === 'countdown' || resetInfo === 'both') {
    const left = formatCountdown(window.resetAt, now);
    if (left) lines.push(left === 'now' ? 'now' : `in ${left}`);
  }
  return lines;
}

/**
 * @param {object} snapshot A usage snapshot; see snapshot.js.
 * @param {object} [settings] window, resetInfo, dateFormat, background.
 * @param {Date} [now] The clock the countdown is measured against.
 */
export function renderGauge(snapshot, settings = {}, now = new Date()) {
  const { background, window: which = 'session' } = settings;
  const label = WINDOW_LABELS[which] ?? WINDOW_LABELS.session;

  if (isFailure(snapshot.status)) {
    return messageFace(messageLines(snapshot.status), snapshot.status, background);
  }

  const usage = which === 'weekly' ? snapshot.weekly : snapshot.session;
  if (usage.usedPercent === null) return messageFace(['Claude', 'No Data'], 'error', background);

  const percent = Math.max(0, Math.min(100, Math.round(usage.usedPercent)));
  const accent = accentFor(statusForPercent(percent, snapshot.thresholds ?? DEFAULT_THRESHOLDS));
  const lines = resetLines(usage, settings, now);

  // The ring rides up as lines appear beneath it, so the whole face stays
  // optically centred instead of drifting to the top of the key.
  const cy = lines.length === 2 ? 60 : lines.length === 1 ? 66 : 74;
  // Three digits need to fit inside the ring, so 100% gets a smaller face.
  const size = percent >= 100 ? 26 : 32;

  const captionY = SIZE - (lines.length === 2 ? 26 : 12);
  const caption = lines
    .map((line, i) =>
      text(CENTER, captionY + i * 15, line, {
        size: 13,
        weight: '600',
        fill: TEXT_MUTED,
        anchor: 'middle',
      }),
    )
    .join('');

  return svgDocument(
    arc(CENTER, cy, RADIUS, START_DEG, SWEEP_DEG, TRACK) +
      arc(CENTER, cy, RADIUS, START_DEG, (SWEEP_DEG * percent) / 100, accent) +
      // Arial's cap height is ~0.716em, so this baseline centres the digits on
      // the ring -- the same trick render.js uses for the agent count.
      `<text x="${CENTER}" y="${Math.round(cy + 0.358 * size)}" text-anchor="middle" ` +
      `font-family="Arial, Helvetica, 'DejaVu Sans', sans-serif" font-size="${size}" ` +
      `font-weight="bold" fill="${accent}">${percent}` +
      `<tspan font-size="${Math.round(size * 0.5)}">%</tspan></text>` +
      // The window's name sits in the ring's open bottom.
      text(CENTER, cy + RADIUS - 1, label, { size: 14, fill: TEXT_MUTED, anchor: 'middle' }) +
      caption +
      (snapshot.stale ? staleDot() : ''),
    background,
  );
}

/** One frame: nothing on this face moves. See barsFrames. */
export function gaugeFrames(snapshot, settings = {}, now = new Date()) {
  return [toDataUri(renderGauge(snapshot, settings, now))];
}
