export const meta = {
  name: 'alpenglow-sim-foundation',
  description: 'Build the simulation foundation: track core, circuit + terrain design, terrain bake, vehicle dynamics on Rapier with adversarial verification, AI driver, race logic and baked ghost rivals',
  phases: [
    { title: 'Track core', detail: 'noise, Track class, layout checker, map renderer' },
    { title: 'Design', detail: 'circuit + macro terrain design by visual iteration' },
    { title: 'Track review', detail: 'independent critique and improvement of the circuit' },
    { title: 'Bake', detail: 'erosion, road conforming, baked world data + runtime World' },
    { title: 'Vehicle', detail: 'physics wrapper + custom raycast vehicle with tire model' },
    { title: 'Vehicle verify', detail: 'adversarial verification and hardening of the vehicle dynamics' },
    { title: 'AI + race', detail: 'autopilot, race logic, ghosts, baked rivals, lap evaluation' },
  ],
}

const ROOT = '/Users/rayeeev/Desktop/Coding/Playground/Game'
const SP = '/private/tmp/claude-501/-Users-rayeeev-Desktop-Coding-Playground-Game/c7fa453a-8723-4335-bdc3-fea318946bcc/scratchpad'

const CTX = `You are one of several agents building the SIMULATION FOUNDATION of "Alpenglow", a realistic 3D mountain-pass time-attack driving game for the browser. Stack: plain JavaScript ES modules (NO TypeScript); Rapier physics (@dimforge/rapier3d-compat 0.21.0, works in Node and browser); Three.js r187 WebGPU does the rendering (not your concern); Vite.

THE GAME: the player drives a ~570 hp mid-engine rear-wheel-drive V8 sports car (wheelbase ~2.65 m, ~1480 kg, 9000 rpm) on a ~5 km closed mountain road around an alpine lake, chasing lap times, medal ghosts (bronze / silver / gold, driven by an AI driver using the very same physics) and the player's own best-lap ghost. Session format: rolling start ~120 m before the start/finish line, then continuous flying laps with a live time delta against the selected ghost. The driving must feel like a believable sports car (weight transfer, grip limits, power oversteer, handbrake turns) and still be controllable on a KEYBOARD.

PROJECT ROOT: ${ROOT}   (always run node from this directory)
READ FIRST - binding contracts. Do not modify them; if you need a change, describe it under "contractChanges" in your report:
  src/sim/constants.js   axis / sign conventions (READ THE HEADER COMMENT CAREFULLY), PHYSICS_DT (1/120 s), wheel order, Surface ids and the SURFACES table
  src/sim/types.js       TrackFrame, TrackProjection, VehicleInput, VehicleState, WheelState, ImpactEvent, SpawnPose
  src/core/math.js, src/core/rng.js, src/core/events.js   shared helpers - use them instead of duplicating
LAYERING: everything under src/sim and src/core must run unchanged in Node AND in the browser: no DOM, no fetch / fs at module top level, no renderer. Allowed imports there: other src/sim and src/core modules, '@dimforge/rapier3d-compat' (physics modules only), 'three' math classes only if truly needed (prefer plain numbers / typed arrays on hot paths). Node-only helpers (fs, sharp) live in tools/ or in files named *.node.js that browser code never imports.
CODE QUALITY: modern JavaScript (ES2023) modules, tabs for indentation, semicolons, JSDoc on every exported function / class / public field, meaningful names, no dead code, no TODO left behind. Hot paths (anything called per physics step) must not allocate: reuse arrays and objects. Deterministic: no Math.random (use src/core/rng.js), no wall-clock time in simulation logic.
TESTS: node's built-in runner; files tests/sim/<name>.test.mjs; run with  node --test tests/sim/<name>.test.mjs . Deterministic, fast unless stated.
DEBUG IMAGES: scratch directory ${SP}/sim/<your-prefix>/ . Generate PNGs in Node with the 'sharp' package (installed): sharp(rawRGBA, { raw: { width, height, channels: 4 } }).png().toFile(path), or build an SVG string and rasterize it with sharp(Buffer.from(svg)).png().toFile(path). You MUST look at your images with the Read tool and iterate - do not ship geometry or behaviour you have not inspected.
RULES: do NOT run npm install; do not edit package.json or vite.config.js; create / modify ONLY the files listed as yours (other agents are working on other files at the same time); do not create markdown / notes files in the project; python3 (if used) must be invoked as python3 -I and has no numpy.
WORKING STYLE (important): work incrementally. Get a first running version onto disk within your first few actions, then iterate with real feedback (tests, numbers, images). Do NOT try to design everything in your head before the first tool call - long silent deliberation is counter-productive here and exhausts your output budget; keep each reasoning step short and let measurements guide you. Write large files in several pieces (multiple Write / Edit calls) rather than in one enormous call.
REPORT: precise and honest. State what you built, the measured numbers, how each claim was verified, known weaknesses, and any contract changes you need. Never report something as verified unless you ran it.

=====================================================================
`

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'Files created or modified (project-relative)' },
    api: { type: 'string', description: 'The public API you implemented, as other engineers must use it (signatures + semantics + gotchas)' },
    metrics: { type: 'string', description: 'Measured numbers / tables' },
    verification: { type: 'string', description: 'What was verified and how (tests, images looked at)' },
    images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the most informative debug images' },
    issues: { type: 'array', items: { type: 'string' } },
    contractChanges: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files', 'api', 'metrics', 'verification', 'issues'],
}

const HARD = `closed loop; centreline length 4600-5400 m; no self-intersection; any two centreline points whose arc distance exceeds 120 m are more than 38 m apart horizontally; minimum horizontal radius >= 16 m everywhere and >= 30 m outside the hairpins; |grade| <= 11 %; vertical curvature gentle enough that a car at the locally attainable speed stays on the ground (crest radius >= 300 m, except ONE deliberate crest where the car may go light but must not jump: there the vertical acceleration demand v^2 / R at the estimated speed must stay below 0.85 g); road surface >= 2.5 m above the water level everywhere; the whole road at least 350 m inside the border of the playable square; paved width 9 m (11 m on the start straight, 10 m through hairpins, smooth width transitions)`

const T1 = `TASK T1 - TRACK CORE (engineering).   Prefix: trackcore.   Your files: src/sim/noise.js, src/sim/track.js, src/sim/layoutCheck.js, src/sim/layout.js (a PROVISIONAL version: a circuit designer replaces its data right after you), tools/render-map.mjs, tools/check-layout.mjs, tests/sim/track.test.mjs.

You build the machinery for the circuit. Another agent (the circuit designer) uses it immediately afterwards to design the real road and landscape by rapid visual iteration, so your tools must be correct, fast and pleasant to iterate with.

1) src/sim/noise.js - deterministic seeded 2D noise: export function createNoise2D(seed) returning (x, y) => value in [-1, 1] (simplex or gradient noise), plus helpers fbm(noise, x, y, octaves, lacunarity, gain), ridged(noise, x, y, octaves, lacunarity, gain) and a domain-warp helper. It will be evaluated tens of millions of times at bake time: make it fast.

2) src/sim/layout.js - provisional DATA, final STRUCTURE (the designer only changes the data and the body of baseHeight):
   export const WORLD = { size: 3072, cell: 2, minX: -1536, minZ: -1536, waterLevel: 0, seed: 20261117, outerSize: 24576, outerCell: 48 }   // inner playable square (meters) centred on the origin + a far, visual-only ring
   export function baseHeight(x, z)   // macro terrain height in meters for ANY x, z (also far outside the playable square), deterministic, smooth at the ~10 m scale (fine detail and erosion are added later by another agent). Provisional body: a simple believable valley (a lake basin below y = 0, a rising flank, rolling hills, high ground far away).
   export const LAYOUT = { name, closed: true, controlPoints: [ { x, z, y? (optional explicit road height), width? (paved width override in m), bank? (override in rad), name? } ... ], defaultWidth: 9, gridOffset: 120 /* spawn this far before the line */, checkpointSpacing: 150, sectors: [0, f1, f2] /* lap fractions where the 3 sectors start */, corners: [ { name, s } ... ], elevation: { ...smoothing / limit parameters... }, banking: { gain, maxDeg: 6 } }
   Provisional data: a valid, simple closed loop of about 5 km around the lake so that everything can be tested end to end today.

3) src/sim/track.js - export class Track:
     constructor(layout)   // builds everything deterministically in < 150 ms: a smooth closed curve through the control points (centripetal Catmull-Rom or better - curvature must be continuous enough to drive smoothly; consider a light curvature-smoothing pass on the resampled curve), arc-length resampling at 1 m spacing, the elevation profile y(s) (from control-point y where given, otherwise from the smoothed baseHeight under the route, followed by grade limiting and vertical-curvature limiting), banking derived from curvature (partial lateral-acceleration compensation, |bank| <= 6 degrees, smooth), the width profile.
     Fields: length, closed, spacing (1), count, layout, sectors (s-values where the 3 sectors START: [0, s1, s2]), checkpoints ([{ index, s } ...], index 0 at s = 0), gridS (spawn position = length - gridOffset), corners.
     frameAt(s, out = {}) → TrackFrame (types.js; interpolated between samples; s wraps)
     pointAt(s, d = 0, out = [0, 0, 0]) → road-surface position P(s, d)
     project(x, z, hintS = undefined, out = {}) → TrackProjection: the nearest centreline point in the horizontal plane. With hintS: a local search (fast and continuous along a car's path); without: a global search through a spatial hash. Must behave sensibly between switchback legs (document the behaviour).
     curvatureAt(s), halfWidthAt(s), bankAt(s), gradeAt(s), heightAt(s)
     spawnPose(s, d = 0) → SpawnPose (position on the road surface, yaw along the driving direction; mind the yaw convention)
     polyline(step = 5) → Float32Array [x0, z0, x1, z1, ...] for the minimap
     The per-sample arrays are public typed arrays (xs, ys, zs, tangents, lefts, ups, curvatures, halfWidths, banks, grades ...) for consumers that iterate (road mesh builder, AI driver).
   Performance: project() with a hint typically < 2 microseconds; frameAt is allocation-free when out is passed.

4) src/sim/layoutCheck.js (pure): export function checkLayout(track, WORLD, baseHeight) → { ok, metrics: { length, minRadius, minRadiusOutsideHairpins, maxGrade, minCrestRadius, maxCrestG, minSeparation, minHeightAboveWater, minBorderMargin, maxCut, maxFill, selfIntersections ... }, violations: [ { rule, value, limit, s } ... ], corners: [ { s, radius, direction, entrySpeed, minSpeed, exitSpeed } ... ] (detected automatically from curvature), speedProfile (Float32Array per sample), estimatedLapTime }.
   It implements these HARD CONSTRAINTS: ${HARD}.
   Speed estimate: v = sqrt(a_lat / |k|) with a_lat = 12 m/s^2, limited by 6 m/s^2 acceleration and 11 m/s^2 braking, capped at 320 km/h. maxCut / maxFill compare the road surface with baseHeight under the centreline and at +-12 m.
   tools/check-layout.mjs prints the metrics, the violations and the corner table in one compact report.

5) tools/render-map.mjs - a debug renderer (Node + sharp), CLI: node tools/render-map.mjs <outDir>, writing PNGs: (a) a 2048 x 2048 top-down map of the playable square: hill-shaded baseHeight with hypsometric tint + contour lines every 20 m, the lake in blue, the road ribbon at true width, start line, direction arrows, s-markers every 250 m, corner names, control points as small dots with their index; (b) a wider map showing the far ring; (c) the elevation profile y(s) with grade colouring and the baseHeight under the route for comparison (cut / fill); (d) curvature and the estimated speed profile. Fast (< 6 s for all images; render the hill-shade at reduced resolution if needed). Export reusable functions (other agents will draw their own overlays with them).

6) tests/sim/track.test.mjs - generic Track correctness (not design constraints): frame orthonormality (unit vectors, up = tangent x left), no jumps in position / tangent / curvature anywhere including the s = 0 seam, banking sign convention (bank has the sign of the curvature in corners), project() round trips (project(pointAt(s, d)) ≈ (s, d)) for thousands of random samples in hint and no-hint modes including near the seam, spawnPose yaw consistent with the tangent, determinism, the project() performance budget.

Report: the API with exact signatures, performance numbers, and the exact commands the designer should use.
`

const T2 = `TASK T2 - CIRCUIT + LANDSCAPE DESIGN (creative).   Prefix: design.   Your files: src/sim/layout.js (replace the provisional data and the body of baseHeight; keep the exported structure), tests/sim/layout.test.mjs. The tools were written minutes ago by the track-core engineer (report appended below); you may fix genuine bugs in src/sim/track.js, src/sim/layoutCheck.js, tools/render-map.mjs, tools/check-layout.mjs - report any such fix.

You design the road and the land it lies on. This is the most important creative decision of the whole game: the circuit must be a road people want to drive again and again.

HOW TO WORK (essential): design by ITERATION WITH YOUR EYES, not by long deliberation. Within your first three actions write a rough first version of baseHeight + control points, then loop: node tools/check-layout.mjs → node tools/render-map.mjs <dir> → LOOK at the PNGs with the Read tool → adjust → repeat. Expect 10-25 quick iterations. Keep every reasoning step short: the map images and the checker numbers tell you what to fix next.

THE LAND: an alpine valley. A lake (surface at y = 0, bed down to about -35 m, roughly 900 x 550 m, organic outline) on the valley floor; on one side a mountain flank rising steadily to a shelf / ridge at about +130..160 m and on to peaks of +500..700 m beyond the road; on the other sides rolling foothills (+40..120 m) and meadows; the far ring (outside the playable square, visual only) is a wall of high alpine peaks (1200-2400 m) with a couple of lower saddles so the horizon is mountainous in every direction. Inside the playable square the terrain must look natural (no absurd spikes, no concentric blobs, no straight ridges) and everything within ~60 m of the road needs macro slopes that allow a believable road bed (cut / fill up to ~8 m).
THE ROAD, in driving order from the start/finish line (s = 0):
  a. LAKESIDE STRAIGHT: start/finish; 650-800 m, nearly straight (a very gentle bend is welcome), 3-5 m above the water with the lake right beside it. The top-speed section (300 km/h reachable).
  b. A fast kink, then a heavy braking zone into a medium-speed corner that leaves the lake.
  c. THE CLIMB: 3-4 hairpins (switchbacks) up the mountain flank, centreline radius 17-24 m, linked by straights / slight curves of 120-220 m; total climb 110-140 m at 6-10 % grade. Switchback legs at least 38 m apart horizontally (centre to centre).
  d. THE RIDGE: flowing high-speed esses along the shelf with one pronounced blind crest and a view over the lake; radii 80-220 m.
  e. THE DESCENT: fast downhill sweepers (grade -5..-9 %) through what will be forest, including one tightening-radius corner and one compression (dip).
  f. A technical finale: a chicane or double-apex complex by a rock outcrop, then a medium-speed corner back onto the lakeside straight (its exit speed matters for the whole straight).
A workable starting sketch (deviate wherever it improves the result): lake centred near (0, +480), about 900 m in x by 550 m in z; the mountain flank rises to the NORTH of the lake (toward -z): gentle near the shore, the shelf at about +140 m around z ≈ -550, peaks beyond z < -900; foothills east and west, a lower saddle south of the lake. The start/finish straight runs along the north shore at z ≈ +170, driven westward from about x = +420 to x = -350 (lake on the driver's left); the fast kink and the braking zone near x ≈ -480; a right-hander turning north into the climb; three or four switchbacks stacked on the flank between z ≈ +80 and z ≈ -420 on the west side (x between -750 and -250); the ridge esses run east along the shelf from x ≈ -550 to x ≈ +550; the descent sweeps down the east side (x ≈ +650..+850) heading south; the technical finale near (+650, +330) by a rock outcrop; the last corner turns west onto the straight.
HARD CONSTRAINTS (checkLayout must return ok: true; tests/sim/layout.test.mjs asserts that plus determinism): ${HARD}.
Rhythm matters: a mix of corner speeds (a few ~60 km/h, several 100-160, a few 200+), left / right balance, corners that link into each other, visible landmarks. Give the corners evocative names (LAYOUT.corners at the right s), set the sectors (for example S1 = lakeside + climb, S2 = ridge, S3 = descent + finale) and the checkpoint spacing.
DONE WHEN: checkLayout is ok with margin; the maps look like a real road engineered into a real valley (switchbacks stacked properly on the slope, no kinks, the road follows the land: cut / fill mostly under 5 m and never over 8 m); the estimated lap time is 105-140 s; the elevation and curvature plots look deliberate rather than accidental.
Report: the design reasoning, track length, estimated lap time, a per-section description with s-ranges, the corner table (name, s, radius, estimated speeds), minimum radius, maximum grade, elevation range, cut / fill statistics, and the paths of the final map images.
`

const B6 = `TASK B6 - INDEPENDENT CIRCUIT REVIEW AND IMPROVEMENT.   Prefix: trackreview.   The files src/sim/noise.js, src/sim/track.js, src/sim/layoutCheck.js, src/sim/layout.js, tools/render-map.mjs, tools/check-layout.mjs, tests/sim/track.test.mjs, tests/sim/layout.test.mjs were just written by two other agents (a track-core engineer and a circuit designer; their reports are appended below). They are now YOURS to improve. Work by iteration: check-layout numbers and map images first, short reasoning steps.

Act as a second, sceptical circuit designer and road engineer with fresh eyes. Do not trust the report: re-run the tests, re-render the maps (node tools/render-map.mjs ...) and LOOK at them.
Evaluate and fix:
 - Geometry quality: curvature continuity (plot curvature and its derivative; spikes mean kinks you would feel in the steering), unintended wiggles on straights, corner shapes (hairpins should be clean constant-radius arcs with proper entry/exit transitions, not polygons), width transitions, banking sign and smoothness (bank must lean INTO the corner per the conventions in src/sim/constants.js), s = 0 seam.
 - Terrain fit: compare the road elevation with baseHeight across full cross-sections every ~25 m (out to 60 m on both sides): flag sections needing more than ~8 m of cut or fill, road running straight up a fall line, switchback legs whose height difference vs horizontal spacing would need slopes steeper than ~60 degrees between them, lakeside sections too close to or below the water.
 - Driving quality: using the estimated speed profile list every corner (name, s, radius, entry speed, minimum speed, exit speed) and judge rhythm: is there a real top-speed straight, a hard braking zone, a technical section, fast flowing section, a memorable crest? Is anything boring (long stretches at constant speed with nothing happening) or unfair (blind corner tightening after a crest with no reference)? Improve the layout where it helps.
 - Constraint margins and robustness of Track (project() between switchback legs, hints near the seam, performance).
 - The macro terrain as a landscape: does the valley read as a believable alpine place in the hill-shaded map and in the wide map (lake shape, mountain flank, foothills, distant peaks, saddles)? Improve baseHeight where it looks artificial (concentric blobs, straight ridges, noise soup).
Make the improvements directly, keep / extend the tests (add tests for defects you found), re-render the final maps, and report exactly what you changed and why, with before / after numbers and image paths. If the design is already excellent, say so with evidence rather than changing things for the sake of it.
`

const B2 = `TASK B2 - TERRAIN GENERATION, BAKE AND RUNTIME WORLD.   Prefix: world.   Your files: src/sim/terrainGen.js, src/sim/world.js, src/sim/roadGeometry.js, src/sim/world.node.js, tools/bake-world.mjs, tests/sim/world.test.mjs, and the outputs in public/assets/world/ .

Inputs finished by other agents (read the code; their reports are appended below): src/sim/layout.js (WORLD constants, baseHeight(x, z), LAYOUT), src/sim/track.js (Track), src/sim/noise.js, tools/render-map.mjs (debug map renderer whose exported functions you may reuse). Do not change those files; report problems instead (tiny, obviously-correct bug fixes are allowed and must be reported).

Build the pipeline that turns the designed macro terrain + road into baked, game-ready world data, and the runtime class that serves it to physics, rendering, scatter placement, audio and HUD.

1) src/sim/terrainGen.js (pure and deterministic; bake-time code, but no Node APIs in it):
   - Inner height grid: n = WORLD.size / WORLD.cell + 1 samples per side (1537 x 1537, 2 m cells), row-major (see conventions).
   - Start from baseHeight; add multi-scale natural detail (fbm / ridged, slope-dependent: steep rocky areas rougher, meadows smooth); run erosion that yields believable alpine landforms (hydraulic droplet or grid-based erosion + thermal / talus relaxation; run it at a coarser resolution and transfer the result if needed) and keep its by-products (flow accumulation / wetness, deposition) for texturing. Along the road corridor the terrain must stay close enough to baseHeight that the road bed remains plausible.
   - Conform the terrain to the road: under the paved width the terrain lies 0.30 m BELOW the road surface P(s, d) (the road mesh sits on top; nothing may poke through even when the terrain mesh is rendered at half or quarter resolution, so keep that lowered band a little wider than the pavement); at the pavement edge a gravel shoulder 1.5 m wide starts flush with the road edge and falls gently (3-4 %); beyond it a shallow ditch on the uphill side, then cut slopes up to ~60-65 degrees where the natural ground is higher (rock cuts) and fill slopes <= 33 degrees where it is lower, blending into the natural terrain within ~10-45 m depending on the height difference. Extrapolate the road surface with its banking / cross slope. Handle the inside of hairpins and neighbouring switchback legs correctly (use the most relevant road section; no terrain overhanging or rising above a lower leg within its corridor; slopes between legs within the cut limit).
   - Lake: a natural shore (gentle pebble shelf around the waterline, bed below), and a plausible rock-armour embankment where the lakeside road runs beside the water.
   - Outer ring heightfield: WORLD.outerSize / WORLD.outerCell + 1 samples per side from baseHeight + large-scale ridged alpine detail with erosion-like sharpening. It must agree with the inner grid along the inner square's border (fade the inner fine detail to zero toward the border so both agree there within ~0.5 m).
   - Maps for the inner area at 4 m resolution (769 x 769, 8-bit): biome weights for a terrain splat shader with the layers grass_meadow, grass_dry, forest_floor, dirt, gravel, rock_cliff (steep slopes), rock_ground, shore - derived from slope, altitude, curvature, flow / wetness, sun aspect, distance to the road (gravel shoulder, dirt verge) and distance to water; weights sum to 255. Pack as two RGBA images: splat0 = [grass_meadow, grass_dry, forest_floor, dirt], splat1 = [gravel, rock_cliff, rock_ground, shore]. Plus one RGBA "fields" map: R = forest density (where trees grow: moderate slopes, below about +230 m, never on road / shoulder / cut slopes / shore; natural clumping with clearings, open meadows near the lake and at the ridge viewpoints), G = meadow / wildflower density, B = wetness / flow, A = distance to the pavement edge (0 at the edge .. 255 at >= 64 m).
   - Physics surface grid at 2 m: one Uint8 Surface id per cell (GRAVEL on shoulders and scree, GRASS, DIRT in forest, ROCK on steep rock, SAND on the shore, WATER below the water level). ASPHALT is not stored (the road collider decides).
2) src/sim/roadGeometry.js (pure): export function buildRoadRibbon(track, opts) → { positions: Float32Array, normals, uvs (u across 0..1 from the left edge to the right edge, v = s in meters), indices: Uint32Array, rows, cols, sAtRow } - the paved surface as a triangle mesh sampled every <= 2 m along s (denser in tight corners and over crests so the chord error stays < 2 cm) with >= 6 lateral subdivisions; exactly P(s, d). This ONE function feeds both the physics collider and the render mesh so they match exactly. Also export function offsetPolyline(track, d, step) → Float32Array of [x, y, z] points at lateral offset d (for guard rails, edge lines, kerbs), and a helper returning both pavement-edge polylines.
3) tools/bake-world.mjs: runs the generation and writes public/assets/world/: world.json (version, seed, WORLD constants, grid sizes, height encoding incl. quantization range, track summary (length, sectors, checkpoints, gridS), water level, list of files with byte sizes, a content hash), height.bin (Uint16 quantized with a step <= 1.5 cm, or Float32 - your choice; little-endian), outer_height.bin, splat0.png, splat1.png, fields.png, surface.bin; and debug renders into a scratch directory (hill-shade coloured by biome with the road drawn, slope map, flow map, forest-density map, close-up crops of each hairpin and of the lakeside at 0.5 m / pixel showing road bed, shoulders, cuts and fills). Bake time target < 3 minutes on an Apple M4 Pro (single thread is fine); print the time per stage. Running it twice must give byte-identical output.
4) src/sim/world.js - the runtime (Node + browser):
     export class World { static async load(read, options) ... }   // read(relativePath) → Promise<ArrayBuffer>. Export function fetchReader(baseUrl) here; the fs-based export function nodeReader(dir) lives in src/sim/world.node.js.
     Fields: meta (world.json), track (a Track built from the layout), n, cell, minX, minZ, size, waterLevel, heights (Float32Array n*n, decoded), outer { n, cell, minX, minZ, heights }, surface (Uint8Array). The splat / fields PNGs are optional at runtime: accept an optional decodeImage(arrayBuffer) → { data: Uint8Array RGBA, width, height } in options (world.node.js provides one based on sharp; the browser renderer loads the PNGs as textures itself and may also pass a canvas-based decoder).
     heightAt(x, z) → terrain height (bilinear on the inner grid; outside the inner square fall back to the outer grid), normalAt(x, z, out) → unit normal, slopeAt(x, z) → radians,
     surfaceAt(x, z) → Surface id of the terrain (never ASPHALT),
     groundAt(x, z, hintS, out) → { y, surface, onRoad, s, d }: the drivable surface: the road surface (ASPHALT) when within the pavement, else the terrain,
     fieldsAt(x, z, out) → { forest, meadow, wetness, roadDistance } when the fields map is loaded,
     inBounds(x, z, margin).
5) tests/sim/world.test.mjs (uses the baked files; skips with a clear message if they are missing): no NaN / infinity; for >= 5000 random pavement points the terrain is within [road - 0.6, road - 0.05]; just outside the pavement edge (+0.3 m) the terrain is within 0.12 m of the road-edge height; cut / fill slope limits hold on sampled cross-sections; no terrain inside the pavement footprint of ANY road section rises above that section (hairpin legs); lake cells are under water; heightAt is continuous; inner / outer grids agree at the border; surface ids are valid.
LOOK at your debug renders critically, both as a landscape artist and as a road engineer, and iterate: the valley must look like a real eroded alpine landscape and the road must look engineered into it. Report: timings, file sizes, statistics (height range, slope histogram, biome coverage in %, maximum cut / fill), image paths, and the exact semantics of every baked file and channel.
`

const B3 = `TASK B3 - PHYSICS WORLD + VEHICLE DYNAMICS.   Prefix: vehicle.   Your files: src/sim/physics.js, src/sim/vehicle.js, src/sim/vehicleConfig.js, src/sim/tire.js (optional split), tools/sim-vehicle.mjs, tests/sim/physics.test.mjs, tests/sim/vehicle.test.mjs.

WORK ALREADY STARTED - READ THIS FIRST: a previous engineer was interrupted while working on this task. src/sim/physics.js (about 680 lines) and tests/sim/physics.test.mjs (about 470 lines) exist, and their Rapier experiments are in ${SP}/sim/vehicle/probe1.mjs .. probe5.mjs (read them: they record verified facts about the heightfield layout, ray casting and contact events of this Rapier version). When they stopped, one physics test was failing: 'landing impulse 33211 vs momentum 6289' - the contact impulse reported for a dropped body was about 5x the body's momentum, so either the impulse accumulation in the event handling / drainImpacts over-counts (for example summing contact-force events over several steps or sub-steps, or using force where impulse is expected) or the test's expectation is wrong. Treat physics.js as an unreviewed draft that you now own: review it critically against the specification below, fix it, get every physics test green, then build the vehicle. vehicleConfig.js, vehicle.js, tools/sim-vehicle.mjs and tests/sim/vehicle.test.mjs do not exist yet. Build the vehicle in stages and keep it running at every stage: (1) chassis + suspension resting on flat ground, (2) tire forces + steering + brakes, (3) drivetrain, (4) aero + assists, (5) telemetry + robustness, (6) tuning against the acceptance table.

1) src/sim/physics.js - a thin, well-tested wrapper around Rapier (import RAPIER from '@dimforge/rapier3d-compat'; in Node: await RAPIER.init()). Verify every Rapier API detail against the installed package (node_modules/@dimforge/rapier3d-compat/*.d.ts) instead of trusting memory - especially the heightfield layout and orientation (which index runs along x vs z, row- vs column-major, where its origin is), castRay / castRayAndGetNormal signatures and filter arguments, collision and contact-force events, and the mass-properties API.
   export async function loadRapier()                        // idempotent init → RAPIER
   export class PhysicsWorld {
     constructor(RAPIER, { dt = PHYSICS_DT, gravity = -GRAVITY } = {})
     addHeightfield({ heights /* Float32Array n*n, row-major, index = iz*n + ix */, n, cell, minX, minZ, kind = 'terrain' })
     addTriMesh({ positions, indices, kind = 'road' })
     addStaticBox({ center, halfExtents, quaternion, kind }) ; addStaticCylinder({ center, radius, halfHeight, quaternion, kind }) ; addStaticHull({ points, position, quaternion, scale, kind })
     addDynamicBody({ shape: { type: 'box' | 'cylinder' | 'hull', ... }, position, quaternion, mass, friction, restitution, kind = 'prop', userData }) → handle { body, collider, kind, userData }   // knock-over props
     setSurfaceQuery(fn)           // fn(x, z) → Surface id for ray hits on 'terrain' colliders; hits on 'road' colliders are ASPHALT
     raycast(ox, oy, oz, dx, dy, dz, maxDist, excludeBody) → null | hit    // hit is a REUSED object { distance, point: [x,y,z], normal: [x,y,z], kind, surface, collider }
     step()                         // advance by dt and gather contact events
     drainImpacts(body, out)        // ImpactEvent[] (types.js) for that body since the last drain
     dynamicBodies                  // array of the handle objects (the renderer reads body.translation() / rotation())
     dispose()
   }
   tests/sim/physics.test.mjs must prove: heightfield orientation and scale (build one from an asymmetric analytic function such as h = 0.1*x + 0.03*z + 2*sin(x/7) on an extent with minX != minZ, cast 500 rays downward at random points and compare with the analytic height within the triangulation error), trimesh raycasts, kinds / surfaces of hits, a dropped dynamic box comes to rest on the heightfield at the right height, impact events fire with sensible impulses, and determinism (the same 5 s simulation twice gives identical final state).

2) src/sim/vehicleConfig.js - export const SPORTS_CAR = { ... }: every tunable number of the car with units in comments. Geometry in one sub-object (wheelbase 2.65, front track 1.67, rear track 1.61, wheel radius 0.358, wheel width, body box, centre of mass) because it will later be overwritten from the measured 3D model (provide export function applyModelGeometry(config, measured)). Mass 1480 kg, inertia tensor, suspension, tires, engine torque-curve table, gear ratios [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69] with a final drive chosen to hit the top-speed target, reverse, brakes, aero, assists.

3) src/sim/vehicle.js - export class Vehicle:
     constructor(physics /* PhysicsWorld */, config = SPORTS_CAR)
     reset(pose /* SpawnPose */, speed = 0)      // place the car on the ground at static ride height, wheels spinning to match the speed, every internal state cleared
     step(input /* VehicleInput */)              // compute and apply all forces for one fixed step; call BEFORE physics.step()
     afterStep()                                 // read the body back and update VehicleState; call AFTER physics.step()
     state                                       // VehicleState (types.js), arrays reused between steps
     setAssists({ abs, tc, stability, steerAssist, autoGearbox }) ; setWetness(w /* 0..1 */) ; setAnalogSteering(bool)
     body                                        // the Rapier rigid body
   Requirements - a custom raycast-wheel model on ONE dynamic rigid body. Do NOT use Rapier's DynamicRayCastVehicleController (we need our own tire model):
   - Chassis collider(s) approximating the body shell with ~0.11 m ground clearance (must not touch a flat road at rest or at full suspension compression on a smooth road); explicit mass, centre of mass (height ~0.42-0.46 m, 42 / 58 front / rear weight distribution) and inertia through Rapier's mass-properties API; low friction and restitution on the shell so wall contact scrubs speed without wild bounces.
   - Four wheels: a ray (consider 2-3 rays or a short shape-cast across the tread for robustness on kerbs and edges) from the suspension top mount along the chassis -Y; spring + separate bump / rebound damping + progressive bump stop; anti-roll bars front and rear; ride frequency ~2.0-2.6 Hz, damping ratio ~0.6-0.8.
   - Tire forces at the contact patch from a slip-based model: Pacejka-style normalized curves for longitudinal and lateral slip combined through the friction ellipse / similarity method, load sensitivity (grip coefficient falls with load), camber ignored; surface properties from SURFACES[surface] (grip, slipPeakScale, rolling, drag, bump) blended with wetness; peak mu on dry asphalt ~1.25-1.35. Proper low-speed behaviour: no jitter, no creeping at standstill, holds on a 15 % slope with brake or handbrake, stops cleanly (relaxation lengths and / or a blended static-friction model below ~2-3 m/s).
   - Wheel rotation integrated per wheel (inertia ~1.2-1.6 kg m^2) with a scheme that is stable at 120 Hz (implicit / analytic slip relaxation or internal sub-steps).
   - Drivetrain: engine torque curve (naturally aspirated V8: ~540 Nm peak near 6000 rpm, ~420 kW near 8500-9000 rpm, idle 950, limiter 9000), throttle map, engine braking, engine inertia + clutch model adequate for launches (never stalls, controlled slip), 7-speed gearbox + final drive, automatic shifting without hunting (hysteresis, kick-down, holds the gear in hard cornering), manual mode via shiftUp / shiftDown, 60-120 ms shifts with torque cut, reverse (automatic: holding the brake at standstill selects reverse and the brake input then acts as reverse throttle; throttle while rolling backward brakes and then selects 1st). Rear-wheel drive with a limited-slip differential.
   - Brakes with ~62 % front bias and ABS; the handbrake locks the rear wheels.
   - Aerodynamic drag and downforce (CdA ~0.72 m^2, ClA ~0.9-1.1 m^2 split 40 / 60 front / rear).
   - Driver aids designed for KEYBOARD (digital) input: speed-dependent steering rate and return smoothing, speed-dependent steering lock (full lock at 200 km/h should ask for about the peak-grip slip angle, not 35 degrees), counter-steer assistance when the rear slides, traction control, light stability control; an analog mode with minimal smoothing. All switchable.
   - Telemetry: fill every field of VehicleState in afterStep() (per-wheel skid intensity, impacts via physics.drainImpacts, lightly filtered g-forces ...).
   - Robustness: never NaN; forces clamped; airborne wheels handled; lands from a 1.5 m drop and from a 15 m long jump without exploding or flipping unrealistically. Self-righting is not your job (the game resets the car).
4) tools/sim-vehicle.mjs - a maneuver-runner CLI (a flat heightfield world plus optional ramps / bumps / kerbs built with PhysicsWorld) that prints a metrics table and can write PNG charts (speed / rpm / gear vs time, g-g diagram, steer angle vs lateral g) via sharp + SVG to a given directory. Maneuvers: launch (0-100, 0-200, standing 400 m), top speed, braking 100-0 and 200-0, steady-state skidpads at R = 50 m and R = 150 m (max lateral g; understeer gradient), step steer at 100 and 180 km/h (yaw-rate rise time, overshoot, settling), lift-off mid-corner, power-on in 2nd gear in a tight corner with TC off (controllable power oversteer, not an instant spin), handbrake turn at 60 km/h (rotates >= 60 degrees, then recovers), straight-line stability at 300 km/h (lateral deviation < 0.3 m over 5 s with zero steer), a slalom driven with digital inputs like a keyboard player (no spin with assists on), standstill hold on a 15 % slope, a 5 cm kerb at 100 km/h, grass and gravel behaviour (less grip, still drivable back onto the road), wet asphalt.
   ACCEPTANCE TARGETS (tune until met; report the measured table): 0-100 km/h in 3.2-3.9 s; 0-200 km/h in 10-12.5 s; top speed 305-335 km/h; 100-0 km/h in 31-37 m; 200-0 km/h in 125-150 m; skidpad R = 50 m: 1.20-1.35 g; mild understeer at the limit with assists on, neutral to slight oversteer on power; step-steer overshoot < 25 % and settled within 1 s; no sustained oscillation in any test with assists on; keyboard-style driving is forgiving: full throttle plus full-lock steering taps below 150 km/h do not instantly spin the car with assists on.
   tests/sim/vehicle.test.mjs encodes the key acceptance targets as assertions (total runtime < 60 s).
Think like a vehicle-dynamics engineer AND a game-feel designer: the car should feel planted and precise up to the limit, rotate willingly on turn-in and on throttle, give clear warning before it lets go, and never do anything a real car would not.
`

const B5 = `TASK B5 - ADVERSARIAL VERIFICATION AND HARDENING OF THE VEHICLE DYNAMICS.   Prefix: vehverify.   The files src/sim/physics.js, src/sim/vehicle.js, src/sim/vehicleConfig.js, src/sim/tire.js (if present), tools/sim-vehicle.mjs, tests/sim/physics.test.mjs, tests/sim/vehicle.test.mjs were just written by another agent (its report is appended below). They are now YOURS. Do not trust the report - try to break the implementation, then fix what you find.

Check and attack:
 - Physical correctness by code reading: units, the sign and axis conventions of src/sim/constants.js and src/sim/types.js (forward = -Z, yaw positive = left, steer input +1 = right, wheel order, latG / yawRate / slipAngle / latForce signs, wheel spin sign), where forces are applied, double counting (gravity, damping), energy sources (anything that can add energy: tire model at low speed, clutch, bump stops), frame-rate dependence.
 - Time-step sensitivity: run the acceptance maneuvers at 60, 120 and 240 Hz physics; key metrics must agree within a few percent and nothing may go unstable at 120 Hz.
 - Numerical robustness fuzzing: minutes of simulated driving with random and adversarial inputs (full-lock flicks, throttle / brake stabs, handbrake abuse, reverse at speed, shifting spam) on bumpy heightfields with ramps, kerbs, walls and loose surfaces: never NaN, never tunnelling through the ground, never absurd speeds or spin rates, no perpetual bouncing, no drifting at rest (10 s at standstill: position change < 1 cm, also on a 15 % slope with the handbrake).
 - Exploits a player would find: speed gain from steering wiggles or wall riding, handbrake / gear tricks that accelerate the car, curb launches, landing glitches.
 - Gearbox / clutch state machine: hunting, wrong gear after reset(speed), reverse logic, limiter behaviour, launch quality (wheelspin controllable with TC on and off).
 - Telemetry: every VehicleState / WheelState field has the right meaning, sign, units and is refreshed each step; arrays are reused; impacts are reported once.
 - Feel with keyboard-like digital inputs: script realistic key sequences (tap-steering through a slalom, a late-braking hairpin with trail-off, lift-off mid-corner, a power slide and its recovery) and check the car stays controllable and communicative; improve the assists if not. With assists OFF the car must still be drivable by a careful driver.
 - Performance: time 60 s of simulated driving in Node; report microseconds per vehicle step and per physics step; remove allocations from the per-step path.
Fix defects directly, add a regression test for each, re-run the full acceptance table (tools/sim-vehicle.mjs) and the test files, and report: the defects found (with evidence), the fixes, and the final measured table versus the acceptance targets given in the original task (0-100 km/h 3.2-3.9 s; 0-200 km/h 10-12.5 s; top speed 305-335 km/h; 100-0 km/h 31-37 m; 200-0 km/h 125-150 m; skidpad R = 50 m 1.20-1.35 g; step-steer overshoot < 25 %, settled within 1 s; no sustained oscillation; forgiving keyboard driving).
`

const B4 = `TASK B4 - AI DRIVER, RACE LOGIC, GHOSTS, INTEGRATION AND BAKED RIVALS.   Prefix: race.   Your files: src/sim/session.js, src/sim/race.js, src/sim/ghost.js, src/sim/autopilot.js, tools/sim-lap.mjs, tools/bake-ghosts.mjs, tests/sim/race.test.mjs, tests/sim/lap.test.mjs, and the outputs public/assets/world/ghost_*.bin + public/assets/world/ghosts.json.
Inputs finished by other agents (read their code; their reports are appended below): Track (src/sim/track.js, src/sim/layout.js), World + baked data (src/sim/world.js, src/sim/world.node.js, public/assets/world/), src/sim/roadGeometry.js, PhysicsWorld + Vehicle (src/sim/physics.js, src/sim/vehicle.js, src/sim/vehicleConfig.js).

1) src/sim/session.js - the single place that assembles a drivable simulation from a World (used by the game and by the Node tools):
   export async function createSimulation(world, { wetness = 0, vehicleConfig } = {}) → sim object { physics, vehicle, world, track, dt, step(input), addObstacles(list), ... }
   - builds the PhysicsWorld: terrain heightfield from world.heights, the road tri-mesh from buildRoadRibbon, the surface query from world.surfaceAt;
   - addObstacles(list): colliders for trees, rocks, props and guard rails that the game adds later. Define and document the descriptor format, e.g. { type: 'cylinder' | 'box' | 'hull', position, quaternion, ...shape, kind: 'tree' | 'rock' | 'rail' | 'prop', dynamic?: boolean, mass? } ; returns handles for the dynamic ones;
   - step(input): vehicle.step(input); physics.step(); vehicle.afterStep(). No rendering concepts.
2) src/sim/race.js - export class RaceSession: pure logic over the track + the vehicle state, emitting events through an Emitter (src/core/events.js):
   rolling start from track.gridS; phases 'grid' (car waiting; the caller runs the 3-2-1 countdown and then calls start()), 'outlap' (until the line is crossed for the first time), 'lap' (continuous timed laps);
   lap timing with sub-step interpolation of the exact line-crossing instant (lap times accurate to ~1 ms rather than quantised to 1/120 s); checkpoints (track.checkpoints) that must be passed in order for a lap to count; 3 sectors with times and best-sector tracking; wrong-way detection (driving against the direction for > 1.5 s); off-track detection (all four wheels beyond the shoulder); stuck / upside-down detection that recommends a reset; resetPose() → SpawnPose at the last passed checkpoint (the caller teleports the car; a reset costs time naturally because the car restarts from standstill); continuous progress (s, lap fraction), current lap time, last lap, session-best lap, lap counter, validity flag with reason.
   Events: 'phase', 'lapStart' { lap }, 'checkpoint' { index, time }, 'sector' { index, time, best, delta }, 'lapComplete' { lap, time, valid, sectors, isSessionBest }, 'wrongWay' { active }, 'offTrack' { active }, 'invalidated' { reason }, 'needsReset' { reason }.
3) src/sim/ghost.js - recording and playback of laps:
   GhostRecorder: sample(lapTime, vehicleState, s) at 30 Hz into compact typed arrays (position, orientation, steer angle, speed, rpm, gear, throttle / brake, wheel compression if cheap); finish(lapTime) → GhostLap.
   encodeGhost(lap) → Uint8Array (quantised, little-endian, versioned header; a 2-minute lap should be well under 60 KB), decodeGhost(bytes) → GhostLap, plus base64 helpers for localStorage.
   GhostPlayer(lap): poseAt(t, out) → interpolated { position, quaternion, steer, speed, rpm, gear, braking, wheelSpin } (smooth at 120 fps: Hermite position using the recorded velocities, slerp orientation); timeAtS(s) → the lap time at which the ghost reached track distance s (monotonic lookup for the live delta: delta = myLapTime - ghost.timeAtS(myS)); duration.
4) src/sim/autopilot.js - export class Autopilot: an AI driver producing a VehicleInput from the VehicleState on any Track (no hand-written per-corner data):
   constructor(track, vehicleConfig, { skill = 1.0 /* about 0.7 .. 1.05 */, wetness = 0 })
   - precomputes a racing line: the lateral offset d(s) that minimises curvature inside the pavement minus a safety margin (iterative optimisation / elastic band; late apexes welcome) and a speed profile v(s) from the line's curvature, grade, banking and speed-dependent grip (downforce), with a forward (traction-limited) and a backward (braking-limited) pass; skill scales grip usage, braking aggressiveness and how much of the road is used;
   - update(vehicleState, dt) → VehicleInput: preview-point steering (pure pursuit / Stanley with curvature feed-forward), throttle / brake tracking of v(s) with trail braking, traction awareness (eases the throttle when the rear slips), recovery (off the line or off the road: slow down and rejoin; stuck: reverse out); deterministic;
   - exposes the line and the speed profile (typed arrays per track sample) for debugging and the HUD.
5) tools/sim-lap.mjs - CLI: loads the baked world (src/sim/world.node.js), creates the simulation, lets the Autopilot drive N laps from the rolling start; prints per-lap and per-sector times, top speed, minimum corner speeds, max g, off-pavement time, wall impacts, steering smoothness; writes PNG charts (actual speed vs the target profile over s, the racing line drawn on the map - reuse tools/render-map.mjs, g-g diagram) into a directory. Use it to tune the AI and to judge the track + car together; LOOK at the charts.
6) tools/bake-ghosts.mjs - runs three AI skill levels to clean flying laps and writes public/assets/world/ghost_bronze.bin, ghost_silver.bin, ghost_gold.bin, the wet variants ghost_*_wet.bin (wetness 1) and ghosts.json: { trackLength, dry: { bronze: { file, time, sectors }, silver, gold }, wet: { ... } }. Choose the skills so that the times are meaningfully spaced: gold = the AI's best clean lap (a good human with practice can beat it by 1-3 %), silver about 5-6 % slower than gold, bronze about 12-14 % slower. Replayed laps must look human-plausible: smooth steering, no wall contact, sensible use of the road width.
7) Tests: tests/sim/race.test.mjs (line-crossing interpolation accuracy with a synthetic constant-speed state, checkpoint-order enforcement, wrong-way, reset pose, ghost encode / decode round-trip error bounds, timeAtS monotonicity, live-delta sanity) and tests/sim/lap.test.mjs (slow test: the gold autopilot completes 2 consecutive laps with zero wall impacts and < 1 s off the pavement, lap time inside a sane window; < 90 s wall clock).
Report: lap times (dry / wet, three skills) with sectors, top speed on the lakeside straight, the slowest corner speed, a per-corner table (name, entry speed, minimum speed), simulation performance (ms per physics step in Node), chart paths, and every problem you found in the track, terrain or vehicle with evidence. If a defect in those blocks clean laps and the fix is obvious and local, fix it in place (re-bake with node tools/bake-world.mjs if the layout changed, and keep the other agents' tests green) and report exactly what you changed; otherwise report it.
`

const rep = (title, r) => `\n\n--- REPORT: ${title} ---\n` + JSON.stringify(r, null, 1)

const E = { effort: 'high' }

const trackChain = async () => {
  const t1 = await agent(CTX + T1, { label: 'sim:track-core', phase: 'Track core', schema: REPORT, ...E })
  if (!t1) throw new Error('track core agent failed')
  const t2 = await agent(CTX + T2 + rep('T1 track core', t1), { label: 'sim:circuit-design', phase: 'Design', schema: REPORT, ...E })
  if (!t2) throw new Error('circuit design agent failed')
  const b6 = await agent(CTX + B6 + rep('T1 track core', t1) + rep('T2 circuit design', t2), { label: 'sim:track-review', phase: 'Track review', schema: REPORT, ...E })
  const b2 = await agent(CTX + B2 + rep('T1 track core', t1) + rep('T2 circuit design', t2) + rep('B6 track review (final state of the track files)', b6), { label: 'sim:terrain-bake', phase: 'Bake', schema: REPORT, ...E })
  return { t1, t2, b6, b2 }
}

const vehicleChain = async () => {
  const b3 = await agent(CTX + B3, { label: 'sim:vehicle', phase: 'Vehicle', schema: REPORT, ...E })
  if (!b3) throw new Error('vehicle agent failed')
  const b5 = await agent(CTX + B5 + rep('B3 vehicle', b3), { label: 'sim:vehicle-verify', phase: 'Vehicle verify', schema: REPORT, ...E })
  return { b3, b5 }
}

const [t, v] = await parallel([trackChain, vehicleChain])
if (!t || !v) {
  log('A chain failed: track=' + !!t + ' vehicle=' + !!v)
  return { track: t, vehicle: v, race: null }
}

const b4 = await agent(
  CTX + B4 + rep('T1 track core', t.t1) + rep('T2 circuit design', t.t2) + rep('B6 track review', t.b6) + rep('B2 terrain bake + World', t.b2) + rep('B3 vehicle', v.b3) + rep('B5 vehicle verification (final state)', v.b5),
  { label: 'sim:ai-race-ghosts', phase: 'AI + race', schema: REPORT, ...E }
)

return { track: t, vehicle: v, race: b4 }
