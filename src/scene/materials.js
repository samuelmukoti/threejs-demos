// Shared material factory with dry/wet variants. Wetness blends between them.
import { MeshStandardMaterial, Color, Vector2, RepeatWrapping } from 'three';
import { settings } from '../settings.js';
import {
  createAsphaltNormalMap, createRoughnessMap, createWindowAtlas, createNeonRamp,
} from './proceduralTextures.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Per-kind dry and wet parameters. Wet = darker, glossier, stronger reflections.
const SPECS = {
  asphalt: {
    dry: { color: 0x2a2c31, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 },
    wet: { color: 0x121317, roughness: 0.12, metalness: 0.15, envMapIntensity: 1.6 },
  },
  sidewalk: {
    dry: { color: 0x6b6d72, roughness: 0.9, metalness: 0.0, envMapIntensity: 0.25 },
    wet: { color: 0x34363b, roughness: 0.3, metalness: 0.05, envMapIntensity: 1.0 },
  },
  laneMarking: {
    dry: { color: 0xd8d8d0, roughness: 0.6, metalness: 0.0, envMapIntensity: 0.6 },
    wet: { color: 0xa8a8a2, roughness: 0.15, metalness: 0.3, envMapIntensity: 1.8 },
  },
  facade: {
    dry: { color: 0x3a3d48, roughness: 0.85, metalness: 0.05, envMapIntensity: 0.3 },
    wet: { color: 0x22242c, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.8 },
  },
  neon: {
    dry: { color: 0x111111, roughness: 0.4, metalness: 0.0, envMapIntensity: 0.5 },
    wet: { color: 0x111111, roughness: 0.25, metalness: 0.0, envMapIntensity: 0.8 },
  },
  metal: {
    dry: { color: 0x70747c, roughness: 0.55, metalness: 0.9, envMapIntensity: 0.8 },
    wet: { color: 0x40444c, roughness: 0.28, metalness: 0.95, envMapIntensity: 1.6 },
  },
};

/**
 * @param {{seed?: number, wetness?: number, textureSize?: number}} [options]
 * Wetness defaults to settings.rain.wetness.
 */
export function createMaterials({ seed = 1337, wetness = settings.rain.wetness, textureSize = 128 } = {}) {
  const tracked = [];
  const track = (o) => { tracked.push(o); return o; };

  const asphaltNormal = track(createAsphaltNormalMap(seed, textureSize));
  const roughnessMap = track(createRoughnessMap(seed + 1, textureSize));
  const windowAtlas = track(createWindowAtlas(seed + 2));
  const neonRamp = track(createNeonRamp(settings.lighting.neon.colors));
  for (const t of [asphaltNormal, roughnessMap]) t.repeat.set(8, 8);

  const dry = (k) => SPECS[k].dry;
  const make = (kind, extra = {}) => {
    const mat = track(new MeshStandardMaterial({ ...dry(kind), ...extra }));
    mat.userData.kind = kind;
    return mat;
  };

  const materials = {
    asphalt: make('asphalt', { normalMap: asphaltNormal, normalScale: new Vector2(0.8, 0.8), roughnessMap }),
    sidewalk: make('sidewalk', { normalMap: asphaltNormal, normalScale: new Vector2(0.5, 0.5) }),
    laneMarking: make('laneMarking', { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    facade: make('facade', {
      emissive: new Color(0xffffff), emissiveMap: windowAtlas, emissiveIntensity: 1.6,
    }),
    neon: make('neon', {
      emissive: new Color(0xffffff), emissiveMap: neonRamp,
      emissiveIntensity: settings.lighting.neon.intensity / 4,
    }),
    metal: make('metal'),
  };
  materials.asphalt.normalMap.wrapS = materials.asphalt.normalMap.wrapT = RepeatWrapping;

  const tmp = new Color();
  const state = { wetness: 0 };

  function setWetness(amount = settings.rain.wetness) {
    const w = clamp01(Number.isFinite(amount) ? amount : 0);
    state.wetness = w;
    for (const mat of Object.values(materials)) {
      const { dry: d, wet: s } = SPECS[mat.userData.kind];
      mat.color.set(d.color).lerp(tmp.set(s.color), w);
      mat.roughness = d.roughness + (s.roughness - d.roughness) * w;
      mat.metalness = d.metalness + (s.metalness - d.metalness) * w;
      mat.envMapIntensity = d.envMapIntensity + (s.envMapIntensity - d.envMapIntensity) * w;
    }
    // Puddles: roughness map influence fades as the surface gets uniformly wet.
    materials.asphalt.roughnessMap = w > 0.98 ? null : roughnessMap;
    materials.asphalt.needsUpdate = true;
  }

  function dispose() {
    for (const o of tracked) o.dispose();
    tracked.length = 0;
  }

  setWetness(wetness);

  return {
    ...materials,
    textures: { asphaltNormal, roughnessMap, windowAtlas, neonRamp },
    setWetness,
    getWetness: () => state.wetness,
    tracked,
    dispose,
  };
}
