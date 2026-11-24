#!/usr/bin/env node
// Dump the structure of a car GLB: node tree, meshes, materials, world-space bounding boxes, triangle counts.
// usage: node tools/assets/car-inspect.mjs <file.glb> [--json out.json] [--quiet]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { writeFileSync } from 'node:fs';

const file = process.argv[ 2 ];
const jsonOut = process.argv.includes( '--json' ) ? process.argv[ process.argv.indexOf( '--json' ) + 1 ] : null;
const quiet = process.argv.includes( '--quiet' );

export async function makeIO() {

	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	return new NodeIO()
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( {
			'draco3d.decoder': await draco3d.createDecoderModule(),
			'draco3d.encoder': await draco3d.createEncoderModule(),
			'meshopt.decoder': MeshoptDecoder,
			'meshopt.encoder': MeshoptEncoder,
		} );

}

function mul( a, b ) {

	const o = new Array( 16 );
	for ( let c = 0; c < 4; c ++ ) for ( let r = 0; r < 4; r ++ ) {

		let s = 0;
		for ( let k = 0; k < 4; k ++ ) s += a[ k * 4 + r ] * b[ c * 4 + k ];
		o[ c * 4 + r ] = s;

	}

	return o;

}

const r3 = ( v ) => v.map( ( x ) => Math.round( x * 10000 ) / 10000 );

if ( file ) {

	const io = await makeIO();
	const doc = await io.read( file );
	const root = doc.getRoot();
	const out = { file, extensionsUsed: root.listExtensionsUsed().map( ( e ) => e.extensionName ), nodes: [], materials: [], textures: [] };

	for ( const m of root.listMaterials() ) {

		const ext = m.listExtensions().map( ( e ) => e.extensionName );
		out.materials.push( {
			name: m.getName(), baseColor: r3( m.getBaseColorFactor() ), metallic: m.getMetallicFactor(), roughness: m.getRoughnessFactor(),
			emissive: r3( m.getEmissiveFactor() ), alphaMode: m.getAlphaMode(), doubleSided: m.getDoubleSided(),
			baseColorTexture: m.getBaseColorTexture()?.getName() || m.getBaseColorTexture()?.getURI() || ( m.getBaseColorTexture() ? '(tex)' : null ),
			normalTexture: m.getNormalTexture() ? '(tex)' : null, extensions: ext,
		} );

	}

	for ( const t of root.listTextures() ) out.textures.push( { name: t.getName(), mime: t.getMimeType(), size: t.getSize(), bytes: t.getImage()?.byteLength } );

	let totalTris = 0;
	const total = { min: [ Infinity, Infinity, Infinity ], max: [ - Infinity, - Infinity, - Infinity ] };

	function visit( node, parentWorld, depth, path ) {

		const world = mul( parentWorld, node.getMatrix() );
		const mesh = node.getMesh();
		const entry = {
			depth, name: node.getName(), path: path + '/' + node.getName(),
			t: r3( node.getTranslation() ), r: r3( node.getRotation() ), s: r3( node.getScale() ),
			worldPos: r3( [ world[ 12 ], world[ 13 ], world[ 14 ] ] ),
		};
		if ( mesh ) {

			entry.mesh = mesh.getName();
			entry.prims = [];
			const bb = { min: [ Infinity, Infinity, Infinity ], max: [ - Infinity, - Infinity, - Infinity ] };
			for ( const p of mesh.listPrimitives() ) {

				const pos = p.getAttribute( 'POSITION' );
				const idx = p.getIndices();
				const tris = ( idx ? idx.getCount() : pos.getCount() ) / 3;
				totalTris += tris;
				const v = [ 0, 0, 0 ];
				const lb = { min: [ Infinity, Infinity, Infinity ], max: [ - Infinity, - Infinity, - Infinity ] };
				for ( let i = 0; i < pos.getCount(); i ++ ) {

					pos.getElement( i, v );
					for ( let k = 0; k < 3; k ++ ) { lb.min[ k ] = Math.min( lb.min[ k ], v[ k ] ); lb.max[ k ] = Math.max( lb.max[ k ], v[ k ] ); }
					const x = world[ 0 ] * v[ 0 ] + world[ 4 ] * v[ 1 ] + world[ 8 ] * v[ 2 ] + world[ 12 ];
					const y = world[ 1 ] * v[ 0 ] + world[ 5 ] * v[ 1 ] + world[ 9 ] * v[ 2 ] + world[ 13 ];
					const z = world[ 2 ] * v[ 0 ] + world[ 6 ] * v[ 1 ] + world[ 10 ] * v[ 2 ] + world[ 14 ];
					const w = [ x, y, z ];
					for ( let k = 0; k < 3; k ++ ) {

						bb.min[ k ] = Math.min( bb.min[ k ], w[ k ] ); bb.max[ k ] = Math.max( bb.max[ k ], w[ k ] );
						total.min[ k ] = Math.min( total.min[ k ], w[ k ] ); total.max[ k ] = Math.max( total.max[ k ], w[ k ] );

					}

				}

				entry.prims.push( {
					material: p.getMaterial()?.getName(), tris, verts: pos.getCount(), mode: p.getMode(),
					attrs: p.listSemantics(), localMin: r3( lb.min ), localMax: r3( lb.max ),
				} );

			}

			entry.worldMin = r3( bb.min ); entry.worldMax = r3( bb.max );
			entry.worldSize = r3( bb.max.map( ( x, k ) => x - bb.min[ k ] ) );
			entry.worldCenter = r3( bb.max.map( ( x, k ) => ( x + bb.min[ k ] ) / 2 ) );

		}

		out.nodes.push( entry );
		for ( const c of node.listChildren() ) visit( c, world, depth + 1, entry.path );

	}

	const I = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
	for ( const scene of root.listScenes() ) for ( const n of scene.listChildren() ) visit( n, I, 0, '' );
	out.totalTriangles = totalTris;
	out.bbox = { min: r3( total.min ), max: r3( total.max ), size: r3( total.max.map( ( x, k ) => x - total.min[ k ] ) ) };
	out.counts = { nodes: out.nodes.length, meshes: root.listMeshes().length, materials: out.materials.length, textures: out.textures.length, drawCalls: out.nodes.reduce( ( a, n ) => a + ( n.prims ? n.prims.length : 0 ), 0 ) };

	if ( jsonOut ) writeFileSync( jsonOut, JSON.stringify( out, null, 1 ) );
	if ( ! quiet ) {

		console.log( 'extensions:', out.extensionsUsed.join( ', ' ) );
		for ( const n of out.nodes ) {

			const pad = '  '.repeat( n.depth );
			let line = `${pad}${n.name}  t=${JSON.stringify( n.t )}`;
			if ( n.r.some( ( x, i ) => Math.abs( x - [ 0, 0, 0, 1 ][ i ] ) > 1e-5 ) ) line += ` r=${JSON.stringify( n.r )}`;
			if ( n.s.some( ( x ) => Math.abs( x - 1 ) > 1e-5 ) ) line += ` s=${JSON.stringify( n.s )}`;
			if ( n.prims ) line += `  | ` + n.prims.map( ( p ) => `${p.material}:${p.tris}t` ).join( ', ' ) + `  wmin=${JSON.stringify( n.worldMin )} wmax=${JSON.stringify( n.worldMax )}`;
			console.log( line );

		}

		console.log( '\nmaterials:' );
		for ( const m of out.materials ) console.log( ' ', JSON.stringify( m ) );
		console.log( '\ntextures:', JSON.stringify( out.textures ) );

	}

	console.log( '\ncounts:', JSON.stringify( out.counts ), 'triangles:', out.totalTriangles, 'bbox:', JSON.stringify( out.bbox ) );

}
