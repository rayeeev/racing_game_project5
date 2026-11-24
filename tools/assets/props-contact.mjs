#!/usr/bin/env node
// Contact-sheet builder: tiles images (with a filename label) into one PNG so many pictures can be reviewed at once.
// usage: node tools/assets/props-contact.mjs --out <sheet.png> [--cols 4] [--cell 400x280] [--bg 808080] <img> <img> ...
import sharp from 'sharp';
import { basename, extname } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { cols: 4, cell: '400x280', bg: '808080', out: null };
const files = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a.startsWith( '--' ) ) opt[ a.slice( 2 ) ] = argv[ ++ i ];
	else files.push( a );

}

if ( ! opt.out || files.length === 0 ) {

	console.error( 'usage: props-contact.mjs --out sheet.png [--cols 4] [--cell 400x280] img...' );
	process.exit( 2 );

}

const cols = Number( opt.cols );
const [ cw, ch ] = opt.cell.split( 'x' ).map( Number );
const rows = Math.ceil( files.length / cols );
const labelH = 22;
const bg = '#' + opt.bg;

const composites = [];
for ( let i = 0; i < files.length; i ++ ) {

	const x = ( i % cols ) * cw, y = Math.floor( i / cols ) * ( ch + labelH );
	const img = await sharp( files[ i ] ).resize( cw - 4, ch - 4, { fit: 'contain', background: bg } ).flatten( { background: bg } ).png().toBuffer();
	composites.push( { input: img, left: x + 2, top: y + 2 } );
	const label = basename( files[ i ], extname( files[ i ] ) ).replace( /[<&>]/g, '' );
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#fff">${label}</text></svg>`;
	composites.push( { input: Buffer.from( svg ), left: x, top: y + ch } );

}

await sharp( { create: { width: cols * cw, height: rows * ( ch + labelH ), channels: 3, background: bg } } )
	.composite( composites )
	.png()
	.toFile( opt.out );
console.log( 'wrote', opt.out, `${cols * cw}x${rows * ( ch + labelH )}`, files.length, 'images' );
