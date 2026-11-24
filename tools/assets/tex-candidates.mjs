#!/usr/bin/env node
// Writes assets-src/textures/_candidates.json : a manifest (same shape as public/assets/textures/index.json "sets")
// of every raw Poly Haven download in assets-src/textures/<polyhavenId>/, so that dev/preview-tex.html can show
// candidates before they are promoted:   /dev/preview-tex.html?manifest=/assets-src/textures/_candidates.json&sets=a,b
//
//   node tools/assets/tex-candidates.mjs [path/to/polyhaven/textures.json]

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve( 'assets-src/textures' );
const catalogPath = process.argv[ 2 ];
const catalog = catalogPath && existsSync( catalogPath ) ? JSON.parse( readFileSync( catalogPath, 'utf8' ) ) : {};

const sets = [];
for ( const id of readdirSync( ROOT ).sort() ) {

	const dir = join( ROOT, id );
	if ( id.startsWith( '_' ) || ! statSync( dir ).isDirectory() ) continue;
	const files = readdirSync( dir );
	const pick = ( tag ) => {

		const re = new RegExp( `_(${tag})_(\\d+)k\\.jpg$` );
		const f = files.filter( ( n ) => re.test( n ) ).sort( ( a, b ) => Number( re.exec( b )[ 2 ] ) - Number( re.exec( a )[ 2 ] ) )[ 0 ];
		return f ? `/assets-src/textures/${id}/${f}` : null;

	};
	const maps = { albedo: pick( 'diff|diffuse|col|color' ), normal: pick( 'nor_gl' ), arm: pick( 'arm' ), height: pick( 'disp' ) };
	if ( ! maps.albedo || ! maps.normal || ! maps.arm ) continue;
	let info = catalog[ id ];
	const infoFile = join( dir, '_api_info.json' );
	if ( ! info && existsSync( infoFile ) ) info = JSON.parse( readFileSync( infoFile, 'utf8' ) );
	const dim = info?.dimensions ?? [ 2000, 2000 ];
	sets.push( { id, polyhavenId: id, tileSizeMeters: Number( ( dim[ 0 ] / 1000 ).toFixed( 3 ) ), maps } );

}

writeFileSync( join( ROOT, '_candidates.json' ), JSON.stringify( { sets }, null, 1 ) );
console.log( `wrote ${join( ROOT, '_candidates.json' )} (${sets.length} sets)` );
