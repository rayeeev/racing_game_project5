// Diagnostic: how many triangles of each mesh are exact back-facing duplicates of another triangle (double-layered surfaces)?
// usage: node tools/assets/car-probe-dup.mjs <file.glb>
import { makeIO, worldMatrix, readPrimitiveWorld } from './car-lib.mjs';
const io = await makeIO();
const doc = await io.read( process.argv[ 2 ] );
let tot = 0, totPaired = 0, totSame = 0;
for ( const node of doc.getRoot().listNodes() ) {
	if ( ! node.getMesh() ) continue;
	for ( const prim of node.getMesh().listPrimitives() ) {
		const g = readPrimitiveWorld( prim, worldMatrix( node ) );
		const key = new Map(); const weld = new Uint32Array( g.positions.length / 3 ); let nW = 0;
		for ( let i = 0; i < weld.length; i ++ ) { const k = Math.round( g.positions[ i * 3 ] * 2e4 ) + ',' + Math.round( g.positions[ i * 3 + 1 ] * 2e4 ) + ',' + Math.round( g.positions[ i * 3 + 2 ] * 2e4 ); let w = key.get( k ); if ( w === undefined ) { w = nW ++; key.set( k, w ); } weld[ i ] = w; }
		const tris = new Map(); let paired = 0, same = 0, degenerate = 0;
		for ( let t = 0; t < g.indices.length; t += 3 ) {
			const a = weld[ g.indices[ t ] ], b = weld[ g.indices[ t + 1 ] ], c = weld[ g.indices[ t + 2 ] ];
			if ( a === b || b === c || a === c ) { degenerate ++; continue; }
			const s = [ a, b, c ].sort( ( x, y ) => x - y );
			// orientation parity relative to sorted order
			const parity = ( ( a === s[ 0 ] && b === s[ 1 ] ) || ( b === s[ 0 ] && c === s[ 1 ] ) || ( c === s[ 0 ] && a === s[ 1 ] ) ) ? 1 : - 1;
			const k = s.join( '_' );
			const e = tris.get( k );
			if ( e === undefined ) tris.set( k, parity ); else if ( e === - parity ) { paired ++; tris.set( k, 0 ); } else if ( e === parity ) same ++;
		}
		const n = g.indices.length / 3;
		tot += n; totPaired += paired * 2; totSame += same;
		console.log( `${( node.getParentNode()?.getName() + '/' + node.getName() ).padEnd( 40 )} tris ${String( n ).padStart( 6 )}  back-face pairs ${String( paired ).padStart( 6 )} (${( 200 * paired / n ).toFixed( 0 ).padStart( 3 )}% of tris)  same-dir dups ${same}  degenerate ${degenerate}` );
	}
}
console.log( 'TOTAL tris', tot, 'in back-face pairs', totPaired, 'same-direction duplicates', totSame );
