import * as THREE from 'three';
import { createVehicleState } from '../vehicles/vehiclePhysics.js';

// Cinematic camera director. Every mode builds a pose spec relative to the
// sampled vehicle states, so the result is a pure function of t (no history).

export const CAMERA_MODES = [
  'aerial', 'frontTracking', 'rearChase', 'sideTracking', 'hood', 'wheelLevel',
  'overheadIntersection', 'tunnel', 'orbitingDrift', 'craneAway',
];

// Shot -> mode. `until` (shot-local progress 0..1) lets a shot hand over to a
// second mode; entries are checked in order.
export const SHOT_MODES = {
  establishing: [{ mode: 'aerial' }],
  leadReveal: [{ mode: 'frontTracking' }],
  pursuit: [{ mode: 'rearChase', until: 0.7 }, { mode: 'hood' }],
  sideBySide: [{ mode: 'sideTracking' }],
  intersection: [{ mode: 'overheadIntersection' }],
  tunnel: [{ mode: 'tunnel' }],
  drift: [{ mode: 'orbitingDrift' }],
  nearMiss: [{ mode: 'wheelLevel' }],
  escape: [{ mode: 'craneAway' }],
  endFrame: [{ mode: 'craneAway', hold: true }],
};

export function modeForShot(name, progress = 0) {
  const entries = SHOT_MODES[name];
  if (!entries) return null;
  for (const e of entries) {
    if (e.until === undefined || progress < e.until) return e.mode;
  }
  return entries[entries.length - 1].mode;
}

const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (x) => { const f = x < 0 ? 0 : x > 1 ? 1 : x; return f * f * (3 - 2 * f); };

export function createCinematicCamera({
  camera, timeline, vehicleStateSampler, rig, settings = null,
} = {}) {
  if (!camera) throw new Error('createCinematicCamera needs a camera');
  if (!timeline || typeof timeline.evaluate !== 'function') throw new Error('createCinematicCamera needs a timeline');
  if (!rig || typeof rig.apply !== 'function') throw new Error('createCinematicCamera needs a rig');
  const sample = typeof vehicleStateSampler === 'function'
    ? vehicleStateSampler
    : vehicleStateSampler && vehicleStateSampler.sample && vehicleStateSampler.sample.bind(vehicleStateSampler);
  if (!sample) throw new Error('createCinematicCamera needs a vehicleStateSampler');

  let debugMode = null;
  const states = { lead: createVehicleState(), pursuer: createVehicleState() };
  const pos = { x: 0, y: 0, z: 0 };
  const tgt = { x: 0, y: 0, z: 0 };
  const L = new THREE.Vector3();
  const P = new THREE.Vector3();
  const M = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const spec = { position: pos, target: tgt, fov: 40, focus: 10, blur: 0, shake: 0, start: 0, end: 1 };

  // Copy whatever the sampler returned into our own states (it may reuse objects).
  function readStates(t) {
    const r = sample(t, states);
    const lead = r?.lead ?? states.lead;
    const pursuer = r?.pursuer ?? states.pursuer;
    L.copy(lead.position);
    P.copy(pursuer.position);
    return { lead, pursuer };
  }

  const set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; };
  const forwardOf = (h) => fwd.set(Math.sin(h), 0, Math.cos(h));
  const rightOf = () => right.set(-fwd.z, 0, fwd.x);

  // Each mode fills pos/tgt and returns { fov, blur, shake, focus? }.
  // c = { lead, pursuer, p (shot progress 0..1), t, span, gap, shotName }
  const MODES = {
    aerial(c) {
      forwardOf(c.lead.heading); rightOf();
      const h = lerp(46, 30, smooth(c.p)) + c.span * 0.4;
      set(pos, M.x + right.x * 18 - fwd.x * 14, h, M.z + right.z * 18 - fwd.z * 14);
      set(tgt, M.x + fwd.x * 6, 0, M.z + fwd.z * 6);
      return { fov: 42, blur: 0.1, shake: 0.1 };
    },
    frontTracking(c) {
      forwardOf(c.lead.heading); rightOf();
      const d = 9 + c.span * 0.2;
      const side = lerp(2.5, -1.5, smooth(c.p));
      set(pos, L.x + fwd.x * d + right.x * side, 1.0, L.z + fwd.z * d + right.z * side);
      set(tgt, L.x, 0.8, L.z);
      return { fov: 38, blur: 0.35, shake: 0.35 };
    },
    rearChase(c) {
      forwardOf(c.pursuer.heading); rightOf();
      const d = 8 + c.gap * 0.15;
      set(pos, P.x - fwd.x * d + right.x * 1.2, 2.2, P.z - fwd.z * d + right.z * 1.2);
      set(tgt, lerp(P.x, L.x, 0.75), 1.0, lerp(P.z, L.z, 0.75));
      return { fov: 46, blur: 0.5, shake: 0.5 };
    },
    sideTracking(c) {
      forwardOf(c.lead.heading); rightOf();
      const d = 7 + c.span * 0.9;
      set(pos, M.x + right.x * d, 1.3, M.z + right.z * d);
      set(tgt, M.x, 0.8, M.z);
      return { fov: 34, blur: 0.6, shake: 0.3 };
    },
    hood(c) {
      forwardOf(c.pursuer.heading);
      set(pos, P.x + fwd.x * 1.3, 1.25, P.z + fwd.z * 1.3);
      set(tgt, L.x, 0.9, L.z);
      return { fov: 62, blur: 0.8, shake: 0.7 };
    },
    wheelLevel(c) {
      forwardOf(c.pursuer.heading); rightOf();
      const f = smooth(c.p);
      set(pos, P.x + right.x * 1.6 + fwd.x * lerp(1.5, -1, f), 0.28, P.z + right.z * 1.6 + fwd.z * lerp(1.5, -1, f));
      set(tgt, lerp(P.x, L.x, 0.6), 0.5, lerp(P.z, L.z, 0.6));
      return { fov: 55, blur: 0.9, shake: 0.6 };
    },
    overheadIntersection(c) {
      set(pos, M.x + 4, 32 + c.span * 0.5, M.z + 4);
      set(tgt, M.x, 0, M.z);
      return { fov: 50, blur: 0.2, shake: 0.1 };
    },
    tunnel(c) {
      forwardOf(c.pursuer.heading); rightOf();
      const d = 6 + c.gap * 0.2;
      set(pos, P.x - fwd.x * d - right.x * 0.8, 1.4, P.z - fwd.z * d - right.z * 0.8);
      set(tgt, lerp(P.x, L.x, 0.7), 1.1, lerp(P.z, L.z, 0.7));
      return { fov: 70, blur: 0.7, shake: 0.5 };
    },
    orbitingDrift(c) {
      const a = 0.6 + c.p * 1.8;
      const r = 8 + c.span * 0.8;
      set(pos, M.x + Math.sin(a) * r, 2.0 + c.p * 1.5, M.z + Math.cos(a) * r);
      set(tgt, M.x, 0.8, M.z);
      return { fov: 45, blur: 0.5, shake: 0.4 };
    },
    craneAway(c) {
      forwardOf(c.pursuer.heading); rightOf();
      const u = smooth(c.shotName === 'endFrame' ? 1 : c.p * 0.85);
      const d = 12 + c.span * 0.5 + u * 30;
      set(pos, M.x - fwd.x * d + right.x * u * 6, 3 + u * 22, M.z - fwd.z * d + right.z * u * 6);
      set(tgt, M.x + fwd.x * 4, 0.8, M.z + fwd.z * 4);
      return { fov: lerp(40, 32, u), blur: 0.15, shake: c.shotName === 'endFrame' ? 0 : 0.15 };
    },
  };

  function update(t) {
    const { shot, localProgress } = timeline.evaluate(t);
    const tt = Number.isFinite(t) ? t : 0;
    const { lead, pursuer } = readStates(tt);
    M.addVectors(L, P).multiplyScalar(0.5);
    const gap = L.distanceTo(P);
    const shotName = shot ? shot.name : null;
    const mode = debugMode || modeForShot(shotName, localProgress) || 'aerial';
    const out = MODES[mode]({
      lead, pursuer, p: localProgress, t: tt, gap, span: Math.min(gap, 40), shotName,
    });
    spec.fov = out.fov;
    spec.blur = out.blur;
    spec.shake = out.shake;
    spec.focus = out.focus ?? Math.hypot(tgt.x - pos.x, tgt.y - pos.y, tgt.z - pos.z);
    rig.apply(spec, tt);
    return { mode, shot: shotName, localProgress, pose: rig.getPose({}) };
  }

  return {
    update,
    modes: CAMERA_MODES,
    modeForShot,
    settings,
    get debugMode() { return debugMode; },
    setDebugMode(name) {
      if (name !== null && name !== undefined && !MODES[name]) throw new Error(`Unknown camera mode: ${name}`);
      debugMode = name ?? null;
    },
  };
}
