#!/usr/bin/env node
// Build public/assets/plants/grass.glb : 5 instancing-ready grass clump variants (2 LODs each) that share ONE 1024 atlas.
// Sources: Poly Haven grass_medium_01 (+ its dry_diff map) and grass_medium_02 (CC0).
// Method: dense rows of the photoscanned source clumps are rendered orthographically (software rasteriser) into "strip"
// cards (albedo + alpha + card-space normal + AO/rough); the clumps are procedural arrangements of bent strip cards.
//   node tools/assets/plants-build-grass.mjs [--debug <dir>]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import {
	SRC, OUT, TexSet, loadSoup, mergeMeshes, placeMesh, boundsOf, Raster, Atlas, encodeTextures, writeGLB,
	MeshBuilder, measure, rng, hex, round, v3,
} from './plants-lib.mjs';

const args = process.argv.slice( 2 );
const debugDir = args.includes( '--debug' ) ? args[ args.indexOf( '--debug' ) + 1 ] : null;
if ( debugDir ) mkdirSync( debugDir, { recursive: true } );

const ATLAS = 1024;
const PAD = 3;

// ---------------------------------------------------------------- sources

async function tex( id, diffOverride ) {

	return TexSet.load( {
		name: id,
		diff: diffOverride || join( SRC, id, 'textures', `${id}_diff_2k.jpg` ),
		alpha: join( SRC, id + '__maps', `${id}_alpha_2k.png` ),
		nor: join( SRC, id, 'textures', `${id}_nor_gl_2k.jpg` ),
		arm: join( SRC, id, 'textures', `${id}_arm_2k.jpg` ),
	} );

}

const T1 = await tex( 'grass_medium_01' );
const T1dry = await tex( 'grass_medium_01', join( SRC, 'grass_medium_01__maps', 'grass_medium_01_dry_diff_2k.jpg' ) );
const T2 = await tex( 'grass_medium_02' );
const T2dry = await tex( 'grass_medium_02', join( SRC, 'grass_medium_02__maps', 'grass_medium_02_dry_diff_2k.jpg' ) );

const clumps = {};
for ( const node of await loadSoup( join( SRC, 'grass_medium_01', 'grass_medium_01_2k.gltf' ) ) ) clumps[ 'm1_' + node.name.replace( 'grass_medium_01_', '' ).replace( '_LOD0', '' ) ] = mergeMeshes( node.prims );
for ( const node of await loadSoup( join( SRC, 'grass_medium_02', 'grass_medium_02_2k.gltf' ) ) ) clumps[ 'm2_' + node.name.replace( 'grass_medium_02_', '' ) ] = mergeMeshes( node.prims );

// ---------------------------------------------------------------- strip definitions
// A strip is a row of source clumps inside a slab (widthM x depthM), rendered from the front.
// items: list of [clumpName, weight, scaleMin, scaleMax, tex]. count = number of clumps planted.

const STRIPS = [];
function strip( name, widthM, heightM, count, items, opts = {} ) {

	STRIPS.push( { name, widthM, heightM, count, items, depthM: opts.depthM ?? 0.14, margin: opts.margin ?? 0.2, seed: opts.seed ?? STRIPS.length * 7919 + 17, grade: opts.grade ?? null, hMax: opts.hMax ?? heightM } );

}

const SHORT = [ [ 'm1_large_a', 3, 0.85, 1.0, T1 ], [ 'm1_large_b', 3, 0.85, 1.0, T1 ], [ 'm1_large_c', 3, 0.85, 1.05, T1 ], [ 'm1_small_a', 2, 0.9, 1.1, T1 ], [ 'm1_small_b', 2, 0.9, 1.2, T1 ], [ 'm1_mid_c', 1, 0.8, 1.0, T1 ] ];
const MID = [ [ 'm1_mid_a', 2, 0.95, 1.15, T1 ], [ 'm1_mid_b', 3, 1.0, 1.3, T1 ], [ 'm1_mid_c', 3, 1.1, 1.5, T1 ], [ 'm1_large_a', 2, 1.2, 1.45, T1 ], [ 'm1_large_b', 2, 1.2, 1.4, T1 ], [ 'm1_large_c', 2, 1.2, 1.5, T1 ], [ 'm1_tall_c', 1, 0.9, 1.05, T1 ] ];
const TALL = [ [ 'm1_tall_a', 3, 1.3, 1.55, T1 ], [ 'm1_tall_b', 3, 1.35, 1.65, T1 ], [ 'm1_tall_c', 3, 1.5, 1.9, T1 ], [ 'm1_mid_a', 3, 1.3, 1.6, T1 ], [ 'm1_mid_b', 2, 1.3, 1.6, T1 ], [ 'm1_large_b', 1, 1.3, 1.5, T1 ] ];
const DRY = [ [ 'm1_mid_a', 3, 1.1, 1.4, T1dry ], [ 'm1_mid_b', 3, 1.2, 1.6, T1dry ], [ 'm1_mid_c', 2, 1.3, 1.8, T1dry ], [ 'm1_large_c', 2, 1.3, 1.6, T1dry ], [ 'm1_tall_c', 1, 1.0, 1.3, T1dry ], [ 'm2_b', 2, 1.0, 1.3, T2dry ], [ 'm2_c', 1, 0.9, 1.1, T2dry ] ];
const DRY_GRADE = { desat: 0.35, gain: [ 1.1, 1.13, 1.12 ] };   // the dry_diff map is orange-brown; alpine dead grass is paler straw
const TUFT = [ [ 'm2_c', 3, 0.95, 1.2, T2 ], [ 'm2_d', 3, 0.9, 1.15, T2 ], [ 'm2_e', 3, 0.8, 1.0, T2 ], [ 'm2_b', 2, 1.0, 1.3, T2 ], [ 'm2_a', 1, 1.0, 1.4, T2 ] ];

strip( 'short_a', 0.42, 0.175, 7, SHORT );
strip( 'short_b', 0.42, 0.175, 6, SHORT );
strip( 'short_c', 0.42, 0.175, 8, SHORT );
strip( 'mid_a', 0.42, 0.28, 7, MID );
strip( 'mid_b', 0.42, 0.28, 6, MID );
strip( 'mid_c', 0.42, 0.28, 8, MID );
strip( 'tall_a', 0.33, 0.56, 7, TALL, { margin: 0.27 } );
strip( 'tall_b', 0.33, 0.56, 8, TALL, { margin: 0.27 } );
strip( 'tall_c', 0.33, 0.56, 6, TALL, { margin: 0.27 } );
strip( 'tuft_a', 0.335, 0.44, 7, TUFT, { margin: 0.3 } );
strip( 'tuft_b', 0.335, 0.44, 8, TUFT, { margin: 0.3 } );
strip( 'tuft_c', 0.335, 0.44, 6, TUFT, { margin: 0.3 } );
strip( 'dry_a', 0.335, 0.40, 8, DRY, { margin: 0.25, grade: DRY_GRADE } );
strip( 'dry_b', 0.335, 0.40, 9, DRY, { margin: 0.25, grade: DRY_GRADE } );
strip( 'dry_c', 0.335, 0.40, 7, DRY, { margin: 0.25, grade: DRY_GRADE } );

function pick( rand, items ) {

	let tot = 0;
	for ( const it of items ) tot += it[ 1 ];
	let r = rand() * tot;
	for ( const it of items ) {

		r -= it[ 1 ];
		if ( r <= 0 ) return it;

	}

	return items[ items.length - 1 ];

}

// ---------------------------------------------------------------- render strips

function renderStrip( s, pxPerM ) {

	const rand = rng( s.seed );
	const w = Math.round( s.widthM * pxPerM ), h = Math.round( s.heightM * pxPerM );
	const widthM = w / pxPerM, heightM = h / pxPerM;
	const raster = new Raster( w, h, widthM, heightM, 4 );
	const frame = { o: [ 0, 0, 0 ], u: [ 1, 0, 0 ], v: [ 0, 1, 0 ], n: [ 0, 0, 1 ] };
	const x0 = s.widthM * s.margin, x1 = s.widthM * ( 1 - s.margin );
	for ( let i = 0; i < s.count; i ++ ) {

		const it = pick( rand, s.items );
		// stratified along x so the strip is evenly filled, jittered
		const x = x0 + ( x1 - x0 ) * ( ( i + 0.15 + rand() * 0.7 ) / s.count );
		const z = ( rand() - 0.5 ) * s.depthM;
		let scale = it[ 2 ] + rand() * ( it[ 3 ] - it[ 2 ] );
		const src = clumps[ it[ 0 ] ];
		const srcH = boundsOf( src ).max[ 1 ];
		if ( srcH * scale > s.hMax * 0.97 ) scale = s.hMax * 0.97 / srcH;
		const m = placeMesh( src, { rotY: rand() * Math.PI * 2, scale, tx: x, tz: z, mirror: rand() < 0.5 } );
		raster.draw( m, frame, { tex: it[ 4 ], tag: i } );

	}

	const r = raster.resolve();
	if ( s.grade ) {

		const { desat, gain } = s.grade;
		for ( let k = 0; k < w * h; k ++ ) {

			const L = 0.2126 * r.rgb[ k * 3 ] + 0.7152 * r.rgb[ k * 3 + 1 ] + 0.0722 * r.rgb[ k * 3 + 2 ];
			for ( let c = 0; c < 3; c ++ ) r.rgb[ k * 3 + c ] = ( r.rgb[ k * 3 + c ] * ( 1 - desat ) + L * desat ) * gain[ c ];

		}

	}

	// --- occlusion: darker towards the ground and for blades deep inside the slab (z far from the viewer)
	const zNear = s.depthM * 0.5 + 0.12, zFar = - s.depthM * 0.5 - 0.12;
	r.ao = new Float32Array( w * h );
	for ( let y = 0; y < h; y ++ ) {

		const hgt = ( h - 1 - y + 0.5 ) / pxPerM;            // metres above ground
		const hTerm = Math.min( 1, hgt / ( 0.45 * s.hMax ) );   // 0 at the root .. 1 at ~45% height
		for ( let x = 0; x < w; x ++ ) {

			const k = y * w + x;
			if ( ! ( r.a[ k ] > 0 ) ) continue;
			const zt = Math.min( 1, Math.max( 0, ( r.z[ k ] - zFar ) / ( zNear - zFar ) ) );   // 1 = front
			const ao = ( 0.42 + 0.58 * Math.pow( hTerm, 0.8 ) ) * ( 0.72 + 0.28 * zt );
			r.ao[ k ] = ao * r.orm[ k * 3 ];
			// mild version baked into albedo so the cards read with depth even under flat lighting
			const alb = 0.62 + 0.38 * ( ( 0.3 + 0.7 * Math.pow( hTerm, 0.7 ) ) * ( 0.6 + 0.4 * zt ) );
			r.rgb[ k * 3 ] *= alb; r.rgb[ k * 3 + 1 ] *= alb; r.rgb[ k * 3 + 2 ] *= alb;
			r.orm[ k * 3 ] = r.ao[ k ];
			r.orm[ k * 3 + 1 ] = 0.62 + 0.38 * r.orm[ k * 3 + 1 ];   // cards with bent 'up' normals must not be glossy (sky-coloured haze at grazing angles)

		}

	}

	// --- fade out blades that run into the left/right card edge (no hard vertical cuts)
	const fade = Math.max( 3, Math.round( w * 0.05 ) );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const d = Math.min( x, w - 1 - x );
		if ( d < fade ) r.a[ y * w + x ] *= Math.max( 0, ( d - 0.5 ) / fade );

	}

	// top row fully transparent (a blade must never touch the top edge)
	for ( let x = 0; x < w; x ++ ) r.a[ x ] = 0;
	return r;

}

// hand layout (fills ~89% of the atlas at 700 px/m): column 1 = short x3 + mid x3 stacked; column 2 = rows of tall / tuft / dry
const pxPerM = 700;
const layout = STRIPS.map( ( s ) => ( { s, w: Math.round( s.widthM * pxPerM ), h: Math.round( s.heightM * pxPerM ) } ) );
{

	const by = ( prefix ) => layout.filter( ( r ) => r.s.name.startsWith( prefix ) );
	let y = PAD;
	for ( const r of [ ...by( 'short' ), ...by( 'mid' ) ] ) {

		r.x = PAD; r.y = y;
		y += r.h + PAD * 2;

	}

	if ( y - PAD > ATLAS ) throw new Error( 'column 1 overflows: ' + y );
	const x0 = PAD + by( 'short' )[ 0 ].w + PAD * 2;
	y = PAD;
	for ( const prefix of [ 'tall', 'tuft', 'dry' ] ) {

		let x = x0;
		for ( const r of by( prefix ) ) {

			r.x = x; r.y = y;
			x += r.w + PAD * 2;

		}

		if ( x - PAD > ATLAS ) throw new Error( `row ${prefix} overflows: ${x}` );
		y += by( prefix )[ 0 ].h + PAD * 2;

	}

	if ( y - PAD > ATLAS ) throw new Error( 'column 2 overflows: ' + y );

}

console.log( 'texel density', pxPerM, 'px/m' );
const atlas = new Atlas( ATLAS, ATLAS );
const stripInfo = {};
for ( const rect of layout ) {

	const s = rect.s;
	const r = renderStrip( s, pxPerM );
	atlas.blit( r, rect.x, rect.y );
	// colour statistics (linear) by height: root = lowest 22%, tip = top 35% of the occupied height
	let top = r.h;
	for ( let y = 0; y < r.h && top === r.h; y ++ ) for ( let x = 0; x < r.w; x ++ ) if ( r.a[ y * r.w + x ] > 0.5 ) {

		top = y;
		break;

	}

	const occ = r.h - top;
	const acc = { all: [ 0, 0, 0, 0 ], root: [ 0, 0, 0, 0 ], tip: [ 0, 0, 0, 0 ] };
	let covBottom = 0, covAll = 0;
	for ( let y = top; y < r.h; y ++ ) for ( let x = 0; x < r.w; x ++ ) {

		const k = y * r.w + x, a = r.a[ k ];
		covAll += a;
		if ( y > r.h - occ * 0.25 ) covBottom += a;
		if ( a <= 0 ) continue;
		const t = ( r.h - y ) / occ;
		for ( const [ key, on ] of [ [ 'all', true ], [ 'root', t < 0.22 ], [ 'tip', t > 0.65 ] ] ) if ( on ) {

			acc[ key ][ 0 ] += r.rgb[ k * 3 ] * a; acc[ key ][ 1 ] += r.rgb[ k * 3 + 1 ] * a; acc[ key ][ 2 ] += r.rgb[ k * 3 + 2 ] * a; acc[ key ][ 3 ] += a;

		}

	}

	stripInfo[ s.name ] = {
		rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, widthM: rect.w / pxPerM, heightM: rect.h / pxPerM, occupiedM: occ / pxPerM,
		avg: acc.all.slice( 0, 3 ).map( ( v ) => v / acc.all[ 3 ] ), root: acc.root.slice( 0, 3 ).map( ( v ) => v / acc.root[ 3 ] ), tip: acc.tip.slice( 0, 3 ).map( ( v ) => v / acc.tip[ 3 ] ),
		coverage: covAll / ( r.w * occ ), coverageBottom: covBottom / ( r.w * occ * 0.25 ),
	};
	console.log( s.name.padEnd( 8 ), `${rect.w}x${rect.h}px`, 'occupied', ( occ / pxPerM ).toFixed( 3 ), 'm  coverage', stripInfo[ s.name ].coverage.toFixed( 2 ), 'bottom', stripInfo[ s.name ].coverageBottom.toFixed( 2 ), 'avg', hex( stripInfo[ s.name ].avg ), 'root', hex( stripInfo[ s.name ].root ), 'tip', hex( stripInfo[ s.name ].tip ) );

}

atlas.dilate( 24 );
// thin blades cover < 50% of a texel: boost coverage so they survive the alpha test (cutoff 0.5 == ~0.28 coverage)
const ALPHA_GAIN = 1.8;
const bytes = atlas.toBytes( ( a ) => a * ALPHA_GAIN );
const images = await encodeTextures( bytes, { quality: 90, debugDir, name: 'grass' } );

// ---------------------------------------------------------------- clump geometry

/**
 * One bent card. c = base centre [x,z]; dir = horizontal unit direction of the card's width; width / height (arc length) in metres;
 * lean0 = tilt from vertical at the root, arch = additional tilt reached at the tip (rad); side = +1/-1 direction it leans to
 * (along the card's horizontal normal); bow = plan-view arc (m); cols x rows grid; mirror = flip u.
 */
function addCard( mb, { c, dir, width, height, lean0, arch, side, bow, cols, rows, stripName, mirror, tilt = [ 0, 0 ] } ) {

	const si = stripInfo[ stripName ];
	const nh = [ - dir[ 1 ] * side, dir[ 0 ] * side ];   // horizontal direction the card leans to
	const u0 = si.rect.x / ATLAS, u1 = ( si.rect.x + si.rect.w ) / ATLAS;
	const vTop = si.rect.y / ATLAS, vBot = ( si.rect.y + si.rect.h ) / ATLAS;
	const usedT = Math.min( 1, height / si.heightM );   // fraction of the strip height that is shown
	const base = mb.vertexCount;
	const seg = height / rows;
	let yy = 0, off = 0;
	for ( let j = 0; j <= rows; j ++ ) {

		const t = j / rows;
		if ( j > 0 ) {

			const ang = lean0 + arch * ( ( j - 0.5 ) / rows );
			yy += seg * Math.cos( ang );
			off += seg * Math.sin( ang );

		}

		for ( let i = 0; i <= cols; i ++ ) {

			const s = i / cols - 0.5;
			const arc = bow * ( 1 - 4 * s * s );
			const px = c[ 0 ] + dir[ 0 ] * s * width + nh[ 0 ] * ( arc + off );
			const pz = c[ 1 ] + dir[ 1 ] * s * width + nh[ 1 ] * ( arc + off );
			// bent normal: straight up plus a few degrees of per-card tilt (keeps the meadow shading continuous with the terrain)
			const n = v3.norm( [ tilt[ 0 ], 1, tilt[ 1 ] ] );
			const uu = mirror ? u1 - ( s + 0.5 ) * ( u1 - u0 ) : u0 + ( s + 0.5 ) * ( u1 - u0 );
			const vv = vBot - t * usedT * ( vBot - vTop );
			mb.vert( [ px, yy, pz ], n, [ uu, vv ] );

		}

	}

	for ( let j = 0; j < rows; j ++ ) for ( let i = 0; i < cols; i ++ ) {

		const a = base + j * ( cols + 1 ) + i, b = a + 1, d = a + cols + 1, e = d + 1;
		mb.quad( a, b, e, d );

	}

}

/** Blue-noise-ish card centres inside a disc (best-candidate sampling). */
function discPoints( rand, count, R ) {

	const pts = [];
	for ( let i = 0; i < count; i ++ ) {

		let best = null, bestD = - 1;
		for ( let k = 0; k < 24; k ++ ) {

			const r = R * Math.sqrt( 0.02 + 0.98 * rand() ), a = rand() * Math.PI * 2;
			const p = [ r * Math.cos( a ), r * Math.sin( a ) ];
			let d = Infinity;
			for ( const q of pts ) d = Math.min( d, Math.hypot( p[ 0 ] - q[ 0 ], p[ 1 ] - q[ 1 ] ) );
			if ( d > bestD ) {

				bestD = d; best = p;

			}

		}

		pts.push( best );

	}

	return pts;

}

const D2R = Math.PI / 180;
const range = ( rand, r ) => r[ 0 ] + rand() * ( r[ 1 ] - r[ 0 ] );

function buildClump( v, lod ) {

	const rand = rng( v.seed + lod * 101 );
	const mb = new MeshBuilder();
	const cfg = lod === 0 ? v.lod0 : v.lod1;
	const pts = discPoints( rand, cfg.cards, v.R * cfg.spread );
	const nTilted = Math.round( cfg.cards * v.tiltedFrac );
	pts.forEach( ( c, i ) => {

		const rad = Math.hypot( c[ 0 ], c[ 1 ] );
		const tilted = i % cfg.cards < nTilted;
		let ang, side;
		if ( v.outward ) {

			// tussock: cards roughly tangential, everything leans away from the centre (fountain)
			ang = Math.atan2( c[ 1 ], c[ 0 ] ) + Math.PI / 2 + ( rand() - 0.5 ) * ( rad < v.R * 0.25 ? Math.PI : Math.PI * 0.6 );
			const d0 = [ Math.cos( ang ), Math.sin( ang ) ];
			side = ( - d0[ 1 ] * c[ 0 ] + d0[ 0 ] * c[ 1 ] ) >= 0 ? 1 : - 1;

		} else {

			// turf: no preferred direction, neighbouring cards arch over each other
			ang = rand() * Math.PI * 2;
			side = rand() < 0.5 ? 1 : - 1;

		}

		const dir = [ Math.cos( ang ), Math.sin( ang ) ];
		const stripName = v.strips[ ( i + Math.floor( rand() * v.strips.length ) ) % v.strips.length ];
		const si = stripInfo[ stripName ];
		const ws = cfg.widthScale * ( 0.9 + rand() * 0.2 );
		const cls = tilted ? v.tilted : v.upright;
		addCard( mb, {
			c, dir, side, width: si.widthM * ws, height: si.heightM * range( rand, v.heightScale ) * ( tilted ? v.tiltedHeight ?? 1 : 1 ),
			lean0: range( rand, cls.lean0 ) * D2R, arch: range( rand, cls.arch ) * D2R,
			bow: si.widthM * ws * ( rand() - 0.5 ) * 0.3,
			cols: cfg.cols, rows: cfg.rows, stripName, mirror: rand() < 0.5,
			tilt: [ ( rand() - 0.5 ) * 0.14, ( rand() - 0.5 ) * 0.14 ],
		} );

	} );
	return mb.build( 0 );

}

const UPRIGHT = { lean0: [ 3, 14 ], arch: [ 10, 34 ] };
const TILTED = { lean0: [ 30, 50 ], arch: [ 14, 30 ] };
const TILTED_MID = { lean0: [ 24, 42 ], arch: [ 12, 28 ] };
const VARIANTS = [
	{ name: 'grass_short', strips: [ 'short_a', 'short_b', 'short_c' ], R: 0.40, seed: 11, heightScale: [ 0.9, 1.08 ], upright: UPRIGHT, tilted: TILTED, tiltedFrac: 0.5, tiltedHeight: 1.1,
		lod0: { cards: 12, cols: 2, rows: 3, spread: 0.72, widthScale: 1.0 }, lod1: { cards: 5, cols: 2, rows: 2, spread: 0.6, widthScale: 1.35 }, windAmplitude: 0.02, sink: 0.02,
		notes: 'short dense meadow turf; main filler' },
	{ name: 'grass_mid', strips: [ 'mid_a', 'mid_b', 'mid_c' ], R: 0.40, seed: 23, heightScale: [ 0.9, 1.08 ], upright: UPRIGHT, tilted: TILTED_MID, tiltedFrac: 0.42, tiltedHeight: 1.0,
		lod0: { cards: 12, cols: 2, rows: 3, spread: 0.72, widthScale: 1.0 }, lod1: { cards: 5, cols: 2, rows: 2, spread: 0.6, widthScale: 1.35 }, windAmplitude: 0.04, sink: 0.02,
		notes: 'medium meadow grass with a few seed heads; main filler' },
	{ name: 'grass_tall', strips: [ 'tall_a', 'tall_b', 'tall_c' ], R: 0.27, seed: 37, heightScale: [ 0.85, 1.05 ], outward: true, upright: { lean0: [ 2, 10 ], arch: [ 6, 22 ] }, tilted: { lean0: [ 18, 30 ], arch: [ 10, 24 ] }, tiltedFrac: 0.4, tiltedHeight: 0.8,
		lod0: { cards: 10, cols: 2, rows: 3, spread: 0.7, widthScale: 1.0 }, lod1: { cards: 4, cols: 2, rows: 2, spread: 0.55, widthScale: 1.25 }, windAmplitude: 0.09, sink: 0.02,
		notes: 'tall flowering grass tuft with panicles; accent, 5-15% of instances' },
	{ name: 'grass_dry', strips: [ 'dry_a', 'dry_b', 'dry_c' ], R: 0.27, seed: 41, heightScale: [ 0.8, 1.05 ], outward: true, upright: { lean0: [ 4, 14 ], arch: [ 10, 30 ] }, tilted: { lean0: [ 26, 44 ], arch: [ 12, 28 ] }, tiltedFrac: 0.5, tiltedHeight: 0.9,
		lod0: { cards: 10, cols: 2, rows: 3, spread: 0.7, widthScale: 1.0 }, lod1: { cards: 4, cols: 2, rows: 2, spread: 0.55, widthScale: 1.25 }, windAmplitude: 0.06, sink: 0.02,
		notes: 'dry straw-coloured tuft; scree edges, road verges, sunny slopes' },
	{ name: 'grass_tuft', strips: [ 'tuft_a', 'tuft_b', 'tuft_c' ], R: 0.27, seed: 53, heightScale: [ 0.8, 1.05 ], outward: true, upright: { lean0: [ 4, 14 ], arch: [ 10, 30 ] }, tilted: { lean0: [ 24, 42 ], arch: [ 12, 28 ] }, tiltedFrac: 0.5, tiltedHeight: 0.9,
		lod0: { cards: 10, cols: 2, rows: 3, spread: 0.7, widthScale: 1.0 }, lod1: { cards: 4, cols: 2, rows: 2, spread: 0.5, widthScale: 1.25 }, windAmplitude: 0.08, sink: 0.02,
		notes: 'loose wild tussock, green blades mixed with dead straw; rocky ground, forest edge' },
];

const outVariants = [], meta = [];
for ( const v of VARIANTS ) {

	const lods = [ buildClump( v, 0 ), buildClump( v, 1 ) ];
	outVariants.push( { name: v.name, lods: lods.map( ( l ) => [ l ] ) } );
	const m = measure( [ lods[ 0 ] ] );
	const mean = ( key ) => {

		const acc = [ 0, 0, 0 ];
		for ( const s of v.strips ) for ( let c = 0; c < 3; c ++ ) acc[ c ] += stripInfo[ s ][ key ][ c ] / v.strips.length;
		return acc;

	};
	meta.push( {
		name: v.name, size: m.size.map( ( x ) => round( x ) ), radius: round( m.radius ), height: round( m.height ),
		lods: lods.map( ( l, i ) => ( { node: `${v.name}_LOD${i}`, triangles: l.idx.length / 3 } ) ),
		avgColor: hex( mean( 'avg' ) ), colorRoot: hex( mean( 'root' ) ), colorTip: hex( mean( 'tip' ) ),
		windAmplitude: v.windAmplitude, collider: { type: 'none' }, sink: v.sink, notes: v.notes,
	} );
	console.log( v.name, 'LOD0', lods[ 0 ].idx.length / 3, 'tris  LOD1', lods[ 1 ].idx.length / 3, 'tris  size', m.size.map( ( x ) => x.toFixed( 2 ) ).join( 'x' ), 'radius', m.radius.toFixed( 2 ) );

}

mkdirSync( OUT, { recursive: true } );
const file = join( OUT, 'grass.glb' );
await writeGLB( file, {
	materials: [ { name: 'grass', base: images.base, normal: images.nor, orm: images.orm, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true, roughness: 1, metallic: 0 } ],
	variants: outVariants,
} );
const bytesOut = statSync( file ).size;
mkdirSync( join( SRC, '_build' ), { recursive: true } );
writeFileSync( join( SRC, '_build', 'grass.json' ), JSON.stringify( {
	id: 'grass', file: '/assets/plants/grass.glb', source: 'https://polyhaven.com/a/grass_medium_01',
	sources: [ 'https://polyhaven.com/a/grass_medium_01', 'https://polyhaven.com/a/grass_medium_02' ],
	author: 'Rob Tuytel, Rico Cilliers (Poly Haven)', license: 'CC0', textureResolution: ATLAS, bytes: bytesOut, category: 'grass',
	texelDensity: pxPerM, alphaCutoff: 0.5, variants: meta,
}, null, 1 ) );
console.log( 'wrote', file, ( bytesOut / 1024 ).toFixed( 0 ), 'KB' );
