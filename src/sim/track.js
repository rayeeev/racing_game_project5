// The road as a mathematical object: a closed centreline sampled every meter with a full local frame, elevation,
// banking and width, plus fast queries (frame at s, projection of a world position, spawn poses ...).
//
// Conventions (see src/sim/constants.js): s runs in the driving direction, d is positive to the LEFT, curvature > 0
// turns LEFT, bank > 0 lowers the left edge, yaw = 0 faces -Z and grows counter-clockwise seen from above.
//
// Definitions specific to this module:
//  - s is the arc length of the centreline measured in the HORIZONTAL plane (plan view). Sample i sits at s = i * spacing
//    and spacing is exactly 1 m: after smoothing, the curve is scaled about the world origin by a factor that changes
//    its length by less than half a meter (within +-0.011 % of 1 for a 5 km lap, see Track#scale) so that the length
//    becomes a whole number of meters.
//  - s = 0 (the start / finish line) is at control point 0.
//  - grade = dy/ds (rise over horizontal run), so the 3D distance driven is slightly longer than s.
//  - Between samples everything is interpolated linearly (vectors are re-normalised), so the centreline of pointAt()
//    lies exactly on a mesh built from the per-sample arrays (and its edges within a fraction of a millimeter).

import { clamp, cubic, DEG2RAD, loopDelta, mod, smoothstep } from '../core/math.js';
import { GRAVITY } from './constants.js';
import { WORLD, baseHeight } from './layout.js';

/** @typedef {import('./types.js').TrackFrame} TrackFrame */
/** @typedef {import('./types.js').TrackProjection} TrackProjection */
/** @typedef {import('./types.js').SpawnPose} SpawnPose */

const SAMPLE_SPACING = 1; // m between the public samples
const FINE_PER_SAMPLE = 4; // the curve is built on a 0.25 m polyline and decimated
const SPLINE_STEP = 0.5; // m; approximate step used to tessellate the spline
const SPLINE_KNOT_POWER = 1; // knot interval = chord length ^ power (1 = chord-length parametrisation)
const HASH_CELL = 16; // m; cell size of the spatial hash used by the global projection
const GLOBAL_EXACT_RINGS = 8; // rings of hash cells searched exhaustively before the coarse scan takes over
const GLOBAL_SCAN_STRIDE = 8; // samples skipped by the coarse scan for positions far away from the road
const MAX_LOCAL_STEPS = 64; // samples a hinted projection may walk before it falls back to the global search
const RELOCALIZE_MARGIN = 12; // m beyond the road edge at which a hinted projection double-checks globally
const RELOCALIZE_RATIO = 0.5; // ... and switches when another part of the road is closer than this fraction
const LIMITER_STRIDES = [ 32, 16, 8, 4, 2, 1 ]; // coarse-to-fine levels of the elevation limiter (meters per node)
const LIMITER_MAX_SWEEPS = 400;
const PROFILE_BLEND_SIGMA = 8; // m; rounds the joints of the explicit-height interpolation

const DEFAULT_ELEVATION = Object.freeze( {
	smoothing: 45, offset: 0.4, terrainFollow: 1, minHeight: 3.5, maxGrade: 0.1,
	minCrestRadius: 350, maxCrestG: 0.7, minSagRadius: 220, maxSagG: 1.5, crestSpan: 120, relaxedCrestG: 0.8, finalSmoothing: 5,
} );
const DEFAULT_BANKING = Object.freeze( { gain: 6, maxDeg: 6, smoothing: 10 } );
const WIDTH_SMOOTHING = 5; // m; Gaussian standard deviation applied to the width profile

/**
 * The quasi-static speed model used for the estimates.
 * @property {number} lateral ...... cornering acceleration in m/s^2 (v = sqrt(lateral / |curvature|))
 * @property {number} accelerate ... forward acceleration in m/s^2
 * @property {number} brake ........ deceleration in m/s^2
 * @property {number} maxSpeed ..... top speed in m/s (320 km/h)
 */
export const SPEED_MODEL = Object.freeze( { lateral: 12, accelerate: 6, brake: 11, maxSpeed: 320 / 3.6 } );

/**
 * Estimated speed at every sample for a flying lap: cornering limit, then acceleration and braking limits.
 * @param {{count: number, spacing: number, curvatures: ArrayLike<number>}} track a Track (only these fields are read)
 * @param {typeof SPEED_MODEL} [model]
 * @returns {Float32Array} speed in m/s per sample
 */
export function estimateSpeedProfile( track, model = SPEED_MODEL ) {

	const count = track.count, ds = track.spacing;
	const speed = new Float32Array( count );
	for ( let i = 0; i < count; i ++ ) {

		const k = Math.abs( track.curvatures[ i ] );
		speed[ i ] = k > 0 ? Math.min( model.maxSpeed, Math.sqrt( model.lateral / k ) ) : model.maxSpeed;

	}

	// Two laps of each pass so that the limits propagate across the s = 0 seam.
	for ( let pass = 0; pass < 2 * count; pass ++ ) {

		const i = pass % count, j = ( i + 1 ) % count;
		const reachable = Math.sqrt( speed[ i ] * speed[ i ] + 2 * model.accelerate * ds );
		if ( speed[ j ] > reachable ) speed[ j ] = reachable;

	}

	for ( let pass = 2 * count - 1; pass >= 0; pass -- ) {

		const i = pass % count, j = ( i + 1 ) % count;
		const allowed = Math.sqrt( speed[ j ] * speed[ j ] + 2 * model.brake * ds );
		if ( speed[ i ] > allowed ) speed[ i ] = allowed;

	}

	return speed;

}

/**
 * Second derivatives of the periodic C2 cubic spline through `values` at the knots.
 * @param {number[]} values one coordinate of the control points
 * @param {number[]} intervals knot interval after each control point
 * @returns {Float64Array}
 */
function splineSecondDerivatives( values, intervals ) {

	const n = values.length;
	const rhs = new Float64Array( n ), second = new Float64Array( n );
	for ( let i = 0; i < n; i ++ ) {

		const prev = ( i + n - 1 ) % n, next = ( i + 1 ) % n;
		rhs[ i ] = 6 * ( ( values[ next ] - values[ i ] ) / intervals[ i ] - ( values[ i ] - values[ prev ] ) / intervals[ prev ] );

	}

	// The cyclic tridiagonal system is strictly diagonally dominant: Gauss-Seidel halves the error every sweep.
	for ( let sweep = 0; sweep < 64; sweep ++ ) {

		for ( let i = 0; i < n; i ++ ) {

			const prev = ( i + n - 1 ) % n, next = ( i + 1 ) % n;
			second[ i ] = ( rhs[ i ] - intervals[ prev ] * second[ prev ] - intervals[ i ] * second[ next ] ) / ( 2 * ( intervals[ prev ] + intervals[ i ] ) );

		}

	}

	return second;

}

/**
 * Tessellates the closed curve through the control points: a periodic cubic spline with continuous curvature (C2),
 * parametrised by chord length so that unevenly spaced points do not make it overshoot.
 * @param {{x: number, z: number}[]} points control points
 * @returns {{xs: number[], zs: number[], starts: number[]}} dense polyline (not repeating the first point) and, per
 *          control point, the index of the polyline vertex that coincides with it
 */
function tessellateSpline( points ) {

	const n = points.length;
	const px = points.map( ( p ) => p.x ), pz = points.map( ( p ) => p.z );
	const intervals = points.map( ( p, i ) => Math.hypot( px[ ( i + 1 ) % n ] - p.x, pz[ ( i + 1 ) % n ] - p.z ) ** SPLINE_KNOT_POWER );
	const ddx = splineSecondDerivatives( px, intervals ), ddz = splineSecondDerivatives( pz, intervals );
	const xs = [], zs = [], starts = [];
	for ( let i = 0; i < n; i ++ ) {

		const next = ( i + 1 ) % n;
		const h = intervals[ i ];
		const steps = Math.max( 4, Math.ceil( Math.hypot( px[ next ] - px[ i ], pz[ next ] - pz[ i ] ) / SPLINE_STEP ) );
		starts.push( xs.length );
		for ( let k = 0; k < steps; k ++ ) {

			const b = k / steps, a = 1 - b;
			const ca = ( a * a * a - a ) * h * h / 6, cb = ( b * b * b - b ) * h * h / 6;
			xs.push( a * px[ i ] + b * px[ next ] + ca * ddx[ i ] + cb * ddx[ next ] );
			zs.push( a * pz[ i ] + b * pz[ next ] + ca * ddz[ i ] + cb * ddz[ next ] );

		}

	}

	return { xs, zs, starts };

}

/**
 * Cumulative length of a closed polyline.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} zs
 * @returns {Float64Array} arc[i] = length from vertex 0 to vertex i; arc[n] = total length
 */
function cumulativeLength( xs, zs ) {

	const n = xs.length;
	const arc = new Float64Array( n + 1 );
	for ( let i = 0; i < n; i ++ ) {

		const j = ( i + 1 ) % n;
		arc[ i + 1 ] = arc[ i ] + Math.hypot( xs[ j ] - xs[ i ], zs[ j ] - zs[ i ] );

	}

	return arc;

}

/**
 * Resamples a closed polyline to `count` points equally spaced in arc length, starting at vertex 0.
 * Positions between vertices are interpolated with a Catmull-Rom cubic so that no faceting noise reaches the curvature.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} zs
 * @param {Float64Array} arc cumulativeLength( xs, zs )
 * @param {number} count
 * @param {number} [scale=1] factor applied to the coordinates
 * @returns {{xs: Float64Array, zs: Float64Array}}
 */
function resampleClosed( xs, zs, arc, count, scale = 1 ) {

	const n = xs.length;
	const outX = new Float64Array( count ), outZ = new Float64Array( count );
	const step = arc[ n ] / count;
	let seg = 0;
	for ( let k = 0; k < count; k ++ ) {

		const target = k * step;
		while ( seg < n - 1 && arc[ seg + 1 ] <= target ) seg ++;
		const span = arc[ seg + 1 ] - arc[ seg ];
		const f = span > 0 ? ( target - arc[ seg ] ) / span : 0;
		const i0 = ( seg + n - 1 ) % n, i2 = ( seg + 1 ) % n, i3 = ( seg + 2 ) % n;
		outX[ k ] = cubic( xs[ i0 ], xs[ seg ], xs[ i2 ], xs[ i3 ], f ) * scale;
		outZ[ k ] = cubic( zs[ i0 ], zs[ seg ], zs[ i2 ], zs[ i3 ], f ) * scale;

	}

	return { xs: outX, zs: outZ };

}

/**
 * Periodic Gaussian smoothing of a sampled loop.
 * @param {ArrayLike<number>} src
 * @param {number} sigma standard deviation in samples (<= 0 returns a copy)
 * @returns {Float64Array}
 */
function smoothPeriodic( src, sigma ) {

	const n = src.length;
	const dst = new Float64Array( n );
	if ( ! ( sigma > 0.05 ) ) {

		dst.set( src );
		return dst;

	}

	const radius = Math.min( Math.ceil( sigma * 3.5 ), ( n - 1 ) >> 1 );
	const kernel = new Float64Array( radius + 1 );
	let total = 0;
	for ( let k = 0; k <= radius; k ++ ) {

		kernel[ k ] = Math.exp( - 0.5 * ( k / sigma ) ** 2 );
		total += k === 0 ? kernel[ k ] : 2 * kernel[ k ];

	}

	// Unrolled copy of the loop so that the inner loop needs no modulo.
	const padded = new Float64Array( n + 2 * radius );
	for ( let i = 0; i < padded.length; i ++ ) padded[ i ] = src[ mod( i - radius, n ) ];
	for ( let i = 0; i < n; i ++ ) {

		const c = i + radius;
		let sum = kernel[ 0 ] * padded[ c ];
		for ( let k = 1; k <= radius; k ++ ) sum += kernel[ k ] * ( padded[ c - k ] + padded[ c + k ] );
		dst[ i ] = sum / total;

	}

	return dst;

}

/**
 * Samples a periodic array at a fractional index with Catmull-Rom interpolation.
 * @param {ArrayLike<number>} values
 * @param {number} position fractional index (any real number; wraps)
 * @returns {number}
 */
function samplePeriodicCubic( values, position ) {

	const n = values.length;
	const base = Math.floor( position );
	const t = position - base;
	const i1 = mod( base, n );
	return cubic( values[ ( i1 + n - 1 ) % n ], values[ i1 ], values[ ( i1 + 1 ) % n ], values[ ( i1 + 2 ) % n ], t );

}

/**
 * Spreads an optional per-control-point value along the loop: between two consecutive control points the value and
 * its weight (1 where the point defines the value, 0 where it does not) ease from one to the other.
 * @param {number[]} stations s of every control point, ascending
 * @param {(number | undefined)[]} values per control point; undefined = not specified
 * @param {number} count number of samples (1 m apart)
 * @returns {{value: Float64Array, weight: Float64Array}} per-sample value and weight (value is 0 where weight is 0)
 */
function spreadControlValues( stations, values, count ) {

	const value = new Float64Array( count ), weight = new Float64Array( count );
	const n = stations.length;
	for ( let k = 0; k < n; k ++ ) {

		const next = ( k + 1 ) % n;
		const v0 = values[ k ], v1 = values[ next ];
		const w0 = v0 === undefined ? 0 : 1, w1 = v1 === undefined ? 0 : 1;
		if ( w0 + w1 === 0 ) continue;
		const from = stations[ k ];
		const span = mod( stations[ next ] - from, count ) || count;
		const first = Math.ceil( from );
		for ( let s = first; s < from + span; s ++ ) {

			const u = smoothstep( 0, 1, ( s - from ) / span );
			const a = w0 * ( 1 - u ), b = w1 * u;
			const i = mod( s, count );
			weight[ i ] = a + b;
			value[ i ] = ( a * ( v0 ?? 0 ) + b * ( v1 ?? 0 ) ) / ( a + b || 1 );

		}

	}

	return { value, weight };

}

/**
 * Periodic cubic Hermite interpolation through (station, value) knots, evaluated at every sample.
 * @param {number[]} stations ascending knot positions in [0, count)
 * @param {number[]} values knot values
 * @param {number} count number of samples
 * @returns {Float64Array}
 */
function interpolateKnotsPeriodic( stations, values, count ) {

	const out = new Float64Array( count );
	const n = stations.length;
	if ( n === 0 ) return out;
	if ( n === 1 ) return out.fill( values[ 0 ] );
	const slopes = new Float64Array( n );
	for ( let k = 0; k < n; k ++ ) {

		const prev = ( k + n - 1 ) % n, next = ( k + 1 ) % n;
		const before = mod( stations[ k ] - stations[ prev ], count ) || count;
		const after = mod( stations[ next ] - stations[ k ], count ) || count;
		slopes[ k ] = ( values[ next ] - values[ prev ] ) / ( before + after );

	}

	for ( let k = 0; k < n; k ++ ) {

		const next = ( k + 1 ) % n;
		const from = stations[ k ];
		const span = mod( stations[ next ] - from, count ) || count;
		for ( let s = Math.ceil( from ); s < from + span; s ++ ) {

			const t = ( s - from ) / span, t2 = t * t, t3 = t2 * t;
			out[ mod( s, count ) ] = ( 2 * t3 - 3 * t2 + 1 ) * values[ k ] + ( t3 - 2 * t2 + t ) * span * slopes[ k ]
				+ ( 3 * t2 - 2 * t3 ) * values[ next ] + ( t3 - t2 ) * span * slopes[ next ];

		}

	}

	return out;

}

/**
 * One relaxation sweep of the elevation limiter: every violated constraint (grade of a segment, vertical curvature at
 * a node, minimum height) is fixed by the smallest possible change of the nodes involved.
 * @param {Float64Array} ys node heights (modified in place)
 * @param {number} h node spacing in meters
 * @param {number} maxGrade
 * @param {Float64Array} crest per-node limit of the crest curvature (1 / radius, positive)
 * @param {Float64Array} sag per-node limit of the sag curvature (1 / radius, positive)
 * @param {number} minY
 * @returns {number} largest violation found, relative to its limit
 */
function limiterSweep( ys, h, maxGrade, crest, sag, minY ) {

	const m = ys.length;
	const maxStep = maxGrade * h, h2 = h * h;
	let worst = 0;
	for ( let k = 0; k < m; k ++ ) {

		const j = k + 1 === m ? 0 : k + 1;
		const rise = ys[ j ] - ys[ k ];
		const excess = rise > maxStep ? rise - maxStep : rise < - maxStep ? rise + maxStep : 0;
		if ( excess !== 0 ) {

			ys[ k ] += excess / 2;
			ys[ j ] -= excess / 2;
			worst = Math.max( worst, Math.abs( excess ) / maxStep );

		}

	}

	for ( let k = 0; k < m; k ++ ) {

		const i = k === 0 ? m - 1 : k - 1, j = k + 1 === m ? 0 : k + 1;
		const bend = ys[ i ] - 2 * ys[ k ] + ys[ j ];
		const hi = sag[ k ] * h2, lo = - crest[ k ] * h2;
		const excess = bend > hi ? bend - hi : bend < lo ? bend - lo : 0;
		if ( excess !== 0 ) {

			ys[ i ] -= excess / 6;
			ys[ k ] += excess / 3;
			ys[ j ] -= excess / 6;
			worst = Math.max( worst, Math.abs( excess ) / ( bend > 0 ? hi : - lo ) );

		}

	}

	for ( let k = 0; k < m; k ++ ) {

		if ( ys[ k ] < minY ) {

			worst = Math.max( worst, ( minY - ys[ k ] ) / 10 );
			ys[ k ] = minY;

		}

	}

	return worst;

}

/**
 * Enforces the grade, vertical-curvature and minimum-height limits on a periodic height profile sampled every meter.
 * Works coarse to fine so that long violations (a ramp that is too steep for hundreds of meters) are resolved as
 * quickly as short ones; the profile is only changed where a limit is exceeded.
 * @param {Float64Array} ys heights per sample (modified in place)
 * @param {{maxGrade: number, crest: Float64Array, sag: Float64Array, minY: number}} limits `crest` and `sag` hold the
 *        per-sample limits of the vertical curvature (1 / radius)
 * @returns {{sweeps: number, residual: number}} total sweeps used and the remaining relative violation
 */
function limitProfile( ys, limits ) {

	const n = ys.length;
	let sweeps = 0, residual = 0;
	for ( const stride of LIMITER_STRIDES ) {

		const m = stride === 1 ? n : Math.round( n / stride );
		if ( m < 16 ) continue;
		const h = n / m;
		// Coarse levels aim slightly inside the limits so that the finer levels have little left to do.
		const tighten = stride === 1 ? 1 : 0.97;
		const nodes = new Float64Array( m ), before = new Float64Array( m ), crest = new Float64Array( m ), sag = new Float64Array( m );
		for ( let k = 0; k < m; k ++ ) {

			const position = k * h;
			const i = Math.floor( position ), f = position - i;
			nodes[ k ] = ys[ i % n ] + ( ys[ ( i + 1 ) % n ] - ys[ i % n ] ) * f;
			// A locally relaxed limit must survive on the coarse levels: take the loosest one around the node.
			let loosestCrest = 0, loosestSag = 0;
			const reach = Math.floor( h / 2 );
			for ( let o = - reach; o <= reach; o ++ ) {

				const near = mod( i + o, n );
				loosestCrest = Math.max( loosestCrest, limits.crest[ near ] );
				loosestSag = Math.max( loosestSag, limits.sag[ near ] );

			}

			crest[ k ] = loosestCrest * tighten;
			sag[ k ] = loosestSag * tighten;

		}

		before.set( nodes );
		residual = 0;
		for ( let sweep = 0; sweep < LIMITER_MAX_SWEEPS; sweep ++ ) {

			residual = limiterSweep( nodes, h, limits.maxGrade * tighten, crest, sag, limits.minY );
			sweeps ++;
			if ( residual < 2e-3 ) break;

		}

		if ( stride === 1 ) {

			ys.set( nodes );

		} else {

			for ( let k = 0; k < m; k ++ ) before[ k ] = nodes[ k ] - before[ k ];
			for ( let i = 0; i < n; i ++ ) ys[ i ] += samplePeriodicCubic( before, i / h );

		}

	}

	return { sweeps, residual };

}

/**
 * Finds the station (s) of the sample-polyline point nearest to a position, searching around an estimate.
 * @param {Float64Array} xs
 * @param {Float64Array} zs
 * @param {number} x
 * @param {number} z
 * @param {number} estimate approximate station
 * @param {number} reach half width of the search window in samples
 * @returns {number} station in [0, count)
 */
function nearestStation( xs, zs, x, z, estimate, reach ) {

	const n = xs.length;
	const centre = Math.round( estimate );
	let best = centre, bestD2 = Infinity;
	for ( let o = - reach; o <= reach; o ++ ) {

		const i = mod( centre + o, n );
		const d2 = ( xs[ i ] - x ) ** 2 + ( zs[ i ] - z ) ** 2;
		if ( d2 < bestD2 ) {

			bestD2 = d2;
			best = centre + o;

		}

	}

	// Refine along the two adjacent segments.
	const i = mod( best, n ), prev = mod( best - 1, n ), next = mod( best + 1, n );
	const ex = xs[ next ] - xs[ prev ], ez = zs[ next ] - zs[ prev ];
	const along = ( ( x - xs[ i ] ) * ex + ( z - zs[ i ] ) * ez ) / Math.hypot( ex, ez );
	return mod( best + clamp( along, - 1, 1 ), n );

}

/**
 * The circuit: a closed road centreline with elevation, banking and width, sampled every meter.
 *
 * All per-sample arrays have `count` entries (vectors: 3 * count, xyz interleaved); sample i sits at s = i.
 * Query methods accept any real s (it wraps around the lap) and never allocate when an `out` argument is passed.
 */
export class Track {

	/**
	 * Builds the track from a layout (see src/sim/layout.js for the format). Deterministic.
	 * @param {object} layout the LAYOUT object
	 * @param {object} [options]
	 * @param {(x: number, z: number) => number} [options.heightFn] terrain height used where the layout gives no explicit road height (default: baseHeight)
	 * @param {number} [options.waterLevel] y of the water surface (default: WORLD.waterLevel)
	 */
	constructor( layout, { heightFn = baseHeight, waterLevel = WORLD.waterLevel } = {} ) {

		if ( ! layout.closed ) throw new Error( 'Track: only closed layouts are supported' );
		if ( layout.controlPoints.length < 4 ) throw new Error( 'Track: a layout needs at least 4 control points' );

		/** The layout this track was built from. */
		this.layout = layout;
		/** Always true: the centreline is a loop. */
		this.closed = true;
		/** Distance between samples in meters (exactly 1). */
		this.spacing = SAMPLE_SPACING;
		/** Number of samples; equals `length` because the spacing is 1 m. */
		this.count = 0;
		/** Lap length in meters, measured along the centreline in plan view (a whole number). */
		this.length = 0;
		/** Factor by which the curve was scaled about the origin to make the length a whole number (|scale - 1| <= 0.5 / length). */
		this.scale = 1;
		/** @type {Float64Array} s of every control point (ascending, controlPointS[0] = 0). */
		this.controlPointS = null;
		/** @type {Float64Array} centreline x per sample. */
		this.xs = null;
		/** @type {Float64Array} road surface height at the centreline per sample. */
		this.ys = null;
		/** @type {Float64Array} centreline z per sample. */
		this.zs = null;
		/** @type {Float64Array} unit tangents (driving direction, including the slope), xyz interleaved. */
		this.tangents = null;
		/** @type {Float64Array} unit left vectors in the road surface (including banking), xyz interleaved. */
		this.lefts = null;
		/** @type {Float64Array} unit road-surface normals (tangent x left), xyz interleaved. */
		this.ups = null;
		/** @type {Float64Array} signed horizontal curvature in 1/m per sample (positive = left turn). */
		this.curvatures = null;
		/** @type {Float64Array} half of the paved width in meters per sample. */
		this.halfWidths = null;
		/** @type {Float64Array} banking angle in rad per sample (positive = left edge lower). */
		this.banks = null;
		/** @type {Float64Array} longitudinal slope dy/ds per sample (positive = uphill). */
		this.grades = null;
		/** @type {Float64Array} heading per sample in rad (yaw convention of constants.js; not unwrapped). */
		this.yaws = null;
		/**
		 * Diagnostics of the elevation build: limiter sweeps used, remaining relative limit violation (0 = none) and the
		 * largest deviation in meters from an explicit control-point height (limits win over explicit heights).
		 * @type {{sweeps: number, residual: number, maxPinError: number}}
		 */
		this.elevationInfo = { sweeps: 0, residual: 0, maxPinError: 0 };
		/** @type {number[]} s where the three sectors start: [0, s1, s2]. */
		this.sectors = [];
		/** @type {{index: number, s: number}[]} lap-validation checkpoints; index 0 is the start / finish line at s = 0. */
		this.checkpoints = [];
		/** s of the rolling-start spawn position (length - layout.gridOffset). */
		this.gridS = 0;
		/** @type {{name: string, s: number, x: number, y: number, z: number}[]} named corners with their centreline position. */
		this.corners = [];

		this._frame = /** @type {TrackFrame} */ ( {} );
		this._leftHorizontal = null; // horizontal length of the left vector per sample
		this._leftAlong = null; // component of the left vector along the horizontal tangent per sample
		this._hashMinX = 0;
		this._hashMinZ = 0;
		this._hashNx = 0;
		this._hashNz = 0;
		this._hashStart = null;
		this._hashItems = null;

		this._buildCurve( layout );
		this._buildProfiles( layout, heightFn, waterLevel );
		this._buildFrames();
		this._buildHash();
		this._buildMarkers( layout );

	}

	/** Horizontal curve: spline -> smoothing -> whole-meter length -> 1 m samples, heading and curvature. */
	_buildCurve( layout ) {

		const points = layout.controlPoints;
		const dense = tessellateSpline( points );
		let arc = cumulativeLength( dense.xs, dense.zs );
		const rawLength = arc[ dense.xs.length ];
		const fractions = dense.starts.map( ( index ) => arc[ index ] / rawLength );

		// Uniform fine polyline, rounded with a Gaussian so that the curvature becomes continuous and smooth.
		let fine = resampleClosed( dense.xs, dense.zs, arc, Math.round( rawLength * FINE_PER_SAMPLE / SAMPLE_SPACING ) );
		const sigma = ( layout.smoothing ?? 4 ) * FINE_PER_SAMPLE / SAMPLE_SPACING;
		fine = { xs: smoothPeriodic( fine.xs, sigma ), zs: smoothPeriodic( fine.zs, sigma ) };

		// Scale to a whole number of meters and resample until the samples are equally spaced.
		arc = cumulativeLength( fine.xs, fine.zs );
		const count = Math.round( arc[ fine.xs.length ] / SAMPLE_SPACING );
		let scale = 1;
		for ( let pass = 0; pass < 3; pass ++ ) {

			const factor = count * SAMPLE_SPACING / arc[ fine.xs.length ];
			scale *= factor;
			fine = resampleClosed( fine.xs, fine.zs, arc, count * FINE_PER_SAMPLE, factor );
			arc = cumulativeLength( fine.xs, fine.zs );

		}

		this.count = count;
		this.length = count * SAMPLE_SPACING;
		this.scale = scale;
		const xs = this.xs = new Float64Array( count );
		const zs = this.zs = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) {

			xs[ i ] = fine.xs[ i * FINE_PER_SAMPLE ];
			zs[ i ] = fine.zs[ i * FINE_PER_SAMPLE ];

		}

		const yaws = this.yaws = new Float64Array( count );
		const curvatures = this.curvatures = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) {

			const prev = i === 0 ? count - 1 : i - 1, next = i + 1 === count ? 0 : i + 1;
			const ax = xs[ i ] - xs[ prev ], az = zs[ i ] - zs[ prev ];
			const bx = xs[ next ] - xs[ i ], bz = zs[ next ] - zs[ i ];
			yaws[ i ] = Math.atan2( - ( ax + bx ), - ( az + bz ) );
			// Turning angle between the two chords over their mean length; a left turn (towards -X when heading -Z) is positive.
			const turn = Math.atan2( az * bx - ax * bz, ax * bx + az * bz );
			curvatures[ i ] = turn / ( 0.5 * ( Math.hypot( ax, az ) + Math.hypot( bx, bz ) ) );

		}

		const stations = this.controlPointS = new Float64Array( points.length );
		for ( let k = 1; k < points.length; k ++ ) {

			stations[ k ] = nearestStation( xs, zs, points[ k ].x * scale, points[ k ].z * scale, fractions[ k ] * count, 40 );
			if ( stations[ k ] <= stations[ k - 1 ] ) throw new Error( `Track: control point ${k} does not advance along the curve` );

		}

	}

	/** Elevation profile, width and banking per sample. */
	_buildProfiles( layout, heightFn, waterLevel ) {

		const count = this.count, points = layout.controlPoints, stations = this.controlPointS;
		const elevation = { ...DEFAULT_ELEVATION, ...layout.elevation };
		const banking = { ...DEFAULT_BANKING, ...layout.banking };

		// Height: smoothed terrain under the route, bent through the explicit control-point heights.
		const ground = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) ground[ i ] = heightFn( this.xs[ i ], this.zs[ i ] );
		const smoothGround = smoothPeriodic( ground, elevation.smoothing / SAMPLE_SPACING );
		const pinStations = [], pinHeights = [], pinOffsets = [];
		for ( let k = 0; k < points.length; k ++ ) {

			if ( points[ k ].y === undefined ) continue;
			pinStations.push( stations[ k ] );
			pinHeights.push( points[ k ].y );

		}

		const follow = pinStations.length > 0 ? elevation.terrainFollow : 1;
		let ys = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) ys[ i ] = follow * ( smoothGround[ i ] + elevation.offset );
		if ( pinStations.length > 0 ) {

			for ( let p = 0; p < pinStations.length; p ++ ) pinOffsets.push( pinHeights[ p ] - sampleLoop( ys, pinStations[ p ] ) );
			const offsets = interpolateKnotsPeriodic( pinStations, pinOffsets, count );
			for ( let i = 0; i < count; i ++ ) ys[ i ] += offsets[ i ];
			ys = smoothPeriodic( ys, PROFILE_BLEND_SIGMA / SAMPLE_SPACING );

		}

		// Vertical curvature limits: a minimum radius, tightened where the estimated speed would make the car go light
		// over a crest or load it up too much through a dip. A control point may relax the crest limit locally.
		const speeds = estimateSpeedProfile( this );
		const crest = new Float64Array( count ), sag = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) {

			const perG = GRAVITY / ( speeds[ i ] * speeds[ i ] );
			crest[ i ] = Math.min( 1 / elevation.minCrestRadius, elevation.maxCrestG * perG );
			sag[ i ] = Math.min( 1 / elevation.minSagRadius, elevation.maxSagG * perG );

		}

		for ( let k = 0; k < points.length; k ++ ) {

			if ( points[ k ].crestRadius === undefined ) continue;
			const reach = Math.round( elevation.crestSpan / 2 / SAMPLE_SPACING );
			const centre = Math.round( stations[ k ] );
			for ( let o = - reach; o <= reach; o ++ ) {

				const i = mod( centre + o, count );
				crest[ i ] = Math.min( 1 / points[ k ].crestRadius, elevation.relaxedCrestG * GRAVITY / ( speeds[ i ] * speeds[ i ] ) );

			}


		}

		const result = limitProfile( ys, { maxGrade: elevation.maxGrade, crest, sag, minY: waterLevel + elevation.minHeight } );
		// The limiter leaves the profile exactly on its limits, with abrupt transitions; a final light smoothing rounds
		// them (averaging keeps a profile within grade, curvature and height bounds).
		ys = smoothPeriodic( ys, elevation.finalSmoothing / SAMPLE_SPACING );
		let maxPinError = 0;
		for ( let p = 0; p < pinStations.length; p ++ ) maxPinError = Math.max( maxPinError, Math.abs( sampleLoop( ys, pinStations[ p ] ) - pinHeights[ p ] ) );
		this.elevationInfo = { sweeps: result.sweeps, residual: result.residual, maxPinError };
		this.ys = ys;
		const grades = this.grades = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) grades[ i ] = ( ys[ ( i + 1 ) % count ] - ys[ ( i + count - 1 ) % count ] ) / ( 2 * SAMPLE_SPACING );

		// Width: the default, eased towards the control points that override it.
		const widthSpread = spreadControlValues( stations, points.map( ( p ) => p.width ), count );
		const widths = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) widths[ i ] = layout.defaultWidth + widthSpread.weight[ i ] * ( widthSpread.value[ i ] - layout.defaultWidth );
		const halfWidths = this.halfWidths = smoothPeriodic( widths, WIDTH_SMOOTHING / SAMPLE_SPACING );
		for ( let i = 0; i < count; i ++ ) halfWidths[ i ] *= 0.5;

		// Banking: follows the curvature (saturating at the maximum), eased towards explicit overrides.
		const maxBank = banking.maxDeg * DEG2RAD;
		const bankSpread = spreadControlValues( stations, points.map( ( p ) => p.bank ), count );
		const rawBanks = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) {

			const natural = maxBank * Math.tanh( banking.gain * this.curvatures[ i ] / maxBank );
			rawBanks[ i ] = natural + bankSpread.weight[ i ] * ( bankSpread.value[ i ] - natural );

		}

		const banks = this.banks = smoothPeriodic( rawBanks, banking.smoothing / SAMPLE_SPACING );
		for ( let i = 0; i < count; i ++ ) banks[ i ] = clamp( banks[ i ], - maxBank, maxBank );

	}

	/** Orthonormal frame per sample from heading, grade and bank. */
	_buildFrames() {

		const count = this.count;
		const tangents = this.tangents = new Float64Array( count * 3 );
		const lefts = this.lefts = new Float64Array( count * 3 );
		const ups = this.ups = new Float64Array( count * 3 );
		const leftHorizontal = this._leftHorizontal = new Float64Array( count );
		const leftAlong = this._leftAlong = new Float64Array( count );
		for ( let i = 0; i < count; i ++ ) {

			// Horizontal heading (hx, hz), then the tangent tilted by the grade.
			const hx = - Math.sin( this.yaws[ i ] ), hz = - Math.cos( this.yaws[ i ] );
			const run = 1 / Math.hypot( 1, this.grades[ i ] );
			const tx = hx * run, ty = this.grades[ i ] * run, tz = hz * run;
			// Unbanked left = worldUp x heading (horizontal); unbanked normal = tangent x left.
			const fx = hz, fz = - hx;
			const nx = ty * fz, ny = tz * fx - tx * fz, nz = - ty * fx;
			// Banking rotates the left vector about the tangent: positive bank lowers the left edge.
			const cosBank = Math.cos( this.banks[ i ] ), sinBank = Math.sin( this.banks[ i ] );
			const lx = fx * cosBank - nx * sinBank, ly = - ny * sinBank, lz = fz * cosBank - nz * sinBank;
			const o = i * 3;
			tangents[ o ] = tx; tangents[ o + 1 ] = ty; tangents[ o + 2 ] = tz;
			lefts[ o ] = lx; lefts[ o + 1 ] = ly; lefts[ o + 2 ] = lz;
			ups[ o ] = ty * lz - tz * ly; ups[ o + 1 ] = tz * lx - tx * lz; ups[ o + 2 ] = tx * ly - ty * lx;
			leftHorizontal[ i ] = lx * fx + lz * fz;
			leftAlong[ i ] = lx * hx + lz * hz;

		}

	}

	/** Spatial hash of the samples for the global projection. */
	_buildHash() {

		const count = this.count, xs = this.xs, zs = this.zs;
		let minX = Infinity, minZ = Infinity, maxX = - Infinity, maxZ = - Infinity;
		for ( let i = 0; i < count; i ++ ) {

			minX = Math.min( minX, xs[ i ] ); maxX = Math.max( maxX, xs[ i ] );
			minZ = Math.min( minZ, zs[ i ] ); maxZ = Math.max( maxZ, zs[ i ] );

		}

		const nx = this._hashNx = Math.floor( ( maxX - minX ) / HASH_CELL ) + 1;
		const nz = this._hashNz = Math.floor( ( maxZ - minZ ) / HASH_CELL ) + 1;
		this._hashMinX = minX;
		this._hashMinZ = minZ;
		const start = this._hashStart = new Uint32Array( nx * nz + 1 );
		const cellOf = new Uint32Array( count );
		for ( let i = 0; i < count; i ++ ) {

			cellOf[ i ] = Math.floor( ( zs[ i ] - minZ ) / HASH_CELL ) * nx + Math.floor( ( xs[ i ] - minX ) / HASH_CELL );
			start[ cellOf[ i ] + 1 ] ++;

		}

		for ( let c = 0; c < nx * nz; c ++ ) start[ c + 1 ] += start[ c ];
		const items = this._hashItems = new Uint32Array( count );
		const cursor = start.slice( 0, nx * nz );
		for ( let i = 0; i < count; i ++ ) items[ cursor[ cellOf[ i ] ] ++ ] = i;

	}

	/** Sectors, checkpoints, grid position and named corners. */
	_buildMarkers( layout ) {

		const length = this.length;
		this.sectors = layout.sectors.map( ( fraction ) => fraction * length );
		const checkpointCount = Math.max( 3, Math.round( length / layout.checkpointSpacing ) );
		this.checkpoints = [];
		for ( let index = 0; index < checkpointCount; index ++ ) this.checkpoints.push( { index, s: index * length / checkpointCount } );
		this.gridS = length - layout.gridOffset;
		this.corners = ( layout.corners ?? [] ).map( ( corner ) => {

			const s = mod( corner.cp === undefined ? corner.s : this.controlPointS[ corner.cp ] + ( corner.offset ?? 0 ), length );
			const position = this.pointAt( s );
			return { name: corner.name, s, x: position[ 0 ], y: position[ 1 ], z: position[ 2 ] };

		} );

	}

	/**
	 * The centreline frame at distance s (interpolated between samples; s wraps around the lap).
	 * @param {number} s distance along the centreline in meters
	 * @param {TrackFrame} [out] object to fill; pass one to avoid an allocation
	 * @returns {TrackFrame} out
	 */
	frameAt( s, out = {} ) {

		const count = this.count;
		if ( s < 0 || s >= count ) s = mod( s, count );
		let i = Math.floor( s );
		if ( i >= count ) {

			i = 0;
			s = 0;

		}

		const f = s - i, g = 1 - f;
		const j = i + 1 === count ? 0 : i + 1;
		const a = i * 3, b = j * 3;
		const tangents = this.tangents, lefts = this.lefts;
		out.s = s;
		out.x = this.xs[ i ] * g + this.xs[ j ] * f;
		out.y = this.ys[ i ] * g + this.ys[ j ] * f;
		out.z = this.zs[ i ] * g + this.zs[ j ] * f;

		let tx = tangents[ a ] * g + tangents[ b ] * f, ty = tangents[ a + 1 ] * g + tangents[ b + 1 ] * f, tz = tangents[ a + 2 ] * g + tangents[ b + 2 ] * f;
		let inv = 1 / Math.sqrt( tx * tx + ty * ty + tz * tz );
		tx *= inv; ty *= inv; tz *= inv;
		// The interpolated left vector is made perpendicular to the tangent again before it is normalised.
		let lx = lefts[ a ] * g + lefts[ b ] * f, ly = lefts[ a + 1 ] * g + lefts[ b + 1 ] * f, lz = lefts[ a + 2 ] * g + lefts[ b + 2 ] * f;
		const along = lx * tx + ly * ty + lz * tz;
		lx -= along * tx; ly -= along * ty; lz -= along * tz;
		inv = 1 / Math.sqrt( lx * lx + ly * ly + lz * lz );
		lx *= inv; ly *= inv; lz *= inv;
		out.tx = tx; out.ty = ty; out.tz = tz;
		out.lx = lx; out.ly = ly; out.lz = lz;
		out.ux = ty * lz - tz * ly;
		out.uy = tz * lx - tx * lz;
		out.uz = tx * ly - ty * lx;
		out.curvature = this.curvatures[ i ] * g + this.curvatures[ j ] * f;
		out.halfWidth = this.halfWidths[ i ] * g + this.halfWidths[ j ] * f;
		out.bank = this.banks[ i ] * g + this.banks[ j ] * f;
		out.grade = this.grades[ i ] * g + this.grades[ j ] * f;
		return out;

	}

	/**
	 * Road-surface position P(s, d) = centre(s) + d * left(s).
	 * @param {number} s distance along the centreline in meters (wraps)
	 * @param {number} [d=0] lateral offset in meters, positive = left
	 * @param {number[]} [out] receives [x, y, z]; pass an array to avoid an allocation
	 * @returns {number[]} out
	 */
	pointAt( s, d = 0, out = [ 0, 0, 0 ] ) {

		const frame = this.frameAt( s, this._frame );
		out[ 0 ] = frame.x + d * frame.lx;
		out[ 1 ] = frame.y + d * frame.ly;
		out[ 2 ] = frame.z + d * frame.lz;
		return out;

	}

	/**
	 * Projects a world position onto the track in the horizontal plane (y is ignored). The result is the inverse of
	 * pointAt(): project( P(s, d) ) returns (s, d) as long as |d| is smaller than the local radius of curvature.
	 * s varies smoothly with the position (the projection uses the interpolated tangent, not the faceted polyline).
	 *
	 * WITHOUT hintS: global search through a spatial hash; returns the nearest part of the centreline wherever the
	 * position is. Within 128 m of the road the result is exact; farther away, where a coarse scan takes over, two parts
	 * of the road at almost the same distance (within a few centimeters) may be confused.
	 *
	 * WITH hintS (the s of the previous projection of the same object): walks along the centreline from the hint to the
	 * nearest local minimum of the distance. This is fast and continuous along a car's path, and between two legs of a
	 * switchback it keeps following the leg the car came from, even where the other leg happens to be closer. Only when
	 * the result is more than 12 m beyond the road edge is a global search made as well; the projection then moves to
	 * another part of the road if that part is less than half as far away (a car that left the road and reached another
	 * leg is picked up there, a car sliding wide is not). A hint more than 64 m off also falls back to the global search.
	 * @param {number} x world x
	 * @param {number} z world z
	 * @param {number} [hintS] s near which to search
	 * @param {TrackProjection} [out] object to fill; pass one to avoid an allocation
	 * @returns {TrackProjection} out
	 */
	project( x, z, hintS = undefined, out = {} ) {

		if ( hintS === undefined ) return this._projectNear( x, z, this._nearestSampleGlobal( x, z ), out );
		let index = this._nearestSampleLocal( x, z, hintS );
		if ( index < 0 ) index = this._nearestSampleGlobal( x, z );
		this._projectNear( x, z, index, out );
		if ( Math.abs( out.d ) > out.halfWidth + RELOCALIZE_MARGIN ) {

			const other = this._nearestSampleGlobal( x, z );
			if ( other !== index ) {

				const local2 = ( this.xs[ index ] - x ) ** 2 + ( this.zs[ index ] - z ) ** 2;
				const other2 = ( this.xs[ other ] - x ) ** 2 + ( this.zs[ other ] - z ) ** 2;
				if ( other2 < RELOCALIZE_RATIO * RELOCALIZE_RATIO * local2 ) this._projectNear( x, z, other, out );

			}

		}

		return out;

	}

	/** Walks from the hint to the nearest sample that is a local minimum of the distance; -1 if the walk is too long. */
	_nearestSampleLocal( x, z, hintS ) {

		const count = this.count, xs = this.xs, zs = this.zs;
		let i = Math.floor( hintS < 0 || hintS >= count ? mod( hintS, count ) : hintS );
		if ( ! ( i < count ) ) i = 0; // also catches a NaN hint
		let best = ( xs[ i ] - x ) ** 2 + ( zs[ i ] - z ) ** 2;
		let steps = 0;
		let j = i + 1 === count ? 0 : i + 1;
		let candidate = ( xs[ j ] - x ) ** 2 + ( zs[ j ] - z ) ** 2;
		const direction = candidate < best ? 1 : - 1;
		if ( direction < 0 ) {

			j = i === 0 ? count - 1 : i - 1;
			candidate = ( xs[ j ] - x ) ** 2 + ( zs[ j ] - z ) ** 2;

		}

		while ( candidate < best ) {

			if ( ++ steps > MAX_LOCAL_STEPS ) return - 1;
			i = j;
			best = candidate;
			j = i + direction;
			if ( j === count ) j = 0;
			else if ( j < 0 ) j = count - 1;
			candidate = ( xs[ j ] - x ) ** 2 + ( zs[ j ] - z ) ** 2;

		}

		return i;

	}

	/** Index of the sample nearest to (x, z) anywhere on the track. */
	_nearestSampleGlobal( x, z ) {

		const nx = this._hashNx, nz = this._hashNz, start = this._hashStart, items = this._hashItems, xs = this.xs, zs = this.zs;
		const cx = clamp( Math.floor( ( x - this._hashMinX ) / HASH_CELL ), 0, nx - 1 );
		const cz = clamp( Math.floor( ( z - this._hashMinZ ) / HASH_CELL ), 0, nz - 1 );
		let best = Infinity, bestIndex = 0;
		for ( let ring = 0; ring <= GLOBAL_EXACT_RINGS; ring ++ ) {

			const z0 = cz - ring, z1 = cz + ring, x0 = cx - ring, x1 = cx + ring;
			for ( let iz = Math.max( z0, 0 ); iz <= Math.min( z1, nz - 1 ); iz ++ ) {

				// Full rows at the top and bottom of the ring, only the two end cells in between.
				const edgeRow = iz === z0 || iz === z1;
				const stride = edgeRow || ring === 0 ? 1 : 2 * ring;
				for ( let ix = x0; ix <= x1; ix += stride ) {

					if ( ix < 0 || ix >= nx ) continue;
					const cell = iz * nx + ix;
					for ( let k = start[ cell ]; k < start[ cell + 1 ]; k ++ ) {

						const i = items[ k ];
						const d2 = ( xs[ i ] - x ) ** 2 + ( zs[ i ] - z ) ** 2;
						if ( d2 < best ) {

							best = d2;
							bestIndex = i;

						}

					}

				}

			}

			// Every sample outside the rings visited so far is at least ring * HASH_CELL away.
			const reach = ring * HASH_CELL;
			if ( best <= reach * reach ) return bestIndex;

		}

		// Far away from the road: scan every few samples, then settle on the best one around the winner.
		const count = this.count;
		best = Infinity;
		for ( let i = 0; i < count; i += GLOBAL_SCAN_STRIDE ) {

			const d2 = ( xs[ i ] - x ) ** 2 + ( zs[ i ] - z ) ** 2;
			if ( d2 < best ) {

				best = d2;
				bestIndex = i;

			}

		}

		const centre = bestIndex;
		for ( let o = 1 - GLOBAL_SCAN_STRIDE; o < GLOBAL_SCAN_STRIDE; o ++ ) {

			const i = mod( centre + o, count );
			const d2 = ( xs[ i ] - x ) ** 2 + ( zs[ i ] - z ) ** 2;
			if ( d2 < best ) {

				best = d2;
				bestIndex = i;

			}

		}

		return bestIndex;

	}

	/** Refines the projection around sample `index` and fills `out`. */
	_projectNear( x, z, index, out ) {

		const count = this.count, xs = this.xs, zs = this.zs, tangents = this.tangents;
		// Start in the segment before or after the sample, depending on which side of it the position lies.
		let seg = index;
		if ( ( x - xs[ index ] ) * tangents[ index * 3 ] + ( z - zs[ index ] ) * tangents[ index * 3 + 2 ] < 0 ) seg = index === 0 ? count - 1 : index - 1;
		let next = 0, t = 0, hx = 0, hz = 0;
		for ( let hop = 0; hop < 4; hop ++ ) {

			next = seg + 1 === count ? 0 : seg + 1;
			const ex = xs[ next ] - xs[ seg ], ez = zs[ next ] - zs[ seg ];
			const wx = x - xs[ seg ], wz = z - zs[ seg ];
			const t0x = tangents[ seg * 3 ], t0z = tangents[ seg * 3 + 2 ];
			const dtx = tangents[ next * 3 ] - t0x, dtz = tangents[ next * 3 + 2 ] - t0z;
			// Solve ( Q - P(t) ) . T(t) = 0 with P and T interpolated linearly along the segment: c0 + c1 t + c2 t^2 = 0.
			const c0 = wx * t0x + wz * t0z;
			const c1 = wx * dtx + wz * dtz - ex * t0x - ez * t0z;
			const c2 = - ( ex * dtx + ez * dtz );
			if ( c1 < - 1e-6 ) {

				t = - c0 / c1;
				t -= ( c0 + ( c1 + c2 * t ) * t ) / ( c1 + 2 * c2 * t );
				t -= ( c0 + ( c1 + c2 * t ) * t ) / ( c1 + 2 * c2 * t );

			} else {

				// Beyond the centre of curvature the tangent condition degenerates: fall back to the chord.
				t = ( wx * ex + wz * ez ) / ( ex * ex + ez * ez );

			}

			hx = t0x + dtx * t;
			hz = t0z + dtz * t;
			if ( hop === 3 || ( t >= 0 && t <= 1 ) || ! ( c1 < - 1e-6 ) ) break;
			seg = t < 0 ? ( seg === 0 ? count - 1 : seg - 1 ) : next;

		}

		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const u = 1 - t;
		const px = xs[ seg ] + ( xs[ next ] - xs[ seg ] ) * t, pz = zs[ seg ] + ( zs[ next ] - zs[ seg ] ) * t;
		// Horizontal left = ( hz, -hx ) normalised; the banked left vector is shorter in plan view and leans along the road.
		const lateral = ( ( x - px ) * hz - ( z - pz ) * hx ) / Math.sqrt( hx * hx + hz * hz );
		const d = lateral / ( this._leftHorizontal[ seg ] * u + this._leftHorizontal[ next ] * t );
		// On a banked slope the left vector also leans along the road; undo that shift (scaled by the lever of the curve).
		const lever = 1 - d * ( this.curvatures[ seg ] * u + this.curvatures[ next ] * t );
		let s = seg + t - d * ( this._leftAlong[ seg ] * u + this._leftAlong[ next ] * t ) / ( lever > 0.25 ? lever : 0.25 );
		if ( s < 0 ) s += count;
		else if ( s >= count ) s -= count;
		out.s = s;
		out.d = d;
		out.halfWidth = this.halfWidths[ seg ] * u + this.halfWidths[ next ] * t;
		out.onRoad = Math.abs( d ) <= out.halfWidth;
		return out;

	}

	/**
	 * Signed horizontal curvature at s in 1/m (positive = left turn).
	 * @param {number} s
	 * @returns {number}
	 */
	curvatureAt( s ) {

		return sampleLoop( this.curvatures, s );

	}

	/**
	 * Half of the paved width at s in meters.
	 * @param {number} s
	 * @returns {number}
	 */
	halfWidthAt( s ) {

		return sampleLoop( this.halfWidths, s );

	}

	/**
	 * Banking angle at s in rad (positive = left edge lower).
	 * @param {number} s
	 * @returns {number}
	 */
	bankAt( s ) {

		return sampleLoop( this.banks, s );

	}

	/**
	 * Longitudinal slope dy/ds at s (positive = uphill).
	 * @param {number} s
	 * @returns {number}
	 */
	gradeAt( s ) {

		return sampleLoop( this.grades, s );

	}

	/**
	 * Road surface height at the centreline at s.
	 * @param {number} s
	 * @returns {number}
	 */
	heightAt( s ) {

		return sampleLoop( this.ys, s );

	}

	/**
	 * Pose for placing a vehicle on the road, facing the driving direction.
	 * @param {number} s distance along the centreline (wraps)
	 * @param {number} [d=0] lateral offset, positive = left
	 * @returns {SpawnPose} a new object: position on the road surface and the yaw of the driving direction
	 */
	spawnPose( s, d = 0 ) {

		const frame = this.frameAt( s, this._frame );
		return {
			position: [ frame.x + d * frame.lx, frame.y + d * frame.ly, frame.z + d * frame.lz ],
			yaw: Math.atan2( - frame.tx, - frame.tz ),
		};

	}

	/**
	 * The centreline in plan view for the minimap.
	 * @param {number} [step=5] approximate distance between points in meters
	 * @returns {Float32Array} [x0, z0, x1, z1, ...] around the lap (the first point is not repeated at the end)
	 */
	polyline( step = 5 ) {

		const points = Math.max( 3, Math.round( this.length / step ) );
		const out = new Float32Array( points * 2 );
		for ( let k = 0; k < points; k ++ ) {

			const frame = this.frameAt( k * this.length / points, this._frame );
			out[ k * 2 ] = frame.x;
			out[ k * 2 + 1 ] = frame.z;

		}

		return out;

	}

}

/**
 * Linear interpolation of a periodic per-sample array at a fractional index.
 * @param {ArrayLike<number>} values
 * @param {number} s fractional index (wraps)
 * @returns {number}
 */
function sampleLoop( values, s ) {

	const count = values.length;
	if ( s < 0 || s >= count ) s = mod( s, count );
	let i = Math.floor( s );
	if ( i >= count ) {

		i = 0;
		s = 0;

	}

	const j = i + 1 === count ? 0 : i + 1;
	return values[ i ] + ( values[ j ] - values[ i ] ) * ( s - i );

}
