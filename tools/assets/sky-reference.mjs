#!/usr/bin/env node
// Ground truth for the energy verification of the sky presets (used by dev/preview-sky.html?mode=energy).
//
//   node tools/assets/sky-reference.mjs
//
// For every preset it integrates the ORIGINAL full-resolution, unclipped sky.hdr on the CPU and writes
//   assets-src/sky/_ref/<id>_ref512.hdr      512x256 energy-conserving downsample of sky.hdr INCLUDING the sun
//                                            (the sun is spread over ~1 pixel, so nothing exceeds the half-float
//                                            range and three.js can use it as an exact "sun inside the IBL" reference)
//   assets-src/sky/_ref/<id>_expected.json   expected irradiance (linear RGB) on a surface facing the sun / facing up:
//       full      = exact integral of the unclipped sky.hdr
//       clamped   = same, after clamping every channel to 65504 (what HDRLoader's default HalfFloatType keeps)
//       envOnly   = integral of env.hdr alone
//       envPlusSun= env.hdr + DirectionalLight( sunColor * sunIntensity )            (what the game renders)
//     plus the averages over the sphere caps the preview page measures (orthographic view from the sun).

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHDR, writeHDR, rowSolidAngle, pixelDir, downsampleEquirect, luminance, roundVec, round } from './sky-lib.mjs';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../..' );
const OUT = join( ROOT, 'public/assets/sky' );
const REF = join( ROOT, 'assets-src/sky/_ref' );
mkdirSync( REF, { recursive: true } );

const HALF_MAX = 65504;

/** Irradiance E(n) = sum L max(0, n.w) dW for several normals at once (exact, full resolution). */
function irradiance( img, normals, clamp = Infinity ) {

	const { width: W, height: H, data } = img;
	const out = normals.map( () => [ 0, 0, 0 ] );
	for ( let r = 0; r < H; r ++ ) {

		const sa = rowSolidAngle( r, W, H );
		for ( let c = 0; c < W; c ++ ) {

			const d = pixelDir( c, r, W, H );
			const o = ( r * W + c ) * 3;
			const R = Math.min( data[ o ], clamp ), G = Math.min( data[ o + 1 ], clamp ), B = Math.min( data[ o + 2 ], clamp );
			for ( let i = 0; i < normals.length; i ++ ) {

				const n = normals[ i ];
				const cs = d[ 0 ] * n[ 0 ] + d[ 1 ] * n[ 1 ] + d[ 2 ] * n[ 2 ];
				if ( cs <= 0 ) continue;
				const w = cs * sa;
				out[ i ][ 0 ] += R * w; out[ i ][ 1 ] += G * w; out[ i ][ 2 ] += B * w;

			}

		}

	}

	return out;

}

/** Normals of the sphere points seen inside the disc r < rMax (unit sphere, orthographic view along -s), equal-area samples. */
function capNormals( s, rMax, rings = 6 ) {

	// orthonormal basis (u, v, s)
	const a = Math.abs( s[ 1 ] ) < 0.99 ? [ 0, 1, 0 ] : [ 1, 0, 0 ];
	let u = [ a[ 1 ] * s[ 2 ] - a[ 2 ] * s[ 1 ], a[ 2 ] * s[ 0 ] - a[ 0 ] * s[ 2 ], a[ 0 ] * s[ 1 ] - a[ 1 ] * s[ 0 ] ];
	const ul = Math.hypot( ...u );
	u = u.map( ( x ) => x / ul );
	const v = [ s[ 1 ] * u[ 2 ] - s[ 2 ] * u[ 1 ], s[ 2 ] * u[ 0 ] - s[ 0 ] * u[ 2 ], s[ 0 ] * u[ 1 ] - s[ 1 ] * u[ 0 ] ];
	const out = [];
	for ( let i = 0; i < rings; i ++ ) {

		// equal-area rings in the projected disc, 4 + 6 i samples per ring
		const r = rMax * Math.sqrt( ( i + 0.5 ) / rings );
		const n = 6 + 6 * i;
		for ( let j = 0; j < n; j ++ ) {

			const phi = ( j + 0.5 * ( i % 2 ) ) / n * 2 * Math.PI;
			const x = r * Math.cos( phi ), y = r * Math.sin( phi ), z = Math.sqrt( 1 - r * r );
			out.push( [ u[ 0 ] * x + v[ 0 ] * y + s[ 0 ] * z, u[ 1 ] * x + v[ 1 ] * y + s[ 1 ] * z, u[ 2 ] * x + v[ 2 ] * y + s[ 2 ] * z ] );

		}

	}

	return out;

}

const meanVec = ( list ) => {

	const m = [ 0, 0, 0 ];
	for ( const v of list ) for ( let k = 0; k < 3; k ++ ) m[ k ] += v[ k ] / list.length;
	return m;

};

const lum = ( c ) => luminance( c[ 0 ], c[ 1 ], c[ 2 ] );
const presets = JSON.parse( readFileSync( join( OUT, 'presets.json' ), 'utf8' ) );

for ( const { meta } of presets ) {

	const sky = readHDR( join( OUT, meta.id, 'sky.hdr' ) );
	const env = readHDR( join( OUT, meta.id, 'env.hdr' ) );
	const s = meta.sunDirection, up = [ 0, 1, 0 ];
	const sunE = meta.sunColor.map( ( c ) => c * meta.sunIntensity );

	// exact integrals at the two principal normals
	const [ fullSun, fullUp ] = irradiance( sky, [ s, up ] );
	const [ clampSun, clampUp ] = irradiance( sky, [ s, up ], HALF_MAX );
	const [ envSun, envUp ] = irradiance( env, [ s, up ] );
	const plus = ( e, n ) => e.map( ( v, k ) => v + sunE[ k ] * Math.max( 0, n[ 0 ] * s[ 0 ] + n[ 1 ] * s[ 1 ] + n[ 2 ] * s[ 2 ] ) );

	// cap averages (what the page measures): env part from a low-res copy (the cosine lobe is smooth), sun part analytic
	let low = env;
	while ( low.width > 128 ) low = downsampleEquirect( low, 2 );
	const caps = {};
	for ( const [ name, rMax ] of [ [ 'center', 0.2 ], [ 'cap', 0.436 ] ] ) {

		const normals = capNormals( s, rMax );
		const envE = irradiance( low, normals );
		const cosMean = normals.reduce( ( a, n ) => a + ( n[ 0 ] * s[ 0 ] + n[ 1 ] * s[ 1 ] + n[ 2 ] * s[ 2 ] ), 0 ) / normals.length;
		const envMean = meanVec( envE );
		caps[ name ] = {
			rMax, meanCos: round( cosMean, 4 ),
			envOnly: roundVec( envMean, 4 ),
			envPlusSun: roundVec( envMean.map( ( v, k ) => v + sunE[ k ] * cosMean ), 4 ),
		};

	}

	// reference environment with the sun inside (512x256, energy conserving, nothing above the half-float range)
	const ref = downsampleEquirect( sky, 8 );
	let refPeak = 0;
	for ( let i = 0; i < ref.data.length; i ++ ) if ( ref.data[ i ] > refPeak ) refPeak = ref.data[ i ];
	if ( refPeak > HALF_MAX ) throw new Error( `${meta.id}: reference peak ${refPeak} exceeds the half-float range` );
	writeHDR( join( REF, `${meta.id}_ref512.hdr` ), ref.width, ref.height, ref.data, { rle: true, comment: `verification reference: ${meta.id} sky incl. sun, energy-conserving 512x256` } );
	const refBack = readHDR( join( REF, `${meta.id}_ref512.hdr` ) );
	const [ refSun, refUp ] = irradiance( refBack, [ s, up ] );

	const expected = {
		id: meta.id,
		sunDirection: s,
		sunIrradiance: roundVec( sunE, 4 ),
		facingSun: {
			full: roundVec( fullSun, 4 ), clamped: roundVec( clampSun, 4 ), ref512: roundVec( refSun, 4 ),
			envOnly: roundVec( envSun, 4 ), envPlusSun: roundVec( plus( envSun, s ), 4 ),
		},
		facingUp: {
			full: roundVec( fullUp, 4 ), clamped: roundVec( clampUp, 4 ), ref512: roundVec( refUp, 4 ),
			envOnly: roundVec( envUp, 4 ), envPlusSun: roundVec( plus( envUp, up ), 4 ),
		},
		caps,
		halfFloatClampLoss: round( 1 - lum( clampSun ) / lum( fullSun ), 4 ),
		refPeak: round( refPeak, 1 ),
	};
	writeFileSync( join( REF, `${meta.id}_expected.json` ), JSON.stringify( expected, null, '\t' ) + '\n' );

	const f = ( v ) => v.map( ( x ) => x.toFixed( 3 ) ).join( ', ' );
	console.log( `[${meta.id}] facing sun : full ${f( fullSun )} | clamped@65504 ${f( clampSun )} (loss ${( expected.halfFloatClampLoss * 100 ).toFixed( 2 )} %) | env+sun ${f( plus( envSun, s ) )} | env only ${f( envSun )} | ref512 ${f( refSun )}` );
	console.log( `[${meta.id}] facing up  : full ${f( fullUp )} | clamped@65504 ${f( clampUp )} | env+sun ${f( plus( envUp, up ) )} | env only ${f( envUp )} | ref512 ${f( refUp )}` );
	console.log( `[${meta.id}] env+sun vs full: facing sun ${( lum( plus( envSun, s ) ) / lum( fullSun ) ).toFixed( 4 )}, facing up ${( lum( plus( envUp, up ) ) / lum( fullUp ) ).toFixed( 4 )};  ref512 peak ${refPeak.toFixed( 0 )}` );

}
