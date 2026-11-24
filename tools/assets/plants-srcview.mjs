#!/usr/bin/env node
// Debug: orthographic side/top renders of every mesh node of a Poly Haven source glTF (albedo with alpha cut-out),
// laid out in one sheet. Used to understand the sources and to validate the software rasteriser.
//   node tools/assets/plants-srcview.mjs <id> <out.png> [pxPerM=1000] [view=side|top|both] [res=2k] [diffOverride.jpg]
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, TexSet, loadSoup, boundsOf, Raster, lin2srgb8, mergeMeshes } from './plants-lib.mjs';

const [ id, out, pxS = '1000', view = 'both', res = '2k', diffOverride ] = process.argv.slice( 2 );
const pxPerM = Number( pxS );

export async function loadAssetTex( id, res = '2k', diffOverride = null ) {

	const dir = join( SRC, id ), maps = join( SRC, id + '__maps' );
	let alpha = null;
	for ( const k of [ 'alpha', 'opacity' ] ) {

		const p = join( maps, `${id}_${k}_${res}.png` );
		if ( existsSync( p ) ) alpha = p;

	}

	return TexSet.load( {
		name: id,
		diff: diffOverride || join( dir, 'textures', `${id}_diff_${res}.jpg` ),
		alpha,
		nor: join( dir, 'textures', `${id}_nor_gl_${res}.jpg` ),
		arm: join( dir, 'textures', `${id}_arm_${res}.jpg` ),
	} );

}

const tex = await loadAssetTex( id, res, diffOverride );
const nodes = await loadSoup( join( SRC, id, `${id}_${res}.gltf` ) );
const bg = [ 0.06, 0.07, 0.09 ];
const tiles = [];
for ( const node of nodes ) {

	const mesh = mergeMeshes( node.prims );
	mesh.tex = tex;
	const b = boundsOf( mesh );
	const views = [];
	if ( view !== 'top' ) views.push( { name: 'side', frame: { o: [ b.min[ 0 ], b.min[ 1 ], 0 ], u: [ 1, 0, 0 ], v: [ 0, 1, 0 ], n: [ 0, 0, 1 ] }, wM: b.size[ 0 ], hM: b.size[ 1 ] } );
	if ( view !== 'side' ) views.push( { name: 'top', frame: { o: [ b.min[ 0 ], 0, b.max[ 2 ] ], u: [ 1, 0, 0 ], v: [ 0, 0, - 1 ], n: [ 0, 1, 0 ] }, wM: b.size[ 0 ], hM: b.size[ 2 ] } );
	for ( const vw of views ) {

		const w = Math.max( 8, Math.ceil( vw.wM * pxPerM ) ), h = Math.max( 8, Math.ceil( vw.hM * pxPerM ) );
		const r = new Raster( w, h, w / pxPerM, h / pxPerM, 3 ).draw( mesh, vw.frame ).resolve();
		const buf = Buffer.alloc( w * h * 3 );
		for ( let k = 0; k < w * h; k ++ ) for ( let c = 0; c < 3; c ++ ) buf[ k * 3 + c ] = lin2srgb8( r.rgb[ k * 3 + c ] * r.a[ k ] + bg[ c ] * ( 1 - r.a[ k ] ) );
		tiles.push( { name: `${node.name.replace( id + '_', '' )} ${vw.name} ${( b.size[ 0 ] * 100 ).toFixed( 0 )}x${( b.size[ 1 ] * 100 ).toFixed( 0 )}x${( b.size[ 2 ] * 100 ).toFixed( 0 )}cm ${mesh.idx.length / 3}t`, w, h, buf } );

	}

}

// simple flow layout
const maxW = 1900;
let x = 0, y = 0, rowH = 0;
const comps = [];
for ( const t of tiles ) {

	if ( x + t.w > maxW && x > 0 ) {

		x = 0; y += rowH + 26; rowH = 0;

	}

	comps.push( { input: await sharp( t.buf, { raw: { width: t.w, height: t.h, channels: 3 } } ).png().toBuffer(), left: x, top: y } );
	const lw = Math.max( t.w, 8 * t.name.length );
	comps.push( { input: Buffer.from( `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="20"><text x="2" y="14" font-family="Helvetica" font-size="12" fill="#fff">${t.name}</text></svg>` ), left: x, top: y + t.h + 2 } );
	x += Math.max( t.w, lw ) + 12;
	rowH = Math.max( rowH, t.h );

}

await sharp( { create: { width: maxW + 100, height: y + rowH + 30, channels: 3, background: '#20242b' } } ).composite( comps ).png().toFile( out );
console.log( 'wrote', out, tiles.length, 'tiles' );
