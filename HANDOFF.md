# CS 61B "Project 5" (formerly Alpenglow) — status and remaining work

_Last updated 2026-11-23. Nothing is running in the background._

## 0. Changes of 2026-11-20 … 23 (read this first)

The owner drove it and reported: boot stuck at "Warming up", occasional freezes, breakage when changing the time of
day. They asked for a smooth, realistic game with fewer features, the CS 61B "Project 5" joke name, a TA easter egg,
and **Dusk as the only time of day**. Gameplay was called good and was not touched.

- **Cause of all three bugs:** render pipelines were built on the frame an object first appeared. On a cold shader
  cache that blocks for seconds (15–21 s at boot). The old `renderer.compileAsync( scene, camera )` compiled for the
  canvas, but the post chain draws into its own MRT target, so nothing it built was reused; the headlights were created
  lazily (a new light rebuilds every lit shader); ~50 instance buckets and the ghost car were empty / hidden at boot.
- **Fix:** `Game._warmUp()` in `src/game/game.js` shows everything once (visible, unculled, instance count ≥ 1),
  compiles through `post.compile()` (`scenePass.compileAsync`, with the render-target types set first - otherwise the
  depth buffer is created as Depth24Plus and every frame logs a copy error), draws one frame, restores. Boot waits have
  timeouts. **Rule: never add a light, or first show an object, after boot.**
- **Dusk only:** `environment.js` loads `'dusk'` unconditionally, `Game.setSky()` is a no-op, the menu cards are gone.
  The other presets' files are still in `public/assets/sky/` (unused; ~70 MB that could be deleted). No sun at dusk, so
  the cascaded sun shadows never render.
- **Shadows:** the two headlight spot lights exist from boot and cast shadows (1024², near 1.4 m so the car does not
  shadow itself; beam aimed ~20 m ahead, intensity 1500). Terrain no longer casts shadows (it only receives).
- **Rename:** boot splash, page title, menu, gantry banner ("CS 61B · PROJECT 5"), package name. Internal names
  (localStorage keys `alpenglow.*`, the circuit name in `layout.js`, CSS prefix `ag-`) were left alone on purpose.
- **Course staff as rivals** (`src/game/staff.js`, names from https://fa26.datastructur.es/staff/ read 2026-11-23; the
  owner asked for real names): gold ghost = Josh Hug, silver = a random Head TA, bronze = a random TA, re-picked each
  race started from the menu. Shown in the menu's rival selector, the medal list, the "vs …" delta label, the lap card
  ("Josh Hug level"), a card at race start, and a DOM name tag floating over the ghost car (`updateGhostTag` in
  `src/ui/ui.js`). Typing `61b` lists the whole staff. Internal ids are still gold / silver / bronze.
- **Measured** (headless Chrome, 1728×1000 at 2× → pixel ratio 1.5, mains power): 105 s autopilot drive, mean 16.7 ms,
  p99 24 ms, max 25.8 ms, no frame over 34 ms. On battery below 20 % Chrome's Energy Saver caps the page at 30 fps.
- Not re-measured: a truly cold first boot after the depth-format fix (later runs had a warm shader cache).
- A faint slanted edge in the sky when looking toward the afterglow is in the photographed sky itself, not a bug.

Sections below predate these changes: wherever they mention four sky presets, sun shadows or "Alpenglow" as the
visible name, this section wins.

## 1. Where things stand

**The game is playable.** `npm run dev`, open http://127.0.0.1:5173, press Start: menu over an attract-mode drive,
countdown, a full lap of the circuit with HUD, lap timing, medals and a visible ghost rival, pause menu, photo mode.
Ten of the fourteen systems exist. It is a first pass of each: everything works together, nothing is polished.

| Area | State |
|---|---|
| Circuit + landscape design, terrain bake, physics, vehicle, AI driver, race logic, ghosts | **Done**, 51 tests |
| Runtime shell + session controller | **Done**, verified in the browser |
| Environment (sky, sun, cascaded shadows, fog, wind values) | First pass done |
| Terrain (chunked LOD, 8 photoscanned layers, far alpine ring) | First pass done |
| Road (asphalt, markings, aprons, guard rails, marker posts, start gantry + lights) | First pass done |
| Water (lake: ripples, depth colour, sky reflection) | First pass done; no planar reflection of the mountains yet |
| Scatter (76 k firs with LODs + baked billboards, 6.5 k rocks, shadow proxies, colliders) | First pass done; no wind animation; one tree species |
| Car + ghost car (material recipe, 8 paints, wheels, driver, lamps, headlights) | First pass done |
| Camera rig (chase, far chase, bonnet, cockpit, orbit, cinematic, photo) | First pass done |
| Post-processing (GTAO, TRAA, bloom, per-preset grade, vignette) | First pass done; no motion blur, SSR, depth of field |
| UI (menu, settings, controls, countdown, HUD, pause, photo hints) | First pass done; system fonts only |
| **Grass, props, effects (smoke / skid marks), racing-line guide, audio** | **Not started.** Briefs exist |
| Assets | Trees: one species only. Audio: engine loops only, licences unverified. Rest delivered, unverified |
| Tuning, playtesting by a human, review rounds, README, CREDITS | Not started |

Tests: `npm test` → 51 of 51 pass. `npm run build` works. Roughly 70 % of the total effort is done.

**Nobody has driven it by hand yet.** Every check so far was automated: the AI driving, and screenshots. Keyboard feel,
camera comfort and difficulty are untested by a person.

### Measured on the finished simulation

| | |
|---|---|
| Lap length / estimated lap | 5315 m / ~2:11 |
| Medal ghosts, dry (gold / silver / bronze) | 2:11.4 / 2:17.2 / 2:26.2 |
| Medal ghosts, wet | 2:31.5 / 2:39.3 / 2:51.0 |
| AI clean-lap check | zero time off the road, no hard impacts, at every skill level 0.70–1.06 |
| Physics cost | 0.04 ms per step (Node) |

## 2. What the game is (decisions already made — no need to revisit)

- **Alpenglow**: an original mountain-pass time-attack driving game. A ~570 hp mid-engine V8 sports car on a ~5 km closed
  road around an alpine lake. Rolling start, continuous flying laps, live time delta against a ghost, bronze / silver /
  gold medal ghosts driven by an AI using the same physics, plus the player's own best-lap ghost.
- Four sky presets: golden hour (signature look), noon, overcast (wet road), dusk (headlights).
- **Plain JavaScript** (ES modules, no TypeScript), Three.js r187 with **WebGPURenderer + TSL node materials**, Rapier
  physics, Vite. You asked for "Java"; we confirmed that meant JavaScript.
- Renderer uses a reversed depth buffer (verified to work with the post-processing chain), so a 0.1 m near plane and a
  40 km far plane coexist.
- Vehicle: a custom raycast-wheel model on one Rapier rigid body with its own tire model (not Rapier's built-in vehicle).
- Axis and sign conventions are fixed in `src/sim/constants.js` (forward = −Z, yaw positive = left, wheel order
  FL / FR / RL / RR, track coordinate `d` positive = left). Everything is written against them.
- The car is presented as a fictional car: real-brand badges are stripped from the model and no brand name appears in
  the game. The model's licence still requires attribution (section 8).

## 3. What exists, in detail

### 3.1 Tooling

| Command | What it does |
|---|---|
| `npm install` | Dependencies are already installed |
| `npm run dev` | Vite dev server on http://127.0.0.1:5173 (no hot reload, by design) |
| `npm test` | Node test runner over `tests/core` and `tests/sim` — 51 of 51 pass |
| `npm run lint` | ESLint. `src/` is clean; `tools/assets/` has 48 `no-undef` errors in throwaway asset scripts |
| `node tools/shot.mjs --url <url> --out <png> --wait-for "window.__ready === true"` | Drives real headless Chrome with WebGPU and saves a screenshot plus the page's console errors |
| `node tools/sim-vehicle.mjs [--list]` | Runs the vehicle maneuver suite and prints a metrics table |
| `node tools/check-layout.mjs` / `node tools/render-map.mjs <dir>` | Circuit constraint report / debug maps |

Dev pages that work today (with the dev server running): `/dev/spike.html` (WebGPU pipeline check) and
`/dev/viewer.html?models=/assets/car/car.glb` (generic asset viewer; parameters are documented at the top of the file).
`/dev/sys.html` (the system harness) will work once the baked world exists.

### 3.2 Runtime shell (lint-clean, verified in the browser through the dev harness)

| File | Role |
|---|---|
| `src/game/context.js` | The contracts: system factory rules, `GameContext`, `Frame`, `HudState`, `GameApi`, event list |
| `src/game/game.js` | Boot sequence, system creation / update order, fixed-step loop with render interpolation, phases (menu, countdown, drive, paused, photo) |
| `src/game/debugApi.js` | `window.__game` automation surface (teleport, free camera, stats) for tests and screenshots |
| `src/main.js`, `index.html` | Entry point and boot splash |
| `src/core/` | `assets.js` (cached loaders + asset indexes), `settings.js`, `storage.js` (lap records), `input.js` (keyboard + gamepad, rumble), `events.js`, `math.js`, `rng.js`, `png.js` (exact-bytes PNG decoder, tested) |
| `src/gfx/shared.js` | Shared TSL uniforms (sun, fog, wind, wetness, time, car position) |
| `src/gfx/worldTextures.js` | GPU textures + TSL lookups for baked world maps, vegetation mask stamping. CPU side verified; the TSL lookups (`heightAt`, `splat0At` ...) are still unexercised until the terrain system uses them |
| `src/sim/constants.js`, `src/sim/types.js` | Conventions, surface table, telemetry type definitions |
| `dev/harness.js`, `dev/sys.html` | Boots the real game with any subset of systems, driven by URL parameters |

`src/game/sessionController.js` bridges the shell and the simulation: who drives (player / AI), countdown, laps, records, medals, ghost selection, HUD state.

### 3.3 Assets (`public/assets/`, ~320 MB) — raw downloads are in `assets-src/` (5.2 GB)

The asset agents were stopped before writing their final reports, so **treat every category as unverified**: the files
exist, but nobody signed off on them and the planned usage notes were never written.

| Category | On disk | Remaining |
|---|---|---|
| Sky | 4 presets (`golden`, `noon`, `overcast`, `dusk`): 4k background HDR, sun-removed 1k lighting HDR, measured `meta.json`, thumbnails, `presets.json` | Confirm the energy calibration (sun intensity vs. original HDR) and exposures; the agent was still iterating |
| Textures | 16 PBR sets (9 terrain layers, 2 asphalt, concrete, galvanized metal, 2 wood, rock detail) + 25 FX textures (water normals, smoke, sparks, flares, noise, LUTs), `index.json` | Final look check of each set; confirm seamless tiling |
| Rocks | 12 assets / 31 variants with LODs and colliders, `index.json` | Visual verification of LODs; group scale shot |
| Plants | 9 assets / 28 variants (grass, flowers, ferns, shrubs, debris), `index.json` | Instanced meadow test and final check |
| Props | 16 assets / 28 variants, `index.json` | Scale and collider verification |
| Car | `car.glb` (~365 k triangles), `car_lod1.glb` (~34 k), `car.json` (52 KB measured spec + material recipe), ground-shadow and tyre textures. Both GLBs are valid files. Licence confirmed as CC BY 4.0 | `car.json` is **5 minutes older than the last rebuild** — regenerate with `tools/assets/car-spec.mjs`. Verify that no badge or dark recess remains (nose, tail, wheel caps, steering wheel, sills). Final renders for 4 paints under 2 skies |
| Trees | `fir.glb`: 6 fir variants (3 tall, 3 young), each with 3 LODs; `index.json` written from the build metadata | More species (pine, saplings, dead wood): raw downloads are already in `assets-src/trees/` |
| Tree impostors | Not baked. The scatter system renders its own far-tree billboards at load instead | Optional: proper multi-view impostor atlases |
| Audio | 10 engine loops (`engine_idle*`, `engine_on_1800…6200`, `engine_off_2400 / 6300`); **no index** | Verify the licence of each source (raw folders: `assets-src/audio/fs-*`), measure per-loop RPM, write `index.json`; tyres, wind, impacts, ambience, UI are missing (the audio system brief allows synthesizing them) |
| three.js r187 reference | **Not written** (only benchmark data survived, section 3.5) | Write it, or have each system author verify APIs directly against `node_modules/three` |

### 3.4 Simulation (`src/sim/`)

| Module | State |
|---|---|
| `physics.js` (Rapier wrapper) | Complete; 9 tests pass (heightfield orientation, ray casts, impacts, determinism) |
| `vehicle.js`, `tire.js`, `vehicleConfig.js`, `tools/sim-vehicle.mjs` | Working and already inside the acceptance targets (section 3.5). **Not adversarially verified**, and `tests/sim/vehicle.test.mjs` does not exist. The agent was still tuning |
| `noise.js`, `track.js`, `layoutCheck.js`, `tools/render-map.mjs`, `tools/check-layout.mjs` | Done; 29 tests |
| `layout.js` | The designed circuit and macro terrain (control points, corner names, sectors). Iterate with `node tools/check-layout.mjs` and `node tools/render-map.mjs <dir>` |
| `world.js`, `world.node.js`, `terrainGen.js`, `roadGeometry.js`, `tools/bake-world.mjs` | Done; 6 tests. Re-run `node tools/bake-world.mjs [--debug <dir>]` then `node tools/bake-ghosts.mjs` after any layout change |
| `session.js`, `race.js`, `ghost.js`, `autopilot.js`, `tools/sim-lap.mjs`, `tools/bake-ghosts.mjs` | Done; 4 tests. `node tools/sim-lap.mjs --skill 1 --laps 2 --trace` shows an AI lap |

### 3.5 Measured numbers worth keeping

Vehicle (from `node tools/sim-vehicle.mjs`, flat dry asphalt):

| Metric | Measured | Target |
|---|---|---|
| 0–100 km/h | 3.49 s | 3.2–3.9 |
| 0–200 km/h | 10.0 s | 10–12.5 |
| Top speed | 328 km/h | 305–335 |
| 100–0 km/h | 32.9 m | 31–37 |
| 200–0 km/h | 126.4 m | 125–150 |
| Skidpad R = 50 m | 1.21 g | 1.20–1.35 |
| Step-steer overshoot (100 / 180 km/h) | 2.5 % / 13 % | < 25 % |

Post-processing cost on this Mac (Apple M4 Pro, test scene, added frame time; full data in
`docs/handoff/benchmarks/`):

| Effect | Added cost |
|---|---|
| TRAA | +0.7 ms |
| GTAO + TRAA | +1.5 ms |
| Bloom | +0.3 ms |
| GTAO + TRAA + bloom | +1.8 ms |
| SSR at half resolution / full resolution | +1.8 ms / +5.7 ms |
| SSGI + TRAA | **+12.9 ms** — too expensive for 60 fps; plan on GTAO instead |

## 4. What remains, in order

1. **Drive it yourself** and note what feels wrong (steering, camera, assists, medal difficulty). This is the most
   valuable next step and only a person can do it.
2. **The four missing systems**, from their briefs in `docs/handoff/briefs/`: effects (tyre smoke, dust, skid marks) and
   audio add the most feel; then grass, the racing-line guide, and props.
   After adding a new system file, run `touch src/game/game.js` (or restart the dev server): system modules are found
   through a Vite glob that is only re-evaluated when `game.js` changes.
3. **Second pass on what exists**, in rough order of visible payoff: wind on trees; planar reflections on the lake;
   motion blur; car paint reflections; richer far-ring mountains; terrain between forest and road; performance (the
   frame draws 4.5–7 M triangles including shadow passes, against a 3.5 M target).
4. **Check the other three sky presets.** Only golden hour has been looked at. Noon, overcast (wet road) and dusk
   (headlights) run through the same code but are unseen.
5. **Finish the assets** (section 3.3): more tree species, audio with verified licences, car sign-off.
6. **Vehicle hardening** (`B5` in `docs/handoff/workflow-prompts/sim-foundation-workflow.js`): `tests/sim/vehicle.test.mjs`,
   fuzzing, exploit hunting.
7. **Finish:** `CREDITS` (section 8), README with controls, clean-up (section 5).

## 5. Known issues and loose ends

  legs", and "the current circuit data builds and its terrain function is usable" (a terrain step far outside the
  playable square in the placeholder `baseHeight`).
- **`car.json` is stale** relative to `car.glb` (see 3.3). One build-script edit for the nose-badge plate was applied by
  the last agent just before it was stopped; the result has not been looked at.
- **Briefs reference a temp folder.** Paths in `docs/handoff/briefs/*.md` were rewritten to `$SCRATCH/...`. Of the files
  they point to, the API reference and the asset usage notes were never written, and the three.js example pages must be
  re-fetched (section 7).
- The texture sets are meant to be shaded with the `recommended.albedoTint` / `aoIntensity` stored per set in `public/assets/textures/index.json` (the raw meadow scan is tan, not green).
- `tools/assets/` holds 125 one-off asset scripts with 48 lint errors (`no-undef`, browser globals inside page scripts).
  Either exclude the folder from lint or tidy the scripts that remain useful.
- `assets-src/` is 5.2 GB of raw downloads. It is needed until trees and audio are finished, then it can be deleted.
  It is listed in `.gitignore`.
- Not a git repository; nothing has been committed. A `.gitignore` is in place for when you run `git init`.
- `dev/` contains leftover preview pages from the asset work (`preview-*.html`, `crib/`, `spike*.html`). Harmless.
- `docs/handoff/workflow-prompts/*.js` are orchestration scripts kept as reference for their task specifications. They
  are not part of the game and are not meant to be run with Node.

## 6. Resuming without overheating the machine

What caused the heat: up to eleven agents ran in parallel, and most of them repeatedly launched headless Chrome for
WebGPU renders while others processed multi-gigabyte meshes.

- Run **one stage at a time with two or three agents**, not eleven. The steps in section 4 are already sequenced for that.
- Avoid several screenshot / GPU jobs at once; they are the main load.
- Use high rather than maximum reasoning effort for build agents. At maximum, one design agent spent its entire output
  budget deliberating, twice, without writing a file.
- Give agents the "iterate with real feedback, write files early" working style (it is in the prompts under
  `docs/handoff/workflow-prompts/`).
- **Permission prompts:** approving lets an agent continue; declining terminates it. One agent waited 25 minutes on a
  prompt. An allowlist for routine build and file-edit commands would avoid that.

## 7. Reference material

| What | Where |
|---|---|
| Briefs for all 14 systems + the common engineering brief | `docs/handoff/briefs/` |
| Full task specifications for assets and simulation (prompt text inside the scripts) | `docs/handoff/workflow-prompts/` |
| Post-processing benchmark data | `docs/handoff/benchmarks/` |
| three.js r187 example pages (API reference by example) | Re-create: `git clone --depth 1 --filter=blob:none --sparse --branch r187 https://github.com/mrdoob/three.js.git three-ref && cd three-ref && git sparse-checkout set --no-cone '/examples/*.html' '/docs/pages/TSL.html.md'` |
| Poly Haven catalog | `https://api.polyhaven.com/assets?t=models` (also `textures`, `hdris`); files per asset: `https://api.polyhaven.com/files/<id>` |

Verified three.js r187 facts (the installed source in `node_modules/three` is the ground truth): `await renderer.init()`;
`THREE.RenderPipeline` replaces `PostProcessing`; `HDRLoader` replaces `RGBELoader`; `PCFSoftShadowMap` was removed;
`directionToColor` / `colorToDirection` were renamed `packNormalToRGB` / `unpackRGBToNormal`;
`reversedDepthBuffer: true` works with GTAO, TRAA and bloom; `renderer.info.render.drawCalls` / `.triangles` exist;
`renderer.compileAsync( scene, camera )` exists.

## 8. Licences to carry into CREDITS

- **Car model:** "Ferrari 458 Italia" by vicent091036, CC BY 4.0, obtained from the three.js r187 examples. Attribution
  is required; the exact text and source links are in `public/assets/car/car.json` under `license`.
- **Poly Haven** (skies, textures, rocks, plants, props, trees): CC0. Credit is optional but intended; each index file
  records author and source per asset.
- **Audio:** sources are not yet licence-verified (step 6). Do not ship the engine loops until they are.
- **FX textures and LUTs:** taken from the three.js repository (MIT); per-file credits are in
  `public/assets/textures/index.json`.
- **Libraries:** three.js (MIT), Rapier (Apache-2.0), Vite (MIT).
