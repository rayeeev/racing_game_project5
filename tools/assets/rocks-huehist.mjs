#!/usr/bin/env node
// Hue histogram (OKLab) of the UV-covered texels of a base colour texture: share of texels and mean chroma per 10 degree bin.
//   node tools/assets/rocks-huehist.mjs <gltf> <texture> [...pairs]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask, SRGB8_TO_LINEAR, linearToOklab } from './rocks-lib.mjs';
const io = await makeIO();
const args = process.argv.slice( 2 );
const SIZE = 1024;
for ( let k = 0; k < args.length; k += 2 ) {

	const doc = await io.read( args[ k ] );
	const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
	const mask = rasterizeUvMask( geos, SIZE, SIZE );
	const { data } = await sharp( args[ k + 1 ] ).resize( SIZE, SIZE, { fit: 'fill' } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const count = new Float64Array( 36 ), chroma = new Float64Array( 36 ), light = new Float64Array( 36 );
	let n = 0, low = 0;
	const lab = [ 0, 0, 0 ];
	for ( let i = 0; i < SIZE * SIZE; i ++ ) {

		if ( ! mask[ i ] ) continue;
		linearToOklab( SRGB8_TO_LINEAR[ data[ i * 3 ] ], SRGB8_TO_LINEAR[ data[ i * 3 + 1 ] ], SRGB8_TO_LINEAR[ data[ i * 3 + 2 ] ], lab );
		n ++;
		const C = Math.hypot( lab[ 1 ], lab[ 2 ] );
		if ( C < 0.012 ) { low ++; continue; }
		const h = ( Math.atan2( lab[ 2 ], lab[ 1 ] ) * 180 / Math.PI + 360 ) % 360;
		const b = Math.floor( h / 10 ) % 36;
		count[ b ] ++; chroma[ b ] += C; light[ b ] += lab[ 0 ];

	}

	console.log( `${args[ k + 1 ].split( '/' ).pop()}: near-neutral (C<0.012) ${( low / n * 100 ).toFixed( 1 )}%` );
	const rows = [];
	for ( let b = 0; b < 36; b ++ ) if ( count[ b ] / n > 0.002 ) rows.push( `${String( b * 10 ).padStart( 3 )}deg ${( count[ b ] / n * 100 ).toFixed( 1 ).padStart( 5 )}% C ${( chroma[ b ] / count[ b ] ).toFixed( 3 )} L ${( light[ b ] / count[ b ] ).toFixed( 2 )}` );
	console.log( '   ' + rows.join( '\n   ' ) );

}
