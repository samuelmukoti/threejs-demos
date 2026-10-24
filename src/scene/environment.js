// Environment: fog + wetness (renderer-free) and renderer-only reflections
// (PMREM sky environment, slow CubeCamera probe, low-res road Reflector).
// Everything touching a WebGLRenderer lives behind init(renderer), so
// createEnvironment() itself is Node-safe.
import {
  Scene, Mesh, BoxGeometry, SphereGeometry, PlaneGeometry, ShaderMaterial, MeshBasicMaterial,
  FogExp2, Color, BackSide, PMREMGenerator, WebGLCubeRenderTarget, CubeCamera, HalfFloatType,
  LinearMipmapLinearFilter, RepeatWrapping, Vector2, Vector3,
} from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { settings as defaultSettings } from '../settings.js';
import { RENDER_ORDER } from './createScene.js';

const PROBE_SIZE = 128;
const PROBE_INTERVAL = 2;      // seconds of timeline t between probe refreshes
const PROBE_NEAR = 0.5;
const PROBE_FAR = 400;
const ROAD_HALF = 7;
const ROAD_Y = 0.03;           // just above asphalt/markings to avoid z-fighting
// Reflector resolution scale relative to the drawing buffer.
const REFLECTION_SCALE = { high: 0.5, medium: 0.35, low: 0.2 };

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Accepts 'high'|'medium'|'low'|'off' or the numeric presets (1, 0.5, 0.25, 0). */
export function normalizeReflectionQuality(q) {
  if (typeof q === 'string') return q in REFLECTION_SCALE ? q : 'off';
  if (typeof q === 'boolean') return q ? 'high' : 'off';
  if (!Number.isFinite(q) || q <= 0) return 'off';
  if (q >= 0.9) return 'high';
  if (q >= 0.45) return 'medium';
  return 'low';
}

// Procedural night sky + a few emissive city "lights" used as the PMREM source.
function buildSkyScene(lighting) {
  const sky = new Scene();
  const geometries = [];
  const mats = [];
  const g = (x) => { geometries.push(x); return x; };
  const m = (x) => { mats.push(x); return x; };

  const dome = new Mesh(g(new SphereGeometry(50, 24, 16)), m(new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new Color(0x02040a) },
      uHorizon: { value: new Color(lighting.fog.color).multiplyScalar(2.5) },
      uGlow: { value: new Color(0x3a2a55) },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, pow(h, 0.45));
        c += uGlow * pow(1.0 - h, 6.0) * 0.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));
  sky.add(dome);

  const panel = (color, intensity, x, y, z, sx, sy, sz) => {
    const mesh = new Mesh(g(new BoxGeometry(sx, sy, sz)), m(new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(intensity),
    })));
    mesh.position.set(x, y, z);
    sky.add(mesh);
  };
  const [pink, cyan, violet] = lighting.neon.colors;
  panel(pink, 6, -30, 8, -10, 2, 14, 10);
  panel(cyan, 6, 30, 10, 12, 2, 18, 8);
  panel(violet, 4, 8, 12, -34, 12, 6, 2);
  panel(lighting.streetlight.color, 8, -18, 14, 22, 3, 1, 3);
  panel(lighting.streetlight.color, 8, 20, 14, -24, 3, 1, 3);
  panel(lighting.moon.color, 3, -20, 40, -15, 6, 1, 6);

  return { sky, dispose: () => { geometries.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); } };
}

// Reflector shader: projective reflection texture, alpha driven by wetness and
// the roughness map so the road reads as patchy wet asphalt, not a mirror.
function createRoadReflectorShader() {
  return {
    name: 'RoadReflectorShader',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      tRough: { value: null },
      uRepeat: { value: new Vector2(8, 8) },
      uStrength: { value: 0.6 },
      uUseRough: { value: 0 },
    },
    vertexShader: /* glsl */`
      uniform mat4 textureMatrix;
      uniform vec2 uRepeat;
      varying vec4 vUv;
      varying vec2 vRoughUv;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vUv = textureMatrix * vec4( position, 1.0 );
        vRoughUv = uv * uRepeat;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform sampler2D tRough;
      uniform float uStrength;
      uniform float uUseRough;
      varying vec4 vUv;
      varying vec2 vRoughUv;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec3 refl = texture2DProj( tDiffuse, vUv ).rgb * color;
        float rough = mix(0.35, texture2D( tRough, vRoughUv ).g, uUseRough);
        float a = uStrength * (1.0 - smoothstep(0.15, 0.95, rough));
        gl_FragColor = vec4( refl, clamp(a, 0.0, 1.0) );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  };
}

/**
 * @param {import('three').Scene} scene
 * @param {{settings?: typeof defaultSettings, materials?: object, roadMesh?: import('three').Object3D}} [options]
 */
export function createEnvironment(scene, { settings = defaultSettings, materials = null, roadMesh = null } = {}) {
  if (!scene) throw new Error('createEnvironment: scene is required');

  const state = {
    wetness: Number.isFinite(settings.rain?.wetness) ? clamp01(settings.rain.wetness) : 0,
    quality: normalizeReflectionQuality(settings.quality?.reflectionQuality),
    size: { w: 1, h: 1 },
    lastProbeT: -Infinity,
    disposed: false,
  };

  // ---- Renderer-free: fog + wetness -------------------------------------
  const { fog } = settings.lighting;
  const baseFogDensity = fog.density;
  if (!scene.fog) scene.fog = new FogExp2(fog.color, fog.density);

  function applyFog() {
    if (!scene.fog) return;
    scene.fog.color.set(fog.color);
    // Wet air hangs a little heavier; kept subtle so the look stays readable.
    scene.fog.density = baseFogDensity * (1 + 0.15 * state.wetness);
  }

  // Renderer-only handles, created in init().
  let renderer = null;
  let pmrem = null;
  let sky = null;
  let envTarget = null;
  let probeTarget = null;
  let probeCamera = null;
  let probeEnvTarget = null;
  let reflector = null;
  let reflectorGeo = null;

  function setWetness(amount = settings.rain.wetness) {
    state.wetness = clamp01(Number.isFinite(amount) ? amount : 0);
    materials?.setWetness?.(state.wetness);
    applyFog();
    if (reflector) reflector.material.uniforms.uStrength.value = reflectionStrength();
  }

  // Wet roads reflect more; dry roads barely at all.
  function reflectionStrength() { return 0.15 + 0.7 * state.wetness; }

  // ---- Road reflector ------------------------------------------------------
  function roadExtent() {
    // Straight stretch only (side street curves away); x = 0 line from route z-range.
    let zMax = -Infinity;
    let zMin = Infinity;
    for (const key of ['boulevard', 'intersection', 'tunnel']) {
      for (const [, z] of settings.route[key] || []) { zMax = Math.max(zMax, z); zMin = Math.min(zMin, z); }
    }
    if (!Number.isFinite(zMax) || zMax - zMin < 1) return { zMax: 60, zMin: -300 };
    return { zMax, zMin };
  }

  function removeReflector() {
    if (!reflector) return;
    reflector.parent?.remove(reflector);
    reflector.dispose();
    reflectorGeo?.dispose();
    reflector = null;
    reflectorGeo = null;
  }

  function buildReflector() {
    removeReflector();
    if (!renderer || state.quality === 'off') return;
    const { zMax, zMin } = roadExtent();
    const length = zMax - zMin;
    reflectorGeo = new PlaneGeometry(ROAD_HALF * 2, length);
    reflectorGeo.rotateX(-Math.PI / 2);
    const [tw, th] = reflectorSize();
    reflector = new Reflector(reflectorGeo, {
      textureWidth: tw,
      textureHeight: th,
      clipBias: 0.003,
      color: 0xffffff,
      shader: createRoadReflectorShader(),
      multisample: 0,
    });
    reflector.name = 'roadReflector';
    reflector.position.set(0, ROAD_Y, (zMax + zMin) / 2);
    reflector.renderOrder = RENDER_ORDER.opaque + 2;
    reflector.frustumCulled = false;
    const mat = reflector.material;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -3;
    mat.polygonOffsetUnits = -3;
    const rough = materials?.textures?.roughnessMap || null;
    if (rough) {
      rough.wrapS = rough.wrapT = RepeatWrapping;
      mat.uniforms.tRough.value = rough;
      mat.uniforms.uUseRough.value = 1;
      mat.uniforms.uRepeat.value.set(8, Math.max(8, length / 14));
    }
    mat.uniforms.uStrength.value = reflectionStrength();
    (roadMesh?.parent || scene).add(reflector);
  }

  function reflectorSize() {
    const k = REFLECTION_SCALE[state.quality] ?? 0.2;
    return [Math.max(16, Math.round(state.size.w * k)), Math.max(16, Math.round(state.size.h * k))];
  }

  // ---- Renderer-only wiring -------------------------------------------------
  function init(r) {
    if (!r) throw new Error('createEnvironment.init: renderer is required');
    if (renderer) return api;
    renderer = r;

    pmrem = new PMREMGenerator(renderer);
    sky = buildSkyScene(settings.lighting);
    envTarget = pmrem.fromScene(sky.sky, 0.04);
    scene.environment = envTarget.texture;

    probeTarget = new WebGLCubeRenderTarget(PROBE_SIZE, {
      type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter,
    });
    probeCamera = new CubeCamera(PROBE_NEAR, PROBE_FAR, probeTarget);

    buildReflector();
    return api;
  }

  /**
   * Refresh the reflection probe at most every PROBE_INTERVAL seconds of t.
   * Safe to call every frame; does nothing between refreshes (or before init()).
   */
  function update(t, position = null) {
    if (!renderer || state.disposed) return false;
    if (Number.isFinite(t) && t >= state.lastProbeT && t - state.lastProbeT < PROBE_INTERVAL) return false;
    state.lastProbeT = Number.isFinite(t) ? t : 0;

    if (position) probeCamera.position.copy(position);
    else probeCamera.position.set(0, 2, 0);

    const prevEnv = scene.environment;
    const prevVisible = reflector ? reflector.visible : true;
    if (reflector) reflector.visible = false;
    scene.environment = envTarget.texture; // never feed the probe its own output
    probeCamera.update(renderer, scene);
    scene.environment = prevEnv;
    if (reflector) reflector.visible = prevVisible;

    const next = pmrem.fromCubemap(probeTarget.texture);
    scene.environment = next.texture;
    probeEnvTarget?.dispose();
    probeEnvTarget = next;
    return true;
  }

  function resize(w, h) {
    state.size.w = Math.max(1, w | 0);
    state.size.h = Math.max(1, h | 0);
    if (reflector) {
      const [tw, th] = reflectorSize();
      reflector.getRenderTarget().setSize(tw, th);
    }
  }

  function setReflectionQuality(q) {
    const next = normalizeReflectionQuality(q);
    if (next === state.quality) return;
    state.quality = next;
    buildReflector();
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    removeReflector();
    probeTarget?.dispose();
    probeEnvTarget?.dispose();
    envTarget?.dispose();
    sky?.dispose();
    pmrem?.dispose();
    if (scene.environment && (scene.environment === envTarget?.texture || scene.environment === probeEnvTarget?.texture)) {
      scene.environment = null;
    }
    probeTarget = probeEnvTarget = envTarget = pmrem = sky = probeCamera = renderer = null;
  }

  applyFog();
  materials?.setWetness?.(state.wetness);

  const api = {
    init,
    update,
    resize,
    setWetness,
    getWetness: () => state.wetness,
    setReflectionQuality,
    getReflectionQuality: () => state.quality,
    get reflector() { return reflector; },
    get probeInterval() { return PROBE_INTERVAL; },
    applyFog,
    dispose,
  };
  return api;
}
