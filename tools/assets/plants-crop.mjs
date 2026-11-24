#!/usr/bin/env node
// Crop + nearest-neighbour upscale of an image region for close inspection; RGBA images are shown with the alpha test applied.
//   node tools/assets/plants-crop.mjs <in.png> <out.png> <x> <y> <w> <h> [scale=3] [cutoff=-1 (0..255: apply alpha test, show over magenta)]
import sharp from 'sharp';
const [ input, out, x, y, w, h, scale = '3', cutoff = '-1' ] = process.argv.slice( 2 );
const { data, info } = await sharp( input ).extract( { left: + x, top: + y, width: + w, height: + h } ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
const o = Buffer.alloc( info.width * info.height * 3 );
const cut = Number( cutoff );
for ( let i = 0; i < info.width * info.height; i ++ ) {

	const a = data[ i * 4 + 3 ];
	if ( cut >= 0 ) {

		const on = a >= cut;
		o[ i * 3 ] = on ? data[ i * 4 ] : 200; o[ i * 3 + 1 ] = on ? data[ i * 4 + 1 ] : 60; o[ i * 3 + 2 ] = on ? data[ i * 4 + 2 ] : 200;

	} else {

		for ( let c = 0; c < 3; c ++ ) o[ i * 3 + c ] = data[ i * 4 + c ];

	}

}

await sharp( o, { raw: { width: info.width, height: info.height, channels: 3 } } ).resize( info.width * scale, info.height * scale, { kernel: 'nearest' } ).png().toFile( out );
console.log( 'wrote', out );
