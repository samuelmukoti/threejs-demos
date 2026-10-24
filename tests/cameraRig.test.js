import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCameraRig, easeInOut } from '../src/camera/cameraRig.js';
import { createSpline } from '../src/animation/splineMotion.js';

const spline = createSpline([
  { x: 0, y: 1, z: 0 },
  { x: 10, y: 1, z: 5 },
  { x: 20, y: 2, z: 0 },
]);
const specA = {
  position: { spline, u0: 0, u1: 1 },
  target: { x: 10, y: 1, z: 0 },
  start: 0, end: 4, fov: 30, fovTo: 50, shake: 0.5, blur: 0.4, ease: 'easeInOut',
};
const specB = {
  position: { x: 5, y: 3, z: 8 },
  target: { x: 0, y: 0, z: 0 },
  fov: 60, shake: 0, blur: 0,
};

const pose = (rig) => rig.getPose({});

describe('cameraRig', () => {
  it('gives the same pose for the same t regardless of history', () => {
    const rig = createCameraRig(new THREE.PerspectiveCamera());
    rig.apply(specA, 1.3);
    const p1 = pose(rig);
    rig.apply(specA, 3.9);
    rig.apply(specB, 0.2);
    rig.apply(specA, 1.3);
    const p2 = pose(rig);
    expect(p2.position.toArray()).toEqual(p1.position.toArray());
    expect(p2.target.toArray()).toEqual(p1.target.toArray());
    expect(p2.fov).toBe(p1.fov);
    const rig2 = createCameraRig(new THREE.PerspectiveCamera());
    rig2.apply(specA, 1.3);
    expect(pose(rig2).position.toArray()).toEqual(p1.position.toArray());
  });

  it('keeps shake amplitude small', () => {
    const rig = createCameraRig(new THREE.PerspectiveCamera());
    const still = { ...specA, shake: 0 };
    let max = 0;
    for (let t = 0; t <= 4; t += 0.05) {
      rig.apply(still, t);
      const a = pose(rig).position.clone();
      rig.apply(specA, t);
      max = Math.max(max, a.distanceTo(pose(rig).position));
    }
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(0.1);
  });

  it('animates fov and moves along the spline', () => {
    const rig = createCameraRig(new THREE.PerspectiveCamera());
    rig.apply({ ...specA, shake: 0 }, 0);
    expect(rig.fov).toBeCloseTo(30);
    expect(pose(rig).position.x).toBeCloseTo(0);
    rig.apply({ ...specA, shake: 0 }, 4);
    expect(rig.fov).toBeCloseTo(50);
    expect(pose(rig).position.x).toBeCloseTo(20, 0);
  });

  it('blends cuts continuously without pose jumps', () => {
    const rig = createCameraRig(new THREE.PerspectiveCamera());
    const cut = { from: specA, start: 2, duration: 0.5, dip: 1 };
    rig.apply(specA, 2 - 1e-6);
    const before = pose(rig);
    rig.apply(specB, 2, cut);
    const atStart = pose(rig);
    expect(atStart.position.distanceTo(before.position)).toBeLessThan(1e-3);
    expect(atStart.dip).toBeCloseTo(0, 5);

    let prev = atStart.position.clone();
    let maxStep = 0;
    let maxDip = 0;
    for (let t = 2; t <= 2.5001; t += 0.01) {
      rig.apply(specB, t, cut);
      const p = pose(rig);
      maxStep = Math.max(maxStep, p.position.distanceTo(prev));
      maxDip = Math.max(maxDip, p.dip);
      prev.copy(p.position);
    }
    expect(maxStep).toBeLessThan(0.5);
    expect(maxDip).toBeGreaterThan(0.9);
    rig.apply(specB, 2.5, cut);
    expect(pose(rig).position.toArray()).toEqual([5, 3, 8]);
    expect(pose(rig).dip).toBe(0);
  });

  it('easeInOut is monotone and bounded', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(-1)).toBe(0);
  });

  it('sets near/far and throws without a camera', () => {
    const cam = new THREE.PerspectiveCamera();
    createCameraRig(cam, { near: 0.02, far: 500 });
    expect(cam.near).toBe(0.02);
    expect(() => createCameraRig(null)).toThrow();
  });
});
