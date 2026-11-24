#!/usr/bin/env node
// Crop a region of an image at full resolution (optionally split channels).  node rocks-crop.mjs <in> <out.png> <x> <y> <w> <h> [zoom] [channels]
import sharp from 'sharp';
const [ input, out, x, y, w, h, zoomS, chans ] = process.argv.slice( 2 );
const zoom = Number( zoomS || 1 );
const base = sharp( input ).extract( { left: Number( x ), top: Number( y ), width: Number( w ), height: Number( h ) } );
if ( chans ) {

	const { data, info } = await base.removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const W = info.width, H = info.height, ch = info.channels;
	const buf = Buffer.alloc( W * 3 * H * 3 );
	for ( let c = 0; c < 3; c ++ ) for ( let i = 0; i < W * H; i ++ ) {

		const v = data[ i * ch + Math.min( c, ch - 1 ) ];
		const px = ( Math.floor( i / W ) * W * 3 + c * W + ( i % W ) ) * 3;
		buf[ px ] = v; buf[ px + 1 ] = v; buf[ px + 2 ] = v;

	}

	await sharp( buf, { raw: { width: W * 3, height: H, channels: 3 } } ).resize( W * 3 * zoom, H * zoom, { kernel: 'nearest' } ).png().toFile( out );

} else {

	await base.resize( Number( w ) * zoom, Number( h ) * zoom, { kernel: 'nearest' } ).png().toFile( out );

}

console.log( 'wrote', out );
