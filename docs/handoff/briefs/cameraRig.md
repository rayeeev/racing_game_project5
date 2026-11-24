# System brief: CAMERA RIG
Module `src/gfx/cameraRig.js` → `export async function createCameraRig( ctx )`, key `cameraRig`. Prefix: `cam`.
Owner files: `src/gfx/cameraRig.js` (+ `src/gfx/camera/*.js`), `dev/cam-*.html`.

## Purpose
Every view of the game. The camera is half of the driving feel and all of the cinematography. You move `ctx.camera`
(position, quaternion, fov → `updateProjectionMatrix`) in `update( frame )`; you are updated FIRST each frame.

## Inputs
`frame.car` (interpolated `position`, `quaternion`, `velocity`, `teleported`, `state`: speed, latG, longG, yawRate,
driftAngle, steerInput, wheels[].surface / travel, impacts, airborne), `frame.phase`, `ctx.track` (frames ahead of the car
for cinematic cameras), `ctx.world.heightAt` (keep cameras above ground), `ctx.input` (`look` axes; actions 'lookBack'),
`ctx.settings` (`fov`, `cameraShake`, `camera`), camera anchors from `ctx.systems.car?.getCameraAnchors()` (fallback:
`ctx.assets.index.car`), events 'car:impact', 'phase', 'car:reset'.

## Modes (`mode` string; `setMode( name )`, `nextMode()` cycles the driving modes; emit nothing yourself - the Game announces)
- `chase` (default) and `chaseFar`: a spring arm behind the car. The heading it follows blends the car's yaw with the
  direction of travel (so a slide shows the car's angle instead of hiding it), with critically damped smoothing that is
  frame-rate independent; looks slightly ahead into the corner; the car sits a little below centre; lateral g shifts the car
  off-centre a touch; FOV widens with speed (settings `fov` at rest → about +14° at 300 km/h) and the arm stretches slightly
  under acceleration and shortens under braking; height and distance tuned so the road ahead is clearly readable
  over the car. Never clips into terrain (ray / height check; rise instead of clipping), never jitters at standstill.
- `bonnet`: rigid on the bonnet, low and fast-feeling, tiny high-frequency vibration from speed and surface roughness.
- `cockpit`: at the driver's eye; head inertia (small translation against g-forces, slight roll with lateral g), looks
  slightly into the corner with steering / yaw rate; near objects (wheel, hands) must not clip.
- Look back (hold) in every driving mode; right-stick free look (`ctx.input.look`) in chase modes.
- `orbit`: slow showcase orbit around the car at the grid (used during the countdown and for 'idle').
- `cinematic` (attract mode in the menu): an automatic director cutting every 5-9 s between procedurally placed shots
  relative to the track: trackside tripod with long lens panning with the car, low kerb-level fly-by, high drone follow,
  helicopter-style lead shot looking back at the car, a slow reveal over the lake. Shots must be validated against terrain
  (line of sight to the car, above ground) and must show off the landscape. Smooth, never nauseating.
- `photo` (phase 'photo'): free-fly camera while the world is frozen: WASD / arrows move, mouse drag looks, Q/E down / up,
  wheel = FOV, [ ] roll, Shift faster. Starts from the current view. Expose `photo = { focusDistance, aperture }` (auto-focus
  on the car by default; F / click sets focus) for the post system's depth of field.
- Shake: subtle procedural shake from speed, rough surfaces (per `SURFACES[...].bump`), kerb strikes, landings and impacts
  ('car:impact' scaled by impulse), scaled by settings `cameraShake`; no shake in photo / cinematic tripod shots.
- `frame.car.teleported` → snap all smoothing state. Phase mapping: 'menu' → cinematic, 'countdown' → orbit that eases into
  the selected driving mode during the last second, 'drive' → the selected driving mode (settings `camera`), 'photo' → photo.
- `enabled` flag: when false, do not touch the camera (the debug API uses this).

## API
`{ mode, modes (driving modes for the UI), setMode( name ), nextMode(), enabled, photo, update( frame ), dispose() }`

## Budget
<= 0.1 ms; zero allocations per frame.

## Verification (`systems=all` or `environment,terrain,road,car,cameraRig&sim=1&phase=drive&autopilot=1`)
Frame sequences (8-10 frames, 0.25 s apart, through `tools/shot.mjs --script`) of: a hairpin, the fast esses, heavy braking,
a slide (if you can provoke one), each driving mode; a cinematic sequence of at least 5 different shots; the countdown
orbit; photo mode. Check: horizon stability, no terrain clipping, the car is never lost, the road ahead is readable,
motion is smooth (compare consecutive frames), FOV changes are subtle.
