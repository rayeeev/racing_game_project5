#!/usr/bin/env node
// Download a Poly Haven model (glTF set) into assets-src/rocks/<id>/ and optional extra maps into assets-src/rocks/<id>__maps/.
//   node tools/assets/rocks-fetch.mjs <id> <res: 1k|2k|4k> [--maps arm,AO] [--maps-res 4k] [--maps-suffix maps] [--maps-format jpg|png] [--skip-gltf 1]
// Every file is fetched with curl (generic UA, no project info), md5-verified against the API listing.
// Downloaded data is only ever read as data (never executed).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const [ id, res, ...rest ] = process.argv.slice( 2 );
if ( ! id || ! res || ! /^[a-z0-9_]+$/.test( id ) ) {

	console.error( 'usage: rocks-fetch.mjs <id> <res> [--maps arm,AO] [--maps-res 4k]' );
	process.exit( 2 );

}

const opt = {};
for ( let i = 0; i < rest.length; i += 2 ) opt[ rest[ i ].replace( /^--/, '' ) ] = rest[ i + 1 ];

const UA = 'asset-fetcher/1.0';
function curl( url, out ) {

	for ( let attempt = 1; attempt <= 4; attempt ++ ) {

		try {

			execFileSync( 'curl', [ '-sS', '-L', '-f', '-A', UA, '--retry', '3', '--retry-delay', '2', '-o', out, url ], { stdio: [ 'ignore', 'inherit', 'inherit' ] } );
			return;

		} catch ( e ) {

			console.log( `  attempt ${attempt} failed for ${url}` );
			if ( attempt === 4 ) throw e;

		}

	}

}

const md5 = ( file ) => createHash( 'md5' ).update( readFileSync( file ) ).digest( 'hex' );

function safeJoin( base, rel ) {

	const p = normalize( join( base, rel ) );
	if ( ! p.startsWith( base + sep ) ) throw new Error( 'unsafe relative path from API: ' + rel );
	return p;

}

function fetchVerified( url, out, expect ) {

	if ( ! /^https:\/\/dl\.polyhaven\.org\//.test( url ) ) throw new Error( 'unexpected download host: ' + url );
	if ( existsSync( out ) && expect.md5 && md5( out ) === expect.md5 ) {

		console.log( '  cached', out );
		return;

	}

	mkdirSync( dirname( out ), { recursive: true } );
	curl( url, out );
	const size = statSync( out ).size;
	if ( expect.size && size !== expect.size ) throw new Error( `size mismatch for ${out}: ${size} != ${expect.size}` );
	if ( expect.md5 && md5( out ) !== expect.md5 ) throw new Error( `md5 mismatch for ${out}` );
	console.log( '  ok', out, size );

}

// file listing (metadata only)
const tmpJson = join( ROOT, 'assets-src/rocks/_api', id + '.files.json' );
mkdirSync( dirname( tmpJson ), { recursive: true } );
if ( ! existsSync( tmpJson ) ) curl( 'https://api.polyhaven.com/files/' + id, tmpJson );
const listing = JSON.parse( readFileSync( tmpJson, 'utf8' ) );

let gltfName = null;
if ( ! opt[ 'skip-gltf' ] ) {

	const entry = listing.gltf?.[ res ]?.gltf;
	if ( ! entry ) throw new Error( `no gltf/${res} for ${id}` );
	const dir = join( ROOT, 'assets-src/rocks', id );
	mkdirSync( dir, { recursive: true } );
	gltfName = entry.url.split( '/' ).pop();
	if ( ! /^[A-Za-z0-9_.-]+\.gltf$/.test( gltfName ) ) throw new Error( 'unexpected gltf name ' + gltfName );
	fetchVerified( entry.url, join( dir, gltfName ), entry );
	for ( const [ rel, v ] of Object.entries( entry.include || {} ) ) fetchVerified( v.url, safeJoin( dir, rel ), v );

}

if ( opt.maps ) {

	const mres = opt[ 'maps-res' ] || res;
	const suffix = opt[ 'maps-suffix' ] || 'maps';
	if ( ! /^[a-z0-9_]+$/.test( suffix ) ) throw new Error( 'bad suffix' );
	const mdir = join( ROOT, 'assets-src/rocks', id + '__' + suffix );
	mkdirSync( mdir, { recursive: true } );
	for ( const m of opt.maps.split( ',' ) ) {

		const fmt = opt[ 'maps-format' ] === 'png' ? 'png' : 'jpg';
		const e = listing[ m ]?.[ mres ]?.[ fmt ];
		if ( ! e ) throw new Error( `no ${m}/${mres}/${fmt} for ${id}` );
		const name = e.url.split( '/' ).pop();
		if ( ! /^[A-Za-z0-9_.-]+\.(jpg|png)$/.test( name ) ) throw new Error( 'unexpected map name ' + name );
		fetchVerified( e.url, join( mdir, name ), e );

	}

}

if ( gltfName ) writeFileSync( join( ROOT, 'assets-src/rocks/_api', id + '.fetched.json' ), JSON.stringify( { id, res, gltf: gltfName, maps: opt.maps || null, when: new Date().toISOString() } ) );
console.log( 'done', id, res );
