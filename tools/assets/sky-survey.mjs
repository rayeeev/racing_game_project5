#!/usr/bin/env node
// Candidate survey: prints lighting statistics for equirect HDRs and writes tone-mapped previews (selection aid).
//   node tools/assets/sky-survey.mjs <outDir> <file.hdr> [<file.hdr> ...]
// Output: <outDir>/<basename>.jpg (upper hemisphere + 12 deg below the horizon) and one stats line per file.

import sharp from 'sharp';
import { basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readHDR, luminance, rowSolidAngle, rowLat, pixelDir, azElFromDir, tonemapToBytes } from './sky-lib.mjs';

const [ outDir, ...files ] = process.argv.slice( 2 );
mkdirSync( outDir, { recursive: true } );

const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const median = ( arr ) => {

	const s = Float64Array.from( arr ).sort();
	return s.length ? s[ s.length >> 1 ] : 0;

};

for ( const file of files ) {

	const img = readHDR( file );
	const { width: W, height: H, data } = img;

	// brightest pixel
	let peak = 0, pc = 0, pr = 0;
	for ( let r = 0; r < H; r ++ ) for ( let c = 0; c < W; c ++ ) {

		const o = ( r * W + c ) * 3;
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		if ( L > peak ) { peak = L; pc = c; pr = r; }

	}

	const sunDir0 = pixelDir( pc, pr, W, H );

	// ring level (3..5 deg) and excess energy within 3 deg
	const cos3 = Math.cos( 3 * Math.PI / 180 ), cos5 = Math.cos( 5 * Math.PI / 180 );
	const ring = [];
	for ( let r = 0; r < H; r ++ ) for ( let c = 0; c < W; c ++ ) {

		const d = dot( pixelDir( c, r, W, H ), sunDir0 );
		if ( d < cos3 && d >= cos5 ) {

			const o = ( r * W + c ) * 3;
			ring.push( luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] ) );

		}

	}

	const ringL = median( ring );
	const sunE = [ 0, 0, 0 ];
	const cen = [ 0, 0, 0 ];
	let sunEL = 0;
	let skyE = 0, upperL = 0, upperSA = 0, lowerL = 0, lowerSA = 0, zenL = 0, zenSA = 0, horL = 0, horSA = 0;
	const logs = [];
	for ( let r = 0; r < H; r ++ ) {

		const sa = rowSolidAngle( r, W, H );
		const lat = rowLat( r, H );
		const sinLat = Math.sin( lat );
		for ( let c = 0; c < W; c ++ ) {

			const o = ( r * W + c ) * 3;
			let L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
			const dir = pixelDir( c, r, W, H );
			if ( dot( dir, sunDir0 ) >= cos3 && L > ringL ) {

				const k = ( L - ringL ) / L;
				for ( let j = 0; j < 3; j ++ ) { sunE[ j ] += data[ o + j ] * k * sa; cen[ j ] += dir[ j ] * ( L - ringL ) * sa; }
				sunEL += ( L - ringL ) * sa;
				L = ringL;

			}

			if ( lat > 0 ) {

				skyE += L * sinLat * sa; upperL += L * sa; upperSA += sa;
				if ( lat > 70 * Math.PI / 180 ) { zenL += L * sa; zenSA += sa; }
				if ( lat < 6 * Math.PI / 180 && lat > 0.5 * Math.PI / 180 ) { horL += L * sa; horSA += sa; }
				if ( ( c & 3 ) === 0 && ( r & 3 ) === 0 ) logs.push( L );

			} else { lowerL += L * sa; lowerSA += sa; }

		}

	}

	const cl = Math.hypot( ...cen ) || 1;
	const sunDir = cen.map( ( v ) => v / cl );
	const { az, el } = azElFromDir( sunDir );
	const mx = Math.max( ...sunE ) || 1;
	const med = median( logs );
	const sunHoriz = sunEL * Math.max( 0, Math.sin( el * Math.PI / 180 ) );

	console.log( [
		basename( file ).replace( /_puresky_\dk\.hdr$/, '' ).padEnd( 30 ),
		'el', el.toFixed( 1 ).padStart( 5 ), 'az', az.toFixed( 0 ).padStart( 3 ),
		'peak', peak.toPrecision( 3 ).padStart( 8 ),
		'Esun', sunEL.toPrecision( 3 ).padStart( 6 ), 'Esky', skyE.toPrecision( 3 ).padStart( 6 ),
		'sun/sky', ( sunEL / skyE ).toFixed( 2 ).padStart( 5 ), 'sunHoriz/sky', ( sunHoriz / skyE ).toFixed( 2 ).padStart( 5 ),
		'sunRGB', sunE.map( ( v ) => ( v / mx ).toFixed( 2 ) ).join( ',' ),
		'zen', ( zenL / zenSA ).toPrecision( 3 ), 'hor', ( horL / horSA ).toPrecision( 3 ), 'upMean', ( upperL / upperSA ).toPrecision( 3 ), 'upMed', med.toPrecision( 3 ), 'low', ( lowerL / lowerSA ).toPrecision( 3 ),
	].join( ' ' ) );

	// preview: rows from +90 down to -12 deg
	const rows = Math.round( H * ( 102 / 180 ) );
	const crop = { width: W, height: rows, data: data.subarray( 0, W * rows * 3 ) };
	const exposure = Number( process.env.SKY_KEY || 0.30 ) / Math.max( med, 1e-6 );
	const bytes = tonemapToBytes( crop, exposure );
	await sharp( bytes, { raw: { width: W, height: rows, channels: 3 } } ).jpeg( { quality: 88 } ).toFile( `${outDir}/${basename( file ).replace( /_puresky_\dk\.hdr$/, '' )}.jpg` );

}
