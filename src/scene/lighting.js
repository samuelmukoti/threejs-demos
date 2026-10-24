// Lighting rig. Renderer-independent: only constructs three objects (Node-safe).
// The light set is FIXED at creation (no lights are ever added or removed while
// running); update() only moves lights and sets intensities, as pure functions of
// (t, settings, vehicleStates), so every frame is reproducible.
import {
  DirectionalLight, PointLight, SpotLight, Object3D, Group, Mesh, ConeGeometry, ShaderMaterial,
  AdditiveBlending, DoubleSide, Color, Vector3, PCFSoftShadowMap,
} from 'three';
import { settings as defaultSettings } from '../settings.js';
import { RENDER_ORDER } from './createScene.js';

const SHADOW_MAP_SIZE = 2048;
const SHADOW_EXTENT = 30;           // half-size of the moon shadow frustum (world units)
const MOON_DISTANCE = 90;
const MOON_DIR = new Vector3(-0.45, 0.8, -0.4).normalize(); // from target toward the moon
const STREET_COUNT = 2;
const NEON_COUNT = 1;
const TUNNEL_COUNT = 2;
const STREET_HEIGHT = 7;
const STREET_LATERAL = 8.5;
const NEON_LATERAL = 12;
const NEON_HEIGHT = 5;
const TUNNEL_HEIGHT = 5.5;
const TAU = Math.PI * 2;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => { const k = clamp01(x); return k * k * (3 - 2 * k); };

// Gradient-alpha volume cone: brightest at the apex (uv.y = 1), fading to the base,
// with a soft silhouette so the hull edges never read as hard lines.
function createConeMaterial(color) {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(color) }, uStrength: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6);
        float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float a = along * rim * uStrength;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/**
 * @param {import('three').Scene} scene
 * @param {typeof defaultSettings} [settings]
 */
export function createLighting(scene, settings = defaultSettings) {
  if (!scene || typeof scene.add !== 'function') throw new Error('createLighting: scene required');
  const L = settings.lighting;
  const shadowsOn = !!(settings.quality && settings.quality.shadows);

  const group = new Group();
  group.name = 'lighting';
  scene.add(group);

  const lights = [];          // fixed order; basis of getLightIntensities()
  const baseIntensity = new Map();
  const geometries = [];
  const materials = [];
  const add = (light, name) => {
    light.name = name;
    group.add(light);
    lights.push(light);
    baseIntensity.set(light, light.intensity);
    return light;
  };

  // ---- Moon (shadow caster #1) -----------------------------------------
  const moon = add(new DirectionalLight(L.moon.color, L.moon.intensity), 'moon');
  moon.castShadow = shadowsOn;
  moon.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const sc = moon.shadow.camera;
  sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
  sc.near = 1; sc.far = MOON_DISTANCE * 2;
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.05;
  group.add(moon.target);

  // Light-space basis for texel snapping (static since the moon direction is fixed).
  const moonRight = new Vector3().crossVectors(new Vector3(0, 1, 0), MOON_DIR).normalize();
  const moonUp = new Vector3().crossVectors(MOON_DIR, moonRight).normalize();
  const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;

  // ---- Streetlights + neon + tunnel (warm points, repositioned near the action)
  const street = [];
  for (let i = 0; i < STREET_COUNT; i++) {
    street.push(add(new PointLight(L.streetlight.color, L.streetlight.intensity, L.streetlight.distance, 2), `street${i}`));
  }
  const neon = [];
  for (let i = 0; i < NEON_COUNT; i++) {
    const colors = L.neon.colors;
    neon.push(add(new PointLight(colors[i % colors.length], L.neon.intensity, 26, 2), `neon${i}`));
  }
  const tunnel = [];
  for (let i = 0; i < TUNNEL_COUNT; i++) {
    tunnel.push(add(new PointLight(L.tunnel.color, L.tunnel.intensity, L.tunnel.spacing * 2.5, 2), `tunnel${i}`));
  }

  // ---- Per-car headlights (2 spots) + brake light (1 spot) ---------------
  const carNames = ['lead', 'pursuer'];
  const cars = carNames.map((name, ci) => {
    const dims = (settings.vehicles[name] || settings.vehicles.lead).dimensions;
    const heads = [1, -1].map((side, si) => {
      const spot = add(new SpotLight(L.headlight.color, L.headlight.intensity, L.headlight.distance, L.headlight.angle, 0.55, 2), `${name}Head${si}`);
      // Shadow caster #2: the lead car's left headlight only.
      spot.castShadow = shadowsOn && ci === 0 && si === 0;
      if (spot.castShadow) {
        spot.shadow.mapSize.set(1024, 1024);
        spot.shadow.camera.near = 0.5;
        spot.shadow.camera.far = L.headlight.distance;
        spot.shadow.bias = -0.0005;
      }
      group.add(spot.target);
      return { spot, side };
    });
    const brakeSpot = add(new SpotLight(L.brake.color, 0, 14, 0.9, 0.8, 2), `${name}Brake`);
    group.add(brakeSpot.target);
    return { name, dims, heads, brake: brakeSpot };
  });

  // ---- Fake volumetric cones --------------------------------------------
  const headCone = new ConeGeometry(2.6, 16, 20, 1, true);
  headCone.translate(0, -8, 0);     // apex at origin, opening along -y
  headCone.rotateX(-Math.PI / 2);   // opening along +z (vehicle forward)
  const streetCone = new ConeGeometry(4.5, STREET_HEIGHT, 20, 1, true);
  streetCone.translate(0, -STREET_HEIGHT / 2, 0); // apex at the lamp, opening down
  geometries.push(headCone, streetCone);
  const headConeMat = createConeMaterial(L.headlight.color);
  const streetConeMat = createConeMaterial(L.streetlight.color);
  materials.push(headConeMat, streetConeMat);

  const makeCone = (geometry, material, name) => {
    const m = new Mesh(geometry, material);
    m.name = name;
    m.renderOrder = RENDER_ORDER.cones;
    m.frustumCulled = false;
    m.visible = false;
    group.add(m);
    return m;
  };
  for (const car of cars) {
    car.cones = car.heads.map((h, i) => makeCone(headCone, headConeMat, `${car.name}HeadCone${i}`));
  }
  const streetCones = street.map((_, i) => makeCone(streetCone, streetConeMat, `streetCone${i}`));

  // Tunnel extents from the route settings (z decreasing).
  const tz = settings.route.tunnel || [];
  const tunnelZ0 = tz.length >= 2 ? tz[0][1] : null;
  const tunnelZ1 = tz.length >= 2 ? tz[tz.length - 1][1] : null;

  const focus = new Vector3();
  const _fwd = new Vector3();
  const _p = new Vector3();

  function pickState(states, name, index) {
    if (!states) return null;
    if (Array.isArray(states)) return states[index] || null;
    return states[name] || null;
  }

  function update(t, vehicleStates) {
    // Focus: centroid of the vehicles (default origin).
    let n = 0;
    focus.set(0, 0, 0);
    const active = cars.map((car, ci) => {
      const st = pickState(vehicleStates, car.name, ci);
      if (st && st.position) { focus.add(st.position); n++; }
      return st && st.position ? st : null;
    });
    if (n > 0) focus.multiplyScalar(1 / n);

    // Moon: follow the action, snap the shadow origin to shadow-map texels.
    const sr = Math.round(focus.dot(moonRight) / texel) * texel;
    const su = Math.round(focus.dot(moonUp) / texel) * texel;
    const sf = Math.round(focus.dot(MOON_DIR) / texel) * texel;
    moon.target.position.copy(moonRight).multiplyScalar(sr).addScaledVector(moonUp, su).addScaledVector(MOON_DIR, sf);
    moon.position.copy(moon.target.position).addScaledVector(MOON_DIR, MOON_DISTANCE);
    moon.target.updateMatrixWorld();

    // Streetlights: nearest lamp slots on a fixed spacing grid, alternating sides.
    const sp = L.streetlight.spacing;
    const baseSlot = Math.round(focus.z / sp);
    const inTunnel = tunnelZ0 !== null && focus.z <= tunnelZ0 && focus.z >= tunnelZ1;
    for (let i = 0; i < street.length; i++) {
      const slot = baseSlot - (i >> 1) * 1 - (i & 1);
      const side = i % 2 === 0 ? 1 : -1;
      const light = street[i];
      light.position.set(side * STREET_LATERAL, STREET_HEIGHT, slot * sp);
      const flick = 1 + 0.04 * Math.sin(t * 7.3 + slot * 1.7) * Math.sin(t * 3.1 + i);
      light.intensity = inTunnel ? 0 : baseIntensity.get(light) * flick;
      const cone = streetCones[i];
      cone.position.copy(light.position);
      cone.visible = light.intensity > 0;
    }
    streetConeMat.uniforms.uStrength.value = inTunnel ? 0 : 0.16;

    // Neon: a coloured wash beside the road, with a hard-ish deterministic flicker.
    for (let i = 0; i < neon.length; i++) {
      const light = neon[i];
      const side = i % 2 === 0 ? -1 : 1;
      const slot = Math.round(focus.z / 30) - 1;
      light.position.set(side * NEON_LATERAL, NEON_HEIGHT, slot * 30 + i * 11);
      const buzz = 0.82 + 0.18 * Math.sin(t * 31 + i * 2.1);
      const drop = Math.sin(t * 2.3 + i * 4.7) > 0.92 ? 0.25 : 1; // occasional stutter
      light.intensity = inTunnel ? 0 : baseIntensity.get(light) * buzz * drop;
    }

    // Tunnel lights: two lamps on the tunnel spacing grid ahead/behind, pulsing.
    const ts = L.tunnel.spacing;
    for (let i = 0; i < tunnel.length; i++) {
      const light = tunnel[i];
      let on = 0;
      if (tunnelZ0 !== null) {
        const clampedZ = Math.min(tunnelZ0, Math.max(tunnelZ1, focus.z));
        const slot = Math.round(clampedZ / ts) - i;
        light.position.set(0, TUNNEL_HEIGHT, slot * ts);
        const near = 1 - Math.min(1, Math.abs(focus.z - clampedZ) / (ts * 4));
        on = smooth(near);
        const pulse = 0.75 + 0.25 * Math.sin(TAU * (0.5 * t - slot / 6));
        light.intensity = baseIntensity.get(light) * on * pulse;
      } else {
        light.intensity = 0;
      }
    }

    // Vehicles.
    headConeMat.uniforms.uStrength.value = 0.22;
    for (let ci = 0; ci < cars.length; ci++) {
      const car = cars[ci];
      const st = active[ci];
      if (!st) {
        for (const h of car.heads) h.spot.intensity = 0;
        car.brake.intensity = 0;
        for (const c of car.cones) c.visible = false;
        continue;
      }
      const yaw = st.yaw || 0;
      _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      const halfL = car.dims.length / 2;
      const halfW = car.dims.width * 0.35;
      car.heads.forEach((h, i) => {
        // Left of heading (+x local) maps to (cos yaw, 0, -sin yaw).
        _p.set(Math.cos(yaw) * halfW * h.side, 0, -Math.sin(yaw) * halfW * h.side)
          .addScaledVector(_fwd, halfL).add(st.position);
        _p.y += 0.65;
        h.spot.position.copy(_p);
        h.spot.target.position.copy(_p).addScaledVector(_fwd, 20);
        h.spot.target.position.y -= 1.2;
        h.spot.target.updateMatrixWorld();
        h.spot.intensity = baseIntensity.get(h.spot);
        const cone = car.cones[i];
        cone.position.copy(_p);
        cone.rotation.set(0.06, yaw, 0);
        cone.visible = true;
      });
      const b = clamp01(st.brakeIntensity || 0);
      _p.copy(st.position).addScaledVector(_fwd, -halfL);
      _p.y += 0.75;
      car.brake.position.copy(_p);
      car.brake.target.position.copy(_p).addScaledVector(_fwd, -8);
      car.brake.target.updateMatrixWorld();
      car.brake.intensity = L.brake.intensity * b * (1 + 3 * b);
    }
  }

  function getLightIntensities() {
    return lights.map((l) => l.intensity);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const l of lights) if (l.shadow && l.shadow.map) l.shadow.map.dispose();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    group.removeFromParent();
  }

  update(0, null);

  return {
    group,
    lights,
    lightCount: lights.length,
    shadowCasterCount: lights.filter((l) => l.castShadow).length,
    shadowMapType: PCFSoftShadowMap, // renderer.shadowMap.type should be set to this
    update,
    getLightIntensities,
    dispose,
  };
}
