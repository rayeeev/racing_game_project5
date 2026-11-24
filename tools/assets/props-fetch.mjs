#!/usr/bin/env node
// Poly Haven model fetcher (CC0). Downloads the glTF package (.gltf + .bin + textures/) of each asset id.
//
//   node tools/assets/props-fetch.mjs --res 2k [--list] [--dest assets-src/props] [--api-cache <dir>] <id> [<id>:<res> ...]
//
// --list   only print the package contents/sizes (nothing is downloaded except the small files-API json)
// Every asset goes into its own directory <dest>/<id>/ which must not already contain other files than a previous
// (possibly partial) download of the same package. Downloaded files are treated as untrusted data: relative paths are
// validated (no absolute paths, no ".."), nothing is executed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, normalize, isAbsolute, sep } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { res: '2k', dest: 'assets-src/props', 'api-cache': null, list: false };
const ids = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a === '--list' ) opt.list = true;
	else if ( a.startsWith( '--' ) ) opt[ a.slice( 2 ) ] = argv[ ++ i ];
	else ids.push( a );

}

if ( ids.length === 0 ) {

	console.error( 'usage: props-fetch.mjs --res 2k [--list] [--dest dir] [--api-cache dir] <id>[:res] ...' );
	process.exit( 2 );

}

const UA = 'asset-fetcher/1.0';

function curl( url, out ) {

	mkdirSync( dirname( out ), { recursive: true } );
	for ( let attempt = 1; attempt <= 4; attempt ++ ) {

		try {

			execFileSync( 'curl', [ '-sS', '-L', '-f', '-A', UA, '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '-o', out, url ], { stdio: [ 'ignore', 'ignore', 'inherit' ] } );
			return;

		} catch ( e ) {

			console.log( `  retry ${attempt} for ${url}` );

		}

	}

	throw new Error( 'download failed: ' + url );

}

function safeRel( rel ) {

	const n = normalize( rel );
	if ( isAbsolute( n ) || n.split( sep ).includes( '..' ) || n.startsWith( '..' ) ) throw new Error( 'unsafe relative path in package: ' + rel );
	return n;

}

let total = 0;
for ( const spec of ids ) {

	const [ id, resOverride ] = spec.split( ':' );
	const res = resOverride || opt.res;
	if ( ! /^[A-Za-z0-9_]+$/.test( id ) ) throw new Error( 'bad id ' + id );

	const cacheDir = opt[ 'api-cache' ];
	let filesJson;
	const cacheFile = cacheDir ? join( cacheDir, id + '.files.json' ) : null;
	if ( cacheFile && existsSync( cacheFile ) && statSync( cacheFile ).size > 100 ) {

		filesJson = JSON.parse( readFileSync( cacheFile, 'utf8' ) );

	} else {

		const out = execFileSync( 'curl', [ '-sS', '-L', '-f', '-A', UA, '--retry', '3', `https://api.polyhaven.com/files/${id}` ], { maxBuffer: 1 << 26 } );
		filesJson = JSON.parse( out.toString( 'utf8' ) );
		if ( cacheFile ) {

			mkdirSync( cacheDir, { recursive: true } );
			writeFileSync( cacheFile, out );

		}

	}

	const g = filesJson.gltf;
	if ( ! g ) {

		console.log( `${id}: NO gltf package (keys: ${Object.keys( filesJson ).join( ',' )})` );
		continue;

	}

	const pkg = g[ res ]?.gltf;
	if ( ! pkg ) {

		console.log( `${id}: no ${res} gltf (available: ${Object.keys( g ).join( ',' )})` );
		continue;

	}

	const entries = [ [ pkg.url.split( '/' ).pop(), pkg.url, pkg.size ] ];
	for ( const [ rel, f ] of Object.entries( pkg.include || {} ) ) entries.push( [ safeRel( rel ), f.url, f.size ] );
	const sum = entries.reduce( ( s, e ) => s + e[ 2 ], 0 );
	total += sum;
	console.log( `${id} @${res}: ${entries.length} files, ${( sum / 1e6 ).toFixed( 1 )} MB (resolutions: ${Object.keys( g ).join( ',' )})` );
	for ( const [ rel, , size ] of entries ) console.log( `    ${rel}  ${( size / 1e6 ).toFixed( 2 )} MB` );
	if ( opt.list ) continue;

	const destDir = resolve( opt.dest, id );
	mkdirSync( destDir, { recursive: true } );
	for ( const [ rel, url, size ] of entries ) {

		if ( ! /^https:\/\/dl\.polyhaven\.org\//.test( url ) ) throw new Error( 'unexpected download host: ' + url );
		const out = join( destDir, rel );
		if ( ! resolve( out ).startsWith( destDir + sep ) ) throw new Error( 'path escapes dest: ' + rel );
		if ( existsSync( out ) && statSync( out ).size === size ) continue;
		curl( url, out );
		const got = statSync( out ).size;
		if ( got !== size ) throw new Error( `size mismatch for ${rel}: got ${got}, expected ${size}` );

	}

	console.log( `  -> ${destDir}` );

}

console.log( `total ${( total / 1e6 ).toFixed( 1 )} MB` );
