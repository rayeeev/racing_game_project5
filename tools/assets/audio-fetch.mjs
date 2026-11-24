#!/usr/bin/env node
// Download every audio source listed in audio-manifest.mjs into assets-src/audio/<source-id>/ and record the
// license that the source page states AT DOWNLOAD TIME in assets-src/audio/_meta/<source-id>.json.
//
//   node tools/assets/audio-fetch.mjs [--only <source-id>[,<source-id>...]] [--force]
//
// Source kinds:
//   freesound  the sound page is parsed (title, author, license link, description, original format); only CC0 / CC-BY
//              are accepted. The file fetched is freesound's public HQ OGG preview (a lossy transcode at the original
//              sample rate) because the original upload needs a login.
//   bsb        bigsoundbank.com: the sound page must state "CC0 (public domain)"; the lossless FLAC is fetched.
//   url        direct file URLs; `licensePage` is fetched and must match `licensePattern`.
//
// Downloaded files are untrusted data: nothing here executes them; they are only ever passed to ffmpeg as inputs.
// Requests carry a generic user agent and no project / user information.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './audio-manifest.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const SRC = join( ROOT, 'assets-src', 'audio' );
const UA = 'asset-fetcher/1.0';

const argv = process.argv.slice( 2 );
const only = argv.includes( '--only' ) ? new Set( argv[ argv.indexOf( '--only' ) + 1 ].split( ',' ) ) : null;
const force = argv.includes( '--force' );

const FS_LICENSES = {
	'creativecommons.org/publicdomain/zero/1.0/': { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
	'creativecommons.org/licenses/by/3.0/': { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
	'creativecommons.org/licenses/by/4.0/': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
};

const decode = ( s ) => s
	.replace( /&amp;/g, '&' ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
	.replace( /&quot;/g, '"' ).replace( /&#x27;/g, "'" ).replace( /&#0?39;/g, "'" ).replace( /&nbsp;/g, ' ' );
const strip = ( s ) => decode( s.replace( /<[^>]+>/g, ' ' ) ).replace( /\s+/g, ' ' ).trim();
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

async function fetchRetry( url, asBuffer ) {

	let lastErr;
	for ( let attempt = 0; attempt < 5; attempt ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA }, redirect: 'follow' } );
			if ( res.status === 200 ) return asBuffer ? Buffer.from( await res.arrayBuffer() ) : { text: await res.text(), url: res.url };
			lastErr = new Error( 'http ' + res.status + ' ' + url );
			if ( res.status === 404 ) break;

		} catch ( e ) { lastErr = e; }

		await sleep( 1500 * ( attempt + 1 ) );

	}

	throw lastErr;

}

async function fetchFreesound( id, dir ) {

	const { text: html, url: pageUrl } = await fetchRetry( `https://freesound.org/s/${id}/` );
	const licHref = ( html.match( /title="Go to the full license text" href="https?:\/\/([^"]+)"/ ) || [] )[ 1 ];
	const lic = FS_LICENSES[ licHref ];
	const og = ( name ) => decode( ( html.match( new RegExp( `<meta property="og:${name}" content="([^"]*)"` ) ) || [] )[ 1 ] || '' );
	const title = og( 'audio:title' ), author = og( 'audio:artist' );
	if ( ! lic ) throw new Error( `freesound ${id}: license not accepted (${licHref}) - ${author} / ${title}` );
	const original = {};
	for ( const m of html.matchAll( /<p class="text-grey no-margins">([^<]+)<\/p>\s*<p class="no-margins">([^<]+)<\/p>/g ) ) original[ strip( m[ 1 ] ) ] = strip( m[ 2 ] );
	const descM = html.match( /<div id="soundDescriptionSection"[^>]*>([\s\S]*?)<\/div>/ );
	const pack = strip( ( html.match( /title="This sound is part of the pack '[^"]*">([\s\S]*?)<\/a>/ ) || [] )[ 1 ] || '' );
	const prev = ( html.match( /https:\/\/cdn\.freesound\.org\/previews\/\d+\/\d+_\d+-hq\.mp3/ ) || [] )[ 0 ];
	if ( ! prev ) throw new Error( `freesound ${id}: preview url not found` );
	const fileUrl = prev.replace( /-hq\.mp3$/, '-hq.ogg' );
	const buf = await fetchRetry( fileUrl, true );
	const file = `fs${id}.ogg`;
	writeFileSync( join( dir, file ), buf );
	return {
		key: String( id ), file, bytes: buf.length, title, author, page: pageUrl.replace( /\?.*$/, '' ), license: lic.name, licenseUrl: lic.url,
		licenseEvidence: `sound page links "Go to the full license text" -> ${licHref}`,
		attribution: lic.name.startsWith( 'CC0' ) ? `"${title}" by ${author} (freesound.org/s/${id}), CC0 1.0 - no attribution required` : `"${title}" by ${author} (https://freesound.org/s/${id}/), licensed under ${lic.name} (${lic.url})`,
		description: descM ? strip( descM[ 1 ] ) : '', pack, original, downloaded: fileUrl,
		note: 'freesound HQ OGG preview (lossy transcode, original sample rate); the original upload needs a login',
	};

}

async function fetchBsb( id, dir ) {

	const { text: html, url: pageUrl } = await fetchRetry( `https://bigsoundbank.com/search?q=${id}` ).then( async ( r ) => {

		const m = r.text.match( new RegExp( `href='(/[a-z0-9-]+-s${id}\\.html)'` ) );
		if ( ! m ) throw new Error( `bigsoundbank ${id}: sound page not found` );
		return fetchRetry( 'https://bigsoundbank.com' + m[ 1 ] );

	} );
	if ( ! /CC0 \(public domain\): Free and royalty-free/.test( html ) ) throw new Error( `bigsoundbank ${id}: page does not state CC0` );
	const title = strip( ( html.match( /<h1[^>]*>([\s\S]*?)<\/h1>/ ) || [] )[ 1 ] || '' );
	const author = strip( ( html.match( /Author\s*:\s*(?:<[^>]+>\s*)*([^<]+)</ ) || [] )[ 1 ] || 'Joseph SARDIN' );
	const description = decode( ( html.match( /<meta name="description" content="([^"]*)"/ ) || html.match( /<meta name='description' content='([^']*)'/ ) || [] )[ 1 ] || '' );
	const tech = {};
	for ( const m of html.matchAll( /<li[^>]*>\s*(Length|Type|Channels|Conditions|Sampling Rate|Bit Depth|Author|Sound number|UCS Category)\s*:\s*([\s\S]*?)<\/li>/g ) ) tech[ m[ 1 ] ] = strip( m[ 2 ] );
	const fileUrl = `https://bigsoundbank.com/UPLOAD/flac/${id}.flac`;
	const buf = await fetchRetry( fileUrl, true );
	if ( buf.subarray( 0, 4 ).toString( 'ascii' ) !== 'fLaC' ) throw new Error( `bigsoundbank ${id}: not a FLAC file` );
	const file = `bsb${id}.flac`;
	writeFileSync( join( dir, file ), buf );
	return {
		key: String( id ), file, bytes: buf.length, title, author: tech.Author || author, page: pageUrl, license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
		licenseEvidence: 'sound page states "CC0 (public domain): Free and royalty-free"; https://bigsoundbank.com/licenses.html: "Creative Commons CC0 1.0 Universal ... Public Domain Dedication"',
		attribution: `"${title}" by Joseph SARDIN - BigSoundBank.com, CC0 1.0 - no attribution required (credit appreciated: "Additional sounds: Joseph SARDIN - BigSoundBank.com")`,
		description, original: tech, downloaded: fileUrl, note: 'lossless FLAC',
	};

}

async function fetchUrl( item, src, dir ) {

	const { text } = await fetchRetry( src.licensePage );
	const re = new RegExp( src.licensePattern );
	const m = text.match( re );
	if ( ! m ) throw new Error( `${src.licensePage}: license pattern not found (${src.licensePattern})` );
	const buf = await fetchRetry( item.url, true );
	writeFileSync( join( dir, item.file ), buf );
	return {
		key: item.file, file: item.file, bytes: buf.length, title: item.title || item.file, author: src.author, page: src.licensePage, license: src.license, licenseUrl: src.licenseUrl,
		licenseEvidence: `page matches /${src.licensePattern}/: "${strip( m[ 0 ] ).slice( 0, 200 )}"`,
		attribution: src.attribution, description: item.description || '', downloaded: item.url, note: src.note || '',
	};

}

mkdirSync( join( SRC, '_meta' ), { recursive: true } );
let failures = 0;
for ( const [ sid, src ] of Object.entries( SOURCES ) ) {

	if ( only && ! only.has( sid ) ) continue;
	const dir = join( SRC, sid );
	const metaFile = join( SRC, '_meta', sid + '.json' );
	const meta = existsSync( metaFile ) && ! force ? JSON.parse( readFileSync( metaFile, 'utf8' ) ) : { id: sid, kind: src.kind, note: src.note || '', fetched: new Date().toISOString().slice( 0, 10 ), files: {} };
	mkdirSync( dir, { recursive: true } );
	const items = src.kind === 'url' ? src.files : src.ids;
	for ( const item of items ) {

		const key = src.kind === 'url' ? item.file : String( item );
		const have = meta.files[ key ];
		if ( have && existsSync( join( dir, have.file ) ) && statSync( join( dir, have.file ) ).size === have.bytes ) continue;
		try {

			const rec = src.kind === 'freesound' ? await fetchFreesound( item, dir ) : src.kind === 'bsb' ? await fetchBsb( item, dir ) : await fetchUrl( item, src, dir );
			meta.files[ key ] = rec;
			writeFileSync( metaFile, JSON.stringify( meta, null, 1 ) );
			console.log( `${sid}/${rec.file}  ${rec.license}  ${rec.author} / ${rec.title}  (${rec.bytes} bytes)` );
			await sleep( 250 );

		} catch ( e ) {

			failures ++;
			console.log( `FAILED ${sid} ${key}: ${e.message}` );

		}

	}

}

console.log( failures ? `${failures} download(s) failed` : 'all sources present' );
process.exit( failures ? 1 : 0 );
