import * as THREE from 'three';
import { createParticlePool } from './particles.js';
import { createEmitterGroup, countFor, mixSeed } from './tireSmoke.js';

// Near-miss barrier scrape: additive sparks plus debris at a fixed event time, and
// continuous sewer steam. All emission is a pure function of t (and the seeded per-step
// PRNG), so scrubbing/replay reproduces the same particles.

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
 * @param getContact (t) => { position: Vector3|[x,y,z], direction?: Vector3|[x,y,z] } — scrape point
 *   at time t and the travel direction of the vehicle (sparks fly backwards along it).
 * @param steamVents array of Vector3|[x,y,z] world positions for sewer steam.
 */
export function createSparks({
  seed = 1,
  eventTime = 0,
  duration = 0.7,
  getContact = () => ({ position: [0, 0, 0] }),
  steamVents = [],
  sparkCapacity = 500,
  debrisCapacity = 120,
  steamCapacity = 400,
  sparkRate = 700, // sparks/s while the scrape lasts
  debrisRate = 60,
  steamRate = 14, // particles/s per vent
  texture = null,
  renderOrder = 11,
} = {}) {
  if (typeof getContact !== 'function') throw new Error('createSparks: getContact must be a function');
  if (!(duration > 0)) throw new Error('createSparks: duration must be > 0');

  const sparks = createParticlePool({
    capacity: sparkCapacity,
    lifetime: 0.6,
    seed: mixSeed(seed, 11),
    size: 0.09,
    gravity: [0, -9.8, 0],
    drag: 0.4,
    texture,
    blending: THREE.AdditiveBlending,
    renderOrder,
  });
  const debris = createParticlePool({
    capacity: debrisCapacity,
    lifetime: 1.4,
    seed: mixSeed(seed, 12),
    size: 0.12,
    gravity: [0, -9.8, 0],
    drag: 0.2,
    texture,
    blending: THREE.NormalBlending,
    renderOrder,
  });
  const steam = createParticlePool({
    capacity: steamCapacity,
    lifetime: 3,
    seed: mixSeed(seed, 13),
    size: 1.2,
    gravity: [0, 0.15, 0],
    drag: 0.6,
    texture,
    blending: THREE.NormalBlending,
    renderOrder,
  });

  const sparkColor = [1, 0.72, 0.28, 1];
  const debrisColor = [0.35, 0.33, 0.3, 0.9];
  const steamColor = [0.8, 0.82, 0.85, 0.22];
  const end = eventTime + duration;

  function active(t) {
    return t >= eventTime && t < end;
  }

  // Sparks stream backwards from the contact point, lofted slightly upward.
  function aim(contact, speed, lift) {
    setVec(_spec.position, contact.position);
    if (contact.direction) {
      setVec(_spec.velocity, contact.direction);
      _spec.velocity[0] *= -speed; _spec.velocity[1] = _spec.velocity[1] * -speed + lift; _spec.velocity[2] *= -speed;
    } else {
      _spec.velocity[0] = 0; _spec.velocity[1] = lift; _spec.velocity[2] = 0;
    }
  }

  function emitSparks(pool, t, step, rng) {
    if (!active(t)) return;
    const contact = getContact(t);
    if (!contact) return;
    const n = countFor(sparkRate, step, rng);
    if (n === 0) return;
    aim(contact, 6, 2.5);
    _spec.count = n;
    _spec.spread = 3.5;
    _spec.positionSpread = 0.06;
    _spec.color = sparkColor;
    _spec.lifetime = 0.25 + rng() * 0.35;
    _spec.size = 0.06 + rng() * 0.06;
    pool.emit(_spec);
  }

  function emitDebris(pool, t, step, rng) {
    if (!active(t)) return;
    const contact = getContact(t);
    if (!contact) return;
    const n = countFor(debrisRate, step, rng);
    if (n === 0) return;
    aim(contact, 3, 2);
    _spec.count = n;
    _spec.spread = 2.5;
    _spec.positionSpread = 0.1;
    _spec.color = debrisColor;
    _spec.lifetime = 0.6 + rng() * 0.8;
    _spec.size = 0.08 + rng() * 0.08;
    pool.emit(_spec);
  }

  function emitSteam(pool, t, step, rng) {
    for (let i = 0; i < steamVents.length; i++) {
      const n = countFor(steamRate, step, rng);
      if (n === 0) continue;
      setVec(_spec.position, steamVents[i]);
      _spec.count = n;
      _spec.velocity[0] = 0; _spec.velocity[1] = 1.4; _spec.velocity[2] = 0;
      _spec.spread = 0.35;
      _spec.positionSpread = 0.15;
      _spec.color = steamColor;
      _spec.lifetime = 2 + rng();
      _spec.size = 0.9 + rng() * 0.8;
      pool.emit(_spec);
    }
  }

  const group = createEmitterGroup(
    [
      { pool: sparks, emit: emitSparks },
      { pool: debris, emit: emitDebris },
      { pool: steam, emit: emitSteam },
    ],
    seed,
  );

  return {
    objects: [sparks.object, debris.object, steam.object],
    sparks,
    debris,
    steam,
    eventTime,
    duration,
    update: group.update,
    replayTo: group.replayTo,
    clear: group.clear,
    dispose: group.dispose,
    getStateHash: group.getStateHash,
  };
}
