import * as THREE from 'three';
import { mulberry32 } from '../utils/prng.js';
import { createParticlePool } from './particles.js';

// Tire spray and drift smoke. Both are pools built on particles.js; emission is a pure
// function of (t, wheel samples), with a per-step PRNG seeded from (seed, step index), so
// replayTo(t) reproduces exactly what live playback produced.

export function mixSeed(seed, index) {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Drives a set of { pool, emit(pool, t, step, rng) } entries as one effect.
// Live: update(t, dt) emits for the step [t - dt, t] then advances the pool.
// Each entry gets its own seeded PRNG stream, re-seeded per step index.
export function createEmitterGroup(entries, seed) {
  const salted = entries.map((e, i) => ({ ...e, salt: mixSeed(seed, 0x1000 + i) }));

  function stepRng(entry, tk, step) {
    return mulberry32(mixSeed(entry.salt, Math.round(tk / step)));
  }

  function update(t, dt) {
    for (const e of salted) {
      const step = e.pool.step;
      if (dt > 0) e.emit(e.pool, t - dt, step, stepRng(e, t - dt, step));
      e.pool.update(t, dt);
    }
  }

  function replayTo(t) {
    for (const e of salted) {
      e.pool.replayTo(t, (pool, tk, step) => e.emit(pool, tk, step, stepRng(e, tk, step)));
    }
  }

  function clear() {
    for (const e of salted) e.pool.clear();
  }

  function dispose() {
    for (const e of salted) e.pool.dispose();
  }

  function getStateHash() {
    return salted.map((e) => e.pool.getStateHash()).join('-');
  }

  return { update, replayTo, clear, dispose, getStateHash };
}

// Stochastic rounding: expected value is rate * step, but always an integer count.
export function countFor(rate, step, rng) {
  return Math.floor(Math.max(0, rate) * step + rng());
}

const _spec = {
  count: 1,
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  spread: 0,
  positionSpread: 0,
  color: [1, 1, 1, 1],
  lifetime: 1,
  size: 0.2,
};

function setVec(out, v) {
  if (Array.isArray(v)) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
  } else {
    out[0] = v.x; out[1] = v.y; out[2] = v.z;
  }
}

/**
 * @param getWheels (t) => array of { position: Vector3|[x,y,z], slip: 0..1+, speed: m/s,
 *   grounded?: boolean } — world-space wheel-contact positions. Must be a pure function of t.
 */
export function createTireSmoke({
  seed = 1,
  getWheels = () => [],
  wet = true,
  sprayCapacity = 600,
  smokeCapacity = 600,
  sprayPerSpeed = 3, // particles/s per m/s of speed per wheel (wet only)
  sprayMinSpeed = 3,
  smokePerSlip = 160, // particles/s per unit of slip above the threshold, per wheel
  slipThreshold = 0.25,
  texture = null,
  renderOrder = 10,
} = {}) {
  if (typeof getWheels !== 'function') throw new Error('createTireSmoke: getWheels must be a function');

  const spray = createParticlePool({
    capacity: sprayCapacity,
    lifetime: 0.9,
    seed: mixSeed(seed, 1),
    size: 0.28,
    gravity: [0, -6, 0],
    drag: 1.5,
    texture,
    blending: THREE.NormalBlending,
    renderOrder,
  });
  const smoke = createParticlePool({
    capacity: smokeCapacity,
    lifetime: 2.5,
    seed: mixSeed(seed, 2),
    size: 0.9,
    gravity: [0, 0.35, 0],
    drag: 0.9,
    texture,
    blending: THREE.NormalBlending,
    renderOrder,
  });

  const sprayColor = [0.7, 0.76, 0.84, 0.35];
  const smokeColor = [0.78, 0.78, 0.8, 0.5];

  function emitSpray(pool, t, step, rng) {
    if (!wet) return;
    const wheels = getWheels(t);
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (w.grounded === false || w.speed < sprayMinSpeed) continue;
      const n = countFor(w.speed * sprayPerSpeed, step, rng);
      if (n === 0) continue;
      setVec(_spec.position, w.position);
      _spec.count = n;
      _spec.velocity[0] = 0; _spec.velocity[1] = 1.2 + w.speed * 0.05; _spec.velocity[2] = 0;
      _spec.spread = 0.9 + w.speed * 0.04;
      _spec.positionSpread = 0.12;
      _spec.color = sprayColor;
      _spec.lifetime = 0.5 + rng() * 0.4;
      _spec.size = 0.2 + rng() * 0.15;
      pool.emit(_spec);
    }
  }

  function emitSmoke(pool, t, step, rng) {
    const wheels = getWheels(t);
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (w.grounded === false || w.slip <= slipThreshold) continue;
      const n = countFor((w.slip - slipThreshold) * smokePerSlip, step, rng);
      if (n === 0) continue;
      setVec(_spec.position, w.position);
      _spec.count = n;
      _spec.velocity[0] = 0; _spec.velocity[1] = 0.8; _spec.velocity[2] = 0;
      _spec.spread = 0.7;
      _spec.positionSpread = 0.2;
      _spec.color = smokeColor;
      _spec.lifetime = 1.6 + rng() * 0.9;
      _spec.size = 0.7 + rng() * 0.6;
      pool.emit(_spec);
    }
  }

  const group = createEmitterGroup(
    [
      { pool: spray, emit: emitSpray },
      { pool: smoke, emit: emitSmoke },
    ],
    seed,
  );

  return {
    objects: [spray.object, smoke.object],
    spray,
    smoke,
    update: group.update,
    replayTo: group.replayTo,
    clear: group.clear,
    dispose: group.dispose,
    getStateHash: group.getStateHash,
  };
}
