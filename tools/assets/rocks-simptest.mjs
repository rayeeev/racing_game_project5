#!/usr/bin/env node
// Experiment: how far does seam-respecting meshopt simplification get for a node, with different options?
//   node tools/assets/rocks-simptest.mjs <gltf> <nodeName|*> <target1,target2,...>
import { MeshoptSimplifier } from 'meshoptimizer';
import { makeIO, extractNodeGeometry, weldGeometry } from './rocks-lib.mjs';

const [ file, nodeName, targetsS ] = process.argv.slice( 2 );
const io = await makeIO();
const doc = await io.read( file );
const targets = targetsS.split( ',' ).map( Number );

for ( const node of doc.getRoot().listNodes() ) {

	if ( ! node.getMesh() || ( nodeName !== '*' && node.getName() !== nodeName ) ) continue;
	const geo = weldGeometry( extractNodeGeometry( node ) );
	const nV = geo.position.length / 3;
	const scale = MeshoptSimplifier.getScale( geo.position, 3 );
	console.log( `\n${node.getName()}: welded verts ${nV} tris ${geo.index.length / 3} scale ${scale.toFixed( 3 )} m` );
	// attributes: normal (3) + uv (2)
	const attrs = new Float32Array( nV * 5 );
	for ( let i = 0; i < nV; i ++ ) {

		attrs[ i * 5 ] = geo.normal[ i * 3 ]; attrs[ i * 5 + 1 ] = geo.normal[ i * 3 + 1 ]; attrs[ i * 5 + 2 ] = geo.normal[ i * 3 + 2 ];
		attrs[ i * 5 + 3 ] = geo.uv[ i * 2 ]; attrs[ i * 5 + 4 ] = geo.uv[ i * 2 + 1 ];

	}

	for ( const target of targets ) {

		const rows = [];
		const run = ( label, fn ) => {

			const t0 = performance.now();
			const [ idx, err ] = fn();
			rows.push( `${label}: ${idx.length / 3} tris, err ${( err * scale * 1000 ).toFixed( 1 )} mm (${( err * 100 ).toFixed( 2 )}%), ${( performance.now() - t0 ).toFixed( 0 )} ms` );

		};

		run( 'pos-only      ', () => MeshoptSimplifier.simplify( geo.index, geo.position, 3, target * 3, 1.0 ) );
		run( 'attr n.5 uv0  ', () => MeshoptSimplifier.simplifyWithAttributes( geo.index, geo.position, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0, 0 ], null, target * 3, 1.0 ) );
		run( 'attr n.5 uv1  ', () => MeshoptSimplifier.simplifyWithAttributes( geo.index, geo.position, 3, attrs, 5, [ 0.5, 0.5, 0.5, 1, 1 ], null, target * 3, 1.0 ) );
		run( 'attr n.5 +prune', () => MeshoptSimplifier.simplifyWithAttributes( geo.index, geo.position, 3, attrs, 5, [ 0.5, 0.5, 0.5, 0, 0 ], null, target * 3, 1.0, [ 'Prune' ] ) );
		run( 'permissive    ', () => MeshoptSimplifier.simplifyWithAttributes( geo.index, geo.position, 3, attrs, 5, [ 0.5, 0.5, 0.5, 1, 1 ], null, target * 3, 1.0, [ 'Permissive' ] ) );
		run( 'sloppy        ', () => MeshoptSimplifier.simplifySloppy( geo.index, geo.position, 3, null, target * 3, 1.0 ) );
		console.log( ` target ${target}:\n   ` + rows.join( '\n   ' ) );

	}

}
