/**
 * The Claude mark -- the radial burst, not the Clawd mascot.
 *
 * Claude Code ships no logo asset of its own (the only SVGs inside the binary
 * belong to Bun), so the mark is constructed here from its geometry: twelve
 * spindle-shaped rays around a small hub, in Anthropic's coral. At the 16px
 * this is drawn at, that reads as the burst.
 *
 * To swap in official artwork, replace claudeMark() with something that emits
 * that path data scaled to (cx, cy, radius). Nothing else needs to change.
 */
const RAYS = 12;
/** Fraction of the radius the rays start out from, leaving a hub. */
const INNER = 0.14;
/** Where along the ray it is widest, and how far the control point overshoots. */
const WAIST = 0.45;
const SPREAD = 0.16;

export const CLAUDE_CORAL = '#d97757';

/**
 * A ray, as a lens pointed at both ends. Coordinates are absolute -- Stream
 * Deck's renderer is happier without nested transforms.
 */
function ray(cx, cy, radius, angle) {
  // Local axes: u runs outward along the ray, v across it.
  const at = (u, v) => {
    const x = cx + u * Math.sin(angle) + v * Math.cos(angle);
    const y = cy - u * Math.cos(angle) + v * Math.sin(angle);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };

  const inner = INNER * radius;
  const waist = inner + WAIST * (radius - inner);
  const spread = SPREAD * radius;

  // A quadratic's peak deviation is half its control offset, so the drawn ray
  // is about SPREAD/2 wide at the waist.
  return (
    `M ${at(inner, 0)} Q ${at(waist, spread)} ${at(radius, 0)} ` +
    `Q ${at(waist, -spread)} ${at(inner, 0)} Z`
  );
}

/** @returns SVG markup for the mark centred on (cx, cy). */
export function claudeMark(cx, cy, radius, color = CLAUDE_CORAL) {
  let path = '';
  for (let i = 0; i < RAYS; i += 1) {
    path += ray(cx, cy, radius, (i / RAYS) * Math.PI * 2);
  }

  return (
    `<path d="${path}" fill="${color}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(INNER * radius * 1.25).toFixed(2)}" fill="${color}"/>`
  );
}
