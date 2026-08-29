/**
 * What the usage faces are made of: the colours, the font, and the faces they
 * fall back to when the numbers are missing or no longer being confirmed.
 *
 * Adapted from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov), recoloured
 * to match the agent keys so a deck holding both does not look like two plugins.
 * See THIRD-PARTY-NOTICES.md.
 */
import { CENTER, SIZE, escapeXml, svgDocument } from '../canvas.js';

/** The same stack render.js uses -- see canvas.js on why no font is loaded. */
export const FONT = "Arial, Helvetica, 'DejaVu Sans', sans-serif";

export const TEXT = '#dfe3ee';
export const TEXT_MUTED = '#8b8fa3';

/**
 * The empty part of a bar or ring. Lighter than the agent keys' ring track: a
 * flat 12px bar reads dimmer than a stroked circle at the same colour, and on a
 * transparent key it has nothing but black behind it.
 */
export const TRACK = '#2f2f45';

/** The greyed-out face: see isDimmed. The grey is the agent keys' own. */
export const DIM_ACCENT = '#4b5563';
export const DIM_TEXT = '#6f7484';

/** One colour per band, shared with the agent keys' states. */
export const ACCENTS = {
  ok: '#4ade80',
  warning: '#fbbf24',
  critical: '#fb923c',
  limited: '#f87171',
  rateLimited: '#fb923c',
  error: '#f87171',
};

export const accentFor = (status) => ACCENTS[status] ?? ACCENTS.ok;

/** A right-aligned or centred line of text at an explicit baseline. */
export function text(x, baseline, value, { size = 22, weight = 'bold', fill = TEXT, anchor } = {}) {
  return (
    `<text x="${x}" y="${baseline}" ${anchor ? `text-anchor="${anchor}" ` : ''}` +
    `font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">` +
    `${escapeXml(value)}</text>`
  );
}

/**
 * True when the face should be drawn dim rather than in its band colours.
 *
 * Three things land here, and none of them is a broken reading: a login that has
 * expired, a WSL distro that was left asleep, and any reading re-served from the
 * cache after the refresh behind it failed. The shape of the key is still right
 * in all three -- what is on it has simply stopped being confirmed -- so it
 * fades rather than being replaced by a message or flagged with a corner dot.
 * That is the same restraint the agent keys show when a poll declines to wake
 * WSL: skipped is not broken, and should not look like it.
 */
export const isDimmed = (snapshot) =>
  snapshot.stale === true || snapshot.status === 'auth' || snapshot.status === 'wslAsleep';

/**
 * The face for a status that has no numbers behind it and no dimmed face to
 * fall back on: a framed message. The frame carries the colour, so the words
 * can stay legible.
 */
export function messageFace(lines, status, background) {
  const accent = accentFor(status);
  const startY = CENTER - ((lines.length - 1) * 26) / 2;
  const body = lines
    .map((line, i) => text(CENTER, startY + i * 26 + 8, line, { size: 20, anchor: 'middle' }))
    .join('');

  return svgDocument(
    `<rect x="8" y="8" width="${SIZE - 16}" height="${SIZE - 16}" rx="18" fill="none" ` +
      `stroke="${accent}" stroke-width="4"/>${body}`,
    background,
  );
}

/** The words for each failure. Short enough to read at a glance on a key. */
export function messageLines(status) {
  return status === 'rateLimited' ? ['Claude', 'Rate', 'Limited'] : ['Claude', 'Error'];
}

/**
 * True when the request was refused or went wrong -- the failures worth spending
 * the whole key on words for. The quieter ones dim instead; see isDimmed.
 */
export const isFailure = (status) => status === 'rateLimited' || status === 'error';
