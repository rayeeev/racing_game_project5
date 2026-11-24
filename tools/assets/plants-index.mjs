#!/usr/bin/env node
// Merge the per-asset build records (assets-src/plants/_build/*.json, written by the plants-build-* scripts)
// into public/assets/plants/index.json and validate every GLB against the project conventions.
//   node tools/assets/plants-index.mjs
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBounds } from '@gltf-transform/functions';
import { SRC, OUT, ROOT, getIO } from './plants-lib.mjs';

const ORDER = [ 'grass', 'flowers', 'fern', 'forest', 'shrub', 'debris' ];
const BUDGET = { grass: [ 150, 40 ], flowers: [ 220, 50 ], fern: [ 600, 120 ], forest: [ 600, 120 ], shrub: [ 2500, 500, 80 ], debris: [ 800, 150 ] };
const dir = join( SRC, '_build' );
const records = readdirSync( dir ).filter( ( f ) => f.endsWith( '.json' ) ).map( ( f ) => JSON.parse( readFileSync( join( dir, f ), 'utf8' ) ) );
records.sort( ( a, b ) => ORDER.indexOf( a.category ) - ORDER.indexOf( b.category ) || a.id.localeCompare( b.id ) );

const io = await getIO();
let problems = 0, total = 0;
const assets = [];
for ( const rec of records ) {

	const file = join( ROOT, 'public', rec.file );
	if ( ! existsSync( file ) ) {

		console.log( `[skip] ${rec.id}: ${file} missing` );
		continue;

	}

	rec.bytes = statSync( file ).size;
	total += rec.bytes;
	const doc = await io.read( file );
	const root = doc.getRoot();
	const nodes = new Map( root.listNodes().map( ( n ) => [ n.getName(), n ] ) );
	const scene = root.listScenes()[ 0 ];
	const bad = ( msg ) => {

		problems ++;
		console.log( `  [PROBLEM] ${rec.id}: ${msg}` );

	};

	const texSizes = root.listTextures().map( ( t ) => `${t.getName()}:${t.getSize()?.join( 'x' )}:${t.getMimeType()}` );
	for ( const t of root.listTextures() ) if ( Math.max( ...( t.getSize() || [ 0 ] ) ) > rec.textureResolution ) bad( `texture ${t.getName()} larger than ${rec.textureResolution}` );
	for ( const m of root.listMaterials() ) if ( m.getAlphaMode() === 'BLEND' ) bad( `material ${m.getName()} uses BLEND` );
	console.log( `${rec.id.padEnd( 26 )} ${( rec.bytes / 1024 ).toFixed( 0 ).padStart( 5 )} KB  ext=[${root.listExtensionsUsed().map( ( e ) => e.extensionName ).join( ',' )}]  mats=[${root.listMaterials().map( ( m ) => `${m.getName()}:${m.getAlphaMode()}${m.getAlphaMode() === 'MASK' ? '@' + m.getAlphaCutoff() : ''}${m.getDoubleSided() ? ':2s' : ''}` ).join( ', ' )}]  tex=[${texSizes.join( ', ' )}]` );
	for ( const v of rec.variants ) {

		v.lods.forEach( ( lod, li ) => {

			const node = nodes.get( lod.node );
			if ( ! node ) return bad( `node ${lod.node} missing` );
			if ( node.getParentNode() || ! scene.listChildren().includes( node ) ) bad( `${lod.node} is not a scene root child` );
			const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
			if ( t.some( ( x ) => x !== 0 ) || r[ 0 ] || r[ 1 ] || r[ 2 ] || r[ 3 ] !== 1 || s.some( ( x ) => x !== 1 ) ) bad( `${lod.node} has a non-identity transform` );
			let tris = 0;
			const mats = new Set();
			for ( const p of node.getMesh().listPrimitives() ) {

				tris += p.getIndices().getCount() / 3;
				if ( mats.has( p.getMaterial() ) ) bad( `${lod.node}: two primitives share a material` );
				mats.add( p.getMaterial() );
				for ( const sem of [ 'POSITION', 'NORMAL', 'TEXCOORD_0' ] ) if ( ! p.getAttribute( sem ) ) bad( `${lod.node}: no ${sem}` );

			}

			if ( tris !== lod.triangles ) bad( `${lod.node}: triangles ${tris} != recorded ${lod.triangles}` );
			const budget = BUDGET[ rec.category ]?.[ li ];
			if ( budget && tris > budget ) bad( `${lod.node}: ${tris} tris exceeds budget ${budget}` );
			const b = getBounds( node );
			if ( li === 0 ) {

				if ( Math.abs( b.min[ 1 ] ) > 0.002 ) bad( `${lod.node}: min y = ${b.min[ 1 ].toFixed( 4 )} (expected 0)` );
				const size = [ b.max[ 0 ] - b.min[ 0 ], b.max[ 1 ] - b.min[ 1 ], b.max[ 2 ] - b.min[ 2 ] ];
				if ( size.some( ( x, i ) => Math.abs( x - v.size[ i ] ) > 0.01 ) ) bad( `${lod.node}: size ${size.map( ( x ) => x.toFixed( 3 ) )} != recorded ${v.size}` );

			}

		} );
		console.log( `   ${v.name.padEnd( 24 )} size ${v.size.map( ( x ) => x.toFixed( 2 ) ).join( ' x ' )}  r=${v.radius}  tris ${v.lods.map( ( l ) => l.triangles ).join( ' / ' )}  avg ${v.avgColor} root ${v.colorRoot} tip ${v.colorTip}` );

	}

	assets.push( rec );

}

const index = { category: 'plants', generated: new Date().toISOString().slice( 0, 10 ), assets };
writeFileSync( join( OUT, 'index.json' ), JSON.stringify( index, null, 1 ) );
console.log( `wrote ${join( OUT, 'index.json' )}: ${assets.length} assets, ${assets.reduce( ( n, a ) => n + a.variants.length, 0 )} variants, ${( total / 1024 ).toFixed( 0 )} KB, problems: ${problems}` );
process.exit( problems ? 1 : 0 );
