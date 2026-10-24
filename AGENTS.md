# three-demos 

> 

This file is the agent's first-touch context for the project. Keep it short, current, and honest.

## Toolchain

Vanilla JavaScript (ES modules), `three` pinned to 0.186.0, Vite 7 (dev/build), Vitest (tests). Node >= 20.19.

## Conventions

- Run tests before claiming any change is complete.
- Prefer the smallest change that makes the test pass.
- Match the existing code style; don't introduce unrelated formatting churn.
- When in doubt, ask the user a single clarifying question rather than guessing.

## Commands

- `npm install` (postinstall copies Draco/Basis decoders)
- `npm run dev` - Vite dev server, http://localhost:5173 (`/?debug`, `/?t=25&paused&seed=1`)
- `npm run build` / `npm run preview`
- `npm test` - Vitest, Node environment, no WebGL
- `npm run setup` - re-copy decoders into `public/draco`, `public/basis`

## Project structure

- `src/main.js` bootstrap and fixed-step loop; `src/settings.js` central config and quality presets
- `src/scene/` scene, lighting, environment (renderer-only parts behind `init(renderer)`), materials, set pieces
- `src/vehicles/`, `src/camera/`, `src/animation/`, `src/effects/`, `src/postprocessing/`, `src/audio/`, `src/ui/`, `src/utils/`
- `src/assets/assetLoader.js` is the only module that knows asset files (GLTF/Draco/KTX2, procedural fallback)
- `public/{models,textures,audio}` asset folders; `public/draco`, `public/basis` are generated and git-ignored
- `tests/` Vitest unit tests; `scripts/copy-decoders.js`
- See README.md for the module map and architecture.

Rules to keep: no `Math.random()`/`Date.now()` in simulation, camera or effect logic (use `utils/prng.js` and `t`); no per-frame allocation in effects; constant light count; every system has `dispose()`; keep `createScene()` free of renderer dependencies.

## Open questions

- Draw-call budget (~300) and the 60 fps / 30 fps targets are documented but not yet measured on real hardware.
- Real GLTF vehicle/prop assets are not provided; wheel-node wiring for loaded vehicles is undecided.
- Whether to ship audio files (only the `audioBus` hook layer exists).
