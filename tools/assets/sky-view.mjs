#!/usr/bin/env node
// Renders a tone-mapped perspective view of an equirect HDR (selection aid / thumbnails).
//   node tools/assets/sky-view.mjs <in.hdr> <out.jpg|png> <azDeg|sun[+offset]> <elDeg> <hfovDeg> <width> <height> <exposure|auto[:key]>
// az "sun" = look toward the brightest pixel's azimuth, "sun+40" = 40 degrees to the right of it.

import sharp from 'sharp';
import { readHDR, renderView, tonemapToBytes, luminance, pixelDir, azElFromDir, downsampleEquirect } from './sky-lib.mjs';

const [ inFile, outFile, azS = 'sun', elS = '15', fovS = '100', wS = '1024', hS = '512', expS = 'auto' ] = process.argv.slice( 2 );
let img = readHDR( inFile );
const width = Number( wS ), height = Number( hS ), hfov = Number( fovS );

let az;
if ( azS.startsWith( 'sun' ) ) {

	let peak = 0, pc = 0, pr = 0;
	const { width: W, height: H, data } = img;
	for ( let r = 0; r < H; r ++ ) for ( let c = 0; c < W; c ++ ) {

		const o = ( r * W + c ) * 3;
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		if ( L > peak ) { peak = L; pc = c; pr = r; }

	}

	az = azElFromDir( pixelDir( pc, pr, W, H ) ).az + Number( azS.slice( 3 ) || 0 );

} else az = Number( azS );

// prefilter: bring the source to roughly the output's angular resolution
const outPxPerDeg = width / hfov;
while ( img.width / 360 > outPxPerDeg * 2.5 && img.width % 2 === 0 && img.height % 2 === 0 ) img = downsampleEquirect( img, 2 );

const view = renderView( img, { azDeg: az, elDeg: Number( elS ), hfovDeg: hfov, width, height, ss: 3 } );

let exposure;
if ( expS.startsWith( 'auto' ) ) {

	const key = Number( expS.split( ':' )[ 1 ] || 0.2 );
	const Ls = [];
	for ( let i = 0; i < width * height; i ++ ) Ls.push( luminance( view.data[ i * 3 ], view.data[ i * 3 + 1 ], view.data[ i * 3 + 2 ] ) );
	Ls.sort( ( a, b ) => a - b );
	exposure = key / Math.max( Ls[ Ls.length >> 1 ], 1e-6 );

} else exposure = Number( expS );

const bytes = tonemapToBytes( view, exposure );
const s = sharp( bytes, { raw: { width, height, channels: 3 } } );
if ( outFile.endsWith( '.png' ) ) await s.png().toFile( outFile ); else await s.jpeg( { quality: 90, mozjpeg: true } ).toFile( outFile );
console.log( 'wrote', outFile, 'az', az.toFixed( 1 ), 'exposure', exposure.toFixed( 3 ) );
