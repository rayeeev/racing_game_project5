#!/usr/bin/env node
// Reads the exposure cards out of a dev/preview-sky.html?mode=beauty screenshot.
//   node tools/assets/sky-cards.mjs <shot.png> '<json of window.__cards>'
// Prints the mean sRGB value (0..255) and the display-linear luminance of a 9x9 px patch at every card centre.

import sharp from 'sharp';
import { sRGBToLinear } from './sky-lib.mjs';

const [ file, cardsJson ] = process.argv.slice( 2 );
const cards = JSON.parse( cardsJson );
const { data, info } = await sharp( file ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
const out = [];
for ( const c of cards ) {

	const s = [ 0, 0, 0 ];
	let n = 0;
	for ( let y = c.y - 4; y <= c.y + 4; y ++ ) for ( let x = c.x - 4; x <= c.x + 4; x ++ ) {

		if ( x < 0 || y < 0 || x >= info.width || y >= info.height ) continue;
		const o = ( y * info.width + x ) * 3;
		s[ 0 ] += data[ o ]; s[ 1 ] += data[ o + 1 ]; s[ 2 ] += data[ o + 2 ]; n ++;

	}

	if ( ! n ) { out.push( `${c.name}: off-screen` ); continue; }
	const rgb = s.map( ( v ) => v / n );
	const lin = rgb.map( ( v ) => sRGBToLinear( v / 255 ) );
	const Y = 0.2126 * lin[ 0 ] + 0.7152 * lin[ 1 ] + 0.0722 * lin[ 2 ];
	out.push( `${c.name}: sRGB ${rgb.map( ( v ) => v.toFixed( 0 ) ).join( ',' )}  Y ${Y.toFixed( 3 )}` );

}

console.log( out.join( '  |  ' ) );
