#!/usr/bin/env node
// Search freesound.org (server-rendered HTML, no login / API key) and print compact results.
//
//   node tools/assets/audio-fs-search.mjs "<query>" [--lic cc0|by|any] [--pages 2] [--sort downloads|rating|duration|relevance]
//                                         [--min 1] [--max 60] [--json out.json] [--pack <packUrl>] [--user <name>]
//
// Output line:  <id>  <dur>s  <sr>  [<license>]  <user> / <title>   {pack}  dl=<downloads>  :: <description>
// Nothing personal is sent: only the query string and a generic user agent.

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice( 2 );
const opts = { lic: 'cc0', pages: 1, sort: 'relevance' };
const positional = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a.startsWith( '--' ) ) { opts[ a.slice( 2 ) ] = argv[ ++ i ]; } else positional.push( a );

}

const query = positional.join( ' ' );
const UA = 'asset-fetcher/1.0';
const SORT = {
	relevance: 'Automatic by relevance',
	downloads: 'Downloads (most first)',
	rating: 'Rating (highest first)',
	duration: 'Duration (longest first)',
	short: 'Duration (shortest first)',
	newest: 'Date added (newest first)',
};

const decode = ( s ) => s
	.replace( /&amp;/g, '&' ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
	.replace( /&quot;/g, '"' ).replace( /&#x27;/g, "'" ).replace( /&#39;/g, "'" );
const strip = ( s ) => decode( s.replace( /<[^>]+>/g, ' ' ) ).replace( /\s+/g, ' ' ).trim();

async function get( url ) {

	for ( let attempt = 0; attempt < 4; attempt ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA } } );
			if ( res.status === 200 ) return await res.text();
			if ( res.status === 404 ) return '';
			await new Promise( ( r ) => setTimeout( r, 1500 * ( attempt + 1 ) ) );

		} catch ( e ) {

			await new Promise( ( r ) => setTimeout( r, 1500 * ( attempt + 1 ) ) );

		}

	}

	throw new Error( 'fetch failed: ' + url );

}

function parse( html ) {

	const out = [];
	const parts = html.split( /<div class="bw-search__result"|<div class="col-6 col-md-4|<div class="bw-pack__sound/ );
	for ( const part of html.split( 'class="bw-player"' ).slice( 1 ) ) {

		const attr = ( name ) => {

			const m = part.match( new RegExp( 'data-' + name + '="([^"]*)"' ) );
			return m ? decode( m[ 1 ] ) : '';

		};

		const id = attr( 'sound-id' );
		if ( ! id ) continue;
		const lic = ( part.match( /title="License: ([^"]+)"/ ) || [] )[ 1 ] || '?';
		const pack = ( part.match( /title="Pack: ([^"]+)"/ ) || [] )[ 1 ] || '';
		const desc = ( part.match( /<div class="max-h-60px[^>]*>([\s\S]*?)<\/div>/ ) || [] )[ 1 ] || '';
		out.push( {
			id: Number( id ),
			user: attr( 'username' ),
			title: attr( 'title' ),
			duration: Number( attr( 'duration' ) ),
			samplerate: Number( attr( 'samplerate' ) ),
			downloads: Number( attr( 'num-downloads' ) ),
			license: decode( lic ),
			pack: decode( pack ),
			mp3: attr( 'mp3' ),
			ogg: attr( 'ogg' ),
			description: strip( desc ),
			url: `https://freesound.org/people/${attr( 'username' )}/sounds/${id}/`,
		} );

	}

	void parts;
	return out;

}

const all = [];
const pages = Number( opts.pages );
for ( let page = 1; page <= pages; page ++ ) {

	let url;
	if ( opts.pack ) {

		url = opts.pack.replace( /\/$/, '' ) + '/' + ( page > 1 ? `?page=${page}` : '' );
		// pack pages list sounds through the search engine: use the pack filter instead
		const m = opts.pack.match( /packs\/(\d+)/ );
		const params = new URLSearchParams();
		params.set( 'q', query );
		params.set( 'f', `grouping_pack:"${m[ 1 ]}_${opts.packname || ''}"` );
		void params;

	}

	const params = new URLSearchParams();
	params.set( 'q', query );
	const filters = [];
	if ( opts.lic === 'cc0' ) filters.push( 'license:"Creative Commons 0"' );
	else if ( opts.lic === 'by' ) filters.push( 'license:"Attribution"' );
	if ( opts.user ) filters.push( `username:"${opts.user}"` );
	if ( opts.packf ) filters.push( `grouping_pack:"${opts.packf}"` );
	if ( opts.min || opts.max ) filters.push( `duration:[${opts.min || 0} TO ${opts.max || '*'}]` );
	if ( filters.length ) params.set( 'f', filters.join( ' ' ) );
	params.set( 's', SORT[ opts.sort ] || SORT.relevance );
	params.set( 'g', opts.group ? '1' : '0' );
	if ( page > 1 ) params.set( 'page', String( page ) );
	if ( ! opts.pack ) url = 'https://freesound.org/search/?' + params.toString();
	const html = await get( url );
	const total = ( html.match( /([\d,]+)\s+sounds?\s*<\/div>|(\d[\d,]*)\s+sounds\b/ ) || [] )[ 0 ];
	if ( page === 1 ) console.log( `# ${url}\n# total: ${total ? strip( total ) : '?'}` );
	const res = parse( html );
	if ( res.length === 0 ) break;
	all.push( ...res );

}

for ( const r of all ) {

	console.log( `${String( r.id ).padStart( 7 )}  ${r.duration.toFixed( 1 ).padStart( 6 )}s  ${String( r.samplerate / 1000 ).padStart( 4 )}k  [${r.license.replace( 'Creative Commons 0', 'CC0' ).replace( 'Attribution NonCommercial', 'BY-NC' ).replace( 'Attribution', 'BY' )}]  ${r.user} / ${r.title}  ${r.pack ? '{' + r.pack + '}' : ''}  dl=${r.downloads}  :: ${r.description.slice( 0, Number( opts.desc || 170 ) )}` );

}

if ( opts.json ) writeFileSync( opts.json, JSON.stringify( all, null, 1 ) );
