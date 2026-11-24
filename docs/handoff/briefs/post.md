# System brief: POST-PROCESSING / RENDER PIPELINE
Module `src/gfx/post.js` → `export async function createPost( ctx )`, key `post`. Prefix: `post`.
Owner files: `src/gfx/post.js` (+ `src/gfx/post/*.js`), `dev/post-*.html`.

## Purpose
You own the final image: the Game calls `post.render( frame )` instead of `renderer.render`. Build a `THREE.RenderPipeline`
that turns a correct scene into a photograph: grounded contact shading, bounce light, reflections on wet asphalt and paint,
filmic tone and colour, stable anti-aliasing, tasteful lens character. Everything must be justified by realism - no
"Instagram filter" look, no heavy vignette, no over-bloom.

## Inputs
`ctx.renderer` (WebGPURenderer, reversed depth, no MSAA), `ctx.scene`, `ctx.camera`, `ctx.quality` (tier, pixelRatio),
`ctx.sky` (+ 'sky:changed': exposure / mood per preset, sunDirection for flare / glare), `ctx.settings` (`motionBlur`,
`renderScale`; listen to 'settings:change'), `frame.phase` ('photo' → depth of field from `ctx.systems.cameraRig?.photo`),
LUTs in `ctx.assets.index.textures.fx`. Study the crib's post-processing section and the official examples
(webgpu_postprocessing_*.html): GTAO, SSGI, SSR, TRAA / TAAU, bloom, motion blur, DOF, lens flare, film, LUT, sharpen.

## Pipeline (by tier; measure everything, the numbers decide)
- Scene pass with MRT (colour, depth, normal, velocity, + metalness / roughness where SSR needs them).
- Ambient occlusion / global illumination: `high` → GTAO (tuned radius for both car-scale contact and tree-scale occlusion,
  denoised, half resolution if needed); `ultra` → SSGI (AO + one-bounce colour bleeding) if it holds 60 fps at 1600x900
  on this machine, else GTAO + a cheaper bounce approximation; `medium` → GTAO half-res; `low` → off.
  AO must affect indirect light, not kill direct sunlight (composite correctly).
- Screen-space reflections on `high` / `ultra`: wet asphalt, puddles, car paint, glass. Roughness-aware, faded at screen
  edges and with distance, no fireflies; when the road is dry the effect must be nearly free (roughness cut-off).
- Temporal anti-aliasing: TRAA on `high` / `ultra` (thin foliage, grass, rails and distant trees must be stable in motion;
  minimal ghosting behind the car and on swaying vegetation); `medium` / `low`: TAAU temporal upscaling from a reduced
  internal resolution (or FXAA / SMAA on low if temporal is too costly) - choose from measurements.
- Bloom: threshold-less energy-conserving style, subtle: sun glints on paint and water, tail lights, headlights at dusk, sky
  near the sun. Motion blur: camera + object, shutter ~ 180° equivalent scaled by the `motionBlur` setting, disabled in photo
  mode; it should make 250 km/h feel fast without smearing the car.
- Depth of field: only in photo mode (aperture / focus from the camera rig) and a very gentle cinematic one in the menu's
  attract mode.
- Lens: sun glare / flare when the sun is in view (occluded by terrain and objects - use depth), very subtle chromatic
  aberration and vignette, optional lens dirt lit by the sun at golden hour, fine film grain; all restrained.
- Tone mapping + grade: pick the tone mapper that looks most photographic for this content (AgX or ACES; decide by
  comparing the four presets side by side) and set `renderer.toneMapping` accordingly BEFORE the environment system reads
  it (you are created after it: if you change the tone mapper, call `ctx.systems.environment?.setPreset( ctx.sky.id )` or
  apply `ctx.sky.meta.exposure` yourself - coordinate through documented API only). Per-preset grade (white balance,
  contrast, saturation; golden hour warm and rich, noon neutral and crisp, overcast soft and cool with deep wet blacks, dusk
  blue with warm lights) through a compact parametric grade or LUTs. Output must not clip highlights harshly or crush
  shadows; check histograms of your screenshots.
- Sharpening after temporal AA (mild). Final dithering against banding in the sky.
- Dynamic resolution: watch the frame time; when it stays above ~17.5 ms lower the internal scene resolution in steps (down
  to 0.6 x), raise it again when comfortably below ~14 ms; never oscillate visibly.
- Runtime toggles without rebuilding everything where possible; rebuild on tier / size change. Handle `resize`.
- Pre-compile: no hitch when effects first become active (e.g. first wet reflection, first photo mode).

## API
`{ render( frame ), resize( w, h, pixelRatio ), setEnabled( name, on ), info() → { scale, passes, ... }, dispose() }`

## Budget
`high`: <= 3.5 ms for the whole post chain at 2400x1350 rendered pixels (1600x900 CSS at pixelRatio 1.5).

## Verification
Until the real scene systems exist, test on `dev/post-test.html` with a representative stand-in scene (car model on a wet /
dry PBR ground with poles, foliage cards and distant geometry). Then on the real game (`systems=all&sim=1`): A/B shots for
every effect (on / off) at the same camera, all four presets, a motion sequence at speed (ghosting, blur), the car close-up
(AO grounding, reflections), a vista (haze + bloom + grade), photo-mode DOF. Report a per-effect cost table per tier
(measured with `__game.stats()` deltas) and the final frame time per tier.
