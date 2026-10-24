import * as THREE from 'three';
import { mulberry32 } from '../utils/prng.js';

// Fixed-capacity particle pool. All storage is preallocated; emit/update never allocate.
// Randomness comes only from a seeded PRNG that is re-seeded per simulation step, so a
// replay from any step-aligned start reproduces the same particles (deterministic seek).

export const MAX_PARTICLE_LIFETIME = 3;
const DEFAULT_STEP = 1 / 60;

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _order = [];

function mixSeed(seed, index) {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createParticlePool({
  capacity = 256,
  lifetime = 1,
  blending = THREE.AdditiveBlending,
  texture = null,
  seed = 1,
  size = 0.2,
  gravity = [0, 0, 0],
  drag = 0,
  step = DEFAULT_STEP,
  renderOrder = 10,
} = {}) {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('createParticlePool: capacity must be a positive integer');
  if (!(lifetime > 0) || lifetime > MAX_PARTICLE_LIFETIME) throw new Error(`createParticlePool: lifetime must be in (0, ${MAX_PARTICLE_LIFETIME}]`);
  if (!(step > 0)) throw new Error('createParticlePool: step must be > 0');

  const positions = new Float32Array(capacity * 3);
  const velocities = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 4);
  const sizes = new Float32Array(capacity);
  const ages = new Float32Array(capacity);
  const lives = new Float32Array(capacity);
  const baseColors = new Float32Array(capacity * 4);
  const seqs = new Float64Array(capacity);
  const alive = new Uint8Array(capacity);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const material = new THREE.PointsMaterial({
    size,
    map: texture,
    vertexColors: true,
    transparent: true,
    blending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;

  let rng = mulberry32(mixSeed(seed, 0));
  let head = 0;
  let seq = 0;
  let time = 0;
  let accum = 0;

  function reseed(stepIndex) {
    rng = mulberry32(mixSeed(seed, stepIndex));
  }

  function emitOne(spec) {
    const i = head;
    head = (head + 1) % capacity; // overwrites the oldest-emitted slot when full
    const p = spec.position || [0, 0, 0];
    const v = spec.velocity || [0, 0, 0];
    const sp = spec.spread ?? 0;
    const ps = spec.positionSpread ?? 0;
    const c = spec.color || [1, 1, 1, 1];
    _pos.set(p[0] + (rng() - 0.5) * 2 * ps, p[1] + (rng() - 0.5) * 2 * ps, p[2] + (rng() - 0.5) * 2 * ps);
    _vel.set(v[0] + (rng() - 0.5) * 2 * sp, v[1] + (rng() - 0.5) * 2 * sp, v[2] + (rng() - 0.5) * 2 * sp);
    positions[i * 3] = _pos.x; positions[i * 3 + 1] = _pos.y; positions[i * 3 + 2] = _pos.z;
    velocities[i * 3] = _vel.x; velocities[i * 3 + 1] = _vel.y; velocities[i * 3 + 2] = _vel.z;
    baseColors[i * 4] = c[0]; baseColors[i * 4 + 1] = c[1]; baseColors[i * 4 + 2] = c[2]; baseColors[i * 4 + 3] = c[3] ?? 1;
    ages[i] = 0;
    lives[i] = Math.min(spec.lifetime ?? lifetime, lifetime);
    sizes[i] = spec.size ?? size;
    seqs[i] = seq++;
    alive[i] = 1;
  }

  function emit(spec = {}) {
    const n = spec.count ?? 1;
    for (let k = 0; k < n; k++) emitOne(spec);
  }

  function writeRender(i) {
    if (!alive[i]) {
      colors[i * 4 + 3] = 0;
      return;
    }
    const f = 1 - ages[i] / lives[i];
    colors[i * 4] = baseColors[i * 4];
    colors[i * 4 + 1] = baseColors[i * 4 + 1];
    colors[i * 4 + 2] = baseColors[i * 4 + 2];
    colors[i * 4 + 3] = baseColors[i * 4 + 3] * f;
  }

  function integrate(h) {
    const damp = Math.max(0, 1 - drag * h);
    for (let i = 0; i < capacity; i++) {
      if (!alive[i]) continue;
      ages[i] += h;
      if (ages[i] >= lives[i]) {
        alive[i] = 0;
        continue;
      }
      const j = i * 3;
      velocities[j] = (velocities[j] + gravity[0] * h) * damp;
      velocities[j + 1] = (velocities[j + 1] + gravity[1] * h) * damp;
      velocities[j + 2] = (velocities[j + 2] + gravity[2] * h) * damp;
      positions[j] += velocities[j] * h;
      positions[j + 1] += velocities[j + 1] * h;
      positions[j + 2] += velocities[j + 2] * h;
    }
  }

  function update(t, dt) {
    accum += dt;
    while (accum >= step - 1e-9) {
      integrate(step);
      accum -= step;
    }
    if (accum < 0) accum = 0;
    time = t;
    for (let i = 0; i < capacity; i++) writeRender(i);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    reseed(Math.round(t / step));
  }

  function clear() {
    alive.fill(0);
    ages.fill(0);
    head = 0;
    seq = 0;
    accum = 0;
    for (let i = 0; i < capacity; i++) writeRender(i);
    geometry.attributes.color.needsUpdate = true;
  }

  // Deterministically rebuild the state at time t by re-simulating the last
  // maxLifetime seconds. emitterFn(pool, time, step) is called before each step.
  function replayTo(t, emitterFn, replayStep = step) {
    clear();
    const first = Math.max(0, Math.floor((t - lifetime) / replayStep));
    const last = Math.round(t / replayStep);
    for (let k = first; k < last; k++) {
      const tk = k * replayStep;
      reseed(k);
      if (emitterFn) emitterFn(api, tk, replayStep);
      update(tk + replayStep, replayStep);
    }
    reseed(last);
    time = t;
  }

  function getStateHash() {
    _order.length = 0;
    for (let i = 0; i < capacity; i++) if (alive[i]) _order.push(i);
    _order.sort((a, b) => seqs[a] - seqs[b]);
    let h = 0x811c9dc5;
    const mix = (x) => {
      h = Math.imul(h ^ (Math.round(x * 1e4) | 0), 0x01000193) >>> 0;
    };
    mix(_order.length);
    for (const i of _order) {
      mix(positions[i * 3]); mix(positions[i * 3 + 1]); mix(positions[i * 3 + 2]);
      mix(velocities[i * 3]); mix(velocities[i * 3 + 1]); mix(velocities[i * 3 + 2]);
      mix(ages[i]); mix(lives[i]);
    }
    return h.toString(16).padStart(8, '0');
  }

  function aliveCount() {
    let n = 0;
    for (let i = 0; i < capacity; i++) n += alive[i];
    return n;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  const api = {
    object: points,
    geometry,
    material,
    capacity,
    maxLifetime: lifetime,
    step,
    emit,
    update,
    clear,
    replayTo,
    getStateHash,
    aliveCount,
    dispose,
    get time() { return time; },
    arrays: { positions, velocities, colors, sizes, ages, lives },
  };
  return api;
}
