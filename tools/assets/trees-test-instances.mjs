#!/usr/bin/env node
// Exploratory: instance recovery statistics for one tree LOD1 dump.
//   node tools/assets/trees-test-instances.mjs <id> <treeObject> "<protoRegex>"
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadDump, findInstances, SRC, m3 } from './trees-lib.mjs';
const [ id, objName, protoRe ] = process.argv.slice( 2 );
const tree = loadDump( id, objName );
const re = new RegExp( protoRe );
const names = readdirSync( join( SRC, '_dump', id ) ).filter( ( f ) => f.endsWith( '.json' ) ).map( ( f ) => f.slice( 0, - 5 ) ).filter( ( n ) => re.test( n ) ).sort();
const protos = names.map( ( n ) => loadDump( id, n ) );
const mat = tree.meta.materials.findIndex( ( m ) => m && /twig|leaves/.test( m ) );
const t0 = Date.now();
const inst = findInstances( tree, protos, mat );
console.log( `${objName}: ${inst.length} instances in ${Date.now() - t0} ms, unmatched polys ${inst.unmatchedPolys}` );
for ( let i = 0; i < protos.length; i ++ ) {

	const l = inst.filter( ( x ) => x.proto === i );
	if ( ! l.length ) {

		console.log( `  ${names[ i ]}: 0` );
		continue;

	}

	const s = l.map( ( x ) => x.T.s ).sort( ( a, b ) => a - b );
	const rms = l.map( ( x ) => x.T.rms / x.T.s ).sort( ( a, b ) => a - b );
	const det = l.map( ( x ) => m3.det( x.T.R ) );
	// world "up" of the prototype's local +Y axis
	const upY = l.map( ( x ) => x.T.R[ 4 ] ).sort( ( a, b ) => a - b );
	const pr = protos[ i ];
	const min = [ 1e9, 1e9, 1e9 ], max = [ - 1e9, - 1e9, - 1e9 ];
	for ( let v = 0; v < pr.nv; v ++ ) for ( let k = 0; k < 3; k ++ ) {

		min[ k ] = Math.min( min[ k ], pr.position[ v * 3 + k ] );
		max[ k ] = Math.max( max[ k ], pr.position[ v * 3 + k ] );

	}

	const q = ( a, f ) => a[ Math.min( a.length - 1, Math.floor( a.length * f ) ) ];
	console.log( `  ${names[ i ]}: n=${l.length} tris=${pr.meta.triangles} size=[${max.map( ( x, k ) => ( x - min[ k ] ).toFixed( 2 ) )}] scale min/med/max=${s[ 0 ].toFixed( 3 )}/${q( s, 0.5 ).toFixed( 3 )}/${s[ s.length - 1 ].toFixed( 3 )} relRms med/max=${q( rms, 0.5 ).toExponential( 1 )}/${rms[ rms.length - 1 ].toExponential( 1 )} det min=${Math.min( ...det ).toFixed( 3 )} localUp.y p10/p50/p90=${q( upY, 0.1 ).toFixed( 2 )}/${q( upY, 0.5 ).toFixed( 2 )}/${q( upY, 0.9 ).toFixed( 2 )}` );

}
