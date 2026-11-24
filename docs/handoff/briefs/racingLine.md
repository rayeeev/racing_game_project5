# System brief: RACING LINE GUIDE
Module `src/gfx/racingLine.js` → `export async function createRacingLine( ctx )`, key `racingLine`. Prefix: `line`.
Owner files: `src/gfx/racingLine.js`, `dev/line-*.html`.

## Purpose
An optional driving aid that teaches the circuit: the ideal line painted on the road ahead of the car, coloured by what to
do - green (flat out), amber (lift), red (brake) - like the assist line of modern racing games. It is the single most
effective feature for making the first laps fun instead of frustrating.

## Inputs
The AI driver's precomputed data: construct `new Autopilot( ctx.track, vehicleConfig, { skill: 1, wetness: ctx.sky.wetness } )`
from `src/sim/autopilot.js` yourself (read that file for the exact fields: the racing line as a lateral offset per track
sample and the target speed profile per sample) - rebuild on 'sky:changed' (wet lines brake earlier). `ctx.track` (pointAt,
frames), `frame.car.state` (speed) and `frame.hud.trackS`, setting `racingLine` ('off' | 'braking' | 'full', listen to
'settings:change'), `frame.phase` (visible only in 'drive' and 'countdown').

## Requirements
- Geometry: a ribbon ~0.45 m wide lying on the road surface along the racing line, built once for the whole lap (sampled
  every 1-2 m, following banking), drawn only for the stretch from ~8 m to ~220 m ahead of the car (window by track
  distance in the shader or by draw range; fade in / out at both ends; wrap correctly across the start line).
- Colour: per point compare the car's CURRENT speed projected forward with the target profile: brake where the car would
  arrive too fast given a realistic deceleration (~11 m/s² dry, ~8 wet), amber within a small margin, green otherwise.
  Updates smoothly every frame (attribute or small data texture update; no allocations).
- 'braking' mode shows only the amber / red sections (clean look for experienced players); 'full' shows everything.
- Look: clearly a HUD overlay yet integrated: soft-edged, slightly emissive chevrons or a segmented band moving toward the
  car, semi-transparent, readable on dry and wet asphalt and at dusk, no z-fighting (in-shader depth bias / polygon offset
  + distance fade), unaffected by motion blur smearing as far as possible, hidden in photo mode and for the cinematic camera.
- <= 0.1 ms, 1 draw call.

## API
`{ update( frame ), setMode( mode ), dispose() }`

## Verification (`systems=environment,terrain,road,car,racingLine&sim=1&phase=drive&autopilot=1`)
Shots approaching a hairpin (red zone visible in time to brake), through fast esses (green / amber), on the straight, in
the wet and at dusk; both modes; confirm the line follows the AI's actual path (the autopilot car should drive along it).
