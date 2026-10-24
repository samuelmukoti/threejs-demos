import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { createVehicle } from '../vehicles/Vehicle.js';

// The ONLY module that knows asset file paths. Every load tries a .glb under
// `<BASE>models/` first and falls back to a procedural builder on any failure
// (missing file, missing decoders, parse error, no network). Never throws.

const VEHICLE_IDS = ['lead', 'pursuer'];

const defaultBaseUrl = () => import.meta.env?.BASE_URL ?? '/';
const defaultLogger = (...args) => {
  if (typeof console !== 'undefined') console.info(...args);
};

// ---- procedural props ------------------------------------------------------

/** Simple procedural props, keyed by id. Each returns { group, dispose }. */
const PROP_BUILDERS = {
  cone() {
    const geo = new THREE.ConeGeometry(0.2, 0.7, 16).translate(0, 0.35, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.6 });
    const group = new THREE.Group();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    group.add(m);
    return { group, dispose() { geo.dispose(); mat.dispose(); } };
  },
  barrier() {
    const geo = new THREE.BoxGeometry(2, 0.8, 0.4).translate(0, 0.4, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.8 });
    const group = new THREE.Group();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return { group, dispose() { geo.dispose(); mat.dispose(); } };
  },
  lamp() {
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 6, 8).translate(0, 3, 0);
    const headGeo = new THREE.BoxGeometry(0.8, 0.12, 0.3).translate(0.4, 6, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7, metalness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xffd9a0, emissiveIntensity: 2, roughness: 0.5,
    });
    const group = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.castShadow = true;
    group.add(pole, new THREE.Mesh(headGeo, headMat));
    return {
      group,
      dispose() { poleGeo.dispose(); headGeo.dispose(); poleMat.dispose(); headMat.dispose(); },
    };
  },
};

function placeholderProp() {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo, mat));
  return { group, dispose() { geo.dispose(); mat.dispose(); } };
}

/**
 * Create an asset loader.
 * options: { renderer?, baseUrl?, logger? }. Decoder loaders are created
 * lazily on first load so construction never fails when decoders are missing.
 */
export function createAssetLoader({ renderer = null, baseUrl = defaultBaseUrl(), logger = defaultLogger } = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const mixers = [];
  const fallbacks = new Set(); // procedural disposers
  const loaded = new Set(); // glTF scene roots we own
  let gltfLoader = null;
  let draco = null;
  let ktx2 = null;
  let disposed = false;

  function getLoader() {
    if (gltfLoader) return gltfLoader;
    gltfLoader = new GLTFLoader();
    try {
      draco = new DRACOLoader().setDecoderPath(`${base}draco/gltf/`);
      gltfLoader.setDRACOLoader(draco);
    } catch (err) {
      logger('[assets] DRACO unavailable', err?.message ?? err);
    }
    try {
      ktx2 = new KTX2Loader().setTranscoderPath(`${base}basis/`);
      if (renderer) ktx2.detectSupport(renderer);
      gltfLoader.setKTX2Loader(ktx2);
    } catch (err) {
      logger('[assets] KTX2 unavailable', err?.message ?? err);
    }
    return gltfLoader;
  }

  async function loadGlb(id) {
    const gltf = await getLoader().loadAsync(`${base}models/${id}.glb`);
    const scene = gltf.scene;
    if (gltf.animations?.length) {
      const mixer = new THREE.AnimationMixer(scene);
      for (const clip of gltf.animations) mixer.clipAction(clip).play();
      mixers.push(mixer);
    }
    loaded.add(scene);
    return scene;
  }

  async function load(kind, id, build) {
    if (disposed) throw new Error('assetLoader: disposed');
    try {
      return await loadGlb(id);
    } catch (err) {
      logger(`[assets] ${kind} "${id}": using procedural fallback (${err?.message ?? err})`);
    }
    const { group, dispose } = build();
    fallbacks.add(dispose);
    return group;
  }

  return {
    baseUrl: base,

    /** @returns {Promise<THREE.Group>} */
    loadVehicle(id) {
      return load('vehicle', id, () => {
        const variant = VEHICLE_IDS.includes(id) ? id : 'lead';
        const v = createVehicle(variant);
        const group = new THREE.Group();
        group.name = `vehicle-${id}`;
        group.add(v.root);
        group.userData.vehicle = v;
        return { group, dispose: () => v.dispose() };
      });
    },

    /** @returns {Promise<THREE.Group>} */
    loadProp(id) {
      return load('prop', id, () => {
        const built = (PROP_BUILDERS[id] ?? placeholderProp)();
        built.group.name = `prop-${id}`;
        return built;
      });
    },

    /** Drive every clip mixer from the fixed clock (absolute seconds). */
    updateMixers(t) {
      for (const m of mixers) m.setTime(t);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of mixers) m.stopAllAction();
      mixers.length = 0;
      for (const scene of loaded) {
        scene.removeFromParent();
        scene.traverse((o) => {
          o.geometry?.dispose();
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const mat of mats) {
            for (const v of Object.values(mat)) if (v?.isTexture) v.dispose();
            mat.dispose();
          }
        });
      }
      loaded.clear();
      for (const d of fallbacks) d();
      fallbacks.clear();
      draco?.dispose();
      ktx2?.dispose();
      gltfLoader = draco = ktx2 = null;
    },
  };
}
