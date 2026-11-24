# System brief: GRASS + WILDFLOWERS
Module `src/gfx/grass.js` → `export async function createGrass( ctx )`, key `grass`. Prefix: `grass`.
Owner files: `src/gfx/grass.js` (+ `src/gfx/grass/*.js`), `dev/grass-*.html`.

## Purpose
Ground cover near the camera - the difference between a textured plane and a meadow. GPU-driven: no per-frame CPU work
proportional to the blade count.

## Inputs
`ctx.assets.index.plants` (grass clump and flower variants with LODs and colours - read the PLANTS notes); `ctx.worldTex`
(heightAt, normalAt, splat0At = (grass_meadow, grass_dry, forest_floor, dirt), splat1At, fieldsAt = (forest, meadow /
flower density, wetness, road distance), maskAt, groundTintAt); uniforms uWindDirection, uWindStrength, uTime,
uCarPosition, uCarVelocity.

## Technique
Instanced clumps on a camera-centred toroidal grid: instance index → cell → hashed jitter → world xz, snapped so instances
are stable in world space while the camera moves. Everything else happens in the vertex stage: height and normal from the
height texture; density, type and size from the biome weights (lush tall grass and flowers in grass_meadow, short dry tufts in
grass_dry, sparse on forest_floor, nothing on rock / gravel / shore / road / masked areas - scale to zero to cull);
distance-based thinning and scale-out at the ring edge (no visible moving boundary); 2-3 concentric bands with decreasing
density and simpler geometry (far band: single crossed cards); wind as gust waves travelling across the meadow in the wind
direction with per-clump phase; bending away from the car and lying flat in its wake.

## Shading
Grass must sit IN the terrain: the base colour blends to `ctx.worldTex.groundTintAt` at the roots and with distance (far
grass merges into the terrain texture); tip colour variation per clump (hue / dryness from noise + the wetness field);
normals bent toward the terrain normal for soft lighting; translucency toward the sun (a backlit rim at golden hour); no
specular sparkle; alpha test with stable mips (mip-scaled alpha or hashed dither working with temporal AA). Receives the
cascaded shadows; casting is optional (near band on ultra only).
Flowers: sparse natural patches following the meadow field (not uniform confetti), 3-4 colours, visible to ~40 m.

## Budget
High: <= 1.5 ms, <= ~1.3 M triangles, <= 8 draw calls, view range ~110-130 m. Tiers scale density and range (low: ~35 m, sparse).

## API
`{ update( frame ), dispose() }`

## Verification (systems=environment,terrain,road,grass[,scatter])
Chase-height views on the lakeside meadow, the ridge and a forest edge; a low grazing shot across a meadow toward the sun;
the road edge (grass must stop cleanly at the gravel shoulder); a top-down shot to check density patterns (no grid
artifacts); a frame sequence while moving to check ring-edge stability; all presets. Compare with photographs of alpine
meadows: colour and density must be natural.
