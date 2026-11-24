#!/usr/bin/env node
// Download a Poly Haven model (glTF set: .gltf + .bin + textures/) into assets-src/trees/<id>/
//
//   node tools/assets/trees-fetch.mjs <id> [--res 2k] [--extra twig_diff:4k:png,twig_alpha:4k:png]
//
// - Reads https://api.polyhaven.com/files/<id> (cached in assets-src/trees/_api/<id>.json).
// - Every file listed under gltf/<res>/gltf/include is stored with its relative path preserved.
// - --extra map:res:ext downloads additional individual texture maps into assets-src/trees/<id>/extra/.
// - Files are verified against the md5 given by the API; existing files with a matching md5 are skipped.
// Downloads are data only: nothing in the download directory is ever executed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const args = process.argv.slice( 2 );
const id = args[ 0 ];
if ( ! id || id.startsWith( '--' ) ) {

	console.error( 'usage: node tools/assets/trees-fetch.mjs <id> [--res 2k] [--extra map:res:ext,...]' );
	process.exit( 2 );

}

const opt = ( k, d ) => {

	const i = args.indexOf( '--' + k );
	return i >= 0 ? args[ i + 1 ] : d;

};

const res = opt( 'res', '2k' );
const extras = ( opt( 'extra', '' ) || '' ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
const noModel = args.includes( '--no-model' );

function curl( url, out ) {

	mkdirSync( dirname( out ), { recursive: true } );
	execFileSync( 'curl', [ '-sS', '-L', '-A', 'asset-fetcher/1.0', '--fail', '--retry', '5', '--retry-delay', '2', '--retry-all-errors', '-C', '-', '-o', out, url ], { stdio: [ 'ignore', 'inherit', 'inherit' ] } );

}

function md5( file ) {

	return new Promise( ( res2, rej ) => {

		const h = createHash( 'md5' );
		createReadStream( file ).on( 'data', ( d ) => h.update( d ) ).on( 'end', () => res2( h.digest( 'hex' ) ) ).on( 'error', rej );

	} );

}

async function fetchVerified( url, out, size, sum ) {

	for ( let attempt = 0; attempt < 4; attempt ++ ) {

		if ( existsSync( out ) && statSync( out ).size === size && ( ! sum || ( await md5( out ) ) === sum ) ) return 'ok';
		if ( existsSync( out ) && statSync( out ).size >= size ) execFileSync( 'rm', [ '-f', out ] );
		try {

			curl( url, out );

		} catch ( e ) {

			console.log( `  retry ${attempt + 1} for ${url}: ${e.message.split( '\n' )[ 0 ]}` );

		}

	}

	if ( existsSync( out ) && statSync( out ).size === size && ( ! sum || ( await md5( out ) ) === sum ) ) return 'ok';
	throw new Error( 'download failed: ' + url );

}

const apiDir = join( ROOT, 'assets-src/trees/_api' );
mkdirSync( apiDir, { recursive: true } );
const apiFile = join( apiDir, id + '.json' );
if ( ! existsSync( apiFile ) ) curl( `https://api.polyhaven.com/files/${id}`, apiFile );
const api = JSON.parse( readFileSync( apiFile, 'utf8' ) );

const dest = join( ROOT, 'assets-src/trees', id );
mkdirSync( dest, { recursive: true } );
let total = 0;

if ( ! noModel ) {

	const entry = api.gltf?.[ res ]?.gltf;
	if ( ! entry ) throw new Error( `no gltf/${res} for ${id}` );
	const main = join( dest, entry.url.split( '/' ).pop() );
	await fetchVerified( entry.url, main, entry.size, entry.md5 );
	total += entry.size;
	console.log( 'ok', main );
	for ( const [ rel, f ] of Object.entries( entry.include || {} ) ) {

		if ( rel.includes( '..' ) || rel.startsWith( '/' ) ) throw new Error( 'suspicious relative path: ' + rel );
		const out = join( dest, rel );
		await fetchVerified( f.url, out, f.size, f.md5 );
		total += f.size;
		console.log( 'ok', out, ( f.size / 1e6 ).toFixed( 2 ) + ' MB' );

	}

}

// --blend : also fetch the 1k .blend (only the .blend itself; its external textures are not needed for geometry)
//           into assets-src/trees/_blend/<id>/ . The .blend holds the artist's LOD1/LOD2 card meshes that the
//           glTF download lacks; it is only ever opened as DATA by trees-blender.mjs (autoexec disabled).
if ( args.includes( '--blend' ) ) {

	const f = api.blend?.[ '1k' ]?.blend;
	if ( ! f ) throw new Error( 'no blend/1k for ' + id );
	const out = join( ROOT, 'assets-src/trees/_blend', id, f.url.split( '/' ).pop() );
	await fetchVerified( f.url, out, f.size, f.md5 );
	total += f.size;
	console.log( 'ok', out, ( f.size / 1e6 ).toFixed( 2 ) + ' MB' );

}

for ( const ex of extras ) {

	const [ map, r, ext ] = ex.split( ':' );
	const f = api[ map ]?.[ r ]?.[ ext ];
	if ( ! f ) {

		console.log( 'MISSING extra', ex, 'available maps:', Object.keys( api ).join( ',' ) );
		continue;

	}

	const out = join( dest, 'extra', f.url.split( '/' ).pop() );
	await fetchVerified( f.url, out, f.size, f.md5 );
	total += f.size;
	console.log( 'ok', out, ( f.size / 1e6 ).toFixed( 2 ) + ' MB' );

}

writeFileSync( join( apiDir, id + '.done' ), new Date().toISOString() + '\n' );
console.log( `done ${id}: ${( total / 1e6 ).toFixed( 1 )} MB` );
