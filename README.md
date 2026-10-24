# three-demos: Night Rain Chase

An original, real-time, cinematic Three.js demo: a 44-second night-time, rain-soaked downtown car chase between two fictional sports cars. Everything is procedural (no copyrighted assets, no audio files). A single deterministic clock drives vehicles, cameras, effects and lighting, so any frame can be reproduced exactly.

## Setup

Requires Node >= 20.19 (Vite 7).

```bash
npm install     # also runs `npm run setup` via postinstall
npm run dev     # http://localhost:5173
```

## Commands

| Command           | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `npm run dev`     | Vite dev server on port 5173                                                                      |
| `npm run build`   | Production build into `dist/`                                                                     |
| `npm run preview` | Serve the production build                                                                        |
| `npm test`        | Vitest unit tests (`vitest run`); no WebGL needed, runs in Node                                   |
| `npm run setup`   | Copy Draco and Basis decoders from `node_modules/three` into `public/draco/` and `public/basis/` |

`scripts/copy-decoders.js` is idempotent and never fails the install if the source is missing. The copied folders are git-ignored.

## Pinned three version

`three` is pinned to the exact version `0.186.0` (no caret). Examples under `three/addons/` (SSAOPass, BokehPass, Reflector, GLTFLoader, DRACOLoader, KTX2Loader) change between releases, and the Draco/Basis decoder files must match the loader code that is copied alongside them. Pinning keeps those in step and keeps renders reproducible. Upgrade deliberately: bump the version, run `npm run setup`, then `npm test` and check the debug-mode visuals.

## Architecture overview

`index.html` loads `src/main.js`, which builds the renderer, scene, vehicles, timeline, camera and composer, then runs a fixed-step loop. Wall-clock time only feeds the step accumulator and FPS stats. Every system exposes `update(t, dt)` and derives its state from `t`, never from `Date.now()` or `Math.random()` (a seeded mulberry32 PRNG is used instead).

- **Vehicles** precompute the whole run at a fixed step (1/120 s) into a state table. At runtime the state is interpolated by `t`, so seeking is O(1) and exact.
- **Event-driven effects** (smoke, spray, sparks, exhaust) are derived from that table plus a fixed event list. On seek, pools are cleared and re-simulated from `t - maxLifetime` (lifetimes <= ~3 s).
- **Rain** is a pure function of `(seed, index, t)`, so it needs no replay.
- **Lighting** is a function of `t` and settings. The light count is constant (changing it recompiles shaders), so only intensities change.

### Module map

| Path                              | Role                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `src/main.js`                     | Bootstrap, URL params, fixed-step loop, test API, WebGL/context-loss handling, dispose  |
| `src/settings.js`                 | Central settings: lighting, fog, rain, vehicles, timeline, route, quality presets       |
| `src/scene/createScene.js`        | Road, buildings, props, instancing, LOD; no renderer dependency (runs under Node)       |
| `src/scene/setPieces.js`          | Traffic, tunnel, intersection, blocking truck, side street                              |
| `src/scene/lighting.js`           | Moon, streetlights, neon, headlight/brake spots, tunnel lights, volumetric cones        |
| `src/scene/environment.js`        | Fog, PMREM environment, CubeCamera probe, Reflector road overlay (`init(renderer)`)     |
| `src/scene/materials.js`, `proceduralTextures.js` | Wet/dry materials and generated textures                                |
| `src/vehicles/Vehicle.js`         | Procedural car rig (lead and pursuer)                                                   |
| `src/vehicles/vehiclePhysics.js`  | Spline-following dynamics, precomputed state table                                      |
| `src/vehicles/vehicleEffects.js`  | Hooks vehicle state to smoke, spray, exhaust and spark emitters                         |
| `src/camera/cinematicCamera.js`   | 10 camera modes and cuts                                                                |
| `src/camera/cameraRig.js`         | Spline, look-at, shake, focal length, DOF and motion-blur plumbing                      |
| `src/animation/chaseTimeline.js`  | Chainable shot timeline: `addShot`, `seek`, `update`, pure `evaluate(t)`                |
| `src/animation/splineMotion.js`   | Arc-length spline helpers                                                               |
| `src/effects/*`                   | Pooled particles, tire smoke, rain, sparks                                              |
| `src/postprocessing/composer.js`  | EffectComposer chain and quality toggles                                                |
| `src/assets/assetLoader.js`       | Only module that knows asset files; GLTF/Draco/KTX2 with procedural fallback            |
| `src/audio/audioBus.js`           | `emit(name, payload)`; logs to console while no audio files exist                       |
| `src/ui/debugPanel.js`            | Lightweight DOM debug panel                                                             |
| `src/utils/prng.js`, `stateHash.js` | Seeded PRNG and stable state hashing                                                  |

Post chain: `RenderPass` -> SSAO -> optional DOF (`BokehPass`) -> `UnrealBloomPass` -> optional motion blur -> optional SMAA -> `OutputPass` (last; does tone mapping and sRGB). The renderer uses ACES Filmic tone mapping at exposure 1.1 and PCFSoft shadows.

## Deterministic clock and test mode

Query parameters:

| Param         | Effect                                                         |
| ------------- | -------------------------------------------------------------- |
| `?t=<sec>`    | Start at that time                                             |
| `?paused`     | Freeze playback (combine with `t` for reproducible screenshots)|
| `?seed=<int>` | Seed for every PRNG                                            |
| `?debug`      | Enable OrbitControls and the debug panel                       |
| `?autodegrade`| Enable automatic quality degrade (off by default)              |

Example: `http://localhost:5173/?t=25&paused&seed=1`

`window.__chase` is exposed only in test mode or debug mode. It provides `seek(t)`, `step(dt)` and `getState()`, which returns vehicle transforms, camera pose, current shot, light intensities and a stable hash of that state. Seeking back to the same `t` with the same seed gives the same hash.

## Quality presets and performance controls

`settings.quality` has `low`, `medium` and `high` presets (default `high`), applied with `applyQualityPreset(name)` or from the debug panel. Presets change rendering load and particle counts only, never simulation state.

| Setting             | low   | medium | high  |
| ------------------- | ----- | ------ | ----- |
| shadows             | off   | on     | on    |
| bloom               | off   | on     | on    |
| SSAO                | off   | off    | on    |
| rain particles      | 3000  | 8000   | 18000 |
| reflection quality  | 0.25  | 0.5    | 1     |
| motion blur / DOF   | off   | off    | on    |
| distant traffic     | 4     | 10     | 20    |
| max pixel ratio     | 1     | 1.5    | 2     |

### Draw-call budget and measurement

Target: about 300 draw calls per frame in total at the high preset. SSAOPass, BokehPass and Reflector each re-render the scene, so their passes count toward that total. The renderer sets `renderer.info.autoReset = false` and resets once per frame, so `renderer.info.render.calls` reports the full-frame total rather than only the last composer pass.

Performance targets: 60 fps at 1080p on a modern desktop with the high preset, and about 30 fps on mid-range hardware with the low preset. These are targets; this repository's tests run without a GPU, so they have not been verified in CI.

To measure:

1. `npm run build && npm run preview`, open `/?debug` in a desktop browser at 1920x1080, with hardware acceleration on and the tab focused.
2. Pick a preset in the debug panel and let the 44 s sequence play. Read FPS and draw calls from the panel. Check the heavy shots (`tunnel`, `drift`, `intersection`) by scrubbing to them.
3. For repeatable comparisons use `/?t=25&paused&seed=1` and compare draw calls and frame time between presets.
4. Add `?autodegrade` to let the app lower pixel ratio, SSAO and reflections when the average frame time stays above ~25 ms.

## Design decisions

- **SSAO vs GTAO**: SSAOPass is used, defaulting to off or half resolution on lower presets. It is cheap to scale down, and it is enough for a dark, fog-heavy night scene where fine contact shadowing is mostly hidden. GTAO looks better but costs more per pixel.
- **MSAA vs SMAA**: the composer uses a HalfFloat render target with `samples: 4` (MSAA) when the GPU supports it, since the scene is full of thin edges (wires, markings, window grids) that post-process AA blurs. If `maxSamples` is 0, an `SMAAPass` is used as the fallback. The renderer's own `antialias` does not apply to composer targets.
- **Reflector overlay vs patched material**: wet-road reflections use a low-resolution `Reflector` limited to the road region, blended by a custom shader driven by wetness and the roughness map. Patching the road's `MeshStandardMaterial` with `onBeforeCompile` would give physically integrated reflections but is fragile across three versions. The overlay keeps the standard material untouched, makes resolution and strength easy to scale per preset, and avoids a flat mirror. A PMREM environment and a rarely-updated CubeCamera probe supply the rest.

## Swapping in real GLTF / Draco / KTX2 assets

Only `src/assets/assetLoader.js` knows about files. `loadVehicle(id)` and `loadProp(id)` try `<BASE_URL>models/<id>.glb` first and fall back to the procedural builder on any failure (missing file, missing decoders, parse error). They never throw and always return a `THREE.Group`.

1. Run `npm run setup` so `public/draco/` and `public/basis/` exist. The loader uses `<BASE_URL>draco/gltf/` for Draco and `<BASE_URL>basis/` for KTX2 (`detectSupport(renderer)` is called for you).
2. Drop files into `public/models/`:
   - vehicles: `lead.glb` and `pursuer.glb`
   - props: `<propId>.glb`, where the id matches a key in `PROP_BUILDERS` (currently `cone`, `barrier`, `lamp`); add a new id there and in the scene code that calls `loadProp`.
3. Keep the model's scale in metres, forward along -z, and origin at ground level between the wheels. Check against `settings.vehicles.*.dimensions`. The physics, wheel pivots and effect emitters are driven by the procedural rig, so a loaded vehicle may need its wheel nodes wired up to match.
4. Textures go in `public/textures/`; KTX2-compressed textures inside a GLB work through the configured loader.
5. Animated clips play through an `AnimationMixer` that `updateMixers(t)` drives from the fixed clock, so animated assets stay deterministic.
6. Use `import.meta.env.BASE_URL` for any new path, not a hard-coded `/`.

Compare results with `/?debug` and check the console for `[assets] ... using procedural fallback` messages to see which files were not picked up.

## Out of scope

Real audio files (only the `audioBus` hook layer), mobile/touch, WebGPU, full rigid-body physics, and any backend.
