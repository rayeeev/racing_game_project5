# System brief: PROPS / SET DRESSING
Module `src/gfx/props.js` → `export async function createProps( ctx )`, key `props`. Prefix: `props`.
Owner files: `src/gfx/props.js` (+ `src/gfx/props/*.js`), `src/sim/zones.js` (pure: designed locations derived from the
track / world), `dev/props-*.html`.

## Purpose
The human touches that turn a road into a believable place: a small paddock at the start / finish, tyre stacks and concrete
barriers at the hairpins, a pier on the lake, a lay-by with a covered car, power poles with wires along a section, a picnic
spot at the ridge viewpoint, a few cones. Uses `ctx.assets.index.props` (read the PROPS notes: variants, sizes, colliders,
dynamic flags, placement hints).

## Requirements
- `src/sim/zones.js`: `export function computeZones( track, world )` → named zones (position, yaw, dimensions) chosen
  procedurally from the layout: paddock (a level strip beside the start straight on the side away from the lake), lay-by,
  pier site on the shore near the straight, ridge viewpoint, run-off zones on the outside of each hairpin, the pole line.
  Validate every zone against the terrain (slope, height above water, distance to the pavement: never on the pavement or
  the shoulder, nothing on the racing line or its natural run-off path).
- Clear the ground for your zones in `ctx.worldTex` (`stampBox` / `stampCircle`) - scatter and grass are created after you
  and respect the mask.
- Placement is designed, not sprinkled: think like a set dresser. Props sit ON the terrain (`world.heightAt`, tilt with the
  normal where appropriate) with believable grouping and orientation. Poles: correct spacing along a road section, wires as
  catenary curves between the insulators (thin geometry, no shadow casting).
- Dynamic props (cones, tyres, barrels, crates): register through `ctx.addObstacles` with `dynamic: true` and their mass
  (returns handles when a simulation exists), then copy the physics transforms to the instances every frame. Static props
  register static colliders. Without a simulation (`ctx.sim === null`) render everything static.
- Instancing for repeated props; LOD1 beyond ~60 m; small props hidden beyond ~250 m. Budget: <= 40 draw calls,
  <= 250 k triangles in view, <= 0.4 ms.
- Night: the paddock flood lights emit light at dusk (a few SpotLights without shadows + emissive lamp heads, driven by uNight).

## API
`{ zones, update( frame ), dispose() }`

## Verification
Paddock overview + eye level; each hairpin's dressing; the pier seen from the road; the pole line; the viewpoint; a
drive-through check that nothing blocks the driving line and nothing floats or sinks; a dynamic test
(`systems=environment,terrain,road,props&sim=1`: teleport / drive the car into a tyre stack with the debug API and confirm
the tyres react and render where physics puts them); dusk with the flood lights.
