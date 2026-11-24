#!/usr/bin/env node
// Build leafy plants whose source is already made of alpha-textured leaf / frond strips (ferns, broad-leaf herbs):
// every source island (one frond or leaf) is RE-GRIDDED in its own UV space: a coarse (nu x nv) quad grid over the island's
// UV rectangle whose vertices are sampled from the original surface. The original element atlas (and therefore the full
// photoscan texel density) is kept, only resized; the leaf keeps its 3D arc.
//   node tools/assets/plants-build-regrid.mjs [id ...] [--debug <dir>]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import {
	SRC, OUT, loadSoup, mergeMeshes, islandsOf, subMesh, placeMesh, boundsOf, loadRGB, loadGray, encodeTextures, writeGLB, MeshBuilder, measure, hex, round, v3, SRGB2LIN,
} from './plants-lib.mjs';

const argv = process.argv.slice( 2 );
const debugDir = argv.includes( '--debug' ) ? argv[ argv.indexOf( '--debug' ) + 1 ] : null;
if ( debugDir ) mkdirSync( debugDir, { recursive: true } );
const only = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && argv[ i - 1 ] !== '--debug' );

const ASSETS = [
	{
		id: 'fern_02', category: 'fern', author: 'Rob Tuytel, Rico Cilliers (Poly Haven)', atlas: 1024, alpha: 'alpha',
		variants: [
			{ src: 'fern_02_b', name: 'fern_large', lod0: { nu: 2, nv: 7 }, lod1: { nu: 1, nv: 3 }, windAmplitude: 0.05, notes: 'large fern, 20 arching fronds; conifer forest floor, shady banks' },
			{ src: 'fern_02_a', name: 'fern_small_a', lod0: { nu: 2, nv: 10 }, lod1: { nu: 2, nv: 4 }, windAmplitude: 0.04, notes: 'small fern, 7 fronds' },
			{ src: 'fern_02_d', name: 'fern_small_b', lod0: { nu: 2, nv: 10 }, lod1: { nu: 2, nv: 4 }, windAmplitude: 0.04, notes: 'small flat fern, 7 fronds' },
		],
		upBlend: 0.6,
	},
	{
		id: 'weed_plant_02', category: 'forest', author: 'Rob Tuytel, Rico Cilliers (Poly Haven)', atlas: 1024, alpha: 'alpha', scale: 1.5,
		variants: [
			{ src: 'weed_plant_02_a_LOD0', name: 'dock_a', lod0: { nu: 4, nv: 8 }, lod1: { nu: 2, nv: 3 }, windAmplitude: 0.02, notes: 'broad-leaf dock rosette (8 leaves); damp meadow, ditch, forest edge' },
			{ src: 'weed_plant_02_b_LOD0', name: 'dock_b', lod0: { nu: 4, nv: 8 }, lod1: { nu: 2, nv: 3 }, windAmplitude: 0.02, notes: 'broad-leaf dock rosette (6 leaves)' },
		],
		upBlend: 0.5,
	},
	{
		// willow-like shoots: big single leaves on real (tube) stems -> leaves re-gridded, stems simplified with meshopt
		id: 'shrub_02', category: 'shrub', author: 'Rico Cilliers (Poly Haven)', atlas: 1024, alpha: 'alpha',
		stemMinTris: 100, outBlend: 0.7,
		variants: [
			{ src: 'shrub_02_a', name: 'willow_a', windAmplitude: 0.12, notes: 'loose willow-like shrub, long grey-green leaves on reddish shoots; stream banks, damp meadow edges' },
			{ src: 'shrub_02_b', name: 'willow_b', windAmplitude: 0.11, notes: 'as willow_a, narrower' },
			{ src: 'shrub_02_c', name: 'willow_c', windAmplitude: 0.1, notes: 'as willow_a, wide and low' },
			{ src: 'shrub_02_d', name: 'willow_d', windAmplitude: 0.09, notes: 'as willow_a, small' },
		],
		// budgets 2500 / 500 / 80: leaves 12 / 2 / 2 tris each, the rest goes to the stems (LOD2: 38 enlarged leaves, no stems)
		lods: [ { nu: 2, nv: 3, stemTris: 1150 }, { nu: 1, nv: 1, stemTris: 215 }, { nu: 1, nv: 1, maxLeaves: 38, scale: 1.75, stemTris: 0 } ],
	},
];

// ---------------------------------------------------------------- UV-space regridding

function regridIsland( m, { nu, nv }, opts ) {

	const { pos, nrm, uv, idx } = m;
	let u0 = Infinity, u1 = - Infinity, v0 = Infinity, v1 = - Infinity;
	for ( let i = 0; i < uv.length; i += 2 ) {

		u0 = Math.min( u0, uv[ i ] ); u1 = Math.max( u1, uv[ i ] ); v0 = Math.min( v0, uv[ i + 1 ] ); v1 = Math.max( v1, uv[ i + 1 ] );

	}

	// long axis of the chart gets nv cells
	const alongV = ( v1 - v0 ) >= ( u1 - u0 );
	const cu = alongV ? nu : nv, cv = alongV ? nv : nu;
	const tc = idx.length / 3;
	/** closest point of the island (in UV space) -> interpolated position + normal */
	const sample = ( qu, qv ) => {

		let best = null, bestD = Infinity;
		for ( let t = 0; t < tc; t ++ ) {

			const a = idx[ t * 3 ], b = idx[ t * 3 + 1 ], c = idx[ t * 3 + 2 ];
			const ax = uv[ a * 2 ], ay = uv[ a * 2 + 1 ], bx = uv[ b * 2 ], by = uv[ b * 2 + 1 ], cx = uv[ c * 2 ], cy = uv[ c * 2 + 1 ];
			const d = ( bx - ax ) * ( cy - ay ) - ( cx - ax ) * ( by - ay );
			if ( Math.abs( d ) < 1e-14 ) continue;
			let w1 = ( ( qu - ax ) * ( cy - ay ) - ( cx - ax ) * ( qv - ay ) ) / d;
			let w2 = ( ( bx - ax ) * ( qv - ay ) - ( qu - ax ) * ( by - ay ) ) / d;
			let w0 = 1 - w1 - w2;
			let dist = 0;
			if ( w0 < 0 || w1 < 0 || w2 < 0 ) {

				// clamp to the triangle (simple barycentric clamp is enough for these well-shaped strips)
				w0 = Math.max( 0, w0 ); w1 = Math.max( 0, w1 ); w2 = Math.max( 0, w2 );
				const s = w0 + w1 + w2;
				w0 /= s; w1 /= s; w2 /= s;
				const px = w0 * ax + w1 * bx + w2 * cx, py = w0 * ay + w1 * by + w2 * cy;
				dist = ( px - qu ) ** 2 + ( py - qv ) ** 2;

			}

			if ( dist < bestD ) {

				bestD = dist;
				best = [ a, b, c, w0, w1, w2 ];
				if ( dist === 0 ) break;

			}

		}

		const [ a, b, c, w0, w1, w2 ] = best;
		const p = [ 0, 0, 0 ], n = [ 0, 0, 0 ];
		for ( let k = 0; k < 3; k ++ ) {

			p[ k ] = pos[ a * 3 + k ] * w0 + pos[ b * 3 + k ] * w1 + pos[ c * 3 + k ] * w2;
			n[ k ] = nrm[ a * 3 + k ] * w0 + nrm[ b * 3 + k ] * w1 + nrm[ c * 3 + k ] * w2;

		}

		return { p, n: v3.norm( n ) };

	};

	const mb = new MeshBuilder();
	const eps = 0.004;   // stay just inside the chart
	const grid = [];
	for ( let j = 0; j <= cv; j ++ ) for ( let i = 0; i <= cu; i ++ ) {

		const gu = u0 + ( u1 - u0 ) * ( eps + ( 1 - 2 * eps ) * i / cu ), gv = v0 + ( v1 - v0 ) * ( eps + ( 1 - 2 * eps ) * j / cv );
		const s = sample( gu, gv );
		grid.push( { ...s, uv: [ u0 + ( u1 - u0 ) * i / cu, v0 + ( v1 - v0 ) * j / cv ] } );

	}

	// orientation: front faces + normals look up (ground plants) or away from the bush centre (shrubs)
	const out = opts.outBlend ?? 0;
	let ref = [ 0, 1, 0 ];
	if ( out > 0 ) {

		const c = [ 0, 0, 0 ];
		for ( const g of grid ) for ( let k = 0; k < 3; k ++ ) c[ k ] += g.p[ k ] / grid.length;
		ref = v3.norm( [ c[ 0 ] - opts.centre[ 0 ], ( c[ 1 ] - opts.centre[ 1 ] ) * 0.6 + 0.35, c[ 2 ] - opts.centre[ 2 ] ] );

	}

	let sum = 0;
	for ( const g of grid ) sum += v3.dot( g.n, ref );
	const flipN = sum < 0 ? - 1 : 1;
	const up = out > 0 ? 0 : ( opts.upBlend ?? 0.5 );
	for ( const g of grid ) {

		const n = v3.norm( [ g.n[ 0 ] * flipN + ref[ 0 ] * out, g.n[ 1 ] * flipN + up + ref[ 1 ] * out, g.n[ 2 ] * flipN + ref[ 2 ] * out ] );
		g.i = mb.vert( [ g.p[ 0 ], Math.max( g.p[ 1 ], 0.002 ), g.p[ 2 ] ], n, g.uv );

	}

	// winding so that the geometric normal agrees with the (unblended) shading normal
	const g00 = grid[ 0 ], g10 = grid[ 1 ], g01 = grid[ cu + 1 ];
	const gn = v3.cross( v3.sub( g10.p, g00.p ), v3.sub( g01.p, g00.p ) );
	const ccw = v3.dot( gn, [ g00.n[ 0 ] * flipN, g00.n[ 1 ] * flipN, g00.n[ 2 ] * flipN ] ) >= 0;
	for ( let j = 0; j < cv; j ++ ) for ( let i = 0; i < cu; i ++ ) {

		const a = grid[ j * ( cu + 1 ) + i ].i, b = a + 1, d = a + cu + 1, e = d + 1;
		if ( ccw ) mb.quad( a, b, e, d ); else mb.quad( a, d, e, b );

	}

	return mb;

}

function compact( m ) {

	const map = new Int32Array( m.pos.length / 3 ).fill( - 1 );
	const pos = [], nrm = [], uv = [], idx = new Uint32Array( m.idx.length );
	for ( let i = 0; i < m.idx.length; i ++ ) {

		const v = m.idx[ i ];
		if ( map[ v ] < 0 ) {

			map[ v ] = pos.length / 3;
			pos.push( m.pos[ v * 3 ], m.pos[ v * 3 + 1 ], m.pos[ v * 3 + 2 ] );
			nrm.push( m.nrm[ v * 3 ], m.nrm[ v * 3 + 1 ], m.nrm[ v * 3 + 2 ] );
			uv.push( m.uv[ v * 2 ], m.uv[ v * 2 + 1 ] );

		}

		idx[ i ] = map[ v ];

	}

	return { material: m.material, pos: Float32Array.from( pos ), nrm: Float32Array.from( nrm ), uv: Float32Array.from( uv ), idx };

}

// ---------------------------------------------------------------- build

async function build( A ) {

	const dir = join( SRC, A.id ), maps = join( SRC, A.id + '__maps' );
	const S = A.atlas;
	// textures: straight resize of the source atlas (diffuse + alpha -> RGBA, normal, ARM == ORM)
	const diff = await loadRGB( join( dir, 'textures', `${A.id}_diff_2k.jpg` ), S );
	const alpha = await loadGray( join( maps, `${A.id}_${A.alpha}_2k.png` ), S );
	const nor = await loadRGB( join( dir, 'textures', `${A.id}_nor_gl_2k.jpg` ), S );
	const arm = await loadRGB( join( dir, 'textures', `${A.id}_arm_2k.jpg` ), S );
	const base = Buffer.alloc( S * S * 4 );
	// bleed leaf colour into the transparent area (the source diffuse is already padded, keep it), alpha as is
	for ( let k = 0; k < S * S; k ++ ) {

		base[ k * 4 ] = diff.data[ k * 3 ]; base[ k * 4 + 1 ] = diff.data[ k * 3 + 1 ]; base[ k * 4 + 2 ] = diff.data[ k * 3 + 2 ]; base[ k * 4 + 3 ] = alpha.data[ k ];

	}

	const orm = Buffer.from( arm.data );
	for ( let k = 0; k < S * S; k ++ ) orm[ k * 3 + 2 ] = 0;   // no metal
	const images = await encodeTextures( { base, nor: Buffer.from( nor.data ), orm, w: S, h: S }, { quality: 90, debugDir, name: A.id } );

	const nodes = await loadSoup( join( dir, `${A.id}_2k.gltf` ) );
	const outVariants = [], meta = [];
	for ( const v of A.variants ) {

		const node = nodes.find( ( n ) => n.name === v.src );
		if ( ! node ) throw new Error( `${A.id}: node ${v.src} not found (have ${nodes.map( ( n ) => n.name ).join( ', ' )})` );
		let mesh = mergeMeshes( node.prims );
		if ( ( v.scale ?? A.scale ?? 1 ) !== 1 ) mesh = placeMesh( mesh, { scale: v.scale ?? A.scale } );
		const all = islandsOf( mesh ).map( ( tris ) => subMesh( mesh, tris ) ).filter( ( m ) => m.idx.length / 3 >= ( A.minIslandTris ?? 8 ) );
		const stemMin = A.stemMinTris ?? Infinity;
		const islands = all.filter( ( m ) => m.idx.length / 3 < stemMin ), stems = all.filter( ( m ) => m.idx.length / 3 >= stemMin );
		const bb = boundsOf( mesh );
		const centre = [ 0, bb.max[ 1 ] * 0.55, 0 ];
		const cfgs = A.lods || [ v.lod0, v.lod1 ];
		const lods = cfgs.map( ( cfg ) => {

			const mb = new MeshBuilder();
			const keepEvery = cfg.maxLeaves ? Math.max( 1, Math.ceil( islands.length / cfg.maxLeaves ) ) : 1;
			islands.forEach( ( isl, k ) => {

				if ( k % keepEvery !== 0 ) return;
				const g = regridIsland( isl, cfg, { ...A, centre } ).build();
				if ( cfg.scale && cfg.scale !== 1 ) {

					// fewer, larger leaves: scale about the leaf centre
					const c = [ 0, 0, 0 ], n = g.pos.length / 3;
					for ( let i = 0; i < g.pos.length; i ++ ) c[ i % 3 ] += g.pos[ i ] / n;
					for ( let i = 0; i < g.pos.length; i ++ ) g.pos[ i ] = c[ i % 3 ] + ( g.pos[ i ] - c[ i % 3 ] ) * cfg.scale;

				}

				mb.append( g );

			} );
			if ( ( cfg.stemTris ?? 0 ) > 0 ) {

				const total = stems.reduce( ( n, st ) => n + st.idx.length / 3, 0 );
				for ( const st of stems ) {

					// share the stem budget in proportion to the source triangle counts
					const target = Math.max( 4, Math.floor( cfg.stemTris * ( st.idx.length / 3 ) / total ) ) * 3;
					const idx = target >= st.idx.length ? st.idx : MeshoptSimplifier.simplify( st.idx, st.pos, 3, target, 0.2 )[ 0 ];
					mb.append( { pos: st.pos, nrm: st.nrm, uv: st.uv, idx } );

				}

			}

			const built = mb.build( 0 );
			return compact( built );

		} );
		// pivot convention: min y = 0
		const y0 = measure( [ lods[ 0 ] ] ).min[ 1 ];
		for ( const l of lods ) for ( let i = 1; i < l.pos.length; i += 3 ) l.pos[ i ] = Math.max( 0, l.pos[ i ] - y0 );
		outVariants.push( { name: v.name, lods: lods.map( ( l ) => [ l ] ) } );
		const m = measure( [ lods[ 0 ] ] );
		// colour statistics: sample the atlas at the LOD0 vertices' uv footprint (area weighted over triangles, alpha weighted)
		const acc = { all: [ 0, 0, 0, 0 ], root: [ 0, 0, 0, 0 ], tip: [ 0, 0, 0, 0 ] };
		const L = lods[ 0 ];
		for ( let t = 0; t < L.idx.length; t += 3 ) {

			const ia = L.idx[ t ], ib = L.idx[ t + 1 ], ic = L.idx[ t + 2 ];
			const e1 = [ L.pos[ ib * 3 ] - L.pos[ ia * 3 ], L.pos[ ib * 3 + 1 ] - L.pos[ ia * 3 + 1 ], L.pos[ ib * 3 + 2 ] - L.pos[ ia * 3 + 2 ] ];
			const e2 = [ L.pos[ ic * 3 ] - L.pos[ ia * 3 ], L.pos[ ic * 3 + 1 ] - L.pos[ ia * 3 + 1 ], L.pos[ ic * 3 + 2 ] - L.pos[ ia * 3 + 2 ] ];
			const triArea = v3.len( v3.cross( e1, e2 ) ) * 0.5;
			for ( let s = 0; s < 24; s ++ ) {

				let r1 = ( s * 0.618034 ) % 1, r2 = ( s * 0.381966 + 0.13 ) % 1;
				if ( r1 + r2 > 1 ) {

					r1 = 1 - r1; r2 = 1 - r2;

				}

				const w0 = 1 - r1 - r2;
				const uu = L.uv[ ia * 2 ] * w0 + L.uv[ ib * 2 ] * r1 + L.uv[ ic * 2 ] * r2, vv = L.uv[ ia * 2 + 1 ] * w0 + L.uv[ ib * 2 + 1 ] * r1 + L.uv[ ic * 2 + 1 ] * r2;
				const y = L.pos[ ia * 3 + 1 ] * w0 + L.pos[ ib * 3 + 1 ] * r1 + L.pos[ ic * 3 + 1 ] * r2;
				const px = Math.min( S - 1, Math.max( 0, Math.floor( uu * S ) ) ), py = Math.min( S - 1, Math.max( 0, Math.floor( vv * S ) ) );
				const k = py * S + px, a = alpha.data[ k ] / 255;
				if ( a < 0.5 ) continue;
				const tt = y / m.height;
				for ( const [ key, on ] of [ [ 'all', true ], [ 'root', tt < 0.3 ], [ 'tip', tt > 0.6 ] ] ) if ( on ) {

					acc[ key ][ 0 ] += SRGB2LIN[ diff.data[ k * 3 ] ] * triArea; acc[ key ][ 1 ] += SRGB2LIN[ diff.data[ k * 3 + 1 ] ] * triArea; acc[ key ][ 2 ] += SRGB2LIN[ diff.data[ k * 3 + 2 ] ] * triArea; acc[ key ][ 3 ] += triArea;

				}

			}

		}

		const col = ( k ) => hex( ( acc[ k ][ 3 ] > 0 ? acc[ k ] : acc.all ).slice( 0, 3 ).map( ( x ) => x / ( acc[ k ][ 3 ] > 0 ? acc[ k ][ 3 ] : acc.all[ 3 ] ) ) );
		meta.push( {
			name: v.name, size: m.size.map( ( x ) => round( x ) ), radius: round( m.radius ), height: round( m.height ),
			lods: lods.map( ( l, i ) => ( { node: `${v.name}_LOD${i}`, triangles: l.idx.length / 3 } ) ),
			avgColor: col( 'all' ), colorRoot: col( 'root' ), colorTip: col( 'tip' ),
			windAmplitude: v.windAmplitude, collider: { type: 'none' }, sink: v.sink ?? 0.01, notes: v.notes,
		} );
		console.log( `  ${v.name}: ${islands.length} leaves + ${stems.length} stems, tris ${lods.map( ( l ) => l.idx.length / 3 ).join( ' / ' )} (source ${mesh.idx.length / 3}), size ${m.size.map( ( x ) => x.toFixed( 2 ) ).join( 'x' )}, min y ${m.min[ 1 ].toFixed( 3 )}` );

	}

	mkdirSync( OUT, { recursive: true } );
	const file = join( OUT, `${A.id}.glb` );
	await writeGLB( file, {
		materials: [ { name: A.id, base: images.base, normal: images.nor, orm: images.orm, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true, roughness: 1, metallic: 0 } ],
		variants: outVariants,
	} );
	mkdirSync( join( SRC, '_build' ), { recursive: true } );
	writeFileSync( join( SRC, '_build', `${A.id}.json` ), JSON.stringify( {
		id: A.id, file: `/assets/plants/${A.id}.glb`, source: `https://polyhaven.com/a/${A.id}`, author: A.author, license: 'CC0',
		textureResolution: S, bytes: statSync( file ).size, category: A.category, alphaCutoff: 0.5, variants: meta,
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
