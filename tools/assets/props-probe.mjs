#!/usr/bin/env node
// Geometry probe for glTF files: per node/primitive world-space bounds (+ local bounds) and optional binned ranges.
// usage: node tools/assets/props-probe.mjs <file.gltf|glb> [--node <substring>] [--bin x|y|z] [--step 0.5] [--top 0.03]
//   --bin  axis along which to bin vertices (prints the ranges of the two other axes per bin)
//   --top  print the centroid clusters of vertices within <top> m of the max Y of each primitive (finds post/insulator tops)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const argv = process.argv.slice( 2 );
const opt = { node: '', bin: '', step: '0.5', top: '' };
let file = null;
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ].startsWith( '--' ) ) opt[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
	else file = argv[ i ];

}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder } );
const doc = await io.read( file );
const f = ( n ) => n.toFixed( 3 );
const AX = { x: 0, y: 1, z: 2 };

for ( const node of doc.getRoot().listNodes() ) {

	const mesh = node.getMesh();
	if ( ! mesh ) continue;
	if ( opt.node && ! node.getName().includes( opt.node ) ) continue;
	const m = node.getWorldMatrix();
	for ( const prim of mesh.listPrimitives() ) {

		const a = prim.getAttribute( 'POSITION' ).getArray();
		const uv = prim.getAttribute( 'TEXCOORD_0' )?.getArray();
		const mn = [ 1e9, 1e9, 1e9 ], mx = [ - 1e9, - 1e9, - 1e9 ], lmn = [ 1e9, 1e9, 1e9 ], lmx = [ - 1e9, - 1e9, - 1e9 ];
		const world = new Float32Array( a.length );
		for ( let i = 0; i < a.length; i += 3 ) {

			const x = a[ i ], y = a[ i + 1 ], z = a[ i + 2 ];
			const p = [ m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ], m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ], m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ];
			world.set( p, i );
			const l = [ x, y, z ];
			for ( let k = 0; k < 3; k ++ ) {

				mn[ k ] = Math.min( mn[ k ], p[ k ] ); mx[ k ] = Math.max( mx[ k ], p[ k ] );
				lmn[ k ] = Math.min( lmn[ k ], l[ k ] ); lmx[ k ] = Math.max( lmx[ k ], l[ k ] );

			}

		}

		let uvr = '';
		if ( uv ) {

			let u0 = 1e9, u1 = - 1e9, v0 = 1e9, v1 = - 1e9;
			for ( let i = 0; i < uv.length; i += 2 ) { u0 = Math.min( u0, uv[ i ] ); u1 = Math.max( u1, uv[ i ] ); v0 = Math.min( v0, uv[ i + 1 ] ); v1 = Math.max( v1, uv[ i + 1 ] ); }
			uvr = ` uv [${f( u0 )}..${f( u1 )}, ${f( v0 )}..${f( v1 )}]`;

		}

		console.log( `${node.getName()} | ${prim.getMaterial()?.getName()} | verts ${a.length / 3} | world min ${mn.map( f )} max ${mx.map( f )} | local min ${lmn.map( f )} max ${lmx.map( f )}${uvr}` );

		if ( opt.bin ) {

			const ax = AX[ opt.bin ], step = Number( opt.step );
			const o = [ 0, 1, 2 ].filter( ( k ) => k !== ax );
			const bins = new Map();
			for ( let i = 0; i < world.length; i += 3 ) {

				const b = Math.round( world[ i + ax ] / step ) * step;
				const e = bins.get( b ) || [ 1e9, - 1e9, 1e9, - 1e9, 0 ];
				e[ 0 ] = Math.min( e[ 0 ], world[ i + o[ 0 ] ] ); e[ 1 ] = Math.max( e[ 1 ], world[ i + o[ 0 ] ] );
				e[ 2 ] = Math.min( e[ 2 ], world[ i + o[ 1 ] ] ); e[ 3 ] = Math.max( e[ 3 ], world[ i + o[ 1 ] ] ); e[ 4 ] ++;
				bins.set( b, e );

			}

			for ( const [ b, e ] of [ ...bins.entries() ].sort( ( p, q ) => p[ 0 ] - q[ 0 ] ) ) console.log( `    ${opt.bin} ${b.toFixed( 2 )}: ${'xyz'[ o[ 0 ] ]} ${f( e[ 0 ] )}..${f( e[ 1 ] )}  ${'xyz'[ o[ 1 ] ]} ${f( e[ 2 ] )}..${f( e[ 3 ] )}  (${e[ 4 ]} verts)` );

		}

		if ( opt.top ) {

			const tol = Number( opt.top );
			const pts = [];
			for ( let i = 0; i < world.length; i += 3 ) if ( world[ i + 1 ] > mx[ 1 ] - tol ) pts.push( [ world[ i ], world[ i + 1 ], world[ i + 2 ] ] );
			// greedy clustering in xz with 0.1 m radius
			const clusters = [];
			for ( const p of pts ) {

				let c = clusters.find( ( c ) => Math.hypot( c.x / c.n - p[ 0 ], c.z / c.n - p[ 2 ] ) < 0.1 );
				if ( ! c ) clusters.push( c = { x: 0, y: 0, z: 0, n: 0 } );
				c.x += p[ 0 ]; c.y = Math.max( c.y, p[ 1 ] ); c.z += p[ 2 ]; c.n ++;

			}

			for ( const c of clusters ) console.log( `    top cluster: x ${f( c.x / c.n )} y ${f( c.y )} z ${f( c.z / c.n )} (${c.n} verts)` );

		}

	}

}
