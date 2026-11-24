#!/usr/bin/env node
// Build small plants (wildflowers, low forest plants) as "slab cloud" card impostors: see plants-slab.mjs.
// One GLB per Poly Haven source, 2 LODs per variant, one shared atlas per GLB (base+alpha / normal / ORM).
//   node tools/assets/plants-build-cards.mjs [id ...] [--debug <dir>]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import {
	SRC, OUT, TexSet, loadSoup, mergeMeshes, placeMesh, boundsOf, Atlas, packRects, encodeTextures, writeGLB, MeshBuilder, measure, hex, round, v3, lin2srgb8, SRGB2LIN,
} from './plants-lib.mjs';
import { slabCards, renderCard, cardQuad } from './plants-slab.mjs';

const argv = process.argv.slice( 2 );
const debugDir = argv.includes( '--debug' ) ? argv[ argv.indexOf( '--debug' ) + 1 ] : null;
if ( debugDir ) mkdirSync( debugDir, { recursive: true } );
const only = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && argv[ i - 1 ] !== '--debug' );

// ---------------------------------------------------------------- colour grading helpers (on the 8-bit sRGB source diffuse)

function rgb2hsv( r, g, b ) {

	const mx = Math.max( r, g, b ), mn = Math.min( r, g, b ), d = mx - mn;
	let h = 0;
	if ( d > 0 ) {

		if ( mx === r ) h = ( ( g - b ) / d ) % 6; else if ( mx === g ) h = ( b - r ) / d + 2; else h = ( r - g ) / d + 4;
		h *= 60;
		if ( h < 0 ) h += 360;

	}

	return [ h, mx === 0 ? 0 : d / mx, mx ];

}

function hsv2rgb( h, s, v ) {

	const c = v * s, x = c * ( 1 - Math.abs( ( h / 60 ) % 2 - 1 ) ), m = v - c;
	let r = 0, g = 0, b = 0;
	if ( h < 60 ) [ r, g, b ] = [ c, x, 0 ]; else if ( h < 120 ) [ r, g, b ] = [ x, c, 0 ]; else if ( h < 180 ) [ r, g, b ] = [ 0, c, x ];
	else if ( h < 240 ) [ r, g, b ] = [ 0, x, c ]; else if ( h < 300 ) [ r, g, b ] = [ x, 0, c ]; else [ r, g, b ] = [ c, 0, x ];
	return [ r + m, g + m, b + m ];

}

/** Rotate the hue of all texels whose hue lies in [h0,h1] (deg) and saturation > sMin to `to` (deg); scale s and v. */
function hueShift( tex, { h0, h1, sMin = 0.25, to, sMul = 1, vMul = 1 } ) {

	const d = tex.diff;
	let n = 0;
	for ( let i = 0; i < d.length; i += 3 ) {

		const [ h, s, v ] = rgb2hsv( d[ i ] / 255, d[ i + 1 ] / 255, d[ i + 2 ] / 255 );
		if ( h < h0 || h > h1 || s < sMin ) continue;
		// keep the relative hue variation inside the petal
		const hh = ( to + ( h - ( h0 + h1 ) / 2 ) * 0.5 + 360 ) % 360;
		const [ r, g, b ] = hsv2rgb( hh, Math.min( 1, s * sMul ), Math.min( 1, v * vMul ) );
		d[ i ] = Math.round( r * 255 ); d[ i + 1 ] = Math.round( g * 255 ); d[ i + 2 ] = Math.round( b * 255 );
		n ++;

	}

	return n;

}

// ---------------------------------------------------------------- asset table

const LOD0 = { nAz: 4, nOff: 2, nH: 3 };
const LOD1 = { nAz: 2, nOff: 1, nH: 2 };
const ASSETS = [
	{
		id: 'dandelion_01', category: 'flowers', author: 'Rob Tuytel, Rico Cilliers (Poly Haven)', atlas: 512, alpha: 'alpha',
		variants: [
			{ src: 'dandelion_01_a_LOD0', name: 'dandelion_a', notes: 'yellow dandelion, 2 flower heads + bud, leaf rosette', windAmplitude: 0.012 },
			{ src: 'dandelion_01_b_LOD0', name: 'dandelion_b', notes: 'yellow dandelion, 2 flower heads, flatter rosette', windAmplitude: 0.01 },
		],
		lod0: { nAz: 4, nOff: 2, nH: 6 }, lod1: { nAz: 2, nOff: 1, nH: 3 }, flower: 'yellow',
		// petals: slightly darker + fully saturated so they stay yellow (not cream) after filmic tone mapping
		grade: ( tex ) => hueShift( tex, { h0: 36, h1: 62, sMin: 0.55, to: 47, sMul: 1.12, vMul: 0.84 } ),
		scale: 1.4, scaleY: 1.3,   // the scanned specimens are small (16 cm); in a meadow the scapes reach 25-30 cm, heads 4-5 cm
		patches: [ { name: 'dandelion_patch', notes: 'group of 3 dandelions (6 flower heads) - the best "yellow dots" per instance', windAmplitude: 0.012,
			parts: [ { variant: 'dandelion_a', x: - 0.13, z: 0.05, rot: 0.6, scale: 1.0 }, { variant: 'dandelion_b', x: 0.15, z: 0.1, rot: 2.4, scale: 1.1 }, { variant: 'dandelion_a', x: 0.02, z: - 0.17, rot: 4.3, scale: 0.85 } ] } ],
	},
	{
		id: 'flower_heliophila', category: 'flowers', author: 'James Ray Cock, Jenelle van Heerden (Poly Haven)', atlas: 1024, alpha: 'alpha',
		variants: [
			{ src: 'flower_heliophila_small', name: 'heliophila_small', notes: 'white star flowers on wiry stems (passes as stitchwort / saxifrage)', windAmplitude: 0.03 },
			{ src: 'flower_heliophila_medium', name: 'heliophila_medium', notes: 'larger loose patch of the same white flower', windAmplitude: 0.035 },
		],
		lod0: { nAz: 6, nOff: 2, nH: 5 }, lod1: { nAz: 3, nOff: 1, nH: 2 }, flower: 'white', horizCos: 0.8,
	},
	{
		id: 'periwinkle_plant', category: 'flowers', author: 'Amal Kumar (Poly Haven)', atlas: 512, alpha: 'opacity',
		variants: [
			{ src: 'periwinkle_plant_05_LOD0', name: 'periwinkle_small', notes: 'blue-violet 5-petal flowers (petals hue-shifted from the pink source), glossy leaves', windAmplitude: 0.015 },
			{ src: 'periwinkle_plant_03_LOD0', name: 'periwinkle_tall', notes: 'taller stem of the same blue-violet flower', windAmplitude: 0.025 },
		],
		lod0: { nAz: 4, nOff: 2, nH: 9 }, lod1: { nAz: 2, nOff: 1, nH: 4 }, flower: 'blue-violet', scale: 1.2, outTilt: 0.55, maxTilt: 0.8,
		patches: [ { name: 'periwinkle_patch', notes: 'group of 4 stems (about 12 blue-violet flowers)', windAmplitude: 0.02,
			parts: [ { variant: 'periwinkle_tall', x: - 0.07, z: 0.03, rot: 0.3, scale: 1.0 }, { variant: 'periwinkle_small', x: 0.09, z: 0.07, rot: 1.9, scale: 1.1 }, { variant: 'periwinkle_tall', x: 0.03, z: - 0.1, rot: 3.6, scale: 0.9 }, { variant: 'periwinkle_small', x: - 0.1, z: - 0.09, rot: 5.1, scale: 0.95 } ] } ],
		grade: ( tex ) => hueShift( tex, { h0: 285, h1: 345, sMin: 0.22, to: 258, sMul: 0.95, vMul: 0.92 } ),
	},
];

// ---------------------------------------------------------------- build

async function build( A ) {

	const dir = join( SRC, A.id ), maps = join( SRC, A.id + '__maps' );
	const tex = await TexSet.load( {
		name: A.id,
		diff: join( dir, 'textures', `${A.id}_diff_2k.jpg` ),
		alpha: A.alpha ? join( maps, `${A.id}_${A.alpha}_2k.png` ) : null,
		nor: join( dir, 'textures', `${A.id}_nor_gl_2k.jpg` ),
		arm: join( dir, 'textures', `${A.id}_arm_2k.jpg` ),
	} );
	if ( A.grade ) console.log( `  graded ${A.grade( tex )} texels` );
	const nodes = await loadSoup( join( dir, `${A.id}_2k.gltf` ) );
	const S = A.atlas, PAD = 2;

	// 1. cards for every variant / LOD
	const work = [];
	for ( const v of A.variants ) {

		const node = nodes.find( ( n ) => n.name === v.src );
		if ( ! node ) throw new Error( `${A.id}: node ${v.src} not found (have ${nodes.map( ( n ) => n.name ).join( ', ' )})` );
		let mesh = mergeMeshes( node.prims );
		if ( ( v.scale ?? A.scale ?? 1 ) !== 1 ) mesh = placeMesh( mesh, { scale: v.scale ?? A.scale } );
		const sy = v.scaleY ?? A.scaleY ?? 1;
		if ( sy !== 1 ) {

			// longer stems: stretch along Y only (normals follow the inverse transpose)
			for ( let i = 0; i < mesh.pos.length; i += 3 ) {

				mesh.pos[ i + 1 ] *= sy;
				const nx = mesh.nrm[ i ], ny = mesh.nrm[ i + 1 ] / sy, nz = mesh.nrm[ i + 2 ];
				const l = Math.hypot( nx, ny, nz ) || 1;
				mesh.nrm[ i ] = nx / l; mesh.nrm[ i + 1 ] = ny / l; mesh.nrm[ i + 2 ] = nz / l;

			}

		}

		mesh.tex = tex;
		const b = boundsOf( mesh );
		const lods = [ A.lod0, A.lod1 ].map( ( cfg, li ) => slabCards( mesh, { ...cfg, horizCos: A.horizCos ?? 0.74, outTilt: A.outTilt ?? 0, maxTilt: A.maxTilt ?? 0.6, minY: 0, minAreaFrac: li === 0 ? 0.004 : 0.01 } ) );
		work.push( { v, mesh, bounds: b, lods } );

	}

	// 2. texel density so that everything fits (LOD1 cards at 45% linear density)
	const LOD1_SCALE = 0.45;
	let px = 4000, rects = null;
	for ( ; px > 60; px *= 0.97 ) {

		rects = [];
		for ( const w of work ) w.lods.forEach( ( cards, li ) => cards.forEach( ( card ) => {

			const d = px * ( li === 0 ? 1 : LOD1_SCALE );
			rects.push( { card, li, w: Math.max( 2, Math.round( card.widthM * d ) ), h: Math.max( 2, Math.round( card.heightM * d ) ), d } );

		} ) );
		if ( packRects( rects, S, S, PAD ) ) break;

	}

	console.log( `  ${rects.length} cards, texel density ${px.toFixed( 0 )} px/m (LOD0)` );

	// 3. render
	const atlas = new Atlas( S, S );
	for ( const r of rects ) {

		const res = renderCard( r.card.mesh ?? work.find( ( w ) => w.lods[ r.li ].includes( r.card ) ).mesh, r.card, r.d, tex, 4 );
		// renderCard rounds like we did
		atlas.blit( res, r.x, r.y );
		r.card.rect = { x: r.x, y: r.y, w: res.w, h: res.h };
		r.card.res = res;

	}

	atlas.dilate( 16 );
	const ALPHA_GAIN = A.alphaGain ?? 1.9;
	const bytes = atlas.toBytes( ( a ) => a * ALPHA_GAIN );
	const images = await encodeTextures( bytes, { quality: 90, debugDir, name: A.id } );

	// 4. meshes + stats
	const up = [ 0, 1, 0 ];
	// shading normals: mostly up (meadow plants must shade like the grass around them), a little of the card's own facing
	const normalFn = ( p, card ) => v3.norm( [ card.frame.n[ 0 ] * 0.3, 1, card.frame.n[ 2 ] * 0.3 ] );
	const outVariants = [], meta = [];
	const stats = {};   // variant name -> linear colour accumulators (from its LOD0 cards)
	const singleLods = {};   // variant name -> [ lod0 prim, lod1 prim ]
	const emit = ( name, lods, v, colourOf ) => {

		outVariants.push( { name, lods: lods.map( ( l ) => [ l ] ) } );
		const m = measure( [ lods[ 0 ] ] );
		const acc = colourOf;
		const col = ( k ) => hex( acc[ k ][ 3 ] > 0 ? acc[ k ].slice( 0, 3 ).map( ( x ) => x / acc[ k ][ 3 ] ) : acc.all.slice( 0, 3 ).map( ( x ) => x / acc.all[ 3 ] ) );
		meta.push( {
			name, size: m.size.map( ( x ) => round( x ) ), radius: round( m.radius ), height: round( m.height ),
			lods: lods.map( ( l, i ) => ( { node: `${name}_LOD${i}`, triangles: l.idx.length / 3 } ) ),
			avgColor: col( 'all' ), colorRoot: col( 'root' ), colorTip: col( 'tip' ),
			windAmplitude: v.windAmplitude, collider: { type: 'none' }, sink: v.sink ?? 0, notes: v.notes,
		} );
		console.log( `  ${name}: tris ${lods.map( ( l ) => l.idx.length / 3 ).join( ' / ' )}, size ${m.size.map( ( x ) => x.toFixed( 2 ) ).join( 'x' )}, min y ${m.min[ 1 ].toFixed( 3 )}` );

	};

	for ( const w of work ) {

		const lods = w.lods.map( ( cards ) => {

			const mb = new MeshBuilder();
			for ( const card of cards ) cardQuad( mb, card, card.rect, S, normalFn );
			return mb.build( 0 );

		} );
		singleLods[ w.v.name ] = lods;
		// colour statistics from the LOD0 cards (linear, alpha weighted), by world height
		const H = measure( [ lods[ 0 ] ] ).height;
		const acc = { all: [ 0, 0, 0, 0 ], root: [ 0, 0, 0, 0 ], tip: [ 0, 0, 0, 0 ] };
		for ( const card of w.lods[ 0 ] ) {

			const res = card.res;
			for ( let y = 0; y < res.h; y ++ ) {

				const wy = card.kind === 'h' ? card.frame.o[ 1 ] : card.frame.o[ 1 ] + ( res.h - 1 - y + 0.5 ) / res.h * card.heightM;
				const t = wy / H;
				for ( let x = 0; x < res.w; x ++ ) {

					const k = y * res.w + x, a = res.a[ k ];
					if ( a <= 0 ) continue;
					for ( const [ key, on ] of [ [ 'all', true ], [ 'root', t < 0.3 ], [ 'tip', t > 0.6 ] ] ) if ( on ) {

						acc[ key ][ 0 ] += res.rgb[ k * 3 ] * a; acc[ key ][ 1 ] += res.rgb[ k * 3 + 1 ] * a; acc[ key ][ 2 ] += res.rgb[ k * 3 + 2 ] * a; acc[ key ][ 3 ] += a;

					}

				}

			}

		}

		stats[ w.v.name ] = acc;
		if ( ! w.v.hidden ) emit( w.v.name, lods, w.v, acc );

	}

	// patches: several baked plants placed side by side (no extra texture space)
	for ( const patch of A.patches || [] ) {

		const acc = { all: [ 0, 0, 0, 0 ], root: [ 0, 0, 0, 0 ], tip: [ 0, 0, 0, 0 ] };
		const lods = [ 0, 1 ].map( ( li ) => {

			const mb = new MeshBuilder();
			for ( const part of patch.parts ) {

				const src = singleLods[ part.variant ][ li ];
				const c = Math.cos( part.rot ), sn = Math.sin( part.rot ), k = part.scale ?? 1;
				const base = mb.vertexCount;
				for ( let i = 0; i < src.pos.length / 3; i ++ ) {

					const x = src.pos[ i * 3 ], y = src.pos[ i * 3 + 1 ], z = src.pos[ i * 3 + 2 ];
					const nx = src.nrm[ i * 3 ], ny = src.nrm[ i * 3 + 1 ], nz = src.nrm[ i * 3 + 2 ];
					mb.vert( [ ( c * x + sn * z ) * k + part.x, y * k, ( - sn * x + c * z ) * k + part.z ], [ c * nx + sn * nz, ny, - sn * nx + c * nz ], [ src.uv[ i * 2 ], src.uv[ i * 2 + 1 ] ] );

				}

				for ( let i = 0; i < src.idx.length; i ++ ) mb.idx.push( src.idx[ i ] + base );
				if ( li === 0 ) for ( const key of [ 'all', 'root', 'tip' ] ) for ( let q = 0; q < 4; q ++ ) acc[ key ][ q ] += stats[ part.variant ][ key ][ q ];

			}

			return mb.build( 0 );

		} );
		emit( patch.name, lods, patch, acc );

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
		textureResolution: S, bytes: statSync( file ).size, category: A.category, texelDensity: Math.round( px ), alphaCutoff: 0.5,
		...( A.flower ? { flowerColor: A.flower } : {} ), variants: meta,
	}, null, 1 ) );
	console.log( `  wrote ${file} ${( statSync( file ).size / 1024 ).toFixed( 0 )} KB` );

}

for ( const A of ASSETS ) {

	if ( only.length && ! only.includes( A.id ) ) continue;
	if ( ! existsSync( join( SRC, A.id ) ) ) {

		console.log( `[skip] ${A.id}: source missing` );
		continue;

	}

	console.log( A.id );
	await build( A );

}
