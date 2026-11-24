# System brief: CAR VISUAL + GHOST CAR
Modules: `src/gfx/car.js` → `createCar( ctx )` (key `car`); `src/gfx/ghostCar.js` → `createGhostCar( ctx )` (key `ghostCar`).
Prefix: `car`. Owner files: `src/gfx/car.js`, `src/gfx/ghostCar.js` (+ `src/gfx/car/*.js`), `dev/car-*.html`.

## Inputs
`/assets/car/car.glb`, `/assets/car/car_lod1.glb`, `ctx.assets.index.car` (= car.json: measured structure - wheel nodes,
axes, roles → mesh / material names, light and exhaust positions, camera anchors - and the tested material recipe). Read the
CAR section of the assets notes first. Per frame: `frame.car` (interpolated pose + latest `VehicleState`) and `frame.ghost`.

## Player car
- Materials per the recipe: layered car paint (clearcoat, subtle flake), glass, rubber, alloy rims, brake discs / calipers,
  lights, interior. At least 8 curated paint colours with ORIGINAL names (deep red, pearl white, midnight blue, graphite,
  yellow, racing green, orange, silver-blue ...): expose `paints = [ { id, name, swatch } ]` and `setPaint( id )`; initial
  paint from `ctx.settings.get( 'paint' )` ('' → your default).
- The game's car is fictional (call it nothing more specific than "the car" in code/UI): no real-world brand names in
  strings or ids; if the model carries brand badges / logos as separable meshes or textures (see `roles.badges` in car.json),
  hide or neutralize them.
- Pose: place the root at `frame.car.position / quaternion` (the physics body origin = the model origin, see the notes).
  Wheels: front groups steer (`state.wheels[i].steer`), all spin about their axle (`state.wheels[i].spin`, extrapolated by
  `angularVelocity * (alpha * dt)` for smoothness), each wheel moves along the car's up axis with its suspension compression
  (body roll / pitch already come from physics). The steering wheel turns with `state.steerInput`.
- Lights: tail lights (dim running lights at night, bright while `state.brake > 0.05`), reverse lights (gear -1), headlights
  (automatic when `ctx.sky.night > 0.5`, toggled by the input action 'headlights'): emissive lenses + two SpotLights (wide
  low beam, 60-80 m reach, plausible falloff; shadow casting from ONE of them only on ultra) parented to the car; lens glow
  that the bloom picks up.
- Driver: the car is open-top and an empty seat looks wrong. Add a simple but convincing helmeted driver (helmet with visor,
  torso, arms reaching the wheel, dark racing suit; hands follow the steering wheel). Must look right from the chase camera
  (3-8 m) and acceptable from the cockpit (arms / hands only).
- Grounding: a soft contact shadow under the car from the baked AO texture (placement in car.json), aligned to the ground
  under the car and fading when airborne, plus real cascaded shadows (casts + receives; cast from LOD1 if that is cheaper).
- Road dirt (valuable, keep it subtle): driving on gravel / dirt / grass gradually dusts the lower body and wheels (a mask
  on the paint: rougher, tinted with the surface's dust colour from SURFACES); wet preset: darker tyres, sheen.
- Reflections on the paint: the sky preset's environment is the base and the post system adds screen-space reflections.
- Cockpit: interior and steering wheel must hold up in the cockpit camera (near plane 0.1 m). Expose camera anchors from
  car.json: `getCameraAnchors()` → `{ cockpit: { position, lookAt }, bonnet: { position, lookAt }, chasePivot }` in car-local
  coordinates.

## Ghost car (`createGhostCar`)
Renders `frame.ghost` (hidden when null) with car_lod1: wheels steer / spin from the GhostPose. A translucent, unmistakably
"ghost" look that still reads as the same car: Fresnel-edged tinted body with dithered transparency (stable with temporal
AA, no sorting artifacts), tinted by `frame.ghost.label` ('BRONZE' / 'SILVER' / 'GOLD' → medal colours, 'BEST' → cool blue);
fades out within ~6 m of the camera so it never blocks the view; casts no shadow.

## API
car: `{ paints, setPaint( id ), object, getCameraAnchors(), setHeadlights( on | 'auto' ), update( frame ), dispose() }`
ghostCar: `{ update( frame ), dispose() }`

## Budget
Car <= 0.8 ms and <= 40 draw calls; ghost <= 0.2 ms.

## Verification
`systems=environment,terrain,road,car&sim=1&phase=idle`: beauty shots (3/4 front, 3/4 rear, side, top) in all four presets and
at least 4 paints - they must look like car photography, not a toy. Driving check with `phase=drive&autopilot=1`: shots in
corners (front wheels steered, body roll, suspension working) and under braking (brake lights). Dusk with headlights on the
road. Cockpit view. Ghost next to the player car. Hunt for: floating / sunk wheels, wrong spin direction, z-fighting contact
shadow, plastic paint, black interior, light leaking.
