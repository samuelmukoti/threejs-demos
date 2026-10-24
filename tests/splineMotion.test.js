import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSpline } from '../src/animation/splineMotion.js';

// Straight run along +z for 0..40, then a sharp turn to +x.
const pts = [
  [0, 0, 0], [0, 0, 10], [0, 0, 20], [0, 0, 30], [0, 0, 40],
  [1, 0, 41], [3, 0, 42], [13, 0, 42], [23, 0, 42], [33, 0, 42],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

describe('splineMotion', () => {
  const sp = createSpline(pts);

  it('hits the endpoints', () => {
    const o = new THREE.Vector3();
    expect(sp.getPointAt(0, o).distanceTo(pts[0])).toBeLessThan(1e-6);
    expect(sp.getPointAt(1, o).distanceTo(pts[pts.length - 1])).toBeLessThan(1e-6);
    expect(sp.lengthAt(0)).toBe(0);
    expect(sp.lengthAt(1)).toBeCloseTo(sp.length, 9);
  });

  it('has monotonic arc length and round-trips distance', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const l = sp.lengthAt(i / 100);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    expect(sp.uAtDistance(sp.lengthAt(0.37))).toBeCloseTo(0.37, 9);
  });

  it('advances roughly uniformly in distance per u step', () => {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const steps = [];
    for (let i = 0; i < 20; i++) {
      sp.getPointAt(i / 20, a); sp.getPointAt((i + 1) / 20, b);
      steps.push(a.distanceTo(b));
    }
    expect(Math.min(...steps)).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBeLessThan((sp.length / 20) * 1.05);
  });

  it('returns normalised tangents', () => {
    const o = new THREE.Vector3();
    for (let i = 0; i <= 50; i++) {
      expect(sp.getTangentAt(i / 50, o).length()).toBeCloseTo(1, 6);
    }
    expect(sp.getTangentAt(0.05, o).z).toBeGreaterThan(0.99);
  });

  it('has finite non-negative curvature, higher at the turn than on the straight', () => {
    for (let i = 0; i <= 50; i++) {
      const k = sp.getCurvatureAt(i / 50);
      expect(Number.isFinite(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
    }
    let best = 0;
    for (let i = 0; i <= 100; i++) best = Math.max(best, sp.getCurvatureAt(i / 100));
    expect(sp.getCurvatureAt(0.1)).toBeLessThan(0.01);
    expect(best).toBeGreaterThan(sp.getCurvatureAt(0.1) * 10);
  });

  it('lookahead sees the upcoming turn', () => {
    const straight = sp.maxCurvatureAhead(0, 10);
    const ahead = sp.maxCurvatureAhead(0, sp.length);
    expect(ahead).toBeGreaterThan(straight * 10);
  });

  it('supports closed splines', () => {
    const loop = createSpline(
      [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      { closed: true }
    );
    const o = new THREE.Vector3();
    expect(loop.getPointAt(0, o).distanceTo(loop.getPointAt(1, new THREE.Vector3()))).toBeLessThan(1e-6);
    expect(Number.isFinite(loop.getCurvatureAt(0))).toBe(true);
  });

  it('rejects too few points', () => {
    expect(() => createSpline([new THREE.Vector3()])).toThrow();
  });
});
