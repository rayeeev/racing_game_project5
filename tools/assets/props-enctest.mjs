#!/usr/bin/env node
// Encoder comparison for a texture: prints size + PSNR (+ mean angular error for normal maps) of several WebP/JPEG settings
// against the Lanczos-resized reference.  usage: node tools/assets/props-enctest.mjs <image> <size> [normal]
import sharp from 'sharp';
const [ file, sizeArg, kind ] = process.argv.slice( 2 );
const size = Number( sizeArg || 1024 );
const ref = await sharp( file ).resize( size, size, { kernel: 'lanczos3' } ).removeAlpha().raw().toBuffer();
const refPng = await sharp( ref, { raw: { width: size, height: size, channels: 3 } } ).png().toBuffer();
const variants = {
	'webp q90': ( s ) => s.webp( { quality: 90, effort: 5 } ),
	'webp q90 smart': ( s ) => s.webp( { quality: 90, effort: 5, smartSubsample: true } ),
	'webp q95 smart': ( s ) => s.webp( { quality: 95, effort: 5, smartSubsample: true } ),
	'webp q100 smart': ( s ) => s.webp( { quality: 100, effort: 5, smartSubsample: true } ),
	'webp nearLossless q60': ( s ) => s.webp( { nearLossless: true, quality: 60, effort: 5 } ),
	'webp lossless': ( s ) => s.webp( { lossless: true, effort: 5 } ),
	'jpeg q90 444': ( s ) => s.jpeg( { quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true } ),
	'jpeg q95 444': ( s ) => s.jpeg( { quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true } ),
	'jpeg q90 420': ( s ) => s.jpeg( { quality: 90, mozjpeg: true } ),
};
for ( const [ name, fn ] of Object.entries( variants ) ) {

	const enc = await fn( sharp( refPng ) ).toBuffer();
	const dec = await sharp( enc ).removeAlpha().raw().toBuffer();
	let se = 0, ang = 0, maxAng = 0;
	const n = size * size;
	for ( let i = 0; i < n; i ++ ) {

		const a = [ ref[ i * 3 ], ref[ i * 3 + 1 ], ref[ i * 3 + 2 ] ], b = [ dec[ i * 3 ], dec[ i * 3 + 1 ], dec[ i * 3 + 2 ] ];
		for ( let k = 0; k < 3; k ++ ) se += ( a[ k ] - b[ k ] ) ** 2;
		if ( kind === 'normal' ) {

			const va = a.map( ( v ) => v / 127.5 - 1 ), vb = b.map( ( v ) => v / 127.5 - 1 );
			const la = Math.hypot( ...va ), lb = Math.hypot( ...vb );
			const d = Math.min( 1, ( va[ 0 ] * vb[ 0 ] + va[ 1 ] * vb[ 1 ] + va[ 2 ] * vb[ 2 ] ) / ( la * lb ) );
			const e = Math.acos( d ) * 180 / Math.PI;
			ang += e; if ( e > maxAng ) maxAng = e;

		}

	}

	const psnr = 10 * Math.log10( 255 * 255 / ( se / ( n * 3 ) ) );
	console.log( `${name.padEnd( 24 )} ${( enc.length / 1024 ).toFixed( 0 ).padStart( 6 )} KB  PSNR ${psnr.toFixed( 2 )} dB${kind === 'normal' ? `  mean angle ${( ang / n ).toFixed( 3 )} deg  max ${maxAng.toFixed( 1 )} deg` : ''}` );

}
