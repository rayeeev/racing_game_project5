#!/usr/bin/env node
// Diagnose an attenuated normal-map channel: compare measured |y| with the magnitude implied by unit length (sqrt(1 - x^2 - z^2)).
//   node tools/assets/rocks-normalfit.mjs <gltf> <normalTexture>
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const io = await makeIO();
const [ gltf, tex ] = process.argv.slice( 2 );
const doc = await io.read( gltf );
const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
const SIZE = 2048;
const mask = rasterizeUvMask( geos, SIZE, SIZE );
const { data } = await sharp( tex ).resize( SIZE, SIZE, { kernel: 'lanczos3' } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
let n = 0, sxy = 0, sxx = 0, syy = 0, sx = 0, sy = 0, lenSum = 0, len2 = 0;
const ratios = [];
let zmin = 1, zmean = 0;
for ( let i = 0; i < SIZE * SIZE; i ++ ) {

	if ( ! mask[ i ] ) continue;
	const x = ( data[ i * 3 ] - 127.5 ) / 127.5, y = ( data[ i * 3 + 1 ] - 127.5 ) / 127.5, z = ( data[ i * 3 + 2 ] - 127.5 ) / 127.5;
	const len = Math.hypot( x, y, z );
	lenSum += len; len2 += len * len; n ++;
	zmean += z; if ( z < zmin ) zmin = z;
	const q = 1 - x * x - z * z;
	if ( q > 0.01 && Math.abs( y ) > 0.02 ) {

		const a = Math.sqrt( q ), b = Math.abs( y );
		sx += b; sy += a; sxx += b * b; syy += a * a; sxy += a * b;
		if ( ratios.length < 400000 ) ratios.push( a / b );

	}

}

const m = ratios.length;
ratios.sort( ( a, b ) => a - b );
console.log( tex.split( '/' ).pop(), 'mean |n|', ( lenSum / n ).toFixed( 3 ), 'std', Math.sqrt( len2 / n - ( lenSum / n ) ** 2 ).toFixed( 3 ), 'mean z', ( zmean / n ).toFixed( 3 ), 'min z', zmin.toFixed( 3 ) );
console.log( '  implied|y| / measured|y|: median', ratios[ m >> 1 ].toFixed( 2 ), 'p25', ratios[ m >> 2 ].toFixed( 2 ), 'p75', ratios[ ( m * 3 ) >> 2 ].toFixed( 2 ), 'least-squares gain', ( sxy / sxx ).toFixed( 2 ) );
