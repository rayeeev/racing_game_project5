// Deterministic random numbers (identical results in Node and every browser).

/** Returns a seeded PRNG function producing floats in [0, 1). (mulberry32) */
export function makeRng( seed ) {

	let a = ( seed >>> 0 ) || 0x9e3779b9;
	return function rng() {

		a = ( a + 0x6d2b79f5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/** Integer hash of up to three integers -> uint32. */
export function hashInt( x, y = 0, z = 0 ) {

	let h = Math.imul( x | 0, 0x27d4eb2d ) ^ Math.imul( y | 0, 0x165667b1 ) ^ Math.imul( z | 0, 0x9e3779b1 );
	h ^= h >>> 15;
	h = Math.imul( h, 0x85ebca6b );
	h ^= h >>> 13;
	h = Math.imul( h, 0xc2b2ae35 );
	h ^= h >>> 16;
	return h >>> 0;

}

/** Hash of up to three integers -> float in [0, 1). */
export function hash01( x, y = 0, z = 0 ) {

	return hashInt( x, y, z ) / 4294967296;

}

/** Random float in [lo, hi) from an rng function. */
export function randRange( rng, lo, hi ) {

	return lo + ( hi - lo ) * rng();

}

/** Approximately normal-distributed value (mean 0, std 1) from an rng function. */
export function randNormal( rng ) {

	let u = 0, v = 0;
	while ( u === 0 ) u = rng();
	while ( v === 0 ) v = rng();
	return Math.sqrt( - 2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

}

/** Picks an index according to non-negative weights. */
export function weightedPick( rng, weights ) {

	let total = 0;
	for ( let i = 0; i < weights.length; i ++ ) total += weights[ i ];
	let r = rng() * total;
	for ( let i = 0; i < weights.length; i ++ ) {

		r -= weights[ i ];
		if ( r <= 0 ) return i;

	}

	return weights.length - 1;

}
