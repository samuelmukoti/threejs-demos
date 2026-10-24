import * as THREE from 'three';
import { mulberry32 } from '../utils/prng.js';

// Cinematic (not arcade) vehicle model. A whole run is simulated up front at a
// fixed step into a state table; playback only interpolates, so seeking is
// stable and two runs with the same inputs are bit-identical.

const G = 9.81;
const WHEEL_RADIUS = 0.34;
const MAX_STEER = 0.6;
const BRAKE_ON = 0.05;

// Per-frame layout of the state table (Float64 stride).
const F = {
  x: 0, y: 1, z: 2, heading: 3, speed: 4, lateralAccel: 5, roll: 6, pitch: 7,
  yaw: 8, slip: 9, steer: 10, wheelRotation: 11, distance: 12, brake: 13,
  drift: 14, susp: 15, // susp .. susp+3 = FL, FR, RL, RR (metres, + = compressed)
};
const STRIDE = F.susp + 4;
const WHEEL_SIDE = [1, -1, 1, -1]; // left wheels compress under positive lateral accel
const WHEEL_FRONT = [1, 1, -1, -1]; // front wheels compress under braking

const wrapAngle = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Allocation-free output container for sampleState. */
export function createVehicleState() {
  return {
    position: new THREE.Vector3(),
    heading: 0, speed: 0, lateralAccel: 0, roll: 0, pitch: 0, yaw: 0, slip: 0,
    steer: 0, wheelRotation: 0, distance: 0, brakeIntensity: 0, braking: false,
    drifting: false,
    suspension: new Float64Array(4),
  };
}

function validate(params, route) {
  if (!params || !(params.maxSpeed > 0)) throw new Error('simulateRun: vehicleParams.maxSpeed required');
  if (!route || !(route.length > 0) || typeof route.getPointAt !== 'function') {
    throw new Error('simulateRun: route must be a spline from createSpline');
  }
}

/**
 * Precompute a run along `route`.
 * options: { step, duration, seed, startDistance, startSpeed, leader: { table, offset, lag } }
 * `leader` makes the vehicle a pursuer holding `offset` metres behind the
 * leader's lagged position.
 */
export function simulateRun(vehicleParams, route, options = {}) {
  validate(vehicleParams, route);
  const {
    step = 1 / 120, duration = 44, seed = 1, startDistance = 0, startSpeed = 0, leader = null,
  } = options;
  if (!(step > 0) || !(duration > 0)) throw new Error('simulateRun: step and duration must be > 0');

  const p = {
    maxSpeed: vehicleParams.maxSpeed,
    acceleration: vehicleParams.acceleration ?? 18,
    brakingForce: vehicleParams.brakingForce ?? 30,
    steeringResponse: vehicleParams.steeringResponse ?? 2.8,
    grip: vehicleParams.grip ?? 1.15,
    driftFactor: vehicleParams.driftFactor ?? 0.72,
    suspensionStiffness: vehicleParams.suspensionStiffness ?? 0.8,
    wheelRadius: vehicleParams.wheelRadius ?? WHEEL_RADIUS,
    length: vehicleParams.dimensions?.length ?? 4.5,
  };
  const wheelbase = p.length * 0.6;
  const gripLimit = p.grip * G; // lateral accel where tyres let go
  // Cinematic driver pushes past the limit in tight turns: controlled drift.
  const cornerLimit = gripLimit * (0.85 + 0.5 * p.driftFactor);
  const springK = 120 * p.suspensionStiffness;
  const springC = 2 * 0.7 * Math.sqrt(springK);

  const count = Math.floor(duration / step) + 1;
  const data = new Float64Array(count * STRIDE);
  const rng = mulberry32(seed);

  const pt = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const len = route.length;
  const closed = route.closed;
  const uOf = (s) => route.uAtDistance(s);
  const headingAt = (s) => {
    route.getTangentAt(uOf(s), tan);
    return Math.atan2(tan.x, tan.z);
  };

  let s = clamp(startDistance, 0, len);
  let v = clamp(startSpeed, 0, p.maxSpeed);
  let steer = 0;
  let slip = 0;
  let aLong = 0;
  let brake = 0;
  const susp = new Float64Array(4);
  const suspVel = new Float64Array(4);
  let lead = null;
  if (leader) {
    if (!leader.table) throw new Error('simulateRun: leader.table required');
    lead = createVehicleState();
  }

  for (let i = 0; i < count; i++) {
    const t = i * step;

    // Signed curvature (+ = turning right) from heading change over a short arc.
    const h = Math.max(len / 200, 0.5);
    const sa = Math.max(0, s - h);
    const sb = Math.min(len, sa + 2 * h);
    const hA = headingAt(sa);
    const hB = headingAt(sb);
    const kSigned = wrapAngle(hB - hA) / Math.max(sb - sa, 1e-6);
    const kAbs = Math.abs(kSigned);
    const heading = headingAt(s);

    // Speed target: look ahead over the braking distance for tight curvature.
    const brakeDist = (v * v) / (2 * p.brakingForce) + 8;
    const kAhead = Math.max(kAbs, route.maxCurvatureAhead(s, brakeDist, 8));
    let target = p.maxSpeed;
    if (kAhead > 1e-4) target = Math.min(target, Math.sqrt(cornerLimit / kAhead));
    if (!closed) target = Math.min(target, Math.sqrt(2 * p.brakingForce * 0.8 * Math.max(len - s, 0)));

    if (lead) {
      sampleState(leader.table, t - (leader.lag ?? 0), lead);
      const gapErr = lead.distance - (leader.offset ?? 0) - s;
      target = Math.min(target, Math.max(0, lead.speed + 0.6 * gapErr));
    }

    // Longitudinal: throttle tapers toward maxSpeed, braking is proportional to overspeed.
    let a;
    if (v > target) {
      brake = clamp((v - target) / 3, 0, 1);
      a = -p.brakingForce * brake;
    } else {
      brake = 0;
      a = p.acceleration * clamp((target - v) / 2, 0, 1) * (1 - v / p.maxSpeed);
    }

    // Lateral: grip loss -> slip angle (controlled drift).
    const latA = v * v * kSigned;
    const excess = Math.max(0, (Math.abs(latA) - gripLimit) / gripLimit);
    const drifting = excess > 0;
    const slipTarget = drifting ? Math.sign(latA) * Math.min(0.5, p.driftFactor * (0.15 + excess)) : 0;
    slip += (slipTarget - slip) * (1 - Math.exp(-3 * step));
    if (drifting) a -= 2 * Math.abs(slip) * v * 0.1; // scrub speed

    const steerTarget = clamp(Math.atan(wheelbase * kSigned), -MAX_STEER, MAX_STEER);
    steer += (steerTarget - steer) * (1 - Math.exp(-p.steeringResponse * step));

    // Suspension: spring-damper per wheel driven by load transfer + road texture.
    const roughness = 0.0004 * Math.min(1, v / 20);
    for (let w = 0; w < 4; w++) {
      const noise = (rng() - 0.5) * roughness;
      const load = 0.004 * latA * WHEEL_SIDE[w] + 0.003 * -aLong * WHEEL_FRONT[w] + noise;
      const acc = -springK * (susp[w] - load) - springC * suspVel[w];
      suspVel[w] += acc * step;
      susp[w] += suspVel[w] * step;
    }
    const halfW = (vehicleParams.dimensions?.width ?? 1.85) / 2;
    const roll = ((susp[0] + susp[2]) - (susp[1] + susp[3])) / 2 / (2 * halfW);
    const pitch = ((susp[2] + susp[3]) - (susp[0] + susp[1])) / 2 / p.length;

    route.getPointAt(uOf(s), pt);
    const o = i * STRIDE;
    data[o + F.x] = pt.x;
    data[o + F.y] = pt.y;
    data[o + F.z] = pt.z;
    data[o + F.heading] = heading;
    data[o + F.speed] = v;
    data[o + F.lateralAccel] = latA;
    data[o + F.roll] = roll;
    data[o + F.pitch] = pitch;
    data[o + F.yaw] = heading + slip;
    data[o + F.slip] = slip;
    data[o + F.steer] = steer;
    data[o + F.wheelRotation] = s / p.wheelRadius;
    data[o + F.distance] = s;
    data[o + F.brake] = brake;
    data[o + F.drift] = drifting ? 1 : 0;
    for (let w = 0; w < 4; w++) data[o + F.susp + w] = susp[w];

    // Integrate.
    const vNew = clamp(v + a * step, 0, p.maxSpeed);
    aLong = (vNew - v) / step;
    s += 0.5 * (v + vNew) * step;
    v = vNew;
    if (s >= len && !closed) { s = len; v = 0; }
  }

  return { step, count, duration: (count - 1) * step, stride: STRIDE, data, wheelRadius: p.wheelRadius, seed };
}

/** Interpolate the table at time `t` (clamped) into `out`. No allocation. */
export function sampleState(table, t, out) {
  const { data, step, count } = table;
  const f = clamp(t / step, 0, count - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, count - 1);
  const k = f - i0;
  const a = i0 * STRIDE;
  const b = i1 * STRIDE;
  const lerp = (idx) => data[a + idx] + (data[b + idx] - data[a + idx]) * k;

  out.position.set(lerp(F.x), lerp(F.y), lerp(F.z));
  const ha = data[a + F.heading];
  out.heading = ha + wrapAngle(data[b + F.heading] - ha) * k;
  out.speed = lerp(F.speed);
  out.lateralAccel = lerp(F.lateralAccel);
  out.roll = lerp(F.roll);
  out.pitch = lerp(F.pitch);
  out.slip = lerp(F.slip);
  out.yaw = out.heading + out.slip;
  out.steer = lerp(F.steer);
  out.wheelRotation = lerp(F.wheelRotation);
  out.distance = lerp(F.distance);
  out.brakeIntensity = lerp(F.brake);
  out.braking = out.brakeIntensity > BRAKE_ON;
  out.drifting = (k < 0.5 ? data[a + F.drift] : data[b + F.drift]) > 0;
  for (let w = 0; w < 4; w++) out.suspension[w] = lerp(F.susp + w);
  return out;
}
