#!/usr/bin/env node
// Exploratory: print the structure of a dumped tree LOD mesh (materials, islands, instance matches against prototypes).
//   node tools/assets/trees-analyze.mjs <id> <treeObject> [<protoRegex>]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadDump, DSU, SRC } from './trees-lib.mjs';

const [ id, objName, protoRe ] = process.argv.slice( 2 );
const d = loadDump( id, objName );
console.log( `${objName}: verts=${d.nv} corners=${d.nc} polys=${d.np} materials=${JSON.stringify( d.meta.materials )} hasColor=${d.meta.hasColor}` );

// per material stats
const mats = d.meta.materials;
const stat = mats.map( () => ( { polys: 0, tris: 0, min: [ 1e9, 1e9, 1e9 ], max: [ - 1e9, - 1e9, - 1e9 ], uvmin: [ 1e9, 1e9 ], uvmax: [ - 1e9, - 1e9 ] } ) );
for ( let p = 0; p < d.np; p ++ ) {

	const s = stat[ d.polyMat[ p ] ];
	s.polys ++;
	s.tris += d.polyCount[ p ] - 2;
	for ( let c = d.polyStart[ p ]; c < d.polyStart[ p ] + d.polyCount[ p ]; c ++ ) {

		const v = d.cornerVert[ c ];
		for ( let k = 0; k < 3; k ++ ) {

			s.min[ k ] = Math.min( s.min[ k ], d.position[ v * 3 + k ] );
			s.max[ k ] = Math.max( s.max[ k ], d.position[ v * 3 + k ] );

		}

		if ( d.uv ) for ( let k = 0; k < 2; k ++ ) {

			s.uvmin[ k ] = Math.min( s.uvmin[ k ], d.uv[ c * 2 + k ] );
			s.uvmax[ k ] = Math.max( s.uvmax[ k ], d.uv[ c * 2 + k ] );

		}

	}

}

// islands
const dsu = new DSU( d.nv );
for ( let p = 0; p < d.np; p ++ ) {

	const s = d.polyStart[ p ];
	for ( let c = 1; c < d.polyCount[ p ]; c ++ ) dsu.union( d.cornerVert[ s ], d.cornerVert[ s + c ] );

}

const islandMat = new Map(); // root -> {mat, polys, verts:Set}
for ( let p = 0; p < d.np; p ++ ) {

	const r = dsu.find( d.cornerVert[ d.polyStart[ p ] ] );
	let e = islandMat.get( r );
	if ( ! e ) islandMat.set( r, e = { mats: new Set(), polys: 0, tris: 0, firstPoly: p, lastPoly: p } );
	e.mats.add( d.polyMat[ p ] );
	e.polys ++;
	e.tris += d.polyCount[ p ] - 2;
	e.lastPoly = p;

}

const vertsPerIsland = new Map();
for ( let v = 0; v < d.nv; v ++ ) {

	const r = dsu.find( v );
	vertsPerIsland.set( r, ( vertsPerIsland.get( r ) || 0 ) + 1 );

}

for ( let m = 0; m < mats.length; m ++ ) {

	const s = stat[ m ];
	const isl = [ ...islandMat.entries() ].filter( ( [ , e ] ) => e.mats.has( m ) );
	const hist = new Map();
	let contiguous = 0;
	for ( const [ r, e ] of isl ) {

		const key = `${vertsPerIsland.get( r )}v/${e.polys}p/${e.tris}t`;
		hist.set( key, ( hist.get( key ) || 0 ) + 1 );
		if ( e.lastPoly - e.firstPoly + 1 === e.polys ) contiguous ++;

	}

	const top = [ ...hist.entries() ].sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).slice( 0, 24 ).map( ( [ k, n ] ) => `${k}x${n}` ).join( ' ' );
	console.log( `  mat[${m}] ${mats[ m ]}: polys=${s.polys} tris=${s.tris} islands=${isl.length} (poly-contiguous ${contiguous}) bbox=[${s.min.map( ( x ) => x.toFixed( 2 ) )}]..[${s.max.map( ( x ) => x.toFixed( 2 ) )}] uv=[${s.uvmin.map( ( x ) => x.toFixed( 3 ) )}]..[${s.uvmax.map( ( x ) => x.toFixed( 3 ) )}]` );
	console.log( `       island kinds (${hist.size}): ${top}` );

}

// prototype matching by corner-UV sequence
if ( protoRe ) {

	const re = new RegExp( protoRe );
	const names = readdirSync( join( SRC, '_dump', id ) ).filter( ( f ) => f.endsWith( '.json' ) ).map( ( f ) => f.slice( 0, - 5 ) ).filter( ( n ) => re.test( n ) );
	// index: quantised first-corner uv -> list of corner indices that start a polygon
	const key = ( u, v ) => Math.round( u * 65536 ) * 131072 + Math.round( v * 65536 );
	const startIndex = new Map();
	for ( let p = 0; p < d.np; p ++ ) {

		const c = d.polyStart[ p ];
		const k = key( d.uv[ c * 2 ], d.uv[ c * 2 + 1 ] );
		let l = startIndex.get( k );
		if ( ! l ) startIndex.set( k, l = [] );
		l.push( c );

	}

	const covered = new Uint8Array( d.nc );
	for ( const n of names ) {

		const pr = loadDump( id, n );
		const c0 = pr.polyStart[ 0 ];
		const cands = startIndex.get( key( pr.uv[ c0 * 2 ], pr.uv[ c0 * 2 + 1 ] ) ) || [];
		let full = 0, partial = 0;
		for ( const c of cands ) {

			let ok = 0;
			for ( let i = 0; i < pr.nc && c + i < d.nc; i ++ ) {

				if ( Math.abs( d.uv[ ( c + i ) * 2 ] - pr.uv[ i * 2 ] ) < 2e-5 && Math.abs( d.uv[ ( c + i ) * 2 + 1 ] - pr.uv[ i * 2 + 1 ] ) < 2e-5 ) ok ++;
				else break;

			}

			if ( ok === pr.nc ) {

				full ++;
				for ( let i = 0; i < pr.nc; i ++ ) covered[ c + i ] = 1;

			} else if ( ok > 3 ) partial ++;

		}

		console.log( `  proto ${n}: corners=${pr.nc} polys=${pr.np} tris=${pr.meta.triangles} candidates=${cands.length} fullSequenceMatches=${full} partial=${partial}` );

	}

	const twigMat = mats.findIndex( ( m ) => m && /twig|leaves/.test( m ) );
	let tot = 0, cov = 0;
	for ( let p = 0; p < d.np; p ++ ) if ( d.polyMat[ p ] === twigMat ) for ( let c = d.polyStart[ p ]; c < d.polyStart[ p ] + d.polyCount[ p ]; c ++ ) {

		tot ++;
		cov += covered[ c ];

	}

	console.log( `  twig corners covered by exact prototype sequences: ${cov}/${tot} (${( 100 * cov / tot ).toFixed( 1 )}%)` );

}
