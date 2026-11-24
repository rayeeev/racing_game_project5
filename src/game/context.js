// Runtime contracts of the game shell (JSDoc typedefs only).
//
// The game is a set of SYSTEMS created by factory functions and driven by the Game loop (src/game/game.js).
// Every system receives the same GameContext and is updated once per rendered frame with the same Frame object.
// Simulation contracts (VehicleState, TrackFrame ...) live in src/sim/types.js; conventions in src/sim/constants.js.
//
// ─────────────────────────────── SYSTEM FACTORIES ───────────────────────────────
// Each system module exports ONE async factory:   export async function createXxx( ctx ) → System
// The factory loads what it needs through ctx.assets, adds its objects to ctx.scene and returns the system object.
// A system must tolerate other systems being absent (ctx.systems.foo may be undefined) - the dev harness boots subsets.
//
//   module                      factory                 key in ctx.systems   role
//   src/gfx/environment.js      createEnvironment       environment          sky, sun light + shadows, fog, exposure, wind, wetness
//   src/gfx/terrain.js          createTerrain           terrain              terrain meshes + splat material, far mountains
//   src/gfx/road.js             createRoad              road                 road surface, markings, shoulder aprons, guard rails, signs, start gantry
//   src/gfx/props.js            createProps             props                designed set dressing (paddock, tyre stacks, cones, poles, pier) incl. dynamic props
//   src/gfx/water.js            createWater             water                the lake
//   src/gfx/scatter.js          createScatter           scatter              trees, rocks, shrubs (placement, instancing, LOD, impostors, colliders)
//   src/gfx/grass.js            createGrass             grass                GPU-driven grass + wildflower ring around the camera
//   src/gfx/car.js              createCar               car                  player car visual (model, paint, wheels, lights)
//   src/gfx/ghostCar.js         createGhostCar          ghostCar             translucent rival / ghost car
//   src/gfx/effects.js          createEffects           effects              tire smoke, dust, skid marks, sparks
//   src/gfx/racingLine.js       createRacingLine        racingLine           optional racing-line / braking-zone guide on the road
//   src/gfx/cameraRig.js        createCameraRig         cameraRig            all camera modes
//   src/gfx/post.js             createPost              post                 render pipeline (AO/GI, bloom, AA, grading); owns the final render call
//   src/ui/ui.js                createUI                ui                   DOM overlay: menus, HUD, notifications
//   src/audio/audio.js          createAudio             audio                engine, tires, wind, impacts, ambience, UI sounds
//
// Creation order: environment, terrain, road, props, water, scatter, grass, car, ghostCar, effects, racingLine, cameraRig, post, audio, ui.
// Update order every frame: input → fixed physics steps → cameraRig → environment → terrain → road → props → water → scatter
//                           → grass → car → ghostCar → effects → racingLine → ui → audio → post.render()

/**
 * @typedef {Object} System
 * @property {(frame: Frame) => void} [update]   called once per rendered frame (also while paused, with frame.paused = true and frame.dt = 0)
 * @property {(width: number, height: number, pixelRatio: number) => void} [resize]   called when the drawing buffer size changes
 * @property {() => void} [dispose]
 */

/**
 * Everything a system may need. Created once by the Game; the same object is passed to every factory.
 * @typedef {Object} GameContext
 * @property {import('three/webgpu').WebGPURenderer} renderer   initialised WebGPURenderer (reversed depth buffer, no MSAA)
 * @property {import('three/webgpu').Scene} scene
 * @property {import('three/webgpu').PerspectiveCamera} camera   the one gameplay camera (near 0.1, far 40000); the camera rig moves it
 * @property {HTMLCanvasElement} canvas
 * @property {HTMLElement} uiRoot                 element that hosts all DOM UI (covers the canvas)
 * @property {import('../core/assets.js').Assets} assets
 * @property {import('../core/settings.js').Settings} settings
 * @property {import('../core/storage.js').Records} records
 * @property {import('../core/input.js').Input} input
 * @property {import('../core/events.js').Emitter} events   global event bus (event list below)
 * @property {{ tier: 'low'|'medium'|'high'|'ultra', pixelRatio: number, renderScale: number }} quality   resolved quality; each system maps `tier` to its own detail table
 * @property {import('../sim/world.js').World} world        baked world: heights, track, surface + fields maps
 * @property {import('../sim/track.js').Track} track        === world.track
 * @property {Object|null} sim                    the simulation ({ physics, vehicle, track, world, dt, step(input), addObstacles(list) }) or null when the harness runs without physics
 * @property {import('../gfx/worldTextures.js').WorldTextures} worldTex   GPU textures + TSL lookups of the baked world maps (height, splat, fields, vegetation mask, ground tint)
 * @property {(list: Object[]) => void} addObstacles   registers physics colliders for static / dynamic objects (no-op without a simulation); descriptor format: see src/sim/session.js
 * @property {SkyState} sky                       current sky / lighting preset data (mutated in place by the environment system)
 * @property {Object<string, System|any>} systems the created systems by key (filled in creation order; later systems may read earlier ones)
 * @property {GameApi} game                       commands + read-only state for UI / debug
 * @property {boolean} isHarness                  true when booted by the dev harness instead of the full game
 */

/**
 * Lighting state shared by all materials. The environment system owns it and keeps the TSL uniforms in src/gfx/shared.js in sync.
 * @typedef {Object} SkyState
 * @property {string} id                              preset id ('golden' | 'noon' | 'overcast' | 'dusk')
 * @property {import('three/webgpu').Vector3} sunDirection   unit vector from the scene TOWARD the sun (world space)
 * @property {import('three/webgpu').Color} sunColor   linear RGB of the sun light (already multiplied by intensity)
 * @property {boolean} hasSun                         false for overcast / night presets (soft ambient only)
 * @property {number} wetness                         0 dry .. 1 wet road
 * @property {number} night                           0 day .. 1 night (headlights, emissive road furniture)
 * @property {Object} meta                            the preset's meta.json (see public/assets/sky/presets.json)
 */

/**
 * Per-frame data handed to every system's update().
 * @typedef {Object} Frame
 * @property {number} dt            seconds since the previous rendered frame (0 while paused; clamped to 0.1)
 * @property {number} time          accumulated un-paused render time in seconds
 * @property {number} realTime      wall-clock seconds since boot (keeps running while paused; use for UI animation)
 * @property {number} alpha         0..1 interpolation factor between the previous and the latest physics step
 * @property {boolean} paused
 * @property {string} phase         'boot' | 'menu' | 'countdown' | 'drive' | 'paused' | 'photo'
 * @property {CarPose} car          render-interpolated pose of the player car + its latest telemetry
 * @property {GhostPose|null} ghost pose of the ghost / rival car for this frame, or null when hidden
 * @property {HudState} hud         everything the HUD shows (filled by the Game)
 * @property {import('three/webgpu').PerspectiveCamera} camera
 */

/**
 * @typedef {Object} CarPose
 * @property {import('three/webgpu').Vector3} position       interpolated world position of the car origin (see VehicleState.position)
 * @property {import('three/webgpu').Quaternion} quaternion  interpolated world orientation
 * @property {import('three/webgpu').Vector3} velocity       world linear velocity (m/s) of the latest step
 * @property {import('../sim/types.js').VehicleState|null} state   latest telemetry of the simulation step (null if there is no sim)
 * @property {boolean} teleported   true on the first frame after a reset / teleport (cameras and trails must snap instead of smoothing)
 */

/**
 * @typedef {Object} GhostPose
 * @property {import('three/webgpu').Vector3} position
 * @property {import('three/webgpu').Quaternion} quaternion
 * @property {number} steer        front wheel steer angle in rad (positive = left)
 * @property {number} speed        m/s
 * @property {number} wheelSpin    accumulated wheel rotation angle in rad
 * @property {boolean} braking
 * @property {string} label        e.g. 'GOLD', 'BEST'
 */

/**
 * @typedef {Object} HudState
 * @property {number} speed          m/s (always >= 0)
 * @property {number} rpm
 * @property {number} redline        rpm at which the limiter cuts
 * @property {number} gear           -1 R, 0 N, 1..7
 * @property {number} throttle       0..1
 * @property {number} brake          0..1
 * @property {number} steer          -1..1 (negative = left)
 * @property {boolean} tcActive
 * @property {boolean} absActive
 * @property {string} racePhase      'none' | 'grid' | 'outlap' | 'lap'
 * @property {number} lap            current lap number (1-based; 0 before the first line crossing)
 * @property {number} lapTime        current lap time in seconds (0 before the first line crossing)
 * @property {number|null} lastLap
 * @property {number|null} bestLap   best valid lap of this session
 * @property {number|null} record    stored personal best for the current conditions
 * @property {number|null} delta     live time delta against the active ghost in seconds (negative = ahead), null if no ghost
 * @property {string} ghostLabel     label of the active ghost ('' if none)
 * @property {number} sector         current sector index 0..2
 * @property {(number|null)[]} sectorTimes   sector times of the current lap so far
 * @property {boolean} lapValid
 * @property {boolean} wrongWay
 * @property {boolean} offTrack
 * @property {number|null} countdown 3, 2, 1, 0 (= GO) while counting down, otherwise null
 * @property {number} trackS         car position along the track in meters
 * @property {number} trackLength
 * @property {number[]} carXZ        [x, z] world position (minimap)
 * @property {number} carYaw
 * @property {number[]|null} ghostXZ
 * @property {{ bronze: number, silver: number, gold: number }|null} medals   target lap times for the current conditions
 * @property {string|null} medal     best medal earned so far for the current conditions: null | 'bronze' | 'silver' | 'gold'
 * @property {string} units          'kmh' | 'mph'
 * @property {string} cameraMode
 */

/**
 * Commands and state exposed to the UI, the debug API and the systems.
 * @typedef {Object} GameApi
 * @property {string} phase
 * @property {() => void} startSession     menu → countdown → drive (rolling start from the grid)
 * @property {() => void} restartSession   back to the grid immediately
 * @property {() => void} quitToMenu
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {() => void} resetCar         put the car back on the road at the last checkpoint
 * @property {(id: string) => Promise<void>} setSky
 * @property {(id: string) => void} setPaint
 * @property {(mode: string) => void} setGhostMode   'off' | 'best' | 'bronze' | 'silver' | 'gold'
 * @property {(mode?: string) => void} setCameraMode  omit the argument to cycle
 * @property {(on: boolean) => void} setPhotoMode
 * @property {(on: boolean, skill?: number) => void} setAutopilot
 */

// ─────────────────────────────── EVENTS on ctx.events ───────────────────────────────
//  'phase'              { from, to }
//  'countdown'          { n }                      3, 2, 1, 0 (0 = GO)
//  'race:lapStart'      { lap }
//  'race:checkpoint'    { index, time }
//  'race:sector'        { index, time, best, delta }
//  'race:lapComplete'   { lap, time, valid, sectors, isSessionBest, isRecord, medal, previousRecord }
//  'race:wrongWay'      { active }
//  'race:offTrack'      { active }
//  'race:invalidated'   { reason }
//  'car:reset'          { pose }
//  'car:impact'         ImpactEvent (src/sim/types.js), one event per collision
//  'car:gear'           { gear, previous }
//  'car:paint'          { id }
//  'sky:changed'        SkyState
//  'settings:change'    { key, value }
//  'camera:mode'        { mode }
//  'photo'              { active }
//  'notify'             { text, kind }             generic toast request for the HUD ('info' | 'good' | 'bad')

export {};
