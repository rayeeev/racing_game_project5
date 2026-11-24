#!/usr/bin/env node
// Diagnostic: stretches the contrast of a screenshot around each channel's median (reveals subtle banding / seams).
//   node tools/assets/sky-enhance.mjs <in.png> <out.png> [gain=6]

import sharp from 'sharp';

const [ inF, outF, gain = '6' ] = process.argv.slice( 2 );
const { data, info } = await sharp( inF ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
const n = info.width * info.height;
const out = Buffer.alloc( data.length );
for ( let ch = 0; ch < 3; ch ++ ) {

	const vals = new Uint8Array( n );
	for ( let i = 0; i < n; i ++ ) vals[ i ] = data[ i * 3 + ch ];
	const med = Uint8Array.from( vals ).sort()[ n >> 1 ];
	for ( let i = 0; i < n; i ++ ) out[ i * 3 + ch ] = Math.max( 0, Math.min( 255, 128 + ( vals[ i ] - med ) * Number( gain ) ) );

}

await sharp( out, { raw: { width: info.width, height: info.height, channels: 3 } } ).png().toFile( outF );
console.log( 'wrote', outF );
