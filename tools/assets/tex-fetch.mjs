#!/usr/bin/env node
// Download Poly Haven texture maps (JPG) into assets-src/textures/<polyhavenId>/.
//
//   node tools/assets/tex-fetch.mjs --res 2k [--height-res 1k] [--maps diff,nor_gl,arm,disp] <polyhavenId> [<polyhavenId> ...]
//
// For every id the Poly Haven files API is queried (https://api.polyhaven.com/files/<id>), the JPG of each requested map
// is downloaded at --res (the displacement map additionally/only at --height-res) and verified against the md5 + size
// reported by the API. The API answers (files + info) are stored next to the images as _api_files.json / _api_info.json.
// Nothing downloaded is ever executed. No project/user information is sent (fixed generic User-Agent).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UA = 'asset-fetcher/1.0';
const ROOT = resolve( process.cwd(), 'assets-src/textures' );

const argv = process.argv.slice( 2 );
const opt = { res: '2k', 'height-res': '1k', maps: 'diff,nor_gl,arm,disp' };
const ids = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
	else ids.push( argv[ i ] );

}

if ( ids.length === 0 ) {

	console.error( 'usage: tex-fetch.mjs --res 2k [--height-res 1k] [--maps diff,nor_gl,arm,disp] <polyhavenId>...' );
	process.exit( 2 );

}

// our short map key -> key used by the Poly Haven files API
const API_KEY = { diff: 'Diffuse', nor_gl: 'nor_gl', arm: 'arm', disp: 'Displacement', rough: 'Rough', ao: 'AO' };

async function get( url, tries = 4 ) {

	let lastErr;
	for ( let t = 0; t < tries; t ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA } } );
			if ( ! res.ok ) throw new Error( `HTTP ${res.status} for ${url}` );
			return Buffer.from( await res.arrayBuffer() );

		} catch ( e ) {

			lastErr = e;
			await new Promise( ( r ) => setTimeout( r, 800 * ( t + 1 ) ) );

		}

	}

	throw lastErr;

}

const md5 = ( buf ) => createHash( 'md5' ).update( buf ).digest( 'hex' );
let failed = 0;

for ( const id of ids ) {

	if ( ! /^[a-z0-9_]+$/i.test( id ) ) {

		console.error( `skip invalid id "${id}"` );
		failed ++;
		continue;

	}

	const dir = join( ROOT, id );
	mkdirSync( dir, { recursive: true } );

	let files, info;
	try {

		files = JSON.parse( ( await get( `https://api.polyhaven.com/files/${id}` ) ).toString( 'utf8' ) );
		info = JSON.parse( ( await get( `https://api.polyhaven.com/info/${id}` ) ).toString( 'utf8' ) );

	} catch ( e ) {

		console.error( `${id}: API error ${e.message}` );
		failed ++;
		continue;

	}

	writeFileSync( join( dir, '_api_files.json' ), JSON.stringify( files, null, 1 ) );
	writeFileSync( join( dir, '_api_info.json' ), JSON.stringify( info, null, 1 ) );

	const jobs = [];
	for ( const map of opt.maps.split( ',' ) ) {

		const key = API_KEY[ map ] ?? map;
		const resList = map === 'disp' ? [ ...new Set( [ opt[ 'height-res' ] ] ) ] : [ opt.res ];
		for ( const res of resList ) {

			const entry = files?.[ key ]?.[ res ]?.jpg;
			if ( ! entry ) {

				console.error( `${id}: map "${key}" @${res} jpg not offered (available keys: ${Object.keys( files ).join( ', ' )})` );
				failed ++;
				continue;

			}

			jobs.push( { map, res, entry } );

		}

	}

	await Promise.all( jobs.map( async ( { map, res, entry } ) => {

		const name = entry.url.split( '/' ).pop();
		if ( ! /^[A-Za-z0-9_.-]+\.jpg$/.test( name ) ) throw new Error( `unexpected file name ${name}` );
		const out = join( dir, name );
		if ( existsSync( out ) && statSync( out ).size === entry.size && md5( readFileSync( out ) ) === entry.md5 ) {

			console.log( `${id}: ${name} ok (cached)` );
			return;

		}

		try {

			const buf = await get( entry.url );
			if ( buf.length !== entry.size || ( entry.md5 && md5( buf ) !== entry.md5 ) ) throw new Error( `size/md5 mismatch for ${name}` );
			if ( buf[ 0 ] !== 0xff || buf[ 1 ] !== 0xd8 ) throw new Error( `${name} is not a JPEG` );
			writeFileSync( out, buf );
			console.log( `${id}: ${name} ${( buf.length / 1024 ).toFixed( 0 )} kB (${map} @${res})` );

		} catch ( e ) {

			console.error( `${id}: ${e.message}` );
			failed ++;

		}

	} ) );

}

if ( failed ) {

	console.error( `${failed} problem(s)` );
	process.exit( 1 );

}
