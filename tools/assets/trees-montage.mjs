#!/usr/bin/env node
// Small review helper: tile images into one PNG.
//   node tools/assets/trees-montage.mjs <out.png> <cell px> <cols> <file1> <file2> ...
// Each input is fitted into a cell x cell square (letterboxed on dark grey); alpha is flattened.
import sharp from 'sharp';

const [ out, cellStr, colsStr, ...files ] = process.argv.slice( 2 );
const cell = Number( cellStr );
const cols = Math.min( Number( colsStr ), files.length );
const rows = Math.ceil( files.length / cols );
const imgs = await Promise.all( files.map( ( f ) => sharp( f ).resize( cell, cell, { fit: 'contain', background: '#202020' } ).flatten( { background: '#202020' } ).png().toBuffer() ) );
await sharp( { create: { width: cols * cell, height: rows * cell, channels: 3, background: '#202020' } } )
	.composite( imgs.map( ( input, i ) => ( { input, left: ( i % cols ) * cell, top: Math.floor( i / cols ) * cell } ) ) )
	.png().toFile( out );
console.log( 'wrote', out );
