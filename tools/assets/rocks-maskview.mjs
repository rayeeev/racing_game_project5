#!/usr/bin/env node
// Debug: whole-texture view, UV-mask overlay (masked-out texels tinted blue).  node rocks-maskview.mjs <gltf> <texture> <out.png> [size]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const [ gltf, texFile, out, sizeS ] = process.argv.slice( 2 );
const SIZE = Number( sizeS || 1024 );
const io = await makeIO();
const doc = await io.read( gltf );
const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
const mask = rasterizeUvMask( geos, SIZE, SIZE );
const { data, info } = await sharp( texFile ).resize( SIZE, SIZE, { fit: 'fill' } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
const ch = info.channels;
const buf = Buffer.alloc( SIZE * SIZE * 3 );
for ( let i = 0; i < SIZE * SIZE; i ++ ) {

	const r = data[ i * ch ], g = ch > 1 ? data[ i * ch + 1 ] : r, b = ch > 2 ? data[ i * ch + 2 ] : r;
	if ( mask[ i ] ) { buf[ i * 3 ] = r; buf[ i * 3 + 1 ] = g; buf[ i * 3 + 2 ] = b; } else { buf[ i * 3 ] = r * 0.35; buf[ i * 3 + 1 ] = g * 0.35; buf[ i * 3 + 2 ] = Math.min( 255, b * 0.35 + 150 ); }

}

await sharp( buf, { raw: { width: SIZE, height: SIZE, channels: 3 } } ).png().toFile( out );
console.log( 'wrote', out );
