# System brief: EFFECTS - tire smoke, dust, spray, skid marks, sparks
Module `src/gfx/effects.js` → `export async function createEffects( ctx )`, key `effects`. Prefix: `fx`.
Owner files: `src/gfx/effects.js` (+ `src/gfx/effects/*.js`), `dev/fx-*.html`.

## Inputs
`frame.car.state` (VehicleState: per wheel `contact`, `surface`, `skid`, `slip`, `slipRatio`, `contactPoint`,
`contactNormal`, `angularVelocity`, `load`; `impacts`; `speed`; `rpm`; `throttle`), `SURFACES` (dust amount / colour, marks
type) from `src/sim/constants.js`, FX textures from `ctx.assets.index.textures.fx` (smoke / spark sprites - see the TEXTURES
notes), the shared uniforms (sun colour / direction, ambient colour, wetness, wind), exhaust positions from
`ctx.assets.index.car`.

## Effects
1. **Tire smoke** on asphalt when a wheel slides (`skid` high): white-grey, billowing, lit by the sun (bright rim toward a
   low sun, shadowed side darker - use uSunColor / uAmbientColor with a cheap normal-from-sprite or half-Lambert trick),
   inherits part of the car velocity, drifts with the wind, expands and fades over ~1.5-3 s. Amount scales with slip speed
   and load. A locked-wheel brake stop and a burnout must both look right.
2. **Dust** on gravel / dirt / grass / sand whenever the wheels roll fast or slide: colour from `SURFACES[surface].dustColor`,
   bigger, lower and longer-lived than smoke; a proper rooster tail off the driven wheels on loose surfaces.
3. **Water spray** when `uWetness > 0.3` on asphalt: fine mist trails behind all four wheels growing with speed.
4. **Skid marks**: per-wheel ribbons on the ground following `contactPoint` / `contactNormal`: dark rubber on asphalt
   (opacity from `skid`), lighter displaced-ground tracks on loose surfaces; persistent for the session in a ring buffer
   (>= 600 m of marks per wheel), no z-fighting (in-shader depth bias / small lift + distance fade), soft edges, break the
   ribbon when the wheel is airborne or teleports (`frame.car.teleported`).
5. **Sparks** on hard metal contacts (`impacts` with kind 'rail' / 'rock' and enough impulse): short bright streaks with
   gravity; bloom should catch them. **Debris puffs** on terrain impacts.
6. **Exhaust**: brief backfire flashes on lift-off at high rpm (rpm > ~7000 and throttle dropping to 0) and on up-shifts
   near the limiter; faint heat / vapour at idle in cold presets is optional.
Implementation: GPU-instanced camera-facing sprites with soft depth fade against the scene (see the crib: depth access /
SoftParticles helper), premultiplied alpha, no popping at spawn / death, fog-aware. CPU-simulated pools with partial buffer
updates are fine; no per-frame allocations. Particle cap by tier (high ~3000). Must be stable with temporal AA.

## API
`{ update( frame ), clear(), dispose() }` (`clear()` removes marks and particles; called on session restart).

## Budget
<= 0.5 ms on high in normal driving, <= 1.2 ms during a sustained burnout.

## Verification (`systems=environment,terrain,road,car,effects&sim=1`)
Script scenarios through `window.__game` (teleport + drive with the autopilot, or feed controls by overriding
`__game.game.session` inputs if the debug API allows): a handbrake slide on asphalt (smoke + rubber marks), a launch with
wheelspin, hard braking, driving along the gravel shoulder and across grass (dust, light tracks), the wet preset at speed
(spray), a rail scrape (sparks). Shots from the chase camera and from a static trackside camera, toward and away from the
sun, in golden and overcast. Hunt for: hard sprite edges intersecting the ground, popping, smoke that looks like flat discs,
marks floating or flickering.
