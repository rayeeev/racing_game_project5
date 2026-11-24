#!/usr/bin/env node
// Bushes from Poly Haven shrubs that are modelled as thousands of single-leaf cards + twig cards on a real bark mesh
// (searsia_lucida 77k tris, wild_rooibos_bush 13k tris).  Target: LOD0 <= 2500, LOD1 <= 500, LOD2 <= 80 triangles.
//
//  1. foliage "atoms" (one leaf card / one twig card) are clustered spatially (k-means) into K sprigs per LOD
//  2. every sprig gets a plane (PCA, biased outwards); its atoms are laid FLAT into that plane ("herbarium sheet":
//     each leaf is rotated about its own centre, so no leaf is foreshortened) -> a 2D sprig image
//  3. a small LIBRARY of representative sprigs (3 size classes, one per LOD) is rendered into the atlas at high texel density
//  4. every sprig of every variant is replaced by the best fitting library card (one quad) -> dense foliage, crisp leaves
//  5. the bark mesh (minus the thousands of leaf stalks) is simplified with meshopt and keeps its original UVs: the
//     bark strip of the source atlas is copied to the same place in the new atlas.
//   node tools/assets/plants-build-bush.mjs [id ...] [--debug <dir>]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';
import {
	SRC, OUT, TexSet, loadSoup, islandsOf, subMesh, boundsOf, mergeMeshes, Raster, Atlas, packRects, encodeTextures, writeGLB, MeshBuilder,
	measure, hex, round, v3, rng, Moments, SRGB2LIN,
} from './plants-lib.mjs';

const argv = process.argv.slice( 2 );
const debugDir = argv.includes( '--debug' ) ? argv[ argv.indexOf( '--debug' ) + 1 ] : null;
if ( debugDir ) mkdirSync( debugDir, { recursive: true } );
const only = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && argv[ i - 1 ] !== '--debug' );

const ASSETS = [
	{
		id: 'searsia_lucida', category: 'shrub', author: 'James Ray Cock, Jenelle van Heerden (Poly Haven)', atlas: 1024,
		mats: { bark: 'searsia_lucida', foliage: [ 'searsia_lucida_leaves', 'searsia_lucida_twigs' ] },
		ref: 'searsia_lucida_c_LOD0', libRegion: 0.86, lib: [ 14, 8, 4 ], density: [ 1, 0.62, 0.36 ],
		variants: [
			{ src: 'searsia_lucida_c_LOD0', name: 'bush_large', budgets: [ [ 925, 650 ], [ 190, 120 ], [ 40, 0 ] ], windAmplitude: 0.1, notes: 'dense green broadleaf bush 1.7 m (reads as green alder / shrub willow); forest edge, slopes above the road' },
			{ src: 'searsia_lucida_d_LOD0', name: 'bush_medium', budgets: [ [ 925, 650 ], [ 190, 120 ], [ 40, 0 ] ], windAmplitude: 0.09, notes: 'same species, 1.4 m' },
			{ src: 'searsia_lucida_e_LOD0', name: 'bush_small', budgets: [ [ 900, 500 ], [ 190, 110 ], [ 36, 0 ] ], windAmplitude: 0.07, notes: 'same species, 1.0 m, wide' },
			{ src: 'searsia_lucida_f_LOD0', name: 'bush_tiny', budgets: [ [ 375, 300 ], [ 150, 90 ], [ 30, 0 ] ], windAmplitude: 0.05, notes: 'same species, young plant 0.75 m' },
		],
		// the scanned leaves are a very pale sage (3-4x brighter than the grass blades); graded to a darker, greener alder-like leaf
		outBias: 0.35, alphaGain: 1.25, minRough: 0.75, leafGain: [ 0.46, 0.54, 0.40 ],
	},
	{
		id: 'wild_rooibos_bush', category: 'shrub', author: 'James Ray Cock, Jenelle van Heerden (Poly Haven)', atlas: 1024,
		mats: { bark: 'wild_rooibos_bush', foliage: [ 'wild_rooibos_bush_leaves', 'wild_rooibos_bush_twigs' ] },
		ref: 'wild_rooibos_bush_a', libRegion: 0.86, lib: [ 14, 8, 4 ], density: [ 1, 0.62, 0.36 ],
		variants: [
			{ src: 'wild_rooibos_bush_a', name: 'heath_large', budgets: [ [ 800, 500 ], [ 190, 110 ], [ 38, 0 ] ], windAmplitude: 0.05, notes: 'low needle-leaved heath shrub 0.55 m, olive-yellow (reads as broom / dwarf juniper); dry sunny slopes, scree edges' },
			{ src: 'wild_rooibos_bush_b', name: 'heath_small', budgets: [ [ 500, 400 ], [ 150, 90 ], [ 30, 0 ] ], windAmplitude: 0.04, notes: 'same species, 0.5 m, narrower' },
		],
		outBias: 0.3, alphaGain: 1.7, minRough: 0.75, leafGain: [ 0.8, 0.84, 0.72 ],
	},
];

// ---------------------------------------------------------------- k-means (3D)

function kmeans3( pts, w, K, rand, iters = 14 ) {

	const n = pts.length / 3;
	K = Math.min( K, n );
	const centers = new Float64Array( K * 3 );
	// seeds: random distinct points
	const perm = [ ...Array( n ).keys() ];
	for ( let i = 0; i < K; i ++ ) {

		const j = i + Math.floor( rand() * ( n - i ) );
		[ perm[ i ], perm[ j ] ] = [ perm[ j ], perm[ i ] ];
		for ( let k = 0; k < 3; k ++ ) centers[ i * 3 + k ] = pts[ perm[ i ] * 3 + k ];

	}

	const assign = new Int32Array( n );
	const dist = new Float64Array( n );
	for ( let it = 0; it < iters; it ++ ) {

		for ( let i = 0; i < n; i ++ ) {

			const x = pts[ i * 3 ], y = pts[ i * 3 + 1 ], z = pts[ i * 3 + 2 ];
			let best = 0, bd = Infinity;
			for ( let c = 0; c < K; c ++ ) {

				const dx = x - centers[ c * 3 ], dy = y - centers[ c * 3 + 1 ], dz = z - centers[ c * 3 + 2 ];
				const d = dx * dx + dy * dy + dz * dz;
				if ( d < bd ) {

					bd = d; best = c;

				}

			}

			assign[ i ] = best; dist[ i ] = bd;

		}

		const sum = new Float64Array( K * 4 );
		for ( let i = 0; i < n; i ++ ) {

			const c = assign[ i ];
			sum[ c * 4 ] += pts[ i * 3 ] * w[ i ]; sum[ c * 4 + 1 ] += pts[ i * 3 + 1 ] * w[ i ]; sum[ c * 4 + 2 ] += pts[ i * 3 + 2 ] * w[ i ]; sum[ c * 4 + 3 ] += w[ i ];

		}

		for ( let c = 0; c < K; c ++ ) {

			if ( sum[ c * 4 + 3 ] > 0 ) {

				for ( let k = 0; k < 3; k ++ ) centers[ c * 3 + k ] = sum[ c * 4 + k ] / sum[ c * 4 + 3 ];

			} else {

				// empty cluster: re-seed at the point that is currently worst represented
				let wi = 0;
				for ( let i = 1; i < n; i ++ ) if ( dist[ i ] > dist[ wi ] ) wi = i;
				for ( let k = 0; k < 3; k ++ ) centers[ c * 3 + k ] = pts[ wi * 3 + k ];
				dist[ wi ] = 0;

			}

		}

	}

	return { assign, K };

}

// ---------------------------------------------------------------- atoms / sprigs

function makeAtoms( prims ) {

	const atoms = [];
	for ( const prim of prims ) for ( const tris of islandsOf( prim ) ) {

		const m = subMesh( prim, tris );
		const c = [ 0, 0, 0 ], n = [ 0, 0, 0 ];
		let area = 0;
		for ( let t = 0; t < m.idx.length; t += 3 ) {

			const a = m.idx[ t ] * 3, b = m.idx[ t + 1 ] * 3, d = m.idx[ t + 2 ] * 3;
			const e1 = [ m.pos[ b ] - m.pos[ a ], m.pos[ b + 1 ] - m.pos[ a + 1 ], m.pos[ b + 2 ] - m.pos[ a + 2 ] ];
			const e2 = [ m.pos[ d ] - m.pos[ a ], m.pos[ d + 1 ] - m.pos[ a + 1 ], m.pos[ d + 2 ] - m.pos[ a + 2 ] ];
			const cr = v3.cross( e1, e2 );
			const ar = v3.len( cr ) * 0.5;
			if ( ar <= 0 ) continue;
			// accumulate normals sign-consistently (cards can contain both windings)
			const sgn = v3.dot( cr, n ) < 0 ? - 1 : 1;
			for ( let k = 0; k < 3; k ++ ) {

				n[ k ] += cr[ k ] * 0.5 * sgn;
				c[ k ] += ( m.pos[ a + k ] + m.pos[ b + k ] + m.pos[ d + k ] ) / 3 * ar;

			}

			area += ar;

		}

		if ( area <= 0 ) continue;
		atoms.push( { mesh: m, c: c.map( ( x ) => x / area ), n: v3.norm( n ), area } );

	}

	return atoms;

}

/** rotation matrix (row-major 3x3) taking unit a to unit b (a.b > -1) */
function rotAB( a, b ) {

	const k = v3.cross( a, b ), c = v3.dot( a, b ), f = 1 / ( 1 + c );
	return [
		c + k[ 0 ] * k[ 0 ] * f, k[ 0 ] * k[ 1 ] * f - k[ 2 ], k[ 0 ] * k[ 2 ] * f + k[ 1 ],
		k[ 1 ] * k[ 0 ] * f + k[ 2 ], c + k[ 1 ] * k[ 1 ] * f, k[ 1 ] * k[ 2 ] * f - k[ 0 ],
		k[ 2 ] * k[ 0 ] * f - k[ 1 ], k[ 2 ] * k[ 1 ] * f + k[ 0 ], c + k[ 2 ] * k[ 2 ] * f,
	];

}

const mul3 = ( R, p ) => [ R[ 0 ] * p[ 0 ] + R[ 1 ] * p[ 1 ] + R[ 2 ] * p[ 2 ], R[ 3 ] * p[ 0 ] + R[ 4 ] * p[ 1 ] + R[ 5 ] * p[ 2 ], R[ 6 ] * p[ 0 ] + R[ 7 ] * p[ 1 ] + R[ 8 ] * p[ 2 ] ];

/** Cluster the atoms into K sprigs; each sprig: plane frame + flattened extents. */
function makeSprigs( atoms, K, centre, outBias, rand ) {

	const pts = new Float32Array( atoms.length * 3 ), w = new Float32Array( atoms.length );
	atoms.forEach( ( a, i ) => {

		pts.set( a.c, i * 3 ); w[ i ] = a.area;

	} );
	const km = kmeans3( pts, w, K, rand );
	const lists = Array.from( { length: km.K }, () => [] );
	atoms.forEach( ( a, i ) => lists[ km.assign[ i ] ].push( a ) );
	const sprigs = [];
	for ( const list of lists ) {

		if ( ! list.length ) continue;
		const mo = new Moments();
		const nSum = [ 0, 0, 0 ];
		for ( const a of list ) {

			mo.add( a.c, a.area );
			// spread the atom's own extent into the moments (a long twig defines the sprig direction)
			const b = boundsOf( a.mesh );
			mo.add( b.min, a.area * 0.25 ); mo.add( b.max, a.area * 0.25 );

		}

		const pca = mo.pca();
		const c = pca.mean;
		const outward = v3.norm( [ c[ 0 ] - centre[ 0 ], ( c[ 1 ] - centre[ 1 ] ) * 0.7, c[ 2 ] - centre[ 2 ] ] );
		for ( const a of list ) {

			const s = v3.dot( a.n, outward ) < 0 ? - 1 : 1;
			for ( let k = 0; k < 3; k ++ ) nSum[ k ] += a.n[ k ] * s * a.area;

		}

		let n0 = list.length >= 3 && pca.values[ 1 ] > 1e-10 ? pca.vectors[ 2 ] : v3.norm( nSum );
		if ( v3.dot( n0, outward ) < 0 ) n0 = v3.scale( n0, - 1 );
		const n = v3.norm( v3.add( v3.scale( n0, 1 - outBias ), v3.scale( outward, outBias ) ) );
		let u = v3.sub( pca.vectors[ 0 ], v3.scale( n, v3.dot( pca.vectors[ 0 ], n ) ) );
		if ( v3.len( u ) < 1e-4 ) u = v3.cross( Math.abs( n[ 1 ] ) < 0.9 ? [ 0, 1, 0 ] : [ 1, 0, 0 ], n );
		u = v3.norm( u );
		const v = v3.cross( n, u );
		const sprig = { c, n, u, v, atoms: list, area: 0, x0: Infinity, x1: - Infinity, y0: Infinity, y1: - Infinity };
		for ( const a of list ) {

			sprig.area += a.area;
			const an = v3.dot( a.n, n ) < 0 ? v3.scale( a.n, - 1 ) : a.n;
			const R = rotAB( an, n );
			a._R = R;
			const p = a.mesh.pos;
			for ( let i = 0; i < p.length; i += 3 ) {

				const q = v3.add( a.c, mul3( R, [ p[ i ] - a.c[ 0 ], p[ i + 1 ] - a.c[ 1 ], p[ i + 2 ] - a.c[ 2 ] ] ) );
				const d = v3.sub( q, c );
				const x = v3.dot( d, u ), y = v3.dot( d, v );
				if ( x < sprig.x0 ) sprig.x0 = x;
				if ( x > sprig.x1 ) sprig.x1 = x;
				if ( y < sprig.y0 ) sprig.y0 = y;
				if ( y > sprig.y1 ) sprig.y1 = y;

			}

		}

		const pad = 0.004;
		sprig.x0 -= pad; sprig.x1 += pad; sprig.y0 -= pad; sprig.y1 += pad;
		sprig.w = sprig.x1 - sprig.x0; sprig.h = sprig.y1 - sprig.y0;
		sprig.fill = sprig.area / ( sprig.w * sprig.h );
		sprigs.push( sprig );

	}

	return sprigs;

}

/** The flattened geometry of a sprig as one mesh (for baking). */
function flattenSprig( sprig ) {

	const parts = [];
	for ( const a of sprig.atoms ) {

		const an = v3.dot( a.n, sprig.n ) < 0 ? v3.scale( a.n, - 1 ) : a.n;
		const R = rotAB( an, sprig.n );
		const m = a.mesh;
		const pos = new Float32Array( m.pos.length ), nrm = new Float32Array( m.nrm.length );
		for ( let i = 0; i < m.pos.length; i += 3 ) {

			const q = v3.add( a.c, mul3( R, [ m.pos[ i ] - a.c[ 0 ], m.pos[ i + 1 ] - a.c[ 1 ], m.pos[ i + 2 ] - a.c[ 2 ] ] ) );
			pos[ i ] = q[ 0 ]; pos[ i + 1 ] = q[ 1 ]; pos[ i + 2 ] = q[ 2 ];
			const r = mul3( R, [ m.nrm[ i ], m.nrm[ i + 1 ], m.nrm[ i + 2 ] ] );
			nrm[ i ] = r[ 0 ]; nrm[ i + 1 ] = r[ 1 ]; nrm[ i + 2 ] = r[ 2 ];

		}

		parts.push( { pos, nrm, uv: m.uv, idx: m.idx } );

	}

	return mergeMeshes( parts );

}

// ---------------------------------------------------------------- build

async function build( A ) {

	const dir = join( SRC, A.id ), maps = join( SRC, A.id + '__maps' );
	const S = A.atlas, PAD = 2;
	const tex = await TexSet.load( {
		name: A.id,
		diff: join( dir, 'textures', `${A.id}_diff_2k.jpg` ), alpha: join( maps, `${A.id}_alpha_2k.png` ),
		nor: join( dir, 'textures', `${A.id}_nor_gl_2k.jpg` ), arm: join( dir, 'textures', `${A.id}_arm_2k.jpg` ),
	} );
	const nodes = await loadSoup( join( dir, `${A.id}_2k.gltf` ) );
	const rand = rng( 4242 );

	// 1-2. atoms + sprigs for every variant / LOD
	const work = [];
	for ( const v of A.variants ) {

		const node = nodes.find( ( n ) => n.name === v.src );
		if ( ! node ) throw new Error( `${A.id}: node ${v.src} not found (have ${nodes.map( ( n ) => n.name ).join( ', ' )})` );
		const foliage = node.prims.filter( ( p ) => A.mats.foliage.includes( p.material ) );
		const bark = node.prims.find( ( p ) => p.material === A.mats.bark );
		const atoms = makeAtoms( foliage );
		const bb = boundsOf( node.prims );
		const centre = [ 0, bb.max[ 1 ] * 0.5, 0 ];
		const per = [ 4.5, 20, 95 ], floor = [ 60, 40, 14 ];
		const levels = v.budgets.map( ( [ cards ], li ) => makeSprigs( atoms, Math.min( cards, Math.max( floor[ li ], Math.round( atoms.length / per[ li ] ) ) ), centre, A.outBias, rand ) );
		work.push( { v, node, bark, atoms, bounds: bb, centre, levels } );
		console.log( `  ${v.name}: ${atoms.length} foliage atoms, sprigs ${levels.map( ( l ) => l.length ).join( ' / ' )}, median sprig size ${levels.map( ( l ) => {

			const s = l.map( ( x ) => Math.max( x.w, x.h ) ).sort( ( a, b ) => a - b );
			return ( s[ s.length >> 1 ] * 100 ).toFixed( 0 ) + 'cm';

		} ).join( ' / ' )}` );

	}

	// 3. library: representative sprigs of the reference variant, per level
	const ref = work.find( ( w ) => w.v.src === A.ref );
	const library = ref.levels.map( ( sprigs, li ) => {

		const sorted = [ ...sprigs ].filter( ( s ) => s.atoms.length >= ( li === 0 ? 3 : 6 ) ).sort( ( a, b ) => a.w * a.h - b.w * b.h );
		const picks = [];
		const n = A.lib[ li ];
		for ( let i = 0; i < n; i ++ ) {

			// evenly spaced size quantiles between 30% and 92%; in a small window around each take the best filled sprig
			const q = 0.3 + 0.62 * ( i + 0.5 ) / n;
			const mid = Math.floor( q * sorted.length ), win = Math.max( 2, Math.floor( sorted.length * 0.02 ) );
			let best = null;
			for ( let k = Math.max( 0, mid - win ); k <= Math.min( sorted.length - 1, mid + win ); k ++ ) {

				const s = sorted[ k ];
				if ( picks.includes( s ) ) continue;
				if ( ! best || s.fill > best.fill ) best = s;

			}

			if ( best ) picks.push( best );

		}

		return picks;

	} );

	// texel density: fit all library cards into the left part of the atlas
	const W = Math.floor( S * A.libRegion );
	let px = 3000, rects = null;
	for ( ; px > 80; px *= 0.98 ) {

		rects = [];
		library.forEach( ( cards, li ) => cards.forEach( ( sprig ) => rects.push( { sprig, li, d: px * A.density[ li ], w: Math.max( 4, Math.round( sprig.w * px * A.density[ li ] ) ), h: Math.max( 4, Math.round( sprig.h * px * A.density[ li ] ) ) } ) ) );
		if ( packRects( rects, W, S, PAD ) ) break;

	}

	console.log( `  library ${library.map( ( l ) => l.length ).join( ' / ' )} cards, texel density ${library.map( ( _, li ) => ( px * A.density[ li ] ).toFixed( 0 ) ).join( ' / ' )} px/m` );

	// 4. bake library + copy the bark strip of the source atlas
	const atlas = new Atlas( S, S );
	const leafAcc = [ 0, 0, 0, 0 ];
	for ( const r of rects ) {

		const s = r.sprig;
		const frame = { o: v3.add( s.c, v3.add( v3.scale( s.u, s.x0 ), v3.scale( s.v, s.y0 ) ) ), u: s.u, v: s.v, n: s.n };
		const res = new Raster( r.w, r.h, s.w, s.h, 4 ).draw( flattenSprig( s ), frame, { tex } ).resolve();
		for ( let k = 0; k < r.w * r.h; k ++ ) {

			if ( res.a[ k ] <= 0 ) continue;
			res.orm[ k * 3 + 1 ] = Math.max( A.minRough, res.orm[ k * 3 + 1 ] );
			if ( A.leafGain ) for ( let c = 0; c < 3; c ++ ) res.rgb[ k * 3 + c ] *= A.leafGain[ c ];
			if ( r.li === 0 ) {

				leafAcc[ 0 ] += res.rgb[ k * 3 ] * res.a[ k ]; leafAcc[ 1 ] += res.rgb[ k * 3 + 1 ] * res.a[ k ]; leafAcc[ 2 ] += res.rgb[ k * 3 + 2 ] * res.a[ k ]; leafAcc[ 3 ] += res.a[ k ];

			}

		}

		atlas.blit( res, r.x, r.y );
		s.rect = { x: r.x, y: r.y, w: r.w, h: r.h };

	}

	atlas.dilate( 16 );
	// bark strip: same texels at the same uv as in the source (source resized to the atlas size)
	const barkAcc = [ 0, 0, 0, 0 ];
	{

		const f = tex.w / S;
		for ( let y = 0; y < S; y ++ ) for ( let x = W; x < S; x ++ ) {

			const k = y * S + x;
			let r = 0, g = 0, b = 0, nx = 0, ny = 0, nz = 0, o0 = 0, o1 = 0, cnt = 0;
			for ( let j = 0; j < f; j ++ ) for ( let i = 0; i < f; i ++ ) {

				const q = ( Math.floor( y * f ) + j ) * tex.w + Math.floor( x * f ) + i;
				r += SRGB2LIN[ tex.diff[ q * 3 ] ]; g += SRGB2LIN[ tex.diff[ q * 3 + 1 ] ]; b += SRGB2LIN[ tex.diff[ q * 3 + 2 ] ];
				nx += tex.nor[ q * 3 ]; ny += tex.nor[ q * 3 + 1 ]; nz += tex.nor[ q * 3 + 2 ];
				o0 += tex.arm[ q * 3 ]; o1 += tex.arm[ q * 3 + 1 ];
				cnt ++;

			}

			atlas.rgb[ k * 3 ] = r / cnt; atlas.rgb[ k * 3 + 1 ] = g / cnt; atlas.rgb[ k * 3 + 2 ] = b / cnt;
			atlas.a[ k ] = 1;
			const n = v3.norm( [ nx / cnt / 127.5 - 1, ny / cnt / 127.5 - 1, nz / cnt / 127.5 - 1 ] );
			atlas.nrm[ k * 3 ] = n[ 0 ]; atlas.nrm[ k * 3 + 1 ] = n[ 1 ]; atlas.nrm[ k * 3 + 2 ] = n[ 2 ];
			atlas.orm[ k * 3 ] = o0 / cnt / 255; atlas.orm[ k * 3 + 1 ] = o1 / cnt / 255; atlas.orm[ k * 3 + 2 ] = 0;

		}

	}

	// alpha gain only on the foliage part
	const bytes = atlas.toBytes( ( a ) => a );
	for ( let y = 0; y < S; y ++ ) for ( let x = 0; x < W; x ++ ) {

		const k = y * S + x;
		bytes.base[ k * 4 + 3 ] = Math.round( Math.min( 1, atlas.a[ k ] * A.alphaGain ) * 255 );

	}

	const images = await encodeTextures( bytes, { quality: 90, debugDir, name: A.id } );

	// 5. meshes
	const outVariants = [], meta = [];
	for ( const w of work ) {

		// bark colour (for colorRoot): mean over the bark uv footprint
		const lods = w.levels.map( ( sprigs, li ) => {

			const mb = new MeshBuilder();
			const lib = library[ li ];
			for ( const s of sprigs ) {

				// best fitting library card, optionally turned by 90 degrees
				let best = null;
				for ( const L of lib ) for ( const rot of [ 0, 1 ] ) {

					const lw = rot ? L.h : L.w, lh = rot ? L.w : L.h;
					const cost = Math.abs( Math.log( s.w / lw ) ) + Math.abs( Math.log( s.h / lh ) ) + rand() * 0.15;
					if ( ! best || cost < best.cost ) best = { L, rot, cost, lw, lh };

				}

				const k = Math.min( 1.45, Math.max( 0.7, Math.sqrt( ( s.w * s.h ) / ( best.lw * best.lh ) ) ) ) * ( w.v.cardScale?.[ li ] ?? 1 );
				const hw = best.lw * k * 0.5, hh = best.lh * k * 0.5;
				const cc = v3.add( s.c, v3.add( v3.scale( s.u, ( s.x0 + s.x1 ) * 0.5 ), v3.scale( s.v, ( s.y0 + s.y1 ) * 0.5 ) ) );
				const R = best.L.rect;
				const u0 = R.x / S, u1 = ( R.x + R.w ) / S, vT = R.y / S, vB = ( R.y + R.h ) / S;
				// library image corners: (u0,vB) bottom-left, (u1,vB) bottom-right, (u1,vT) top-right, (u0,vT) top-left
				let uvs = [ [ u0, vB ], [ u1, vB ], [ u1, vT ], [ u0, vT ] ];
				if ( best.rot ) uvs = [ uvs[ 1 ], uvs[ 2 ], uvs[ 3 ], uvs[ 0 ] ];   // image turned by 90 degrees
				if ( rand() < 0.5 ) uvs = [ uvs[ 1 ], uvs[ 0 ], uvs[ 3 ], uvs[ 2 ] ];   // mirrored
				const corners = [ [ - hw, - hh ], [ hw, - hh ], [ hw, hh ], [ - hw, hh ] ].map( ( [ x, y ] ) => v3.add( cc, v3.add( v3.scale( s.u, x ), v3.scale( s.v, y ) ) ) );
				const ids = corners.map( ( p, i ) => {

					p[ 1 ] = Math.max( p[ 1 ], 0.01 );
					const out = v3.norm( [ p[ 0 ] - w.centre[ 0 ], ( p[ 1 ] - w.centre[ 1 ] ) * 0.7, p[ 2 ] - w.centre[ 2 ] ] );
					const n = v3.norm( [ s.n[ 0 ] * 0.25 + out[ 0 ] * 0.6, s.n[ 1 ] * 0.25 + out[ 1 ] * 0.6 + 0.6, s.n[ 2 ] * 0.25 + out[ 2 ] * 0.6 ] );
					return mb.vert( p, n, uvs[ i ] );

				} );
				mb.quad( ids[ 0 ], ids[ 1 ], ids[ 2 ], ids[ 3 ] );

			}

			const prims = [ mb.build( 0 ) ];
			// bark
			const barkBudget = w.v.budgets[ li ][ 1 ];
			if ( barkBudget > 0 && w.bark ) {

				const minExtent = li === 0 ? 0.12 : 0.3;
				let islands = islandsOf( w.bark ).map( ( t ) => subMesh( w.bark, t ) ).filter( ( m ) => m.idx.length / 3 >= 12 && Math.max( ...boundsOf( m ).size ) >= minExtent );
				islands.sort( ( a, b ) => b.idx.length - a.idx.length );
				const bb = new MeshBuilder();
				let total = islands.reduce( ( n, m ) => n + m.idx.length / 3, 0 ), budget = barkBudget;
				// greedy: big islands first, each gets its share; islands whose share is below 10 triangles are dropped
				let used = 0;
				for ( const m of islands ) {

					const tris = m.idx.length / 3;
					const share = Math.floor( budget * tris / total );
					total -= tris;
					if ( share < 10 ) continue;
					const target = Math.min( tris, share );
					const idx = target >= tris ? m.idx : MeshoptSimplifier.simplify( m.idx, m.pos, 3, target * 3, 0.5 )[ 0 ];
					if ( idx.length / 3 > share * 1.3 + 4 ) {

						budget -= 0;   // could not reach the target (open borders) -> skip this island

					} else {

						bb.append( { pos: m.pos, nrm: m.nrm, uv: m.uv, idx } );
						used += idx.length / 3;
						budget -= idx.length / 3;

					}

				}

				const built = compact( bb.build( 1 ) );
				if ( built.idx.length ) prims.push( built );

			}

			return prims;

		} );

		// pivot: min y = 0
		const y0 = measure( lods[ 0 ] ).min[ 1 ];
		for ( const prims of lods ) for ( const p of prims ) for ( let i = 1; i < p.pos.length; i += 3 ) p.pos[ i ] = Math.max( 0, p.pos[ i ] - y0 );
		outVariants.push( { name: w.v.name, lods } );
		const m = measure( lods[ 0 ] );
		// bark colour
		if ( barkAcc[ 3 ] === 0 && w.bark ) for ( let i = 0; i < w.bark.uv.length; i += 2 ) {

			const x = Math.min( tex.w - 1, Math.max( 0, Math.floor( w.bark.uv[ i ] * tex.w ) ) ), y = Math.min( tex.h - 1, Math.max( 0, Math.floor( w.bark.uv[ i + 1 ] * tex.h ) ) );
			const q = ( y * tex.w + x ) * 3;
			barkAcc[ 0 ] += SRGB2LIN[ tex.diff[ q ] ]; barkAcc[ 1 ] += SRGB2LIN[ tex.diff[ q + 1 ] ]; barkAcc[ 2 ] += SRGB2LIN[ tex.diff[ q + 2 ] ]; barkAcc[ 3 ] ++;

		}

		const leaf = leafAcc.slice( 0, 3 ).map( ( x ) => x / leafAcc[ 3 ] ), barkC = barkAcc[ 3 ] ? barkAcc.slice( 0, 3 ).map( ( x ) => x / barkAcc[ 3 ] ) : leaf;
		const tris = lods.map( ( prims ) => prims.reduce( ( n, p ) => n + p.idx.length / 3, 0 ) );
		meta.push( {
			name: w.v.name, size: m.size.map( ( x ) => round( x ) ), radius: round( m.radius ), height: round( m.height ),
			lods: tris.map( ( t, i ) => ( { node: `${w.v.name}_LOD${i}`, triangles: t } ) ),
			avgColor: hex( leaf ), colorRoot: hex( barkC ), colorTip: hex( leaf ),
			windAmplitude: w.v.windAmplitude, collider: { type: 'none' }, sink: 0.03, notes: w.v.notes,
		} );
		console.log( `  ${w.v.name}: tris ${lods.map( ( prims ) => prims.map( ( p ) => p.idx.length / 3 ).join( '+' ) ).join( ' / ' )}, size ${m.size.map( ( x ) => x.toFixed( 2 ) ).join( 'x' )}` );

	}

	mkdirSync( OUT, { recursive: true } );
	const file = join( OUT, `${A.id}.glb` );
	await writeGLB( file, {
		materials: [
			{ name: A.id + '_leaves', textureName: A.id, base: images.base, normal: images.nor, orm: images.orm, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true, roughness: 1, metallic: 0 },
			{ name: A.id + '_bark', texturesFrom: 0, alphaMode: 'OPAQUE', doubleSided: false, roughness: 1, metallic: 0 },
		],
		variants: outVariants,
	} );
	mkdirSync( join( SRC, '_build' ), { recursive: true } );
	writeFileSync( join( SRC, '_build', `${A.id}.json` ), JSON.stringify( {
		id: A.id, file: `/assets/plants/${A.id}.glb`, source: `https://polyhaven.com/a/${A.id}`, author: A.author, license: 'CC0',
		textureResolution: S, bytes: statSync( file ).size, category: A.category, alphaCutoff: 0.5,
		materials: [ `${A.id}_leaves (MASK, double sided)`, `${A.id}_bark (OPAQUE)` ], variants: meta,
	}, null, 1 ) );
	console.log( `  wrote ${file} ${( statSync( file ).size / 1024 ).toFixed( 0 )} KB` );

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

await MeshoptSimplifier.ready;
for ( const A of ASSETS ) {

	if ( only.length && ! only.includes( A.id ) ) continue;
	if ( ! existsSync( join( SRC, A.id ) ) ) continue;
	console.log( A.id );
	await build( A );

}
