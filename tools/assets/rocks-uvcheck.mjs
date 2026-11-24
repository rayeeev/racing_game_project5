#!/usr/bin/env node
// Generic check that a texture matches the mesh UV layout: padding outside UV islands is smooth/streaky, the inside is detailed.
// Prints high-frequency energy inside vs outside an eroded/dilated UV mask per channel.  ratio >> 1 => matches.
//   node tools/assets/rocks-uvcheck.mjs <gltf> <texture> [<gltf> <texture> ...]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const io = await makeIO();
const args = process.argv.slice( 2 );
const SIZE = 1024;
const cache = new Map();
for ( let k = 0; k < args.length; k += 2 ) {

	let m = cache.get( args[ k ] );
	if ( ! m ) {

		const doc = await io.read( args[ k ] );
		const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
		const mask = rasterizeUvMask( geos, SIZE, SIZE );
		// erode (inside) and dilate (outside) by 3 px to stay clear of the island borders
		const inside = new Uint8Array( SIZE * SIZE ), outside = new Uint8Array( SIZE * SIZE );
		const R = 3;
		for ( let y = R; y < SIZE - R; y ++ ) for ( let x = R; x < SIZE - R; x ++ ) {

			let all = 1, none = 1;
			for ( let dy = - R; dy <= R && ( all || none ); dy ++ ) for ( let dx = - R; dx <= R; dx ++ ) { if ( mask[ ( y + dy ) * SIZE + x + dx ] ) none = 0; else all = 0; }
			inside[ y * SIZE + x ] = all; outside[ y * SIZE + x ] = none;

		}

		m = { inside, outside };
		cache.set( args[ k ], m );

	}

	const { data, info } = await sharp( args[ k + 1 ] ).resize( SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels;
	const res = [];
	for ( let c = 0; c < ch; c ++ ) {

		let ein = 0, nin = 0, eout = 0, nout = 0;
		for ( let y = 1; y < SIZE - 1; y ++ ) for ( let x = 1; x < SIZE - 1; x ++ ) {

			const i = y * SIZE + x;
			if ( ! m.inside[ i ] && ! m.outside[ i ] ) continue;
			// isotropic-ish high-pass: |4c - n - s - e - w| (padding streaks are 1D-constant or flat -> low response on average)
			const lap = Math.abs( 4 * data[ i * ch + c ] - data[ ( i - 1 ) * ch + c ] - data[ ( i + 1 ) * ch + c ] - data[ ( i - SIZE ) * ch + c ] - data[ ( i + SIZE ) * ch + c ] );
			if ( m.inside[ i ] ) { ein += lap; nin ++; } else { eout += lap; nout ++; }

		}

		res.push( `${'RGB'[ c ]}: in ${( ein / nin ).toFixed( 2 )} out ${( eout / nout ).toFixed( 2 )} ratio ${( ( ein / nin ) / Math.max( eout / nout, 1e-3 ) ).toFixed( 1 )}` );

	}

	console.log( args[ k + 1 ].split( '/' ).pop().padEnd( 42 ), res.join( ' | ' ) );

}
