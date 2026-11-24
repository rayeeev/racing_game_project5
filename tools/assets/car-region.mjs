#!/usr/bin/env node
// List the loose parts of EVERY mesh of a GLB whose bbox centre lies in a box (world space).
// usage: node tools/assets/car-region.mjs <file.glb> x0 x1 y0 y1 z0 z1 [--sym] [--max-size 0.5] [--all-of <node>]
import { makeIO, worldMatrix, readPrimitiveWorld, connectedComponents, r3 } from './car-lib.mjs';
const a = process.argv.slice( 2 );
const file = a[ 0 ];
const [ x0, x1, y0, y1, z0, z1 ] = a.slice( 1, 7 ).map( Number );
const sym = a.includes( '--sym' );
const maxSize = a.includes( '--max-size' ) ? Number( a[ a.indexOf( '--max-size' ) + 1 ] ) : Infinity;
const allOf = a.includes( '--all-of' ) ? a[ a.indexOf( '--all-of' ) + 1 ] : null;
const io = await makeIO();
const doc = await io.read( file );
for ( const node of doc.getRoot().listNodes() ) {

	if ( ! node.getMesh() ) continue;
	const m = worldMatrix( node );
	for ( const prim of node.getMesh().listPrimitives() ) {

		const { positions, indices } = readPrimitiveWorld( prim, m );
		const cc = connectedComponents( positions, indices );
		for ( const c of cc.list ) {

			const x = sym ? Math.abs( c.center[ 0 ] ) : c.center[ 0 ];
			const inside = x >= x0 && x <= x1 && c.center[ 1 ] >= y0 && c.center[ 1 ] <= y1 && c.center[ 2 ] >= z0 && c.center[ 2 ] <= z1 && Math.max( ...c.size ) <= maxSize;
			if ( inside || node.getName() === allOf ) console.log( `${( ( node.getParentNode()?.getName() ?? '' ) + '/' + node.getName() ).padEnd( 28 )} [${prim.getMaterial()?.getName()}] #${c.id} tris=${c.tris} area=${c.area.toFixed( 5 )} c=[${r3( c.center ).join( ',' )}] size=[${r3( c.size ).join( ',' )}]` );

		}

	}

}
