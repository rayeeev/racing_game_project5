# Alpenglow - common engineering brief for system authors

You are one of several engineers working IN PARALLEL on "Alpenglow", a realistic 3D mountain-pass time-attack driving game
that runs in the browser. Each engineer owns one SYSTEM (a few files). Read this brief completely, then your system brief.

## The game
The player drives a ~570 hp mid-engine V8 sports car (open-top, visible interior) on a ~5 km closed mountain road that loops
around an alpine lake: lakeside straight, climbing hairpins, a ridge with fast esses, a forested descent. Rolling start, then
continuous flying laps against the clock, medal ghosts (bronze / silver / gold AI laps) and the player's own best-lap ghost.
Four sky presets: golden hour (the signature look), noon, overcast (wet road), dusk (headlights).
Goal #1 is PHOTOREALISM: every frame should be mistakable for a photograph / a modern AAA racing game - one coherent real
place, photoscanned materials, physically plausible light. Goal #2 is 60 fps at about 2400x1350 rendered pixels on an Apple
M4 Pro (the "high" tier). Programmer art, placeholder colours, visible tiling, popping, z-fighting, shimmering and plastic
shading are defects to be fixed, not shipped.

## Stack
- Plain JavaScript ES modules (NO TypeScript). Tabs, semicolons, JSDoc on everything exported. Vite 8 dev server.
- Three.js r187 (three@0.187.0) with **WebGPURenderer + TSL node materials**: `import * as THREE from 'three/webgpu'`,
  `import { ... } from 'three/tsl'`, addons from `'three/addons/...'`. There is no onBeforeCompile and no ShaderMaterial
  path here: custom shading is written as TSL nodes on Node materials (MeshStandardNodeMaterial etc.).
- The renderer is created by the Game with `reversedDepthBuffer: true`, no MSAA, shadow maps enabled, camera near 0.1 / far 40000.
- Rapier physics lives in the simulation layer (src/sim) - systems read telemetry, they never touch physics directly except
  through `ctx.addObstacles(list)`.

## Your API knowledge of three.js is probably stale - verify, do not guess
- Verified r187 quick reference (read it first): `$SCRATCH/notes/three-r187-crib.md`
- Official r187 example pages: `$SCRATCH/three-ref/examples/webgpu_*.html`
- TSL docs: `.../scratchpad/three-ref/docs/pages/TSL.html.md`
- Ground truth = the installed source: `node_modules/three/src`, `node_modules/three/examples/jsm`, `node_modules/three/build/three.webgpu.js`.
- A console warning that says something was renamed / deprecated means your code is wrong: use the new name.
- WebGPU limits that bite: at most 16 sampled textures per shader stage (use array textures / packing for many-layer
  materials); sampling with implicit derivatives is not allowed inside non-uniform control flow (use .grad() / .level() there
  or restructure with mix()).

## Contracts you must read before writing code (do NOT modify these files)
| file | what it defines |
|---|---|
| `src/game/context.js` | System factory contract, `GameContext` (ctx), `Frame`, `CarPose`, `GhostPose`, `HudState`, `GameApi`, the event list |
| `src/sim/constants.js` | axis / sign conventions, wheel order, `Surface` ids + `SURFACES` table |
| `src/sim/types.js` | `VehicleState`, `WheelState`, `ImpactEvent`, `TrackFrame`, `TrackProjection` |
| `src/gfx/shared.js` | shared TSL uniforms (`uTime`, `uSunDirection`, `uSunColor`, `uWetness`, `uNight`, wind, fog, car position) |
| `src/gfx/worldTextures.js` | `ctx.worldTex`: GPU textures + TSL lookups of baked world maps (height, biome splats, fields, vegetation mask, ground tint) |
| `src/core/assets.js` | `ctx.assets`: cached loaders (gltf, texture, hdr, pbr set, audio, json) + the asset indexes (`ctx.assets.index.*`) |
| `src/core/settings.js`, `src/core/input.js`, `src/core/storage.js`, `src/core/events.js`, `src/core/math.js`, `src/core/rng.js` | settings, input actions, records, emitter, helpers |
| `src/game/game.js` | boot sequence, creation / update order, fixed-step loop (read it to understand when your code runs) |
| `src/sim/track.js`, `src/sim/world.js`, `src/sim/roadGeometry.js`, `src/sim/layout.js` | the circuit and the baked world (`ctx.track`, `ctx.world`) |
If a contract is missing something you need, do not edit it: list the exact change you need under `contractRequests` in your
report and work around it locally for now. Shell files you must not edit: everything in `src/core`, `src/game`, `src/sim`,
`src/gfx/shared.js`, `src/gfx/worldTextures.js`, `src/main.js`, `index.html`, `dev/harness.js`, `dev/sys.html`, `tools/shot.mjs`,
`package.json`, `vite.config.js`, `eslint.config.js`.

## How a system is built
- One module exporting ONE async factory `createXxx( ctx )` that returns the system object (see the table in context.js for
  file names / factory names / keys). Load through `ctx.assets` (so the loading bar is right), add objects to `ctx.scene`.
- `update( frame )` runs once per rendered frame (also while paused, with `frame.dt === 0`). No allocations in update():
  reuse vectors / arrays; no `new` in per-frame paths.
- Optional `resize( width, height, pixelRatio )`, `dispose()`.
- Other systems may be absent (`ctx.systems.foo === undefined`) - guard every cross-system access.
- Quality: `ctx.quality.tier` is 'low' | 'medium' | 'high' | 'ultra'. Keep ONE table at the top of your module that maps the
  tier to your own detail parameters. 'high' is the default and the tier that must look great at 60 fps; 'ultra' may cost
  more; 'low' must still look decent.
- Everything world-related is deterministic: use `src/core/rng.js` (seeded), never `Math.random()` for placement.
- Scene scale is meters; the playable square is 3072 m; visible terrain extends ~12 km. Mind precision and depth: avoid
  coplanar geometry (decals must be in-shader or offset and distance-faded).
- Shadows: the environment system provides a cascaded directional shadow (sun). Set `castShadow` / `receiveShadow` sensibly;
  alpha-tested materials must cast alpha-tested shadows; avoid huge shadow-caster triangle counts (cast from lower LODs).
- Materials must respond to ALL four sky presets automatically (use scene lighting + the shared uniforms; never bake a
  light direction or colour into a material).
- Clean code: meaningful names, JSDoc, no dead code, no TODOs, no console spam (one concise `console.info` at init is fine).

## Frame budget on the "high" tier (whole game, 16.6 ms): keep your slice
shadows + environment 2.5 ms | terrain 2.0 | road 0.5 | scatter (trees/rocks/shrubs) 3.0 | grass 1.5 | water 0.7 | props 0.4 |
car 0.8 | effects 0.5 | post-processing 3.5 | everything else 1.2.
Whole-scene targets on high: <= ~3.5 M triangles in the main pass, <= ~400 draw calls, <= ~1.6 GB of textures.

## Developing and verifying your system (mandatory)
A Vite dev server is ALREADY running at http://127.0.0.1:5173 (project root, no HMR - each page load is fresh). Do not
start, stop or reconfigure it. Never run `npm install`.
- **Harness**: `/dev/sys.html?systems=<comma list>&...` boots the REAL game shell with only the listed systems. All
  parameters are documented at the top of `dev/harness.js` (systems, sim, phase, autopilot, sky, quality, camera `cam=`/`look=`
  or track-relative `s=`/`d=`/`h=`/`ls=`/`ld=`/`lh=`, `tp=`, `wait=`, `set.<key>=`). You may also write your own pages
  `dev/<yourprefix>-*.html` that call `bootHarness()` and then script the scene.
- **Screenshots**: `node tools/shot.mjs --url "<url>" --out <abs.png> --wait-for "window.__ready === true" --delay 500`
  (+ `--eval "<js>"`, `--script scenario.mjs --out-dir <dir>`, `--width/--height`; see its header). It drives real headless
  Chrome with WebGPU; the LAST stdout line is JSON with `errors` and `warnings` from the page console - both must be empty
  for your system. Always quote URLs.
- **Debug API** in the page: `window.__game` (see `src/game/debugApi.js`): `stats()` (fps, frameMs, drawCalls, triangles),
  `freeCamera(pos, target, fov)`, `trackCamera(s, d, h, lookS, lookD, lookH)`, `teleport(s, d, kmh)`, `setSky(id)`,
  `setAutopilot(true)`, `setTimeScale(x)`, `frames(n)`.
- **You must LOOK at your screenshots** (Read tool on the PNG) and judge them like an art director comparing against
  photographs of real alpine roads; iterate until they hold up. Check all four sky presets, near and far, and at speed
  (autopilot driving) where relevant. Save your final review shots to
  `$SCRATCH/review/<yourprefix>/`.
- **Performance**: measure with `__game.stats()` after a few seconds (headless Chrome uses the real GPU). Report frame
  time with and without your system (run the harness with and without it) at 1600x900 viewport, quality=high.
- **Lint**: `npx eslint <your files>` must be clean.
- Until other systems exist, the harness provides fallback lighting when `environment` is not in the list; once
  `src/gfx/environment.js` exists (another engineer is writing it right now) prefer running WITH it:
  `systems=environment,<yours>`. Other engineers' systems appear over time - re-test with them near the end, but never edit
  their files; report integration problems instead.

## Assets
All game-ready assets are under `public/assets/` (served at `/assets/...`) with index files exposed as `ctx.assets.index.*`
(textures, rocks, trees, plants, props, audio, sky, car, ghosts). Detailed usage notes written by the asset engineers:
`$SCRATCH/notes/assets-notes.md` - read the sections relevant to you. Do not re-download or
re-process assets unless your brief says so; if an asset is unusable, say so in your report (and work around it).
Model convention: each GLB holds variants with LOD nodes named `<variant>_LOD0|1|2` (identity transforms, pivot at the
bottom centre, shared materials); foliage is alpha-MASK + double-sided.

## Report (structured)
summary; files (created / modified); api (what your system exposes to others: fields + methods + events, exactly);
verification (what you looked at: screenshot paths + what they show; console clean?); performance (measured numbers);
issues (known weaknesses, honest); contractRequests (changes you need in shell / other systems).
Never claim something works unless you ran it and looked at it.
