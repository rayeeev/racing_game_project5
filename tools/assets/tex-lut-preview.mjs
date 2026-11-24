#!/usr/bin/env node
// Apply 3D LUTs (.cube / .3dl) to a display-referred sRGB image offline (trilinear) and build a labelled comparison sheet.
// Also prints what each LUT does to a neutral grey ramp and to a few memory colours (objective warm/cool/contrast read-out).
//
//   node tools/assets/tex-lut-preview.mjs --out <sheet.png> --in <image.png>[,<image2.png>] [--cell 640] <lut files...>

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice( 2 );
const opt = { cell: 640 };
const luts = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
	else luts.push( argv[ i ] );

}

export function parseLut( file ) {

	const text = readFileSync( file, 'utf8' );
	if ( /\.cube$/i.test( file ) ) {

		const size = Number( /LUT_3D_SIZE\s+(\d+)/.exec( text )[ 1 ] );
		const data = new Float32Array( size ** 3 * 3 );
		let k = 0;
		for ( const line of text.split( /\r?\n/ ) ) {

			const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*$/i.exec( line );
			if ( m && k < data.length ) { data[ k ++ ] = Number( m[ 1 ] ); data[ k ++ ] = Number( m[ 2 ] ); data[ k ++ ] = Number( m[ 3 ] ); }

		}

		if ( k !== data.length ) throw new Error( `${file}: expected ${data.length / 3} entries, got ${k / 3}` );
		return { size, data, title: /TITLE\s+"([^"]*)"/.exec( text )?.[ 1 ] ?? null }; // index = (b * size + g) * size + r

	}

	// .3dl : first numeric line = grid, then size^3 integer triples with BLUE changing fastest
	const lines = text.split( /\r?\n/ ).map( ( l ) => l.trim() ).filter( ( l ) => l && ! l.startsWith( '#' ) );
	const grid = lines[ 0 ].split( /\s+/ ).map( Number );
	const size = grid.length;
	const raw = lines.slice( 1 ).map( ( l ) => l.split( /\s+/ ).map( Number ) ).filter( ( a ) => a.length === 3 );
	if ( raw.length !== size ** 3 ) throw new Error( `${file}: expected ${size ** 3} entries, got ${raw.length}` );
	let max = 0;
	for ( const a of raw ) max = Math.max( max, a[ 0 ], a[ 1 ], a[ 2 ] );
	const scale = 2 ** Math.ceil( Math.log2( max + 1 ) ) - 1;
	const data = new Float32Array( size ** 3 * 3 );
	raw.forEach( ( a, index ) => {

		const b = index % size, g = Math.floor( index / size ) % size, r = Math.floor( index / ( size * size ) ) % size;
		const d = ( ( b * size + g ) * size + r ) * 3;
		data[ d ] = a[ 0 ] / scale; data[ d + 1 ] = a[ 1 ] / scale; data[ d + 2 ] = a[ 2 ] / scale;

	} );
	return { size, data, title: null };

}

export function sampleLut( lut, r, g, b, out ) {

	const n = lut.size - 1, d = lut.data, s = lut.size;
	const x = Math.min( Math.max( r, 0 ), 1 ) * n, y = Math.min( Math.max( g, 0 ), 1 ) * n, z = Math.min( Math.max( b, 0 ), 1 ) * n;
	const x0 = Math.min( Math.floor( x ), n - 1 ), y0 = Math.min( Math.floor( y ), n - 1 ), z0 = Math.min( Math.floor( z ), n - 1 );
	const fx = x - x0, fy = y - y0, fz = z - z0;
	for ( let c = 0; c < 3; c ++ ) {

		const at = ( i, j, k ) => d[ ( ( ( z0 + k ) * s + ( y0 + j ) ) * s + ( x0 + i ) ) * 3 + c ];
		const c00 = at( 0, 0, 0 ) * ( 1 - fx ) + at( 1, 0, 0 ) * fx, c10 = at( 0, 1, 0 ) * ( 1 - fx ) + at( 1, 1, 0 ) * fx;
		const c01 = at( 0, 0, 1 ) * ( 1 - fx ) + at( 1, 0, 1 ) * fx, c11 = at( 0, 1, 1 ) * ( 1 - fx ) + at( 1, 1, 1 ) * fx;
		out[ c ] = ( c00 * ( 1 - fy ) + c10 * fy ) * ( 1 - fz ) + ( c01 * ( 1 - fy ) + c11 * fy ) * fz;

	}

	return out;

}

if ( process.argv[ 1 ] && process.argv[ 1 ].endsWith( 'tex-lut-preview.mjs' ) ) {

	const parsed = luts.map( ( f ) => ( { name: basename( f ), lut: parseLut( f ) } ) );
	const tmp = [ 0, 0, 0 ];
	const h2 = ( v ) => Math.round( Math.min( Math.max( v, 0 ), 1 ) * 255 ).toString( 16 ).padStart( 2, '0' );
	const probes = { 'grey10': [ 0.1, 0.1, 0.1 ], 'grey25': [ 0.25, 0.25, 0.25 ], 'grey50': [ 0.5, 0.5, 0.5 ], 'grey75': [ 0.75, 0.75, 0.75 ], 'white': [ 1, 1, 1 ], 'black': [ 0, 0, 0 ], 'sky #6f9bd8': [ 0.435, 0.608, 0.847 ], 'grass #6c7a3a': [ 0.424, 0.478, 0.227 ], 'sun-rock #c8a070': [ 0.784, 0.627, 0.439 ] };
	for ( const { name, lut } of parsed ) {

		const parts = Object.entries( probes ).map( ( [ k, v ] ) => {

			sampleLut( lut, v[ 0 ], v[ 1 ], v[ 2 ], tmp );
			return `${k}->#${h2( tmp[ 0 ] )}${h2( tmp[ 1 ] )}${h2( tmp[ 2 ] )}`;

		} );
		console.log( `${name.padEnd( 26 )} size ${lut.size} title ${lut.title}  ${parts.join( '  ' )}` );

	}

	if ( opt.out && opt.in ) {

		const cell = Number( opt.cell );
		const inputs = String( opt.in ).split( ',' );
		const w1 = Math.floor( cell / inputs.length ), h1 = Math.round( w1 * 9 / 16 );
		const base = Buffer.alloc( cell * h1 * 3 );
		for ( let i = 0; i < inputs.length; i ++ ) {

			const { data } = await sharp( inputs[ i ] ).resize( w1, h1, { fit: 'cover' } ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
			for ( let y = 0; y < h1; y ++ ) data.copy( base, ( y * cell + i * w1 ) * 3, y * w1 * 3, ( y + 1 ) * w1 * 3 );

		}

		const variants = [ { name: 'no LUT', buf: base } ];
		for ( const { name, lut } of parsed ) {

			const out = Buffer.alloc( base.length );
			for ( let i = 0; i < base.length; i += 3 ) {

				sampleLut( lut, base[ i ] / 255, base[ i + 1 ] / 255, base[ i + 2 ] / 255, tmp );
				out[ i ] = Math.round( Math.min( Math.max( tmp[ 0 ], 0 ), 1 ) * 255 ); out[ i + 1 ] = Math.round( Math.min( Math.max( tmp[ 1 ], 0 ), 1 ) * 255 ); out[ i + 2 ] = Math.round( Math.min( Math.max( tmp[ 2 ], 0 ), 1 ) * 255 );

			}

			variants.push( { name: `${name}${lut.title ? ` ("${lut.title}")` : ''}`, buf: out } );

		}

		const cols = 2, rows = Math.ceil( variants.length / cols ), lh = 22, pad = 4;
		const comps = [];
		for ( let i = 0; i < variants.length; i ++ ) {

			const x = pad + ( i % cols ) * ( cell + pad ), y = pad + Math.floor( i / cols ) * ( h1 + lh + pad );
			comps.push( { input: await sharp( variants[ i ].buf, { raw: { width: cell, height: h1, channels: 3 } } ).png().toBuffer(), left: x, top: y } );
			comps.push( { input: Buffer.from( `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${lh}"><rect width="100%" height="100%" fill="#202020"/><text x="3" y="15" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#f2f2f2">${variants[ i ].name.replace( /&/g, '&amp;' )}</text></svg>` ), left: x, top: y + h1 } );

		}

		await sharp( { create: { width: cols * ( cell + pad ) + pad, height: rows * ( h1 + lh + pad ) + pad, channels: 3, background: '#202020' } } ).composite( comps ).png().toFile( opt.out );
		console.log( opt.out );

	}

}
