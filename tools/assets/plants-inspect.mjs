#!/usr/bin/env node
// Inspect a glTF/GLB: nodes (world bounds, triangles), meshes, primitives, materials, textures.
//   node tools/assets/plants-inspect.mjs <file.gltf|glb> [--islands]   (--islands: count connected components per node)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const file = process.argv[ 2 ];
const wantIslands = process.argv.includes( '--islands' );
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );
const doc = await io.read( file );
const root = doc.getRoot();
const f = ( a ) => '[' + [ ...a ].map( ( v ) => v.toFixed( 3 ) ).join( ', ' ) + ']';

console.log( 'extensionsUsed:', root.listExtensionsUsed().map( ( e ) => e.extensionName ).join( ', ' ) || '-' );
console.log( 'scenes:', root.listScenes().length, 'nodes:', root.listNodes().length, 'meshes:', root.listMeshes().length, 'materials:', root.listMaterials().length, 'textures:', root.listTextures().length );

for ( const t of root.listTextures() ) {

	const s = t.getSize();
	console.log( `  tex "${t.getName()}" uri=${t.getURI()} ${t.getMimeType()} ${s ? s.join( 'x' ) : '?'} ${( t.getImage()?.byteLength / 1024 ).toFixed( 0 )} KB` );

}

for ( const m of root.listMaterials() ) {

	console.log( `  mat "${m.getName()}" alphaMode=${m.getAlphaMode()} cutoff=${m.getAlphaCutoff()} doubleSided=${m.getDoubleSided()} base=${f( m.getBaseColorFactor() )} rough=${m.getRoughnessFactor()} metal=${m.getMetallicFactor()}`
		+ ` baseTex=${m.getBaseColorTexture()?.getURI() ?? '-'} nrm=${m.getNormalTexture()?.getURI() ?? '-'} orm=${m.getMetallicRoughnessTexture()?.getURI() ?? '-'} occ=${m.getOcclusionTexture()?.getURI() ?? '-'}`
		+ ` ext=${m.listExtensions().map( ( e ) => e.extensionName ).join( ',' ) || '-'}` );

}

function islands( prim ) {

	const pos = prim.getAttribute( 'POSITION' );
	const idx = prim.getIndices();
	const n = pos.getCount();
	// weld by position first (cards often have split vertices)
	const key = new Map();
	const remap = new Uint32Array( n );
	const p = [ 0, 0, 0 ];
	for ( let i = 0; i < n; i ++ ) {

		pos.getElement( i, p );
		const k = `${Math.round( p[ 0 ] * 1e5 )},${Math.round( p[ 1 ] * 1e5 )},${Math.round( p[ 2 ] * 1e5 )}`;
		let j = key.get( k );
		if ( j === undefined ) {

			j = i;
			key.set( k, j );

		}

		remap[ i ] = j;

	}

	const parent = new Uint32Array( n );
	for ( let i = 0; i < n; i ++ ) parent[ i ] = i;
	const find = ( a ) => {

		while ( parent[ a ] !== a ) {

			parent[ a ] = parent[ parent[ a ] ];
			a = parent[ a ];

		}

		return a;

	};
	const tri = idx ? idx.getCount() / 3 : n / 3;
	for ( let t = 0; t < tri; t ++ ) {

		const a = remap[ idx ? idx.getScalar( t * 3 ) : t * 3 ], b = remap[ idx ? idx.getScalar( t * 3 + 1 ) : t * 3 + 1 ], c = remap[ idx ? idx.getScalar( t * 3 + 2 ) : t * 3 + 2 ];
		const ra = find( a ), rb = find( b ), rc = find( c );
		parent[ rb ] = ra;
		parent[ find( rc ) ] = ra;

	}

	const counts = new Map();
	for ( let t = 0; t < tri; t ++ ) {

		const r = find( remap[ idx ? idx.getScalar( t * 3 ) : t * 3 ] );
		counts.set( r, ( counts.get( r ) || 0 ) + 1 );

	}

	const sizes = [ ...counts.values() ].sort( ( a, b ) => b - a );
	return { count: sizes.length, largest: sizes.slice( 0, 5 ), median: sizes[ sizes.length >> 1 ] };

}

let total = 0;
function walk( node, depth ) {

	const mesh = node.getMesh();
	let line = `${'  '.repeat( depth )}node "${node.getName()}" T=${f( node.getTranslation() )} R=${f( node.getRotation() )} S=${f( node.getScale() )}`;
	if ( mesh ) {

		const b = getBounds( node );
		let tris = 0;
		const prims = [];
		for ( const prim of mesh.listPrimitives() ) {

			const idx = prim.getIndices();
			const pos = prim.getAttribute( 'POSITION' );
			const t = idx ? idx.getCount() / 3 : pos.getCount() / 3;
			tris += t;
			let s = `{mat="${prim.getMaterial()?.getName()}" tris=${t} verts=${pos.getCount()} attrs=${prim.listSemantics().join( '/' )}`;
			if ( wantIslands ) {

				const is = islands( prim );
				s += ` islands=${is.count} largest=${is.largest.join( '/' )} median=${is.median}`;

			}

			prims.push( s + '}' );

		}

		total += tris;
		const size = [ b.max[ 0 ] - b.min[ 0 ], b.max[ 1 ] - b.min[ 1 ], b.max[ 2 ] - b.min[ 2 ] ];
		line += ` mesh="${mesh.getName()}" tris=${tris} worldMin=${f( b.min )} worldMax=${f( b.max )} size=${f( size )} ${prims.join( ' ' )}`;

	}

	console.log( line );
	for ( const c of node.listChildren() ) walk( c, depth + 1 );

}

for ( const scene of root.listScenes() ) {

	console.log( `scene "${scene.getName()}"` );
	for ( const n of scene.listChildren() ) walk( n, 1 );

}

console.log( 'total triangles:', total );
