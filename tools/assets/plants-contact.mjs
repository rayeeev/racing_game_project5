#!/usr/bin/env node
// Contact sheet builder: node tools/assets/plants-contact.mjs <out.png> <cols> <cellW> <cellH> <img1> <img2> ...
// Each cell gets the file's basename as a label. Used to review many thumbnails / renders in one image.
import sharp from 'sharp';
import { basename } from 'node:path';

const [ out, colsS, cwS, chS, ...files ] = process.argv.slice( 2 );
const cols = Number( colsS ), cw = Number( cwS ), ch = Number( chS );
if ( ! out || ! files.length ) {

	console.error( 'usage: plants-contact.mjs <out.png> <cols> <cellW> <cellH> <img...>' );
	process.exit( 2 );

}

const rows = Math.ceil( files.length / cols );
const labelH = 22;
const composites = [];
for ( let i = 0; i < files.length; i ++ ) {

	const x = ( i % cols ) * cw, y = Math.floor( i / cols ) * ( ch + labelH );
	try {

		const buf = await sharp( files[ i ] ).resize( cw, ch, { fit: 'contain', background: '#2b2f36' } ).flatten( { background: '#2b2f36' } ).png().toBuffer();
		composites.push( { input: buf, left: x, top: y } );

	} catch ( e ) {

		console.error( 'skip', files[ i ], e.message );

	}

	const label = basename( files[ i ] ).replace( /\.(png|jpg|webp)$/i, '' ).replace( /[<&>]/g, '' );
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#fff">${label}</text></svg>`;
	composites.push( { input: Buffer.from( svg ), left: x, top: y + ch } );

}

await sharp( { create: { width: cols * cw, height: rows * ( ch + labelH ), channels: 3, background: '#000' } } ).composite( composites ).png().toFile( out );
console.log( 'wrote', out, cols * cw, 'x', rows * ( ch + labelH ) );
