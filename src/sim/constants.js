// Simulation-wide constants and conventions.
//
// ───────────────────────────── CONVENTIONS (binding for every module) ─────────────────────────────
// Units ............ meters, seconds, kilograms, radians, Newtons.
// Axes ............. right-handed, +Y up (three.js default).
// Vehicle frame .... forward = -Z, right = +X, up = +Y (local space of the chassis rigid body AND of the car model).
// Yaw .............. rotation about +Y. yaw = 0 faces -Z. Positive yaw turns LEFT (counter-clockwise seen from above).
//                    forward(yaw) = ( -sin(yaw), 0, -cos(yaw) )      quaternion = axisAngle(+Y, yaw)
// Steering input ... steer in [-1, +1]: -1 = full LEFT, +1 = full RIGHT (same sign as a gamepad stick X axis).
//                    Road-wheel steer ANGLES are yaw angles: positive = wheels turned LEFT.
// Track coords ..... s = distance along the centreline in the driving direction, in [0, track.length).
//                    d = signed lateral offset from the centreline, POSITIVE = LEFT of the driving direction.
//                    left = up x forward.   Curvature > 0 = the road turns LEFT.   bank > 0 = left edge lower (banked for a left turn).
// Wheel order ...... [ FL, FR, RL, RR ]  (front-left, front-right, rear-left, rear-right) everywhere.
// Grids ............ height/surface grids are row-major with z as the row: index = iz * n + ix,
//                    world x = minX + ix * cell, world z = minZ + iz * cell.
// The simulation (src/sim, src/core) must stay free of DOM / renderer dependencies so it runs unchanged in Node.
// ────────────────────────────────────────────────────────────────────────────────────────────────────

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.2; // kg/m^3

/** Wheel indices. */
export const FL = 0, FR = 1, RL = 2, RR = 3;

/** Ground surface types (stored as Uint8 in the baked surface grid). */
export const Surface = Object.freeze( {
	ASPHALT: 0,
	GRAVEL: 1, // road shoulders, scree
	GRASS: 2,
	DIRT: 3, // soil, forest floor
	ROCK: 4,
	SAND: 5, // lake shore
	WATER: 6,
} );

/**
 * Per-surface physical + presentation properties. Indexed by Surface id.
 *  grip ............ multiplier on the tire friction coefficient (1 = dry asphalt)
 *  wetGrip ......... multiplier applied on top of `grip` when world wetness = 1 (interpolate by wetness)
 *  slipPeakScale ... stretches the slip at which peak grip occurs (loose surfaces peak later and fall off less)
 *  rolling ......... rolling resistance coefficient (force = rolling * load)
 *  drag ............ extra speed-proportional drag while a wheel is on it, N per (m/s) per wheel (deep sand / water)
 *  bump ............ amplitude (m) of small-scale roughness to be added to the suspension contact (procedural)
 *  bumpFreq ........ spatial frequency (1/m) of that roughness
 *  dust ............ 0..1 amount of dust kicked up when rolling/slipping
 *  dustColor ....... sRGB hex of the dust / spray
 *  marks ........... 'rubber' (dark skid marks) | 'ruts' (light displaced-ground tracks) | 'none'
 *  sound ........... which rolling/skid sound family to use
 */
export const SURFACES = Object.freeze( [
	{ id: 0, name: 'asphalt', grip: 1.00, wetGrip: 0.74, slipPeakScale: 1.0, rolling: 0.013, drag: 0, bump: 0.000, bumpFreq: 0.0, dust: 0.00, dustColor: 0x8a8a8a, marks: 'rubber', sound: 'asphalt' },
	{ id: 1, name: 'gravel', grip: 0.66, wetGrip: 0.90, slipPeakScale: 1.9, rolling: 0.035, drag: 6, bump: 0.012, bumpFreq: 1.7, dust: 0.85, dustColor: 0xb9ad98, marks: 'ruts', sound: 'gravel' },
	{ id: 2, name: 'grass', grip: 0.52, wetGrip: 0.72, slipPeakScale: 1.6, rolling: 0.070, drag: 14, bump: 0.022, bumpFreq: 0.9, dust: 0.20, dustColor: 0x6f6a4d, marks: 'ruts', sound: 'grass' },
	{ id: 3, name: 'dirt', grip: 0.58, wetGrip: 0.70, slipPeakScale: 1.8, rolling: 0.055, drag: 10, bump: 0.018, bumpFreq: 1.1, dust: 0.70, dustColor: 0x8c7355, marks: 'ruts', sound: 'gravel' },
	{ id: 4, name: 'rock', grip: 0.72, wetGrip: 0.75, slipPeakScale: 1.1, rolling: 0.030, drag: 4, bump: 0.035, bumpFreq: 0.8, dust: 0.15, dustColor: 0x9a9a96, marks: 'none', sound: 'gravel' },
	{ id: 5, name: 'sand', grip: 0.48, wetGrip: 0.95, slipPeakScale: 2.2, rolling: 0.160, drag: 40, bump: 0.010, bumpFreq: 1.3, dust: 0.60, dustColor: 0xc8bb9c, marks: 'ruts', sound: 'gravel' },
	{ id: 6, name: 'water', grip: 0.30, wetGrip: 1.00, slipPeakScale: 2.0, rolling: 0.300, drag: 260, bump: 0.000, bumpFreq: 0.0, dust: 0.00, dustColor: 0xdfe8ee, marks: 'none', sound: 'water' },
] );
