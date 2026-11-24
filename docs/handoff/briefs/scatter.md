# System brief: SCATTER - trees, rocks, shrubs
Module `src/gfx/scatter.js` → `export async function createScatter( ctx )`, key `scatter`. Prefix: `scatter`.
Owner files: `src/gfx/scatter.js` (+ `src/gfx/scatter/*.js`), `src/sim/scatterPlacement.js` (pure deterministic placement),
`dev/scatter-*.html`. You may use and fix `src/gfx/lib/impostorMaterial.js` (written by the impostor asset engineer).

## Purpose
Clothe the world: conifer forest, saplings, dead wood, boulders, rock outcrops and cliff pieces, shrubs and ferns. Tens of
thousands of objects with LOD, impostors, wind and shadows inside a 3 ms budget.

## Inputs
`ctx.assets.index.trees / rocks / plants` (variants, LOD node names, sizes, colliders, impostor atlases - read the TREES,
IMPOSTORS, ROCKS and PLANTS notes); `ctx.world` (heightAt, normalAt, slopeAt, fieldsAt → forest density, meadow, wetness,
road distance; track); `ctx.worldTex` (vegetation mask: respect `maskValue`; stamp your big rocks and tree trunks so grass
does not grow through them).

## Placement - `src/sim/scatterPlacement.js` (pure + seeded: identical on every machine; fast enough to run at load, < 400 ms)
- Trees follow the baked forest density with natural structure: clumps and clearings, a dense interior and a sparse edge
  with saplings and shrubs, bigger trees further from the road; never closer than ~4.5 m to the pavement edge (thick trunks
  >= 6 m) so the run-off stays fair; random yaw, ±20 % scale variation, slight lean on slopes; altitude and slope limits; no
  trees on the shore, on cut slopes or in cleared zones (mask).
- Rocks: boulders at cliff bases and on scree (rock / gravel splat weights), occasional erratic boulders in meadows, cliff
  pieces dressed onto the steepest road cuts and outcrops (aligned with the slope, sunk per the notes), small stones around
  rocky areas; nothing within 3 m of the pavement.
- Shrubs / ferns / debris: forest edge, under trees, along wet lines, on scree.
- Output compact typed arrays per variant (x, y, z, yaw, scale, optional tilt) + bounds. Target counts on high: ~18-25 k
  trees inside the playable square, ~3-5 k rocks, ~10-15 k shrubs / ferns / debris (scaled by tier).

## Rendering
- Per variant and LOD an InstancedMesh (or equivalent) fed from per-cell instance lists (cells ~64 m): frustum culling per
  cell, LOD by distance with hysteresis and a dithered cross-fade (no visible popping at 250 km/h), impostors
  (`createImpostorMaterial`) beyond the LOD2 range out to >= 1.5 km, tiny objects culled early. No per-frame allocations;
  throttle rebuilds (camera moved > 2 m or turned); CPU time < 0.6 ms on average.
- Materials: convert the GLB materials to node materials. Foliage: alpha test that keeps density at distance (no
  alpha-to-coverage without MSAA: use hashed / dithered alpha or mip-scaled alpha with temporal AA), two-sided lighting with
  a translucency term so backlit needles glow toward a low sun, per-instance colour / brightness variation, slight
  ground-tint blending at the base. Bark and rock: PBR + moss / wetness response to uWetness; rocks blend into the ground
  (tint the bottom band with `ctx.worldTex.groundTintAt`) so they do not look pasted on.
- Wind in the vertex stage: trunk sway + branch flutter (phase from world position, amplitude from height above the pivot
  and uWindStrength), identical in the shadow pass.
- Shadows: trees and big rocks cast into the sun cascades without blowing the budget - cast from a cheap LOD within the
  cascade range (layers or shadow-only instances, whichever r187's CSM node supports: check how it selects casters). Long
  golden-hour tree shadows striping the road are a signature image of this game.
- Colliders via `ctx.addObstacles`: trunks as cylinders (kind 'tree') within ~120 m of the road, rocks with their hull /
  sphere colliders (kind 'rock').
- Budget on high: <= 3.0 ms GPU + CPU, <= ~1.8 M triangles in the main pass, <= 120 draw calls, shadow casters <= 600 k
  triangles per frame.

## API
`{ update( frame ), placement (counts + arrays, for debugging), dispose() }`

## Verification (systems=environment,terrain,road,scatter)
A forest section at chase height (both directions); forest edge + meadow; a hairpin cut with cliff pieces; the vista from the
ridge over forested slopes (impostor range); an LOD transition sequence (same view at several distances); backlit trees
toward the sun at golden hour; overcast; a 250 km/h drive-by frame sequence (autopilot or scripted camera along the track) to
check popping. Report draw calls, triangles and milliseconds.
