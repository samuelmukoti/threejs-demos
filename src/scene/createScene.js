// Scene builder. Renderer-independent: only constructs three objects (Node-safe).
import {
  Scene, Group, Mesh, InstancedMesh, LOD, FogExp2, Color, BufferGeometry, BufferAttribute,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, SphereGeometry, Sphere, Vector3,
  Matrix4, Quaternion, Euler, MeshStandardMaterial, MeshBasicMaterial, DynamicDrawUsage,
} from 'three';
import { settings as defaultSettings } from '../settings.js';
import { mulberry32, range, pick } from '../utils/prng.js';
import { createMaterials } from './materials.js';
import { createSpline } from '../animation/splineMotion.js';

// Explicit draw order buckets.
export const RENDER_ORDER = { opaque: 0, glass: 10, cones: 20, particles: 30, lensDroplets: 40 };

const ROAD_HALF = 7;        // asphalt half width
const SIDEWALK_W = 4;
const SAMPLE_STEP = 3;
const BIG_SPHERE_R = 1e5;

function buildRoutePoints(route) {
  const pts = [];
  for (const key of ['boulevard', 'intersection', 'tunnel', 'sideStreet']) {
    for (const p of route[key] || []) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
  }
  if (pts.length < 2) throw new Error('createScene: settings.route needs at least 2 points');
  return pts;
}

/**
 * @param {{seed?: number, settings?: typeof defaultSettings}} [options]
 */
export function createScene({ seed = 1337, settings = defaultSettings } = {}) {
  const rng = mulberry32(seed);
  const scene = new Scene();
  const root = new Group();
  root.name = 'world';
  scene.add(root);

  const geometries = [];
  const ownMaterials = [];
  const geo = (g) => { geometries.push(g); return g; };
  const mat = (m) => { ownMaterials.push(m); return m; };

  const materials = createMaterials({ seed, wetness: settings.rain.wetness });
  const { fog } = settings.lighting;
  scene.fog = new FogExp2(fog.color, fog.density);
  scene.background = new Color(fog.color);

  // ---- Route sampling --------------------------------------------------
  const spline = createSpline(buildRoutePoints(settings.route).map(([x, z]) => new Vector3(x, 0, z)));
  const count = Math.max(2, Math.ceil(spline.length / SAMPLE_STEP));
  const samples = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const p = spline.getPointAt(u);
    const t = spline.getTangentAt(u);
    t.y = 0;
    t.normalize();
    samples.push({ p, t, n: new Vector3(-t.z, 0, t.x), s: u * spline.length, u });
  }
  const at = (s, lateral, y = 0, out = new Vector3()) => {
    const u = Math.min(1, Math.max(0, s / spline.length));
    const p = spline.getPointAt(u);
    const t = spline.getTangentAt(u);
    t.y = 0;
    t.normalize();
    return out.set(p.x - t.z * lateral, y, p.z + t.x * lateral);
  };
  const tunnelRange = (() => {
    const tz = settings.route.tunnel || [];
    if (tz.length < 2) return null;
    return [tz[0][1], tz[tz.length - 1][1]]; // z range (z decreasing)
  })();
  const inTunnel = (v) => tunnelRange && v.z <= tunnelRange[0] + 4 && v.z >= tunnelRange[1] - 4;

  // ---- Ribbon geometry along the route ---------------------------------
  function ribbon(x0, x1, y, s0 = 0, s1 = spline.length, uvScale = 0.25) {
    const pos = [], uv = [], idx = [];
    const rows = [];
    for (const sm of samples) {
      if (sm.s < s0 - 1e-6 || sm.s > s1 + 1e-6) continue;
      rows.push(sm);
    }
    rows.forEach((sm, i) => {
      pos.push(sm.p.x + sm.n.x * x0, y, sm.p.z + sm.n.z * x0, sm.p.x + sm.n.x * x1, y, sm.p.z + sm.n.z * x1);
      uv.push(0, sm.s * uvScale, (x1 - x0) * uvScale, sm.s * uvScale);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    });
    return { pos, uv, idx };
  }
  function toGeometry(parts) {
    const pos = [], uv = [], idx = [];
    let base = 0;
    for (const r of parts) {
      pos.push(...r.pos); uv.push(...r.uv);
      for (const i of r.idx) idx.push(i + base);
      base += r.pos.length / 3;
    }
    const g = geo(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Fix normals to face up (winding-independent).
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    g.boundingSphere = new Sphere(new Vector3(0, 0, -150), BIG_SPHERE_R / 100);
    return g;
  }
  const addMesh = (g, m, order = RENDER_ORDER.opaque, name = '') => {
    const mesh = new Mesh(g, m);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.name = name;
    root.add(mesh);
    return mesh;
  };

  const road = addMesh(toGeometry([ribbon(-ROAD_HALF, ROAD_HALF, 0)]), materials.asphalt, RENDER_ORDER.opaque, 'road');
  road.receiveShadow = true;
  const sidewalks = addMesh(toGeometry([
    ribbon(ROAD_HALF, ROAD_HALF + SIDEWALK_W, 0.15),
    ribbon(-ROAD_HALF - SIDEWALK_W, -ROAD_HALF, 0.15),
  ]), materials.sidewalk, RENDER_ORDER.opaque, 'sidewalks');
  sidewalks.receiveShadow = true;

  // Lane markings: dashed centre line, solid edge lines.
  const markParts = [];
  for (let s = 0; s < spline.length - 3; s += 9) markParts.push(ribbon(-0.1, 0.1, 0.02, s, s + 4.5));
  markParts.push(ribbon(-ROAD_HALF + 0.4, -ROAD_HALF + 0.55, 0.02), ribbon(ROAD_HALF - 0.55, ROAD_HALF - 0.4, 0.02));
  const markings = addMesh(toGeometry(markParts), materials.laneMarking, RENDER_ORDER.opaque + 1, 'laneMarkings');

  // ---- Instancing helper with near/far LOD split -----------------------
  const lodNear = settings.lod.mid;
  const lodFar = settings.lod.far;
  const lodSets = [];
  const _m = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _s = new Vector3(), _v = new Vector3();
  const compose = (x, y, z, ry, sx, sy, sz) =>
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(sx, sy, sz)).clone();

  /**
   * Registers instance transforms; near mesh uses nearGeo within `nearDist`,
   * far mesh uses farGeo (simpler/impostor) up to `farDist`, null farGeo = culled.
   */
  function instanced(name, nearGeo, farGeo, material, matrices, { nearDist = lodNear, farDist = lodFar, order = RENDER_ORDER.opaque } = {}) {
    const make = (g, label) => {
      const im = new InstancedMesh(g, material, Math.max(1, matrices.length));
      im.name = `${name}:${label}`;
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.frustumCulled = false; // long road: explicit no-cull, bounds are huge
      im.boundingSphere = new Sphere(new Vector3(0, 0, -150), BIG_SPHERE_R / 100);
      im.renderOrder = order;
      im.count = 0;
      root.add(im);
      return im;
    };
    const set = {
      name, matrices, nearDist, farDist, near: make(nearGeo, 'near'),
      far: farGeo ? make(farGeo, 'far') : null, positions: matrices.map((m) => new Vector3().setFromMatrixPosition(m)),
    };
    lodSets.push(set);
    return set;
  }
  const lodCenter = new Vector3(0, 0, 60);
  const lastCenter = new Vector3(Infinity, 0, 0);
  function refreshLod(center) {
    for (const set of lodSets) {
      let n = 0, f = 0;
      for (let i = 0; i < set.matrices.length; i++) {
        const d = set.positions[i].distanceTo(center);
        if (d <= set.nearDist) set.near.setMatrixAt(n++, set.matrices[i]);
        else if (d <= set.farDist && set.far) set.far.setMatrixAt(f++, set.matrices[i]);
      }
      set.near.count = n;
      set.near.instanceMatrix.needsUpdate = true;
      if (set.far) { set.far.count = f; set.far.instanceMatrix.needsUpdate = true; }
    }
  }

  // ---- Buildings -------------------------------------------------------
  const unitBox = geo(new BoxGeometry(1, 1, 1));
  unitBox.translate(0, 0.5, 0);
  const farBox = geo(new BoxGeometry(1, 1, 1)); // untextured-ish impostor: shared geometry shape, no uv detail
  farBox.translate(0, 0.5, 0);
  farBox.deleteAttribute('uv');
  const farFacade = mat(new MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.9, metalness: 0 }));

  const buildingMatrices = [];
  const windowMatrices = [];
  const detailMatrices = [];
  for (let s = -10; s < spline.length + 10; s += 14) {
    for (const side of [-1, 1]) {
      const w = range(rng, 9, 16), d = range(rng, 10, 18), h = range(rng, 14, 55);
      const lateral = side * (ROAD_HALF + SIDEWALK_W + 2 + w / 2 + range(rng, 0, 2));
      const c = at(Math.max(0, Math.min(spline.length, s)), lateral);
      if (inTunnel(c)) continue;
      const ry = Math.atan2(-(at(s + 1, 0).x - at(s, 0).x), -(at(s + 1, 0).z - at(s, 0).z)) || 0;
      buildingMatrices.push(compose(c.x, 0, c.z, ry, w, h, d));
      // Rooftop detail (distant detail instances).
      detailMatrices.push(compose(c.x + range(rng, -2, 2), h, c.z + range(rng, -2, 2), ry, w * 0.3, range(rng, 1, 3), d * 0.3));
      // Windows on the street-facing side, as emissive quads.
      const faceDir = new Vector3(-Math.sin(ry), 0, -Math.cos(ry)); // forward axis
      const nx = Math.cos(ry), nz = -Math.sin(ry);                  // local +x
      const sign = -side; // facing the road
      const rows = Math.floor(h / 4), cols = Math.floor(d / 4);
      for (let r = 1; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          if (rng() > 0.45) continue;
          const off = (k - (cols - 1) / 2) * 3.6;
          const px = c.x + nx * sign * (w / 2 + 0.05) + faceDir.x * off;
          const pz = c.z + nz * sign * (w / 2 + 0.05) + faceDir.z * off;
          windowMatrices.push(compose(px, r * 4 - 1, pz, ry + (sign > 0 ? Math.PI / 2 : -Math.PI / 2), 2.2, 2.2, 1));
        }
      }
    }
  }
  instanced('buildings', unitBox, farBox, materials.facade, buildingMatrices, { nearDist: lodNear * 2 });
  // Far buildings use dull material: swap far mesh material.
  lodSets[lodSets.length - 1].far.material = farFacade;
  const rooftop = geo(new BoxGeometry(1, 1, 1));
  rooftop.translate(0, 0.5, 0);
  instanced('rooftopDetail', rooftop, null, farFacade, detailMatrices, { nearDist: lodFar });

  const windowGeo = geo(new PlaneGeometry(1, 1));
  const windowMat = mat(new MeshBasicMaterial({ color: new Color(0xffd9a0).multiplyScalar(1.4), toneMapped: true }));
  const windowFar = geo(new PlaneGeometry(1.4, 1.4));
  instanced('windows', windowGeo, windowFar, windowMat, windowMatrices, { nearDist: lodNear * 2, farDist: lodFar });

  // ---- Streetlights ----------------------------------------------------
  const poleGeo = geo(new CylinderGeometry(0.1, 0.14, 8, 6));
  poleGeo.translate(0, 4, 0);
  const poleFar = geo(new BoxGeometry(0.2, 8, 0.2));
  poleFar.translate(0, 4, 0);
  const lampGeo = geo(new SphereGeometry(0.3, 8, 6));
  const lampMat = mat(new MeshBasicMaterial({ color: new Color(settings.lighting.streetlight.color).multiplyScalar(2) }));
  const poleMatrices = [], lampMatrices = [];
  const spacing = settings.lighting.streetlight.spacing;
  const lightPositions = [];
  for (let s = 0, i = 0; s < spline.length; s += spacing, i++) {
    const side = i % 2 ? 1 : -1;
    const p = at(s, side * (ROAD_HALF + 1.2));
    if (inTunnel(p)) continue;
    poleMatrices.push(compose(p.x, 0.15, p.z, 0, 1, 1, 1));
    const l = at(s, side * (ROAD_HALF - 0.4), 8.2);
    lampMatrices.push(compose(l.x, 8.35, l.z, 0, 1.2, 0.5, 1.2));
    lightPositions.push(new Vector3(l.x, 8.2, l.z));
  }
  instanced('poles', poleGeo, poleFar, materials.metal, poleMatrices);
  instanced('lamps', lampGeo, null, lampMat, lampMatrices, { nearDist: lodFar });

  // ---- Barriers (jersey barriers) -------------------------------------
  const barrierGeo = geo(new BoxGeometry(0.6, 0.9, 3));
  barrierGeo.translate(0, 0.45, 0);
  const barrierFar = geo(new BoxGeometry(0.6, 0.9, 3));
  barrierFar.translate(0, 0.45, 0);
  const barrierMatrices = [];
  for (let s = 20; s < spline.length; s += 3.2) {
    if (rng() > 0.18) continue;
    const side = rng() < 0.5 ? -1 : 1;
    const p = at(s, side * (ROAD_HALF - 0.5));
    if (inTunnel(p)) continue;
    barrierMatrices.push(compose(p.x, 0, p.z, 0, 1, 1, 1));
  }
  instanced('barriers', barrierGeo, barrierFar, mat(new MeshStandardMaterial({ color: 0x8b8d90, roughness: 0.8 })), barrierMatrices);

  // ---- Debris ----------------------------------------------------------
  const debrisGeo = geo(new BoxGeometry(0.35, 0.12, 0.25));
  const debrisMatrices = [];
  for (let i = 0; i < 160; i++) {
    const p = at(rng() * spline.length, range(rng, -ROAD_HALF - 2, ROAD_HALF + 2), 0.06);
    debrisMatrices.push(compose(p.x, 0.06, p.z, rng() * Math.PI * 2, range(rng, 0.5, 1.6), 1, range(rng, 0.5, 1.6)));
  }
  instanced('debris', debrisGeo, null, mat(new MeshStandardMaterial({ color: 0x3d3a36, roughness: 0.95 })), debrisMatrices, { nearDist: lodNear * 2 });

  // ---- LOD props (non-instanced) --------------------------------------
  const lodProps = [];
  function lodProp(nearObj, farObj, p, ry = 0) {
    const lod = new LOD();
    lod.addLevel(nearObj, 0);
    lod.addLevel(farObj, settings.lod.mid);
    lod.position.copy(p);
    lod.rotation.y = ry;
    lod.name = nearObj.name;
    root.add(lod);
    lodProps.push(lod);
    return lod;
  }
  const box = (w, h, d, material, order = RENDER_ORDER.opaque, y = h / 2) => {
    const g = geo(new BoxGeometry(w, h, d));
    const m = new Mesh(g, material);
    m.position.y = y;
    m.renderOrder = order;
    return m;
  };

  // Parked cars.
  const carMats = [0x3a4a5c, 0x5c3a3a, 0x2e2e33, 0x4b5b46].map((c) => mat(new MeshStandardMaterial({ color: c, roughness: 0.4, metalness: 0.6 })));
  const glassMat = mat(new MeshStandardMaterial({ color: 0x0a1015, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.7 }));
  const parkedCars = [];
  for (let s = 12; s < spline.length - 5; s += 22) {
    const side = rng() < 0.5 ? -1 : 1;
    const p = at(s, side * (ROAD_HALF - 1.2));
    if (inTunnel(p)) continue;
    const bodyMat = pick(rng, carMats);
    const nearCar = new Group();
    nearCar.name = 'parkedCar';
    nearCar.add(box(1.8, 0.7, 4.2, bodyMat, RENDER_ORDER.opaque, 0.55));
    nearCar.add(box(1.6, 0.55, 2.2, glassMat, RENDER_ORDER.glass, 1.15));
    const farCar = new Group();
    farCar.add(box(1.8, 1.2, 4.2, bodyMat));
    parkedCars.push(lodProp(nearCar, farCar, p));
  }

  // Dumpsters.
  const dumpMat = mat(new MeshStandardMaterial({ color: 0x1f3a2a, roughness: 0.7, metalness: 0.3 }));
  for (let s = 30; s < spline.length - 5; s += 41) {
    const side = rng() < 0.5 ? -1 : 1;
    const p = at(s, side * (ROAD_HALF + SIDEWALK_W - 0.8), 0.15);
    if (inTunnel(p)) continue;
    const n = new Group(); n.name = 'dumpster';
    n.add(box(1.8, 1.3, 1.0, dumpMat));
    const f = new Group(); f.add(box(1.8, 1.3, 1.0, dumpMat));
    lodProp(n, f, p);
  }

  // Construction elements: cones + a hoarding wall.
  const coneGeo = geo(new ConeGeometry(0.22, 0.7, 8));
  coneGeo.translate(0, 0.35, 0);
  const coneMat = mat(new MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6, emissive: new Color(0x331000) }));
  const cones = [];
  for (let s = 55; s < spline.length - 5; s += 37) {
    const p0 = at(s, ROAD_HALF - 2.2);
    if (inTunnel(p0)) continue;
    for (let k = 0; k < 5; k++) {
      const p = at(s + k * 2.2, ROAD_HALF - 2.2 - k * 0.25);
      const nearCone = new Mesh(coneGeo, coneMat);
      nearCone.renderOrder = RENDER_ORDER.cones;
      nearCone.name = 'cone';
      const farCone = box(0.35, 0.6, 0.35, coneMat, RENDER_ORDER.cones);
      cones.push(lodProp(nearCone, farCone, p));
    }
    const wall = new Group(); wall.name = 'hoarding';
    wall.add(box(0.2, 2.2, 8, mat(new MeshStandardMaterial({ color: 0x55575c, roughness: 0.9 }))));
    const wallFar = new Group(); wallFar.add(box(0.2, 2.2, 8, farFacade));
    const wp = at(s + 4, ROAD_HALF + SIDEWALK_W - 0.3, 0.15);
    lodProp(wall, wallFar, wp);
  }

  // Signal heads at the intersection and at intervals; cycle in update().
  const signalMats = {
    red: mat(new MeshBasicMaterial({ color: 0x300000 })),
    amber: mat(new MeshBasicMaterial({ color: 0x302000 })),
    green: mat(new MeshBasicMaterial({ color: 0x003010 })),
  };
  const signalOn = { red: new Color(0xff2020), amber: new Color(0xffb020), green: new Color(0x20ff60) };
  const signalOff = { red: new Color(0x300000), amber: new Color(0x302000), green: new Color(0x003010) };
  const housingMat = mat(new MeshStandardMaterial({ color: 0x15161a, roughness: 0.6, metalness: 0.4 }));
  const lampGeoS = geo(new SphereGeometry(0.14, 8, 6));
  const interZ = (settings.route.intersection || [[0, 0]])[0][1];
  const signalS = (() => {
    let best = spline.length / 2, bd = Infinity;
    for (const sm of samples) { const d = Math.abs(sm.p.z - interZ); if (d < bd) { bd = d; best = sm.s; } }
    return best;
  })();
  for (const side of [-1, 1]) {
    const p = at(signalS - 4, side * (ROAD_HALF + 0.8));
    const near = new Group(); near.name = 'signalHead';
    const pole = box(0.18, 5.5, 0.18, materials.metal);
    const head = box(0.5, 1.4, 0.4, housingMat, RENDER_ORDER.opaque, 5.3);
    near.add(pole, head);
    ['red', 'amber', 'green'].forEach((k, i) => {
      const lamp = new Mesh(lampGeoS, signalMats[k]);
      lamp.position.set(0, 5.75 - i * 0.45, 0.22);
      near.add(lamp);
    });
    const far = new Group(); far.add(box(0.5, 5.8, 0.4, housingMat));
    lodProp(near, far, p, side > 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  // Neon signs: flat boxes on building fronts with emissive ramp.
  const neonMat = materials.neon;
  const neonGeo = geo(new BoxGeometry(0.2, 1.4, 4));
  const neonSigns = [];
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1;
    const s = 8 + (i * spline.length) / 15 + range(rng, -6, 6);
    const p = at(s, side * (ROAD_HALF + SIDEWALK_W + 2.1), range(rng, 4, 9));
    if (inTunnel(p)) continue;
    const sign = new Mesh(neonGeo, neonMat);
    sign.position.copy(p);
    sign.rotation.y = 0;
    sign.name = 'neonSign';
    sign.frustumCulled = false;
    root.add(sign);
    neonSigns.push(sign);
  }

  // ---- Per-frame update -------------------------------------------------
  const camLike = { position: null };
  function update(t = 0, dt = 0) {
    const c = camLike.position || lodCenter;
    if (c.distanceToSquared(lastCenter) > 25) { lastCenter.copy(c); refreshLod(c); }
    // Signal cycle: 6s green, 1.5s amber, 6s red.
    const phase = t % 13.5;
    const state = phase < 6 ? 'green' : phase < 7.5 ? 'amber' : 'red';
    for (const k of Object.keys(signalMats)) signalMats[k].color.copy(k === state ? signalOn[k] : signalOff[k]);
    // Neon flicker (deterministic in t).
    neonMat.emissiveIntensity = (settings.lighting.neon.intensity / 4) * (0.92 + 0.08 * Math.sin(t * 23) * Math.sin(t * 7.3));
    for (const lod of lodProps) lod.update?.call(lod, camLikeCamera(c));
    return dt;
  }
  // THREE.LOD.update needs a camera-like with matrixWorld; supply a cheap stand-in.
  const standIn = { matrixWorld: new Matrix4() };
  function camLikeCamera(pos) { standIn.matrixWorld.makeTranslation(pos.x, pos.y, pos.z); return standIn; }

  /** Point LOD selection at a camera (or any object with .position). */
  function setLodCamera(obj) { camLike.position = obj ? obj.position : null; }

  refreshLod(lodCenter);

  function dispose() {
    for (const g of geometries) g.dispose();
    for (const m of ownMaterials) m.dispose();
    materials.dispose();
    for (const set of lodSets) { set.near.dispose(); set.far?.dispose(); }
    geometries.length = 0;
    ownMaterials.length = 0;
    root.removeFromParent();
  }

  const handles = {
    root, spline, materials, road, sidewalks, markings, lodSets, lodProps, parkedCars, cones,
    neonSigns, streetlightPositions: lightPositions, renderOrder: RENDER_ORDER,
    setLodCamera, refreshLod, geometries, ownMaterials,
  };
  return { scene, update, dispose, handles };
}
