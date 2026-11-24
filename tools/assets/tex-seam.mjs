#!/usr/bin/env node
// Seam-cross sheet: for every image the 1:1 pixel neighbourhood of the wrap-around corner (the four tile corners meet in
// the centre of each cell, so both the U and the V seam run through the middle of the cell). Any discontinuity shows up
// as a horizontal/vertical line through the cell centre.
//
//   node tools/assets/tex-seam.mjs --out <abs.png> [--cell 300] [--cols 5] [--map albedo] <set id | image path> ...

import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { cell: 300, cols: 5, map: 'albedo' };
const items = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
	else items.push( argv[ i ] );

}

const cell = Number( opt.cell ), cols = Math.min( Number( opt.cols ), items.length ), lh = 22, pad = 4;
const rows = Math.ceil( items.length / cols );
const comps = [];
for ( let i = 0; i < items.length; i ++ ) {

	const file = existsSync( items[ i ] ) ? items[ i ] : resolve( 'public/assets/textures', items[ i ], `${opt.map}.jpg` );
	const label = existsSync( items[ i ] ) ? `${basename( dirname( file ) )}/${basename( file )}` : `${items[ i ]} (${opt.map}, 1:1 at the wrap corner)`;
	const { data, info } = await sharp( file ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const W = info.width, H = info.height, half = cell / 2;
	const out = Buffer.alloc( cell * cell * 3 );
	for ( let y = 0; y < cell; y ++ ) {

		const sy = ( H - half + y ) % H;
		for ( let x = 0; x < cell; x ++ ) {

			const sx = ( W - half + x ) % W;
			const s = ( sy * W + sx ) * 3, d = ( y * cell + x ) * 3;
			out[ d ] = data[ s ]; out[ d + 1 ] = data[ s + 1 ]; out[ d + 2 ] = data[ s + 2 ];

		}

	}

	const x = pad + ( i % cols ) * ( cell + pad ), y = pad + Math.floor( i / cols ) * ( cell + lh + pad );
	comps.push( { input: await sharp( out, { raw: { width: cell, height: cell, channels: 3 } } ).png().toBuffer(), left: x, top: y } );
	comps.push( { input: Buffer.from( `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${lh}"><rect width="100%" height="100%" fill="#202020"/><text x="3" y="15" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#f2f2f2">${label}</text></svg>` ), left: x, top: y + cell } );

}

await sharp( { create: { width: cols * ( cell + pad ) + pad, height: rows * ( cell + lh + pad ) + pad, channels: 3, background: '#202020' } } ).composite( comps ).png().toFile( opt.out );
console.log( opt.out );
