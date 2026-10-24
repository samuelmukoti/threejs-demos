import * as THREE from 'three';
import { mulberry32 } from '../utils/prng.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, f) => a + (b - a) * f;

export const easeInOut = (x) => {
  const f = clamp01(x);
  return f * f * f * (f * (f * 6 - 15) + 10); // smootherstep
};
export const easeIn = (x) => { const f = clamp01(x); return f * f; };
export const easeOut = (x) => { const f = clamp01(x); return 1 - (1 - f) * (1 - f); };
export const EASINGS = { linear: clamp01, easeIn, easeOut, easeInOut };

const SHAKE_TERMS = 3;
const SHAKE_UNITS = 0.03; // world units of positional shake at shake = 1
const SHAKE_ANGLE = 0.004; // radians-ish offset of target per unit distance at shake = 1

/**
 * Pose spec (all fields optional except position/target):
 *   position / target: { x, y, z } | Vector3 | { spline, u0, u1 } (spline from createSpline)
 *   start, end: shot time range in seconds (progress along spline/fov/focus)
 *   ease: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' (default 'linear')
 *   fov, fovTo: vertical field of view in degrees (animated over the shot)
 *   focus, focusTo: DOF focus distance (default: distance to target)
 *   shake: 0..1 shake amount, blur: 0..1 motion-blur intensity
 *
 * Cut blend (optional 3rd arg of apply): { from: poseSpec, start, duration, dip }
 *   Blends pose from `from` into `spec` over [start, start + duration] with an
 *   eased weight; `dip` (0..1) peaks mid-cut for a fade/dip overlay.
 */
export function createCameraRig(camera, { seed = 1, near = 0.05, far = 2000 } = {}) {
  if (!camera) throw new Error('createCameraRig needs a camera');
  camera.near = near;
  camera.far = far;

  const rng = mulberry32(seed);
  const shakeFreq = new Float64Array(SHAKE_TERMS * 3);
  const shakePhase = new Float64Array(SHAKE_TERMS * 3);
  for (let i = 0; i < shakeFreq.length; i++) {
    shakeFreq[i] = 0.7 + rng() * 5.3;
    shakePhase[i] = rng() * Math.PI * 2;
  }
  const shakeAt = (axis, t) => {
    let s = 0;
    for (let k = 0; k < SHAKE_TERMS; k++) {
      const i = axis * SHAKE_TERMS + k;
      s += Math.sin(t * shakeFreq[i] + shakePhase[i]);
    }
    return s / SHAKE_TERMS; // [-1, 1]
  };

  const pos = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const posB = new THREE.Vector3();
  const tgtB = new THREE.Vector3();
  const state = { fov: camera.fov, focus: 10, blur: 0, dip: 0, shake: 0 };
  const stateB = { fov: 0, focus: 0, blur: 0, shake: 0 };

  function evalChannel(ch, f, out) {
    if (!ch) throw new Error('pose spec needs position and target');
    if (ch.spline) {
      const u0 = ch.u0 ?? 0;
      const u1 = ch.u1 ?? 1;
      ch.spline.getPointAt(lerp(u0, u1, f), out);
    } else {
      out.set(ch.x, ch.y, ch.z);
    }
    return out;
  }

  function evalSpec(spec, t, p, g, s) {
    const span = (spec.end ?? 0) - (spec.start ?? 0);
    const lin = span > 0 ? clamp01((t - (spec.start ?? 0)) / span) : 0;
    const f = (EASINGS[spec.ease] || clamp01)(lin);
    evalChannel(spec.position, f, p);
    evalChannel(spec.target, f, g);
    const fov = spec.fov ?? 40;
    s.fov = lerp(fov, spec.fovTo ?? fov, f);
    const focusFrom = spec.focus ?? p.distanceTo(g);
    s.focus = lerp(focusFrom, spec.focusTo ?? focusFrom, f);
    s.blur = spec.blur ?? 0;
    s.shake = spec.shake ?? 0;
  }

  function apply(spec, t, cut) {
    evalSpec(spec, t, pos, tgt, state);
    state.dip = 0;
    if (cut && cut.from && cut.duration > 0 && t < cut.start + cut.duration) {
      const w = easeInOut((t - cut.start) / cut.duration);
      if (t < cut.start + cut.duration) {
        evalSpec(cut.from, t, posB, tgtB, stateB);
        pos.lerpVectors(posB, pos, w);
        tgt.lerpVectors(tgtB, tgt, w);
        state.fov = lerp(stateB.fov, state.fov, w);
        state.focus = lerp(stateB.focus, state.focus, w);
        state.blur = lerp(stateB.blur, state.blur, w);
        state.shake = lerp(stateB.shake, state.shake, w);
        const raw = clamp01((t - cut.start) / cut.duration);
        state.dip = (cut.dip ?? 0) * Math.sin(Math.PI * raw);
      }
    }
    if (state.shake > 0) {
      const a = state.shake;
      pos.x += shakeAt(0, t) * SHAKE_UNITS * a;
      pos.y += shakeAt(1, t) * SHAKE_UNITS * a;
      pos.z += shakeAt(2, t) * SHAKE_UNITS * a;
      const dist = Math.max(pos.distanceTo(tgt), 1e-3);
      const o = SHAKE_ANGLE * dist * a;
      tgt.x += shakeAt(1, t + 11.3) * o;
      tgt.y += shakeAt(2, t + 5.7) * o;
      tgt.z += shakeAt(0, t + 3.1) * o;
    }

    camera.position.copy(pos);
    camera.lookAt(tgt);
    if (Math.abs(camera.fov - state.fov) > 1e-9) {
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    return api;
  }

  /** Writes the current pose into `out` (for state hashing). */
  function getPose(out = {}) {
    out.position = out.position || new THREE.Vector3();
    out.target = out.target || new THREE.Vector3();
    out.position.copy(pos);
    out.target.copy(tgt);
    out.fov = state.fov;
    out.focusDistance = state.focus;
    out.motionBlur = state.blur;
    out.dip = state.dip;
    return out;
  }

  const api = {
    camera,
    apply,
    getPose,
    get focusDistance() { return state.focus; },
    get motionBlur() { return state.blur; },
    get dip() { return state.dip; },
    get fov() { return state.fov; },
    easeInOut,
    easeIn,
    easeOut,
  };
  return api;
}
