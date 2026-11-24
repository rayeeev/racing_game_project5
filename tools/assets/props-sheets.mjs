#!/usr/bin/env node
// Review sheets: one PNG per asset with every variant as a row: [LOD0 view A | LOD0 view B | LOD1 view A | LOD1 view B].
//   node tools/assets/props-sheets.mjs --out <dir> [--only id1,id2] [--cell 800x600] [--extra "&side=front"] [--hdr <url>|none]
// Needs the dev server (http://127.0.0.1:5173) and uses tools/shot.mjs + tools/assets/props-scenario.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { out: '', only: '', cell: '800x600', extra: '', hdr: '/assets-src/props/_hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr', a: '32:14', b: '212:28', dist: '1.0', index: 'public/assets/props/index.json' };
for ( let i = 0; i < argv.length; i ++ ) if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
if ( ! opt.out ) { console.error( 'usage: props-sheets.mjs --out <dir> [--only ids]' ); process.exit( 2 ); }
const out = resolve( opt.out );
mkdirSync( join( out, 'cells' ), { recursive: true } );
const index = JSON.parse( readFileSync( opt.index, 'utf8' ) );
const only = opt.only ? new Set( opt.only.split( ',' ) ) : null;
const [ cw, ch ] = opt.cell.split( 'x' ).map( Number );
const [ azA, elA ] = opt.a.split( ':' ), [ azB, elB ] = opt.b.split( ':' );

for ( const asset of index.assets ) {

	if ( only && ! only.has( asset.id ) ) continue;
	// lod=both lays the items out as v0L0, v0L1, v1L0, v1L1 ...
	const views = [], files = [];
	asset.variants.forEach( ( v, vi ) => {

		for ( const [ lod, tag, az, el ] of [ [ 0, 'a', azA, elA ], [ 0, 'b', azB, elB ], [ 1, 'a', azA, elA ], [ 1, 'b', azB, elB ] ] ) {

			const name = `${asset.id}__${v.name}_LOD${lod}_${tag}`;
			views.push( `cells/${name}:${az}:${el}:${opt.dist}:${vi * 2 + lod}` );
			files.push( join( out, 'cells', name + '.png' ) );

		}

	} );
	const url = `http://127.0.0.1:5173/dev/preview-props.html?assets=${asset.id}&lod=both${opt.hdr !== 'none' ? '&hdr=' + opt.hdr : ''}&envI=0.9&sunI=3.2${opt.extra}`;
	const res = execFileSync( 'node', [ 'tools/shot.mjs', '--url', url, '--wait-for', 'window.__ready === true', '--script', 'tools/assets/props-scenario.mjs', '--out-dir', out, '--views', views.join( ';' ), '--width', String( cw ), '--height', String( ch ), '--info', '1' ], { encoding: 'utf8' } );
	const last = res.trim().split( '\n' ).pop();
	const summary = JSON.parse( last );
	const infoLine = res.split( '\n' ).find( ( l ) => l.includes( '[shot] info' ) ) || '';
	execFileSync( 'node', [ 'tools/assets/props-contact.mjs', '--out', join( out, asset.id + '.png' ), '--cols', '4', '--cell', `${cw}x${ch}`, ...files ] );
	console.log( `${asset.id}: ${files.length} cells, errors ${JSON.stringify( summary.errors )} ${infoLine.includes( '"errors":[]' ) ? '' : infoLine.slice( 0, 300 )}` );

}
