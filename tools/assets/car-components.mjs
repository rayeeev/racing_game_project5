#!/usr/bin/env node
// List the connected components (loose parts) of selected mesh nodes of a car GLB, in world coordinates.
// usage: node tools/assets/car-components.mjs <file.glb> <nodeName[,nodeName...]> [--min-tris N] [--max N] [--tol 1e-4] [--json out.json]
import { writeFileSync } from 'node:fs';
import { makeIO, worldMatrix, readPrimitiveWorld, connectedComponents, r3 } from './car-lib.mjs';

const argv = process.argv.slice( 2 );
const file = argv[ 0 ];
const names = ( argv[ 1 ] || '' ).split( ',' );
const opt = ( k, d ) => ( argv.includes( '--' + k ) ? argv[ argv.indexOf( '--' + k ) + 1 ] : d );
const minTris = Number( opt( 'min-tris', 0 ) );
const maxList = Number( opt( 'max', 400 ) );
const tol = Number( opt( 'tol', 1e-4 ) );
const jsonOut = opt( 'json', null );

const io = await makeIO();
const doc = await io.read( file );
const result = {};
for ( const node of doc.getRoot().listNodes() ) {

	if ( ! names.includes( node.getName() ) || ! node.getMesh() ) continue;
	const parentName = node.getParentNode() ? node.getParentNode().getName() : '';
	const m = worldMatrix( node );
	for ( const prim of node.getMesh().listPrimitives() ) {

		const { positions, indices } = readPrimitiveWorld( prim, m );
		const cc = connectedComponents( positions, indices, tol );
		const list = cc.list.filter( ( c ) => c.tris >= minTris ).sort( ( a, b ) => b.area - a.area );
		const label = `${parentName}/${node.getName()} [${prim.getMaterial()?.getName()}]`;
		console.log( `\n== ${label}: ${indices.length / 3} tris, ${cc.count} components` );
		for ( const c of list.slice( 0, maxList ) ) {

			console.log( `  #${String( c.id ).padStart( 3 )} tris=${String( c.tris ).padStart( 5 )} area=${c.area.toFixed( 4 ).padStart( 8 )} c=[${r3( c.center ).map( ( x ) => x.toFixed( 3 ).padStart( 7 ) ).join( ',' )}] size=[${r3( c.size ).map( ( x ) => x.toFixed( 3 ) ).join( ',' )}]` );

		}

		result[ label ] = list.map( ( c ) => ( { id: c.id, tris: c.tris, area: c.area, center: r3( c.center ), size: r3( c.size ), min: r3( c.min ), max: r3( c.max ) } ) );

	}

}

if ( jsonOut ) writeFileSync( jsonOut, JSON.stringify( result, null, 1 ) );
