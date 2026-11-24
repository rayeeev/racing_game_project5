#!/usr/bin/env node
// Build labelled contact sheets from a directory of PNG screenshots.
// usage: node tools/assets/car-montage.mjs <dir> <outPrefix> [--cols 3] [--rows 3] [--w 800] [--h 450] [--filter regex] [--files a.png,b.png]
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const argv = process.argv.slice( 2 );
const dir = argv[ 0 ];
const outPrefix = argv[ 1 ];
const opt = ( k, d ) => ( argv.includes( '--' + k ) ? argv[ argv.indexOf( '--' + k ) + 1 ] : d );
const cols = Number( opt( 'cols', 3 ) ), rows = Number( opt( 'rows', 3 ) );
const W = Number( opt( 'w', 800 ) ), H = Number( opt( 'h', 450 ) );
const filter = new RegExp( opt( 'filter', '.' ) );
const LABEL = 24;

let files;
if ( argv.includes( '--files' ) ) files = opt( 'files', '' ).split( ',' ).map( ( f ) => ( f.startsWith( '/' ) ? f : join( dir, f ) ) );
else files = readdirSync( dir ).filter( ( f ) => f.endsWith( '.png' ) && ! f.startsWith( '_' ) && filter.test( f ) ).sort().map( ( f ) => join( dir, f ) );

const per = cols * rows;
const sheets = [];
for ( let s = 0; s * per < files.length; s ++ ) {

	const chunk = files.slice( s * per, ( s + 1 ) * per );
	const comps = [];
	for ( let i = 0; i < chunk.length; i ++ ) {

		const x = ( i % cols ) * W, y = Math.floor( i / cols ) * ( H + LABEL );
		const buf = await sharp( chunk[ i ] ).resize( W, H, { fit: 'contain', background: '#000' } ).png().toBuffer();
		const name = basename( chunk[ i ] ).replace( /\.png$/, '' ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' );
		const label = Buffer.from( `<svg width="${W}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000"/><text x="6" y="17" font-size="15" fill="#fff" font-family="Helvetica, Arial, sans-serif">${name}</text></svg>` );
		comps.push( { input: label, left: x, top: y }, { input: buf, left: x, top: y + LABEL } );

	}

	const usedRows = Math.ceil( chunk.length / cols );
	const out = `${outPrefix}${files.length > per ? '-' + String( s + 1 ).padStart( 2, '0' ) : ''}.png`;
	await sharp( { create: { width: W * cols, height: usedRows * ( H + LABEL ), channels: 3, background: '#181818' } } ).composite( comps ).png().toFile( out );
	sheets.push( out );

}

console.log( sheets.join( '\n' ) );
