#!/usr/bin/env node
// Debug: overlay the rasterised UV mask boundary on a crop of a texture channel.
//   node tools/assets/rocks-maskdebug.mjs <gltf> <texture file> <cx 0..1> <cy 0..1> <cropPx> <out.png>
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const [ gltf, texFile, cxS, cyS, cropS, out ] = process.argv.slice( 2 );
const io = await makeIO();
const doc = await io.read( gltf );
const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
const meta = await sharp( texFile ).metadata();
const W = meta.width, H = meta.height;
const mask = rasterizeUvMask( geos, W, H );
const crop = Number( cropS );
const x0 = Math.max( 0, Math.min( W - crop, Math.round( Number( cxS ) * W - crop / 2 ) ) ), y0 = Math.max( 0, Math.min( H - crop, Math.round( Number( cyS ) * H - crop / 2 ) ) );
const { data, info } = await sharp( texFile ).extract( { left: x0, top: y0, width: crop, height: crop } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
const ch = info.channels;
const Z = 4;
const outBuf = Buffer.alloc( crop * Z * crop * Z * 3 * 2 );
const OW = crop * Z * 2;
for ( let y = 0; y < crop; y ++ ) for ( let x = 0; x < crop; x ++ ) {

	const m = mask[ ( y0 + y ) * W + ( x0 + x ) ];
	const r = data[ ( y * crop + x ) * ch ], g = ch > 1 ? data[ ( y * crop + x ) * ch + 1 ] : r, b = ch > 2 ? data[ ( y * crop + x ) * ch + 2 ] : r;
	for ( let dy = 0; dy < Z; dy ++ ) for ( let dx = 0; dx < Z; dx ++ ) {

		// left: channel R as grey, with masked-out texels tinted blue; right: RGB as is
		let o = ( ( y * Z + dy ) * OW + x * Z + dx ) * 3;
		outBuf[ o ] = m ? r : r * 0.5; outBuf[ o + 1 ] = m ? r : r * 0.5; outBuf[ o + 2 ] = m ? r : Math.min( 255, r * 0.5 + 120 );
		o = ( ( y * Z + dy ) * OW + crop * Z + x * Z + dx ) * 3;
		outBuf[ o ] = r; outBuf[ o + 1 ] = g; outBuf[ o + 2 ] = b;

	}

}

await sharp( outBuf, { raw: { width: OW, height: crop * Z, channels: 3 } } ).png().toFile( out );
let cov = 0; for ( let i = 0; i < mask.length; i ++ ) cov += mask[ i ];
console.log( 'wrote', out, 'crop origin', x0, y0, 'coverage', ( cov / mask.length * 100 ).toFixed( 1 ) + '%' );
