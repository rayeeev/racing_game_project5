#!/usr/bin/env node
// Build the game-ready conifer GLBs (public/assets/trees/fir.glb, pine.glb) from the Poly Haven sources.
//
//   node tools/assets/trees-build-conifers.mjs <fir|pine> [--only <variant>] [--debug-atlas]
//
// Inputs (see trees-fetch.mjs / trees-blender.mjs):
//   assets-src/trees/_dump/<id>/*            raw LOD1 trees, twig prototypes, trunks dumped from the .blend files
//   assets-src/trees/<id>/{textures,extra}/  source texture maps
// Output:
//   public/assets/trees/<species>.glb        6 variants x 3 LODs, 2 materials (<species>_bark, <species>_needles)
//   assets-src/trees/_build/<species>.json   measurements for trees-index.mjs
//
// How the LODs are made (no generic decimation of foliage):
//   * The artist's LOD1 tree is a set of exact copies ("instances") of a few twig-card prototypes. We recover every
//     instance (prototype id + similarity transform) and re-emit the tree with cards of our own choosing:
//       LOD0  the artist's cut-out card meshes (LOD1 or LOD2 prototype, whichever fits the triangle budget)
//       LOD1  one bent quad strip (4 triangles) per card, fitted to the prototype's 3D shape
//       LOD2  a subset of the cards as single quads, scaled up so the total card area (silhouette/density) is kept
//   * Branches and trunks are rebuilt as low-poly tubes from the ring structure of the source tubes; the photo-scanned
//     trunk base is simplified with meshoptimizer (UV seams preserved).

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDump, findInstances, SRC, OUT, DSU, v3, m3, applySim, rng, srgbToLinear, linearToSrgb, hex } from './trees-lib.mjs';
import { MeshBuilder, fitSurface, noise3, DensityGrid, writeGLB, ringsFromTube, decimateRings, emitTube, simplifyMesh, compactMesh } from './trees-geom.mjs';
import { loadImage, newImage, crop, resize, blit, savePng, encode, shelfPack, sampleBilinear, dilate, alphaHalo } from './trees-img.mjs';
import { bakeNeedleSprites } from './trees-bake.mjs';
import { buildBarkAtlas, buildScanTrunk } from './trees-bark.mjs';
import { rasterTriangle } from './trees-raster.mjs';

const args = process.argv.slice( 2 );
const speciesName = args[ 0 ];
const optVal = ( k, d ) => {

	const i = args.indexOf( '--' + k );
	return i >= 0 ? args[ i + 1 ] : d;

};

const ONLY = optVal( 'only', null );
const DEBUG_ATLAS = args.includes( '--debug-atlas' );
const BUILD = join( SRC, '_build' );
mkdirSync( BUILD, { recursive: true } );
mkdirSync( OUT, { recursive: true } );

// ---------------------------------------------------------------------------------------------------------------
// Species configuration
// ---------------------------------------------------------------------------------------------------------------
const BUDGET = {
	tall: [ 45000, 9000, 1500 ],
	young: [ 12000, 2500, 400 ],
};

const SPECIES = {
	fir: {
		needleMode: 'repack', // the source atlas already holds 7 baked twig sprites
		needleSrc: 'fir_tree_01',
		needleMaps: { diff: 'extra/fir_tree_01_twig_diff_4k.png', alpha: 'extra/fir_tree_01_twig_alpha_4k.png', nor: 'extra/fir_tree_01_twig_nor_gl_4k.png', arm: 'textures/fir_tree_01_twig_arm_2k.jpg', mask: 'extra/fir_tree_01_twig_mask_2k.png' },
		needleValue: 0.8, // "Hue Saturation Value" node (value 0.8) in front of the base colour in the source material
		barkSrc: 'fir_tree_01',
		barkMaps: ( name ) => ( { diff: `textures/fir_tree_01_${name}_diff_2k.jpg`, nor: `textures/fir_tree_01_${name}_nor_gl_2k.jpg`, arm: `textures/fir_tree_01_${name}_arm_2k.jpg` } ),
		groups: [
			{
				src: 'fir_tree_01', klass: 'tall',
				variants: [ [ 'a', 'fir_tall_a' ], [ 'b', 'fir_tall_b' ], [ 'c', 'fir_tall_c' ] ],
				tree: ( v ) => `fir_tree_01_${v}_LOD1`,
				trunk: ( v ) => `fir_tree_01_trunk_${v}`,
				protos: { main_a: 'fir_tree_01_twig_main_a', main_b: 'fir_tree_01_twig_main_b', main_c: 'fir_tree_01_twig_main_c', tip_a: 'fir_tree_01_twig_tip_a', tip_b: 'fir_tree_01_twig_tip_b', tip_c: 'fir_tree_01_twig_tip_c', tip_d: 'fir_tree_01_twig_tip_d' },
				mats: { twig: /_twig$/, bark: /_bark$/, trunk: /_trunk_[abc]$/, dead: /dead_branches$/ },
			},
			{
				src: 'fir_sapling_medium', klass: 'young',
				variants: [ [ 'a', 'fir_young_a' ], [ 'b', 'fir_young_b' ], [ 'c', 'fir_young_c' ] ],
				tree: ( v ) => `fir_sapling_medium_${v}_LOD1`,
				trunk: null,
				protos: { main_a: 'fir_sapling_medium_twigs_a', main_b: 'fir_sapling_medium_twigs_b', main_c: 'fir_sapling_medium_twigs_c', tip_a: 'fir_sapling_medium_twigs_tip_a', tip_b: 'fir_sapling_medium_twigs_tip_b', tip_c: 'fir_sapling_medium_twigs_tip_c', tip_d: 'fir_sapling_medium_twigs_tip_d' },
				mats: { twig: /_twigs$/, bark: /_branches$/, trunk: null, dead: /branches_dead$/ },
			},
		],
	},
	pine: {
		needleMode: 'bake', // the source atlas only has needle strips; whole twigs are baked into sprites here
		needleSrc: 'pine_tree_01',
		needleMaps: { diff: 'extra/pine_tree_01_twig_diff_4k.png', alpha: 'extra/pine_tree_01_twig_alpha_4k.png', nor: 'extra/pine_tree_01_twig_nor_gl_4k.png', arm: 'textures/pine_tree_01_twig_arm_2k.jpg', mask: 'extra/pine_tree_01_twig_mask_2k.png' },
		needleValue: 1.0,
		barkSrc: 'pine_tree_01',
		barkMaps: ( name ) => ( { diff: `textures/pine_tree_01_${name}_diff_2k.jpg`, nor: `textures/pine_tree_01_${name}_nor_gl_2k.jpg`, arm: `textures/pine_tree_01_${name}_arm_2k.jpg` } ),
		groups: [
			{
				src: 'pine_tree_01', klass: 'tall',
				variants: [ [ 'a', 'pine_tall_a' ], [ 'b', 'pine_tall_b' ], [ 'c', 'pine_tall_c' ] ],
				tree: ( v ) => `pine_tree_01_${v}_LOD1`,
				trunk: ( v ) => `pine_tree_01_trunk_${v}`,
				protos: { a: 'pine_tree_01_twig_a', b: 'pine_tree_01_twig_b', c: 'pine_tree_01_twig_c', d: 'pine_tree_01_twig_d', e: 'pine_tree_01_twig_e', f: 'pine_tree_01_twig_f', g: 'pine_tree_01_twig_g' },
				protoLod0: ( n ) => n,
				mats: { twig: /_twig$/, bark: /_bark$/, trunk: /_trunk_[abc]$/, dead: /dead_branches$/ },
			},
			{
				src: 'pine_sapling_medium', klass: 'young',
				variants: [ [ 'a', 'pine_young_a' ], [ 'b', 'pine_young_b' ], [ 'c', 'pine_young_c' ] ],
				tree: ( v ) => `pine_sapling_medium_${v}_LOD1`,
				trunk: null,
				protos: { a: 'pine_sapling_medium_twig_a', b: 'pine_sapling_medium_twig_b', c: 'pine_sapling_medium_twig_c', d: 'pine_sapling_medium_twig_d', e: 'pine_sapling_medium_twig_e', f: 'pine_sapling_medium_twig_f', g: 'pine_sapling_medium_twig_g' },
				protoLod0: ( n ) => n + '_LOD0',
				mats: { twig: /_twig$/, bark: /_bark$/, trunk: null, dead: /dead_branches$/ },
			},
		],
	},
};

const sp = SPECIES[ speciesName ];
if ( ! sp ) {

	console.error( 'usage: node tools/assets/trees-build-conifers.mjs <fir|pine> [--only <variant>]' );
	process.exit( 2 );

}

const NEEDLE_ATLAS = 2048;
const ALPHA_CUTOFF = 0.4;

// ---------------------------------------------------------------------------------------------------------------
// 1. Needle atlas
// ---------------------------------------------------------------------------------------------------------------
// Returns { base, normal, orm (raw images), sprites: { key: { toAtlas(u, v) -> [u, v] glTF, rectUV:[u0,v0,u1,v1] (Blender uv of the source) } }, avgColor }
async function repackNeedleAtlas( protoDumps ) {

	const S = 4096;
	const dir = join( SRC, sp.needleSrc );
	console.log( 'needle atlas: loading 4k source maps ...' );
	const diff = await loadImage( join( dir, sp.needleMaps.diff ), 3 );
	const alpha = await loadImage( join( dir, sp.needleMaps.alpha ), 1 );
	const nor = await loadImage( join( dir, sp.needleMaps.nor ), 3 );
	const arm = await loadImage( join( dir, sp.needleMaps.arm ), 3, [ S, S ] );
	const mask = await loadImage( join( dir, sp.needleMaps.mask ), 1, [ S, S ] );
	if ( diff.w !== S || alpha.w !== S || nor.w !== S ) throw new Error( 'expected 4k source maps' );
	// sprite rectangles = union of the card UV bounds of every prototype that shares the key
	const rects = [];
	for ( const [ key, dumps ] of Object.entries( protoDumps ) ) {

		let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
		for ( const d of dumps ) for ( let c = 0; c < d.nc; c ++ ) {

			u0 = Math.min( u0, d.uv[ c * 2 ] );
			u1 = Math.max( u1, d.uv[ c * 2 ] );
			v0 = Math.min( v0, d.uv[ c * 2 + 1 ] );
			v1 = Math.max( v1, d.uv[ c * 2 + 1 ] );

		}

		const m = 6;
		const x0 = Math.max( 0, Math.floor( u0 * S ) - m ), x1 = Math.min( S, Math.ceil( u1 * S ) + m );
		const y0 = Math.max( 0, Math.floor( ( 1 - v1 ) * S ) - m ), y1 = Math.min( S, Math.ceil( ( 1 - v0 ) * S ) + m );
		rects.push( { key, x0, y0, sw: x1 - x0, sh: y1 - y0, uv: [ u0, v0, u1, v1 ] } );

	}

	// largest uniform scale that packs into the atlas
	const PAD = 8;
	let lo = 0.2, hi = 1.5;
	for ( let it = 0; it < 30; it ++ ) {

		const s = ( lo + hi ) / 2;
		const test = rects.map( ( r ) => ( { w: Math.round( r.sw * s ) + PAD * 2, h: Math.round( r.sh * s ) + PAD * 2 } ) );
		if ( shelfPack( test, NEEDLE_ATLAS, NEEDLE_ATLAS ) ) lo = s; else hi = s;

	}

	const scale = Math.min( lo, 1 );
	const packed = rects.map( ( r ) => ( { w: Math.round( r.sw * scale ) + PAD * 2, h: Math.round( r.sh * scale ) + PAD * 2 } ) );
	if ( ! shelfPack( packed, NEEDLE_ATLAS, NEEDLE_ATLAS ) ) throw new Error( 'needle atlas packing failed' );
	console.log( `needle atlas: ${rects.length} sprites, scale ${scale.toFixed( 3 )} of the 4k source (${( scale * 2 ).toFixed( 2 )}x the 2k source)` );

	const base = newImage( NEEDLE_ATLAS, NEEDLE_ATLAS, 4, [ 0, 0, 0, 0 ] );
	const normal = newImage( NEEDLE_ATLAS, NEEDLE_ATLAS, 3, [ 128, 128, 255 ] );
	const orm = newImage( NEEDLE_ATLAS, NEEDLE_ATLAS, 3, [ 255, 160, 0 ] );
	const valid = new Uint8Array( NEEDLE_ATLAS * NEEDLE_ATLAS );
	const sprites = {};
	const sum = [ 0, 0, 0, 0 ];
	for ( let i = 0; i < rects.length; i ++ ) {

		const r = rects[ i ], p = packed[ i ];
		const dw = p.w - PAD * 2, dh = p.h - PAD * 2;
		const dx = p.x + PAD, dy = p.y + PAD;
		const sx = dw / r.sw, sy = dh / r.sh;
		// colour maps are cropped with their padding (the source atlas is edge-dilated), alpha only inside the rect
		const padS = Math.ceil( PAD / scale );
		const cw = r.sw + padS * 2, ch = r.sh + padS * 2;
		const tw = Math.round( cw * sx ), th = Math.round( ch * sy );
		const ox = dx - Math.round( padS * sx ), oy = dy - Math.round( padS * sy );
		const cDiff = await resize( crop( diff, r.x0 - padS, r.y0 - padS, cw, ch ), tw, th );
		const cNor = await resize( crop( nor, r.x0 - padS, r.y0 - padS, cw, ch ), tw, th );
		const cArm = await resize( crop( arm, r.x0 - padS, r.y0 - padS, cw, ch ), tw, th );
		const cMask = await resize( crop( mask, r.x0 - padS, r.y0 - padS, cw, ch ), tw, th );
		// alpha: only what lies under this sprite's card polygons (keeps bits of neighbouring sprites / twig strips out)
		const aCrop = crop( alpha, r.x0, r.y0, r.sw, r.sh );
		const inside = new Uint8Array( r.sw * r.sh );
		for ( const d of protoDumps[ r.key ] ) for ( let p = 0; p < d.np; p ++ ) {

			const s = d.polyStart[ p ], n = d.polyCount[ p ];
			for ( let k = 1; k < n - 1; k ++ ) {

				const q = [ s, s + k, s + k + 1 ].map( ( c ) => [ d.uv[ c * 2 ] * S - r.x0, ( 1 - d.uv[ c * 2 + 1 ] ) * S - r.y0 ] );
				rasterTriangle( q[ 0 ][ 0 ], q[ 0 ][ 1 ], q[ 1 ][ 0 ], q[ 1 ][ 1 ], q[ 2 ][ 0 ], q[ 2 ][ 1 ], r.sw, r.sh, ( px, py ) => {

					inside[ py * r.sw + px ] = 1;

				} );

			}

		}

		const GROW = 5;
		for ( let y = 0; y < r.sh; y ++ ) for ( let x = 0; x < r.sw; x ++ ) {

			let ok = 0;
			for ( let dy = - GROW; dy <= GROW && ! ok; dy += GROW ) for ( let dx = - GROW; dx <= GROW && ! ok; dx += GROW ) {

				const xx = Math.min( r.sw - 1, Math.max( 0, x + dx ) ), yy = Math.min( r.sh - 1, Math.max( 0, y + dy ) );
				ok = inside[ yy * r.sw + xx ];

			}

			if ( ! ok ) aCrop.data[ y * r.sw + x ] = 0;

		}

		const cAlpha = await resize( aCrop, dw, dh );
		for ( let y = 0; y < th; y ++ ) for ( let x = 0; x < tw; x ++ ) {

			const X = ox + x, Y = oy + y;
			if ( X < 0 || Y < 0 || X >= NEEDLE_ATLAS || Y >= NEEDLE_ATLAS ) continue;
			const o = Y * NEEDLE_ATLAS + X, s = y * tw + x;
			for ( let k = 0; k < 3; k ++ ) {

				base.data[ o * 4 + k ] = Math.round( 255 * linearToSrgb( srgbToLinear( cDiff.data[ s * 3 + k ] / 255 ) * sp.needleValue ) );
				normal.data[ o * 3 + k ] = cNor.data[ s * 3 + k ];

			}

			orm.data[ o * 3 ] = cArm.data[ s * 3 ];
			orm.data[ o * 3 + 1 ] = cArm.data[ s * 3 + 1 ];
			orm.data[ o * 3 + 2 ] = cMask.data[ s ];
			valid[ o ] = 1;

		}

		for ( let y = 0; y < dh; y ++ ) for ( let x = 0; x < dw; x ++ ) {

			const o = ( dy + y ) * NEEDLE_ATLAS + dx + x;
			const a = cAlpha.data[ y * dw + x ];
			base.data[ o * 4 + 3 ] = a;
			if ( a > 128 ) {

				for ( let k = 0; k < 3; k ++ ) sum[ k ] += srgbToLinear( base.data[ o * 4 + k ] / 255 );
				sum[ 3 ] ++;

			}

		}

		const x0 = r.x0, y0 = r.y0;
		sprites[ r.key ] = {
			rectUV: r.uv,
			px: { x: dx, y: dy, w: dw, h: dh },
			toAtlas: ( u, v ) => [ ( dx + ( u * S - x0 ) * sx ) / NEEDLE_ATLAS, ( dy + ( ( 1 - v ) * S - y0 ) * sy ) / NEEDLE_ATLAS ],
		};

	}

	// everything outside the sprites: spread the neighbouring colours (keeps mips clean), alpha stays 0
	dilate( base, valid, 12 );
	const avg = [ 0, 1, 2 ].map( ( k ) => sum[ k ] / sum[ 3 ] );
	for ( let i = 0; i < valid.length; i ++ ) if ( ! valid[ i ] && base.data[ i * 4 ] === 0 && base.data[ i * 4 + 1 ] === 0 && base.data[ i * 4 + 2 ] === 0 ) {

		for ( let k = 0; k < 3; k ++ ) base.data[ i * 4 + k ] = Math.round( 255 * linearToSrgb( avg[ k ] ) );

	}

	alphaHalo( base, ALPHA_CUTOFF, 3 );
	return { base, normal, orm, sprites, avgLinear: avg };

}

// ---------------------------------------------------------------------------------------------------------------
// 2. Card meshes (prototype space, Y up; the twig grows along -Z from its attachment point at the origin)
// ---------------------------------------------------------------------------------------------------------------
// A card = list of islands; an island = { verts: [{ p, n, uv }], tris: [i, j, k, ...], centroid, up, area }.
// The artist's twig cards consist of one flat "spray" island (the twig seen from above) plus a few vertical "fin"
// islands that re-use part of the sprite and give the twig thickness when it is seen edge-on.
function finishIsland( verts, tris ) {

	let area = 0;
	const centroid = [ 0, 0, 0 ], up = [ 0, 0, 0 ];
	for ( let t = 0; t < tris.length; t += 3 ) {

		const a = verts[ tris[ t ] ].p, b = verts[ tris[ t + 1 ] ].p, c = verts[ tris[ t + 2 ] ].p;
		const n = v3.cross( v3.sub( b, a ), v3.sub( c, a ) );
		const ar = v3.len( n ) / 2;
		area += ar;
		for ( let k = 0; k < 3; k ++ ) {

			centroid[ k ] += ar * ( a[ k ] + b[ k ] + c[ k ] ) / 3;
			up[ k ] += n[ k ] / 2;

		}

	}

	for ( let k = 0; k < 3; k ++ ) centroid[ k ] /= area || 1;
	return { verts, tris, centroid, up: v3.norm( up ), area, planarity: v3.len( up ) / ( area || 1 ) };

}

function makeCard( islands ) {

	const card = { islands, tris: [], area: 0, centroid: [ 0, 0, 0 ] };
	let n = 0;
	for ( const isl of islands ) {

		n += isl.tris.length;
		card.area += isl.area;
		for ( let k = 0; k < 3; k ++ ) card.centroid[ k ] += isl.centroid[ k ] * isl.area;

	}

	for ( let k = 0; k < 3; k ++ ) card.centroid[ k ] /= card.area || 1;
	card.tris.length = n; // only the count is used by the budget code
	return card;

}

// polygon islands of a prototype dump, largest area first
function protoIslands( d ) {

	const dsu = new DSU( d.nv );
	for ( let p = 0; p < d.np; p ++ ) for ( let c = 1; c < d.polyCount[ p ]; c ++ ) dsu.union( d.cornerVert[ d.polyStart[ p ] ], d.cornerVert[ d.polyStart[ p ] + c ] );
	const map = new Map();
	for ( let p = 0; p < d.np; p ++ ) {

		const r = dsu.find( d.cornerVert[ d.polyStart[ p ] ] );
		if ( ! map.has( r ) ) map.set( r, [] );
		map.get( r ).push( p );

	}

	return [ ...map.values() ];

}

// the artist's cut-out polygons of one island, UVs moved into our atlas
function islandFromDump( d, polys, sprite ) {

	const verts = [], tris = [];
	const map = new Map();
	const vert = ( c ) => {

		const v = d.cornerVert[ c ];
		const key = v + '/' + d.uv[ c * 2 ].toFixed( 6 ) + '/' + d.uv[ c * 2 + 1 ].toFixed( 6 );
		let i = map.get( key );
		if ( i === undefined ) {

			i = verts.length;
			verts.push( {
				p: [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ],
				n: v3.norm( [ d.normal[ c * 3 ], d.normal[ c * 3 + 1 ], d.normal[ c * 3 + 2 ] ] ),
				uv: sprite.toAtlas( d.uv[ c * 2 ], d.uv[ c * 2 + 1 ] ),
			} );
			map.set( key, i );

		}

		return i;

	};

	for ( const p of polys ) {

		const s = d.polyStart[ p ], n = d.polyCount[ p ];
		for ( let k = 1; k < n - 1; k ++ ) tris.push( vert( s ), vert( s + k ), vert( s + k + 1 ) );

	}

	return finishIsland( verts, tris );

}

function cardFromDump( d, sprite ) {

	return makeCard( protoIslands( d ).map( ( polys ) => islandFromDump( d, polys, sprite ) ).sort( ( a, b ) => b.area - a.area ) );

}

// a bent grid (nu x nv quads over the island's UV bounding box) fitted to one island of the prototype
function islandFromFit( d, polys, sprite, nu, nv ) {

	let u0 = Infinity, u1 = - Infinity, v0 = Infinity, v1 = - Infinity;
	const corners = [];
	for ( const p of polys ) for ( let c = d.polyStart[ p ]; c < d.polyStart[ p ] + d.polyCount[ p ]; c ++ ) corners.push( c );
	for ( const c of corners ) {

		u0 = Math.min( u0, d.uv[ c * 2 ] );
		u1 = Math.max( u1, d.uv[ c * 2 ] );
		v0 = Math.min( v0, d.uv[ c * 2 + 1 ] );
		v1 = Math.max( v1, d.uv[ c * 2 + 1 ] );

	}

	const samples = [];
	const seen = new Set();
	const mean = [ 0, 0, 0 ];
	for ( const c of corners ) {

		const v = d.cornerVert[ c ];
		for ( let k = 0; k < 3; k ++ ) mean[ k ] += d.normal[ c * 3 + k ];
		const key = v + '/' + d.uv[ c * 2 ].toFixed( 5 ) + '/' + d.uv[ c * 2 + 1 ].toFixed( 5 );
		if ( seen.has( key ) ) continue;
		seen.add( key );
		samples.push( { uv: [ ( d.uv[ c * 2 ] - u0 ) / ( u1 - u0 ) * 2 - 1, ( d.uv[ c * 2 + 1 ] - v0 ) / ( v1 - v0 ) * 2 - 1 ], p: [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ] } );

	}

	// planar fit for single quads, "bent along v" when there are enough samples and rows
	const fit = fitSurface( samples, false, nv > 1 && samples.length >= 8 );
	const verts = [], tris = [];
	const sign = v3.dot( fit.evalN( 0, 0 ), mean ) < 0 ? - 1 : 1;
	for ( let j = 0; j <= nv; j ++ ) for ( let i = 0; i <= nu; i ++ ) {

		const a = i / nu * 2 - 1, b = j / nv * 2 - 1;
		verts.push( { p: fit.evalP( a, b ), n: v3.scale( fit.evalN( a, b ), sign ), uv: sprite.toAtlas( u0 + ( u1 - u0 ) * i / nu, v0 + ( v1 - v0 ) * j / nv ) } );

	}

	for ( let j = 0; j < nv; j ++ ) for ( let i = 0; i < nu; i ++ ) {

		const a = j * ( nu + 1 ) + i, b = a + 1, c = a + nu + 1, e = c + 1;
		if ( sign > 0 ) tris.push( a, b, e, a, e, c ); else tris.push( a, e, b, a, c, e );

	}

	const isl = finishIsland( verts, tris );
	isl.fitRms = fit.rms;
	return isl;

}

// simplified card sets of a prototype:  x6 = bent spray strip + stem fin, x4 = spray quad + stem fin, x2 = spray quad
function simpleCards( d, sprite ) {

	const islands = protoIslands( d ).map( ( polys ) => ( { polys, ref: islandFromDump( d, polys, sprite ) } ) ).sort( ( a, b ) => b.ref.area - a.ref.area );
	const spray = islands[ 0 ];
	// the fin that runs along the main stem: long in z, plane normal across the stem
	let stemFin = null, best = 0;
	for ( const isl of islands.slice( 1 ) ) {

		let z0 = Infinity, z1 = - Infinity;
		for ( const v of isl.ref.verts ) {

			z0 = Math.min( z0, v.p[ 2 ] );
			z1 = Math.max( z1, v.p[ 2 ] );

		}

		const score = ( z1 - z0 ) * Math.abs( isl.ref.up[ 0 ] );
		if ( score > best ) {

			best = score;
			stemFin = isl;

		}

	}

	const fin = stemFin ? islandFromFit( d, stemFin.polys, sprite, 1, 1 ) : null;
	const strip = islandFromFit( d, spray.polys, sprite, 1, 2 ), quad = islandFromFit( d, spray.polys, sprite, 1, 1 );
	return {
		x6: makeCard( fin ? [ strip, fin ] : [ strip ] ),
		x4: makeCard( fin ? [ quad, fin ] : [ quad ] ),
		x2: makeCard( [ quad ] ),
		fitRms: [ strip.fitRms, quad.fitRms, fin ? fin.fitRms : 0 ],
	};

}

// ---------------------------------------------------------------------------------------------------------------
// 3. Emitting instances
// ---------------------------------------------------------------------------------------------------------------
// direction "out of the crown" used to bend the card normals (trees are centred on x = z = 0)
function outward( p, upTilt = 0.6 ) {

	const r = Math.hypot( p[ 0 ], p[ 2 ] );
	if ( r < 1e-4 ) return [ 0, 1, 0 ];
	const k = Math.min( 1, r / 0.5 );
	return v3.norm( [ p[ 0 ] / r * k, upTilt + ( 1 - k ), p[ 2 ] / r * k ] );

}

// tint multiplier of the source needle material: mix(MULTIPLY, colour, dark green, 0.5 * ramp(noise(position)))
const DARK = [ 0.086, 0.1383, 0.0264 ];
function needleTint( p, seed ) {

	const n = noise3( p, 1.0, seed );
	const f = 0.5 * Math.max( 0, Math.min( 1, ( n - 0.313 ) / ( 0.781 - 0.313 ) ) );
	return [ 1 - f * ( 1 - DARK[ 0 ] ), 1 - f * ( 1 - DARK[ 1 ] ), 1 - f * ( 1 - DARK[ 2 ] ) ];

}

function emitCards( mb, instances, cardOf, opts ) {

	const { puff, grid, seed, aoMin, scaleOf, crownCenter } = opts;
	for ( const inst of instances ) {

		const card = cardOf( inst );
		if ( ! card ) continue;
		const T = inst.T;
		const g = scaleOf ? scaleOf( inst ) : 1;
		// enlarged cards (LOD2) grow towards the inside of the crown: the scaling pivot is the card's outermost point,
		// so the silhouette of the tree does not swell
		let cardC = applySim( T, card.centroid );
		if ( g !== 1 && crownCenter ) {

			const dir = v3.norm( v3.sub( cardC, crownCenter ) );
			let best = - Infinity, tip = cardC;
			for ( const isl of card.islands ) for ( const v of isl.verts ) {

				const p = applySim( T, v.p );
				const dd = v3.dot( v3.sub( p, crownCenter ), dir );
				if ( dd > best ) {

					best = dd;
					tip = p;

				}

			}

			cardC = v3.lerp( cardC, tip, 0.8 );

		}

		for ( const isl of card.islands ) {

			const upW = m3.mulv( T.R, isl.up );
			// every island is wound so that its front face looks out of the crown (two-sided lighting flips the normal
			// for back faces, so the stored normal has to be the front-face normal)
			const flip = v3.dot( upW, outward( applySim( T, isl.centroid ) ) ) < 0;
			const ids = [];
			for ( const v of isl.verts ) {

				let p = applySim( T, v.p );
				if ( g !== 1 ) p = v3.add( cardC, v3.scale( v3.sub( p, cardC ), g ) );
				let n = m3.mulv( T.R, v.n );
				if ( flip ) n = v3.scale( n, - 1 );
				n = v3.norm( v3.add( v3.scale( n, 1 - puff ), v3.scale( outward( p ), puff ) ) );
				const tint = needleTint( p, seed );
				const ao = grid ? aoMin + ( 1 - aoMin ) * Math.pow( grid.visibility( p ), 0.75 ) : 1;
				ids.push( mb.addVertex( p, n, v.uv, [ tint[ 0 ] * ao, tint[ 1 ] * ao, tint[ 2 ] * ao ] ) );

			}

			for ( let t = 0; t < isl.tris.length; t += 3 ) {

				if ( flip ) mb.addTri( ids[ isl.tris[ t ] ], ids[ isl.tris[ t + 2 ] ], ids[ isl.tris[ t + 1 ] ] );
				else mb.addTri( ids[ isl.tris[ t ] ], ids[ isl.tris[ t + 1 ] ], ids[ isl.tris[ t + 2 ] ] );

			}

		}

	}

}

// ---------------------------------------------------------------------------------------------------------------
// 4. Branch tubes of a tree dump (material = bark / branches)
// ---------------------------------------------------------------------------------------------------------------
function extractTubes( tree, matIndex ) {

	// islands of the given material
	const dsu = new DSU( tree.nv );
	const used = new Uint8Array( tree.nv );
	for ( let p = 0; p < tree.np; p ++ ) {

		if ( tree.polyMat[ p ] !== matIndex ) continue;
		const s = tree.polyStart[ p ];
		for ( let c = 0; c < tree.polyCount[ p ]; c ++ ) {

			used[ tree.cornerVert[ s + c ] ] = 1;
			if ( c ) dsu.union( tree.cornerVert[ s ], tree.cornerVert[ s + c ] );

		}

	}

	const islands = new Map();
	for ( let p = 0; p < tree.np; p ++ ) {

		if ( tree.polyMat[ p ] !== matIndex ) continue;
		const r = dsu.find( tree.cornerVert[ tree.polyStart[ p ] ] );
		if ( ! islands.has( r ) ) islands.set( r, [] );
		islands.get( r ).push( p );

	}

	const getPos = ( v ) => [ tree.position[ v * 3 ], tree.position[ v * 3 + 1 ], tree.position[ v * 3 + 2 ] ];
	const tubes = [];
	for ( const polys of islands.values() ) {

		const adjacency = new Map();
		const edgeCount = new Map();
		const vsum = new Map(); // vertex -> [sum v, n]
		for ( const p of polys ) {

			const s = tree.polyStart[ p ], n = tree.polyCount[ p ];
			for ( let c = 0; c < n; c ++ ) {

				const a = tree.cornerVert[ s + c ], b = tree.cornerVert[ s + ( c + 1 ) % n ];
				if ( ! adjacency.has( a ) ) adjacency.set( a, new Set() );
				if ( ! adjacency.has( b ) ) adjacency.set( b, new Set() );
				adjacency.get( a ).add( b );
				adjacency.get( b ).add( a );
				const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
				edgeCount.set( key, ( edgeCount.get( key ) || 0 ) + 1 );
				const e = vsum.get( a ) || [ 0, 0 ];
				e[ 0 ] += tree.uv[ ( s + c ) * 2 + 1 ];
				e[ 1 ] ++;
				vsum.set( a, e );

			}

		}

		const boundary = [];
		for ( const [ key, n ] of edgeCount ) if ( n === 1 ) boundary.push( [ Math.floor( key / 4294967296 ), key % 4294967296 ] );
		const rings = ringsFromTube( [ ...adjacency.keys() ], adjacency, boundary, getPos );
		if ( ! rings || rings.length < 2 ) continue;
		let length = 0;
		for ( let i = 1; i < rings.length; i ++ ) length += v3.len( v3.sub( rings[ i ].c, rings[ i - 1 ].c ) );
		for ( const r of rings ) {

			let s = 0;
			for ( const v of r.ids ) s += vsum.get( v )[ 0 ] / vsum.get( v )[ 1 ];
			r.srcV = s / r.ids.length;

		}

		tubes.push( { rings, length, radius: rings[ 0 ].r, sides: rings[ 0 ].n, verts: adjacency.size, polys: polys.length } );

	}

	return tubes;

}

// ---------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------
const t0 = Date.now();
const log = ( ...a ) => console.log( `[${( ( Date.now() - t0 ) / 1000 ).toFixed( 1 )}s]`, ...a );

// --- load prototypes
for ( const g of sp.groups ) {

	g.protoKeys = Object.keys( g.protos );
	g.lod1 = g.protoKeys.map( ( k ) => loadDump( g.src, g.protos[ k ] + '_LOD1' ) );
	g.lod2 = g.protoKeys.map( ( k ) => loadDump( g.src, g.protos[ k ] + '_LOD2' ) );

}

// --- needle atlas + card sets
let needles;
if ( sp.needleMode === 'repack' ) {

	const byKey = {};
	for ( const g of sp.groups ) g.protoKeys.forEach( ( k, i ) => ( byKey[ k ] = byKey[ k ] || [] ).push( g.lod1[ i ] ) );
	needles = await repackNeedleAtlas( byKey );
	for ( const g of sp.groups ) {

		g.cards = g.protoKeys.map( ( k, i ) => {

			const simple = simpleCards( g.lod1[ i ], needles.sprites[ k ] );
			return { key: k, hi: cardFromDump( g.lod1[ i ], needles.sprites[ k ] ), mid: cardFromDump( g.lod2[ i ], needles.sprites[ k ] ), ...simple };

		} );
		log( `${g.src}: simplified card fit rms (strip, quad, fin) ` + g.cards.map( ( c ) => `${c.key} ${c.fitRms.map( ( x ) => x.toFixed( 3 ) ).join( '/' )}` ).join( ' | ' ) );

	}

} else {

	needles = await bakeNeedleSprites( sp, NEEDLE_ATLAS, log );
	for ( const g of sp.groups ) g.cards = g.protoKeys.map( ( k ) => needles.cards[ k ] );

}

log( 'needle atlas ready; sprites:', Object.keys( needles.sprites ).join( ', ' ) );
if ( DEBUG_ATLAS ) {

	await savePng( needles.base, join( BUILD, `${speciesName}_needles_base.png` ) );
	await savePng( needles.normal, join( BUILD, `${speciesName}_needles_normal.png` ) );
	await savePng( needles.orm, join( BUILD, `${speciesName}_needles_orm.png` ) );

}

// --- bark atlas (scanned trunk bases with the bark blended in, tiling bark, branch bark, dead branch bark)
const bark = await buildBarkAtlas( sp, log );
if ( DEBUG_ATLAS ) {

	await savePng( bark.base, join( BUILD, `${speciesName}_bark_base.png` ) );
	await savePng( bark.normal, join( BUILD, `${speciesName}_bark_normal.png` ) );
	await savePng( bark.orm, join( BUILD, `${speciesName}_bark_orm.png` ) );

}

// --- variants
const variants = [];
const report = { species: speciesName, variants: [], needleAvgLinear: needles.avgLinear, barkAvgLinear: bark.avgLinear };
let seedCounter = 11;
for ( const g of sp.groups ) {

	for ( const [ vk, vname ] of g.variants ) {

		if ( ONLY && ONLY !== vname ) continue;
		const budget = BUDGET[ g.klass ];
		const tree = loadDump( g.src, g.tree( vk ) );
		const mats = tree.meta.materials;
		const mi = ( re ) => ( re ? mats.findIndex( ( m ) => m && re.test( m ) ) : - 1 );
		const mTwig = mi( g.mats.twig ), mBark = mi( g.mats.bark ), mTrunk = mi( g.mats.trunk ), mDead = mi( g.mats.dead );
		const seed = seedCounter ++;

		// ---- recentre: x/z on the trunk axis at ground level, ground plane y = 0
		const tubes = extractTubes( tree, mBark );
		let axis = [ 0, 0 ], ground = 0, stem = null, scan = null;
		if ( g.trunk ) {

			scan = buildScanTrunk( loadDump( g.src, g.trunk( vk ) ), bark, vk );
			axis = scan.axis;
			ground = scan.ground;
			log( `${vname}: scan base ${scan.scanTriangles} tris, ${scan.droppedPureBark} pure-bark tris re-mapped to the bark tile from y=${scan.yLow.toFixed( 2 )}, junction y=${scan.junction.c[ 1 ].toFixed( 2 )} r=${scan.junction.r.toFixed( 3 )}, ground=${ground.toFixed( 3 )}, trunk r@1m=${scan.trunkRadius.toFixed( 3 )}` );

		} else {

			// the main stem is the tube with the most rings that starts at the ground
			stem = tubes.slice().sort( ( a, b ) => b.rings.length - a.rings.length )[ 0 ];
			const base = stem.rings[ 0 ].c[ 1 ] < stem.rings[ stem.rings.length - 1 ].c[ 1 ] ? stem.rings[ 0 ] : stem.rings[ stem.rings.length - 1 ];
			axis = [ base.c[ 0 ], base.c[ 2 ] ];
			ground = 0;

		}

		const shift = [ - axis[ 0 ], - ground, - axis[ 1 ] ];
		const move = ( p ) => [ p[ 0 ] + shift[ 0 ], p[ 1 ] + shift[ 1 ], p[ 2 ] + shift[ 2 ] ];

		// ---- instances
		const inst = findInstances( tree, g.lod1, mTwig );
		if ( inst.unmatchedPolys ) throw new Error( `${vname}: ${inst.unmatchedPolys} foliage polygons are not prototype copies` );
		for ( const it of inst ) it.T = { ...it.T, t: move( it.T.t ) };
		log( `${vname}: ${inst.length} twig instances, ${tubes.length} branch tubes` );
		if ( process.env.TUBE_STATS ) {

			const h = new Map();
			for ( const t of tubes ) {

				const k = `${t.sides}x${t.rings.length} r${( Math.round( t.radius * 200 ) / 200 ).toFixed( 3 )}`;
				const e = h.get( k ) || { n: 0, len: 0 };
				e.n ++;
				e.len += t.length;
				h.set( k, e );

			}

			console.log( [ ...h.entries() ].sort( ( a, b ) => b[ 1 ].n - a[ 1 ].n ).slice( 0, 30 ).map( ( [ k, e ] ) => `${k}: n=${e.n} meanLen=${( e.len / e.n ).toFixed( 2 )}` ).join( '\n' ) );

		}

		// ---- crown density grid for the sky-visibility AO (built from the full-detail cards, shared by all LODs)
		const probe = new MeshBuilder();
		emitCards( probe, inst, ( it ) => g.cards[ it.proto ].hi, { puff: 0, grid: null, seed, aoMin: 1 } );
		const pb = probe.bounds();
		const grid = new DensityGrid( pb.min, pb.max, g.klass === 'tall' ? 0.3 : 0.2 );
		const COVER = needles.coverage ?? 0.4;
		for ( let t = 0; t < probe.idx.length; t += 3 ) {

			const a = probe.idx[ t ] * 3, b = probe.idx[ t + 1 ] * 3, c = probe.idx[ t + 2 ] * 3;
			const A = [ probe.pos[ a ], probe.pos[ a + 1 ], probe.pos[ a + 2 ] ], B = [ probe.pos[ b ], probe.pos[ b + 1 ], probe.pos[ b + 2 ] ], C = [ probe.pos[ c ], probe.pos[ c + 1 ], probe.pos[ c + 2 ] ];
			const area = v3.len( v3.cross( v3.sub( B, A ), v3.sub( C, A ) ) ) / 2;
			grid.add( [ ( A[ 0 ] + B[ 0 ] + C[ 0 ] ) / 3, ( A[ 1 ] + B[ 1 ] + C[ 1 ] ) / 3, ( A[ 2 ] + B[ 2 ] + C[ 2 ] ) / 3 ], area * COVER );

		}

		grid.finalize();
		const aoAt = ( p, aoMin ) => aoMin + ( 1 - aoMin ) * Math.pow( grid.visibility( p ), 0.75 );

		// ---- wood (trunk, branches, dead branches) per LOD
		const wood = [ new MeshBuilder(), new MeshBuilder(), new MeshBuilder() ];
		const woodInfo = buildWood( { g, vk, vname, tree, tubes, stem, scan, mDead, move, aoAt, wood, klass: g.klass } );

		// ---- foliage per LOD
		const foliage = [ new MeshBuilder(), new MeshBuilder(), new MeshBuilder() ];
		const AO_MIN = 0.55;
		const order = inst.map( ( it, i ) => i );
		const rand = rng( seed * 7919 );
		const rank = inst.map( () => rand() );
		// LOD0: the most detailed card set that fits the budget
		const cardBudget0 = budget[ 0 ] - wood[ 0 ].triangleCount;
		const trisOf = ( sel ) => inst.reduce( ( s, it ) => s + ( g.cards[ it.proto ][ sel ]?.tris.length || 0 ) / 3, 0 );
		// per prototype: the artist's LOD1 card ("hi") where the budget allows, else the LOD2 card ("mid")
		const setOf = g.cards.map( () => ( needles.lodSets ? needles.lodSets[ 0 ] : 'mid' ) );
		if ( ! needles.lodSets ) {

			const count = g.cards.map( ( c, i ) => inst.filter( ( it ) => it.proto === i ).length );
			let total = trisOf( 'mid' );
			const upgrades = g.cards.map( ( c, i ) => ( { i, cost: count[ i ] * ( c.hi.tris.length - c.mid.tris.length ) / 3 } ) ).filter( ( u ) => u.cost > 0 ).sort( ( a, b ) => a.cost - b.cost );
			for ( const u of upgrades ) if ( total + u.cost <= cardBudget0 ) {

				setOf[ u.i ] = 'hi';
				total += u.cost;

			}

		}

		const lod0Set = g.protoKeys.map( ( k, i ) => `${k}:${setOf[ i ]}` ).filter( ( x, i ) => inst.some( ( it ) => it.proto === i ) ).join( ' ' );
		emitCards( foliage[ 0 ], inst, ( it ) => g.cards[ it.proto ][ setOf[ it.proto ] ], { puff: 0.35, grid, seed, aoMin: AO_MIN } );
		// LOD1 / LOD2: simplified cards. Pick the richest set whose total fits; if even the leanest allowed set does not
		// fit, keep the best-ranked instances and scale them up so the total card area (density, silhouette) is kept.
		const selectScaled = ( set, triBudget ) => {

			const sorted = order.slice().sort( ( a, b ) => rank[ a ] - rank[ b ] );
			let tris = 0, keptArea = 0, totalArea = 0;
			const keep = new Set();
			for ( const i of sorted ) {

				const card = g.cards[ inst[ i ].proto ][ set ];
				if ( ! card ) continue;
				const area = card.area * inst[ i ].T.s ** 2;
				totalArea += area;
				if ( tris + card.tris.length / 3 <= triBudget ) {

					tris += card.tris.length / 3;
					keptArea += area;
					keep.add( i );

				}

			}

			const gscale = Math.min( 2.6, Math.sqrt( totalArea / Math.max( keptArea, 1e-9 ) ) );
			return { set, keep, gscale, kept: keep.size };

		};

		const pick = ( sets, triBudget ) => {

			for ( const set of sets ) if ( trisOf( set ) <= triBudget ) return selectScaled( set, triBudget );
			return selectScaled( sets[ sets.length - 1 ], triBudget );

		};

		const s1 = pick( needles.lodSets ? needles.lodSets[ 1 ] : [ 'x6', 'x4' ], budget[ 1 ] - wood[ 1 ].triangleCount );
		const crownCenter = [ 0, ( pb.min[ 1 ] + pb.max[ 1 ] ) / 2, 0 ];
		emitCards( foliage[ 1 ], inst.filter( ( it, i ) => s1.keep.has( i ) ), ( it ) => g.cards[ it.proto ][ s1.set ], { puff: 0.45, grid, seed, aoMin: AO_MIN, scaleOf: () => s1.gscale, crownCenter } );
		const s2 = pick( needles.lodSets ? needles.lodSets[ 2 ] : [ 'x4' ], budget[ 2 ] - wood[ 2 ].triangleCount );
		emitCards( foliage[ 2 ], inst.filter( ( it, i ) => s2.keep.has( i ) ), ( it ) => g.cards[ it.proto ][ s2.set ], { puff: 0.6, grid, seed, aoMin: AO_MIN, scaleOf: () => s2.gscale, crownCenter } );
		log( `${vname}: LOD0 cards=${lod0Set} ${foliage[ 0 ].triangleCount}t | LOD1 ${s1.set} ${s1.kept}/${inst.length} cards x${s1.gscale.toFixed( 2 )} ${foliage[ 1 ].triangleCount}t | LOD2 ${s2.set} ${s2.kept}/${inst.length} cards x${s2.gscale.toFixed( 2 )} ${foliage[ 2 ].triangleCount}t` );

		// ---- convention: min y = 0. Whatever sits below the ground line (scan patch edge, stem extension) is
		//      reported as "sink": the runtime places the tree at terrainHeight - sink.
		let minY = Infinity;
		for ( const mb of [ ...wood, ...foliage ] ) if ( mb.triangleCount ) minY = Math.min( minY, mb.bounds().min[ 1 ] );
		for ( const mb of [ ...wood, ...foliage ] ) mb.translate( [ 0, - minY, 0 ] );
		const sink = Math.max( 0, - minY );

		// ---- measurements
		const fb = foliage[ 0 ].bounds(), wb = wood[ 0 ].bounds();
		const min = fb.min.map( ( x, k ) => Math.min( x, wb.min[ k ] ) ), max = fb.max.map( ( x, k ) => Math.max( x, wb.max[ k ] ) );
		let radius = 0, crownRadius = 0;
		for ( const mb of [ foliage[ 0 ], wood[ 0 ] ] ) for ( let i = 0; i < mb.pos.length; i += 3 ) radius = Math.max( radius, Math.hypot( mb.pos[ i ], mb.pos[ i + 2 ] ) );
		for ( let i = 0; i < foliage[ 0 ].pos.length; i += 3 ) crownRadius = Math.max( crownRadius, Math.hypot( foliage[ 0 ].pos[ i ], foliage[ 0 ].pos[ i + 2 ] ) );
		// mean vertex colour of the foliage (area weighted would be nicer; vertices are evenly spread over the cards)
		const vc = [ 0, 0, 0 ];
		for ( let i = 0; i < foliage[ 0 ].col.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) vc[ k ] += foliage[ 0 ].col[ i + k ] / ( foliage[ 0 ].col.length / 3 );
		for ( const [ label, mbs ] of [ [ 'wood', wood ], [ 'foliage', foliage ] ] ) mbs.forEach( ( mb, l ) => {

			let lo = Infinity, hi = - Infinity;
			for ( const x of mb.uv ) {

				lo = Math.min( lo, x );
				hi = Math.max( hi, x );

			}

			if ( lo < 0 || hi > 1 ) console.warn( `WARNING ${vname} ${label} LOD${l}: uv range ${lo.toFixed( 4 )}..${hi.toFixed( 4 )}` );

		} );
		const lods = [ 0, 1, 2 ].map( ( l ) => ( { node: `${vname}_LOD${l}`, triangles: wood[ l ].triangleCount + foliage[ l ].triangleCount, woodTriangles: wood[ l ].triangleCount, foliageTriangles: foliage[ l ].triangleCount } ) );
		for ( let l = 0; l < 3; l ++ ) if ( lods[ l ].triangles > budget[ l ] ) console.warn( `WARNING ${vname} LOD${l}: ${lods[ l ].triangles} triangles > budget ${budget[ l ]}` );
		report.variants.push( {
			name: vname, klass: g.klass, source: g.src, sourceVariant: vk,
			size: [ max[ 0 ] - min[ 0 ], max[ 1 ] - min[ 1 ], max[ 2 ] - min[ 2 ] ], min, max, radius, crownRadius,
			height: max[ 1 ] - sink, sink,
			trunkRadius: woodInfo.trunkRadius, groundPatchRadius: woodInfo.groundPatchRadius || 0,
			crownBase: fb.min[ 1 ] - sink, instances: inst.length, lods,
			foliageVertexColorLinear: vc, lod0CardSet: lod0Set,
		} );
		variants.push( { name: vname, lods: [ 0, 1, 2 ].map( ( l ) => ( { parts: [ { material: `${speciesName}_bark`, mb: wood[ l ] }, { material: `${speciesName}_needles`, mb: foliage[ l ] } ] } ) ) } );
		log( `${vname}: size ${report.variants.at( - 1 ).size.map( ( x ) => x.toFixed( 2 ) )} tris ${lods.map( ( l ) => l.triangles )} (wood ${lods.map( ( l ) => l.woodTriangles )})` );

	}

}

// ---------------------------------------------------------------------------------------------------------------
// Wood: trunk + branches + dead branches for the three LODs
// ---------------------------------------------------------------------------------------------------------------
function buildWood( { g, vk, vname, tree, tubes, stem, scan, mDead, move, aoAt, wood, klass } ) {

	const info = { sink: 0, trunkRadius: 0 };
	const tall = klass === 'tall';
	// ---- trunk
	if ( scan ) {

		// photo-scanned base + generated upper tube (tall trees)
		const r = scan.emit( wood, move, aoAt );
		Object.assign( info, r );

	} else {

		// young tree: the main stem is a plain tube -> cylindrical bark tile mapping
		const rings = stem.rings.slice();
		if ( rings[ 0 ].c[ 1 ] > rings[ rings.length - 1 ].c[ 1 ] ) rings.reverse();
		const base = rings[ 0 ];
		// radius at 1 m
		let r1 = base.r;
		for ( let i = 1; i < rings.length; i ++ ) if ( rings[ i - 1 ].c[ 1 ] <= 1 && rings[ i ].c[ 1 ] >= 1 ) {

			const t = ( 1 - rings[ i - 1 ].c[ 1 ] ) / ( rings[ i ].c[ 1 ] - rings[ i - 1 ].c[ 1 ] );
			r1 = rings[ i - 1 ].r + ( rings[ i ].r - rings[ i - 1 ].r ) * t;

		}

		info.trunkRadius = r1;
		// extend the stem 0.35 m below the ground so it stays closed on slopes; the convention wants min y = 0, so the
		// whole tree is lifted by that amount and "sink" tells the runtime to push it back down
		const SINK = 0.35;
		info.sink = SINK;
		const period = Math.max( 0.5, 2 * 2 * Math.PI * r1 ); // bark tile repeats every 2 circumferences (1:2 tile)
		const specs = [ { sides: 8, maxRings: 22, tol: 0.006 }, { sides: 5, maxRings: 9, tol: 0.02 }, { sides: 4, maxRings: 5, tol: 0.05 } ];
		specs.forEach( ( s, l ) => {

			const sel = decimateRings( rings, s.maxRings, s.tol );
			const list = [ { c: [ base.c[ 0 ], base.c[ 1 ] - SINK, base.c[ 2 ] ], r: base.r * 1.25 }, ...sel ].map( ( r ) => ( { c: move( r.c ), r: r.r } ) );
			bark.emitTiledTube( wood[ l ], list, s.sides, period, ( p ) => aoAt( p, 0.7 ), l === 0 );

		} );

	}

	// ---- branches
	// tall trees: twig stems thinner than 7.5 mm sit 6+ m above the ground under the cards (whose sprites show the
	// stems anyway) -> not worth 6 triangles each. Young trees keep them (they are seen from close by).
	const branchSpecs = tall
		? [ { sides: 4, maxRings: 6, tol: 0.012, minLen: 0, minRadius: 0.0075, thinSides: 3 }, { sides: 3, maxRings: 3, tol: 0.05, minLen: 0.9, minRadius: 0.012, thinSides: 3 }, null ]
		: [ { sides: 4, maxRings: 5, tol: 0.012, minLen: 0, minRadius: 0, thinSides: 3 }, { sides: 3, maxRings: 2, tol: 0.06, minLen: 0.8, minRadius: 0.008, thinSides: 3 }, null ];
	branchSpecs.forEach( ( s, l ) => {

		if ( ! s ) return;
		for ( const t of tubes ) {

			if ( t === stem ) continue;
			if ( t.length < s.minLen || t.radius < s.minRadius ) continue;
			const thin = t.radius < 0.012;
			const sel = decimateRings( t.rings, thin ? 2 : s.maxRings, s.tol );
			const list = sel.map( ( r ) => ( { c: move( r.c ), r: Math.max( r.r, l === 0 ? 0.004 : 0.008 ), srcV: r.srcV } ) );
			bark.emitBranchTube( wood[ l ], list, thin ? s.thinSides : s.sides, ( p ) => aoAt( p, 0.45 ) );

		}

	} );

	// ---- dead branches (solid twiggy meshes near the lower trunk): simplified, LOD0 and LOD1 only
	if ( mDead >= 0 ) {

		const m = bark.deadMesh( tree, mDead, move );
		const targets = tall ? [ 0.45, 0.1, 0 ] : [ 0.5, 0.1, 0 ];
		targets.forEach( ( f, l ) => {

			if ( f <= 0 ) return;
			const target = Math.round( m.idx.length / 3 * f );
			const { idx } = simplifyMesh( m, target, { error: l === 0 ? 0.01 : 0.05, uvWeight: 0.2, normalWeight: 0.1 } );
			const c = compactMesh( m, idx );
			const mb = wood[ l ];
			const base = mb.vertexCount;
			for ( let i = 0; i < c.pos.length / 3; i ++ ) {

				const p = [ c.pos[ i * 3 ], c.pos[ i * 3 + 1 ], c.pos[ i * 3 + 2 ] ];
				const a = aoAt( p, 0.55 );
				mb.addVertex( p, [ c.nor[ i * 3 ], c.nor[ i * 3 + 1 ], c.nor[ i * 3 + 2 ] ], [ c.uv[ i * 2 ], c.uv[ i * 2 + 1 ] ], [ a, a, a ] );

			}

			for ( let i = 0; i < c.idx.length; i += 3 ) mb.addTri( base + c.idx[ i ], base + c.idx[ i + 1 ], base + c.idx[ i + 2 ] );

		} );

	}

	return info;

}

// ---------------------------------------------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------------------------------------------
const half = async ( img ) => resize( img, img.w / 2, img.h / 2 );
const materials = {
	[ `${speciesName}_bark` ]: {
		baseColor: await encode( bark.base, 'webp', { quality: 90 } ), baseColorMime: 'image/webp',
		normal: await encode( bark.normal, 'jpeg', { quality: 90 } ), normalMime: 'image/jpeg',
		orm: await encode( await half( bark.orm ), 'webp', { quality: 88 } ), ormMime: 'image/webp',
		roughness: 1, metallic: 0, doubleSided: false,
	},
	[ `${speciesName}_needles` ]: {
		baseColor: await encode( needles.base, 'webp', { quality: 92, alphaQuality: 100 } ), baseColorMime: 'image/webp',
		normal: await encode( await half( needles.normal ), 'jpeg', { quality: 90 } ), normalMime: 'image/jpeg',
		orm: await encode( await half( needles.orm ), 'webp', { quality: 88 } ), ormMime: 'image/webp',
		roughness: 1, metallic: 0, doubleSided: true, alphaMode: 'MASK', alphaCutoff: ALPHA_CUTOFF,
	},
};
const file = join( OUT, `${speciesName}${ONLY ? '_' + ONLY : ''}.glb` );
await writeGLB( file, variants, materials );
report.file = file;
report.bytes = statSync( file ).size;
report.textures = {
	bark: { baseColor: bark.base.w, normal: bark.normal.w, orm: bark.orm.w / 2 },
	needles: { baseColor: needles.base.w, normal: needles.normal.w / 2, orm: needles.orm.w / 2 },
};
if ( ! ONLY ) writeFileSync( join( BUILD, `${speciesName}.json` ), JSON.stringify( report, null, 1 ) );
log( `wrote ${file} (${( report.bytes / 1e6 ).toFixed( 2 )} MB)` );
