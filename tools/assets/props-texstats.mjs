#!/usr/bin/env node
// Channel statistics of textures (mean / percentiles per channel, 0..1). usage: node tools/assets/props-texstats.mjs <img> ...
import sharp from 'sharp';
import { basename } from 'node:path';
for ( const file of process.argv.slice( 2 ) ) {
	const { data, info } = await sharp( file ).resize( 512, 512, { fit: 'fill' } ).raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels, n = info.width * info.height;
	const out = [];
	for ( let c = 0; c < Math.min( ch, 4 ); c ++ ) {
		const hist = new Uint32Array( 256 ); let sum = 0;
		for ( let i = 0; i < n; i ++ ) { const v = data[ i * ch + c ]; hist[ v ] ++; sum += v; }
		const pct = ( p ) => { let acc = 0; for ( let v = 0; v < 256; v ++ ) { acc += hist[ v ]; if ( acc >= n * p ) return ( v / 255 ).toFixed( 2 ); } return '1.00'; };
		out.push( `${'RGBA'[ c ]} mean ${( sum / n / 255 ).toFixed( 2 )} p05 ${pct( 0.05 )} p50 ${pct( 0.5 )} p95 ${pct( 0.95 )}` );
	}
	console.log( basename( file ).padEnd( 52 ), out.join( ' | ' ) );
}
