#!/usr/bin/env node
// Labelled contact sheet builder (sharp).
//
//   node tools/assets/tex-sheet.mjs --out <abs.png> [--cell 256] [--cols 6] [--tile 1] [--bg 202020]
//        [--labels a,b,c] [--crop 0] <image> <image> ...
//
//   --tile N   repeat every image NxN inside its cell (N=3 -> seam check)
//   --crop S   instead of scaling the whole image, cut a centred SxS pixel crop (1:1 detail check)
//   --aspect A cell width / height for the plain mode (default 1), e.g. 1.8 for 16:9 screenshots
//   --labels   comma separated labels (default: "<parent dir>/<file name>" without extension)
//
// Images are read as-is (no colour management), so the sheet shows the stored sRGB values.

import sharp from 'sharp';
import { basename, dirname, extname } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { cell: 256, cols: 6, tile: 1, bg: '202020', crop: 0, out: null, labels: null, aspect: 1 };
const files = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a.startsWith( '--' ) ) opt[ a.slice( 2 ) ] = argv[ ++ i ];
	else files.push( a );

}

if ( ! opt.out || files.length === 0 ) {

	console.error( 'usage: tex-sheet.mjs --out <png> [--cell 256] [--cols 6] [--tile 1] [--crop 0] [--labels a,b] <images...>' );
	process.exit( 2 );

}

const cell = Number( opt.cell ), cols = Math.min( Number( opt.cols ), files.length ), tile = Number( opt.tile ), crop = Number( opt.crop );
const labelH = 22, pad = 4;
const cellH = Math.round( cell / Number( opt.aspect ) );
const rows = Math.ceil( files.length / cols );
const W = cols * ( cell + pad ) + pad, H = rows * ( cellH + labelH + pad ) + pad;
const labels = opt.labels ? String( opt.labels ).split( ',' ) : files.map( ( f ) => {

	const b = basename( f, extname( f ) );
	const d = basename( dirname( f ) );
	return [ 'albedo', 'normal', 'arm', 'height', 'diff', 'nor_gl', 'disp' ].includes( b ) ? `${d}/${b}` : b;

} );

const esc = ( s ) => String( s ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
const composites = [];

for ( let i = 0; i < files.length; i ++ ) {

	const x = pad + ( i % cols ) * ( cell + pad );
	const y = pad + Math.floor( i / cols ) * ( cellH + labelH + pad );
	let buf;
	try {

		if ( crop > 0 ) {

			const meta = await sharp( files[ i ] ).metadata();
			const s = Math.min( crop, meta.width, meta.height );
			buf = await sharp( files[ i ] )
				.extract( { left: Math.floor( ( meta.width - s ) / 2 ), top: Math.floor( ( meta.height - s ) / 2 ), width: s, height: s } )
				.resize( cell, cell, { kernel: 'lanczos3' } ).removeAlpha().png().toBuffer();

		} else if ( tile > 1 ) {

			const sub = Math.floor( cell / tile );
			const one = await sharp( files[ i ] ).resize( sub, sub, { kernel: 'lanczos3' } ).removeAlpha().png().toBuffer();
			const parts = [];
			for ( let ty = 0; ty < tile; ty ++ ) for ( let tx = 0; tx < tile; tx ++ ) parts.push( { input: one, left: tx * sub, top: ty * sub } );
			buf = await sharp( { create: { width: sub * tile, height: sub * tile, channels: 3, background: '#000' } } ).composite( parts ).png().toBuffer();

		} else {

			buf = await sharp( files[ i ] ).resize( cell, cellH, { fit: 'contain', background: '#' + opt.bg, kernel: 'lanczos3' } ).flatten( { background: '#' + opt.bg } ).png().toBuffer();

		}

	} catch ( e ) {

		console.error( 'failed:', files[ i ], e.message );
		continue;

	}

	composites.push( { input: buf, left: x, top: y } );
	const fs = Math.max( 9, Math.min( 14, Math.floor( ( cell * 1.75 ) / Math.max( 8, labels[ i ].length ) ) ) );
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}"><rect width="100%" height="100%" fill="#${opt.bg}"/><text x="3" y="15" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" fill="#f2f2f2">${esc( labels[ i ] )}</text></svg>`;
	composites.push( { input: Buffer.from( svg ), left: x, top: y + cellH } );

}

await sharp( { create: { width: W, height: H, channels: 3, background: '#' + opt.bg } } ).composite( composites ).png( { compressionLevel: 6 } ).toFile( opt.out );
console.log( `${opt.out}  ${W}x${H}  (${files.length} images, ${cols} cols)` );
