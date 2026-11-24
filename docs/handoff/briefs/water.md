# System brief: WATER
Module `src/gfx/water.js` → `export async function createWater( ctx )`, key `water`. Prefix: `water`.
Owner files: `src/gfx/water.js` (+ `src/gfx/water/*.js`), `dev/water-*.html`.

## Purpose
The alpine lake (surface at `ctx.world.waterLevel`; the bed is part of the terrain heights) - the visual centrepiece beside
the fastest straight.

## Requirements
- Surface mesh only where it can be seen: derive the lake outline from the height data (terrain height < waterLevel +
  margin), with detail concentrated near the shore; no kilometres of hidden water under the terrain.
- Look: wind-driven ripples (2-3 scrolling normal layers at different scales + a subtle large swell; direction from
  uWindDirection, strength from uWindStrength; calmer mirror-like patches in the lee of the shore are a plus), Fresnel
  reflection of sky and landscape, a sun glitter path, depth-based colour and clarity computed analytically from the terrain
  height texture (`ctx.worldTex.heightAt`: depth = waterLevel - terrain height): clear shallows showing the pebble bed
  grading to deep blue-green; a soft shoreline (no hard polygon edge where water meets land), a subtle wet-sand darkening /
  foam line at the shore.
- Reflections: mountains and trees mirrored in the lake are what makes alpine lakes look real. Evaluate the options under
  r187 (crib + examples: the `reflector()` TSL node, WaterMesh / Water2Mesh, screen-space reflections from the post system)
  and implement the best: on high / ultra a planar reflection (reduced resolution, simplified content - no grass, particles
  or small props: use a layer and document it) distorted by the ripple normals; on low / medium environment reflection only.
  The reflection must fade gracefully at the horizon and must never show the underside of the terrain.
- Overcast: duller, wind-ruffled. Dusk: dark water with sky glow.
- Stable under temporal anti-aliasing; writes sensible depth for fog; no shimmering at distance (fade normal intensity with
  distance, use mips).
- Budget on high: <= 0.7 ms for the surface, <= ~1.5 ms for the planar reflection pass (measure both).

## API
`{ update( frame ), dispose(), reflectionLayer (if used: which layer objects must enable to appear in the reflection) }`

## Verification (systems=environment,terrain,water[,scatter])
From the lakeside straight at chase height looking along and across the lake; from the ridge looking down; a shoreline
close-up; all four presets; a short frame sequence to check ripple animation and reflection stability.
