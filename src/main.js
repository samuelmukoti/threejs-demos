import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { settings, applyQualityPreset } from './settings.js';
import { createAssetLoader } from './assets/assetLoader.js';
import { createScene } from './scene/createScene.js';
import { createLighting } from './scene/lighting.js';
import { createEnvironment } from './scene/environment.js';
import { configureRenderer, createComposer, resetInfo } from './postprocessing/composer.js';
import { buildDefaultTimeline } from './animation/chaseTimeline.js';
import { createAudioBus } from './audio/audioBus.js';
import { createVehicleState, sampleState, simulateRun } from './vehicles/vehiclePhysics.js';
import { createVehicleEffects } from './vehicles/vehicleEffects.js';
import { createRain } from './effects/rain.js';
import { createCameraRig } from './camera/cameraRig.js';
import { createCinematicCamera, CAMERA_MODES } from './camera/cinematicCamera.js';
import { createDebugPanel } from './ui/debugPanel.js';

const DEFAULT_SEED = 1337;
const MAX_FRAME_DT = 0.1; // wall-clock clamp so a stalled tab never fast-forwards the sim
const PIXEL_RATIO_CAP = 2;
const DEGRADE_THRESHOLD_MS = 25;
const DEGRADE_WINDOW = 90;
const FREE_CAMERA = 'free';
const PURSUER_OFFSET = 14;
const PURSUER_LAG = 1.2;
const LENS_STRENGTH = { hood: 0.9, wheelLevel: 0.8, tunnel: 0.6, rearChase: 0.35 };
const PARTICLE_SYSTEMS = ['tireSmoke', 'sparks', 'exhaust', 'rain'];
const QUALITY_ORDER = ['high', 'medium', 'low'];

const smoothstep = (a, b, x) => {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
};

export function parseParams(search = globalThis.location?.search ?? '') {
  const p = new URLSearchParams(search);
  const num = (key) => {
    if (!p.has(key)) return null;
    const v = Number(p.get(key));
    return Number.isFinite(v) ? v : null;
  };
  const seed = num('seed');
  const t = num('t');
  const debug = p.has('debug');
  const paused = p.has('paused');
  return {
    debug,
    paused,
    t,
    seed: seed === null ? DEFAULT_SEED : Math.trunc(seed),
    test: p.has('t') || paused || p.has('seed'),
    autoDegrade: p.has('autodegrade'),
  };
}

export function hasWebGL(doc = globalThis.document) {
  try {
    const canvas = doc.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

// Stable FNV-1a hash over a flat list of numbers/strings (numbers rounded to 1e-4).
export function hashValues(values) {
  let h = 0x811c9dc5;
  const mixInt = (n) => { h = Math.imul(h ^ (n | 0), 0x01000193) >>> 0; };
  for (const v of values) {
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) mixInt(v.charCodeAt(i));
      mixInt(0x7f);
    } else {
      mixInt(Math.round((Number.isFinite(v) ? v : 0) * 1e4));
    }
  }
  return h.toString(16).padStart(8, '0');
}

function showNoWebGL(doc, reason) {
  const el = doc.getElementById('no-webgl');
  if (el) {
    el.style.display = 'flex';
    if (reason) el.textContent = `${el.textContent} (${reason})`;
  }
  doc.getElementById('fade')?.remove();
}

function forEachMaterial(root, fn, skip) {
  root.traverse((o) => {
    if (!o.isMesh || (skip && skip(o))) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) fn(m);
  });
}

export async function bootstrap({ doc = document, win = window, params = parseParams() } = {}) {
  const container = doc.getElementById('app') ?? doc.body;
  const fadeEl = doc.getElementById('fade');
  if (fadeEl) fadeEl.style.transition = 'none';

  if (!hasWebGL(doc)) {
    showNoWebGL(doc);
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch (err) {
    showNoWebGL(doc, err?.message);
    return null;
  }
  configureRenderer(renderer);
  container.appendChild(renderer.domElement);

  const { seed } = params;
  const exposeApi = params.test || params.debug;
  const disposers = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  };

  // ---- world ------------------------------------------------------------------------------
  const audioBus = createAudioBus();
  const assets = createAssetLoader({ renderer });
  const world = createScene({ seed, settings });
  const { scene, handles } = world;
  const lighting = createLighting(scene, settings);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  const rig = createCameraRig(camera, { seed });
  const timeline = buildDefaultTimeline();
  const duration = timeline.duration;
  world.handles.setLodCamera(camera);

  const [leadGroup, pursuerGroup] = await Promise.all([assets.loadVehicle('lead'), assets.loadVehicle('pursuer')]);
  scene.add(leadGroup, pursuerGroup);
  const rigs = { lead: leadGroup.userData.vehicle ?? null, pursuer: pursuerGroup.userData.vehicle ?? null };

  const step = settings.timeline.fixedStep;
  const leadTable = simulateRun(settings.vehicles.lead, handles.spline, {
    step, duration, seed, startSpeed: 8, startDistance: PURSUER_OFFSET,
  });
  const pursuerTable = simulateRun(settings.vehicles.pursuer, handles.spline, {
    step, duration, seed: seed + 1, startSpeed: 8, leader: { table: leadTable, offset: PURSUER_OFFSET, lag: PURSUER_LAG },
  });
  const tables = { lead: leadTable, pursuer: pursuerTable };
  const states = { lead: createVehicleState(), pursuer: createVehicleState() };
  const sampler = (t, out = states) => {
    sampleState(tables.lead, t, out.lead);
    sampleState(tables.pursuer, t, out.pursuer);
    return out;
  };

  const effects = createVehicleEffects({
    vehicles: [
      { id: 'lead', table: leadTable, vehicle: rigs.lead ?? undefined, dimensions: settings.vehicles.lead.dimensions },
      { id: 'pursuer', table: pursuerTable, vehicle: rigs.pursuer ?? undefined, dimensions: settings.vehicles.pursuer.dimensions },
    ],
    seed,
    audioBus,
    handles,
    scene,
  });
  const rainMax = settings.qualityPresets.high.rainParticles;
  const rain = createRain({
    count: Math.min(settings.quality.rainParticles, rainMax), maxCount: rainMax, seed,
  });
  scene.add(rain.object, rain.lensObject);

  const cinematic = createCinematicCamera({ camera, timeline, vehicleStateSampler: sampler, rig, settings });

  // ---- renderer-bound pipeline (rebuilt after context restore) ---------------------------------
  let env = null;
  let pipeline = null;
  function buildGpuPipeline() {
    env = createEnvironment(scene, { settings, materials: handles.materials, roadMesh: handles.road });
    env.init(renderer);
    pipeline = createComposer(renderer, scene, camera, settings.quality);
  }
  buildGpuPipeline();

  const shadowLights = lighting.lights.filter((l) => l.castShadow);

  // ---- sizing --------------------------------------------------------------------------------
  function resize() {
    const w = Math.max(1, container.clientWidth || win.innerWidth);
    const h = Math.max(1, container.clientHeight || win.innerHeight);
    const ratio = Math.min(win.devicePixelRatio || 1, PIXEL_RATIO_CAP, settings.quality.pixelRatioMax ?? PIXEL_RATIO_CAP);
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pipeline.resize(w, h, ratio); // composer + SSAO targets
    env.resize(Math.round(w * ratio), Math.round(h * ratio)); // Reflector target
    rain.setPixelScale(ratio);
  }

  function applyQuality() {
    const q = settings.quality;
    pipeline.setQuality(q);
    env.setReflectionQuality(q.reflectionQuality);
    rain.setCount(Math.min(q.rainParticles, rain.maxCount));
    renderer.shadowMap.enabled = !!q.shadows;
    for (const l of shadowLights) l.castShadow = !!q.shadows;
    resize();
  }

  // ---- debug helpers ---------------------------------------------------------------------------
  const wireframe = { scene: false, vehicles: false, collisionProxies: false };
  const helpers = { collisionProxies: false, tireContacts: false, splinePaths: false };
  const particles = { tireSmoke: true, sparks: true, exhaust: true, rain: true };
  const helperObjects = {};
  let rainDensity = settings.rain.intensity;
  let cameraMode = null;

  function setWireframe(target, on) {
    wireframe[target] = !!on;
    if (target === 'collisionProxies') {
      for (const v of Object.values(rigs)) v?.setDebugWireframe(on);
    } else if (target === 'vehicles') {
      for (const g of [leadGroup, pursuerGroup]) forEachMaterial(g, (m) => { m.wireframe = !!on; }, (o) => o.name === 'collisionProxy');
    } else if (target === 'scene') {
      forEachMaterial(handles.root, (m) => { m.wireframe = !!on; });
    }
  }

  function setHelper(name, on) {
    helpers[name] = !!on;
    if (name === 'collisionProxies') {
      for (const v of Object.values(rigs)) v?.setDebugWireframe(on);
    } else if (name === 'splinePaths') {
      if (!helperObjects.spline) {
        const pts = [];
        for (let i = 0; i <= 300; i++) pts.push(handles.spline.getPointAt(i / 300).clone().setY(0.2));
        helperObjects.spline = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false }),
        );
        helperObjects.spline.renderOrder = 999;
        scene.add(helperObjects.spline);
      }
      helperObjects.spline.visible = !!on;
    } else if (name === 'tireContacts') {
      if (!helperObjects.contacts) {
        helperObjects.contacts = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 8 }, () => new THREE.Vector3())),
          new THREE.PointsMaterial({ color: 0xffff00, size: 10, sizeAttenuation: false, depthTest: false }),
        );
        helperObjects.contacts.frustumCulled = false;
        helperObjects.contacts.renderOrder = 999;
        scene.add(helperObjects.contacts);
      }
      helperObjects.contacts.visible = !!on;
    }
  }

  function updateHelpers(t) {
    const pts = helperObjects.contacts;
    if (!pts || !pts.visible) return;
    const wheels = effects.getWheels(t);
    const attr = pts.geometry.attributes.position;
    wheels.forEach((w, i) => attr.setXYZ(i, w.position.x, w.position.y, w.position.z));
    attr.needsUpdate = true;
  }

  function setParticles(name, on) {
    particles[name] = !!on;
    const objs = name === 'tireSmoke' ? effects.tireSmoke.objects
      : name === 'sparks' ? effects.sparks.objects
        : name === 'exhaust' ? [effects.exhaust.object]
          : [rain.object, rain.lensObject];
    for (const o of objs) o.visible = !!on;
  }

  // ---- orbit controls (debug only; disabled while the cinematic camera drives) ----------------
  let controls = null;
  if (params.debug) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
  }
  const freeCamera = () => cameraMode === FREE_CAMERA;

  function setCameraMode(name) {
    cameraMode = name || null;
    if (freeCamera()) {
      cinematic.setDebugMode(null);
      if (controls) {
        const pose = rig.getPose({});
        controls.target.copy(pose.target);
        controls.enabled = true;
        controls.update();
      }
    } else {
      if (controls) controls.enabled = false;
      cinematic.setDebugMode(cameraMode);
    }
  }

  // ---- per-t world update (pure in t apart from the fixed-step effect pools) -------------------
  const poseOut = {};
  const frameInfo = { shot: null, mode: null };
  const headlights = [
    { position: new THREE.Vector3(), direction: new THREE.Vector3() },
    { position: new THREE.Vector3(), direction: new THREE.Vector3() },
  ];
  let fade = 0;

  function applyAt(t, dt, scrub = false) {
    sampler(t, states);
    for (const id of ['lead', 'pursuer']) {
      const v = rigs[id];
      if (v) {
        v.applyState(states[id]);
        v.setHeadlights(1);
      }
    }
    if (scrub) effects.seek(t);
    else effects.update(t, dt);
    assets.updateMixers(t);
    lighting.update(t, states);

    if (!freeCamera()) {
      const r = cinematic.update(t);
      frameInfo.shot = r.shot;
      frameInfo.mode = r.mode;
    } else {
      frameInfo.shot = timeline.evaluate(t).shot?.name ?? null;
    }
    world.update(t, dt);
    env.update(t, states.lead.position);
    handles.setLodCamera(camera);

    ['lead', 'pursuer'].forEach((id, i) => {
      const s = states[id];
      headlights[i].position.copy(s.position).setY(0.7);
      headlights[i].direction.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    });
    rain.setHeadlights(headlights);
    rain.update(t, camera.position);
    rain.setLensStrength((LENS_STRENGTH[frameInfo.mode] ?? 0.15) * (particles.rain ? rainDensity : 0));

    rig.getPose(poseOut);
    pipeline.setDofFocus(poseOut.focusDistance);
    pipeline.setMotionBlur(poseOut.motionBlur);
    updateHelpers(t);

    const fadeOut = smoothstep(settings.timeline.fadeStart, duration, t);
    fade = Math.max(fadeOut, poseOut.dip ?? 0);
    if (fadeEl) fadeEl.style.opacity = String(fade);
  }

  // ---- render / loop ---------------------------------------------------------------------------
  function renderFrame() {
    if (controls?.enabled) controls.update();
    resetInfo(renderer);
    pipeline.render();
  }

  function seekTo(t) {
    timeline.seek(t);
    applyAt(timeline.t, 0, true);
  }

  // Restart the sequence: seek 0, clear pools, reseed PRNG-driven state. No new GPU resources.
  function reset() {
    timeline.reset();
    if (params.paused) timeline.pause();
    effects.reset();
    seekTo(0);
  }

  let paused = !!params.paused;
  function setPaused(p) {
    paused = !!p;
    if (paused) timeline.pause(); else timeline.resume();
  }

  let accumulator = 0;
  let lastWall = null;
  let rafId = 0;
  let contextLost = false;
  let disposed = false;
  let degradeSum = 0;
  let degradeCount = 0;
  const fpsStats = { fps: 0, frameMs: 0 };

  function degradeIfSlow(wallMs) {
    if (!params.autoDegrade) return;
    degradeSum += wallMs;
    if (++degradeCount < DEGRADE_WINDOW) return;
    const avg = degradeSum / degradeCount;
    degradeSum = 0;
    degradeCount = 0;
    if (avg <= DEGRADE_THRESHOLD_MS) return;
    const idx = QUALITY_ORDER.findIndex((n) => Object.keys(settings.qualityPresets[n]).every((k) => settings.quality[k] === settings.qualityPresets[n][k]));
    const next = QUALITY_ORDER[Math.min(QUALITY_ORDER.length - 1, (idx < 0 ? 0 : idx) + 1)];
    if (next && next !== QUALITY_ORDER[idx]) {
      applyQualityPreset(next);
      applyQuality();
    }
  }

  function frame(nowMs) {
    if (disposed || contextLost) return;
    rafId = win.requestAnimationFrame(frame);
    const wall = nowMs / 1000;
    const wallDt = lastWall === null ? 0 : Math.min(Math.max(wall - lastWall, 0), MAX_FRAME_DT);
    lastWall = wall;
    // Wall-clock only feeds the accumulator and the FPS stats; the sim advances in fixed steps.
    accumulator += wallDt;
    fpsStats.frameMs += (wallDt * 1000 - fpsStats.frameMs) * 0.1;
    fpsStats.fps = fpsStats.frameMs > 0 ? 1000 / fpsStats.frameMs : 0;
    if (wallDt > 0) degradeIfSlow(wallDt * 1000);

    let advanced = 0;
    while (accumulator >= step) {
      accumulator -= step;
      if (!timeline.paused) {
        timeline.update(step);
        advanced += step * timeline.playbackSpeed;
      }
    }
    if (!timeline.paused && timeline.t >= duration - 1e-9) {
      reset();
    } else {
      applyAt(timeline.t, advanced);
    }
    renderFrame();
    debugPanel?.update(wallDt);
  }

  function startLoop() {
    lastWall = null;
    accumulator = 0;
    rafId = win.requestAnimationFrame(frame);
  }

  // ---- context loss ----------------------------------------------------------------------------
  listen(renderer.domElement, 'webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true; // pauses the clock: frame() stops rescheduling
    win.cancelAnimationFrame(rafId);
  });
  listen(renderer.domElement, 'webglcontextrestored', () => {
    if (disposed) return;
    pipeline.dispose();
    env.dispose();
    buildGpuPipeline();
    applyQuality();
    contextLost = false;
    seekTo(timeline.t);
    startLoop();
  });
  listen(win, 'resize', resize);

  // ---- debug panel ----------------------------------------------------------------------------
  const getState = () => {
    const speedState = states.lead;
    return {
      time: timeline.t,
      paused: timeline.paused,
      playbackSpeed: timeline.playbackSpeed,
      shot: frameInfo.shot,
      speed: speedState.speed,
      lateralAccel: speedState.lateralAccel,
      cameraMode: cameraMode ?? '',
      exposure: renderer.toneMappingExposure,
      rainDensity,
      wireframe: { ...wireframe },
      helpers: { ...helpers },
      particles: { ...particles },
      quality: { ...settings.quality },
      fps: fpsStats.fps,
    };
  };

  let debugPanel = null;
  if (params.debug) {
    debugPanel = createDebugPanel({
      renderer,
      duration,
      cameraModes: [...CAMERA_MODES, FREE_CAMERA],
      quality: settings.quality,
      qualityPresets: settings.qualityPresets,
      particleSystems: PARTICLE_SYSTEMS,
      getState,
      setPaused,
      seek: seekTo,
      reset,
      setPlaybackSpeed: (x) => { timeline.playbackSpeed = x; },
      setCameraMode,
      setWireframe,
      setHelper,
      setParticles,
      setRainDensity: (x) => {
        rainDensity = x;
        rain.setCount(Math.min(Math.round(settings.quality.rainParticles * x), rain.maxCount));
      },
      setExposure: (x) => { renderer.toneMappingExposure = x; },
      setQuality: (key, value) => { settings.quality[key] = value; applyQuality(); },
      applyPreset: (name) => { applyQualityPreset(name); applyQuality(); },
    });
  }

  // ---- test API --------------------------------------------------------------------------------
  const snapshot = () => {
    const vehicles = {};
    const flat = [timeline.t];
    for (const id of ['lead', 'pursuer']) {
      const s = states[id];
      const q = [s.position.x, s.position.y, s.position.z, s.yaw, s.roll, s.pitch, s.steer];
      vehicles[id] = { position: [q[0], q[1], q[2]], yaw: q[3], roll: q[4], pitch: q[5], steer: q[6], speed: s.speed };
      flat.push(...q);
    }
    const pose = rig.getPose({});
    const cam = {
      position: pose.position.toArray(), target: pose.target.toArray(), fov: pose.fov, focusDistance: pose.focusDistance,
    };
    flat.push(...cam.position, ...cam.target, cam.fov);
    const lights = lighting.getLightIntensities();
    flat.push(...lights);
    const fx = effects.getStateHash();
    flat.push(frameInfo.shot ?? '', fx);
    return {
      t: timeline.t, seed, shot: frameInfo.shot, cameraMode: frameInfo.mode, vehicles, camera: cam, lights, effects: fx, hash: hashValues(flat),
    };
  };

  const chase = {
    seek(t) { seekTo(t); renderFrame(); return snapshot(); },
    step(dt = 1 / 60) {
      timeline.seek(timeline.t + dt);
      applyAt(timeline.t, dt);
      renderFrame();
      return snapshot();
    },
    getState: snapshot,
  };
  if (exposeApi) win.__chase = chase;

  // ---- dispose-all -----------------------------------------------------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;
    win.cancelAnimationFrame(rafId);
    for (const d of disposers) d();
    disposers.length = 0;
    debugPanel?.dispose();
    controls?.dispose();
    for (const o of Object.values(helperObjects)) {
      o.removeFromParent();
      o.geometry.dispose();
      o.material.dispose();
    }
    effects.dispose();
    rain.object.removeFromParent();
    rain.lensObject.removeFromParent();
    rain.dispose();
    pipeline.dispose();
    env.dispose();
    lighting.dispose();
    assets.dispose();
    world.dispose();
    audioBus.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    if (win.__chase === chase) delete win.__chase;
  }

  // ---- go --------------------------------------------------------------------------------------
  applyQuality();
  if (params.paused) timeline.pause();
  seekTo(params.t ?? 0);
  if (!paused) setPaused(false);
  renderFrame();
  startLoop();

  return { renderer, scene, camera, timeline, chase, reset, dispose, getState };
}

if (typeof document !== 'undefined' && !import.meta.env?.VITEST) {
  bootstrap().catch((err) => {
    console.error('[main] bootstrap failed', err);
    const el = document.getElementById('no-webgl');
    if (el) {
      el.style.display = 'flex';
      el.textContent = `The demo failed to start: ${err?.message ?? err}`;
    }
  });
}
