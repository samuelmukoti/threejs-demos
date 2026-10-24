import * as THREE from 'three';
import { settings } from '../settings.js';
import { mulberry32 } from '../utils/prng.js';

// Procedural vehicle rig. Pure three.js scene-graph (no canvas/DOM), so it
// builds under Node. Model space: +y up, forward = +z (heading 0 travels +z),
// matching vehiclePhysics where heading = atan2(tangent.x, tangent.z).
//
// Hierarchy:
//   root (position, yaw)
//   ├─ body (roll/pitch) ─ paint, glass, lights, spoiler, grille, exhaust, exhaustEmitter
//   ├─ suspFL/FR/RL/RR (wheel bump travel)
//   │    └─ steeringPivot (front axle: yaw by steer)
//   │         ├─ wheelXX (spin) ─ tyre, rim, spokes, brake disc
//   │         └─ tireContactXX (fixed point on the ground under the wheel)
//   └─ collisionProxy (hidden box; wireframe toggle)

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
// The physics state table's "left" wheels (+ compression under positive lateral
// accel) sit on the -x side, because positive heading turns toward +x. Rig
// names use the true left-hand convention (FL at +x), so map rig -> state index.
const STATE_INDEX = { FL: 1, FR: 0, RL: 3, RR: 2 };
const SIDE = { FL: 1, FR: -1, RL: 1, RR: -1 }; // +x is the vehicle's left
const FRONT = { FL: true, FR: true, RL: false, RR: false };
const BUMP_TRAVEL = 0.35; // visual scale of suspension metres -> wheel node offset
const BEVEL = 0.04;
const CLEARANCE = 0.16;
const TAIL_BASE = 0.8;
const TAIL_GAIN = 7;
const HEAD_GAIN = 6;
const AUX_GAIN = 4;

const VARIANTS = {
  lead: {
    paintColor: 0x0b1b4d,
    metalness: 0.9, roughness: 0.3,
    // Side profile as [z as fraction of length, y as fraction of height].
    hull: [[-0.5, 0], [0.5, 0], [0.5, 0.34], [0.4, 0.46], [0.1, 0.53], [-0.3, 0.58], [-0.5, 0.52]],
    cabin: [[-0.24, 0.55], [-0.13, 1], [0.06, 1], [0.2, 0.54]],
    cabinWidth: 0.82,
    wheelWidth: 0.26,
  },
  pursuer: {
    paintColor: 0x3a3f46, // gunmetal
    metalness: 0.75, roughness: 0.42,
    hull: [[-0.5, 0], [0.5, 0], [0.5, 0.5], [0.44, 0.6], [0.12, 0.63], [-0.34, 0.65], [-0.5, 0.6]],
    cabin: [[-0.3, 0.62], [-0.23, 1], [0.1, 1], [0.22, 0.62]],
    cabinWidth: 0.86,
    wheelWidth: 0.32,
  },
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- shared resource cache (ref-counted) ---------------------------------
const cache = new Map();

function acquire(held, key, factory) {
  let entry = cache.get(key);
  if (!entry) {
    entry = { value: factory(), refs: 0 };
    cache.set(key, entry);
  }
  entry.refs++;
  held.push(key);
  return entry.value;
}

function release(held) {
  for (const key of held) {
    const entry = cache.get(key);
    if (!entry) continue;
    if (--entry.refs <= 0) {
      entry.value.dispose();
      cache.delete(key);
    }
  }
  held.length = 0;
}

/** Subtle orange-peel normal map built as a DataTexture (no canvas; Node-safe). */
function createPaintNormalMap(size = 64) {
  const rng = mulberry32(7);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = rng();
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Extrude a side profile (z,y fractions) across `width`, centred on x = 0. */
function extrudeProfile(points, length, height, width, bevel = BEVEL) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z * length, y * height)));
  const depth = Math.max(width - 2 * bevel, 0.05);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 3, curveSegments: 4,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2); // shape x -> model z, extrusion z -> model x
  geo.computeVertexNormals();
  return geo;
}

function emissive(color, intensity) {
  return new THREE.MeshStandardMaterial({
    color: 0x050505, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0,
  });
}

function mesh(geo, mat, name, castShadow = true) {
  const m = new THREE.Mesh(geo, mat);
  if (name) m.name = name;
  m.castShadow = castShadow;
  return m;
}

/**
 * Build a vehicle rig.
 * variant: 'lead' | 'pursuer'. params: optional overrides of
 * { mass, dimensions:{length,width,height}, wheelRadius, paintColor }.
 * Defaults come from settings.vehicles[variant].
 */
export function createVehicle(variant, params = {}) {
  const design = VARIANTS[variant];
  if (!design) throw new Error(`createVehicle: unknown variant "${variant}" (expected 'lead' or 'pursuer')`);
  const base = settings.vehicles[variant] ?? {};
  const dims = { ...base.dimensions, ...params.dimensions };
  const { length: L, width: W, height: H } = dims;
  if (!(L > 0 && W > 0 && H > 0)) throw new Error('createVehicle: dimensions must be positive');
  const mass = params.mass ?? base.mass ?? 1450;
  const R = params.wheelRadius ?? 0.34;
  if (!(R > 0)) throw new Error('createVehicle: wheelRadius must be > 0');
  const paintColor = params.paintColor ?? design.paintColor;
  const tw = design.wheelWidth;
  const isLead = variant === 'lead';

  const held = [];
  const ownedMaterials = [];
  const ownedGeometries = [];
  const own = (mat) => { ownedMaterials.push(mat); return mat; };
  const ownGeo = (geo) => { ownedGeometries.push(geo); return geo; };
  const dimKey = `${variant}|${L}|${W}|${H}`;

  // ---- shared materials / geometries
  const normalMap = acquire(held, 'normalMap', () => createPaintNormalMap());
  const paint = acquire(held, `paint|${variant}|${paintColor}`, () => new THREE.MeshPhysicalMaterial({
    color: paintColor, metalness: design.metalness, roughness: design.roughness,
    clearcoat: 1, clearcoatRoughness: 0.06, normalMap, normalScale: new THREE.Vector2(0.12, 0.12),
  }));
  const glass = acquire(held, 'glass', () => new THREE.MeshPhysicalMaterial({
    color: 0x05080f, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02,
  }));
  const trim = acquire(held, 'trim', () => new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.6, metalness: 0.3 }));
  const metal = acquire(held, 'metal', () => new THREE.MeshStandardMaterial({ color: 0x8b9199, roughness: 0.3, metalness: 1 }));
  const rubber = acquire(held, 'rubber', () => new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9, metalness: 0 }));
  const rimMat = acquire(held, `rim|${variant}`, () => new THREE.MeshStandardMaterial({
    color: isLead ? 0x9aa3ad : 0x2b2e33, roughness: 0.25, metalness: 1,
  }));
  const hullGeo = acquire(held, `hull|${dimKey}`, () => extrudeProfile(design.hull, L, H, W));
  const cabinGeo = acquire(held, `cabin|${dimKey}`, () => extrudeProfile(design.cabin, L, H, W * design.cabinWidth, 0.03));
  const tireGeo = acquire(held, `tire|${R}|${tw}`, () => new THREE.CylinderGeometry(R, R, tw, 28).rotateZ(Math.PI / 2));
  const rimGeo = acquire(held, `rimGeo|${R}|${tw}`, () => new THREE.CylinderGeometry(R * 0.66, R * 0.66, tw * 1.02, 24).rotateZ(Math.PI / 2));
  const spokeGeo = acquire(held, `spoke|${R}|${tw}`, () => new THREE.BoxGeometry(tw * 1.06, R * 0.58, R * 0.1).translate(0, R * 0.33, 0));
  const discGeo = acquire(held, `disc|${R}`, () => new THREE.CylinderGeometry(R * 0.52, R * 0.52, 0.025, 24).rotateZ(Math.PI / 2));
  const unitBox = acquire(held, 'unitBox', () => new THREE.BoxGeometry(1, 1, 1));
  const pipeGeo = acquire(held, 'pipe', () => new THREE.CylinderGeometry(0.045, 0.05, 0.22, 12).rotateX(Math.PI / 2));

  // ---- per-vehicle materials (intensity is animated per instance)
  const tailMat = own(emissive(0xff1010, TAIL_BASE));
  const headMat = own(emissive(0xe6f2ff, 0));
  const auxMat = own(emissive(0xffa020, 0));
  const discMat = own(new THREE.MeshStandardMaterial({
    color: 0x55585d, roughness: 0.4, metalness: 0.9, emissive: 0xff5a10, emissiveIntensity: 0,
  }));
  const proxyMat = own(new THREE.MeshBasicMaterial({ color: 0x00ff66, wireframe: true }));
  const proxyGeo = ownGeo(new THREE.BoxGeometry(L, H - CLEARANCE, W));

  const box = (mat, sx, sy, sz, x, y, z, name, parent, shadow = false) => {
    const m = mesh(unitBox, mat, name, shadow);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  const root = new THREE.Group();
  root.name = `vehicle_${variant}`;
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const hull = mesh(hullGeo, paint, 'hull');
  hull.position.y = CLEARANCE;
  const cabin = mesh(cabinGeo, glass, 'cabin');
  cabin.position.y = CLEARANCE;
  body.add(hull, cabin);
  // Roof panel in paint over the glass.
  const roofTop = design.cabin.reduce((a, p) => Math.max(a, p[1]), 0) * H + CLEARANCE;
  const roofSpan = design.cabin.filter((p) => p[1] === 1).map((p) => p[0] * L);
  const roofLen = Math.abs(roofSpan[1] - roofSpan[0]);
  box(paint, W * design.cabinWidth * 0.94, 0.03, roofLen, 0, roofTop + 0.01, (roofSpan[0] + roofSpan[1]) / 2, 'roof', body);

  const frontZ = L / 2 + BEVEL * 0.8 + 0.004;
  const rearZ = -L / 2 - BEVEL * 0.8 - 0.004;
  const noseTop = design.hull[2][1] * H + CLEARANCE;

  // Underbody splitter / skirt for a grounded look.
  box(trim, W * 0.96, 0.05, L * 0.98, 0, CLEARANCE + 0.02, 0, 'underbody', body);

  // ---- lights
  const headAnchors = [];
  if (isLead) {
    for (const s of [1, -1]) {
      box(headMat, W * 0.26, 0.045, 0.02, s * W * 0.3, noseTop - 0.1, frontZ, `headlight${s > 0 ? 'L' : 'R'}`, body);
    }
    // Full-width LED tail bar.
    box(tailMat, W * 0.86, 0.055, 0.02, 0, design.hull[6][1] * H + CLEARANCE - 0.12, rearZ, 'taillight', body);
  } else {
    for (const s of [1, -1]) {
      const lamp = mesh(unitBox, headMat, `headlight${s > 0 ? 'L' : 'R'}`, false);
      lamp.scale.set(W * 0.2, 0.11, 0.02);
      lamp.position.set(s * W * 0.37, noseTop - 0.14, frontZ);
      body.add(lamp);
      box(tailMat, W * 0.2, 0.1, 0.02, s * W * 0.36, design.hull[6][1] * H + CLEARANCE - 0.14, rearZ, `taillight${s > 0 ? 'L' : 'R'}`, body);
    }
    // Distinctive grille: dark recess with three bright slats.
    box(trim, W * 0.42, 0.2, 0.03, 0, noseTop - 0.17, frontZ - 0.005, 'grille', body);
    for (let i = 0; i < 3; i++) {
      box(metal, W * 0.38, 0.018, 0.035, 0, noseTop - 0.1 - i * 0.065, frontZ + 0.002, `grilleSlat${i}`, body);
    }
    // Amber auxiliary light bar along the lower valance.
    for (let i = 0; i < 4; i++) {
      box(auxMat, W * 0.1, 0.06, 0.03, (i - 1.5) * W * 0.13, CLEARANCE + 0.12, frontZ, `auxLight${i}`, body);
    }
    // Hood scoop-like vents.
    for (const s of [1, -1]) box(trim, W * 0.18, 0.02, L * 0.14, s * W * 0.2, design.hull[4][1] * H + CLEARANCE + 0.03, L * 0.16, 'hoodVent', body);
  }
  for (const s of [1, -1]) {
    const a = new THREE.Object3D();
    a.name = `headlightAnchor${s > 0 ? 'L' : 'R'}`;
    a.position.set(s * W * (isLead ? 0.3 : 0.37), noseTop - 0.1, frontZ + 0.02);
    body.add(a);
    headAnchors.push(a);
  }

  // ---- rear spoiler (lead) / exhaust (both; pursuer's is prominent)
  if (isLead) {
    const deckY = design.hull[5][1] * H + CLEARANCE;
    const wingY = deckY + 0.14;
    const wingZ = -L * 0.45;
    box(paint, W * 0.86, 0.03, 0.26, 0, wingY, wingZ, 'spoilerWing', body, true);
    for (const s of [1, -1]) box(paint, 0.04, 0.14, 0.12, s * W * 0.3, deckY + 0.06, wingZ, 'spoilerStrut', body);
  }
  const exhaustEmitter = new THREE.Object3D();
  exhaustEmitter.name = 'exhaustEmitter';
  const pipeX = isLead ? [W * 0.3, -W * 0.3] : [W * 0.22, -W * 0.22];
  for (const x of pipeX) {
    const pipe = mesh(pipeGeo, metal, 'exhaustPipe', false);
    pipe.position.set(x, CLEARANCE + (isLead ? 0.05 : 0.1), rearZ - (isLead ? 0.0 : 0.08));
    body.add(pipe);
  }
  exhaustEmitter.position.set(0, CLEARANCE + (isLead ? 0.05 : 0.1), rearZ - (isLead ? 0.12 : 0.2));
  body.add(exhaustEmitter);

  // ---- wheels
  const track = W / 2 - tw / 2 + 0.02;
  const wheelbase = L * 0.6;
  const wheels = {};
  const steeringPivots = [];
  const suspensionNodes = [];
  const brakeDiscs = [];
  const tireContactPoints = [];
  for (const id of WHEELS) {
    const side = SIDE[id];
    const susp = new THREE.Group();
    susp.name = `suspension${id}`;
    susp.position.set(side * track, R, (FRONT[id] ? 1 : -1) * wheelbase / 2);
    const pivot = new THREE.Group();
    pivot.name = 'steeringPivot';
    pivot.userData.wheel = id;
    const wheel = new THREE.Group();
    wheel.name = `wheel${id}`;
    wheel.add(mesh(tireGeo, rubber, 'tire'), mesh(rimGeo, rimMat, 'rim', false));
    for (let i = 0; i < 5; i++) {
      const sp = mesh(spokeGeo, rimMat, 'spoke', false);
      sp.position.x = side * tw * 0.02;
      sp.rotation.x = (i / 5) * Math.PI * 2;
      wheel.add(sp);
    }
    const disc = mesh(discGeo, discMat, 'brakeDisc', false);
    disc.position.x = -side * tw * 0.3;
    wheel.add(disc);
    brakeDiscs.push(disc);
    const contact = new THREE.Object3D();
    contact.name = `tireContact${id}`;
    contact.position.y = -R;
    pivot.add(wheel, contact);
    susp.add(pivot);
    root.add(susp);
    wheels[id] = wheel;
    suspensionNodes.push(susp);
    tireContactPoints.push(contact);
    if (FRONT[id]) steeringPivots.push(pivot);
  }

  // ---- collision proxy + debug wireframe
  const collisionProxy = new THREE.Mesh(proxyGeo, proxyMat);
  collisionProxy.name = 'collisionProxy';
  collisionProxy.position.y = CLEARANCE + (H - CLEARANCE) / 2;
  collisionProxy.visible = false;
  collisionProxy.castShadow = false;
  root.add(collisionProxy);

  let disposed = false;
  const vehicle = {
    variant,
    mass,
    dimensions: dims,
    wheelRadius: R,
    root,
    body,
    wheels,
    wheelList: WHEELS.map((id) => wheels[id]),
    steeringPivots,
    suspensionNodes,
    brakeDiscs,
    exhaustEmitter,
    tireContactPoints,
    headlightAnchors: headAnchors,
    collisionProxy,

    /** Brake light / disc glow, i in [0,1]. Emissive exceeds 1 so bloom picks it up. */
    setBrake(i) {
      const k = clamp01(i);
      tailMat.emissiveIntensity = TAIL_BASE + k * TAIL_GAIN;
      discMat.emissiveIntensity = k * 1.5;
    },
    /** Headlight (and auxiliary light) intensity, i in [0,1]. */
    setHeadlights(i) {
      const k = clamp01(i);
      headMat.emissiveIntensity = k * HEAD_GAIN;
      auxMat.emissiveIntensity = k * AUX_GAIN;
    },
    /** Show or hide the collision-proxy wireframe. */
    setDebugWireframe(on) {
      collisionProxy.visible = !!on;
    },
    /** Pose the rig from a vehiclePhysics state (see createVehicleState). */
    applyState(state) {
      if (disposed) return vehicle;
      if (!state || !state.position) throw new Error('applyState: state with position required');
      root.position.copy(state.position);
      root.rotation.y = state.yaw;
      body.rotation.z = state.roll;
      body.rotation.x = -state.pitch;
      for (let w = 0; w < 4; w++) {
        const id = WHEELS[w];
        suspensionNodes[w].position.y = R + state.suspension[STATE_INDEX[id]] * BUMP_TRAVEL;
        wheels[id].rotation.x = state.wheelRotation;
      }
      for (const p of steeringPivots) p.rotation.y = state.steer;
      vehicle.setBrake(state.brakeIntensity ?? 0);
      return vehicle;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      for (const g of ownedGeometries) g.dispose();
      for (const m of ownedMaterials) m.dispose();
      release(held);
    },
  };
  return vehicle;
}
