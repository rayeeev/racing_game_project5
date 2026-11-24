// Small dependency-free math helpers shared by the simulation (Node + browser) and the renderer.

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const KMH_PER_MS = 3.6;
export const MPH_PER_MS = 2.2369362920544;

export function clamp( x, lo, hi ) {

	return x < lo ? lo : x > hi ? hi : x;

}

export function saturate( x ) {

	return x < 0 ? 0 : x > 1 ? 1 : x;

}

export function lerp( a, b, t ) {

	return a + ( b - a ) * t;

}

export function invLerp( a, b, x ) {

	return a === b ? 0 : ( x - a ) / ( b - a );

}

/** Linear remap of x from [a0,a1] to [b0,b1] (unclamped). */
export function remap( x, a0, a1, b0, b1 ) {

	return b0 + ( b1 - b0 ) * invLerp( a0, a1, x );

}

/** Linear remap of x from [a0,a1] to [b0,b1], clamped to the output range. */
export function remapClamped( x, a0, a1, b0, b1 ) {

	return b0 + ( b1 - b0 ) * saturate( invLerp( a0, a1, x ) );

}

export function smoothstep( e0, e1, x ) {

	const t = saturate( invLerp( e0, e1, x ) );
	return t * t * ( 3 - 2 * t );

}

export function smootherstep( e0, e1, x ) {

	const t = saturate( invLerp( e0, e1, x ) );
	return t * t * t * ( t * ( t * 6 - 15 ) + 10 );

}

/**
 * Frame-rate independent exponential smoothing: moves `current` toward `target`.
 * `lambda` is the decay rate in 1/s (higher = snappier); after 1/lambda seconds ~63% of the gap is closed.
 */
export function damp( current, target, lambda, dt ) {

	return lerp( current, target, 1 - Math.exp( - lambda * dt ) );

}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function moveToward( current, target, maxDelta ) {

	const d = target - current;
	if ( Math.abs( d ) <= maxDelta ) return target;
	return current + Math.sign( d ) * maxDelta;

}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle( a ) {

	a = ( a + Math.PI ) % TAU;
	if ( a <= 0 ) a += TAU;
	return a - Math.PI;

}

/** Shortest signed angular difference b - a, in (-PI, PI]. */
export function angleDelta( a, b ) {

	return wrapAngle( b - a );

}

/** Positive modulo: result in [0, m). */
export function mod( x, m ) {

	return ( ( x % m ) + m ) % m;

}

/** Shortest signed difference b - a on a loop of length `length`, in (-length/2, length/2]. */
export function loopDelta( a, b, length ) {

	let d = mod( b - a, length );
	if ( d > length / 2 ) d -= length;
	return d;

}

export function sq( x ) {

	return x * x;

}

export function sign0( x ) {

	return x > 0 ? 1 : x < 0 ? - 1 : 0;

}

/** Catmull-Rom style cubic interpolation through p1..p2 with neighbours p0, p3 (uniform). */
export function cubic( p0, p1, p2, p3, t ) {

	const t2 = t * t, t3 = t2 * t;
	return 0.5 * ( ( 2 * p1 ) + ( - p0 + p2 ) * t + ( 2 * p0 - 5 * p1 + 4 * p2 - p3 ) * t2 + ( - p0 + 3 * p1 - 3 * p2 + p3 ) * t3 );

}

/** Piecewise-linear lookup in a table of [x, y] pairs sorted by x (clamped at the ends). */
export function tableLookup( table, x ) {

	const n = table.length;
	if ( x <= table[ 0 ][ 0 ] ) return table[ 0 ][ 1 ];
	if ( x >= table[ n - 1 ][ 0 ] ) return table[ n - 1 ][ 1 ];
	for ( let i = 1; i < n; i ++ ) {

		if ( x <= table[ i ][ 0 ] ) {

			const a = table[ i - 1 ], b = table[ i ];
			return lerp( a[ 1 ], b[ 1 ], invLerp( a[ 0 ], b[ 0 ], x ) );

		}

	}

	return table[ n - 1 ][ 1 ];

}

/** Formats seconds as m:ss.mmm (e.g. 1:42.317). Negative or non-finite values give "--:--.---". */
export function formatLapTime( seconds ) {

	if ( ! Number.isFinite( seconds ) || seconds < 0 ) return '--:--.---';
	const totalMs = Math.round( seconds * 1000 );
	const m = Math.floor( totalMs / 60000 );
	const s = Math.floor( ( totalMs % 60000 ) / 1000 );
	const ms = totalMs % 1000;
	return `${m}:${String( s ).padStart( 2, '0' )}.${String( ms ).padStart( 3, '0' )}`;

}

/** Formats a time delta in seconds as +0.123 / -1.045. */
export function formatDelta( seconds ) {

	if ( ! Number.isFinite( seconds ) ) return '';
	const sign = seconds < 0 ? '-' : '+';
	return sign + Math.abs( seconds ).toFixed( 3 );

}
