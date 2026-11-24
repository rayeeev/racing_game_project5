// Tire force model: a normalised Pacejka-style slip curve, combined longitudinal / lateral slip by the similarity
// method (friction ellipse), load sensitivity and surface scaling. Pure functions on plain numbers - no allocation.

import { clamp } from '../core/math.js';

/**
 * Solves the stiffness factor B of g(s) = sin( C * atan( B s - E ( B s - atan( B s ) ) ) ) so that the curve
 * peaks (g = 1) at s = 1.
 * @param {number} C  shape factor, 1 < C < 2
 * @param {number} E  curvature factor, E < 1
 * @returns {number} B
 */
export function solveStiffnessFactor( C, E ) {

	const target = Math.tan( Math.PI / ( 2 * C ) );
	let lo = 0, hi = 50;
	for ( let i = 0; i < 60; i ++ ) {

		const mid = 0.5 * ( lo + hi );
		if ( mid - E * ( mid - Math.atan( mid ) ) < target ) lo = mid; else hi = mid;

	}

	return 0.5 * ( lo + hi );

}

/**
 * Normalised slip curve: 0 at s = 0, rises to 1 at s = 1 and falls toward sin( C * 90 deg ) for large slip.
 * @param {number} s  combined slip normalised by the peak slip, >= 0
 * @param {number} B  stiffness factor from solveStiffnessFactor()
 * @param {number} C  shape factor
 * @param {number} E  curvature factor
 * @returns {number} normalised force, 0..1
 */
export function slipCurve( s, B, C, E ) {

	const x = B * s;
	return Math.sin( C * Math.atan( x - E * ( x - Math.atan( x ) ) ) );

}

/**
 * Grip multiplier from the tire load: the friction coefficient falls as the load rises above the reference.
 * @param {number} load         vertical load in N
 * @param {number} reference    load at which the multiplier is 1
 * @param {number} sensitivity  coefficient lost per 100 % of load above the reference
 * @returns {number} multiplier, clamped to 0.55 .. 1.12
 */
export function loadGripFactor( load, reference, sensitivity ) {

	return clamp( 1 - sensitivity * ( load / reference - 1 ), 0.55, 1.12 );

}

/**
 * Combined-slip tire force by the similarity method. Writes [ Fx, Fy, Fx / sx ] into `out`:
 * Fx is the longitudinal force (N, positive = forward), Fy the lateral force (N, positive = left) and Fx / sx the
 * SECANT stiffness of Fx with respect to the normalised longitudinal slip. The curve is concave up to its peak, so
 * the secant is never below the tangent: an implicit wheel-speed step linearised with it converges on the torque
 * balance without ever overshooting through zero slip, also on the flat / falling part of the curve.
 * @param {number} sx    longitudinal slip ratio divided by the peak slip ratio
 * @param {number} sy    tangent of the slip angle divided by the tangent of the peak slip angle
 * @param {number} fxMax peak longitudinal force = muLong * load, N
 * @param {number} fyMax peak lateral force = muLat * load, N
 * @param {number} B     stiffness factor
 * @param {number} C     shape factor
 * @param {number} E     curvature factor
 * @param {number[]|Float64Array} out  receives [ Fx, Fy, Fx / sx ]
 * @returns {number} the combined normalised slip (1 = at the grip peak)
 */
export function combinedForce( sx, sy, fxMax, fyMax, B, C, E, out ) {

	const s = Math.sqrt( sx * sx + sy * sy );
	if ( s < 1e-6 ) {

		const slope = B * C; // g'(0)
		out[ 0 ] = fxMax * slope * sx;
		out[ 1 ] = fyMax * slope * sy;
		out[ 2 ] = fxMax * slope;
		return s;

	}

	const g = slipCurve( s, B, C, E ) / s;
	out[ 0 ] = fxMax * g * sx;
	out[ 1 ] = fyMax * g * sy;
	out[ 2 ] = fxMax * g;
	return s;

}
