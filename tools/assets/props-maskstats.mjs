#!/usr/bin/env node
// Statistics of textures inside the UV islands of one source material.
// usage: node tools/assets/props-maskstats.mjs <file.gltf> <materialName> <image> [<image> ...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { basename } from 'node:path';
import { rasterizeUvMask } from './props-lib.mjs';
const [ file, matName, ...images ] = process.argv.slice( 2 );
const doc = await new NodeIO().registerExtensions( ALL_EXTENSIONS ).read( file );
const size = 1024;
const mask = new Uint8Array( size * size );
for ( const mesh of doc.getRoot().listMeshes() ) for ( const prim of mesh.listPrimitives() ) {
	if ( prim.getMaterial()?.getName() !== matName ) continue;
	const uvA = prim.getAttribute( 'TEXCOORD_0' ); const n = uvA.getCount(); const uv = new Float32Array( n * 2 ); const el = [];
	for ( let i = 0; i < n; i ++ ) { uvA.getElement( i, el ); uv[ i * 2 ] = el[ 0 ]; uv[ i * 2 + 1 ] = el[ 1 ]; }
	rasterizeUvMask( { uv, idx: new Uint32Array( prim.getIndices().getArray() ) }, size, mask );
}
let cover = 0; for ( const m of mask ) cover += m;
console.log( `${matName}: UV coverage ${( cover / mask.length * 100 ).toFixed( 2 )}% of the atlas` );
for ( const img of images ) {
	const { data, info } = await sharp( img ).resize( size, size, { fit: 'fill' } ).raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels; const out = [];
	for ( let c = 0; c < Math.min( 3, ch ); c ++ ) {
		const vals = [];
		for ( let i = 0; i < mask.length; i ++ ) if ( mask[ i ] ) vals.push( data[ i * ch + c ] );
		vals.sort( ( a, b ) => a - b );
		const p = ( q ) => ( vals[ Math.floor( ( vals.length - 1 ) * q ) ] / 255 ).toFixed( 2 );
		out.push( `${'RGB'[ c ]} p05 ${p( 0.05 )} p25 ${p( 0.25 )} p50 ${p( 0.5 )} p75 ${p( 0.75 )} p95 ${p( 0.95 )}` );
	}
	console.log( '  ' + basename( img ).padEnd( 40 ), out.join( ' | ' ) );
}
