# System brief: ROAD
Module `src/gfx/road.js` → `export async function createRoad( ctx )`, key `road`. Prefix: `road`.
Owner files: `src/gfx/road.js` (+ `src/gfx/road/*.js`), `src/sim/roadside.js` (pure placement, shared with physics),
`dev/road-*.html`.

## Purpose
The road and its engineered furniture. The player looks at this surface 100 % of the time: it must read as real asphalt at
1 m and at 300 m, in every sky preset.

## Inputs
`ctx.track` (frames, widths, banking, curvature, sectors, checkpoints, corners); `buildRoadRibbon` / `offsetPolyline` from
`src/sim/roadGeometry.js` (the SAME ribbon the physics collider uses - use it for the pavement so the wheels touch what you
see); texture sets `asphalt_main`, `asphalt_worn`, `gravel`, `concrete`, `metal_galvanized`, `wood_weathered`; `ctx.worldTex`.

## Pavement material (TSL; MeshPhysicalNodeMaterial if you model the water film as a clearcoat)
- asphalt_main at true scale (uv: u across, v = s in meters) mixed with asphalt_worn patches, repairs and cracks through
  low-frequency masks; subtle darker rubbered-in lines along the typical driving line, heavier in braking zones and at
  apexes (derive from curvature / a speed heuristic along s); anti-tiling (two scales + macro variation).
- Painted markings generated in the shader from (u in meters, s): solid white edge lines, a dashed centre line (double solid
  through hairpins and over blind crests), the start / finish line as a chequered band at s = 0; realistic wear (broken
  edges, faded patches), paint slightly smoother than asphalt in roughness and visible in the normal.
- Wetness (uWetness): darker albedo, a low-roughness water film, puddles in ruts and low spots (noise + the worn-asphalt
  height); the post system adds screen-space reflections on top. The dry state must be properly matte with a soft sheen
  toward a low sun at grazing angles.
- The pavement must not end in a razor-straight polygon edge: an irregular, broken asphalt edge fading into the shoulder.

## Shoulder aprons
The baked terrain lies 0.3 m below the pavement underneath it and rises to road level at the pavement edge, followed by a
1.5 m gravel shoulder. Build apron strips on both sides (starting slightly under the pavement edge, reaching ~1.2 m outward,
following the terrain just above it), textured with the SAME gravel set and scale as the terrain's gravel layer, so there is
never a gap, step or hard seam between road and terrain at any terrain LOD. Verify at grazing angles all around the lap
(hairpins, crests, banked corners).

## Road furniture
Placement is computed in `src/sim/roadside.js` (pure, deterministic, Node-compatible: `export function computeRoadside(
track, world )` returning rails as polylines + post positions, delineators, signs, gantry pose ...), because physics needs the
same data: call `ctx.addObstacles( [...] )` from createRoad with boxes along the rail segments (kind 'rail'; the descriptor
format is documented in `src/sim/session.js`; when that file does not exist yet, follow `{ type: 'box', position,
quaternion, halfExtents, kind: 'rail' }`).
- Guard rails: galvanized W-beam on posts (every 4 m, 2 m in tight curves; proper end terminals), placed where a car leaving
  the road would fall or reach water: outside of corners with a drop, along the lake, the outer edge of switchbacks, crests
  with drops. Not along rock cuts or flat meadows. Extrude along offset polylines (few merged meshes), instance the posts.
  Real dimensions (beam centre ~0.55 m, top ~0.75 m, ~0.6 m outside the pavement edge).
- Delineator posts (white, ~1 m, reflector patches; 50 m apart on straights, 25 m in curves, where there is no rail);
  reflectors glow with uNight.
- Signs: chevron boards on the outside of the sharpest corners; brake-marker boards (150 / 100 / 50) before the hard braking
  zones (from curvature / speed heuristic, or from the autopilot speed profile if `src/sim/autopilot.js` exists); sector
  boards at the sector lines; a start / finish gantry over the road at s = 0 (truss or frame with a timing banner showing the
  game's name "ALPENGLOW" - original graphics only, no real-world brands or logos) with a light bar the countdown can drive:
  `setStartLights( state )` with state 0..3 (number of red lights on), 'green' or 'off'. Subscribe to the 'countdown' event
  yourself ({ n: 3, 2, 1, 0 }) to drive it.
- Everything merged / instanced: <= ~25 draw calls for the whole system; rails and signs cast shadows.

## API
`{ update( frame ), setStartLights( state ), roadside, dispose() }`

## Verification (systems=environment,terrain,road)
Chase-camera views every ~400 m around the lap (`s=` / `ls=`), grazing close-ups of markings and of the pavement edge, a
hairpin with rails, the start line with the gantry, the wet preset close-up + vista, dusk with reflectors. Hunt for: gaps to
the terrain, z-fighting, tiling, plastic look, floating posts, rails intersecting terrain or crossing the road.
