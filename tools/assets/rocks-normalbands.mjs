#!/usr/bin/env node
// Band-wise std of normal-map R vs G inside the UV mask (diagnose anisotropic / attenuated channels).
//   node tools/assets/rocks-normalbands.mjs <gltf> <normalTexture> [...pairs]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const io = await makeIO();
const args = process.argv.slice( 2 );
for ( let k = 0; k < args.length; k += 2 ) {

	const doc = await io.read( args[ k ] );
	const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
	const meta = await sharp( args[ k + 1 ] ).metadata();
	const W = meta.width, H = meta.height;
	const mask = rasterizeUvMask( geos, W, H );
	let prev = null;
	const out = [];
	for ( const sigma of [ 0, 1, 2, 4, 8, 16 ] ) {

		let img = sharp( args[ k + 1 ] ).removeAlpha().toColourspace( 'srgb' );
		if ( sigma > 0 ) img = img.blur( sigma );
		const { data } = await img.raw().toBuffer( { resolveWithObject: true } );
		if ( prev ) {

			let n = 0; const s = [ 0, 0, 0 ], ss = [ 0, 0, 0 ];
			for ( let i = 0; i < W * H; i += 3 ) {

				if ( ! mask[ i ] ) continue;
				n ++;
				for ( let c = 0; c < 3; c ++ ) { const d = prev[ i * 3 + c ] - data[ i * 3 + c ]; s[ c ] += d; ss[ c ] += d * d; }

			}

			const sd = s.map( ( v, c ) => Math.sqrt( ss[ c ] / n - ( v / n ) ** 2 ) );
			out.push( `band<${sigma}px R ${sd[ 0 ].toFixed( 1 )} G ${sd[ 1 ].toFixed( 1 )} G/R ${( sd[ 1 ] / sd[ 0 ] ).toFixed( 2 )}` );

		}

		prev = data;

	}

	console.log( args[ k + 1 ].split( '/' ).pop().padEnd( 38 ), out.join( ' | ' ) );

}
