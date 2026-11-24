#!/usr/bin/env node
// Forest-floor debris (fallen branches, bark flakes): photoscanned opaque meshes, simplified with meshopt to
// LOD0 <= 800 / LOD1 <= 150 triangles; the source textures are only resized (1024, WebP).
//   node tools/assets/plants-build-debris.mjs [id ...] [--debug <dir>]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import { SRC, OUT, loadSoup, mergeMeshes, boundsOf, loadRGB, encodeTextures, writeGLB, measure, hex, round, v3, SRGB2LIN } from './plants-lib.mjs';

const argv = process.argv.slice( 2 );
const debugDir = argv.includes( '--debug' ) ? argv[ argv.indexOf( '--debug' ) + 1 ] : null;
if ( debugDir ) mkdirSync( debugDir, { recursive: true } );
const only = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && argv[ i - 1 ] !== '--debug' );

const ASSETS = [
	{
		id: 'dry_branches_medium_01', author: 'Rico Cilliers (Poly Haven)', atlas: 1024, doubleSided: false, targets: [ 800, 150 ],
		variants: [
			{ src: 'dry_branches_medium_01_a', name: 'branch_forked', notes: 'weathered fallen branch with side twigs, 1.3 m' },
			{ src: 'dry_branches_medium_01_b', name: 'branch_long', notes: 'weathered fallen branch, 1.0 m' },
			{ src: 'dry_branches_medium_01_c', name: 'branch_short', notes: 'weathered fallen branch, 0.8 m' },
		],
	},
	{
		id: 'bark_debris_01', author: 'Greg Zaal, Jenelle van Heerden (Poly Haven)', atlas: 1024, doubleSided: true, targets: [ 800, 150 ],
		variants: [
			{ src: 'bark_debris_01_b', name: 'bark_slab_a', notes: 'shed bark slab, 0.47 m' },
			{ src: 'bark_debris_01_d', name: 'bark_slab_b', notes: 'shed bark slab, 0.6 m, narrow' },
		],
	},
];

function compact( m, idx ) {

	const map = new Int32Array( m.pos.length / 3 ).fill( - 1 );
	const pos = [], nrm = [], uv = [], out = new Uint32Array( idx.length );
	for ( let i = 0; i < idx.length; i ++ ) {

		const v = idx[ i ];
		if ( map[ v ] < 0 ) {

			map[ v ] = pos.length / 3;
			pos.push( m.pos[ v * 3 ], m.pos[ v * 3 + 1 ], m.pos[ v * 3 + 2 ] );
			nrm.push( m.nrm[ v * 3 ], m.nrm[ v * 3 + 1 ], m.nrm[ v * 3 + 2 ] );
			uv.push( m.uv[ v * 2 ], m.uv[ v * 2 + 1 ] );

		}

		out[ i ] = map[ v ];

	}

	return { material: 0, pos: Float32Array.from( pos ), nrm: Float32Array.from( nrm ), uv: Float32Array.from( uv ), idx: out };

}

async function build( A ) {

	const dir = join( SRC, A.id ), S = A.atlas;
	const diff = await loadRGB( join( dir, 'textures', `${A.id}_diff_2k.jpg` ), S );
	const nor = await loadRGB( join( dir, 'textures', `${A.id}_nor_gl_2k.jpg` ), S );
	const arm = await loadRGB( join( dir, 'textures', `${A.id}_arm_2k.jpg` ), S );
	const base = Buffer.alloc( S * S * 4, 255 );
	for ( let k = 0; k < S * S; k ++ ) {

		base[ k * 4 ] = diff.data[ k * 3 ]; base[ k * 4 + 1 ] = diff.data[ k * 3 + 1 ]; base[ k * 4 + 2 ] = diff.data[ k * 3 + 2 ];

	}

	const orm = Buffer.from( arm.data );
	for ( let k = 0; k < S * S; k ++ ) orm[ k * 3 + 2 ] = 0;
	const images = await encodeTextures( { base, nor: Buffer.from( nor.data ), orm, w: S, h: S }, { quality: 90, opaque: true, debugDir, name: A.id } );
	const nodes = await loadSoup( join( dir, `${A.id}_2k.gltf` ) );
	const outVariants = [], meta = [];
	for ( const v of A.variants ) {

		const node = nodes.find( ( n ) => n.name === v.src );
		if ( ! node ) throw new Error( `${A.id}: node ${v.src} not found (have ${nodes.map( ( n ) => n.name ).join( ', ' )})` );
		const mesh = mergeMeshes( node.prims );
		// pivot: bottom centre
		const b = boundsOf( mesh );
		const cx = ( b.min[ 0 ] + b.max[ 0 ] ) / 2, cz = ( b.min[ 2 ] + b.max[ 2 ] ) / 2;
		for ( let i = 0; i < mesh.pos.length; i += 3 ) {

			mesh.pos[ i ] -= cx; mesh.pos[ i + 1 ] -= b.min[ 1 ]; mesh.pos[ i + 2 ] -= cz;

		}

		const lods = A.targets.map( ( target ) => {

			let idx = MeshoptSimplifier.simplify( mesh.idx, mesh.pos, 3, target * 3, 0.05 )[ 0 ];
			let mode = 'simplify';
			if ( idx.length / 3 > target ) {

				// attribute seams of the photoscan atlas stop the regular simplifier: allow more error, then go sloppy
				idx = MeshoptSimplifier.simplify( mesh.idx, mesh.pos, 3, target * 3, 1.0 )[ 0 ];
				if ( idx.length / 3 > target && MeshoptSimplifier.simplifySloppy ) {

					idx = MeshoptSimplifier.simplifySloppy( mesh.idx, mesh.pos, 3, target * 3, 1.0 )[ 0 ];
					mode = 'sloppy';

				}

			}

			const out = compact( mesh, idx );
			out.mode = mode;
			return out;

		} );
		// LOD nodes must rest on y = 0 as well
		for ( const l of lods ) {

			let y0 = Infinity;
			for ( let i = 1; i < l.pos.length; i += 3 ) y0 = Math.min( y0, l.pos[ i ] );
			for ( let i = 1; i < l.pos.length; i += 3 ) l.pos[ i ] -= y0;

		}

		outVariants.push( { name: v.name, lods: lods.map( ( l ) => [ l ] ) } );
		const m = measure( [ lods[ 0 ] ] );
		// average albedo over the surface (area weighted uv sampling)
		const acc = [ 0, 0, 0, 0 ], L = lods[ 0 ];
		for ( let t = 0; t < L.idx.length; t += 3 ) {

			const ia = L.idx[ t ], ib = L.idx[ t + 1 ], ic = L.idx[ t + 2 ];
			const e1 = [ L.pos[ ib * 3 ] - L.pos[ ia * 3 ], L.pos[ ib * 3 + 1 ] - L.pos[ ia * 3 + 1 ], L.pos[ ib * 3 + 2 ] - L.pos[ ia * 3 + 2 ] ];
			const e2 = [ L.pos[ ic * 3 ] - L.pos[ ia * 3 ], L.pos[ ic * 3 + 1 ] - L.pos[ ia * 3 + 1 ], L.pos[ ic * 3 + 2 ] - L.pos[ ia * 3 + 2 ] ];
			const area = v3.len( v3.cross( e1, e2 ) ) * 0.5;
			const uu = ( L.uv[ ia * 2 ] + L.uv[ ib * 2 ] + L.uv[ ic * 2 ] ) / 3, vv = ( L.uv[ ia * 2 + 1 ] + L.uv[ ib * 2 + 1 ] + L.uv[ ic * 2 + 1 ] ) / 3;
			const k = Math.min( S - 1, Math.max( 0, Math.floor( ( vv - Math.floor( vv ) ) * S ) ) ) * S + Math.min( S - 1, Math.max( 0, Math.floor( ( uu - Math.floor( uu ) ) * S ) ) );
			acc[ 0 ] += SRGB2LIN[ diff.data[ k * 3 ] ] * area; acc[ 1 ] += SRGB2LIN[ diff.data[ k * 3 + 1 ] ] * area; acc[ 2 ] += SRGB2LIN[ diff.data[ k * 3 + 2 ] ] * area; acc[ 3 ] += area;

		}

		const col = hex( acc.slice( 0, 3 ).map( ( x ) => x / acc[ 3 ] ) );
		meta.push( {
			name: v.name, size: m.size.map( ( x ) => round( x ) ), radius: round( m.radius ), height: round( m.height ),
			lods: lods.map( ( l, i ) => ( { node: `${v.name}_LOD${i}`, triangles: l.idx.length / 3 } ) ),
			avgColor: col, colorRoot: col, colorTip: col, windAmplitude: 0, collider: { type: 'none' }, sink: 0.015, notes: v.notes,
		} );
		console.log( `  ${v.name}: tris ${lods.map( ( l ) => `${l.idx.length / 3} (${l.mode})` ).join( ' / ' )} (source ${mesh.idx.length / 3}), size ${m.size.map( ( x ) => x.toFixed( 2 ) ).join( 'x' )}` );

	}

	mkdirSync( OUT, { recursive: true } );
	const file = join( OUT, `${A.id}.glb` );
	await writeGLB( file, {
		materials: [ { name: A.id, base: images.base, normal: images.nor, orm: images.orm, alphaMode: 'OPAQUE', doubleSided: A.doubleSided, roughness: 1, metallic: 0 } ],
		variants: outVariants,
	} );
	mkdirSync( join( SRC, '_build' ), { recursive: true } );
	writeFileSync( join( SRC, '_build', `${A.id}.json` ), JSON.stringify( {
		id: A.id, file: `/assets/plants/${A.id}.glb`, source: `https://polyhaven.com/a/${A.id}`, author: A.author, license: 'CC0',
		textureResolution: S, bytes: statSync( file ).size, category: 'debris', variants: meta,
	}, null, 1 ) );
	console.log( `  wrote ${file} ${( statSync( file ).size / 1024 ).toFixed( 0 )} KB` );

}

await MeshoptSimplifier.ready;
for ( const A of ASSETS ) {

	if ( only.length && ! only.includes( A.id ) ) continue;
	if ( ! existsSync( join( SRC, A.id ) ) ) continue;
	console.log( A.id );
	await build( A );

}
