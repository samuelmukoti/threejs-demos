// Debug overlay: lightweight DOM, no dependencies. Only construct in debug mode.
//
// createDebugPanel(api) -> { element, update(dt), dispose() }
//
// `api` is a plain object of optional hooks; any missing hook hides/no-ops its control.
//   renderer                      THREE.WebGLRenderer (draw calls via renderer.info)
//   parent                        element to mount into (default document.body)
//   quality, qualityPresets       settings.quality object and preset map
//   duration, cameraModes         timeline length (s) and selectable camera modes
//   getState()                    -> { time, paused, playbackSpeed, shot, speed, lateralAccel,
//                                      cameraMode, exposure, rainDensity, wireframe{}, helpers{},
//                                      particles{}, quality{} } (all optional)
//   setPaused(bool) seek(t) reset() setPlaybackSpeed(x) setCameraMode(name|null)
//   setWireframe(target, on)      target: 'scene' | 'vehicles' | 'collisionProxies'
//   setHelper(name, on)           name: 'collisionProxies' | 'tireContacts' | 'splinePaths'
//   setParticles(name, on)        name from api.particleSystems
//   setRainDensity(x) setExposure(x)
//   setQuality(key, value) applyPreset(name)

const WIREFRAMES = [
  ['scene', 'Scene'],
  ['vehicles', 'Vehicles'],
  ['collisionProxies', 'Collision proxies'],
];
const HELPERS = [
  ['collisionProxies', 'Collision proxies'],
  ['tireContacts', 'Tire contacts'],
  ['splinePaths', 'Spline paths'],
];
const QUALITY_TOGGLES = [
  ['ssao', 'SSAO'],
  ['bloom', 'Bloom'],
  ['dof', 'DOF'],
  ['motionBlur', 'Motion blur'],
  ['reflectionQuality', 'Reflections'],
  ['shadows', 'Shadows'],
];
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];
const FPS_WINDOW = 0.5;

export function createDebugPanel(api = {}) {
  const doc = globalThis.document;
  if (!doc) throw new Error('createDebugPanel requires a DOM');

  const cleanups = [];
  const readouts = {};
  const syncers = [];
  let disposed = false;

  const info = api.renderer?.info;
  const prevAutoReset = info ? info.autoReset : true;
  if (info) info.autoReset = false; // accumulate across composer passes; reset per frame in update()

  const root = doc.createElement('div');
  root.className = 'debug-panel';
  root.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'width:260px', 'max-height:calc(100vh - 16px)',
    'overflow:auto', 'padding:8px', 'background:rgba(8,10,16,0.85)', 'color:#cfe',
    'font:11px/1.4 monospace', 'z-index:1000', 'border-radius:4px', 'user-select:none',
  ].join(';');

  function listen(el, type, fn) {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  }

  function guard(fn) {
    return (...args) => {
      try {
        return fn?.(...args);
      } catch (err) {
        console.error('[debugPanel]', err);
        return undefined;
      }
    };
  }

  function section(title) {
    const h = doc.createElement('div');
    h.textContent = title;
    h.style.cssText = 'margin:8px 0 2px;color:#7fd;font-weight:bold;border-bottom:1px solid #345';
    root.appendChild(h);
  }

  function row(label, control) {
    const r = doc.createElement('label');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
    const t = doc.createElement('span');
    t.textContent = label;
    t.style.cssText = 'flex:1';
    r.append(t, control);
    root.appendChild(r);
    return r;
  }

  function button(label, fn) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:inherit;margin-right:4px;cursor:pointer';
    listen(b, 'click', guard(fn));
    return b;
  }

  function checkbox(label, get, set) {
    const c = doc.createElement('input');
    c.type = 'checkbox';
    c.checked = !!get();
    listen(c, 'change', guard(() => set(c.checked)));
    row(label, c);
    syncers.push(() => {
      if (doc.activeElement !== c) c.checked = !!get();
    });
    return c;
  }

  function slider(label, { min, max, step }, get, set) {
    const s = doc.createElement('input');
    s.type = 'range';
    s.min = String(min);
    s.max = String(max);
    s.step = String(step);
    s.style.cssText = 'width:120px';
    const v = Number(get());
    s.value = String(Number.isFinite(v) ? v : min);
    listen(s, 'input', guard(() => set(Number(s.value))));
    row(label, s);
    syncers.push(() => {
      const cur = Number(get());
      if (Number.isFinite(cur) && doc.activeElement !== s) s.value = String(cur);
    });
    return s;
  }

  function select(label, options, get, set) {
    const s = doc.createElement('select');
    for (const [value, text] of options) {
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = text;
      s.appendChild(o);
    }
    s.value = String(get());
    listen(s, 'change', guard(() => set(s.value)));
    row(label, s);
    syncers.push(() => {
      if (doc.activeElement !== s) s.value = String(get());
    });
    return s;
  }

  const state = () => {
    try {
      return api.getState?.() ?? {};
    } catch (err) {
      console.error('[debugPanel]', err);
      return {};
    }
  };

  // --- Read-outs ---
  section('Read-outs');
  for (const [key, label] of [
    ['fps', 'FPS'], ['calls', 'Draw calls'], ['speed', 'Speed (m/s)'],
    ['lat', 'Lateral accel (m/s²)'], ['shot', 'Shot'],
  ]) {
    const val = doc.createElement('span');
    val.textContent = '-';
    readouts[key] = val;
    row(label, val);
  }

  // --- Timeline ---
  section('Timeline');
  const controls = doc.createElement('div');
  const pauseBtn = button('Pause', () => {
    const paused = !state().paused;
    api.setPaused?.(paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  controls.append(pauseBtn, button('Reset', () => api.reset?.()));
  root.appendChild(controls);
  if (api.seek) {
    const dur = api.duration ?? 44;
    slider('Scrub', { min: 0, max: dur, step: 0.01 }, () => state().time ?? 0, (t) => api.seek(t));
  }
  select(
    'Speed',
    SPEEDS.map((s) => [String(s), `${s}x`]),
    () => String(state().playbackSpeed ?? 1),
    (v) => api.setPlaybackSpeed?.(Number(v)),
  );

  // --- Camera ---
  if (api.cameraModes?.length) {
    section('Camera');
    select(
      'Mode',
      [['', 'auto (shot)'], ...api.cameraModes.map((m) => [m, m])],
      () => state().cameraMode ?? '',
      (v) => api.setCameraMode?.(v || null),
    );
  }

  // --- Toggles ---
  const toggleGroup = (title, entries, key, setter) => {
    if (!setter) return;
    section(title);
    for (const [name, label] of entries) {
      checkbox(label, () => state()[key]?.[name], (on) => setter(name, on));
    }
  };
  toggleGroup('Wireframe', WIREFRAMES, 'wireframe', api.setWireframe);
  toggleGroup('Physics helpers', HELPERS, 'helpers', api.setHelper);
  toggleGroup(
    'Particles',
    (api.particleSystems ?? []).map((n) => [n, n]),
    'particles',
    api.setParticles,
  );

  // --- Environment ---
  section('Environment');
  if (api.setRainDensity) {
    slider('Rain', { min: 0, max: 2, step: 0.05 }, () => state().rainDensity ?? 1, api.setRainDensity);
  }
  if (api.setExposure) {
    slider('Exposure', { min: 0.2, max: 3, step: 0.05 }, () => state().exposure ?? 1, api.setExposure);
  }

  // --- Quality ---
  if (api.setQuality || api.applyPreset) {
    section('Quality');
    const quality = () => state().quality ?? api.quality ?? {};
    if (api.applyPreset && api.qualityPresets) {
      const presetBtns = doc.createElement('div');
      for (const name of Object.keys(api.qualityPresets)) {
        presetBtns.appendChild(button(name, () => api.applyPreset(name)));
      }
      root.appendChild(presetBtns);
    }
    if (api.setQuality) {
      for (const [key, label] of QUALITY_TOGGLES) {
        checkbox(label, () => quality()[key], (on) => api.setQuality(key, key === 'reflectionQuality' ? (on ? 1 : 0.25) : on));
      }
    }
  }

  // --- FPS / per-frame update ---
  let acc = 0;
  let frames = 0;
  let calls = 0;
  let uiTimer = 0;

  function update(dt) {
    if (disposed) return;
    if (info) {
      calls = info.render.calls; // accumulated over every pass this frame
      info.reset();
    }
    acc += dt;
    frames += 1;
    uiTimer += dt;
    if (acc >= FPS_WINDOW) {
      readouts.fps.textContent = (frames / acc).toFixed(0);
      acc = 0;
      frames = 0;
    }
    if (uiTimer < 0.1) return; // throttle DOM writes
    uiTimer = 0;
    const s = state();
    readouts.calls.textContent = String(calls);
    readouts.speed.textContent = Number.isFinite(s.speed) ? s.speed.toFixed(1) : '-';
    readouts.lat.textContent = Number.isFinite(s.lateralAccel) ? s.lateralAccel.toFixed(2) : '-';
    readouts.shot.textContent = s.shot ?? '-';
    pauseBtn.textContent = s.paused ? 'Resume' : 'Pause';
    for (const sync of syncers) sync();
  }

  (api.parent ?? doc.body).appendChild(root);

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    syncers.length = 0;
    root.remove();
    if (info) info.autoReset = prevAutoReset;
  }

  return { element: root, update, dispose };
}
