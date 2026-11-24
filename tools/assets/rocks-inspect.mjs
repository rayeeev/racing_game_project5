#!/usr/bin/env node
// Inspect glTF/GLB files: node hierarchy, transforms, primitives, bounds, materials, textures.
//   node tools/assets/rocks-inspect.mjs <file.gltf|glb> [...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );
const f3 = ( a ) => '[' + Array.from( a ).map( ( v ) => v.toFixed( 3 ) ).join( ', ' ) + ']';

for ( const file of process.argv.slice( 2 ) ) {

	const doc = await io.read( file );
	const root = doc.getRoot();
	console.log( '\n=====', file );
	console.log( 'extensions:', root.listExtensionsUsed().map( ( e ) => e.extensionName ).join( ', ' ) || '-' );
	for ( const scene of root.listScenes() ) {

		const b = getBounds( scene );
		console.log( `scene "${scene.getName()}" bounds min ${f3( b.min )} max ${f3( b.max )} size ${f3( b.max.map( ( v, i ) => v - b.min[ i ] ) )}` );
		const walk = ( node, depth ) => {

			const mesh = node.getMesh();
			const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
			let line = `${'  '.repeat( depth )}- node "${node.getName()}" T${f3( t )} R${f3( r )} S${f3( s )}`;
			if ( mesh ) {

				const nb = getBounds( node );
				line += ` mesh "${mesh.getName()}" wsize ${f3( nb.max.map( ( v, i ) => v - nb.min[ i ] ) )} wmin ${f3( nb.min )} wmax ${f3( nb.max )}`;

			}

			console.log( line );
			if ( mesh ) {

				for ( const prim of mesh.listPrimitives() ) {

					const pos = prim.getAttribute( 'POSITION' );
					const idx = prim.getIndices();
					const tris = ( idx ? idx.getCount() : pos.getCount() ) / 3;
					const attrs = prim.listSemantics().map( ( s ) => `${s}:${prim.getAttribute( s ).getType()}/${prim.getAttribute( s ).getComponentType()}` ).join( ' ' );
					console.log( `${'  '.repeat( depth + 2 )}prim mode ${prim.getMode()} verts ${pos.getCount()} tris ${tris} mat "${prim.getMaterial()?.getName()}" attrs ${attrs}` );

				}

			}

			for ( const c of node.listChildren() ) walk( c, depth + 1 );

		};

		for ( const n of scene.listChildren() ) walk( n, 1 );

	}

	for ( const m of root.listMaterials() ) {

		const tex = ( t ) => ( t ? `${t.getName() || '?'}(${t.getURI() || t.getMimeType()} ${t.getSize()?.join( 'x' )})` : '-' );
		console.log( `material "${m.getName()}" baseColorFactor ${f3( m.getBaseColorFactor() )} metallic ${m.getMetallicFactor()} roughness ${m.getRoughnessFactor()} alpha ${m.getAlphaMode()} doubleSided ${m.getDoubleSided()}` );
		console.log( `   baseColor ${tex( m.getBaseColorTexture() )} normal ${tex( m.getNormalTexture() )} (scale ${m.getNormalScale()}) orm ${tex( m.getMetallicRoughnessTexture() )} occlusion ${tex( m.getOcclusionTexture() )} emissive ${tex( m.getEmissiveTexture() )}` );
		const mrInfo = m.getMetallicRoughnessTextureInfo(), bcInfo = m.getBaseColorTextureInfo();
		if ( bcInfo ) console.log( `   baseColor texCoord ${bcInfo.getTexCoord()} wrap ${bcInfo.getWrapS()}/${bcInfo.getWrapT()}` );

	}

	for ( const t of root.listTextures() ) console.log( `texture "${t.getName()}" uri ${t.getURI()} mime ${t.getMimeType()} size ${t.getSize()?.join( 'x' )} bytes ${t.getImage()?.byteLength}` );

}
