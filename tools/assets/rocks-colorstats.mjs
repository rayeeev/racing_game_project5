#!/usr/bin/env node
// Masked colour statistics of base-colour textures (only texels covered by UV triangles count).
//   node tools/assets/rocks-colorstats.mjs <file.gltf|glb> [...]
// Prints mean colour (linear-averaged, as sRGB hex), OKLab mean/std, and the same for "rock" (non-green) texels.
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { makeIO, extractNodeGeometry, rasterizeUvMask, SRGB8_TO_LINEAR, linearToOklab, linearToSrgb, toHex } from './rocks-lib.mjs';

const io = await makeIO();
const SIZE = 1024;

export function isGreen( a, b ) {

	const C = Math.hypot( a, b );
	const h = Math.atan2( b, a ) * 180 / Math.PI;
	return C > 0.03 && h > 100 && h < 175;

}

for ( const file of process.argv.slice( 2 ) ) {

	const doc = await io.read( file );
	const root = doc.getRoot();
	const geos = root.listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
	const mask = rasterizeUvMask( geos, SIZE );
	const tex = root.listMaterials()[ 0 ].getBaseColorTexture();
	let input;
	if ( tex.getURI() && ! file.endsWith( '.glb' ) ) input = join( dirname( file ), tex.getURI() ); else input = Buffer.from( tex.getImage() );
	const { data, info } = await sharp( input ).resize( SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' } ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels;
	const lab = [ 0, 0, 0 ];
	const acc = { all: [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ], rock: [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] };
	const hueHist = new Float64Array( 36 );
	let covered = 0;
	for ( let i = 0; i < SIZE * SIZE; i ++ ) {

		if ( ! mask[ i ] ) continue;
		covered ++;
		const r = SRGB8_TO_LINEAR[ data[ i * ch ] ], g = SRGB8_TO_LINEAR[ data[ i * ch + 1 ] ], b = SRGB8_TO_LINEAR[ data[ i * ch + 2 ] ];
		linearToOklab( r, g, b, lab );
		const C = Math.hypot( lab[ 1 ], lab[ 2 ] );
		const h = ( Math.atan2( lab[ 2 ], lab[ 1 ] ) * 180 / Math.PI + 360 ) % 360;
		hueHist[ Math.floor( h / 10 ) % 36 ] += C;
		for ( const key of isGreen( lab[ 1 ], lab[ 2 ] ) ? [ 'all' ] : [ 'all', 'rock' ] ) {

			const A = acc[ key ];
			A[ 0 ] += r; A[ 1 ] += g; A[ 2 ] += b; A[ 3 ] += lab[ 0 ]; A[ 4 ] += lab[ 1 ]; A[ 5 ] += lab[ 2 ];
			A[ 6 ] += lab[ 0 ] * lab[ 0 ]; A[ 7 ] += lab[ 1 ] * lab[ 1 ]; A[ 8 ] += lab[ 2 ] * lab[ 2 ]; A[ 9 ] ++;

		}

	}

	const fmt = ( A ) => {

		const n = A[ 9 ];
		const mean = [ A[ 3 ] / n, A[ 4 ] / n, A[ 5 ] / n ];
		const std = [ Math.sqrt( A[ 6 ] / n - mean[ 0 ] ** 2 ), Math.sqrt( A[ 7 ] / n - mean[ 1 ] ** 2 ), Math.sqrt( A[ 8 ] / n - mean[ 2 ] ** 2 ) ];
		const hex = toHex( linearToSrgb( A[ 0 ] / n ) * 255, linearToSrgb( A[ 1 ] / n ) * 255, linearToSrgb( A[ 2 ] / n ) * 255 );
		return `${hex} lum ${( 0.2126 * A[ 0 ] / n + 0.7152 * A[ 1 ] / n + 0.0722 * A[ 2 ] / n ).toFixed( 3 )} Lab ${mean.map( ( v ) => v.toFixed( 4 ) ).join( ' ' )} std ${std.map( ( v ) => v.toFixed( 4 ) ).join( ' ' )}`;

	};

	const hueTop = [ ...hueHist ].map( ( v, i ) => [ i * 10, v ] ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).slice( 0, 4 ).map( ( [ h, v ] ) => `${h}deg:${( v / hueHist.reduce( ( s, x ) => s + x, 0 ) * 100 ).toFixed( 0 )}%` ).join( ' ' );
	console.log( `${file.split( '/' ).pop().padEnd( 34 )} cover ${( covered / SIZE / SIZE * 100 ).toFixed( 0 )}% green ${( ( 1 - acc.rock[ 9 ] / acc.all[ 9 ] ) * 100 ).toFixed( 1 )}%\n    all : ${fmt( acc.all )}\n    rock: ${fmt( acc.rock )}\n    hue : ${hueTop}` );

}
