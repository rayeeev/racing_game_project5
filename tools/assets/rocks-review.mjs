#!/usr/bin/env node
// Review screenshots of every rock variant with the generic viewer (dev/viewer.html, lod= and only= params):
// LOD0 and the last LOD, two camera angles each, HDRI + sun. Also builds one contact sheet per asset.
//   node tools/assets/rocks-review.mjs --out <dir> [--only id1,id2] [--jobs 6] [--hdr /assets-src/rocks/_hdri/...hdr]
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const args = {};
for ( let i = 2; i < process.argv.length; i += 2 ) args[ process.argv[ i ].replace( /^--/, '' ) ] = process.argv[ i + 1 ];
const OUT = resolve( args.out );
const JOBS = Number( args.jobs || 6 );
const HDR = args.hdr || '/assets-src/rocks/_hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr';
const BASE = args.base || 'http://127.0.0.1:5173';
mkdirSync( join( OUT, 'sheets' ), { recursive: true } );

const index = JSON.parse( readFileSync( join( ROOT, 'public/assets/rocks/index.json' ), 'utf8' ) );
const only = args.only ? args.only.split( ',' ) : null;

const run = ( cmd, argv ) => new Promise( ( res, rej ) => execFile( cmd, argv, { cwd: ROOT, maxBuffer: 1 << 24 }, ( err, stdout, stderr ) => ( err ? rej( new Error( stderr || stdout || String( err ) ) ) : res( stdout ) ) ) );

const tasks = [];
const sheets = [];
for ( const asset of index.assets ) {

	if ( only && ! only.includes( asset.id ) ) continue;
	const open = asset.doubleSided; // open shells are only shown from the front half space
	const cells = [];
	for ( const v of asset.variants ) {

		const lastLod = v.lods.length - 1;
		const views = open ? [ [ 28, 10 ], [ - 35, 14 ] ] : [ [ 35, 16 ], [ 215, 16 ] ];
		for ( const lod of [ 0, lastLod ] ) for ( const [ az, el ] of views ) {

			const file = join( OUT, `${v.name}_LOD${lod}_az${az}.png` );
			const url = `${BASE}/dev/viewer.html?models=${asset.file}&lod=${lod}&only=${v.name}_LOD&hdr=${HDR}&az=${az}&el=${el}&dist=${open ? 0.78 : 0.82}&exposure=0.7&groundColor=4f5a36`;
			tasks.push( { file, url, expect: v.lods[ lod ].triangles, name: `${v.name} LOD${lod} az${az}` } );
			cells.push( file );

		}

	}

	sheets.push( { id: asset.id, cells } );

}

let done = 0, failed = 0;
const queue = [ ...tasks ];
async function worker() {

	while ( queue.length ) {

		const t = queue.shift();
		try {

			const out = await run( 'node', [ 'tools/shot.mjs', '--url', t.url, '--out', t.file, '--wait-for', 'window.__ready === true', '--delay', '400', '--width', '1100', '--height', '760', '--eval', 'JSON.stringify(window.__info.models.map(m => m.triangles))' ] );
			const last = JSON.parse( out.trim().split( '\n' ).pop() );
			const m = /eval result: "\[(\d+)\]"/.exec( out );
			const tris = m ? Number( m[ 1 ] ) : - 1;
			if ( ! last.ok || last.errors.length || tris !== t.expect ) { failed ++; console.log( `!! ${t.name}: ok=${last.ok} errors=${JSON.stringify( last.errors ).slice( 0, 300 )} triangles shown ${tris} expected ${t.expect}` ); }

		} catch ( e ) {

			failed ++;
			console.log( `!! ${t.name}: ${String( e.message ).slice( 0, 400 )}` );

		}

		done ++;
		if ( done % 20 === 0 ) console.log( `  ${done}/${tasks.length}` );

	}

}

console.log( `${tasks.length} screenshots -> ${OUT}` );
await Promise.all( Array.from( { length: JOBS }, worker ) );
console.log( `done: ${done} shots, ${failed} problems` );

for ( const s of sheets ) {

	// rows of 4: LOD0 a, LOD0 b, LODn a, LODn b  (one row per variant)
	for ( let k = 0; k < s.cells.length; k += 16 ) {

		const part = s.cells.slice( k, k + 16 );
		const out = join( OUT, 'sheets', `${s.id}${s.cells.length > 16 ? '_' + ( k / 16 + 1 ) : ''}.png` );
		await run( 'node', [ 'tools/assets/rocks-contact.mjs', out, '4', '550', '380', ...part ] );
		console.log( 'sheet', out );

	}

}
