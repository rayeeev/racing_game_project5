#!/usr/bin/env node
// Simplifier experiments: prints triangle counts / absolute errors for several flag combinations.
// usage: node tools/assets/props-simptest.mjs <file.gltf> <nodeRegex> <target> [absErrorMeters]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { transformMesh, mergeByMaterial, weld } from './props-lib.mjs';
const [ file, nodeRe, targetArg, absArg ] = process.argv.slice( 2 );
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS );
const doc = await io.read( file );
const re = new RegExp( nodeRe );
const meshes = [];
for ( const node of doc.getRoot().listNodes() ) {
	if ( ! node.getMesh() || ! re.test( node.getName() ) ) continue;
	for ( const prim of node.getMesh().listPrimitives() ) {
		const n = prim.getAttribute( 'POSITION' ).getCount();
		const g = ( s, size ) => { const a = prim.getAttribute( s ); const o = new Float32Array( n * size ); const el = []; for ( let i = 0; i < n; i ++ ) { a.getElement( i, el ); o.set( el.slice( 0, size ), i * size ); } return o; };
		meshes.push( transformMesh( { material: prim.getMaterial().getName(), pos: g( 'POSITION', 3 ), nrm: g( 'NORMAL', 3 ), uv: g( 'TEXCOORD_0', 2 ), idx: new Uint32Array( prim.getIndices().getArray() ) }, node.getWorldMatrix() ) );
	}
}
for ( const m of mergeByMaterial( meshes ).map( weld ) ) {
	const n = m.pos.length / 3, src = m.idx.length / 3;
	const scale = MeshoptSimplifier.getScale( m.pos, 3 );
	const target = Math.round( Number( targetArg ) <= 1 ? src * Number( targetArg ) : Number( targetArg ) );
	console.log( `\n${m.material}: ${src} tris, ${n} verts, scale ${scale.toFixed( 3 )} m, target ${target}` );
	const attrs = new Float32Array( n * 5 );
	for ( let i = 0; i < n; i ++ ) { attrs.set( m.nrm.subarray( i * 3, i * 3 + 3 ), i * 5 ); attrs.set( m.uv.subarray( i * 2, i * 2 + 2 ), i * 5 + 3 ); }
	const errs = absArg ? [ Number( absArg ) / scale ] : [ 0.01, 0.03, 0.1, 1 ];
	for ( const err of errs ) {
		const run = ( label, fn ) => { const t = performance.now(); const [ idx, e ] = fn(); console.log( `  err<=${( err * scale * 1000 ).toFixed( 0 ).padStart( 4 )}mm ${label.padEnd( 44 )} -> ${String( idx.length / 3 ).padStart( 6 )} tris, err ${( e * scale * 1000 ).toFixed( 1 )} mm (${( performance.now() - t ).toFixed( 0 )} ms)` ); };
		run( 'simplify (pos only)', () => MeshoptSimplifier.simplify( m.idx, m.pos, 3, target * 3, err, [] ) );
		run( 'attr n0.5 uv0.5', () => MeshoptSimplifier.simplifyWithAttributes( m.idx, m.pos, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0.5, 0.5 ], null, target * 3, err, [] ) );
		run( 'attr n0.5 uv0.5 Prune', () => MeshoptSimplifier.simplifyWithAttributes( m.idx, m.pos, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0.5, 0.5 ], null, target * 3, err, [ 'Prune' ] ) );
		run( 'attr n0.5 uv0.5 Permissive', () => MeshoptSimplifier.simplifyWithAttributes( m.idx, m.pos, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0.5, 0.5 ], null, target * 3, err, [ 'Permissive' ] ) );
		run( 'attr n0.5 uv0.5 Permissive+Prune', () => MeshoptSimplifier.simplifyWithAttributes( m.idx, m.pos, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0.5, 0.5 ], null, target * 3, err, [ 'Permissive', 'Prune' ] ) );
		run( 'attr n0.1 uv0.1 Permissive+Prune', () => MeshoptSimplifier.simplifyWithAttributes( m.idx, m.pos, 3, attrs, 5, [ 0.1, 0.1, 0.1, 0.1, 0.1 ], null, target * 3, err, [ 'Permissive', 'Prune' ] ) );
		run( 'pos only Permissive+Prune', () => MeshoptSimplifier.simplify( m.idx, m.pos, 3, target * 3, err, [ 'Permissive', 'Prune' ] ) );
		run( 'sloppy', () => MeshoptSimplifier.simplifySloppy( m.idx, m.pos, 3, null, target * 3, err ) );
	}
}
