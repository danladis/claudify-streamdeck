/**
 * Reset times, short enough for a key.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * Both helpers take the ISO string straight off a snapshot window and an
 * explicit `now`, so a test can pin the clock instead of racing it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

/**
 * The reset moment in local time.
 *   dayMonth  '31 May, 14:06'
 *   isoShort  '05/31 14:06'
 *   weekday   'Sat 14:06'
 * Null for a missing or unparseable timestamp -- the face then shows nothing
 * rather than 'Invalid Date'.
 */
export function formatResetTime(isoString, format = 'dayMonth') {
  if (!isoString) return null;
  const at = new Date(isoString);
  if (Number.isNaN(at.getTime())) return null;

  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  switch (format) {
    case 'isoShort':
      return `${pad2(at.getMonth() + 1)}/${pad2(at.getDate())} ${time}`;
    case 'weekday':
      return `${WEEKDAYS[at.getDay()]} ${time}`;
    default:
      return `${at.getDate()} ${MONTHS[at.getMonth()]}, ${time}`;
  }
}

/**
 * How long until the reset, coarsely: '2d 3h', '7h 58m', '42m', or 'now' once
 * it is due. Null for a missing or unparseable timestamp.
 */
export function formatCountdown(isoString, now = new Date()) {
  if (!isoString) return null;
  const target = new Date(isoString);
  if (Number.isNaN(target.getTime())) return null;

  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
