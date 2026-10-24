import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { settings } from '../src/settings.js';
import { createScene } from '../src/scene/createScene.js';
import { createLighting } from '../src/scene/lighting.js';
import { buildDefaultTimeline } from '../src/animation/chaseTimeline.js';
import { createVehicle } from '../src/vehicles/Vehicle.js';
import { createVehicleState, sampleState, simulateRun } from '../src/vehicles/vehiclePhysics.js';
import { createVehicleEffects } from '../src/vehicles/vehicleEffects.js';
import { createRain } from '../src/effects/rain.js';
import { createCameraRig } from '../src/camera/cameraRig.js';
import { createCinematicCamera } from '../src/camera/cinematicCamera.js';
import { hashValues } from '../src/utils/stateHash.js';

const OFFSET = 14;
const LAG = 1.2;
const TIMES = [0, 3.5, 12, 21.7, 35];

// Headless replica of the main.js simulation wiring (no renderer).
function build(seed) {
  const world = createScene({ seed, settings });
  const { scene, handles } = world;
  const lighting = createLighting(scene, settings);
  const camera = new THREE.PerspectiveCamera(40, 1.6, 0.05, 2000);
  const rig = createCameraRig(camera, { seed });
  const timeline = buildDefaultTimeline();
  const step = settings.timeline.fixedStep;
  const lead = simulateRun(settings.vehicles.lead, handles.spline, {
    step, duration: timeline.duration, seed, startSpeed: 8, startDistance: OFFSET,
  });
  const pursuer = simulateRun(settings.vehicles.pursuer, handles.spline, {
    step, duration: timeline.duration, seed: seed + 1, startSpeed: 8, leader: { table: lead, offset: OFFSET, lag: LAG },
  });
  const states = { lead: createVehicleState(), pursuer: createVehicleState() };
  const sampler = (t, out = states) => {
    sampleState(lead, t, out.lead);
    sampleState(pursuer, t, out.pursuer);
    return out;
  };
  const vehicles = { lead: createVehicle('lead'), pursuer: createVehicle('pursuer') };
  const effects = createVehicleEffects({
    vehicles: [
      { id: 'lead', table: lead, vehicle: vehicles.lead, dimensions: settings.vehicles.lead.dimensions },
      { id: 'pursuer', table: pursuer, vehicle: vehicles.pursuer, dimensions: settings.vehicles.pursuer.dimensions },
    ],
    seed, handles, scene,
  });
  const rain = createRain({ count: 200, maxCount: 200, seed });
  const cinematic = createCinematicCamera({ camera, timeline, vehicleStateSampler: sampler, rig, settings });

  function seek(t) {
    sampler(t, states);
    for (const id of ['lead', 'pursuer']) vehicles[id].applyState(states[id]);
    effects.seek(t);
    lighting.update(t, states);
    const r = cinematic.update(t);
    world.update(t, 0);
    rain.update(t, camera.position);
    const flat = [t];
    const transforms = [];
    for (const id of ['lead', 'pursuer']) {
      const root = vehicles[id].root;
      const s = states[id];
      flat.push(s.position.x, s.position.y, s.position.z, s.yaw, s.roll, s.pitch, s.steer);
      transforms.push([...root.position.toArray(), root.rotation.y]);
      flat.push(...transforms[transforms.length - 1]);
    }
    const pose = rig.getPose({});
    const cam = [...pose.position.toArray(), ...pose.target.toArray(), pose.fov];
    flat.push(...cam);
    const lights = Array.from(lighting.getLightIntensities());
    flat.push(...lights);
    const fx = effects.getStateHash();
    flat.push(r.shot ?? '', fx);
    return { hash: hashValues(flat), fx, lights, cam, transforms };
  }

  function dispose() {
    effects.dispose();
    rain.dispose();
    lighting.dispose();
    Object.values(vehicles).forEach((v) => v.dispose());
    world.dispose();
  }
  return { seek, dispose };
}

describe('determinism', () => {
  it('same seed and t give identical state across instances', () => {
    const a = build(1337);
    const b = build(1337);
    for (const t of TIMES) expect(b.seek(t)).toEqual(a.seek(t));
    a.dispose();
    b.dispose();
  });

  it('seeking forward then backward reproduces the same state', () => {
    const a = build(42);
    const forward = TIMES.map((t) => a.seek(t));
    const backward = [...TIMES].reverse().map((t) => a.seek(t)).reverse();
    expect(backward).toEqual(forward);
    const fresh = build(42);
    expect(fresh.seek(21.7)).toEqual(forward[3]);
    a.dispose();
    fresh.dispose();
  });

  it('different seeds differ for seeded effects', () => {
    const a = build(1);
    const b = build(2);
    const ra = a.seek(21.7);
    const rb = b.seek(21.7);
    expect(rb.fx).not.toBe(ra.fx);
    expect(rb.hash).not.toBe(ra.hash);
    a.dispose();
    b.dispose();
  });
});
