import * as THREE from 'three';
import { mulberry32 } from '../utils/prng.js';
import { settings } from '../settings.js';

// Rain streaks and lens droplets. Every streak position is a pure function of
// (seed, index, t) and the focus point, so scrubbing / camera cuts never change the rain.
// All buffers are allocated once at the maximum count; setCount only changes the draw range.

const DEFAULT_VOLUME = [60, 36, 60]; // x, y, z extent of the rain box around the focus point
const LENS_DROPLETS = 48;
const HEADLIGHT_COS = 0.88;
const HEADLIGHT_RANGE = 40;
const _tmp = new THREE.Vector3();

function wrap(v, size) {
  return v - Math.floor(v / size) * size;
}

export function createRain({
  count = settings.qualityPresets?.medium?.rainParticles ?? 8000,
  maxCount = count,
  seed = 1,
  volume = DEFAULT_VOLUME,
  speed = settings.rain.speed,
  streakLength = settings.rain.streakLength,
  wind = settings.rain.wind,
  renderOrder = 9,
} = {}) {
  if (!Number.isInteger(count) || count < 0) throw new Error('createRain: count must be a non-negative integer');
  if (!Number.isInteger(maxCount) || maxCount <= 0) throw new Error('createRain: maxCount must be a positive integer');
  const max = Math.max(maxCount, count);
  const [vx, vy, vz] = volume;

  // Per-index constants derived from the seeded PRNG (generated once, in index order).
  const rng = mulberry32((seed ^ 0x5a17c0de) >>> 0);
  const baseX = new Float32Array(max);
  const baseY = new Float32Array(max);
  const baseZ = new Float32Array(max);
  const speeds = new Float32Array(max);
  const lengths = new Float32Array(max);
  const near = new Float32Array(max); // 0..1 threshold: streak only shown when density falloff exceeds it
  for (let i = 0; i < max; i++) {
    baseX[i] = rng() * vx;
    baseY[i] = rng() * vy;
    baseZ[i] = rng() * vz;
    speeds[i] = 0.75 + rng() * 0.5;
    lengths[i] = 0.6 + rng() * 0.8;
    near[i] = rng();
  }

  const positions = new Float32Array(max * 6);
  const colors = new Float32Array(max * 8);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setDrawRange(0, count * 2);
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const streaks = new THREE.LineSegments(geometry, material);
  streaks.frustumCulled = false;
  streaks.renderOrder = renderOrder;

  let active = count;
  let headlights = null; // array of { position: Vector3, direction: Vector3 } (borrowed, not copied)

  function setCount(n) {
    active = Math.max(0, Math.min(max, Math.floor(n)));
    geometry.setDrawRange(0, active * 2);
  }

  function setHeadlights(list) {
    headlights = list;
  }

  const windX = wind;
  const fallDir = speed;

  function update(t, focusPoint) {
    const fx = focusPoint ? focusPoint.x : 0;
    const fy = focusPoint ? focusPoint.y : 0;
    const fz = focusPoint ? focusPoint.z : 0;
    const hx = vx / 2, hy = vy / 2, hz = vz / 2;
    for (let i = 0; i < active; i++) {
      const s = speeds[i];
      // Position inside the box (wrapped fall + wind drift), then re-centred on the focus point.
      const lx = wrap(baseX[i] + windX * s * t - fx + hx, vx);
      const ly = wrap(baseY[i] - fallDir * s * t - fy + hy, vy);
      const lz = wrap(baseZ[i] - fz + hz, vz);
      const x = fx + lx - hx;
      const y = fy + ly - hy;
      const z = fz + lz - hz;

      // Density: thin out toward the box edge so the volume follows the action smoothly.
      const dx = (lx - hx) / hx, dy = (ly - hy) / hy, dz = (lz - hz) / hz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const falloff = Math.max(0, 1 - d2);
      const visible = falloff > near[i] * 0.85 ? 1 : 0;

      // Streak tail points back along the velocity vector.
      const len = streakLength * lengths[i] * s;
      const inv = 1 / Math.hypot(windX * s, fallDir * s);
      const tx = windX * s * inv * len;
      const ty = -fallDir * s * inv * len;
      const p = i * 6;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
      positions[p + 3] = x - tx; positions[p + 4] = y - ty; positions[p + 5] = z;

      // Headlight interaction: brighter streaks inside a headlight cone.
      let boost = 0;
      if (headlights) {
        for (let h = 0; h < headlights.length; h++) {
          const hl = headlights[h];
          _tmp.set(x - hl.position.x, y - hl.position.y, z - hl.position.z);
          const dist = _tmp.length();
          if (dist > 0.001 && dist < HEADLIGHT_RANGE) {
            const c = _tmp.dot(hl.direction) / dist;
            if (c > HEADLIGHT_COS) boost = Math.max(boost, (c - HEADLIGHT_COS) / (1 - HEADLIGHT_COS) * (1 - dist / HEADLIGHT_RANGE));
          }
        }
      }
      const a = visible * (0.18 + falloff * 0.25 + boost * 0.9);
      const c = i * 8;
      const r = 0.55 + boost * 0.45;
      colors[c] = r; colors[c + 1] = r + 0.05; colors[c + 2] = 0.75 + boost * 0.25; colors[c + 3] = a * 0.3; // tail fades
      colors[c + 4] = r; colors[c + 5] = r + 0.05; colors[c + 6] = 0.75 + boost * 0.25; colors[c + 7] = a;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    lensUniforms.uTime.value = t;
  }

  // Lens droplets: screen-space points emitted straight in clip space; deterministic from uTime.
  const lensRng = mulberry32((seed ^ 0x1e45d20b) >>> 0);
  const lensPos = new Float32Array(LENS_DROPLETS * 3);
  const lensParams = new Float32Array(LENS_DROPLETS * 3); // phase, period, size
  for (let i = 0; i < LENS_DROPLETS; i++) {
    lensPos[i * 3] = lensRng() * 2 - 1;
    lensPos[i * 3 + 1] = lensRng() * 2 - 1;
    lensPos[i * 3 + 2] = 0;
    lensParams[i * 3] = lensRng() * 10;
    lensParams[i * 3 + 1] = 4 + lensRng() * 6;
    lensParams[i * 3 + 2] = 0.5 + lensRng() * 0.5;
  }
  const lensGeometry = new THREE.BufferGeometry();
  lensGeometry.setAttribute('position', new THREE.BufferAttribute(lensPos, 3));
  lensGeometry.setAttribute('params', new THREE.BufferAttribute(lensParams, 3));
  const lensUniforms = {
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uPixelScale: { value: 1 },
  };
  const lensMaterial = new THREE.ShaderMaterial({
    uniforms: lensUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      attribute vec3 params;
      uniform float uTime;
      uniform float uStrength;
      uniform float uPixelScale;
      varying float vAlpha;
      void main() {
        float age = mod(uTime + params.x, params.y) / params.y;
        float grow = smoothstep(0.0, 0.15, age);
        float fade = 1.0 - smoothstep(0.8, 1.0, age);
        vec2 p = position.xy;
        p.y -= age * age * 0.25; // pooled droplet slowly slides down
        gl_Position = vec4(p, 0.0, 1.0);
        gl_PointSize = (6.0 + params.z * 26.0) * grow * uPixelScale * (0.5 + uStrength);
        vAlpha = grow * fade * uStrength;
      }`,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r = dot(c, c);
        if (r > 1.0) discard;
        float rim = smoothstep(0.5, 1.0, r);
        vec3 col = mix(vec3(0.55, 0.65, 0.8), vec3(0.9, 0.95, 1.0), rim);
        gl_FragColor = vec4(col, vAlpha * (0.12 + rim * 0.35));
      }`,
  });
  const lens = new THREE.Points(lensGeometry, lensMaterial);
  lens.frustumCulled = false;
  lens.renderOrder = 1000;
  lens.visible = false;

  // strength 0..1: hood / wheel / tunnel shots use higher values.
  function setLensStrength(s) {
    const v = Math.max(0, Math.min(1, s));
    lensUniforms.uStrength.value = v;
    lens.visible = v > 0;
  }

  function setPixelScale(s) {
    lensUniforms.uPixelScale.value = s;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    lensGeometry.dispose();
    lensMaterial.dispose();
  }

  return {
    object: streaks,
    lensObject: lens,
    geometry,
    get count() { return active; },
    maxCount: max,
    setCount,
    setHeadlights,
    setLensStrength,
    setPixelScale,
    update,
    dispose,
  };
}
