// Deterministic chase timeline. Pure module: no GSAP, no wall-clock, no three/DOM.
import { settings } from '../settings.js';

export function createChaseTimeline() {
  const shots = [];
  let t = 0;
  let paused = false;
  let playbackSpeed = 1;

  const duration = () => (shots.length ? shots[shots.length - 1].end : 0);

  function evaluate(time) {
    if (!shots.length) return { shot: null, localProgress: 0, t: 0 };
    const total = duration();
    const tt = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), total);
    let shot = shots[shots.length - 1];
    for (const s of shots) {
      if (tt < s.end) { shot = s; break; }
    }
    const span = shot.end - shot.start;
    const localProgress = span > 0 ? Math.min(Math.max((tt - shot.start) / span, 0), 1) : 1;
    return { shot, localProgress, t: tt };
  }

  const timeline = {
    get shots() { return shots; },
    get duration() { return duration(); },
    get t() { return t; },
    get paused() { return paused; },
    get playbackSpeed() { return playbackSpeed; },
    set playbackSpeed(v) {
      if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid playbackSpeed: ${v}`);
      playbackSpeed = v;
    },
    addShot(name, start, end) {
      if (!(end > start)) throw new Error(`Shot "${name}" must have end > start`);
      const last = shots[shots.length - 1];
      if (last && start !== last.end) {
        throw new Error(`Shot "${name}" must start at ${last.end} (contiguous)`);
      }
      shots.push({ name, start, end });
      return timeline;
    },
    evaluate,
    seek(time) {
      t = evaluate(time).t;
      return evaluate(t);
    },
    update(dt) {
      if (!paused) {
        t = evaluate(t + dt * playbackSpeed).t;
      }
      return evaluate(t);
    },
    pause() { paused = true; return timeline; },
    resume() { paused = false; return timeline; },
    reset() { t = 0; paused = false; return timeline; },
  };
  return timeline;
}

export function buildDefaultTimeline(config = settings.timeline) {
  const timeline = createChaseTimeline();
  for (const { name, start, end } of config.shots) timeline.addShot(name, start, end);
  return timeline;
}
