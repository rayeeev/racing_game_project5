#!/usr/bin/env node
// Preview a diffuse texture with a separate alpha map applied over a flat background.
//   node tools/assets/plants-texview.mjs <diff.jpg> <alpha.png|-> <out.png> [size=1024] [bg=48,52,60]
import sharp from 'sharp';
const [ diff, alpha, out, sizeS = '1024', bgS = '48,52,60' ] = process.argv.slice( 2 );
const size = Number( sizeS );
const bg = bgS.split( ',' ).map( Number );
const rgb = await sharp( diff ).resize( size, size ).removeAlpha().toColourspace( 'srgb' ).raw( { depth: 'uchar' } ).toBuffer();
const o = Buffer.alloc( size * size * 3 );
let a = null;
if ( alpha && alpha !== '-' ) a = await sharp( alpha ).resize( size, size ).greyscale().toColourspace( 'b-w' ).raw( { depth: 'uchar' } ).toBuffer();
for ( let i = 0; i < size * size; i ++ ) {

	const al = a ? a[ i ] / 255 : 1;
	for ( let c = 0; c < 3; c ++ ) o[ i * 3 + c ] = Math.round( rgb[ i * 3 + c ] * al + bg[ c ] * ( 1 - al ) );

}

await sharp( o, { raw: { width: size, height: size, channels: 3 } } ).png().toFile( out );
console.log( 'wrote', out );
