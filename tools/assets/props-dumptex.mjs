#!/usr/bin/env node
// Dumps the embedded textures of GLB files as PNG (for visual inspection). usage: node tools/assets/props-dumptex.mjs <outDir> <file.glb> ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
const [ outDir, ...files ] = process.argv.slice( 2 );
mkdirSync( outDir, { recursive: true } );
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder } );
for ( const file of files ) {
	const doc = await io.read( file );
	for ( const tex of doc.getRoot().listTextures() ) {
		const out = join( outDir, `${basename( file, '.glb' )}__${tex.getName()}.png` );
		const img = sharp( Buffer.from( tex.getImage() ) );
		const md = await img.metadata();
		await img.png().toFile( out );
		console.log( out, tex.getMimeType(), `${md.width}x${md.height}`, md.hasAlpha ? 'alpha' : '', `${( tex.getImage().byteLength / 1024 ).toFixed( 0 )} KB` );
	}
}
