import { describe, it, expect } from 'vitest';
import { createSpline } from '../src/animation/splineMotion.js';
import { settings } from '../src/settings.js';
import { simulateRun } from '../src/vehicles/vehiclePhysics.js';
import { createVehicleEffects } from '../src/vehicles/vehicleEffects.js';

const route = () => createSpline([
  { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -300 }, { x: 0, y: 0, z: -600 },
  { x: -12, y: 0, z: -630 }, { x: -40, y: 0, z: -640 }, { x: -300, y: 0, z: -640 },
]);
const make = (events) => {
  const table = simulateRun(settings.vehicles.lead, route(), { step: 1 / 120, duration: 44, seed: 3 });
  const bus = { emit: (n, p) => events.push([n, p]) };
  return createVehicleEffects({ vehicles: [{ id: 'lead', table }, { id: 'pursuer', table }], audioBus: bus, seed: 5 });
};

describe('vehicleEffects', () => {
  it('seek reproduces live playback state', () => {
    const live = make([]);
    for (let i = 1; i <= 10 * 120; i++) live.update(i / 120, 1 / 120);
    const hash = live.getStateHash();
    const other = make([]);
    other.seek(10);
    expect(other.getStateHash()).toBe(hash);
    other.seek(5); other.seek(10);
    expect(other.getStateHash()).toBe(hash);
    expect(live.exhaust.aliveCount()).toBeGreaterThan(0);
    expect(other.exhaust.aliveCount()).toBe(live.exhaust.aliveCount());
  });

  it('emits deterministic audio and only beat markers on seek', () => {
    const a = []; const b = [];
    const fa = make(a); const fb = make(b);
    for (let i = 1; i <= 35 * 120; i++) { fa.update(i / 120, 1 / 120); fb.update(i / 120, 1 / 120); }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const names = new Set(a.map((e) => e[0]));
    for (const n of ['engine', 'gearChange', 'rain', 'beat', 'impact']) expect(names.has(n)).toBe(true);
    a.length = 0;
    fa.seek(12);
    expect(a.map((e) => e[0])).toEqual(['beat']);
  });

  it('rejects empty vehicles and disposes cleanly', () => {
    expect(() => createVehicleEffects({ vehicles: [] })).toThrow();
    const fx = make([]);
    fx.dispose();
    fx.update(1, 1 / 60);
  });
});
