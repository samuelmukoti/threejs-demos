// Audio hook layer. Pure module: no three or DOM imports.
// With no audio backend it logs events to the console (throttled per event name).

export const AUDIO_EVENTS = [
  'engine', 'tireSqueal', 'gearChange', 'brake', 'rain', 'impact', 'tunnel', 'beat',
];

// Minimum ms between console log lines per event name. 0 = log every event.
// Continuous events are limited so they do not flood the console.
export const DEFAULT_LOG_INTERVALS = {
  engine: 1000,
  tireSqueal: 500,
  brake: 500,
  rain: 2000,
  tunnel: 0,
  gearChange: 0,
  impact: 0,
  beat: 0,
};

const defaultClock = () => (typeof performance !== 'undefined' ? performance.now() : 0);
const defaultLogger = (...args) => {
  if (typeof console !== 'undefined') console.info(...args);
};

/**
 * @param {object} [options]
 * @param {() => number} [options.clock] time in ms, used only for log throttling
 * @param {(...args: any[]) => void} [options.logger] console fallback sink
 * @param {boolean} [options.hasBackend] when true, events are not logged
 * @param {Record<string, number>} [options.logIntervals] per-event throttle overrides (ms)
 */
export function createAudioBus(options = {}) {
  const {
    clock = defaultClock,
    logger = defaultLogger,
    hasBackend = false,
    logIntervals = {},
  } = options;
  const intervals = { ...DEFAULT_LOG_INTERVALS, ...logIntervals };
  const listeners = new Map(); // name -> Set<cb>
  const lastLogged = new Map(); // name -> ms
  let suppressed = false;
  let disposed = false;

  function subscribe(name, cb) {
    if (typeof cb !== 'function') throw new Error('audioBus.subscribe requires a callback');
    if (disposed) return () => {};
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
    return () => unsubscribe(name, cb);
  }

  function unsubscribe(name, cb) {
    const set = listeners.get(name);
    if (!set) return false;
    const removed = set.delete(cb);
    if (set.size === 0) listeners.delete(name);
    return removed;
  }

  function log(name, payload) {
    const interval = intervals[name] ?? 0;
    const now = clock();
    const last = lastLogged.get(name);
    if (interval > 0 && last !== undefined && now - last < interval) return;
    lastLogged.set(name, now);
    logger(`[audio] ${name}`, payload);
  }

  function notify(set, name, payload) {
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload, name);
      } catch (err) {
        logger(`[audio] subscriber error on "${name}"`, err);
      }
    }
  }

  // Returns true if the event was dispatched.
  function emit(name, payload) {
    if (disposed || suppressed) return false;
    if (!hasBackend) log(name, payload);
    notify(listeners.get(name), name, payload);
    notify(listeners.get('*'), name, payload);
    return true;
  }

  function setSuppressed(value) {
    suppressed = !!value;
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    lastLogged.clear();
  }

  return { emit, subscribe, unsubscribe, setSuppressed, dispose };
}
