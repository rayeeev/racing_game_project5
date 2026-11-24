#!/usr/bin/env node
// Prints the structure of glTF/GLB files: node tree (world bbox, triangles, materials) and material/texture setup.
// usage: node tools/assets/props-inspect.mjs [--depth 6] [--brief] <file.gltf|glb> ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const argv = process.argv.slice( 2 );
let maxDepth = 8, brief = false;
const files = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ] === '--depth' ) maxDepth = Number( argv[ ++ i ] );
	else if ( argv[ i ] === '--brief' ) brief = true;
	else files.push( argv[ i ] );

}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );
const f = ( n ) => ( Math.round( n * 1000 ) / 1000 ).toString();
const v = ( a ) => '[' + a.map( f ).join( ', ' ) + ']';

function tris( prim ) {

	const idx = prim.getIndices();
	const pos = prim.getAttribute( 'POSITION' );
	const count = idx ? idx.getCount() : ( pos ? pos.getCount() : 0 );
	return prim.getMode() === 4 ? count / 3 : 0;

}

for ( const file of files ) {

	const doc = await io.read( file );
	const root = doc.getRoot();
	console.log( `\n=== ${file}` );
	console.log( `extensionsUsed: ${root.listExtensionsUsed().map( ( e ) => e.extensionName ).join( ', ' ) || '-'}` );
	let total = 0;
	for ( const mesh of root.listMeshes() ) for ( const p of mesh.listPrimitives() ) total += tris( p );
	console.log( `meshes ${root.listMeshes().length}, nodes ${root.listNodes().length}, materials ${root.listMaterials().length}, textures ${root.listTextures().length}, unique-mesh triangles ${total}` );

	for ( const scene of root.listScenes() ) {

		const sb = getBounds( scene );
		console.log( `scene "${scene.getName()}" bbox min ${v( sb.min )} max ${v( sb.max )} size ${v( sb.max.map( ( x, i ) => x - sb.min[ i ] ) )}` );
		const walk = ( node, depth ) => {

			if ( depth > maxDepth ) return;
			const mesh = node.getMesh();
			let line = '  '.repeat( depth + 1 ) + `- ${node.getName() || '(unnamed)'}`;
			const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
			const hasT = t.some( ( x ) => Math.abs( x ) > 1e-6 ), hasR = Math.abs( r[ 3 ] ) < 0.999999, hasS = s.some( ( x ) => Math.abs( x - 1 ) > 1e-6 );
			if ( ! brief && ( hasT || hasR || hasS ) ) line += ` T${hasT ? v( t ) : ''}${hasR ? ' R' + v( r ) : ''}${hasS ? ' S' + v( s ) : ''}`;
			if ( mesh ) {

				const b = getBounds( node );
				const prims = mesh.listPrimitives();
				const attrs = prims[ 0 ] ? prims[ 0 ].listSemantics().join( ',' ) : '';
				line += ` | mesh "${mesh.getName()}" tris ${prims.map( tris ).join( '+' )} mats [${prims.map( ( p ) => p.getMaterial()?.getName() ).join( ', ' )}] size ${v( b.max.map( ( x, i ) => x - b.min[ i ] ) )} min ${v( b.min )} max ${v( b.max )}${brief ? '' : ' attrs ' + attrs}`;

			}

			console.log( line );
			for ( const c of node.listChildren() ) walk( c, depth + 1 );

		};

		for ( const c of scene.listChildren() ) walk( c, 0 );

	}

	for ( const m of root.listMaterials() ) {

		const tex = ( t ) => ( t ? `${t.getName() || ''}(${t.getURI() || t.getMimeType()} ${( t.getSize() || [] ).join( 'x' )})` : '-' );
		console.log( `material "${m.getName()}": alpha ${m.getAlphaMode()}${m.getAlphaMode() === 'MASK' ? ' cutoff ' + m.getAlphaCutoff() : ''} doubleSided ${m.getDoubleSided()} baseColorFactor ${v( m.getBaseColorFactor() )} metal ${f( m.getMetallicFactor() )} rough ${f( m.getRoughnessFactor() )} emissive ${v( m.getEmissiveFactor() )}` );
		console.log( `    base ${tex( m.getBaseColorTexture() )} | normal ${tex( m.getNormalTexture() )} scale ${m.getNormalScale()} | MR ${tex( m.getMetallicRoughnessTexture() )} | occ ${tex( m.getOcclusionTexture() )} | emis ${tex( m.getEmissiveTexture() )} | ext ${m.listExtensions().map( ( e ) => e.extensionName ).join( ',' ) || '-'}` );

	}

}
