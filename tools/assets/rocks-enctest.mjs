#!/usr/bin/env node
// Experiment: encoding error of a 2k normal map / ORM / base colour for several codecs + qualities.
//   node tools/assets/rocks-enctest.mjs <normal 4k jpg> <arm 4k jpg> <diff 4k jpg>
import sharp from 'sharp';
import { loadRGB8, resizeLanczos, u8ToFloat, floatToU8, renormalizeNormals, srgb8ToLinearFloat, linearFloatToSrgb8 } from './rocks-tex.mjs';

const [ norFile, armFile, diffFile ] = process.argv.slice( 2 );
const S = 2048;

async function variants( u8, kind ) {

	const rows = [];
	const img = () => sharp( Buffer.from( u8.buffer, u8.byteOffset, u8.byteLength ), { raw: { width: S, height: S, channels: 3 } } );
	const cases = [
		[ 'webp q85', () => img().webp( { quality: 85, effort: 6, smartSubsample: true } ) ],
		[ 'webp q90', () => img().webp( { quality: 90, effort: 6, smartSubsample: true } ) ],
		[ 'webp q90 nosmart', () => img().webp( { quality: 90, effort: 6 } ) ],
		[ 'webp q95', () => img().webp( { quality: 95, effort: 6, smartSubsample: true } ) ],
		[ 'webp q98', () => img().webp( { quality: 98, effort: 6, smartSubsample: true } ) ],
		[ 'webp nearLossless60', () => img().webp( { nearLossless: true, quality: 60, effort: 6 } ) ],
		[ 'jpeg444 q90', () => img().jpeg( { quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true } ) ],
		[ 'jpeg444 q95', () => img().jpeg( { quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true } ) ],
		[ 'jpeg420 q90', () => img().jpeg( { quality: 90, chromaSubsampling: '4:2:0', mozjpeg: true } ) ],
	];
	for ( const [ name, fn ] of cases ) {

		const buf = await fn().toBuffer();
		const dec = ( await sharp( buf ).removeAlpha().raw().toBuffer() );
		let se = [ 0, 0, 0 ], ang = 0, angMax = 0, n = 0;
		for ( let i = 0; i < S * S; i ++ ) {

			for ( let c = 0; c < 3; c ++ ) { const d = dec[ i * 3 + c ] - u8[ i * 3 + c ]; se[ c ] += d * d; }
			if ( kind === 'normal' ) {

				const ax = u8[ i * 3 ] / 127.5 - 1, ay = u8[ i * 3 + 1 ] / 127.5 - 1, az = u8[ i * 3 + 2 ] / 127.5 - 1;
				const bx = dec[ i * 3 ] / 127.5 - 1, by = dec[ i * 3 + 1 ] / 127.5 - 1, bz = dec[ i * 3 + 2 ] / 127.5 - 1;
				const dot = ( ax * bx + ay * by + az * bz ) / ( Math.hypot( ax, ay, az ) * Math.hypot( bx, by, bz ) );
				const a = Math.acos( Math.min( 1, dot ) ) * 180 / Math.PI;
				ang += a; if ( a > angMax ) angMax = a;

			}

			n ++;

		}

		rows.push( `${name.padEnd( 20 )} ${( buf.length / 1024 ).toFixed( 0 ).padStart( 5 )} kB  rmse R/G/B ${se.map( ( v ) => Math.sqrt( v / n ).toFixed( 2 ) ).join( '/' )}` + ( kind === 'normal' ? `  mean angle ${( ang / n ).toFixed( 2 )} deg, max ${angMax.toFixed( 1 )} deg` : '' ) );

	}

	return rows;

}

{

	const src = await loadRGB8( norFile );
	const small = renormalizeNormals( resizeLanczos( u8ToFloat( src.data ), src.width, src.height, 3, S, S ) );
	console.log( 'NORMAL\n  ' + ( await variants( floatToU8( small ), 'normal' ) ).join( '\n  ' ) );

}

{

	const src = await loadRGB8( armFile );
	const f = u8ToFloat( src.data );
	for ( let i = 2; i < f.length; i += 3 ) f[ i ] = 0;
	console.log( 'ORM\n  ' + ( await variants( floatToU8( resizeLanczos( f, src.width, src.height, 3, S, S ) ), 'orm' ) ).join( '\n  ' ) );

}

{

	const src = await loadRGB8( diffFile );
	console.log( 'BASECOLOR\n  ' + ( await variants( linearFloatToSrgb8( resizeLanczos( srgb8ToLinearFloat( src.data ), src.width, src.height, 3, S, S ) ), 'color' ) ).join( '\n  ' ) );

}
