#!/usr/bin/env node
// Check that an ARM/AO texture matches the mesh UV layout: the AO channel is black outside UV islands in Poly Haven bakes.
//   node tools/assets/rocks-armcheck.mjs <gltf> <armOrAoTexture> [...pairs]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const io = await makeIO();
const args = process.argv.slice( 2 );
const SIZE = 1024;
for ( let k = 0; k < args.length; k += 2 ) {

	const doc = await io.read( args[ k ] );
	const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
	const mask = rasterizeUvMask( geos, SIZE, SIZE );
	const { data, info } = await sharp( args[ k + 1 ] ).resize( SIZE, SIZE, { fit: 'fill', kernel: 'nearest' } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels;
	let inMask = 0, inBlack = 0, outMask = 0, outLit = 0, sumIn = 0, sumG = 0;
	for ( let i = 0; i < SIZE * SIZE; i ++ ) {

		const r = data[ i * ch ];
		if ( mask[ i ] ) { inMask ++; if ( r < 6 ) inBlack ++; sumIn += r; sumG += ch > 1 ? data[ i * ch + 1 ] : r; } else { outMask ++; if ( r >= 6 ) outLit ++; }

	}

	console.log( `${args[ k + 1 ].split( '/' ).pop().padEnd( 40 )} in-mask black ${( inBlack / inMask * 100 ).toFixed( 1 ).padStart( 5 )}%  out-of-mask lit ${( outLit / outMask * 100 ).toFixed( 1 ).padStart( 5 )}%  mean R in mask ${( sumIn / inMask ).toFixed( 0 )}  mean G in mask ${( sumG / inMask ).toFixed( 0 )}  ${inBlack / inMask > 0.03 ? '<== MISMATCH?' : 'ok'}` );

}
