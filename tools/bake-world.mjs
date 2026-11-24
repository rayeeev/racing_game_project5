#!/usr/bin/env node
// Bakes the world: node tools/bake-world.mjs [--debug <dir>]
// Reads src/sim/layout.js (circuit + macro terrain), writes public/assets/world/ (see src/sim/world.js for the formats).
// Deterministic: two runs produce identical bytes. With --debug it also writes overview PNGs for inspection.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { LAYOUT, WORLD } from '../src/sim/layout.js';
import { generateWorld } from '../src/sim/terrainGen.js';
import { Track } from '../src/sim/track.js';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const outDir = path.join( root, 'public/assets/world' );
const debugIndex = process.argv.indexOf( '--debug' );
const debugDir = debugIndex >= 0 ? path.resolve( process.argv[ debugIndex + 1 ] ) : null;

const track = new Track( LAYOUT );
let last = performance.now();
let stage = 'setup';
const world = generateWorld( track, ( next ) => {

	const now = performance.now();
	console.log( `  ${stage.padEnd( 16 )} ${( ( now - last ) / 1000 ).toFixed( 2 )} s` );
	stage = next;
	last = now;

} );
console.log( `  ${stage.padEnd( 16 )} ${( ( performance.now() - last ) / 1000 ).toFixed( 2 )} s` );

await mkdir( outDir, { recursive: true } );
const png = ( data, size ) => sharp( Buffer.from( data.buffer, data.byteOffset, data.byteLength ), { raw: { width: size, height: size, channels: 4 } } ).png( { compressionLevel: 9 } ).toBuffer();
const files = {
	'height.bin': Buffer.from( world.heights.buffer ),
	'outer_height.bin': Buffer.from( world.outerHeights.buffer ),
	'surface.bin': Buffer.from( world.surface.buffer ),
	'splat0.png': await png( world.splat0, world.mapSize ),
	'splat1.png': await png( world.splat1, world.mapSize ),
	'fields.png': await png( world.fields, world.mapSize ),
};

const hash = createHash( 'sha256' );
const sizes = {};
for ( const [ name, buffer ] of Object.entries( files ) ) {

	hash.update( name ).update( buffer );
	sizes[ name ] = buffer.length;
	await writeFile( path.join( outDir, name ), buffer );

}

const meta = {
	version: 1,
	seed: WORLD.seed,
	n: world.n,
	cell: WORLD.cell,
	minX: WORLD.minX,
	minZ: WORLD.minZ,
	size: WORLD.size,
	waterLevel: WORLD.waterLevel,
	mapSize: world.mapSize,
	outer: { n: world.outerN, cell: WORLD.outerCell, minX: - WORLD.outerSize / 2, minZ: - WORLD.outerSize / 2, size: WORLD.outerSize },
	track: { name: LAYOUT.name, length: track.length, sectors: track.sectors, checkpoints: track.checkpoints.length, gridS: track.gridS },
	files: { height: 'height.bin', outerHeight: 'outer_height.bin', surface: 'surface.bin', splat0: 'splat0.png', splat1: 'splat1.png', fields: 'fields.png' },
	bytes: sizes,
	stats: world.stats,
	hash: hash.digest( 'hex' ).slice( 0, 16 ),
};
await writeFile( path.join( outDir, 'world.json' ), JSON.stringify( meta, null, '\t' ) + '\n' );

console.log( `world baked → ${path.relative( root, outDir )}  hash ${meta.hash}` );
console.log( `  heights ${world.stats.minHeight.toFixed( 1 )} .. ${world.stats.maxHeight.toFixed( 1 )} m, max cut ${world.stats.maxCut.toFixed( 1 )} m, max fill ${world.stats.maxFill.toFixed( 1 )} m` );
console.log( '  biome coverage %', JSON.stringify( world.stats.biomeCoverage ) );
console.log( '  bytes', JSON.stringify( sizes ) );

if ( debugDir ) {

	await mkdir( debugDir, { recursive: true } );
	const LAYER_COLORS = [ [ 74, 110, 42 ], [ 138, 132, 70 ], [ 58, 66, 36 ], [ 112, 86, 58 ], [ 150, 146, 138 ], [ 122, 120, 118 ], [ 140, 134, 124 ], [ 176, 166, 138 ] ];

	/** Renders a square region (world coordinates) of the inner area: biome colour x hill shade, forest tint, road in dark grey. */
	const render = async ( file, x0, z0, extent, pixels ) => {

		const out = Buffer.alloc( pixels * pixels * 3 );
		const { n, heights, splat0, splat1, fields, mapSize } = world;
		const h = ( x, z ) => {

			const ix = Math.max( 0, Math.min( n - 1, Math.round( ( x - WORLD.minX ) / WORLD.cell ) ) ), iz = Math.max( 0, Math.min( n - 1, Math.round( ( z - WORLD.minZ ) / WORLD.cell ) ) );
			return heights[ iz * n + ix ];

		};

		const proj = {};
		const step = extent / pixels;
		for ( let py = 0; py < pixels; py ++ ) {

			for ( let px = 0; px < pixels; px ++ ) {

				const x = x0 + ( px + 0.5 ) * step, z = z0 + ( py + 0.5 ) * step;
				const mi = Math.max( 0, Math.min( mapSize - 1, Math.round( ( x - WORLD.minX ) / WORLD.size * ( mapSize - 1 ) ) ) );
				const mj = Math.max( 0, Math.min( mapSize - 1, Math.round( ( z - WORLD.minZ ) / WORLD.size * ( mapSize - 1 ) ) ) );
				const k = ( mj * mapSize + mi ) * 4;
				let r = 0, g = 0, b = 0;
				for ( let i = 0; i < 4; i ++ ) {

					const w0 = splat0[ k + i ] / 255, w1 = splat1[ k + i ] / 255;
					r += w0 * LAYER_COLORS[ i ][ 0 ] + w1 * LAYER_COLORS[ 4 + i ][ 0 ];
					g += w0 * LAYER_COLORS[ i ][ 1 ] + w1 * LAYER_COLORS[ 4 + i ][ 1 ];
					b += w0 * LAYER_COLORS[ i ][ 2 ] + w1 * LAYER_COLORS[ 4 + i ][ 2 ];

				}

				const forest = fields[ k ] / 255;
				r = r * ( 1 - 0.55 * forest ) + 22 * 0.55 * forest;
				g = g * ( 1 - 0.55 * forest ) + 48 * 0.55 * forest;
				b = b * ( 1 - 0.55 * forest ) + 26 * 0.55 * forest;
				const e = Math.max( WORLD.cell, step );
				const height = h( x, z );
				const shade = Math.max( 0.25, Math.min( 1.6, 1 + ( ( h( x - e, z ) - h( x + e, z ) ) * 0.7 + ( h( x, z - e ) - h( x, z + e ) ) * 0.7 ) / ( 2 * e ) * 1.6 ) );
				if ( height < WORLD.waterLevel ) {

					const depth = Math.min( 1, ( WORLD.waterLevel - height ) / 20 );
					r = 70 - 40 * depth; g = 130 - 50 * depth; b = 170 - 40 * depth;

				} else {

					r *= shade; g *= shade; b *= shade;

				}

				if ( step <= 2.5 ) {

					track.project( x, z, undefined, proj );
					if ( Math.abs( proj.d ) <= proj.halfWidth ) r = g = b = 52;
					else if ( Math.abs( proj.d ) <= proj.halfWidth + 0.5 ) r = g = b = 235;

				}

				const o = ( py * pixels + px ) * 3;
				out[ o ] = Math.min( 255, r ); out[ o + 1 ] = Math.min( 255, g ); out[ o + 2 ] = Math.min( 255, b );

			}

		}

		await sharp( out, { raw: { width: pixels, height: pixels, channels: 3 } } ).png().toFile( path.join( debugDir, file ) );
		console.log( `  debug ${path.join( debugDir, file )}` );

	};

	await render( 'overview.png', - 1100, - 900, 2100, 1400 );
	await render( 'hairpins.png', - 860, - 600, 620, 1240 );
	await render( 'lakeside.png', - 200, 20, 440, 1100 );
	await render( 'descent.png', 440, - 620, 1040, 1300 );

}
