import * as THREE from 'three';

const TABLE_SIZE = 400;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Spline wrapper with an arc-length table. `u` is the normalised arc-length
 * parameter in [0,1] (equal steps in u are equal steps in distance).
 * Distances `s` are in world units in [0, length]. All getters write into `out`.
 */
export function createSpline(points, { closed = false } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('createSpline needs at least 2 points');
  }
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))),
    closed,
    'centripetal'
  );

  // Arc-length table: tTable[i] is the curve parameter at cumulative length lTable[i].
  const tTable = new Float64Array(TABLE_SIZE + 1);
  const lTable = new Float64Array(TABLE_SIZE + 1);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  curve.getPoint(0, a);
  for (let i = 1; i <= TABLE_SIZE; i++) {
    const t = i / TABLE_SIZE;
    curve.getPoint(t, b);
    tTable[i] = t;
    lTable[i] = lTable[i - 1] + a.distanceTo(b);
    a.copy(b);
  }
  const length = lTable[TABLE_SIZE];

  function tAtDistance(s) {
    if (s <= 0) return 0;
    if (s >= length) return 1;
    let lo = 0;
    let hi = TABLE_SIZE;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lTable[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = lTable[hi] - lTable[lo];
    const f = span > 0 ? (s - lTable[lo]) / span : 0;
    return tTable[lo] + f * (tTable[hi] - tTable[lo]);
  }

  function wrapDistance(s) {
    if (!closed) return Math.min(Math.max(s, 0), length);
    return ((s % length) + length) % length;
  }

  const lengthAt = (u) => clamp01(u) * length;
  const uAtDistance = (s) => (length > 0 ? clamp01(s / length) : 0);

  function getPointAt(u, out = new THREE.Vector3()) {
    return curve.getPoint(tAtDistance(lengthAt(u)), out);
  }

  function tangentAtDistance(s, out) {
    const h = Math.max(length / TABLE_SIZE, 1e-6);
    const s0 = closed ? s - h : Math.max(s - h, 0);
    const s1 = closed ? s + h : Math.min(s + h, length);
    curve.getPoint(tAtDistance(wrapDistance(s0)), c);
    curve.getPoint(tAtDistance(wrapDistance(s1)), d);
    out.subVectors(d, c);
    if (out.lengthSq() < 1e-18) out.set(0, 0, 1);
    return out.normalize();
  }

  function getTangentAt(u, out = new THREE.Vector3()) {
    return tangentAtDistance(lengthAt(u), out);
  }

  const t0 = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  function curvatureAtDistance(s) {
    const h = Math.max(length / 100, 1e-6);
    const s0 = closed ? s - h : Math.min(Math.max(s - h, 0), Math.max(length - 2 * h, 0));
    const s1 = closed ? s + h : Math.min(s0 + 2 * h, length);
    tangentAtDistance(wrapDistance(s0), t0);
    tangentAtDistance(wrapDistance(s1), t1);
    const ds = closed ? 2 * h : Math.max(s1 - s0, 1e-6);
    const k = t0.sub(t1).length() / ds; // |ΔT| / Δs
    return Number.isFinite(k) ? k : 0;
  }

  const getCurvatureAt = (u) => curvatureAtDistance(lengthAt(u));

  /** Max curvature over [s, s + lookahead] (distances), sampled `samples` times. */
  function maxCurvatureAhead(s, lookahead, samples = 16) {
    let max = 0;
    const n = Math.max(1, samples | 0);
    for (let i = 0; i <= n; i++) {
      const k = curvatureAtDistance(closed ? s + (lookahead * i) / n : Math.min(s + (lookahead * i) / n, length));
      if (k > max) max = k;
    }
    return max;
  }

  return {
    curve,
    closed,
    length,
    getPointAt,
    getTangentAt,
    getCurvatureAt,
    lengthAt,
    uAtDistance,
    maxCurvatureAhead,
  };
}
