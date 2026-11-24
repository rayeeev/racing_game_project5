#!/usr/bin/env node
// Downscaled preview + basic statistics of texture files: node tools/assets/rocks-texpreview.mjs <outDir> <size> <img...>
import sharp from 'sharp';
import { basename, join } from 'node:path';
const [ outDir, sizeS, ...files ] = process.argv.slice( 2 );
for ( const f of files ) {

	const img = sharp( f );
	const meta = await img.metadata();
	const stats = await img.stats();
	const out = join( outDir, basename( f ).replace( /\.(jpg|png|webp)$/i, '' ) + '.png' );
	await sharp( f ).resize( Number( sizeS ), Number( sizeS ), { fit: 'inside' } ).png().toFile( out );
	console.log( basename( f ), meta.width + 'x' + meta.height, 'ch', meta.channels, meta.space, 'mean', stats.channels.map( ( c ) => c.mean.toFixed( 1 ) ).join( '/' ), 'std', stats.channels.map( ( c ) => c.stdev.toFixed( 1 ) ).join( '/' ) );

}
