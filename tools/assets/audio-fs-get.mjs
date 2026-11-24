#!/usr/bin/env node
// Download freesound.org sounds (the publicly served HQ OGG preview; originals need a login) and
// record the license that the sound page states at download time.
//
//   node tools/assets/audio-fs-get.mjs --dir <abs download dir> --meta <abs meta.json> <soundId> [<soundId> ...]
//        [--allow "cc0,by"]   licenses accepted (default: cc0,by). Anything else is refused.
//
// For every id it fetches https://freesound.org/s/<id>/ , parses title / author / license / description /
// file info, refuses non-whitelisted licenses, then downloads <id>_<user>-hq.ogg into --dir as
// fs<id>.ogg . The meta file (kept OUTSIDE the download dir) maps id -> metadata.
// Only a generic user agent and the sound ids are sent.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const argv = process.argv.slice( 2 );
const opts = { allow: 'cc0,by' };
const ids = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a.startsWith( '--' ) ) { opts[ a.slice( 2 ) ] = argv[ ++ i ]; } else ids.push( a );

}

if ( ! opts.dir || ! opts.meta || ids.length === 0 ) {

	console.error( 'usage: audio-fs-get.mjs --dir <dir> --meta <meta.json> <id>...' );
	process.exit( 2 );

}

const UA = 'asset-fetcher/1.0';
const allow = new Set( opts.allow.split( ',' ) );

export const LICENSES = {
	'http://creativecommons.org/publicdomain/zero/1.0/': { key: 'cc0', name: 'CC0 1.0' },
	'https://creativecommons.org/publicdomain/zero/1.0/': { key: 'cc0', name: 'CC0 1.0' },
	'http://creativecommons.org/licenses/by/3.0/': { key: 'by', name: 'CC BY 3.0' },
	'https://creativecommons.org/licenses/by/3.0/': { key: 'by', name: 'CC BY 3.0' },
	'http://creativecommons.org/licenses/by/4.0/': { key: 'by', name: 'CC BY 4.0' },
	'https://creativecommons.org/licenses/by/4.0/': { key: 'by', name: 'CC BY 4.0' },
};

const decode = ( s ) => s
	.replace( /&amp;/g, '&' ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
	.replace( /&quot;/g, '"' ).replace( /&#x27;/g, "'" ).replace( /&#39;/g, "'" ).replace( /&nbsp;/g, ' ' );
const strip = ( s ) => decode( s.replace( /<[^>]+>/g, ' ' ) ).replace( /\s+/g, ' ' ).trim();

async function fetchRetry( url, asBuffer ) {

	let lastErr;
	for ( let attempt = 0; attempt < 5; attempt ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA }, redirect: 'follow' } );
			if ( res.status === 200 ) return asBuffer ? Buffer.from( await res.arrayBuffer() ) : { text: await res.text(), url: res.url };
			lastErr = new Error( 'http ' + res.status + ' ' + url );
			if ( res.status === 404 ) break;

		} catch ( e ) { lastErr = e; }

		await new Promise( ( r ) => setTimeout( r, 1500 * ( attempt + 1 ) ) );

	}

	throw lastErr;

}

mkdirSync( opts.dir, { recursive: true } );
mkdirSync( dirname( opts.meta ), { recursive: true } );
const meta = existsSync( opts.meta ) ? JSON.parse( readFileSync( opts.meta, 'utf8' ) ) : {};

for ( const id of ids ) {

	const file = join( opts.dir, `fs${id}.ogg` );
	if ( meta[ id ] && existsSync( file ) && statSync( file ).size > 0 ) { console.log( `fs${id}: cached` ); continue; }

	const { text: html, url: pageUrl } = await fetchRetry( `https://freesound.org/s/${id}/` );
	const licHref = ( html.match( /title="Go to the full license text" href="([^"]+)"/ ) || [] )[ 1 ];
	const lic = LICENSES[ licHref ];
	const og = ( name ) => decode( ( html.match( new RegExp( `<meta property="og:${name}" content="([^"]*)"` ) ) || [] )[ 1 ] || '' );
	const title = og( 'audio:title' );
	const user = og( 'audio:artist' );
	if ( ! lic || ! allow.has( lic.key ) ) {

		console.log( `fs${id}: REFUSED license ${licHref} (${user} / ${title})` );
		continue;

	}

	const info = {};
	for ( const m of html.matchAll( /<p class="text-grey no-margins">([^<]+)<\/p>\s*<p class="no-margins">([^<]+)<\/p>/g ) ) info[ strip( m[ 1 ] ) ] = strip( m[ 2 ] );
	const pack = strip( ( html.match( /title="This sound is part of the pack '[^"]*">([\s\S]*?)<\/a>/ ) || [] )[ 1 ] || '' );
	const descM = html.match( /<div id="soundDescriptionSection"[^>]*>([\s\S]*?)<\/div>/ ) || html.match( /<meta name="twitter:description" content="([^"]*)"/ );
	const description = descM ? strip( descM[ 1 ] ) : '';
	const prev = ( html.match( /https:\/\/cdn\.freesound\.org\/previews\/\d+\/\d+_\d+-hq\.mp3/ ) || [] )[ 0 ];
	if ( ! prev ) { console.log( `fs${id}: no preview url found` ); continue; }
	const oggUrl = prev.replace( /-hq\.mp3$/, '-hq.ogg' );
	const buf = await fetchRetry( oggUrl, true );
	writeFileSync( file, buf );
	const date = ( html.match( /<span[^>]*class="[^"]*text-grey[^"]*"[^>]*>\s*([A-Z][a-z]+ \d+(?:st|nd|rd|th), \d{4})\s*</ ) || [] )[ 1 ] || '';
	meta[ id ] = {
		id: Number( id ),
		title,
		author: user,
		page: pageUrl,
		license: lic.name,
		licenseUrl: licHref,
		description,
		pack,
		uploaded: date,
		original: info,
		downloaded: oggUrl,
		downloadedNote: 'freesound HQ OGG preview (lossy transcode of the original upload, original sample rate); the original file needs a freesound login',
		file: `fs${id}.ogg`,
		bytes: buf.length,
	};
	writeFileSync( opts.meta, JSON.stringify( meta, null, 1 ) );
	console.log( `fs${id}: ${lic.name}  ${user} / ${title}  (${buf.length} bytes)  ${JSON.stringify( info )}` );

}
