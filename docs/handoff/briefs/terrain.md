# System brief: TERRAIN
Module `src/gfx/terrain.js` → `export async function createTerrain( ctx )`, key `terrain`. Prefix: `terrain`.
Owner files: `src/gfx/terrain.js` (+ `src/gfx/terrain/*.js`), `tools/bake-terrain-textures.mjs` (optional offline packing),
`public/assets/terrain/` (outputs of that tool), `dev/terrain-*.html`.

## Purpose
The ground, from under the wheels to the horizon.

## Inputs
- `ctx.world`: `heights` (Float32Array n x n, 2 m grid, 1537²), `outer { n, cell, minX, minZ, heights }` (far ring, 48 m
  grid, ±12 km), `waterLevel`, `track`. Read the world-bake section of the notes for the exact semantics.
- `ctx.worldTex`: `heightAt / normalAt / splat0At / splat1At / fieldsAt / groundTintAt` (TSL) + the textures themselves.
  splat0 = (grass_meadow, grass_dry, forest_floor, dirt), splat1 = (gravel, rock_cliff, rock_ground, shore),
  fields = (forest density, meadow density, wetness, distance to pavement edge / 64 m).
- PBR sets from `ctx.assets.index.textures` (ids as above + `snow`; each albedo / normal (GL) / arm / height + tileSizeMeters).

## Geometry
- Inner square: where the car can drive, the surface must match the physics heightfield (LOD0 = the 2 m grid; use the same
  triangle diagonal as the Rapier heightfield if you can determine it from `src/sim/physics.js` - tyres must visibly touch
  the ground). Distance LOD without cracks (skirts or stitched borders) and without visible popping at 300 km/h
  (hysteresis; geomorph if needed); frustum-culled chunks. Under the road the terrain is intentionally 0.3 m below the
  pavement; the road system covers it.
- Far ring from `world.outer`: alpine peaks. It must join the inner square without a visible seam or gap (overlap + skirt)
  and must not z-fight with it.
- Budget on high: <= ~900 k terrain triangles in view, <= 60 draw calls, <= 2.0 ms.

## Material (TSL on a MeshStandardNodeMaterial) - this is where realism is won or lost
- 8 inner layers (+ snow on the far peaks) weighted by the baked splat maps, with crisp, natural transitions from
  height-map-based blending (not linear cross-fades) and a little noise along biome borders.
- More than 16 sampled textures per shader stage are impossible: pack the layers into 2D ARRAY textures (for example array A:
  albedo RGB + height in A; array B: normal XY + roughness + AO), built offline by `tools/bake-terrain-textures.mjs` into
  `public/assets/terrain/` (preferred: fast loading) or at load time. Mipmaps + anisotropy are essential (grazing angles).
  Tier-dependent resolution (high 2048, medium 1024, low 512).
- True real-world scale from tileSizeMeters. Kill visible tiling: blend every layer between a near scale and a much larger
  far scale by distance; add low-frequency macro colour / brightness variation (also driven by the wetness field: lusher,
  darker grass where water collects); far away fall back to the ground-tint colour (no noisy sparkle at 2 km+).
- Triplanar projection for rock_cliff on steep faces.
- Lighting normal = macro terrain normal derived PER PIXEL from the height texture (never from vertex normals of low LODs,
  so lighting does not pop with LOD) combined correctly with the layers' detail normals.
- Roughness / AO from the packed maps; wet look from uWetness (darker and glossier, strongest on dirt / gravel / rock).
- Far ring: rock, scree and alpine meadow by slope / altitude, forest-coloured lower slopes (convincing "distant forest"
  shading with slight noise), snow above ~1700 m with slope-dependent coverage. It is seen through 3-12 km of haze: prioritize
  shape-defining lighting over detail.
- Receives the cascaded shadows. Terrain self-shadowing from a low sun matters enormously at golden hour: beyond the
  cascade range and on the far ring apply a sun-visibility / horizon term computed once per sky preset from the height data
  (CPU or GPU bake, recomputed on 'sky:changed') - big realism win for distant slopes.
- After building, if you can compute a better per-area average of your final terrain colour, write it into
  `ctx.worldTex.groundTintData` and call `refreshGroundTint()` (grass and particles are tinted with it).

## API
`{ update( frame ), dispose(), ...documented helpers other systems could reuse }`

## Verification (systems=environment,terrain[,road])
Chase-camera height on the lakeside straight; in the hairpins looking up and down the slope; on the ridge looking across
the valley to the far peaks; a 1.5 m-high grazing close-up of each biome; a top-down overview from 1500 m; the inner / outer
seam; one vista in all four presets. Hunt for: tiling, blurry or noisy ground, harsh linear blends, LOD cracks or pops,
lighting discontinuities, the seam, shadow acne on slopes.
