import { describe, it, expect } from 'vitest';
import { createSpline } from '../src/animation/splineMotion.js';
import { settings } from '../src/settings.js';
import { simulateRun, sampleState, createVehicleState } from '../src/vehicles/vehiclePhysics.js';

const straight = () => createSpline([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -400 }, { x: 0, y: 0, z: -800 }]);
// Long straight, then a tight hairpin-ish right turn, then straight.
const withCorner = () => createSpline([
  { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -300 }, { x: 0, y: 0, z: -600 },
  { x: -12, y: 0, z: -630 }, { x: -40, y: 0, z: -640 }, { x: -300, y: 0, z: -640 }, { x: -600, y: 0, z: -640 },
]);
const params = settings.vehicles.lead;
const opts = { step: 1 / 120, duration: 44, seed: 7 };

describe('vehiclePhysics', () => {
  it('never exceeds maxSpeed and accelerates', () => {
    const table = simulateRun(params, straight(), { ...opts, duration: 20 });
    let max = 0;
    for (let i = 0; i < table.count; i++) max = Math.max(max, table.data[i * table.stride + 4]);
    expect(max).toBeLessThanOrEqual(params.maxSpeed);
    expect(max).toBeGreaterThan(params.maxSpeed * 0.5);
  });

  it('brakes before a high-curvature segment', () => {
    const route = withCorner();
    const table = simulateRun(params, route, { ...opts, startSpeed: 50 });
    const out = createVehicleState();
    let peak = 0;
    let sawBrake = false;
    let cornerSpeed = Infinity;
    for (let t = 0; t < table.duration; t += 0.05) {
      sampleState(table, t, out);
      if (out.position.z > -540) peak = Math.max(peak, out.speed);
      if (out.position.z < -560 && out.position.z > -600 && out.braking) sawBrake = true;
      if (out.position.z < -620) cornerSpeed = Math.min(cornerSpeed, out.speed);
    }
    expect(sawBrake).toBe(true);
    expect(cornerSpeed).toBeLessThan(peak * 0.7);
  });

  it('wheel rotation equals distance / radius', () => {
    const table = simulateRun(params, straight(), { ...opts, duration: 10 });
    const out = createVehicleState();
    sampleState(table, 6.3, out);
    expect(out.wheelRotation).toBeCloseTo(out.distance / table.wheelRadius, 6);
    expect(out.distance).toBeGreaterThan(10);
  });

  it('triggers drift above the grip threshold, not on a straight', () => {
    const drift = simulateRun(params, withCorner(), { ...opts, startSpeed: 50 });
    const flat = simulateRun(params, straight(), { ...opts, duration: 10 });
    const out = createVehicleState();
    let drifted = false;
    let maxSlip = 0;
    for (let t = 0; t < drift.duration; t += 0.02) {
      sampleState(drift, t, out);
      if (out.drifting) {
        drifted = true;
        expect(Math.abs(out.lateralAccel)).toBeGreaterThan(params.grip * 9.81 * 0.9);
      }
      maxSlip = Math.max(maxSlip, Math.abs(out.slip));
    }
    expect(drifted).toBe(true);
    expect(maxSlip).toBeGreaterThan(0.05);
    for (let t = 0; t < flat.duration; t += 0.1) {
      expect(sampleState(flat, t, out).drifting).toBe(false);
    }
  });

  it('is deterministic for identical inputs', () => {
    const a = simulateRun(params, withCorner(), opts);
    const b = simulateRun(params, withCorner(), opts);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('seek sampling is stable and order independent', () => {
    const table = simulateRun(params, withCorner(), opts);
    const o1 = createVehicleState();
    const o2 = createVehicleState();
    sampleState(table, 12.345, o1);
    for (const t of [30, 0, 44, 5, 12.345]) sampleState(table, t, o2);
    expect(o2.position.toArray()).toEqual(o1.position.toArray());
    expect(o2.speed).toBe(o1.speed);
    expect(sampleState(table, -5, o1).distance).toBe(sampleState(table, 0, o2).distance);
    expect(Number.isFinite(sampleState(table, 999, o1).speed)).toBe(true);
  });

  it('pursuer trails the lead with offset', () => {
    const route = straight();
    const lead = simulateRun(params, route, { ...opts, startDistance: 30, duration: 20 });
    const chaser = simulateRun(settings.vehicles.pursuer, route, {
      ...opts, duration: 20, leader: { table: lead, offset: 12, lag: 0.3 },
    });
    const a = createVehicleState();
    const b = createVehicleState();
    sampleState(lead, 19, a);
    sampleState(chaser, 19, b);
    expect(b.distance).toBeLessThan(a.distance);
    expect(a.distance - b.distance).toBeLessThan(40);
  });
});
