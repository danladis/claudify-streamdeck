/**
 * The two-window face: 5H over 7D, each a percentage and a bar.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * Each bar is coloured by its own percentage rather than by the key's overall
 * status, so a nearly-spent 5-hour window shows orange without dragging the
 * weekly bar along with it.
 */
import { SIZE, svgDocument, toDataUri } from '../canvas.js';
import { statusForPercent } from './snapshot.js';
import { DEFAULT_THRESHOLDS } from './snapshot.js';
import {
  DIM_ACCENT,
  DIM_TEXT,
  TEXT,
  TRACK,
  accentFor,
  isDimmed,
  isFailure,
  messageFace,
  messageLines,
  text,
} from './palette.js';

const BAR = { x: 12, width: 120, height: 12, radius: 6 };

/** One row: label left, percentage right, bar beneath. */
function row(top, label, window, thresholds, dim) {
  const known = window.usedPercent !== null;
  const percent = known ? Math.max(0, Math.min(100, Math.round(window.usedPercent))) : 0;
  // Only a bar with something in it is ever painted, so an unknown window never
  // reaches for a colour: it draws its track and a dash and stops there.
  const accent = dim ? DIM_ACCENT : accentFor(statusForPercent(percent, thresholds));
  const ink = dim ? DIM_TEXT : TEXT;
  const barY = top + 34;

  return (
    text(BAR.x, top + 22, label, { size: 22, fill: ink }) +
    text(SIZE - BAR.x, top + 22, known ? `${percent}%` : '--', {
      size: 22,
      fill: ink,
      anchor: 'end',
    }) +
    `<rect x="${BAR.x}" y="${barY}" width="${BAR.width}" height="${BAR.height}" ` +
    `rx="${BAR.radius}" fill="${TRACK}"/>` +
    // A zero-width rounded rect still paints its corners, so it is left out
    // entirely rather than drawn as a stub of colour at 0%.
    (percent > 0
      ? `<rect x="${BAR.x}" y="${barY}" width="${Math.round((BAR.width * percent) / 100)}" ` +
        `height="${BAR.height}" rx="${BAR.radius}" fill="${accent}"/>`
      : '')
  );
}

/**
 * @param {object} snapshot A usage snapshot; see snapshot.js.
 * @param {{background?: string}} [options]
 */
export function renderBars(snapshot, options = {}) {
  const { background } = options;
  if (isFailure(snapshot.status)) return messageFace(messageLines(snapshot.status), snapshot.status, background);

  const dim = isDimmed(snapshot);

  // Reached 'ok' but with nothing in either window: the endpoint answered, and
  // said nothing useful. That is an error the user can act on (retry, re-login),
  // not two empty bars implying zero usage. A dimmed key is already saying that
  // its numbers are unconfirmed, so it keeps its shape and shows dashes.
  if (!dim && snapshot.session.usedPercent === null && snapshot.weekly.usedPercent === null) {
    return messageFace(['Claude', 'No Data'], 'error', background);
  }

  const thresholds = snapshot.thresholds ?? DEFAULT_THRESHOLDS;

  return svgDocument(
    row(8, '5H', snapshot.session, thresholds, dim) +
      // A 1px rect, not a <line>: canvas.js keeps the faces to rects, circles
      // and paths, and the repo's own rasteriser only understands those.
      `<rect x="${BAR.x}" y="72" width="${BAR.width}" height="1" fill="${TRACK}"/>` +
      row(80, '7D', snapshot.weekly, thresholds, dim),
    background,
  );
}

/**
 * The face as Stream Deck wants it. A list of one, because nothing here moves
 * -- the shape plugin.js already drives for the animated faces.
 */
export function barsFrames(snapshot, settings = {}) {
  return [toDataUri(renderBars(snapshot, { background: settings.background }))];
}
