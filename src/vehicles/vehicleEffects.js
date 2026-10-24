import * as THREE from 'three';
import { settings } from '../settings.js';
import { createParticlePool } from '../effects/particles.js';
import { createTireSmoke, createEmitterGroup, countFor, mixSeed } from '../effects/tireSmoke.js';
import { createSparks } from '../effects/sparks.js';
import { createVehicleState, sampleState } from './vehiclePhysics.js';

// Hooks the vehicle state tables to the pooled effects (tire spray, drift smoke, exhaust
// vapor, near-miss sparks, sewer steam) and to the audio bus. Everything is derived from
// the precomputed state tables and a fixed event list, so the same t always yields the
// same particles and the same audio events. Effects advance on a fixed 1/60 s step
// (the particle pool step) regardless of the caller's dt; seek(t) rebuilds the pools.

const STEP = 1 / 60;
const EPS = 1e-6;
const AUDIO_EVERY = 6; // engine/squeal/brake events every 6 steps (10 Hz)
const RAIN_EVERY = 60; // rain event once per second
const GEARS = 6;
const IDLE_RPM = 1100;
const REDLINE_RPM = 7200;
const SQUEAL_ON = 0.2;
const BRAKE_MIN_SPEED = 3;
const MAX_SLIP = 0.5; // vehiclePhysics clamps |slip| to this

const DEFAULT_NEAR_MISS = { time: 34, duration: 0.7, vehicleId: 'pursuer', side: -1, strength: 1 };

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function setLocal(out, x, y, z, yaw, origin) {
  // Rotation about +y by `yaw`, matching Object3D.rotation.y.
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.set(origin.x + x * c + z * s, origin.y + y, origin.z - x * s + z * c);
  return out;
}

function defaultOffsets(dimensions = {}) {
  const L = dimensions.length ?? 4.5;
  const W = dimensions.width ?? 1.85;
  const wheelbase = L * 0.6;
  const track = W / 2 - 0.1;
  return {
    exhaust: [0, 0.2, -L / 2 - 0.1],
    wheels: [
      [track, 0, wheelbase / 2], [-track, 0, wheelbase / 2],
      [track, 0, -wheelbase / 2], [-track, 0, -wheelbase / 2],
    ],
  };
}

// Body-local exhaust and wheel-contact offsets, read once from the rig (if any).
function readOffsets(entry) {
  const fallback = defaultOffsets(entry.vehicle?.dimensions ?? entry.dimensions);
  const rig = entry.vehicle;
  const exhaust = rig?.exhaustEmitter
    ? [rig.exhaustEmitter.position.x, rig.exhaustEmitter.position.y, rig.exhaustEmitter.position.z]
    : fallback.exhaust;
  const wheels = rig?.suspensionNodes?.length === 4
    ? rig.suspensionNodes.map((n) => [n.position.x, 0, n.position.z])
    : fallback.wheels;
  return { exhaust: entry.exhaustOffset ?? exhaust, wheels: entry.wheelOffsets ?? wheels };
}

/**
 * @param vehicles array of { id, table, vehicle?, dimensions?, exhaustOffset?, wheelOffsets? }
 *   `table` comes from simulateRun; `vehicle` (optional) is the Vehicle rig the emitter and
 *   wheel-contact offsets are read from. Order: wheels are FL, FR, RL, RR.
 * @param tireSmoke optional prebuilt createTireSmoke (its getWheels should be this.getWheels)
 * @param sparks optional prebuilt createSparks (its getContact should be this.getNearMissContact)
 * @param exhaust optional prebuilt createParticlePool for exhaust vapor
 * @param audioBus optional { emit(name, payload) }
 * @param handles optional scene handles: { steamVents, tunnel: { zStart, zEnd } }
 * @param scene optional Object3D the particle systems are added to
 */
export function createVehicleEffects({
  vehicles = [],
  seed = 1,
  tireSmoke = null,
  sparks = null,
  exhaust = null,
  audioBus = null,
  handles = {},
  scene = null,
  nearMiss = {},
  steamVents = null,
  tunnel = null,
  bpm = 96,
  maxSpeed = settings.vehicles?.lead?.maxSpeed ?? 62,
  exhaustRate = 26,
  texture = null,
} = {}) {
  if (!Array.isArray(vehicles) || vehicles.length === 0) throw new Error('createVehicleEffects: vehicles must be a non-empty array');
  for (const v of vehicles) {
    if (!v || !v.table || !v.table.data) throw new Error('createVehicleEffects: every vehicle needs a table from simulateRun');
  }
  if (!(bpm > 0)) throw new Error('createVehicleEffects: bpm must be > 0');

  const entries = vehicles.map((v, i) => ({
    id: v.id ?? v.vehicle?.variant ?? `vehicle${i}`,
    table: v.table,
    offsets: readOffsets(v),
    halfWidth: (v.vehicle?.dimensions ?? v.dimensions)?.width / 2 || 0.93,
    state: createVehicleState(),
    next: createVehicleState(),
    wheels: [0, 1, 2, 3].map(() => ({ position: new THREE.Vector3(), slip: 0, speed: 0, grounded: true })),
    // audio bookkeeping (derived from t, rebuilt on seek)
    gear: 1,
    squealing: false,
    braking: false,
  }));
  const wheelList = entries.flatMap((e) => e.wheels);
  const primary = entries[0];

  const event = { ...DEFAULT_NEAR_MISS, ...nearMiss };
  const nearEntry = entries.find((e) => e.id === event.vehicleId) ?? entries[entries.length - 1];
  const vents = steamVents ?? handles.steamVents ?? [];
  const tunnelRange = tunnel
    ?? (handles.tunnel ? { zStart: handles.tunnel.zStart, zEnd: handles.tunnel.zEnd } : null)
    ?? (settings.route?.tunnel?.length >= 2
      ? { zStart: settings.route.tunnel[0][1], zEnd: settings.route.tunnel[settings.route.tunnel.length - 1][1] }
      : null);
  const ventPositions = vents.map((v) => v.position ?? v);

  // ---- pure-in-t samplers ---------------------------------------------------
  const _origin = new THREE.Vector3();
  let wheelsT = NaN;

  function getWheels(t) {
    if (t === wheelsT) return wheelList;
    wheelsT = t;
    for (const e of entries) {
      const s = sampleState(e.table, t, e.state);
      const rearSlip = clamp(Math.abs(s.slip) / MAX_SLIP, 0, 1);
      const brakeSlip = s.speed > 15 ? s.brakeIntensity * 0.3 : 0;
      for (let w = 0; w < 4; w++) {
        const o = e.offsets.wheels[w];
        const wheel = e.wheels[w];
        setLocal(wheel.position, o[0], 0.05, o[2], s.yaw, s.position);
        wheel.speed = s.speed;
        wheel.slip = clamp(rearSlip * (w < 2 ? 0.7 : 1) + brakeSlip, 0, 1.5);
        wheel.grounded = true;
      }
    }
    return wheelList;
  }

  const _contact = { position: new THREE.Vector3(), direction: new THREE.Vector3() };
  function getNearMissContact(t) {
    const s = sampleState(nearEntry.table, t, nearEntry.state);
    _origin.copy(s.position);
    setLocal(_contact.position, event.side * nearEntry.halfWidth, 0.5, 0, s.heading, _origin);
    _contact.direction.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    return _contact;
  }

  // ---- particle systems -----------------------------------------------------
  const owned = [];
  const smokeSys = tireSmoke ?? createTireSmoke({ seed: mixSeed(seed, 1), getWheels, texture });
  const sparkSys = sparks ?? createSparks({
    seed: mixSeed(seed, 2),
    eventTime: event.time,
    duration: event.duration,
    getContact: getNearMissContact,
    steamVents: ventPositions,
    texture,
  });
  if (!tireSmoke) owned.push(smokeSys);
  if (!sparks) owned.push(sparkSys);

  const exhaustPool = exhaust ?? createParticlePool({
    capacity: 500,
    lifetime: 2,
    seed: mixSeed(seed, 3),
    size: 0.5,
    gravity: [0, 0.25, 0],
    drag: 1.1,
    texture,
    blending: THREE.NormalBlending,
    renderOrder: 10,
  });
  const exhaustSpec = {
    count: 1, position: [0, 0, 0], velocity: [0, 0, 0], spread: 0.25, positionSpread: 0.05,
    color: [0.78, 0.8, 0.84, 0.28], lifetime: 1, size: 0.4,
  };
  const _p = new THREE.Vector3();
  const _a = createVehicleState();
  const _b = createVehicleState();

  function throttleAt(e, t) {
    // Throttle proxy: forward acceleration over one step, 0.25 at cruise.
    sampleState(e.table, t, _a);
    sampleState(e.table, t + STEP, _b);
    const accel = (_b.speed - _a.speed) / STEP;
    return _a.braking ? 0 : clamp(0.25 + accel / 18, 0, 1);
  }

  function emitExhaust(pool, t, step, rng) {
    for (const e of entries) {
      const s = sampleState(e.table, t, e.state);
      if (s.speed <= 0 && t > 1) continue; // parked at the end of the route
      const throttle = throttleAt(e, t);
      const n = countFor(exhaustRate * (0.4 + throttle), step, rng);
      if (n === 0) continue;
      const o = e.offsets.exhaust;
      setLocal(_p, o[0], o[1], o[2], s.yaw, s.position);
      exhaustSpec.count = n;
      exhaustSpec.position[0] = _p.x; exhaustSpec.position[1] = _p.y; exhaustSpec.position[2] = _p.z;
      const back = -(1.2 + s.speed * 0.02); // streams backwards along the heading
      exhaustSpec.velocity[0] = Math.sin(s.yaw) * back;
      exhaustSpec.velocity[1] = 0.3;
      exhaustSpec.velocity[2] = Math.cos(s.yaw) * back;
      exhaustSpec.lifetime = 1 + rng() * 0.8;
      exhaustSpec.size = 0.3 + rng() * 0.3 + throttle * 0.2;
      pool.emit(exhaustSpec);
    }
  }

  const exhaustGroup = createEmitterGroup([{ pool: exhaustPool, emit: emitExhaust }], mixSeed(seed, 4));
  if (!exhaust) owned.push({ dispose: exhaustGroup.dispose });

  const objects = [...smokeSys.objects, ...sparkSys.objects, exhaustPool.object];
  if (scene) for (const o of objects) scene.add(o);

  // ---- audio ----------------------------------------------------------------
  function emitAudio(name, payload) {
    if (audioBus) audioBus.emit(name, payload);
  }

  function gearFor(speed) {
    return clamp(1 + Math.floor((speed / maxSpeed) * GEARS), 1, GEARS);
  }

  function rpmFor(speed, gear, throttle) {
    const width = maxSpeed / GEARS;
    const f = clamp((speed - (gear - 1) * width) / width, 0, 1);
    return Math.round(IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * clamp(0.3 + 0.55 * f + 0.15 * throttle, 0, 1));
  }

  const inTunnel = (z) => !!tunnelRange && z <= tunnelRange.zStart && z >= tunnelRange.zEnd;
  const beatAt = (t) => Math.floor((t * bpm) / 60 + EPS);

  let tunnelInside = false;
  let lastBeat = -1;
  let nearFired = false;

  // Sets audio bookkeeping to the values implied by time t without emitting anything.
  function syncAudioState(t) {
    for (const e of entries) {
      const s = sampleState(e.table, t, e.state);
      e.gear = gearFor(s.speed);
      e.squealing = Math.abs(s.slip) / MAX_SLIP > SQUEAL_ON;
      e.braking = s.braking && s.speed > BRAKE_MIN_SPEED;
    }
    tunnelInside = inTunnel(sampleState(primary.table, t, primary.state).position.z);
    lastBeat = beatAt(t);
    nearFired = t >= event.time;
  }

  function audioStep(idx, t) {
    const periodic = idx % AUDIO_EVERY === 0;
    for (const e of entries) {
      const s = sampleState(e.table, t, e.state);
      const gear = gearFor(s.speed);
      if (gear !== e.gear) {
        e.gear = gear;
        emitAudio('gearChange', { vehicleId: e.id, gear });
      }
      const squeal = Math.min(1, Math.abs(s.slip) / MAX_SLIP);
      const squealNow = squeal > SQUEAL_ON;
      if (squealNow && (periodic || !e.squealing)) emitAudio('tireSqueal', { vehicleId: e.id, slip: squeal });
      e.squealing = squealNow;
      const brakeNow = s.braking && s.speed > BRAKE_MIN_SPEED;
      if (brakeNow && (periodic || !e.braking)) emitAudio('brake', { vehicleId: e.id, intensity: s.brakeIntensity });
      e.braking = brakeNow;
      if (periodic) {
        const throttle = throttleAt(e, t);
        emitAudio('engine', { vehicleId: e.id, rpm: rpmFor(s.speed, gear, throttle), throttle, speed: s.speed });
      }
    }

    const inside = inTunnel(sampleState(primary.table, t, primary.state).position.z);
    if (inside !== tunnelInside) {
      tunnelInside = inside;
      emitAudio('tunnel', { inside, wetness: settings.rain?.wetness ?? 0.85 });
    }

    if (idx % RAIN_EVERY === 0) {
      emitAudio('rain', { intensity: (settings.rain?.intensity ?? 1) * (tunnelInside ? 0.15 : 1) });
    }

    if (!nearFired && t >= event.time) {
      nearFired = true;
      const s = sampleState(nearEntry.table, t, nearEntry.state);
      emitAudio('impact', { vehicleId: nearEntry.id, position: s.position.clone(), strength: event.strength });
    }

    const beat = beatAt(t);
    if (beat !== lastBeat) {
      lastBeat = beat;
      emitAudio('beat', { index: beat, t: (beat * 60) / bpm });
    }
  }

  // ---- fixed-step driver ------------------------------------------------------
  let stepIndex = 0;
  let disposed = false;

  function advance(idx) {
    const t = idx * STEP;
    smokeSys.update(t, STEP);
    sparkSys.update(t, STEP);
    exhaustGroup.update(t, STEP);
    audioStep(idx, t);
  }

  function seek(t) {
    if (disposed) return;
    const idx = Math.max(0, Math.floor(t / STEP + EPS));
    const tq = idx * STEP;
    stepIndex = idx;
    wheelsT = NaN;
    smokeSys.replayTo(tq);
    sparkSys.replayTo(tq);
    exhaustGroup.replayTo(tq);
    // Non-marker audio is suppressed while seeking; only the current beat marker is emitted.
    syncAudioState(tq);
    emitAudio('beat', { index: lastBeat, t: (lastBeat * 60) / bpm });
  }

  function update(t, dt = STEP) {
    if (disposed) return;
    const target = Math.max(0, Math.floor(t / STEP + EPS));
    const gap = target - stepIndex;
    // Backwards or large jumps are scrubs, not playback: rebuild instead of stepping.
    if (gap < 0 || gap * STEP > Math.max(0.5, dt * 4)) {
      seek(t);
      return;
    }
    while (stepIndex < target) {
      stepIndex++;
      advance(stepIndex);
    }
  }

  function reset() {
    if (disposed) return;
    smokeSys.clear();
    sparkSys.clear();
    exhaustGroup.clear();
    stepIndex = 0;
    wheelsT = NaN;
    syncAudioState(0);
    lastBeat = -1; // so the first beat marker fires on playback
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const o of objects) o.removeFromParent();
    for (const s of owned) s.dispose();
  }

  function getStateHash() {
    return [smokeSys.getStateHash(), sparkSys.getStateHash(), exhaustGroup.getStateHash()].join('|');
  }

  syncAudioState(0);
  lastBeat = -1;

  return {
    objects,
    tireSmoke: smokeSys,
    sparks: sparkSys,
    exhaust: exhaustPool,
    getWheels,
    getNearMissContact,
    update,
    seek,
    reset,
    dispose,
    getStateHash,
    get time() { return stepIndex * STEP; },
  };
}
