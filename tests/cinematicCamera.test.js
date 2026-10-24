import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCinematicCamera, CAMERA_MODES, SHOT_MODES, modeForShot } from '../src/camera/cinematicCamera.js';
import { createCameraRig } from '../src/camera/cameraRig.js';
import { buildDefaultTimeline } from '../src/animation/chaseTimeline.js';

// Lead drives toward -z at 30 m/s; pursuer follows 12 m behind, with a slight sway.
function sampler(t, states) {
  const sway = Math.sin(t * 0.5) * 2;
  states.lead.position.set(sway, 0, 60 - 30 * t);
  states.lead.heading = Math.PI;
  states.pursuer.position.set(sway * 0.5, 0, 72 - 30 * t);
  states.pursuer.heading = Math.PI + 0.05 * Math.sin(t);
  return states;
}

function make() {
  const camera = new THREE.PerspectiveCamera();
  const timeline = buildDefaultTimeline();
  const rig = createCameraRig(camera);
  const cam = createCinematicCamera({ camera, timeline, vehicleStateSampler: sampler, rig });
  return { cam, timeline };
}

describe('cinematicCamera', () => {
  it('defines 10 modes, all used by the timeline', () => {
    expect(CAMERA_MODES).toHaveLength(10);
    const { timeline } = make();
    const used = new Set();
    for (const s of timeline.shots) {
      for (let i = 0; i < 20; i++) {
        used.add(modeForShot(s.name, i / 20));
      }
      expect(SHOT_MODES[s.name]).toBeDefined();
    }
    expect([...used].sort()).toEqual([...CAMERA_MODES].sort());
  });

  it('matches the mode to the shot at sampled times', () => {
    const { cam } = make();
    const expected = {
      0: 'aerial', 7: 'frontTracking', 12: 'rearChase', 16: 'sideTracking',
      20: 'overheadIntersection', 26: 'tunnel', 31: 'orbitingDrift',
      34: 'wheelLevel', 40: 'craneAway', 43: 'craneAway',
    };
    for (const [t, mode] of Object.entries(expected)) {
      expect(cam.update(Number(t)).mode).toBe(mode);
    }
    expect(cam.update(13.8).mode).toBe('hood');
  });

  it('produces finite poses in every mode', () => {
    const { cam } = make();
    for (const m of CAMERA_MODES) {
      cam.setDebugMode(m);
      for (let t = 0; t <= 44; t += 2.5) {
        const { pose } = cam.update(t);
        for (const v of [...pose.position.toArray(), ...pose.target.toArray(), pose.fov, pose.focusDistance, pose.motionBlur]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
    cam.setDebugMode(null);
    expect(cam.debugMode).toBeNull();
    expect(() => cam.setDebugMode('nope')).toThrow();
  });

  it('is deterministic after forward/backward seeks', () => {
    const { cam } = make();
    const ts = [0, 7, 12, 16, 20, 26, 31, 34, 40, 43];
    const first = ts.map((t) => cam.update(t).pose.position.toArray());
    for (const t of [...ts].reverse()) cam.update(t);
    cam.update(21.3);
    const second = ts.map((t) => cam.update(t).pose.position.toArray());
    expect(second).toEqual(first);
  });
});
