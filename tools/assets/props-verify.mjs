#!/usr/bin/env node
// Verifies public/assets/props/*.glb + index.json against the asset conventions. Exit code 1 on any violation.
//   node tools/assets/props-verify.mjs [--index public/assets/props/index.json] [--quiet]
// Checks per GLB: only "<variant>_LOD<n>" nodes directly under the scene root, identity transforms, one primitive per
// material, the same glTF material objects on every LOD, float32 positions in metres, triangle counts / sizes / bounds
// matching index.json, LOD budgets, texture formats + resolutions, no BLEND materials, extensions used.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice( 2 );
const opt = { index: 'public/assets/props/index.json', quiet: false };
for ( let i = 0; i < argv.length; i ++ ) { if ( argv[ i ] === '--quiet' ) opt.quiet = true; else if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ]; }

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder } );
const index = JSON.parse( readFileSync( opt.index, 'utf8' ) );
const problems = [];
const bad = ( msg ) => { problems.push( msg ); console.log( '  !! ' + msg ); };
const near = ( a, b, eps = 0.002 ) => Math.abs( a - b ) <= eps;
let totalBytes = 0, totalGpu = 0;
const rows = [];

for ( const asset of index.assets ) {

	const file = resolve( 'public', '.' + asset.file );
	if ( ! existsSync( file ) ) { bad( `${asset.id}: file missing ${file}` ); continue; }
	const bytes = statSync( file ).size;
	totalBytes += bytes;
	if ( bytes !== asset.bytes ) bad( `${asset.id}: bytes ${bytes} != index ${asset.bytes}` );
	for ( const key of [ 'id', 'file', 'source', 'author', 'license', 'textureResolution', 'bytes', 'variants' ] ) if ( asset[ key ] === undefined ) bad( `${asset.id}: index field ${key} missing` );
	if ( asset.source !== `https://polyhaven.com/a/${asset.id}` ) bad( `${asset.id}: source url` );

	const doc = await io.read( file );
	const root = doc.getRoot();
	const used = root.listExtensionsUsed().map( ( e ) => e.extensionName ).sort();
	const scene = root.getDefaultScene() || root.listScenes()[ 0 ];
	const children = scene.listChildren();
	const byName = new Map( children.map( ( n ) => [ n.getName(), n ] ) );
	if ( root.listNodes().length !== children.length ) bad( `${asset.id}: nodes that are not direct children of the scene root` );
	for ( const node of children ) {

		if ( ! /^.+_LOD\d$/.test( node.getName() ) ) bad( `${asset.id}: root node name ${node.getName()}` );
		const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
		if ( t.some( ( v ) => v !== 0 ) || r[ 0 ] !== 0 || r[ 1 ] !== 0 || r[ 2 ] !== 0 || r[ 3 ] !== 1 || s.some( ( v ) => v !== 1 ) ) bad( `${asset.id}: ${node.getName()} transform is not identity` );

	}

	// materials / textures
	let gpu = 0;
	const texInfo = [];
	for ( const tex of root.listTextures() ) {

		const md = await sharp( Buffer.from( tex.getImage() ) ).metadata();
		if ( ! [ 'image/webp', 'image/jpeg' ].includes( tex.getMimeType() ) ) bad( `${asset.id}: texture ${tex.getName()} mime ${tex.getMimeType()}` );
		if ( md.width !== md.height || ( md.width & ( md.width - 1 ) ) ) bad( `${asset.id}: texture ${tex.getName()} size ${md.width}x${md.height}` );
		if ( md.width > asset.textureResolution ) bad( `${asset.id}: texture ${tex.getName()} ${md.width} > textureResolution ${asset.textureResolution}` );
		gpu += md.width * md.height * 4 * 4 / 3;
		texInfo.push( `${tex.getName().replace( asset.id + '_', '' ).replace( asset.id, '' ) || 'main'}:${md.width}` );

	}

	totalGpu += gpu;
	for ( const m of root.listMaterials() ) {

		if ( m.getAlphaMode() === 'BLEND' ) bad( `${asset.id}: material ${m.getName()} uses BLEND` );
		const im = ( asset.materials || [] ).find( ( x ) => x.name === m.getName() );
		if ( ! im ) { bad( `${asset.id}: material ${m.getName()} missing from index.materials` ); continue; }
		if ( im.doubleSided !== m.getDoubleSided() ) bad( `${asset.id}: material ${m.getName()} doubleSided mismatch` );
		if ( ( im.alphaMode || 'OPAQUE' ) !== m.getAlphaMode() ) bad( `${asset.id}: material ${m.getName()} alphaMode mismatch` );
		if ( im.ao !== !! m.getOcclusionTexture() ) bad( `${asset.id}: material ${m.getName()} ao flag mismatch` );
		if ( m.getOcclusionTexture() && m.getOcclusionTexture() !== m.getMetallicRoughnessTexture() ) bad( `${asset.id}: material ${m.getName()} occlusion is not packed with metallicRoughness` );

	}

	// variants
	const seenNodes = new Set();
	for ( const v of asset.variants ) {

		for ( const key of [ 'name', 'size', 'radius', 'lods', 'avgColor', 'collider', 'dynamic', 'placement', 'sink', 'notes' ] ) if ( v[ key ] === undefined ) bad( `${asset.id}/${v.name}: index field ${key} missing` );
		if ( v.dynamic && typeof v.mass !== 'number' ) bad( `${asset.id}/${v.name}: dynamic without mass` );
		if ( ! [ 'box', 'cylinder', 'none' ].includes( v.collider.type ) ) bad( `${asset.id}/${v.name}: collider type` );
		if ( ! /^#[0-9a-f]{6}$/.test( v.avgColor ) ) bad( `${asset.id}/${v.name}: avgColor` );
		let lod0Mats = null;
		v.lods.forEach( ( lod, li ) => {

			if ( lod.node !== `${v.name}_LOD${li}` ) bad( `${asset.id}/${v.name}: lod node name ${lod.node}` );
			const node = byName.get( lod.node );
			if ( ! node ) { bad( `${asset.id}: node ${lod.node} missing in GLB` ); return; }
			seenNodes.add( lod.node );
			const prims = node.getMesh().listPrimitives();
			const mats = prims.map( ( p ) => p.getMaterial() );
			if ( new Set( mats ).size !== mats.length ) bad( `${asset.id}: ${lod.node} has several primitives with the same material` );
			if ( li === 0 ) lod0Mats = new Set( mats ); else for ( const m of mats ) if ( ! lod0Mats.has( m ) ) bad( `${asset.id}: ${lod.node} uses material ${m.getName()} that LOD0 does not use` );
			let tris = 0;
			const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
			let radius = 0;
			for ( const p of prims ) {

				if ( p.getMode() !== 4 ) bad( `${asset.id}: ${lod.node} non-triangle primitive` );
				const pos = p.getAttribute( 'POSITION' );
				if ( pos.getComponentType() !== 5126 ) bad( `${asset.id}: ${lod.node} POSITION is not float32` );
				if ( ! p.getAttribute( 'NORMAL' ) || ! p.getAttribute( 'TEXCOORD_0' ) ) bad( `${asset.id}: ${lod.node} missing NORMAL/TEXCOORD_0` );
				tris += p.getIndices().getCount() / 3;
				const a = pos.getArray();
				for ( let i = 0; i < a.length; i += 3 ) {

					for ( let k = 0; k < 3; k ++ ) { if ( a[ i + k ] < min[ k ] ) min[ k ] = a[ i + k ]; if ( a[ i + k ] > max[ k ] ) max[ k ] = a[ i + k ]; }
					radius = Math.max( radius, Math.hypot( a[ i ], a[ i + 2 ] ) );

				}

			}

			if ( tris !== lod.triangles ) bad( `${asset.id}: ${lod.node} triangles ${tris} != index ${lod.triangles}` );
			if ( li === 0 ) {

				const size = max.map( ( x, k ) => x - min[ k ] );
				if ( size.some( ( x, k ) => ! near( x, v.size[ k ] ) ) ) bad( `${asset.id}/${v.name}: size ${size.map( ( x ) => x.toFixed( 3 ) )} != index ${v.size}` );
				if ( ! near( radius, v.radius ) ) bad( `${asset.id}/${v.name}: radius ${radius.toFixed( 3 )} != index ${v.radius}` );
				// pivot convention: min y = 0 (a few mm tolerance: simplification may remove the lowest vertex). Variants that
				// deliberately share a vertical datum with siblings declare it via "datum" in index.json.
				if ( Math.abs( min[ 1 ] ) > 0.006 && ! v.datum ) bad( `${asset.id}/${v.name}: min y = ${min[ 1 ].toFixed( 4 )}` );
				const big = v.size[ 0 ] > 3 || v.size[ 1 ] > 3 || v.size[ 2 ] > 3;
				if ( tris > ( big ? 15000 : 6000 ) ) bad( `${asset.id}/${v.name}: LOD0 ${tris} tris over budget` );
				rows.push( [ `${asset.id}/${v.name}`, v.size.map( ( x ) => x.toFixed( 2 ) ).join( ' x ' ), v.lods.map( ( l ) => l.triangles ).join( ' / ' ), ( v.lods[ 1 ].triangles / v.lods[ 0 ].triangles * 100 ).toFixed( 0 ) + '%', v.collider.type, v.dynamic ? `dyn ${v.mass} kg` : 'static', v.placement, v.avgColor ] );

			}

		} );

	}

	for ( const node of children ) if ( ! seenNodes.has( node.getName() ) ) bad( `${asset.id}: GLB node ${node.getName()} not listed in index.json` );
	if ( ! opt.quiet ) console.log( `${asset.id.padEnd( 26 )} ${( bytes / 1024 ).toFixed( 0 ).padStart( 5 )} KB  gpu ${( gpu / 1048576 ).toFixed( 1 ).padStart( 5 )} MB  ext [${used.join( ', ' )}]  tex [${texInfo.join( ', ' )}]` );

}

if ( ! opt.quiet ) {

	console.log( '' );
	const w = [ 0, 1, 2, 3, 4, 5, 6, 7 ].map( ( c ) => Math.max( ...rows.map( ( r ) => r[ c ].length ) ) );
	for ( const r of rows ) console.log( r.map( ( c, i ) => c.padEnd( w[ i ] ) ).join( '  ' ) );

}

console.log( `\n${index.assets.length} assets, ${rows.length} variants, ${( totalBytes / 1e6 ).toFixed( 2 )} MB on disk, ~${( totalGpu / 1048576 ).toFixed( 0 )} MB GPU texture memory if everything is loaded (RGBA8 + mips)` );
console.log( problems.length ? `${problems.length} PROBLEM(S)` : 'OK - all convention checks passed' );
process.exit( problems.length ? 1 : 0 );
