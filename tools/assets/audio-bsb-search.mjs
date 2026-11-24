#!/usr/bin/env node
// Search bigsoundbank.com (CC0 library by Joseph Sardin) and print compact results.
//
//   node tools/assets/audio-bsb-search.mjs "<query>" [--cat VEHSkid] [--pages 3]
//
// Output line:  <id>  <length>  <UCS category>  <title> :: <description>   <page url>
// Lossless files are directly reachable at https://bigsoundbank.com/UPLOAD/flac/<id>.flac (and /UPLOAD/bwf/<id>.wav).

const argv = process.argv.slice( 2 );
const opts = { pages: 1 };
const positional = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a.startsWith( '--' ) ) { opts[ a.slice( 2 ) ] = argv[ ++ i ]; } else positional.push( a );

}

const query = positional.join( ' ' );
const UA = 'asset-fetcher/1.0';

const decode = ( s ) => s
	.replace( /&nbsp;/g, ' ' ).replace( /&amp;/g, '&' ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
	.replace( /&quot;/g, '"' ).replace( /&#0?39;/g, "'" ).replace( /&#x27;/g, "'" );
const strip = ( s ) => decode( s.replace( /<svg[\s\S]*?<\/svg>/g, ' ' ).replace( /<[^>]+>/g, ' ' ) ).replace( /\s+/g, ' ' ).trim();

async function get( url ) {

	for ( let attempt = 0; attempt < 4; attempt ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA } } );
			if ( res.status === 200 ) return await res.text();

		} catch ( e ) { /* retry */ }

		await new Promise( ( r ) => setTimeout( r, 1500 * ( attempt + 1 ) ) );

	}

	throw new Error( 'fetch failed: ' + url );

}

const seen = new Set();
for ( let page = 1; page <= Number( opts.pages ); page ++ ) {

	const params = new URLSearchParams();
	if ( query ) params.set( 'q', query );
	if ( opts.cat ) params.set( 'CatID', opts.cat );
	if ( page > 1 ) params.set( 'page', String( page ) );
	const url = 'https://bigsoundbank.com/search?' + params.toString();
	const html = await get( url );
	if ( page === 1 ) console.log( '# ' + url );
	const blocks = html.split( /<div class='resultat_\d+'>/ ).slice( 1 );
	let added = 0;
	for ( const b of blocks ) {

		const m = b.match( /<a href='(\/[^']+-s(\d{4})\.html)'>([\s\S]*?)<\/a>/ );
		if ( ! m || seen.has( m[ 2 ] ) ) continue;
		seen.add( m[ 2 ] );
		added ++;
		const title = strip( m[ 3 ] );
		const d = b.match( /<\/div><\/div><div>([\s\S]*?)<\/div>/ );
		const desc = d ? strip( d[ 1 ] ) : '';
		const cat = ( b.match( /CatID=([A-Za-z]+)/ ) || [] )[ 1 ] || '';
		const len = ( desc.match( /Length: ([\d:]+)/ ) || [] )[ 1 ] || '';
		console.log( `${m[ 2 ]}  ${len.padStart( 6 )}  ${cat.padEnd( 10 )}  ${title} :: ${desc.replace( /UCS Category : .*$/, '' ).replace( /UCS Category.*$/, '' ).slice( 0, Number( opts.desc || 150 ) )}   https://bigsoundbank.com${m[ 1 ]}` );

	}

	if ( added === 0 ) break;

}
