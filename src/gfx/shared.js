// TSL uniform nodes shared by every material and effect.
//
// The ENVIRONMENT system (src/gfx/environment.js) owns the lighting-related values, the Game writes uTime and uCarPosition
// each frame. Any material may read these nodes; nobody else writes them.
// Import in materials:   import { uSunDirection, uWetness, ... } from './shared.js';

import { uniform } from 'three/tsl';
import { Color, Vector2, Vector3 } from 'three/webgpu';

/** Un-paused render time in seconds (animations, wind, water). */
export const uTime = uniform( 0 );

/** Unit vector from the scene TOWARD the sun (world space). For presets without a sun it points at the brightest sky region. */
export const uSunDirection = uniform( new Vector3( 0.45, 0.6, 0.66 ).normalize() );

/** Linear RGB sun colour multiplied by its intensity (0 when the preset has no direct sun). */
export const uSunColor = uniform( new Color( 1, 1, 1 ) );

/** Average sky colour (linear) scaled to the ambient level - a cheap ambient term for unlit / custom-lit effects such as particles. */
export const uAmbientColor = uniform( new Color( 0.5, 0.6, 0.7 ) );

/** Road / world wetness: 0 = dry, 1 = soaked (darker albedo, lower roughness, puddles). */
export const uWetness = uniform( 0 );

/** 0 = day, 1 = night (emissive road furniture, headlight-dependent effects). */
export const uNight = uniform( 0 );

/** Horizontal wind direction (unit vector in the XZ plane, stored as x → world X, y → world Z). */
export const uWindDirection = uniform( new Vector2( 0.8, 0.6 ) );

/** Wind strength 0..1 (0.25 = gentle breeze, 1 = storm). */
export const uWindStrength = uniform( 0.3 );

/** Fog / aerial-perspective colour toward the horizon away from the sun (linear RGB). */
export const uFogColor = uniform( new Color( 0.6, 0.7, 0.8 ) );

/** Fog colour when looking toward the sun (in-scattering glow, linear RGB). */
export const uFogSunColor = uniform( new Color( 1.0, 0.85, 0.6 ) );

/** Fog density at lake level in 1/m (extinction coefficient). */
export const uFogDensity = uniform( 0.00012 );

/** Height falloff of the fog in 1/m (density = uFogDensity * exp( -y * uFogHeightFalloff )). */
export const uFogHeightFalloff = uniform( 0.004 );

/** World position of the player car origin (grass bending, dust, proximity effects). */
export const uCarPosition = uniform( new Vector3() );

/** World-space velocity of the player car in m/s. */
export const uCarVelocity = uniform( new Vector3() );
