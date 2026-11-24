#!/usr/bin/env node
// Download a Poly Haven model as glTF (+ .bin + textures) into assets-src/plants/<id>/ .
//   node tools/assets/plants-fetch.mjs <res> <id> [<id> ...]        (res: 1k | 2k | 4k | 8k)
// The download directory must not exist yet or be empty (each download gets its own directory).
// Only relative, non-escaping "include" paths are accepted (downloads are untrusted data).
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, normalize, sep } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const [ res, ...ids ] = process.argv.slice( 2 );
if ( ! res || ! ids.length ) {

	console.error( 'usage: plants-fetch.mjs <res> <id...>' );
	process.exit( 2 );

}

const UA = 'asset-fetcher/1.0';

function curl( url, out ) {

	const args = [ '-sS', '-L', '-f', '-A', UA, '--retry', '4', '--retry-delay', '2', '--retry-all-errors', '--max-time', '900' ];
	if ( out ) args.push( '-o', out );
	args.push( url );
	return execFileSync( 'curl', args, { maxBuffer: 1 << 28 } );

}

function safeRel( p ) {

	const n = normalize( p );
	if ( n.startsWith( '..' ) || n.startsWith( sep ) || /^[a-zA-Z]:/.test( n ) || n.includes( '\0' ) ) throw new Error( 'unsafe path: ' + p );
	return n;

}

for ( const id of ids ) {

	if ( ! /^[a-z0-9_]+$/.test( id ) ) throw new Error( 'bad id ' + id );
	const dir = join( ROOT, 'assets-src/plants', id );
	if ( existsSync( dir ) && readdirSync( dir ).length > 0 ) {

		console.log( `[skip] ${id}: ${dir} already populated` );
		continue;

	}

	mkdirSync( dir, { recursive: true } );
	const files = JSON.parse( curl( `https://api.polyhaven.com/files/${id}` ).toString( 'utf8' ) );
	const g = files.gltf?.[ res ]?.gltf;
	if ( ! g ) {

		console.error( `[fail] ${id}: no gltf at ${res}; available: ${Object.keys( files.gltf || {} ).join( ',' )}` );
		continue;

	}

	const mainName = safeRel( g.url.split( '/' ).pop() );
	const list = [ [ mainName, g.url, g.size ] ];
	for ( const [ rel, v ] of Object.entries( g.include || {} ) ) list.push( [ safeRel( rel ), v.url, v.size ] );
	let total = 0;
	for ( const [ rel, url, size ] of list ) {

		if ( ! /^https:\/\/dl\.polyhaven\.org\//.test( url ) ) throw new Error( 'unexpected host: ' + url );
		const out = join( dir, rel );
		mkdirSync( dirname( out ), { recursive: true } );
		curl( url, out );
		const got = statSync( out ).size;
		if ( size && got !== size ) throw new Error( `${id}/${rel}: size mismatch ${got} != ${size}` );
		total += got;

	}

	writeFileSync( join( dir, '_source.json' ), JSON.stringify( { id, res, page: `https://polyhaven.com/a/${id}`, files: list.map( ( l ) => ( { path: l[ 0 ], url: l[ 1 ], bytes: l[ 2 ] } ) ) }, null, 1 ) );
	console.log( `[ok] ${id} ${res}: ${list.length} files, ${( total / 1e6 ).toFixed( 1 )} MB -> ${dir}` );

}
