/**
 * The key surface every face is drawn on.
 *
 * Stream Deck rasterises SVG data URIs itself, which keeps the plugin free of
 * native image dependencies -- but it rasterises them *statically*, so SMIL and
 * CSS animation inside the SVG do nothing. Motion comes from pushing a
 * pre-rendered frame at a time; see the frames() export on each face.
 *
 * Its renderer is also conservative, so faces stick to rects, circles, paths
 * with absolute coordinates and <text> with an explicit baseline -- no
 * transforms, no dominant-baseline, no letter-spacing, no external fonts.
 */
export const SIZE = 144;
export const CENTER = SIZE / 2;

/** The key's background, as a user-facing setting shared by both faces. */
export const BACKGROUNDS = {
  blue: { background: '#0b0b11', card: '#15151f' },
  gray: { background: '#1c1c1e', card: '#1c1c1e' },
  // No rects at all: the key stays alpha-transparent, showing Stream Deck's
  // own key background through the icon.
  transparent: null,
};

/** Where a corner glyph sits: clear of the ring even at its thickest. */
export const CORNER = { x: 120, y: 24, r: 8 };

export const escapeXml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });

/** Wrap a face's own markup in the card, themed by the `background` setting. */
export function svgDocument(inner, background = 'transparent') {
  // Not `??`: 'transparent' maps to null on purpose, and ?? would treat that
  // as missing and fall back to blue.
  const theme = background in BACKGROUNDS ? BACKGROUNDS[background] : BACKGROUNDS.blue;
  const chrome = theme
    ? `<rect width="${SIZE}" height="${SIZE}" fill="${theme.background}"/>` +
      `<rect x="3" y="3" width="${SIZE - 6}" height="${SIZE - 6}" rx="22" fill="${theme.card}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    chrome +
    inner +
    '</svg>'
  );
}

export function toDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** A filled dot in the corner slot, for states that need flagging. */
export function cornerDot(color, radius = 5) {
  return `<circle cx="${CORNER.x}" cy="${CORNER.y}" r="${radius}" fill="${color}"/>`;
}
