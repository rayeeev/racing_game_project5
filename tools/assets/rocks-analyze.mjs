#!/usr/bin/env node
// Topology / UV analysis of source meshes: welded vertex counts, geometric components, UV islands, open borders, UV range.
//   node tools/assets/rocks-analyze.mjs <file.gltf> [...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );

class DSU {

	constructor( n ) { this.p = new Int32Array( n ); for ( let i = 0; i < n; i ++ ) this.p[ i ] = i; }
	find( a ) { while ( this.p[ a ] !== a ) { this.p[ a ] = this.p[ this.p[ a ] ]; a = this.p[ a ]; } return a; }
	union( a, b ) { a = this.find( a ); b = this.find( b ); if ( a !== b ) this.p[ a ] = b; }

}

function analyze( prim ) {

	const pos = prim.getAttribute( 'POSITION' ).getArray();
	const uv = prim.getAttribute( 'TEXCOORD_0' ).getArray();
	const nrm = prim.getAttribute( 'NORMAL' )?.getArray();
	const idxAcc = prim.getIndices();
	const n = pos.length / 3;
	const idx = idxAcc ? idxAcc.getArray() : Uint32Array.from( { length: n }, ( _, i ) => i );
	const tris = idx.length / 3;

	// weld by exact position
	const posMap = new Map();
	const posId = new Int32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		const k = pos[ i * 3 ] + ',' + pos[ i * 3 + 1 ] + ',' + pos[ i * 3 + 2 ];
		let id = posMap.get( k );
		if ( id === undefined ) { id = posMap.size; posMap.set( k, id ); }
		posId[ i ] = id;

	}

	// weld by position+uv (ignoring normals)
	const puMap = new Map();
	const puId = new Int32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		const k = posId[ i ] + ',' + uv[ i * 2 ] + ',' + uv[ i * 2 + 1 ];
		let id = puMap.get( k );
		if ( id === undefined ) { id = puMap.size; puMap.set( k, id ); }
		puId[ i ] = id;

	}

	// weld by position+uv+normal
	const fullMap = new Map();
	for ( let i = 0; i < n; i ++ ) {

		const k = puId[ i ] + ',' + ( nrm ? nrm[ i * 3 ] + ',' + nrm[ i * 3 + 1 ] + ',' + nrm[ i * 3 + 2 ] : '' );
		if ( ! fullMap.has( k ) ) fullMap.set( k, fullMap.size );

	}

	const geo = new DSU( posMap.size );
	const isl = new DSU( puMap.size );
	const edgeCount = new Map();
	let area = 0, uvArea = 0, degenerate = 0;
	for ( let t = 0; t < tris; t ++ ) {

		const a = idx[ t * 3 ], b = idx[ t * 3 + 1 ], c = idx[ t * 3 + 2 ];
		geo.union( posId[ a ], posId[ b ] ); geo.union( posId[ a ], posId[ c ] );
		isl.union( puId[ a ], puId[ b ] ); isl.union( puId[ a ], puId[ c ] );
		const pa = posId[ a ], pb = posId[ b ], pc = posId[ c ];
		if ( pa === pb || pb === pc || pa === pc ) { degenerate ++; continue; }
		for ( const [ x, y ] of [ [ pa, pb ], [ pb, pc ], [ pc, pa ] ] ) {

			const k = x < y ? x * 4294967296 + y : y * 4294967296 + x;
			edgeCount.set( k, ( edgeCount.get( k ) || 0 ) + 1 );

		}

		const ax = pos[ a * 3 ], ay = pos[ a * 3 + 1 ], az = pos[ a * 3 + 2 ];
		const ux = pos[ b * 3 ] - ax, uy = pos[ b * 3 + 1 ] - ay, uz = pos[ b * 3 + 2 ] - az;
		const vx = pos[ c * 3 ] - ax, vy = pos[ c * 3 + 1 ] - ay, vz = pos[ c * 3 + 2 ] - az;
		const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
		area += 0.5 * Math.hypot( cx, cy, cz );
		const s1 = uv[ b * 2 ] - uv[ a * 2 ], t1 = uv[ b * 2 + 1 ] - uv[ a * 2 + 1 ];
		const s2 = uv[ c * 2 ] - uv[ a * 2 ], t2 = uv[ c * 2 + 1 ] - uv[ a * 2 + 1 ];
		uvArea += 0.5 * Math.abs( s1 * t2 - s2 * t1 );

	}

	let border = 0, nonManifold = 0;
	for ( const c of edgeCount.values() ) { if ( c === 1 ) border ++; else if ( c > 2 ) nonManifold ++; }
	const geoRoots = new Map();
	for ( let t = 0; t < tris; t ++ ) { const r = geo.find( posId[ idx[ t * 3 ] ] ); geoRoots.set( r, ( geoRoots.get( r ) || 0 ) + 1 ); }
	const islRoots = new Map();
	for ( let t = 0; t < tris; t ++ ) { const r = isl.find( puId[ idx[ t * 3 ] ] ); islRoots.set( r, ( islRoots.get( r ) || 0 ) + 1 ); }
	let umin = Infinity, umax = - Infinity, vmin = Infinity, vmax = - Infinity;
	for ( let i = 0; i < n; i ++ ) { umin = Math.min( umin, uv[ i * 2 ] ); umax = Math.max( umax, uv[ i * 2 ] ); vmin = Math.min( vmin, uv[ i * 2 + 1 ] ); vmax = Math.max( vmax, uv[ i * 2 + 1 ] ); }
	const islSizes = [ ...islRoots.values() ].sort( ( a, b ) => b - a );
	const geoSizes = [ ...geoRoots.values() ].sort( ( a, b ) => b - a );
	return {
		verts: n, tris, uniquePos: posMap.size, uniquePosUv: puMap.size, uniqueFull: fullMap.size,
		geoComponents: geoRoots.size, geoTop: geoSizes.slice( 0, 6 ), uvIslands: islRoots.size, islTop: islSizes.slice( 0, 8 ),
		smallIslands: islSizes.filter( ( s ) => s < 20 ).length,
		borderEdges: border, nonManifoldEdges: nonManifold, degenerate,
		area: + area.toFixed( 3 ), uvArea: + uvArea.toFixed( 3 ), uvRange: [ umin, umax, vmin, vmax ].map( ( v ) => + v.toFixed( 3 ) ),
	};

}

for ( const file of process.argv.slice( 2 ) ) {

	const doc = await io.read( file );
	console.log( '\n=====', file );
	for ( const node of doc.getRoot().listNodes() ) {

		const mesh = node.getMesh();
		if ( ! mesh ) continue;
		for ( const prim of mesh.listPrimitives() ) console.log( node.getName(), JSON.stringify( analyze( prim ) ) );

	}

}
