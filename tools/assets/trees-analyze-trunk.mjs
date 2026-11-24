#!/usr/bin/env node
// Exploratory: how does the scan/bark blend mask ("Col") and the UV layout of a dumped trunk vary with height?
//   node tools/assets/trees-analyze-trunk.mjs <id> <object>
import { loadDump } from './trees-lib.mjs';
const [ id, name ] = process.argv.slice( 2 );
const d = loadDump( id, name );
console.log( name, 'verts', d.nv, 'polys', d.np, 'hasColor', d.meta.hasColor, 'materials', d.meta.materials );
const bins = new Map();
for ( let p = 0; p < d.np; p ++ ) for ( let c = d.polyStart[ p ]; c < d.polyStart[ p ] + d.polyCount[ p ]; c ++ ) {

	const v = d.cornerVert[ c ];
	const y = d.position[ v * 3 + 1 ];
	const r = Math.hypot( d.position[ v * 3 ], d.position[ v * 3 + 2 ] );
	const b = y < 4 ? Math.floor( y * 4 ) / 4 : Math.floor( y );
	let e = bins.get( b );
	if ( ! e ) bins.set( b, e = { n: 0, col: 0, cmin: 9, cmax: - 9, r: 0, rmax: 0, umin: 9, umax: - 9, vmin: 9, vmax: - 9 } );
	e.n ++;
	if ( d.color ) {

		const cc = d.color[ c * 4 ];
		e.col += cc;
		e.cmin = Math.min( e.cmin, cc );
		e.cmax = Math.max( e.cmax, cc );

	}

	e.r += r;
	e.rmax = Math.max( e.rmax, r );
	e.umin = Math.min( e.umin, d.uv[ c * 2 ] );
	e.umax = Math.max( e.umax, d.uv[ c * 2 ] );
	e.vmin = Math.min( e.vmin, d.uv[ c * 2 + 1 ] );
	e.vmax = Math.max( e.vmax, d.uv[ c * 2 + 1 ] );

}

for ( const b of [ ...bins.keys() ].sort( ( a, c ) => a - c ) ) {

	const e = bins.get( b );
	console.log( `y>=${b.toFixed( 2 ).padStart( 6 )} corners=${String( e.n ).padStart( 6 )} Col mean=${( e.col / e.n ).toFixed( 3 )} [${e.cmin.toFixed( 2 )}..${e.cmax.toFixed( 2 )}] radius mean=${( e.r / e.n ).toFixed( 3 )} max=${e.rmax.toFixed( 3 )} u=[${e.umin.toFixed( 3 )}..${e.umax.toFixed( 3 )}] v=[${e.vmin.toFixed( 3 )}..${e.vmax.toFixed( 3 )}]` );

}
