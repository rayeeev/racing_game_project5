#!/usr/bin/env node
// Exploratory: island structure of the twig card prototypes (flat spray + vertical "fin" cards).
import { loadDump, DSU, v3, eigSym3 } from './trees-lib.mjs';
const [ id, ...names ] = process.argv.slice( 2 );
for ( const name of names ) {

	const d = loadDump( id, name );
	const dsu = new DSU( d.nv );
	for ( let p = 0; p < d.np; p ++ ) for ( let c = 1; c < d.polyCount[ p ]; c ++ ) dsu.union( d.cornerVert[ d.polyStart[ p ] ], d.cornerVert[ d.polyStart[ p ] + c ] );
	const isl = new Map();
	for ( let p = 0; p < d.np; p ++ ) {

		const r = dsu.find( d.cornerVert[ d.polyStart[ p ] ] );
		if ( ! isl.has( r ) ) isl.set( r, [] );
		isl.get( r ).push( p );

	}

	console.log( `${name}: ${isl.size} islands, ${d.meta.triangles} tris` );
	for ( const polys of isl.values() ) {

		let area = 0;
		const nrm = [ 0, 0, 0 ], min = [ 1e9, 1e9, 1e9 ], max = [ - 1e9, - 1e9, - 1e9 ], uvmin = [ 9, 9 ], uvmax = [ - 9, - 9 ];
		let tris = 0;
		for ( const p of polys ) {

			const s = d.polyStart[ p ], n = d.polyCount[ p ];
			const P = [];
			for ( let c = 0; c < n; c ++ ) {

				const v = d.cornerVert[ s + c ];
				P.push( [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ] );
				for ( let k = 0; k < 3; k ++ ) {

					min[ k ] = Math.min( min[ k ], P[ c ][ k ] );
					max[ k ] = Math.max( max[ k ], P[ c ][ k ] );

				}

				for ( let k = 0; k < 2; k ++ ) {

					uvmin[ k ] = Math.min( uvmin[ k ], d.uv[ ( s + c ) * 2 + k ] );
					uvmax[ k ] = Math.max( uvmax[ k ], d.uv[ ( s + c ) * 2 + k ] );

				}

			}

			for ( let k = 1; k < n - 1; k ++ ) {

				const cr = v3.cross( v3.sub( P[ k ], P[ 0 ] ), v3.sub( P[ k + 1 ], P[ 0 ] ) );
				area += v3.len( cr ) / 2;
				for ( let q = 0; q < 3; q ++ ) nrm[ q ] += cr[ q ] / 2;
				tris ++;

			}

		}

		const n = v3.norm( nrm );
		console.log( `    polys=${polys.length} tris=${tris} area=${area.toFixed( 3 )} planarity=${( v3.len( nrm ) / area ).toFixed( 2 )} normal=[${n.map( ( x ) => x.toFixed( 2 ) )}] bbox=[${min.map( ( x ) => x.toFixed( 2 ) )}]..[${max.map( ( x ) => x.toFixed( 2 ) )}] uv=[${uvmin.map( ( x ) => x.toFixed( 3 ) )}]..[${uvmax.map( ( x ) => x.toFixed( 3 ) )}]` );

	}

}
