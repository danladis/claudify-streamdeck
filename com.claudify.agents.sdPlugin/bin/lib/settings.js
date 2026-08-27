/** Defaults for a freshly-dropped key. */
export const DEFAULTS = {
  /** 'auto' picks wsl on Windows, local elsewhere. */
  transport: 'auto',
  /** WSL distribution name; empty means "the default distro". */
  distro: '',
  /** Explicit path to the claude binary; empty means auto-detect. */
  claudeBin: '',
  /** Only count sessions started under this directory; empty means all. */
  cwdFilter: '',
  /** 'all' | 'bg' | 'interactive' */
  scope: 'all',
  /** Seconds between refreshes. */
  interval: 30,
  /** Spin the ring, or set Clawd moving, while agents are working. */
  animate: true,
  /** How fast either face animates: see SPEEDS. */
  speed: 'normal',
  /** Which move Clawd makes on the mascot key: see ANIMATIONS in clawd.js. */
  clawdAnimation: 'random',
  /** Ring stroke weight: see THICKNESS in render.js. */
  thickness: 'normal',
  /** Show the Claude mark in the top-right corner of the ring key. */
  showMark: true,
  /** Key background, shared by both faces: see BACKGROUNDS in canvas.js. */
  background: 'transparent',
  /** 'focus' | 'agentView' | 'refresh' | 'custom' */
  pressAction: 'focus',
  /** Shell command for pressAction 'custom', run on the Claude-side host. */
  customCommand: '',
  /** Show the custom command in a terminal window instead of running it silently. */
  customInTerminal: true,
};

/**
 * Animation speed, as a multiplier on each face's own frame interval. Higher is
 * slower: a face's base pace is what its author picked, and this stretches or
 * squeezes it. The extremes stay watchable -- 'crawl' still moves, and 'frantic'
 * stops short of asking the deck for a frame faster than it can draw one.
 */
export const SPEEDS = {
  crawl: 2.6,
  slow: 1.6,
  normal: 1,
  brisk: 0.65,
  frantic: 0.42,
};

export const speedFactor = (name) => SPEEDS[name] ?? SPEEDS.normal;

/**
 * Clawd's moves, named here so settings can be validated without importing the
 * drawing code. clawd.js owns what each one looks like. 'random' isn't a move
 * of its own -- it tells plugin.js to pick a fresh one each time Clawd starts.
 */
const CLAWD_ANIMATIONS = new Set(['wiggle', 'scuttle', 'shimmy', 'wave', 'jump', 'random']);

const TRANSPORTS = new Set(['auto', 'wsl', 'local']);
const SCOPES = new Set(['all', 'bg', 'interactive']);
const PRESS_ACTIONS = new Set(['focus', 'agentView', 'refresh', 'custom']);
const THICKNESSES = new Set(['hairline', 'thin', 'normal', 'thick', 'heavy']);
const BACKGROUNDS = new Set(['blue', 'gray', 'transparent']);

const str = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback);
const oneOf = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

/** Coerce whatever the Property Inspector saved into a complete, valid config. */
export function normalize(raw) {
  const settings = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const interval = Number(settings.interval);

  return {
    transport: oneOf(settings.transport, TRANSPORTS, DEFAULTS.transport),
    distro: str(settings.distro, DEFAULTS.distro),
    claudeBin: str(settings.claudeBin, DEFAULTS.claudeBin),
    cwdFilter: str(settings.cwdFilter, DEFAULTS.cwdFilter),
    scope: oneOf(settings.scope, SCOPES, DEFAULTS.scope),
    // Under 5s just hammers the CLI for no benefit; over an hour is
    // indistinguishable from "off".
    interval: Number.isFinite(interval)
      ? Math.min(3600, Math.max(5, Math.round(interval)))
      : DEFAULTS.interval,
    animate: settings.animate !== false,
    speed: oneOf(settings.speed, new Set(Object.keys(SPEEDS)), DEFAULTS.speed),
    clawdAnimation: oneOf(settings.clawdAnimation, CLAWD_ANIMATIONS, DEFAULTS.clawdAnimation),
    thickness: oneOf(settings.thickness, THICKNESSES, DEFAULTS.thickness),
    showMark: settings.showMark !== false,
    background: oneOf(settings.background, BACKGROUNDS, DEFAULTS.background),
    pressAction: oneOf(settings.pressAction, PRESS_ACTIONS, DEFAULTS.pressAction),
    customCommand: str(settings.customCommand, DEFAULTS.customCommand),
    customInTerminal: settings.customInTerminal !== false,
  };
}

/** Which host we actually talk to, once 'auto' is resolved. */
export function resolveTransport(settings, platform = process.platform) {
  if (settings.transport !== 'auto') return settings.transport;
  return platform === 'win32' ? 'wsl' : 'local';
}

/**
 * Two keys sharing this signature produce identical probe results, so a single
 * run can satisfy both.
 */
export function probeKey(settings) {
  return [
    resolveTransport(settings),
    settings.distro,
    settings.claudeBin,
    settings.cwdFilter,
  ].join(' ');
}
