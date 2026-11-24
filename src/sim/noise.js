// Deterministic seeded 2D noise (simplex) and the usual fractal helpers built on top of it.
// Identical results in Node and in every browser: only integer hashing and IEEE double arithmetic are used.
// The functions are evaluated tens of millions of times while the world is baked, so they are written for speed:
// table lookups, no allocation, no closures created per call.

const F2 = 0.5 * ( Math.sqrt( 3 ) - 1 );
const G2 = ( 3 - Math.sqrt( 3 ) ) / 6;
const GRADIENT_COUNT = 16;
/** Scales the raw simplex sum so that the output spans [-1, 1] (analytic maximum of the 2D simplex kernel, unit gradients). */
const OUTPUT_SCALE = 99.2043345;

/**
 * Creates a seeded 2D simplex noise function.
 * The result is continuous (C1), has a feature size of about one unit and averages to zero.
 * @param {number} seed any integer; different seeds give unrelated fields
 * @returns {(x: number, y: number) => number} noise function with values in [-1, 1]
 */
export function createNoise2D( seed ) {

	// Permutation table shuffled with a small xorshift generator seeded from `seed`.
	const perm = new Uint8Array( 512 );
	for ( let i = 0; i < 256; i ++ ) perm[ i ] = i;
	let state = ( seed | 0 ) ^ 0x9e3779b9;
	if ( state === 0 ) state = 0x6d2b79f5;
	for ( let i = 255; i > 0; i -- ) {

		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		const j = ( state >>> 0 ) % ( i + 1 );
		const swap = perm[ i ];
		perm[ i ] = perm[ j ];
		perm[ j ] = swap;

	}

	for ( let i = 0; i < 256; i ++ ) perm[ i + 256 ] = perm[ i ];

	// Unit gradients evenly spread around the circle, indexed by the hashed lattice corner.
	const gradX = new Float64Array( 512 );
	const gradY = new Float64Array( 512 );
	for ( let i = 0; i < 512; i ++ ) {

		const angle = ( ( perm[ i ] % GRADIENT_COUNT ) + 0.5 ) * ( 2 * Math.PI / GRADIENT_COUNT );
		gradX[ i ] = Math.cos( angle );
		gradY[ i ] = Math.sin( angle );

	}

	return function noise2D( x, y ) {

		const skew = ( x + y ) * F2;
		const i = Math.floor( x + skew );
		const j = Math.floor( y + skew );
		const unskew = ( i + j ) * G2;
		const x0 = x - i + unskew;
		const y0 = y - j + unskew;
		const i1 = x0 > y0 ? 1 : 0;
		const j1 = 1 - i1;
		const x1 = x0 - i1 + G2;
		const y1 = y0 - j1 + G2;
		const x2 = x0 - 1 + 2 * G2;
		const y2 = y0 - 1 + 2 * G2;
		const ii = i & 255;
		const jj = j & 255;

		let sum = 0;
		let t = 0.5 - x0 * x0 - y0 * y0;
		if ( t > 0 ) {

			const g = ii + perm[ jj ];
			t *= t;
			sum += t * t * ( gradX[ g ] * x0 + gradY[ g ] * y0 );

		}

		t = 0.5 - x1 * x1 - y1 * y1;
		if ( t > 0 ) {

			const g = ii + i1 + perm[ jj + j1 ];
			t *= t;
			sum += t * t * ( gradX[ g ] * x1 + gradY[ g ] * y1 );

		}

		t = 0.5 - x2 * x2 - y2 * y2;
		if ( t > 0 ) {

			const g = ii + 1 + perm[ jj + 1 ];
			t *= t;
			sum += t * t * ( gradX[ g ] * x2 + gradY[ g ] * y2 );

		}

		return sum * OUTPUT_SCALE;

	};

}

/**
 * Fractal Brownian motion: a sum of `octaves` noise layers, normalised to stay within [-1, 1].
 * @param {(x: number, y: number) => number} noise noise function from createNoise2D
 * @param {number} x
 * @param {number} y
 * @param {number} [octaves=5] number of layers
 * @param {number} [lacunarity=2] frequency multiplier between layers
 * @param {number} [gain=0.5] amplitude multiplier between layers
 * @returns {number} value in [-1, 1]
 */
export function fbm( noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5 ) {

	let sum = 0, amplitude = 1, total = 0;
	for ( let o = 0; o < octaves; o ++ ) {

		sum += amplitude * noise( x, y );
		total += amplitude;
		amplitude *= gain;
		// The offset decorrelates the octaves (otherwise all layers share the lattice origin).
		x = x * lacunarity + 19.19;
		y = y * lacunarity - 7.31;

	}

	return sum / total;

}

/**
 * Ridged multifractal: sharp crests where the underlying noise crosses zero, weighted so that detail gathers on the
 * ridges and the valleys stay smooth. Good for mountain ranges.
 * @param {(x: number, y: number) => number} noise noise function from createNoise2D
 * @param {number} x
 * @param {number} y
 * @param {number} [octaves=5] number of layers
 * @param {number} [lacunarity=2] frequency multiplier between layers
 * @param {number} [gain=0.5] amplitude multiplier between layers
 * @returns {number} value in [0, 1] (1 on the ridge lines)
 */
export function ridged( noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5 ) {

	let sum = 0, amplitude = 1, total = 0, weight = 1;
	for ( let o = 0; o < octaves; o ++ ) {

		let r = 1 - Math.abs( noise( x, y ) );
		r *= r;
		sum += amplitude * r * weight;
		total += amplitude;
		weight = r < 1 ? r : 1;
		amplitude *= gain;
		x = x * lacunarity + 19.19;
		y = y * lacunarity - 7.31;

	}

	return sum / total;

}

/**
 * Domain warp: displaces a sample position by a low-frequency vector noise. Evaluate any other field at the returned
 * position to give it organic, swirled shapes.
 * @param {(x: number, y: number) => number} noise noise function from createNoise2D
 * @param {number} x
 * @param {number} y
 * @param {number} amplitude maximum displacement along each axis (same unit as x / y)
 * @param {number} frequency spatial frequency of the warp field (1 / feature size)
 * @param {number[]} [out] receives the warped position [x, y]; pass it to avoid an allocation
 * @returns {number[]} out
 */
export function warp( noise, x, y, amplitude, frequency, out = [ 0, 0 ] ) {

	const fx = x * frequency, fy = y * frequency;
	out[ 0 ] = x + amplitude * noise( fx + 31.7, fy - 12.4 );
	out[ 1 ] = y + amplitude * noise( fx - 45.3, fy + 71.9 );
	return out;

}
