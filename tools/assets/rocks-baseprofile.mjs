#!/usr/bin/env node
// Bottom-edge profile of open "sheet" meshes in built GLBs: lowest border vertex per x-bin (LOD0).
//   node tools/assets/rocks-baseprofile.mjs <glb> [...]
import { makeIO } from './rocks-lib.mjs';
const io = await makeIO();
for ( const file of process.argv.slice( 2 ) ) {

	const doc = await io.read( file );
	for ( const node of doc.getRoot().listNodes() ) {

		if ( ! /_LOD0$/.test( node.getName() ) ) continue;
		const prim = node.getMesh().listPrimitives()[ 0 ];
		const pos = prim.getAttribute( 'POSITION' ).getArray(), idx = prim.getIndices().getArray();
		const n = pos.length / 3;
		const map = new Map(), pid = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) { const k = pos[ i * 3 ] + ',' + pos[ i * 3 + 1 ] + ',' + pos[ i * 3 + 2 ]; let id = map.get( k ); if ( id === undefined ) { id = map.size; map.set( k, id ); } pid[ i ] = id; }
		const edges = new Map();
		for ( let t = 0; t < idx.length; t += 3 ) for ( let e = 0; e < 3; e ++ ) {

			const a = pid[ idx[ t + e ] ], b = pid[ idx[ t + ( e + 1 ) % 3 ] ];
			const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
			const rec = edges.get( k );
			if ( rec ) rec.c ++; else edges.set( k, { c: 1, v: idx[ t + e ], w: idx[ t + ( e + 1 ) % 3 ] } );

		}

		let minX = Infinity, maxX = - Infinity, maxY = 0;
		for ( let i = 0; i < n; i ++ ) { minX = Math.min( minX, pos[ i * 3 ] ); maxX = Math.max( maxX, pos[ i * 3 ] ); maxY = Math.max( maxY, pos[ i * 3 + 1 ] ); }
		const BINS = 24;
		const low = new Array( BINS ).fill( Infinity ), lowZ = new Array( BINS ).fill( 0 );
		let borderEdges = 0;
		for ( const rec of edges.values() ) {

			if ( rec.c !== 1 ) continue;
			borderEdges ++;
			for ( const v of [ rec.v, rec.w ] ) {

				const b = Math.min( BINS - 1, Math.floor( ( pos[ v * 3 ] - minX ) / ( maxX - minX ) * BINS ) );
				if ( pos[ v * 3 + 1 ] < low[ b ] ) { low[ b ] = pos[ v * 3 + 1 ]; lowZ[ b ] = pos[ v * 3 + 2 ]; }

			}

		}

		const vals = low.filter( ( v ) => Number.isFinite( v ) );
		const sorted = [ ...vals ].sort( ( a, b ) => a - b );
		console.log( `${node.getName()}: border edges ${borderEdges}, height ${maxY.toFixed( 2 )}; bottom edge y per x-bin (left -> right):\n   ` + low.map( ( v ) => ( Number.isFinite( v ) ? v.toFixed( 2 ) : ' -- ' ) ).join( ' ' ) + `\n   z: ` + lowZ.map( ( v ) => v.toFixed( 1 ) ).join( ' ' ) + `\n   median ${sorted[ sorted.length >> 1 ].toFixed( 2 )} p80 ${sorted[ Math.floor( sorted.length * 0.8 ) ].toFixed( 2 )} max ${sorted[ sorted.length - 1 ].toFixed( 2 )}` );

	}

}
