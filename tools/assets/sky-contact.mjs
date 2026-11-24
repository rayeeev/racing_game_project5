#!/usr/bin/env node
// Contact sheet of images with labels (selection aid).
//   node tools/assets/sky-contact.mjs <out.png> <cols> <cellW> <cellH> <img1> <img2> ...
// The label under each cell is the file's basename without extension.

import sharp from 'sharp';
import { basename, extname } from 'node:path';

const [ out, colsS, cwS, chS, ...files ] = process.argv.slice( 2 );
const cols = Number( colsS ), cw = Number( cwS ), ch = Number( chS );
const labelH = 22;
const rows = Math.ceil( files.length / cols );
const W = cols * cw, H = rows * ( ch + labelH );

const composites = [];
for ( let i = 0; i < files.length; i ++ ) {

	const x = ( i % cols ) * cw, y = Math.floor( i / cols ) * ( ch + labelH );
	const buf = await sharp( files[ i ] ).resize( cw - 4, ch - 4, { fit: 'cover' } ).png().toBuffer();
	composites.push( { input: buf, left: x + 2, top: y + 2 } );
	const name = basename( files[ i ], extname( files[ i ] ) ).replace( /[<>&]/g, '' );
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="4" y="16" font-family="Helvetica,Arial,sans-serif" font-size="14" fill="#fff">${name}</text></svg>`;
	composites.push( { input: Buffer.from( svg ), left: x, top: y + ch } );

}

await sharp( { create: { width: W, height: H, channels: 3, background: '#000' } } ).composite( composites ).png().toFile( out );
console.log( 'wrote', out, W + 'x' + H );
