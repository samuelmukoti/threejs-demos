import { describe, it, expect } from 'vitest';
import { createParticlePool } from '../src/effects/particles.js';

const emitter = (pool, t) => {
  if (Math.round(t * 60) % 3 === 0) {
    pool.emit({ position: [t, 0, 0], velocity: [0, 1, 0], spread: 0.5, count: 2, lifetime: 1 });
  }
};

function runLive(pool, until, step = 1 / 60) {
  const n = Math.round(until / step);
  for (let k = 0; k < n; k++) {
    emitter(pool, k * step);
    pool.update((k + 1) * step, step);
  }
}

describe('particles', () => {
  it('has fixed-size preallocated buffers and expected render flags', () => {
    const pool = createParticlePool({ capacity: 16, lifetime: 1, seed: 1 });
    const buf = pool.arrays.positions;
    expect(buf.length).toBe(48);
    pool.emit({ count: 100 });
    expect(pool.arrays.positions).toBe(buf);
    expect(pool.arrays.positions.length).toBe(48);
    expect(pool.object.frustumCulled).toBe(false);
    expect(pool.material.depthWrite).toBe(false);
  });

  it('recycles the oldest slot beyond capacity', () => {
    const pool = createParticlePool({ capacity: 4, lifetime: 1, seed: 1 });
    for (let i = 0; i < 6; i++) pool.emit({ position: [i, 0, 0] });
    expect(pool.aliveCount()).toBe(4);
    const xs = Array.from({ length: 4 }, (_, i) => pool.arrays.positions[i * 3]).sort();
    expect(xs).toEqual([2, 3, 4, 5]);
  });

  it('rejects lifetime above 3', () => {
    expect(() => createParticlePool({ capacity: 4, lifetime: 4 })).toThrow();
  });

  it('particles expire after their lifetime', () => {
    const pool = createParticlePool({ capacity: 8, lifetime: 0.5, seed: 1 });
    pool.emit({ count: 3 });
    pool.update(0.25, 0.25);
    expect(pool.aliveCount()).toBe(3);
    pool.update(0.75, 0.5);
    expect(pool.aliveCount()).toBe(0);
  });

  it('seek-and-replay yields identical state, matching live simulation', () => {
    const opts = { capacity: 512, lifetime: 1, seed: 42, gravity: [0, -1, 0] };
    const live = createParticlePool(opts);
    runLive(live, 2);
    const a = createParticlePool(opts);
    a.replayTo(2, emitter);
    const hashA = a.getStateHash();
    a.replayTo(0.5, emitter);
    a.replayTo(2, emitter);
    expect(a.getStateHash()).toBe(hashA);
    expect(hashA).toBe(live.getStateHash());
  });

  it('different seeds give different state', () => {
    const a = createParticlePool({ capacity: 64, seed: 1 });
    const b = createParticlePool({ capacity: 64, seed: 2 });
    a.replayTo(1, emitter);
    b.replayTo(1, emitter);
    expect(a.getStateHash()).not.toBe(b.getStateHash());
  });

  it('clear removes all particles', () => {
    const pool = createParticlePool({ capacity: 8, seed: 1 });
    pool.emit({ count: 5 });
    pool.clear();
    expect(pool.aliveCount()).toBe(0);
    const empty = createParticlePool({ capacity: 8, seed: 1 });
    expect(pool.getStateHash()).toBe(empty.getStateHash());
  });
});
