#!/usr/bin/env node
// Colour-coherence sheet for the delivered sets (reads public/assets/textures/index.json).
// Per set, top to bottom: raw albedo (whole tile, downsized), albedo with recommended.albedoTint applied in linear space
// (identical to the raw one when the set has no tint), flat chip of the raw average colour, flat chip of the tinted average.
//
//   node tools/assets/tex-swatches.mjs --out <abs.png> [--cell 160] [--rows "a,b,c;d,e,f"]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { srgbToLinear, linearToSrgb, hex } from './tex-lib.mjs';

const argv = process.argv.slice( 2 );
const opt = { cell: 160 };
for ( let i = 0; i < argv.length; i ++ ) if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];

const index = JSON.parse( readFileSync( resolve( 'public/assets/textures/index.json' ), 'utf8' ) );
const byId = Object.fromEntries( index.sets.map( ( s ) => [ s.id, s ] ) );
const rowsIds = opt.rows
	? String( opt.rows ).split( ';' ).map( ( r ) => r.split( ',' ) )
	: [ [ 'grass_meadow', 'grass_dry', 'forest_floor', 'dirt', 'gravel', 'rock_ground', 'rock_cliff', 'shore', 'snow' ], [ 'asphalt_main', 'asphalt_worn', 'concrete', 'metal_galvanized', 'wood_weathered', 'wood_planks' ] ];

const cell = Number( opt.cell ), chip = 34, lh = 34, pad = 4;
const rowH = cell * 2 + chip * 2 + lh + pad;
const W = Math.max( ...rowsIds.map( ( r ) => r.length ) ) * ( cell + pad ) + pad, H = rowsIds.length * rowH + pad;
const comps = [];
const LUT = Array.from( { length: 256 }, ( _, i ) => srgbToLinear( i / 255 ) );

for ( let r = 0; r < rowsIds.length; r ++ ) {

	for ( let c = 0; c < rowsIds[ r ].length; c ++ ) {

		const set = byId[ rowsIds[ r ][ c ] ];
		if ( ! set ) continue;
		const x = pad + c * ( cell + pad ), y = pad + r * rowH;
		const tint = set.recommended?.albedoTint ?? [ 1, 1, 1 ];
		const { data } = await sharp( resolve( 'public' + set.maps.albedo ) ).resize( cell, cell, { kernel: 'lanczos3' } ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
		const tinted = Buffer.alloc( data.length );
		for ( let i = 0; i < data.length; i ++ ) tinted[ i ] = Math.round( Math.min( 1, linearToSrgb( LUT[ data[ i ] ] * tint[ i % 3 ] ) ) * 255 );
		const avg = set.avgColorLinear.map( ( v ) => linearToSrgb( v ) * 255 );
		const avgT = set.avgColorLinear.map( ( v, i ) => Math.min( 1, linearToSrgb( v * tint[ i ] ) ) * 255 );
		comps.push( { input: await sharp( data, { raw: { width: cell, height: cell, channels: 3 } } ).png().toBuffer(), left: x, top: y } );
		comps.push( { input: await sharp( tinted, { raw: { width: cell, height: cell, channels: 3 } } ).png().toBuffer(), left: x, top: y + cell } );
		comps.push( { input: await sharp( { create: { width: cell, height: chip, channels: 3, background: hex( avg ) } } ).png().toBuffer(), left: x, top: y + cell * 2 } );
		comps.push( { input: await sharp( { create: { width: cell, height: chip, channels: 3, background: hex( avgT ) } } ).png().toBuffer(), left: x, top: y + cell * 2 + chip } );
		const hasTint = !! set.recommended?.albedoTint;
		comps.push( { input: Buffer.from( `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${lh}"><rect width="100%" height="100%" fill="#202020"/><text x="2" y="13" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#fff">${set.id}</text><text x="2" y="28" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#bbb">${hex( avg )}${hasTint ? ' -> ' + hex( avgT ) + ' tinted' : ' (no tint)'}</text></svg>` ), left: x, top: y + cell * 2 + chip * 2 } );

	}

}

await sharp( { create: { width: W, height: H, channels: 3, background: '#202020' } } ).composite( comps ).png().toFile( opt.out );
console.log( opt.out, `${W}x${H}  rows: raw albedo / albedo x recommended tint / avg chip / tinted avg chip` );
