#!/usr/bin/env node
// Texture stretch statistics per node: ratio of UV-space area to 3D area per triangle, relative to the node median.
//   node tools/assets/rocks-stretch.mjs <gltf|glb> [nodeNameSubstring]
import { makeIO, extractNodeGeometry } from './rocks-lib.mjs';
const io = await makeIO();
const [ file, sub ] = process.argv.slice( 2 );
const doc = await io.read( file );
for ( const node of doc.getRoot().listNodes() ) {

	if ( ! node.getMesh() || ( sub && ! node.getName().includes( sub ) ) ) continue;
	const { position: p, uv, index } = extractNodeGeometry( node );
	const ratios = [];
	let area3 = 0, zeroUv = 0, flipped = 0, pos = 0, neg = 0;
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ], b = index[ t + 1 ], c = index[ t + 2 ];
		const ux = p[ b * 3 ] - p[ a * 3 ], uy = p[ b * 3 + 1 ] - p[ a * 3 + 1 ], uz = p[ b * 3 + 2 ] - p[ a * 3 + 2 ];
		const vx = p[ c * 3 ] - p[ a * 3 ], vy = p[ c * 3 + 1 ] - p[ a * 3 + 1 ], vz = p[ c * 3 + 2 ] - p[ a * 3 + 2 ];
		const A = 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );
		const s = 0.5 * ( ( uv[ b * 2 ] - uv[ a * 2 ] ) * ( uv[ c * 2 + 1 ] - uv[ a * 2 + 1 ] ) - ( uv[ c * 2 ] - uv[ a * 2 ] ) * ( uv[ b * 2 + 1 ] - uv[ a * 2 + 1 ] ) );
		if ( s > 0 ) pos ++; else if ( s < 0 ) neg ++;
		area3 += A;
		if ( A <= 0 ) continue;
		if ( Math.abs( s ) < 1e-12 ) { zeroUv += A; continue; }
		ratios.push( [ Math.abs( s ) / A, A ] );

	}

	ratios.sort( ( x, y ) => x[ 0 ] - y[ 0 ] );
	const med = ratios[ ratios.length >> 1 ][ 0 ];
	let lowA = 0, highA = 0, veryLowA = 0;
	for ( const [ r, A ] of ratios ) { if ( r < med / 4 ) lowA += A; if ( r < med / 16 ) veryLowA += A; if ( r > med * 4 ) highA += A; }
	console.log( `${node.getName()}: tris ${index.length / 3}, uv winding +${pos}/-${neg}, area with zero uv area ${( zeroUv / area3 * 100 ).toFixed( 2 )}%, texel density < 1/4 median ${( lowA / area3 * 100 ).toFixed( 2 )}% (< 1/16: ${( veryLowA / area3 * 100 ).toFixed( 2 )}%), > 4x median ${( highA / area3 * 100 ).toFixed( 2 )}%` );

}
