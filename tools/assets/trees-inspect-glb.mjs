#!/usr/bin/env node
// Print per-node / per-primitive statistics of a built tree GLB (triangles, bounds, uv / colour / normal ranges).
//   node tools/assets/trees-inspect-glb.mjs <file.glb> [nodeNameSubstring]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder } );
const [ file, filter ] = process.argv.slice( 2 );
const doc = await io.read( file );
const root = doc.getRoot();
console.log( 'extensions:', root.listExtensionsUsed().map( ( e ) => e.extensionName ).join( ', ' ) );
for ( const t of root.listTextures() ) console.log( `texture ${t.getName()} ${t.getMimeType()} ${t.getSize()?.join( 'x' )} ${( t.getImage().byteLength / 1024 ).toFixed( 0 )} KB` );
for ( const m of root.listMaterials() ) console.log( `material ${m.getName()} alphaMode=${m.getAlphaMode()} cutoff=${m.getAlphaCutoff()} doubleSided=${m.getDoubleSided()} metal=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()} baseColorFactor=${m.getBaseColorFactor()}` );
for ( const node of root.listNodes() ) {

	if ( filter && ! node.getName().includes( filter ) ) continue;
	const mesh = node.getMesh();
	if ( ! mesh ) continue;
	const tr = node.getTranslation(), sc = node.getScale(), ro = node.getRotation();
	const identity = tr.every( ( x ) => x === 0 ) && sc.every( ( x ) => x === 1 ) && ro[ 3 ] === 1;
	let line = `${node.getName()} identity=${identity}`;
	for ( const prim of mesh.listPrimitives() ) {

		const pos = prim.getAttribute( 'POSITION' ), nor = prim.getAttribute( 'NORMAL' ), uv = prim.getAttribute( 'TEXCOORD_0' ), col = prim.getAttribute( 'COLOR_0' );
		const tris = prim.getIndices().getCount() / 3;
		let nmin = Infinity, nmax = 0, nan = 0;
		const el = [];
		for ( let i = 0; i < nor.getCount(); i ++ ) {

			nor.getElement( i, el );
			const l = Math.hypot( el[ 0 ], el[ 1 ], el[ 2 ] );
			if ( ! Number.isFinite( l ) ) nan ++;
			nmin = Math.min( nmin, l );
			nmax = Math.max( nmax, l );

		}

		let cmin = [ 1, 1, 1 ], cmean = [ 0, 0, 0 ];
		if ( col ) for ( let i = 0; i < col.getCount(); i ++ ) {

			col.getElement( i, el );
			for ( let k = 0; k < 3; k ++ ) {

				cmin[ k ] = Math.min( cmin[ k ], el[ k ] );
				cmean[ k ] += el[ k ] / col.getCount();

			}

		}

		line += `\n   ${prim.getMaterial().getName()}: tris=${tris} verts=${pos.getCount()} pos=[${pos.getMin( [] ).map( ( x ) => x.toFixed( 2 ) )}]..[${pos.getMax( [] ).map( ( x ) => x.toFixed( 2 ) )}] (${pos.getComponentType() === 5126 ? 'f32' : 'int'}) uv=[${uv.getMinNormalized( [] ).map( ( x ) => x.toFixed( 3 ) )}]..[${uv.getMaxNormalized( [] ).map( ( x ) => x.toFixed( 3 ) )}] normalLen=${nmin.toFixed( 2 )}..${nmax.toFixed( 2 )} nan=${nan} colMin=[${cmin.map( ( x ) => x.toFixed( 2 ) )}] colMean=[${cmean.map( ( x ) => x.toFixed( 2 ) )}]`;

	}

	console.log( line );

}
