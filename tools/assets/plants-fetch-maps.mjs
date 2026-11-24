#!/usr/bin/env node
// Download extra Poly Haven texture maps that are not referenced by the glTF (Alpha, Mask, opacity, dry_diff, translucency)
// into assets-src/plants/<id>__maps/ .
//   node tools/assets/plants-fetch-maps.mjs <res> <id>:<Key>[+<Key>...] [...]      e.g.  2k grass_medium_01:Alpha+dry_diff
// Format preference: png for Alpha/Mask/opacity (lossless), jpg for colour maps.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const [ res, ...specs ] = process.argv.slice( 2 );
const UA = 'asset-fetcher/1.0';

function curl( url, out ) {

	const args = [ '-sS', '-L', '-f', '-A', UA, '--retry', '4', '--retry-delay', '2', '--retry-all-errors', '--max-time', '900' ];
	if ( out ) args.push( '-o', out );
	args.push( url );
	return execFileSync( 'curl', args, { maxBuffer: 1 << 28 } );

}

for ( const spec of specs ) {

	const [ id, keysS ] = spec.split( ':' );
	if ( ! /^[a-z0-9_]+$/.test( id ) ) throw new Error( 'bad id ' + id );
	const keys = keysS.split( '+' );
	const dir = join( ROOT, 'assets-src/plants', id + '__maps' );
	mkdirSync( dir, { recursive: true } );
	const files = JSON.parse( curl( `https://api.polyhaven.com/files/${id}` ).toString( 'utf8' ) );
	const log = [];
	for ( const key of keys ) {

		const entry = files[ key ]?.[ res ];
		if ( ! entry ) {

			console.error( `[fail] ${id}: no ${key} at ${res}` );
			continue;

		}

		const lossless = /^(alpha|mask|opacity)$/i.test( key );
		const fmt = lossless ? ( entry.png ? 'png' : 'jpg' ) : ( entry.jpg ? 'jpg' : 'png' );
		const { url, size } = entry[ fmt ];
		if ( ! /^https:\/\/dl\.polyhaven\.org\//.test( url ) ) throw new Error( 'unexpected host: ' + url );
		const name = url.split( '/' ).pop();
		if ( ! /^[A-Za-z0-9_.-]+$/.test( name ) ) throw new Error( 'bad name ' + name );
		const out = join( dir, name );
		if ( existsSync( out ) && statSync( out ).size === size ) {

			console.log( `[skip] ${name}` );
			continue;

		}

		curl( url, out );
		if ( statSync( out ).size !== size ) throw new Error( 'size mismatch ' + name );
		log.push( { key, path: name, url, bytes: size } );
		console.log( `[ok] ${id} ${key} -> ${out} (${( size / 1e6 ).toFixed( 2 )} MB)` );

	}

	if ( log.length ) writeFileSync( join( dir, `_source_${Date.now()}.json` ), JSON.stringify( { id, res, page: `https://polyhaven.com/a/${id}`, files: log }, null, 1 ) );

}
