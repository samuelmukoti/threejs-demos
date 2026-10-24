// Set pieces: tunnel, intersection cross-traffic, delivery truck, side-street turn,
// distant traffic, steam-vent and near-miss-barrier anchors.
// Renderer-independent (Node-safe). All motion is a pure function of t plus a seeded PRNG.
import {
  Group, Mesh, InstancedMesh, BufferGeometry, BufferAttribute, BoxGeometry, PlaneGeometry,
  CylinderGeometry, Sphere, Vector3, Matrix4, Quaternion, Euler, Color, DoubleSide,
  MeshStandardMaterial, MeshBasicMaterial, DynamicDrawUsage,
} from 'three';
import { mulberry32, range, pick } from '../utils/prng.js';
import { createSpline } from '../animation/splineMotion.js';

const BIG_SPHERE = new Sphere(new Vector3(0, 0, -150), 1e3);
const TUNNEL_HEIGHT = 7;
const SIDE_STREET_HALF = 4.5;
const SIDE_WALL_HEIGHT = 14;
const CROSS_HALF = 110;              // cross-traffic wraps over [-CROSS_HALF, CROSS_HALF]
const TRAFFIC_Z_MAX = 60;
const TRAFFIC_Z_MIN = -295;
const CAR_LEN = 4.4;

const wrap = (v, lo, hi) => {
  const w = hi - lo;
  return ((((v - lo) % w) + w) % w) + lo;
};
const lerp = (a, b, k) => a + (b - a) * k;
// Heading angle (rotation about y) for a car whose front is local -z and moves along (fx, fz).
const heading = (fx, fz) => Math.atan2(-fx, -fz);

/**
 * @param {object} o
 * @param {import('three').Object3D} o.root
 * @param {object} o.settings
 * @param {number} [o.seed]
 * @param {object} o.materials  result of createMaterials()
 * @param {Record<string, number>} o.renderOrder
 * @param {number} [o.roadHalf]
 */
export function createSetPieces({ root, settings, seed = 1337, materials, renderOrder, roadHalf = 7 }) {
  const rng = mulberry32((seed ^ 0x5e7b1ece) >>> 0);
  const group = new Group();
  group.name = 'setPieces';
  root.add(group);

  const geometries = [];
  const ownMaterials = [];
  const instancedMeshes = [];
  const geo = (g) => { geometries.push(g); return g; };
  const mat = (m) => { ownMaterials.push(m); return m; };

  const _m = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _s = new Vector3(), _v = new Vector3();
  const _c = new Color();
  const _o = new Vector3();
  const setM = (im, i, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) => {
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(sx, sy, sz));
    im.setMatrixAt(i, _m);
  };
  const makeInstanced = (name, g, material, n, order = renderOrder.opaque) => {
    const im = new InstancedMesh(g, material, Math.max(1, n));
    im.name = name;
    im.instanceMatrix.setUsage(DynamicDrawUsage);
    im.frustumCulled = false;
    im.boundingSphere = BIG_SPHERE.clone();
    im.renderOrder = order;
    im.count = n;
    group.add(im);
    instancedMeshes.push(im);
    return im;
  };
  const addBox = (parent, w, h, d, material, x, y, z) => {
    const m = new Mesh(geo(new BoxGeometry(w, h, d)), material);
    m.position.set(x, y, z);
    m.frustumCulled = false;
    parent.add(m);
    return m;
  };

  // ---- Route-derived anchors -------------------------------------------
  const route = settings.route;
  const tunnelPts = route.tunnel || [];
  const hasTunnel = tunnelPts.length >= 2;
  const tunnelZ0 = hasTunnel ? tunnelPts[0][1] : 0;
  const tunnelZ1 = hasTunnel ? tunnelPts[tunnelPts.length - 1][1] : 0;
  const tunnelX = hasTunnel ? tunnelPts[0][0] : 0;
  const interPts = route.intersection || [];
  const interZ = interPts.length ? interPts[Math.floor(interPts.length / 2)][1] : null;
  const interX = interPts.length ? interPts[0][0] : 0;

  const concrete = mat(new MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.85, metalness: 0.05, side: DoubleSide }));
  const handles = {};

  // ---- Tunnel / underpass ----------------------------------------------
  if (hasTunnel) {
    const len = Math.abs(tunnelZ1 - tunnelZ0);
    const cz = (tunnelZ0 + tunnelZ1) / 2;
    const half = roadHalf + 1.5;
    const tunnel = new Group();
    tunnel.name = 'tunnel';
    addBox(tunnel, 1, TUNNEL_HEIGHT, len, concrete, tunnelX - half - 0.5, TUNNEL_HEIGHT / 2, cz);
    addBox(tunnel, 1, TUNNEL_HEIGHT, len, concrete, tunnelX + half + 0.5, TUNNEL_HEIGHT / 2, cz);
    addBox(tunnel, half * 2 + 2, 0.8, len, concrete, tunnelX, TUNNEL_HEIGHT + 0.4, cz);
    // Portal header: slightly lower lintel at the entrance.
    addBox(tunnel, half * 2 + 2, 1.4, 1.2, concrete, tunnelX, TUNNEL_HEIGHT - 0.3, tunnelZ0 + 0.6);
    group.add(tunnel);

    // Animated light strips (instanced): two rows on the ceiling, one on each wall.
    const spacing = Math.max(2, settings.lighting.tunnel.spacing);
    const rows = [-3.2, 3.2];
    const perRow = Math.max(1, Math.floor(len / spacing));
    const stripCount = perRow * rows.length;
    const stripMat = mat(new MeshBasicMaterial({ color: 0xffffff, toneMapped: true }));
    const stripGeo = geo(new BoxGeometry(0.35, 0.1, 2.4));
    const strips = makeInstanced('tunnelStrips', stripGeo, stripMat, stripCount);
    const stripPositions = [];
    let si = 0;
    for (const rx of rows) {
      for (let k = 0; k < perRow; k++) {
        const z = tunnelZ0 - (k + 0.5) * (len / perRow);
        setM(strips, si, tunnelX + rx, TUNNEL_HEIGHT - 0.05, z);
        stripPositions.push(new Vector3(tunnelX + rx, TUNNEL_HEIGHT - 0.05, z));
        si++;
      }
    }
    strips.instanceMatrix.needsUpdate = true;
    const flickerSeed = Array.from({ length: stripCount }, () => rng());
    const base = new Color(settings.lighting.tunnel.color);
    const gain = settings.lighting.tunnel.intensity / 9;
    // Pure function of (t, i): travelling chase pulse + a few failing tubes.
    const stripIntensity = (t, i) => {
      const chase = 0.8 + 0.2 * Math.sin(t * 3 - i * 0.6);
      const flicker = flickerSeed[i] < 0.1 ? (Math.sin(t * 17 + i * 5.1) > -0.3 ? 1 : 0.15) : 1;
      return gain * chase * flicker;
    };
    const writeStrips = (t) => {
      for (let i = 0; i < stripCount; i++) {
        _c.copy(base).multiplyScalar(stripIntensity(t, i));
        strips.setColorAt(i, _c);
      }
      strips.instanceColor.needsUpdate = true;
    };
    writeStrips(0);
    handles.tunnel = {
      group: tunnel, zStart: tunnelZ0, zEnd: tunnelZ1, halfWidth: half, height: TUNNEL_HEIGHT,
      strips, stripPositions, stripIntensity, entry: new Vector3(tunnelX, 0, tunnelZ0),
      exit: new Vector3(tunnelX, 0, tunnelZ1),
    };
    handles.tunnel.write = writeStrips;
  }

  // ---- Intersection with instanced cross traffic -----------------------
  const crossCars = [];
  let crossBodies = null, crossLights = null;
  if (interZ !== null) {
    const crossRoad = new Mesh(geo(new PlaneGeometry(CROSS_HALF * 2, roadHalf * 2)), materials.asphalt);
    crossRoad.rotation.x = -Math.PI / 2;
    crossRoad.position.set(interX, 0.03, interZ);
    crossRoad.renderOrder = renderOrder.opaque;
    crossRoad.frustumCulled = false;
    crossRoad.receiveShadow = true;
    crossRoad.name = 'crossRoad';
    group.add(crossRoad);

    // Zebra crossings on both approaches.
    const stripeGeo = geo(new BoxGeometry(0.6, 0.02, 3));
    const stripes = makeInstanced('crosswalk', stripeGeo, materials.laneMarking, 2 * 10, renderOrder.opaque + 1);
    let zi = 0;
    for (const zs of [interZ + roadHalf + 2, interZ - roadHalf - 2]) {
      for (let k = 0; k < 10; k++) setM(stripes, zi++, interX + (k - 4.5) * 1.4, 0.05, zs);
    }
    stripes.instanceMatrix.needsUpdate = true;

    const nCars = 6;
    const bodyColors = [0x3a4a5c, 0x7a2a2a, 0x2e2e33, 0x4b5b46, 0xa8a8a0, 0x24304a];
    for (let i = 0; i < nCars; i++) {
      const dir = i % 2 ? 1 : -1;
      crossCars.push({
        dir,
        laneZ: interZ + (dir > 0 ? -1 : 1) * range(rng, 2, roadHalf - 2),
        speed: range(rng, 14, 22),
        x0: range(rng, -CROSS_HALF, CROSS_HALF),
        color: new Color(pick(rng, bodyColors)),
      });
    }
    const bodyGeo = geo(new BoxGeometry(1.9, 1.2, CAR_LEN));
    bodyGeo.translate(0, 0.75, 0);
    crossBodies = makeInstanced('crossTrafficBodies', bodyGeo,
      mat(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.6 })), nCars);
    crossCars.forEach((c, i) => crossBodies.setColorAt(i, c.color));
    const lightGeo = geo(new BoxGeometry(0.4, 0.18, 0.06));
    crossLights = makeInstanced('crossTrafficLights', lightGeo, mat(new MeshBasicMaterial({ color: 0xffffff })), nCars * 4);
    const head = new Color(settings.lighting.headlight.color).multiplyScalar(2.5);
    const tail = new Color(settings.lighting.brake.color).multiplyScalar(2);
    for (let i = 0; i < nCars; i++) {
      crossLights.setColorAt(i * 4, head); crossLights.setColorAt(i * 4 + 1, head);
      crossLights.setColorAt(i * 4 + 2, tail); crossLights.setColorAt(i * 4 + 3, tail);
    }
    crossLights.instanceColor.needsUpdate = true;
    crossBodies.instanceColor.needsUpdate = true;
  }
  const crossPosition = (i, t, out = new Vector3()) => {
    const c = crossCars[i];
    return out.set(interX + wrap(c.x0 + c.dir * c.speed * t, -CROSS_HALF, CROSS_HALF), 0, c.laneZ);
  };
  // Shared writer: body at (x,z) heading ry, with two front and two rear lights.
  const writeCarLights = (lights, base, x, z, ry, visible, big = 1) => {
    _q.setFromEuler(_e.set(0, ry, 0));
    const s = visible ? big : 0;
    for (let k = 0; k < 4; k++) {
      const front = k < 2;
      _o.set((k % 2 ? 1 : -1) * 0.65, 0.75, front ? -CAR_LEN / 2 : CAR_LEN / 2).applyQuaternion(_q);
      setM(lights, base + k, x + _o.x, _o.y, z + _o.z, ry, s, s, s);
    }
  };
  function updateCross(t) {
    if (!crossBodies) return;
    const p = new Vector3();
    for (let i = 0; i < crossCars.length; i++) {
      const c = crossCars[i];
      crossPosition(i, t, p);
      const ry = heading(c.dir, 0);
      setM(crossBodies, i, p.x, 0, p.z, ry);
      writeCarLights(crossLights, i * 4, p.x, p.z, ry, true);
    }
    crossBodies.instanceMatrix.needsUpdate = true;
    crossLights.instanceMatrix.needsUpdate = true;
  }
  handles.intersection = interZ === null ? null : {
    center: new Vector3(interX, 0, interZ), crossCars, crossPosition, bodies: crossBodies, lights: crossLights,
  };

  // ---- Delivery truck blocking part of the road ------------------------
  const truckZ = -45;
  const truckX = roadHalf - 2.4;
  const truck = new Group();
  truck.name = 'deliveryTruck';
  const cargoMat = mat(new MeshStandardMaterial({ color: 0xc9c9c2, roughness: 0.6, metalness: 0.2 }));
  const cabMat = mat(new MeshStandardMaterial({ color: 0x2a4a7a, roughness: 0.4, metalness: 0.5 }));
  const darkMat = mat(new MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.8 }));
  addBox(truck, 2.6, 0.5, 8.4, darkMat, 0, 0.55, 0);
  addBox(truck, 2.6, 2.9, 5.6, cargoMat, 0, 2.25, 1.4);
  addBox(truck, 2.5, 2.1, 2.2, cabMat, 0, 1.7, -3.6);
  addBox(truck, 2.3, 0.8, 0.1, darkMat, 0, 2.2, -4.72); // windscreen
  const hazardMats = [0, 1].map(() => mat(new MeshBasicMaterial({ color: 0x000000 })));
  hazardMats.forEach((m, i) => addBox(truck, 0.3, 0.2, 0.08, m, i ? 1 : -1, 1.0, 4.25));
  truck.position.set(truckX, 0, truckZ);
  truck.rotation.y = 0.1;
  truck.traverse((o) => { o.frustumCulled = false; });
  group.add(truck);
  const hazardOn = new Color(0xffa010).multiplyScalar(3);
  const hazardOff = new Color(0x1a0d00);
  const truckBlocks = (x, z) => x > truckX - 3 && Math.abs(z - truckZ) < 9;
  handles.truck = {
    group: truck, position: truck.position.clone(), halfWidth: 1.3, length: 8.4,
    clearLaneX: 0, blocks: truckBlocks,
  };

  // ---- Final sharp turn into a narrow side street ----------------------
  const sidePts = route.sideStreet || [];
  if (sidePts.length >= 2) {
    const sideSpline = createSpline(sidePts.map(([x, z]) => new Vector3(x, 0, z)));
    const step = 2;
    const rows = Math.max(2, Math.ceil(sideSpline.length / step));
    const left = [], right = [];
    const taper = 20;
    const pt = new Vector3(), tg = new Vector3();
    for (let i = 0; i <= rows; i++) {
      const u = i / rows;
      const s = u * sideSpline.length;
      sideSpline.getPointAt(u, pt);
      sideSpline.getTangentAt(u, tg);
      tg.y = 0; tg.normalize();
      const nx = -tg.z, nz = tg.x;
      // Tunnel-width mouth tapering to a narrow lane.
      const hw = lerp(roadHalf + 1.5, SIDE_STREET_HALF, Math.min(1, s / taper));
      left.push([pt.x + nx * hw, pt.z + nz * hw]);
      right.push([pt.x - nx * hw, pt.z - nz * hw]);
    }
    const pos = [], idx = [];
    const wall = (line) => {
      const b = pos.length / 3;
      line.forEach(([x, z], i) => {
        pos.push(x, 0, z, x, SIDE_WALL_HEIGHT, z);
        if (i > 0) { const a = b + (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      });
    };
    wall(left);
    wall(right);
    // End cap closing the street.
    const last = rows;
    const b = pos.length / 3;
    pos.push(left[last][0], 0, left[last][1], left[last][0], SIDE_WALL_HEIGHT, left[last][1],
      right[last][0], 0, right[last][1], right[last][0], SIDE_WALL_HEIGHT, right[last][1]);
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    const g = geo(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.boundingSphere = BIG_SPHERE.clone();
    const walls = new Mesh(g, concrete);
    walls.name = 'sideStreetWalls';
    walls.frustumCulled = false;
    group.add(walls);
    const endPt = new Vector3(sidePts[sidePts.length - 1][0], 0, sidePts[sidePts.length - 1][1]);
    const turnPt = new Vector3(sidePts[2 < sidePts.length ? 2 : 1][0], 0, sidePts[2 < sidePts.length ? 2 : 1][1]);
    handles.sideStreet = {
      spline: sideSpline, mesh: walls, halfWidth: SIDE_STREET_HALF, wallHeight: SIDE_WALL_HEIGHT,
      entry: new Vector3(sidePts[0][0], 0, sidePts[0][1]), turn: turnPt, end: endPt,
    };
  }

  // ---- Distant traffic (instanced, headlight/taillight colours, LOD) ---
  const nTraffic = Math.max(0, Math.floor(settings.quality?.distantTraffic ?? 0));
  const lodMid = settings.lod.mid, lodFar = settings.lod.far;
  const traffic = [];
  let trafficBodies = null, trafficLights = null;
  if (nTraffic > 0) {
    const bodyGeo = geo(new BoxGeometry(1.8, 1.25, CAR_LEN));
    bodyGeo.translate(0, 0.7, 0);
    trafficBodies = makeInstanced('trafficBodies', bodyGeo,
      mat(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.6 })), nTraffic);
    const glowGeo = geo(new BoxGeometry(0.5, 0.22, 0.08));
    trafficLights = makeInstanced('trafficLights', glowGeo, mat(new MeshBasicMaterial({ color: 0xffffff })), nTraffic * 4);
    const head = new Color(settings.lighting.headlight.color).multiplyScalar(3);
    const tail = new Color(settings.lighting.brake.color).multiplyScalar(2.5);
    const paint = [0x3a4a5c, 0x5c3a3a, 0x2e2e33, 0x4b5b46, 0x9a9a92];
    const span = TRAFFIC_Z_MAX - TRAFFIC_Z_MIN;
    for (let i = 0; i < nTraffic; i++) {
      const oncoming = i % 2 === 1;
      const car = {
        oncoming,
        x: (oncoming ? 1 : -1) * range(rng, 3.0, 3.8),
        z0: TRAFFIC_Z_MIN + (i / nTraffic) * span + range(rng, 0, span / nTraffic),
        vz: (oncoming ? 1 : -1) * range(rng, 10, 20),
      };
      traffic.push(car);
      trafficBodies.setColorAt(i, _c.set(pick(rng, paint)));
      // Oncoming cars show headlights to the camera (front faces +z); same-direction show taillights.
      const c = oncoming ? head : tail;
      for (let k = 0; k < 4; k++) trafficLights.setColorAt(i * 4 + k, c);
    }
    trafficBodies.instanceColor.needsUpdate = true;
    trafficLights.instanceColor.needsUpdate = true;
  }
  const trafficPosition = (i, t, out = new Vector3()) => {
    const c = traffic[i];
    return out.set(c.x, 0, wrap(c.z0 + c.vz * t, TRAFFIC_Z_MIN, TRAFFIC_Z_MAX));
  };
  function updateTraffic(t, center) {
    if (!trafficBodies) return;
    const p = new Vector3();
    let nb = 0, nl = 0;
    for (let i = 0; i < traffic.length; i++) {
      const c = traffic[i];
      trafficPosition(i, t, p);
      if (truckBlocks(p.x, p.z)) continue;
      const d = p.distanceTo(center);
      if (d > lodFar) continue;
      const ry = c.oncoming ? heading(0, 1) : heading(0, -1);
      if (d <= lodMid) setM(trafficBodies, nb++, p.x, 0, p.z, ry); // near LOD: body + lights
      // Far LOD: lights only, scaled up so they still read through fog.
      writeCarLights(trafficLights, nl, p.x, p.z, ry, true, d > lodMid ? 1 + (d - lodMid) / lodFar * 2 : 1);
      nl += 4;
    }
    trafficBodies.count = nb;
    trafficLights.count = nl;
    trafficBodies.instanceMatrix.needsUpdate = true;
    trafficLights.instanceMatrix.needsUpdate = true;
  }
  handles.traffic = { count: nTraffic, cars: traffic, position: trafficPosition, bodies: trafficBodies, lights: trafficLights };

  // ---- Steam vent anchors (sewer grates) -------------------------------
  const ventSpots = [];
  const zOr = (z) => Math.max(tunnelZ1 + 5, z);
  const candidates = [-28, -72, hasTunnel ? (tunnelZ0 + tunnelZ1) / 2 + 20 : -160, hasTunnel ? zOr(tunnelZ1 + 30) : -250];
  for (const z of candidates) {
    ventSpots.push(new Vector3((rng() < 0.5 ? -1 : 1) * range(rng, 3.5, 5.5), 0.03, z));
  }
  if (handles.sideStreet) {
    const e = handles.sideStreet.turn;
    ventSpots.push(new Vector3(e.x + 2, 0.03, e.z + 1.5));
  }
  const ventGeo = geo(new CylinderGeometry(0.45, 0.45, 0.04, 12));
  const vents = makeInstanced('steamVentGrates', ventGeo, darkMat, ventSpots.length);
  ventSpots.forEach((v, i) => setM(vents, i, v.x, v.y, v.z));
  vents.instanceMatrix.needsUpdate = true;
  handles.steamVents = ventSpots.map((position, id) => ({
    id, position, direction: new Vector3(0, 1, 0), rate: 0.6 + 0.4 * ((id * 0.37) % 1),
  }));

  // ---- Near-miss barriers (anchors + jersey barrier instances) ---------
  const barrierSpots = [];
  const addBarrier = (x, z, ry = 0, kind = 'roadside') => barrierSpots.push({ position: new Vector3(x, 0, z), ry, kind });
  addBarrier(truckX - 2.2, truckZ + 6.5, 0, 'truck');
  addBarrier(truckX - 2.2, truckZ - 6.5, 0, 'truck');
  if (interZ !== null) {
    addBarrier(-(roadHalf - 0.6), interZ - roadHalf - 6, 0, 'intersection');
    addBarrier(roadHalf - 0.6, interZ - roadHalf - 6, 0, 'intersection');
  }
  if (hasTunnel) {
    for (const dz of [14, 20, 26]) addBarrier(tunnelX + (dz % 2 ? 5.5 : -5.5), tunnelZ1 + dz, 0, 'tunnelExit');
  }
  const barGeo = geo(new BoxGeometry(0.6, 0.9, 3));
  barGeo.translate(0, 0.45, 0);
  const bars = makeInstanced('nearMissBarriers', barGeo,
    mat(new MeshStandardMaterial({ color: 0x8b8d90, roughness: 0.8 })), barrierSpots.length);
  barrierSpots.forEach((b, i) => setM(bars, i, b.position.x, 0, b.position.z, b.ry));
  bars.instanceMatrix.needsUpdate = true;
  handles.nearMissBarriers = barrierSpots.map((b, id) => ({
    id, kind: b.kind, position: b.position.clone().setY(0.45), radius: 1.5,
  }));

  // ---- Per-frame update (pure function of t) ---------------------------
  const lodDefault = new Vector3(0, 0, 60);
  function update(t = 0, center = lodDefault) {
    handles.tunnel?.write(t);
    updateCross(t);
    updateTraffic(t, center);
    const blink = (t * 1.6) % 1 < 0.5;
    for (const m of hazardMats) m.color.copy(blink ? hazardOn : hazardOff);
  }
  update(0);

  function dispose() {
    for (const im of instancedMeshes) im.dispose();
    for (const g of geometries) g.dispose();
    for (const m of ownMaterials) m.dispose();
    instancedMeshes.length = 0;
    geometries.length = 0;
    ownMaterials.length = 0;
    group.removeFromParent();
  }

  return { group, update, dispose, handles };
}
