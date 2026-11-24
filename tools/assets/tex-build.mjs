#!/usr/bin/env node
// Builds public/assets/textures/<set>/{albedo,normal,arm,height}.jpg from the raw Poly Haven downloads in
// assets-src/textures/<polyhavenId>/ and writes public/assets/textures/index.json.
//
//   node tools/assets/tex-fetch.mjs ...            (once, downloads)
//   node tools/assets/tex-fx.mjs                   (once, writes assets-src/textures/_fx.json)
//   node tools/assets/tex-build.mjs <path/to/polyhaven/textures.json>
//
// Rules: Poly Haven JPGs are copied byte-for-byte whenever they already have the right size/format. Re-encoding
// (sharp, 4:4:4) only happens for (a) 3-channel displacement JPGs -> single channel greyscale, (b) the derived
// metal_galvanized set (corrugation removed from a corrugated galvanized sheet scan), (c) normal maps flagged with
// normalFix: several scans have a constant tilt bias (mean normal up to 12 degrees off +Z) or tile-sized "pillowing"
// (a 2.5 degree sawtooth across the tile) which is invisible at noon but turns into wrong brightness / a visible 2 m
// checkerboard under a 6 degree golden-hour sun (N.L doubles for a 6 degree tilt). See tools/assets/tex-lowfreq.mjs.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { albedoStats, channelStats, seamRatio, bakedLightCheck, normalStats, heightScaleFromNormal, srgbToLinear, linearToSrgb, round } from './tex-lib.mjs';

const SRC = resolve( 'assets-src/textures' );
const OUT = resolve( 'public/assets/textures' );
const catalogPath = process.argv[ 2 ];
const catalog = catalogPath && existsSync( catalogPath ) ? JSON.parse( readFileSync( catalogPath, 'utf8' ) ) : {};

// id -> Poly Haven asset. res = edge length of albedo/normal/arm. tint = recommended linear albedo multiplier (optional).
const SETS = [
	{ id: 'grass_meadow', normalFix: { bias: true }, aoIntensity: 0.5, ph: 'forrest_ground_01', res: 2048, intent: 'natural green alpine meadow ground (short grass, moss, dry stalks, twigs)',
		recommended: { albedoTint: [ 0.62, 0.88, 0.5 ], note: 'Raw scan is a yellowish green-tan (lots of dry material). Multiply albedo by albedoTint for a fresh alpine-meadow green; use 1,1,1 towards late-summer/dry areas. Meant as the ground under instanced grass blades.' } },
	{ id: 'grass_dry', ph: 'grass_ground', res: 2048, intent: 'sparse / worn dry grass with soil showing through (transition between meadow and dirt/gravel)' },
	{ id: 'forest_floor', normalFix: { bias: true }, aoIntensity: 0.45, ph: 'forrest_ground_03', res: 2048, intent: 'conifer forest floor: carpet of dry pine needles with small twigs and stones',
		recommended: { albedoTint: [ 0.58, 0.52, 0.46 ], note: 'Raw scan is sun-bleached pale tan needles. Multiply albedo by albedoTint for the darker red-brown duff found under a closed fir canopy.' } },
	{ id: 'dirt', normalFix: { bias: true }, ph: 'dry_mud_field_001', res: 2048, intent: 'grey-brown dry soil / dried mud with fine clods (road cuts, shoulders)' },
	{ id: 'gravel', ph: 'gravel_floor_03', res: 2048, intent: 'neutral grey fine roadside gravel / fine scree' },
	{ id: 'rock_cliff', ph: 'marble_cliff_05', res: 2048, intent: 'grey fractured cliff face (drone scan of a 20 m wall) for triplanar projection on steep slopes',
		recommended: { detailRepeatMeters: 6, note: 'Use the true 20 m repeat for albedo/arm (at 8 m the dark notch feature repeats visibly on a planar wall - tested). 2048 px over 20 m is only 102 px/m, i.e. soft closer than ~10 m: add close-range detail by blending a second sample of the same normal map at ~6 m repeat (or the rock_ground / gravel normal) rather than shrinking the base repeat.' } },
	{ id: 'rock_ground', normalFix: { bias: true }, ph: 'gray_rocks', res: 2048, intent: 'broken angular grey rock / coarse scree with soil and a few sprouts between the stones (high ground, talus)' },
	{ id: 'shore', normalFix: { bias: true }, ph: 'ganges_river_pebbles', res: 2048, intent: 'rounded river pebbles in coarse sand for the lake edge' },
	{ id: 'snow', normalFix: { bias: true }, aoIntensity: 0.55, ph: 'snow_02', res: 1024, intent: 'fresh, slightly wind-packed snow for distant peaks',
		recommended: { albedoTint: [ 2.2, 2.2, 2.25 ], note: 'Poly Haven snow albedo is stored far too dark (linear 0.38). Multiply by ~2.2 to reach a physical snow albedo of ~0.85.' } },
	{ id: 'asphalt_main', normalFix: { ramp: true, highpass: 1 / 16 }, ph: 'asphalt_pit_lane', res: 2048, intent: 'dark, good-condition asphalt with visible 3-8 mm aggregate, no markings (main road surface)',
		recommended: { albedoTint: [ 0.9, 1.0, 1.14 ], note: 'Raw scan has a slight brown cast (#453e37). albedoTint neutralises it to a dark neutral grey that matches the granite palette; use 1,1,1 to keep the warm tone.' } },
	{ id: 'asphalt_worn', ph: 'asphalt_02', res: 2048, intent: 'older sun-bleached asphalt with exposed aggregate and cracks (patches, lay-bys, old sections)' },
	{ id: 'concrete', ph: 'concrete_wall_009', res: 1024, intent: 'cast concrete with bug holes, form-tie plugs and pour lines (barriers, kerbs, bridge)' },
	{ id: 'metal_galvanized', ph: 'corrugated_iron', res: 1024, derive: 'flatten-corrugation', intent: 'flat hot-dip galvanized steel with zinc spangle and a few rust runs (guard rails, sign posts)' },
	{ id: 'wood_weathered', normalFix: { bias: true }, roughnessBias: 0.3, ph: 'rough_wood', res: 1024, intent: 'grey weathered, cracked bare timber without plank gaps; grain runs along V (posts, beams, pier planks)' },
	{ id: 'rock_detail', ph: 'rock_boulder_dry', res: 1024, extra: true, intent: 'EXTRA set: close-range rock micro-surface (1.8 m scan of a pale grey-beige weathered boulder face, 569 px/m) to blend over rock_cliff near the road, where the 20 m cliff scan (102 px/m) gets soft',
		recommended: { note: 'Detail layer only: blend its normal (and at most a faint albedo modulation) over rock_cliff within ~15 m of the camera. Do NOT use it alone on large surfaces - its dark lichen blotches repeat visibly every 1.8 m (tested on an 8x6 m wall). Its roughness (0.63) is lower than rock_cliff (0.88): keep the roughness of rock_cliff.' } },
	{ id: 'wood_planks', normalFix: { bias: true }, roughnessBias: 0.3, ph: 'brown_planks_03', res: 1024, extra: true, intent: 'EXTRA set: grey weathered boards with dark gaps, boards run along V (pier deck, fences) - complements wood_weathered' },
];

const JPEG = { quality: 95, chromaSubsampling: '4:4:4', mozjpeg: false };

function findSrc( ph, tag, res ) {

	const dir = join( SRC, ph );
	const k = res / 1024;
	const re = new RegExp( `_(${tag})_${k}k\\.jpg$` );
	const f = readdirSync( dir ).find( ( n ) => re.test( n ) );
	if ( ! f ) throw new Error( `${ph}: no "${tag}" map at ${k}k in ${dir}` );
	return join( dir, f );

}

async function assertSize( file, size ) {

	const m = await sharp( file ).metadata();
	if ( m.width !== size || m.height !== size ) throw new Error( `${file}: expected ${size}x${size}, got ${m.width}x${m.height}` );
	return m;

}

// ---------------------------------------------------------------- derived: flatten a corrugated sheet scan
// The corrugation is a 1D profile (ridges run along V). Its contribution to every map is the vertically low-passed
// signal; removing it (rotation for normals, subtraction for height, division for albedo/AO/roughness) leaves a flat sheet
// with all micro detail (zinc spangle, dents, scratches, rust runs) intact.
async function flattenCorrugation( set, dir ) {

	const S = set.res;
	const read = async ( tag, res, ch ) => {

		const img = sharp( findSrc( set.ph, tag, res ) );
		const { data } = await ( ch === 1 ? img.greyscale().toColourspace( 'b-w' ) : img.removeAlpha().toColourspace( 'srgb' ) ).raw().toBuffer( { resolveWithObject: true } );
		return data;

	};
	const [ diff, arm ] = [ await read( 'diff|diffuse', S, 3 ), await read( 'arm', S, 3 ) ]; // the scan's normal + displacement only hold the corrugation and are not used
	const N = S * S, RAD = Math.round( S * 0.19 );

	// wrap-around vertical box blur of a Float32Array plane
	const blurV = ( src, size = S, rad = RAD ) => {

		const out = new Float32Array( src.length ), win = 2 * rad + 1;
		for ( let x = 0; x < size; x ++ ) {

			let s = 0;
			for ( let k = - rad; k <= rad; k ++ ) s += src[ ( ( k + size ) % size ) * size + x ];
			for ( let y = 0; y < size; y ++ ) {

				out[ y * size + x ] = s / win;
				s += src[ ( ( y + rad + 1 ) % size ) * size + x ] - src[ ( ( y - rad + size ) % size ) * size + x ];

			}

		}

		return out;

	};
	const blurH = ( src, size, rad ) => {

		const out = new Float32Array( src.length ), win = 2 * rad + 1;
		for ( let y = 0; y < size; y ++ ) {

			let s = 0;
			for ( let k = - rad; k <= rad; k ++ ) s += src[ y * size + ( ( k + size ) % size ) ];
			for ( let x = 0; x < size; x ++ ) {

				out[ y * size + x ] = s / win;
				s += src[ y * size + ( ( x + rad + 1 ) % size ) ] - src[ y * size + ( ( x - rad + size ) % size ) ];

			}

		}

		return out;

	};
	// two box passes per axis ~ gaussian, wrap-around so the result stays tileable
	const blur2D = ( src, size, rad ) => blurH( blurV( blurH( blurV( src, size, rad ), size, rad ), size, rad ), size, rad );
	const plane = ( buf, ch, stride, fn ) => {

		const p = new Float32Array( buf.length / stride );
		for ( let i = 0; i < p.length; i ++ ) p[ i ] = fn( buf[ i * stride + ch ] );
		return p;

	};
	const mean = ( p ) => p.reduce( ( a, b ) => a + b, 0 ) / p.length;

	// albedo (linear, multiplicative), AO + roughness (multiplicative), metalness untouched
	const outA = Buffer.alloc( N * 3 );
	for ( let c = 0; c < 3; c ++ ) {

		const p = plane( diff, c, 3, ( v ) => srgbToLinear( v / 255 ) ), b = blurV( p ), g = mean( p );
		for ( let i = 0; i < N; i ++ ) outA[ i * 3 + c ] = Math.round( Math.min( 1, Math.max( 0, linearToSrgb( ( p[ i ] * g ) / Math.max( b[ i ], 1e-4 ) ) ) ) * 255 );

	}

	// micro relief: the scan's own normal map keeps rows of dents along the former ridges even after flattening, which
	// read as artefacts on a flat sheet. The zinc spangle is therefore embossed very slightly from the flattened albedo
	// (2D high-pass of the luminance -> height -> normal, mean slope ~0.03 = barely visible sparkle variation).
	const lumA = new Float32Array( N );
	for ( let i = 0; i < N; i ++ ) lumA[ i ] = 0.2126 * srgbToLinear( outA[ i * 3 ] / 255 ) + 0.7152 * srgbToLinear( outA[ i * 3 + 1 ] / 255 ) + 0.0722 * srgbToLinear( outA[ i * 3 + 2 ] / 255 );
	const lowA = blur2D( lumA, S, 5 );
	const micro = new Float32Array( N );
	let var_ = 0;
	for ( let i = 0; i < N; i ++ ) { micro[ i ] = lumA[ i ] - lowA[ i ]; var_ += micro[ i ] * micro[ i ]; }
	const sd = Math.sqrt( var_ / N ) || 1;
	for ( let i = 0; i < N; i ++ ) micro[ i ] = Math.max( - 3, Math.min( 3, micro[ i ] / sd ) );
	const smooth = blur2D( micro, S, 1 ); // de-noise JPEG grain before differentiating
	const gx = new Float32Array( N ), gy = new Float32Array( N );
	let gsum = 0;
	for ( let y = 0; y < S; y ++ ) for ( let x = 0; x < S; x ++ ) {

		const i = y * S + x;
		gx[ i ] = ( smooth[ y * S + ( ( x + 1 ) % S ) ] - smooth[ y * S + ( ( x - 1 + S ) % S ) ] ) * 0.5;
		gy[ i ] = ( smooth[ ( ( y + 1 ) % S ) * S + x ] - smooth[ ( ( y - 1 + S ) % S ) * S + x ] ) * 0.5;
		gsum += Math.hypot( gx[ i ], gy[ i ] );

	}

	const kN = 0.03 / ( gsum / N );
	const outN = Buffer.alloc( N * 3 );
	for ( let i = 0; i < N; i ++ ) {

		// OpenGL convention: x = -dh/du, y = -dh/dv with v up = +dh/d(image row)
		const x = - gx[ i ] * kN, y = gy[ i ] * kN, l = Math.hypot( x, y, 1 );
		outN[ i * 3 ] = Math.round( ( x / l * 0.5 + 0.5 ) * 255 ); outN[ i * 3 + 1 ] = Math.round( ( y / l * 0.5 + 0.5 ) * 255 ); outN[ i * 3 + 2 ] = Math.round( ( 1 / l * 0.5 + 0.5 ) * 255 );

	}

	const outArm = Buffer.alloc( N * 3 );
	for ( let c = 0; c < 3; c ++ ) {

		const p = plane( arm, c, 3, ( v ) => v / 255 );
		if ( c === 2 ) { for ( let i = 0; i < N; i ++ ) outArm[ i * 3 + c ] = 255; continue; } // clean zinc: the scan's rust runs (metalness 0 streaks) are dropped
		const b = blurV( p ), g = mean( p );
		for ( let i = 0; i < N; i ++ ) outArm[ i * 3 + c ] = Math.round( Math.min( 1, Math.max( 0, ( p[ i ] * g ) / Math.max( b[ i ], 1e-4 ) ) ) * 255 );

	}

	// height: the same micro relief (+-3 sigma mapped to 0.5 +- 0.24); practically flat, only there for API symmetry
	const outH = Buffer.alloc( 1024 * 1024 );
	for ( let y = 0; y < 1024; y ++ ) for ( let x = 0; x < 1024; x ++ ) outH[ y * 1024 + x ] = Math.round( ( 0.5 + smooth[ Math.floor( y * S / 1024 ) * S + Math.floor( x * S / 1024 ) ] * 0.08 ) * 255 );

	await sharp( outA, { raw: { width: S, height: S, channels: 3 } } ).jpeg( JPEG ).toFile( join( dir, 'albedo.jpg' ) );
	await sharp( outN, { raw: { width: S, height: S, channels: 3 } } ).jpeg( JPEG ).toFile( join( dir, 'normal.jpg' ) );
	await sharp( outArm, { raw: { width: S, height: S, channels: 3 } } ).jpeg( JPEG ).toFile( join( dir, 'arm.jpg' ) );
	await sharp( outH, { raw: { width: 1024, height: 1024, channels: 1 } } ).toColourspace( 'b-w' ).jpeg( JPEG ).toFile( join( dir, 'height.jpg' ) );
	return 'Derived from the Poly Haven "corrugated_iron" scan (galvanized corrugated sheet) to get a FLAT galvanized sheet: the vertically low-passed corrugation banding was divided out of albedo, AO and roughness; metalness is a constant 1 (the scan\'s rust runs are dropped); normal + height are a very subtle emboss of the zinc spangle derived from the flattened albedo (mean slope 0.03), because the scanned normal/displacement only contain the corrugation. Re-encoded JPEG q95 4:4:4.';

}

// ---------------------------------------------------------------- normal map clean-up (bias / pillowing)
function wrapBlur2D( src, size, rad ) {

	const pass = ( a, horizontal ) => {

		const out = new Float32Array( a.length ), win = 2 * rad + 1;
		for ( let j = 0; j < size; j ++ ) {

			const at = horizontal ? ( k ) => j * size + ( ( k % size ) + size ) % size : ( k ) => ( ( ( k % size ) + size ) % size ) * size + j;
			let acc = 0;
			for ( let k = - rad; k <= rad; k ++ ) acc += a[ at( k ) ];
			for ( let i = 0; i < size; i ++ ) {

				out[ at( i ) ] = acc / win;
				acc += a[ at( i + rad + 1 ) ] - a[ at( i - rad ) ];

			}

		}

		return out;

	};
	return pass( pass( pass( pass( src, true ), false ), true ), false );

}

async function fixNormal( src, dst, size, opts ) {

	const { data } = await sharp( src ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const N = size * size, DEG = 180 / Math.PI;
	const comp = [ new Float32Array( N ), new Float32Array( N ) ];
	for ( let i = 0; i < N; i ++ ) { comp[ 0 ][ i ] = data[ i * 3 ] / 127.5 - 1; comp[ 1 ][ i ] = data[ i * 3 + 1 ] / 127.5 - 1; }
	const report = { biasDeg: [], rampDeg: [] };
	for ( const p of comp ) {

		// least squares fit p ~ a + b u + c v with u, v in [-0.5, 0.5] (u, v are orthogonal and zero-mean on the grid)
		let a = 0, b = 0, c = 0, uu = 0;
		for ( let y = 0; y < size; y ++ ) {

			const v = ( y + 0.5 ) / size - 0.5;
			for ( let x = 0; x < size; x ++ ) {

				const u = ( x + 0.5 ) / size - 0.5, val = p[ y * size + x ];
				a += val; b += val * u; c += val * v; uu += u * u;

			}

		}

		a /= N; b /= uu; c /= uu;
		report.biasDeg.push( round( a * DEG, 2 ) );
		report.rampDeg.push( [ round( b * DEG, 2 ), round( c * DEG, 2 ) ] ); // tilt change across the whole tile along u / v
		const ramp = opts.ramp === true;
		for ( let y = 0; y < size; y ++ ) {

			const v = ( y + 0.5 ) / size - 0.5;
			for ( let x = 0; x < size; x ++ ) p[ y * size + x ] -= a + ( ramp ? b * ( ( x + 0.5 ) / size - 0.5 ) + c * v : 0 );

		}

		if ( opts.ramp ) {

			// pillowing is separable and NOT wrap-continuous (S-shaped tilt profile with a jump at the tile border):
			// subtract the 1D mean profiles along u and v, smoothed WITHOUT wrap-around so the border jump is removed too
			const smooth1D = ( prof, rad ) => prof.map( ( _, i ) => {

				let acc = 0;
				for ( let k = - rad; k <= rad; k ++ ) acc += prof[ Math.min( size - 1, Math.max( 0, i + k ) ) ];
				return acc / ( 2 * rad + 1 );

			} );
			const col = new Float32Array( size ), row = new Float32Array( size );
			for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) { col[ x ] += p[ y * size + x ] / size; row[ y ] += p[ y * size + x ] / size; }
			const rad1 = Math.round( size / 64 );
			const colS = smooth1D( col, rad1 ), rowS = smooth1D( row, rad1 );
			for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) p[ y * size + x ] -= colS[ x ] + rowS[ y ];

		}

		if ( opts.highpass ) {

			const low = wrapBlur2D( p, size, Math.round( size * opts.highpass ) );
			for ( let i = 0; i < N; i ++ ) p[ i ] -= low[ i ];

		}

	}

	const out = Buffer.alloc( N * 3 );
	for ( let i = 0; i < N; i ++ ) {

		let x = comp[ 0 ][ i ], y = comp[ 1 ][ i ];
		const l2 = x * x + y * y;
		if ( l2 > 0.98 ) { const k = Math.sqrt( 0.98 / l2 ); x *= k; y *= k; }
		const z = Math.sqrt( 1 - x * x - y * y );
		out[ i * 3 ] = Math.round( ( x * 0.5 + 0.5 ) * 255 ); out[ i * 3 + 1 ] = Math.round( ( y * 0.5 + 0.5 ) * 255 ); out[ i * 3 + 2 ] = Math.round( ( z * 0.5 + 0.5 ) * 255 );

	}

	await sharp( out, { raw: { width: size, height: size, channels: 3 } } ).jpeg( { quality: 97, chromaSubsampling: '4:4:4', mozjpeg: false } ).toFile( dst );
	return report;

}

// ---------------------------------------------------------------- build
const sets = [];
for ( const set of SETS ) {

	const dir = join( OUT, set.id );
	mkdirSync( dir, { recursive: true } );
	let derived = null, heightNote = null, normalNote = null;

	if ( set.derive === 'flatten-corrugation' ) {

		derived = await flattenCorrugation( set, dir );

	} else {

		for ( const [ name, tag ] of [ [ 'albedo', 'diff|diffuse' ], [ 'normal', 'nor_gl' ], [ 'arm', 'arm' ] ] ) {

			const src = findSrc( set.ph, tag, set.res );
			await assertSize( src, set.res );
			if ( name === 'normal' && set.normalFix ) {

				const rep = await fixNormal( src, join( dir, 'normal.jpg' ), set.res, set.normalFix );
				normalNote = `normal.jpg re-encoded (q97 4:4:4) after clean-up of the Poly Haven nor_gl map: removed constant tilt bias of [${rep.biasDeg.join( ', ' )}] deg (x, y)` + ( set.normalFix.ramp ? `, removed linear tilt ramps across the tile of [${rep.rampDeg[ 0 ].join( ', ' )}] / [${rep.rampDeg[ 1 ].join( ', ' )}] deg (pillowing)` : '' ) + ( set.normalFix.highpass ? `, wrap-around high-pass (box radius ${( set.normalFix.highpass * 100 ).toFixed( 1 )}% of the tile) to remove tile-scale undulation` : '' );

			} else copyFileSync( src, join( dir, `${name}.jpg` ) ); // untouched Poly Haven JPG

		}

		const hsrc = findSrc( set.ph, 'disp', 1024 );
		const hm = await assertSize( hsrc, 1024 );
		if ( hm.channels === 1 ) copyFileSync( hsrc, join( dir, 'height.jpg' ) );
		else {

			await sharp( hsrc ).greyscale().toColourspace( 'b-w' ).jpeg( JPEG ).toFile( join( dir, 'height.jpg' ) );
			heightNote = 'height.jpg re-encoded (source displacement JPG was 3-channel grey) to single-channel greyscale, q95';

		}

	}

	const f = { albedo: join( dir, 'albedo.jpg' ), normal: join( dir, 'normal.jpg' ), arm: join( dir, 'arm.jpg' ), height: join( dir, 'height.jpg' ) };
	await assertSize( f.albedo, set.res ); await assertSize( f.normal, set.res ); await assertSize( f.arm, set.res );
	const hMeta = await assertSize( f.height, 1024 );
	if ( hMeta.channels !== 1 ) throw new Error( `${set.id}: height is not single channel` );

	const a = await albedoStats( f.albedo ), arm = await channelStats( f.arm ), hgt = await channelStats( f.height ), nrm = await normalStats( f.normal );
	const seam = { albedo: await seamRatio( f.albedo ), normal: await seamRatio( f.normal ), height: await seamRatio( f.height ) };
	const baked = await bakedLightCheck( f.albedo, f.normal, f.arm );
	const info = catalog[ set.ph ] ?? JSON.parse( readFileSync( join( SRC, set.ph, '_api_info.json' ), 'utf8' ) );
	const dim = info.dimensions;
	if ( Math.abs( dim[ 0 ] - dim[ 1 ] ) > 1 ) console.warn( `${set.id}: non-square dimensions ${dim}` );
	const bytes = Object.values( f ).reduce( ( s, p ) => s + statSync( p ).size, 0 );
	const hfit = await heightScaleFromNormal( f.height, f.normal, dim[ 0 ] / 1000 );

	const entry = {
		id: set.id,
		intent: set.intent,
		source: `https://polyhaven.com/a/${set.ph}`,
		polyhavenId: set.ph,
		polyhavenName: info.name,
		author: Object.keys( info.authors ).join( ', ' ),
		license: 'CC0',
		resolution: set.res,
		heightResolution: 1024,
		tileSizeMeters: round( dim[ 0 ] / 1000, 3 ),
		texelsPerMeter: Math.round( set.res / ( dim[ 0 ] / 1000 ) ),
		avgColorLinear: a.avgColorLinear,
		avgColorSRGB: a.avgColorSRGB,
		avgRoughness: round( arm.mean[ 1 ], 3 ),
		roughnessRange: [ arm.min[ 1 ], arm.max[ 1 ] ],
		avgAO: round( arm.mean[ 0 ], 3 ),
		avgMetalness: round( arm.mean[ 2 ], 3 ),
		heightMean: round( hgt.mean[ 0 ], 3 ),
		heightRange: [ hgt.min[ 0 ], hgt.max[ 0 ] ],
		heightScaleMeters: hfit.scaleMeters,
		heightFit: { scaleU: hfit.scaleX, scaleV: hfit.scaleY, corrU: hfit.rx, corrV: hfit.ry },
		normalMeanSlope: nrm.meanSlope,
		checks: { seamRatio: seam, bakedLightCorrelation: baked.directional, bakedLightXY: [ baked.rx, baked.ry ] },
		maps: { albedo: `/assets/textures/${set.id}/albedo.jpg`, normal: `/assets/textures/${set.id}/normal.jpg`, arm: `/assets/textures/${set.id}/arm.jpg`, height: `/assets/textures/${set.id}/height.jpg` },
		bytes,
	};
	if ( set.roughnessBias ) entry.recommended = { ...( entry.recommended ?? {} ), roughnessBias: set.roughnessBias, roughnessNote: `Stored roughness (mean ${entry.avgRoughness}) is too glossy for dry, grey weathered timber; use roughness = saturate( sample + ${set.roughnessBias} ).` };
	if ( set.extra ) entry.extra = true;
	if ( set.recommended ) entry.recommended = set.recommended;
	if ( derived ) entry.derived = derived;
	if ( heightNote ) entry.heightNote = heightNote;
	if ( normalNote ) entry.normalNote = normalNote;
	if ( set.aoIntensity ) entry.recommended = { ...( entry.recommended ?? {} ), aoIntensity: set.aoIntensity, aoNote: `AO map is very dark (mean ${entry.avgAO}); use aoMapIntensity ~${set.aoIntensity} (ao = mix(1, aoSample, ${set.aoIntensity})) so ambient light matches the other layers (their mean AO is 0.75-0.97).` };
	sets.push( entry );
	console.log( `${set.id.padEnd( 18 )} <- ${set.ph.padEnd( 22 )} ${set.res}px tile ${entry.tileSizeMeters} m  ${a.avgColorSRGB} rough ${entry.avgRoughness} metal ${entry.avgMetalness}  ${( bytes / 1e6 ).toFixed( 1 )} MB  hScale ${hfit.scaleMeters} m (u ${hfit.scaleX} v ${hfit.scaleY} r ${hfit.rx}/${hfit.ry})${derived ? '  [derived]' : ''}${heightNote ? '  [height re-encoded]' : ''}${normalNote ? '  [normal fixed]' : ''}` );

}

const fxFile = join( SRC, '_fx.json' );
const fx = existsSync( fxFile ) ? JSON.parse( readFileSync( fxFile, 'utf8' ) ) : [];
const index = {
	generator: 'tools/assets/tex-build.mjs + tools/assets/tex-fx.mjs',
	conventions: {
		albedo: 'sRGB JPG (set texture.colorSpace = SRGBColorSpace)',
		normal: 'tangent-space, OpenGL convention (+Y up = Poly Haven nor_gl), linear data (NoColorSpace)',
		arm: 'linear data: R = ambient occlusion, G = roughness, B = metalness',
		height: 'linear data, single channel 8-bit, 1024x1024, white = up. displacementMeters = ( sample - heightMean ) * heightScaleMeters, where heightScaleMeters (black-to-white range) was calibrated by least-squares matching the height-field slopes to the normal map (heightFit.corrU/corrV = correlation of that fit; both positive confirms the OpenGL normal convention)',
		tiling: 'all maps wrap seamlessly (RepeatWrapping); uv = worldPositionMeters / tileSizeMeters',
		avgColorLinear: 'linear-sRGB mean of the albedo (what the smallest mip converges to); use for distant terrain colour / far LOD',
		recommended: 'optional per-set hints: albedoTint = linear RGB multiplier applied to the albedo sample (may exceed 1); aoIntensity = strength to apply the AO channel with (ao = mix(1, aoSample, aoIntensity)); roughnessBias = value to add to the roughness sample; detailRepeatMeters = repeat size for an additional detail-normal sample; note/aoNote = why',
	},
	sets,
	fx,
};
writeFileSync( join( OUT, 'index.json' ), JSON.stringify( index, null, '\t' ) + '\n' );
console.log( `wrote ${join( OUT, 'index.json' )}: ${sets.length} sets, ${fx.length} fx` );
