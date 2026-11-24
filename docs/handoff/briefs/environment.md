# System brief: ENVIRONMENT
Module `src/gfx/environment.js` → `export async function createEnvironment( ctx )`, key `environment`. Prefix: `env`.
Owner files: `src/gfx/environment.js` (+ `src/gfx/environment/*.js` if you split), `dev/env-*.html`.

## Purpose
Everything about light and air: the sky, the sun and its shadows, image-based lighting, fog / aerial perspective, exposure,
wind, and the wet / night state. Every other material relies on the scene lighting you set up and on the shared uniforms
you keep up to date. You are created FIRST; everybody else is judged under your light.

## Inputs
`ctx.assets.index.sky` = `public/assets/sky/presets.json`: per preset `files { sky, env, thumb }` and `meta` (sunDirection =
unit vector TOWARD the sun, valid for an equirect `scene.background` with no rotation; sunColor; sunIntensity; exposure
{ aces, agx }; zenith / horizon colours; fog hint; hasSun ...). Read the SKY section of the assets notes for the exact,
verified semantics (energy calibration: `env.hdr` has the sun removed and the DirectionalLight puts it back).

## Requirements
1. **Presets**: `async setPreset( id )`; initial preset = `ctx.settings.get( 'sky' )`. Background = `sky.hdr` (equirect),
   image-based lighting = `env.hdr`. Apply the exposure matching the active tone mapping (`renderer.toneMapping`: AgX by
   default → `meta.exposure.agx`; ACES → `.aces`) to `renderer.toneMappingExposure`, and the background / environment
   intensities. Dispose the previous preset's textures. Keep `ctx.sky` (id, sunDirection, sunColor = colour x intensity in
   linear RGB, hasSun, wetness, night, meta) and ALL lighting uniforms of `src/gfx/shared.js` (uSunDirection, uSunColor,
   uAmbientColor, uWetness, uNight, uFogColor, uFogSunColor, uFogDensity, uFogHeightFalloff, uWindDirection,
   uWindStrength) in sync, then `ctx.events.emit( 'sky:changed', ctx.sky )`.
   Conditions: golden → dry, day · noon → dry, day · overcast → wetness 1, day · dusk → dry, night 1.
   Expose `presets = [ { id, name, thumb, wet, night } ]` for the menu.
2. **Sun + cascaded shadows**: a DirectionalLight from the meta with `CSMShadowNode` (`three/addons/csm/CSMShadowNode.js`;
   study `webgpu_shadowmap_csm.html` and the crib). Per tier: cascades / map size / max distance (high: 4 cascades, 2048,
   ~320 m). Tune splits so the car and roadside objects near the camera get crisp contact shadows while the far cascade
   still carries tree and cliff shadows across the road. Stable under camera motion (no shimmering / swimming: texel
   snapping if the node does not do it), correct bias on steep terrain and on thin alpha-tested foliage, cascade blending.
   Presets without sun (overcast, dusk): no hard sun shadow - but the world must not look flat; a weak, very soft
   directional component from the brightest sky region is allowed if it looks right. Follow the camera every frame.
   Expose `sun` (the light) and `csm`.
3. **Fog / aerial perspective** as `scene.fogNode` (TSL): exponential height fog integrated analytically along the view
   ray; colour varies with the angle to the sun (uFogColor away from it → uFogSunColor toward it); density from the preset's
   fog hint. It must give depth to the valley - mountains 12 km away remain visible as hazy silhouettes on clear presets,
   the far shore of the lake is clearly softened - without washing out the foreground, and it must merge seamlessly with
   the horizon haze of the sky image (take colours from the meta). Check that it applies to every material type
   (standard, alpha-tested, transparent, sprites).
4. **Wind**: slowly varying gusts in uWindStrength (calm at golden hour, breezy at noon, gusty when overcast), prevailing
   direction with slight wander.
5. **Cloud shadows** for the partly cloudy presets (golden, noon) if r187 supports modulating a DirectionalLight in world
   space cleanly (e.g. `light.colorNode` / projected texture - check the source and examples): soft, large (100-400 m),
   slowly drifting. Skip if it needs hacks or costs more than ~0.2 ms.
6. **Night**: at dusk a subtle cool sky fill keeps silhouettes readable; headlights are the car system's job.

## API
`{ presets, current, setPreset( id ) → Promise, sun, csm, update( frame ), dispose() }`

## Verification
Until terrain / road / scatter exist, build `dev/env-test.html` (via `bootHarness`) with objects at 2 m .. 2 km (boxes,
spheres, an alpha-tested foliage card, a tall thin pole) on the harness fallback terrain. Shots for each preset: toward the
sun, away from the sun, across the valley from high up (fog depth), shadow close-ups at 3 m / 30 m / 150 m, and a
moving-camera sequence (frames 2 m apart) to check shadow stability. Report the frame cost of shadows (on vs off) per tier.
When other systems appear in the repo, re-shoot the real scene with them.
