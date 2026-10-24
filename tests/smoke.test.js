import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { settings } from '../src/settings.js';
import { createScene } from '../src/scene/createScene.js';
import { createLighting } from '../src/scene/lighting.js';
import { buildDefaultTimeline } from '../src/animation/chaseTimeline.js';
import { createVehicle } from '../src/vehicles/Vehicle.js';
import { createVehicleEffects } from '../src/vehicles/vehicleEffects.js';
import { simulateRun } from '../src/vehicles/vehiclePhysics.js';
import { createAssetLoader } from '../src/assets/assetLoader.js';
import { createAudioBus } from '../src/audio/audioBus.js';
import { hashValues } from '../src/utils/stateHash.js';

function expectRig(v) {
  expect(v.wheelList).toHaveLength(4);
  expect(v.steeringPivots.length).toBeGreaterThanOrEqual(2);
  expect(v.exhaustEmitter).toBeTruthy();
  expect(v.tireContactPoints).toHaveLength(4);
  expect(v.collisionProxy).toBeTruthy();
  expect(v.root.getObjectByName('collisionProxy')).toBe(v.collisionProxy);
  expect(v.root.getObjectByName('exhaustEmitter')).toBe(v.exhaustEmitter);
}

describe('smoke', () => {
  it('createScene succeeds and the timeline has 10 shots', () => {
    const world = createScene({ seed: 1, settings });
    expect(world.scene.isScene).toBe(true);
    expect(world.handles.spline).toBeTruthy();
    expect(() => world.update(0, 0)).not.toThrow();
    expect(buildDefaultTimeline().shots).toHaveLength(10);
    world.dispose();
  });

  it('both vehicles have the required rig nodes', () => {
    for (const variant of ['lead', 'pursuer']) {
      const v = createVehicle(variant);
      expectRig(v);
      v.dispose();
    }
  });

  it('asset fallback returns a procedural vehicle with rig nodes', async () => {
    const logs = [];
    const assets = createAssetLoader({ baseUrl: '/__missing__/', logger: (...a) => logs.push(a) });
    for (const id of ['lead', 'pursuer']) {
      const group = await assets.loadVehicle(id);
      expect(group.userData.vehicle).toBeTruthy();
      expectRig(group.userData.vehicle);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(() => assets.dispose()).not.toThrow();
  });

  it('dispose runs cleanly and releases tracked geometries and materials', () => {
    const world = createScene({ seed: 3, settings });
    const { scene, handles } = world;
    const lighting = createLighting(scene, settings);
    const bus = createAudioBus();
    const vehicles = [createVehicle('lead'), createVehicle('pursuer')];
    const table = simulateRun(settings.vehicles.lead, handles.spline, { step: 1 / 60, duration: 5, seed: 3 });
    const effects = createVehicleEffects({
      vehicles: [{ id: 'lead', table, vehicle: vehicles[0] }, { id: 'pursuer', table, vehicle: vehicles[1] }],
      seed: 3, audioBus: bus, handles, scene,
    });
    scene.add(...vehicles.map((v) => v.root));
    effects.update(1, 1 / 60);

    const disposedGeo = new Set();
    const disposedMat = new Set();
    const geos = new Set();
    const mats = new Set();
    scene.traverse((o) => {
      if (o.geometry) {
        geos.add(o.geometry);
        o.geometry.addEventListener('dispose', () => disposedGeo.add(o.geometry));
      }
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        mats.add(m);
        m.addEventListener('dispose', () => disposedMat.add(m));
      }
    });
    expect(geos.size).toBeGreaterThan(0);

    expect(() => {
      effects.dispose();
      vehicles.forEach((v) => v.dispose());
      lighting.dispose();
      bus.dispose();
      world.dispose();
    }).not.toThrow();
    expect(() => { effects.dispose(); lighting.dispose(); bus.dispose(); world.dispose(); }).not.toThrow();

    expect(disposedGeo.size).toBeGreaterThan(0);
    expect(disposedMat.size).toBeGreaterThan(0);
    // Everything the scene owned in its world subtree must be released.
    expect(disposedGeo.size).toBe(geos.size);
    expect(disposedMat.size).toBe(mats.size);
  });

  it('hashValues is stable and order sensitive', () => {
    expect(hashValues([1, 2, 'a'])).toBe(hashValues([1, 2, 'a']));
    expect(hashValues([1, 2])).not.toBe(hashValues([2, 1]));
    expect(THREE.REVISION).toBeTruthy();
  });
});
