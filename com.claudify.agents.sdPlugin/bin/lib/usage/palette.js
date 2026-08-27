/**
 * What the usage faces are made of: the colours, the font, and the face both
 * fall back to when there are no numbers to show.
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

/** One colour per band, shared with the agent keys' states. */
export const ACCENTS = {
  ok: '#4ade80',
  warning: '#fbbf24',
  critical: '#fb923c',
  limited: '#f87171',
  stale: TEXT_MUTED,
  auth: '#fbbf24',
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
 * The corner dot that marks a reading as stale. Deliberately small: the numbers
 * under it are the real last-known-good ones, and greying the whole key over a
 * transient rate-limit window would overstate the problem.
 */
export const staleDot = () => `<circle cx="${SIZE - 12}" cy="12" r="3.5" fill="${TEXT_MUTED}"/>`;

/**
 * The face for a status that has no numbers behind it: a framed message. The
 * frame carries the colour, so the words can stay legible.
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
  switch (status) {
    case 'auth':
      return ['Claude', 'Login', 'Required'];
    case 'rateLimited':
      return ['Claude', 'Rate', 'Limited'];
    default:
      return ['Claude', 'Error'];
  }
}

/** True when a status has nothing worth drawing a bar or a ring for. */
export const isFailure = (status) =>
  status === 'auth' || status === 'rateLimited' || status === 'error';
