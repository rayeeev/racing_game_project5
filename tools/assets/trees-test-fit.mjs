#!/usr/bin/env node
// Exploratory: how well do simple bent grids approximate the artist's cut-out twig cards?
import { loadDump } from './trees-lib.mjs';
import { fitSurface } from './trees-geom.mjs';
const [ id, ...names ] = process.argv.slice( 2 );
for ( const name of names ) {

	const d = loadDump( id, name );
	let u0 = Infinity, u1 = - Infinity, v0 = Infinity, v1 = - Infinity;
	for ( let c = 0; c < d.nc; c ++ ) {

		u0 = Math.min( u0, d.uv[ c * 2 ] );
		u1 = Math.max( u1, d.uv[ c * 2 ] );
		v0 = Math.min( v0, d.uv[ c * 2 + 1 ] );
		v1 = Math.max( v1, d.uv[ c * 2 + 1 ] );

	}

	const samples = [];
	const seen = new Set();
	for ( let c = 0; c < d.nc; c ++ ) {

		const v = d.cornerVert[ c ];
		if ( seen.has( v ) ) continue;
		seen.add( v );
		samples.push( { uv: [ ( d.uv[ c * 2 ] - u0 ) / ( u1 - u0 ) * 2 - 1, ( d.uv[ c * 2 + 1 ] - v0 ) / ( v1 - v0 ) * 2 - 1 ], p: [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ] } );

	}

	const min = [ 1e9, 1e9, 1e9 ], max = [ - 1e9, - 1e9, - 1e9 ];
	for ( const s of samples ) for ( let k = 0; k < 3; k ++ ) {

		min[ k ] = Math.min( min[ k ], s.p[ k ] );
		max[ k ] = Math.max( max[ k ], s.p[ k ] );

	}

	const rms = ( fit ) => Math.sqrt( samples.reduce( ( a, s ) => {

		const p = fit.evalP( s.uv[ 0 ], s.uv[ 1 ] );
		return a + ( p[ 0 ] - s.p[ 0 ] ) ** 2 + ( p[ 1 ] - s.p[ 1 ] ) ** 2 + ( p[ 2 ] - s.p[ 2 ] ) ** 2;

	}, 0 ) / samples.length );
	const f1 = fitSurface( samples, false ), f2 = fitSurface( samples, true );
	// corners of the fitted surface
	const corners = [ [ - 1, - 1 ], [ 1, - 1 ], [ - 1, 1 ], [ 1, 1 ], [ 0, - 1 ], [ 0, 0 ], [ 0, 1 ], [ - 1, 0 ], [ 1, 0 ] ].map( ( [ a, b ] ) => f2.evalP( a, b ).map( ( x ) => x.toFixed( 2 ) ).join( ',' ) );
	console.log( `${name}: verts=${samples.length} bbox size=[${max.map( ( x, k ) => ( x - min[ k ] ).toFixed( 2 ) )}] y range ${min[ 1 ].toFixed( 2 )}..${max[ 1 ].toFixed( 2 )} uvAspect w/h=${( ( u1 - u0 ) / ( v1 - v0 ) ).toFixed( 2 )} rms[1,u,v,v2]=${rms( f1 ).toFixed( 3 )} rms[+u2]=${rms( f2 ).toFixed( 3 )}` );
	console.log( `     fitted(+u2) corners BL,BR,TL,TR: ${corners.slice( 0, 4 ).join( ' | ' )}  mid col B,C,T: ${corners.slice( 4, 7 ).join( ' | ' )}  mid row L,R: ${corners.slice( 7 ).join( ' | ' )}` );

}
