#!/usr/bin/env node
// Builds the game-ready sky presets from the raw Poly Haven "puresky" HDRIs.
//
//   node tools/assets/sky-build.mjs [presetId ...]        (default: all presets)
//
// For every preset in PRESETS:
//   assets-src/sky/<source>/<source>_4k.hdr  ->  public/assets/sky/<id>/sky.hdr   (byte-identical copy, background)
//   assets-src/sky/<source>_2k/<source>_2k.hdr -> public/assets/sky/<id>/sky_2k.hdr (byte-identical copy, optional
//                                                low-memory background: 16 MB instead of 64 MB of GPU memory)
//                                                public/assets/sky/<id>/env.hdr   (1024x512, sun disc removed, lighting)
//                                                public/assets/sky/<id>/meta.json (measured lighting data)
//                                                public/assets/sky/<id>/thumb.jpg (512x256 tone-mapped menu preview)
// and public/assets/sky/presets.json: [ { id, name, description, files, meta: <meta.json content> }, ... ].
//
// Units: everything is in the HDR's own radiance units (three.js decodes sky.hdr / env.hdr to exactly these numbers).
// Hand-tuned values (exposure, fog density, ...) live in PRESETS and were chosen from the renders of dev/preview-sky.html.

import sharp from 'sharp';
import { copyFileSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readHDR, writeHDR, luminance, rowSolidAngle, rowLat, pixelDir, azElFromDir,
	downsampleEquirect, renderView, tonemapToBytes, linearToHex, round, roundVec,
} from './sky-lib.mjs';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../..' );
const SRC = join( ROOT, 'assets-src/sky' );
const OUT = join( ROOT, 'public/assets/sky' );

const ENV_FACTOR = 4; // 4096x2048 -> 1024x512
const SUN_MASK_DEG = 1.0; // radius of the region in which the sun disc + inner glare are clamped
const SUN_RING_DEG = 0.15; // width of the reference ring just outside the mask (defines the clamp level)
const HORIZON_BAND = [ 1, 6 ]; // elevation range (deg) used for horizon / fog colours
const ZENITH_MIN_EL = 70; // zenith cap
const SUNSIDE = { halfAz: 25, el: [ 1, 8 ], excludeSunDeg: 3 };
const BACKGROUND_CLAMP = 64; // suggested max radiance of the visible sky before bloom / TAA (the raw sun disc is ~65000)

const PRESETS = [
	{
		id: 'golden',
		name: 'Golden Hour',
		source: 'table_mountain_2_puresky',
		author: 'Greg Zaal (original HDRI), Jarod Guest (sky edit)',
		hasSun: true,
		exposure: { aces: 1.0, agx: 1.2 },
		ambientIntensity: 1,
		fogDensity: 'hazy',
		shadowSoftness: 'sharp',
		thumb: { azOffset: 25, el: 17, hfov: 100, exposure: 0.42 },
		description: 'Low warm sun (7 deg) with cumulus clouds catching golden light; long crisp shadows, deep blue zenith.',
	},
	{
		id: 'noon',
		name: 'Midday',
		source: 'kloofendal_48d_partly_cloudy_puresky',
		author: 'Greg Zaal (original HDRI), Jarod Guest (sky edit)',
		hasSun: true,
		exposure: { aces: 0.7, agx: 0.85 },
		ambientIntensity: 1,
		fogDensity: 'clear',
		shadowSoftness: 'sharp',
		thumb: { azOffset: - 22, el: 21, hfov: 100, exposure: 0.45 },
		description: 'High neutral sun (48 deg) in a deep blue sky with fair-weather cumulus; crisp shadows.',
	},
	{
		id: 'overcast',
		name: 'Overcast',
		source: 'overcast_soil_puresky',
		author: 'Sergej Majboroda (original HDRI), Jarod Guest (sky edit)',
		hasSun: false,
		exposure: { aces: 0.52, agx: 0.55 },
		ambientIntensity: 1,
		fogDensity: 'misty',
		shadowSoftness: 'very-soft',
		thumb: { az: 0, el: 18, hfov: 100, exposure: 0.33 },
		description: 'Closed, textured stratocumulus deck; soft shadowless light for the wet-road look.',
	},
	{
		id: 'dusk',
		name: 'Dusk',
		source: 'qwantani_dusk_2_puresky',
		author: 'Greg Zaal (photography), Jarod Guest (processing)',
		hasSun: false,
		exposure: { aces: 0.18, agx: 0.16 },
		ambientIntensity: 1,
		fogDensity: 'hazy',
		shadowSoftness: 'very-soft',
		thumb: { azOffset: 12, el: 16, hfov: 100, exposure: 0.15 },
		description: 'Blue hour after sunset: rose/violet afterglow on one horizon, deep blue-violet zenith; for headlight driving.',
	},
];

/** JSON with tab indentation, but arrays of numbers kept on one line (readable diffs, small files). */
function toJSON( value ) {

	return JSON.stringify( value, null, '\t' ).replace( /\[\s+(-?[\d.eE+-]+(?:,\s+-?[\d.eE+-]+)*)\s+\]/g, ( m, inner ) => '[ ' + inner.replace( /\s+/g, ' ' ) + ' ]' ) + '\n';

}

const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const rad = ( d ) => d * Math.PI / 180;
const md5 = ( file ) => createHash( 'md5' ).update( readFileSync( file ) ).digest( 'hex' );

function median( values ) {

	const s = Float64Array.from( values ).sort();
	if ( ! s.length ) return 0;
	return s.length % 2 ? s[ s.length >> 1 ] : 0.5 * ( s[ s.length / 2 - 1 ] + s[ s.length / 2 ] );

}

/** Rows that can contain pixels within `deg` of direction d. */
function rowRange( d, deg, H ) {

	const el = Math.asin( d[ 1 ] ) * 180 / Math.PI;
	const r0 = Math.max( 0, Math.floor( ( 0.5 - ( el + deg ) / 180 ) * H ) - 1 );
	const r1 = Math.min( H - 1, Math.ceil( ( 0.5 - ( el - deg ) / 180 ) * H ) + 1 );
	return [ r0, r1 ];

}

function findSun( img ) {

	const { width: W, height: H, data } = img;
	let peak = 0, pc = 0, pr = 0;
	for ( let r = 0; r < H / 2; r ++ ) for ( let c = 0; c < W; c ++ ) {

		const o = ( r * W + c ) * 3;
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		if ( L > peak ) { peak = L; pc = c; pr = r; }

	}

	const d0 = pixelDir( pc, pr, W, H );
	const cen = [ 0, 0, 0 ];
	const cosLim = Math.cos( rad( 1.5 ) );
	const [ r0, r1 ] = rowRange( d0, 1.5, H );
	for ( let r = r0; r <= r1; r ++ ) {

		const sa = rowSolidAngle( r, W, H );
		for ( let c = 0; c < W; c ++ ) {

			const d = pixelDir( c, r, W, H );
			if ( dot( d, d0 ) < cosLim ) continue;
			const o = ( r * W + c ) * 3;
			const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
			if ( L < 0.2 * peak ) continue;
			for ( let k = 0; k < 3; k ++ ) cen[ k ] += d[ k ] * L * sa;

		}

	}

	const l = Math.hypot( ...cen );
	return { dir: cen.map( ( v ) => v / l ), peak };

}

/**
 * Clamps the sun disc + inner glare (everything brighter than the sky just outside the mask) in place.
 * Returns the removed energy per channel = sum( removed radiance * solid angle ) = irradiance on a surface facing the sun.
 */
function removeSun( img, sunDir ) {

	const { width: W, height: H, data } = img;
	const cosMask = Math.cos( rad( SUN_MASK_DEG ) ), cosRing = Math.cos( rad( SUN_MASK_DEG + SUN_RING_DEG ) );
	const [ r0, r1 ] = rowRange( sunDir, SUN_MASK_DEG + SUN_RING_DEG, H );
	const ring = [];
	const inside = [];
	for ( let r = r0; r <= r1; r ++ ) for ( let c = 0; c < W; c ++ ) {

		const cs = dot( pixelDir( c, r, W, H ), sunDir );
		if ( cs < cosRing ) continue;
		const o = ( r * W + c ) * 3;
		if ( cs >= cosMask ) inside.push( o, r ); else ring.push( luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] ) );

	}

	const cap = median( ring );
	const removed = [ 0, 0, 0 ];
	let clamped = 0, overHalf = 0;
	for ( let i = 0; i < inside.length; i += 2 ) {

		const o = inside[ i ], r = inside[ i + 1 ];
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		if ( Math.max( data[ o ], data[ o + 1 ], data[ o + 2 ] ) > 65504 ) overHalf ++;
		if ( L <= cap ) continue;
		const s = cap / L, sa = rowSolidAngle( r, W, H );
		for ( let k = 0; k < 3; k ++ ) {

			removed[ k ] += data[ o + k ] * ( 1 - s ) * sa;
			data[ o + k ] *= s;

		}

		clamped ++;

	}

	return { removed, cap, clamped, maskPixels: inside.length / 2, overHalf };

}

/** Direction of the brightest sky region: argmax of the mean luminance inside a cap of `capDeg` (upper hemisphere). */
function brightestRegion( img, capDeg = 10 ) {

	let small = img;
	while ( small.width > 256 ) small = downsampleEquirect( small, 2 );
	const { width: W, height: H, data } = small;
	const n = W * H / 2; // upper hemisphere rows
	const dirs = new Float32Array( n * 3 ), Lw = new Float32Array( n ), sas = new Float32Array( n );
	for ( let r = 0; r < H / 2; r ++ ) {

		const sa = rowSolidAngle( r, W, H );
		for ( let c = 0; c < W; c ++ ) {

			const i = r * W + c, d = pixelDir( c, r, W, H );
			dirs[ i * 3 ] = d[ 0 ]; dirs[ i * 3 + 1 ] = d[ 1 ]; dirs[ i * 3 + 2 ] = d[ 2 ];
			Lw[ i ] = luminance( data[ i * 3 ], data[ i * 3 + 1 ], data[ i * 3 + 2 ] ) * sa;
			sas[ i ] = sa;

		}

	}

	const cosCap = Math.cos( rad( capDeg ) );
	let best = - 1;
	const means = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		if ( dirs[ i * 3 + 1 ] < Math.sin( rad( 2 ) ) ) continue;
		const x = dirs[ i * 3 ], y = dirs[ i * 3 + 1 ], z = dirs[ i * 3 + 2 ];
		let s = 0, w = 0;
		for ( let j = 0; j < n; j ++ ) {

			if ( x * dirs[ j * 3 ] + y * dirs[ j * 3 + 1 ] + z * dirs[ j * 3 + 2 ] < cosCap ) continue;
			s += Lw[ j ]; w += sas[ j ];

		}

		means[ i ] = s / w;
		if ( means[ i ] > best ) best = means[ i ];

	}

	// refine: centroid of the candidates within 97 % of the best cap mean (stable against plateaus)
	const cen = [ 0, 0, 0 ];
	for ( let i = 0; i < n; i ++ ) if ( means[ i ] >= 0.97 * best ) for ( let k = 0; k < 3; k ++ ) cen[ k ] += dirs[ i * 3 + k ] * sas[ i ];
	const l = Math.hypot( ...cen );
	const dir = cen.map( ( v ) => v / l );

	// mean colour of the cap around that direction
	const col = [ 0, 0, 0 ];
	let w = 0;
	for ( let j = 0; j < n; j ++ ) {

		if ( dir[ 0 ] * dirs[ j * 3 ] + dir[ 1 ] * dirs[ j * 3 + 1 ] + dir[ 2 ] * dirs[ j * 3 + 2 ] < cosCap ) continue;
		for ( let k = 0; k < 3; k ++ ) col[ k ] += data[ j * 3 + k ] * sas[ j ];
		w += sas[ j ];

	}

	return { dir, color: col.map( ( v ) => v / w ), capMeanLuminance: best };

}

function measure( env, sunDir ) {

	const { width: W, height: H, data } = env;
	const acc = () => ( { rgb: [ 0, 0, 0 ], w: 0 } );
	const add = ( a, o, w ) => { a.rgb[ 0 ] += data[ o ] * w; a.rgb[ 1 ] += data[ o + 1 ] * w; a.rgb[ 2 ] += data[ o + 2 ] * w; a.w += w; };
	const mean = ( a ) => a.rgb.map( ( v ) => v / ( a.w || 1 ) );

	const zenith = acc(), horizon = acc(), ground = acc(), sphere = acc(), upper = acc(), sunside = acc();
	const sectors = Array.from( { length: 8 }, acc );
	const irrUp = [ 0, 0, 0 ], irrDown = [ 0, 0, 0 ];
	let peakL = 0;
	const sunAz = azElFromDir( sunDir ).az;
	const cosExcl = Math.cos( rad( SUNSIDE.excludeSunDeg ) );

	for ( let r = 0; r < H; r ++ ) {

		const sa = rowSolidAngle( r, W, H );
		const el = rowLat( r, H ) * 180 / Math.PI;
		const sinEl = Math.sin( rad( el ) );
		for ( let c = 0; c < W; c ++ ) {

			const o = ( r * W + c ) * 3;
			const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
			if ( L > peakL ) peakL = L;
			add( sphere, o, sa );
			if ( el > 0 ) {

				add( upper, o, sa );
				for ( let k = 0; k < 3; k ++ ) irrUp[ k ] += data[ o + k ] * sinEl * sa;

			} else {

				add( ground, o, sa );
				for ( let k = 0; k < 3; k ++ ) irrDown[ k ] += data[ o + k ] * - sinEl * sa;

			}

			if ( el >= ZENITH_MIN_EL ) add( zenith, o, sa );
			const inBand = el >= HORIZON_BAND[ 0 ] && el <= HORIZON_BAND[ 1 ];
			const inSunBand = el >= SUNSIDE.el[ 0 ] && el <= SUNSIDE.el[ 1 ];
			if ( inBand || inSunBand ) {

				const d = pixelDir( c, r, W, H );
				let az = Math.atan2( d[ 0 ], d[ 2 ] ) * 180 / Math.PI;
				if ( az < 0 ) az += 360;
				if ( inBand ) {

					add( horizon, o, sa );
					add( sectors[ Math.round( az / 45 ) % 8 ], o, sa );

				}

				if ( inSunBand ) {

					let dAz = Math.abs( az - sunAz );
					if ( dAz > 180 ) dAz = 360 - dAz;
					if ( dAz <= SUNSIDE.halfAz && dot( d, sunDir ) < cosExcl ) add( sunside, o, sa );

				}

			}

		}

	}

	return {
		zenithColor: mean( zenith ), horizonColor: mean( horizon ), horizonColors: sectors.map( mean ),
		sunsideHazeColor: mean( sunside ), groundColor: mean( ground ),
		averageColor: mean( sphere ), upperColor: mean( upper ),
		skyIrradiance: irrUp, groundIrradiance: irrDown, peakL,
	};

}

async function build( preset ) {

	const t0 = Date.now();
	const srcFile = join( SRC, preset.source, preset.source + '_4k.hdr' );
	const outDir = join( OUT, preset.id );
	mkdirSync( outDir, { recursive: true } );
	const skyFile = join( outDir, 'sky.hdr' );
	copyFileSync( srcFile, skyFile );
	copyFileSync( join( SRC, preset.source + '_2k', preset.source + '_2k.hdr' ), join( outDir, 'sky_2k.hdr' ) );

	const sky = readHDR( skyFile );
	const { width: W, height: H } = sky;
	let skyPeak = 0;
	for ( let i = 0; i < W * H; i ++ ) skyPeak = Math.max( skyPeak, luminance( sky.data[ i * 3 ], sky.data[ i * 3 + 1 ], sky.data[ i * 3 + 2 ] ) );
	if ( W !== 4096 || H !== 2048 ) throw new Error( `${preset.id}: expected 4096x2048, got ${W}x${H}` );

	const exposure = preset.exposure;

	let sunDir, sunE = [ 0, 0, 0 ], sunInfo = null, brightest = null;
	const work = { width: W, height: H, data: Float32Array.from( sky.data ) };

	if ( preset.hasSun ) {

		const found = findSun( sky );
		sunDir = found.dir;
		const res = removeSun( work, sunDir );
		sunE = res.removed;
		sunInfo = { peakLuminance: found.peak, clampLuminance: res.cap, clampedPixels: res.clamped, maskPixels: res.maskPixels, pixelsAboveHalfFloat: res.overHalf };

	} else {

		brightest = brightestRegion( sky, 10 );
		sunDir = brightest.dir;

	}

	const env = downsampleEquirect( work, ENV_FACTOR );
	const envFile = join( outDir, 'env.hdr' );
	writeHDR( envFile, env.width, env.height, env.data, { rle: true, comment: `Alpenglow sky preset "${preset.id}" - lighting environment (sun disc removed), from ${preset.source} (Poly Haven, CC0)` } );

	// statistics are measured on what the renderer will actually use: the decoded env.hdr
	const envDecoded = readHDR( envFile );
	const m = measure( envDecoded, sunDir );
	const ae = azElFromDir( sunDir );

	const sunMax = Math.max( ...sunE );
	const sunColor = preset.hasSun ? sunE.map( ( v ) => v / sunMax ) : ( () => { const mx = Math.max( ...brightest.color ); return brightest.color.map( ( v ) => v / mx ); } )();
	const sunIntensity = preset.hasSun ? sunMax : 0;
	const lum = ( c ) => luminance( c[ 0 ], c[ 1 ], c[ 2 ] );
	const sunIrrHoriz = sunE.map( ( v ) => v * Math.max( 0, Math.sin( rad( ae.el ) ) ) );
	// uniform fog colour: per-channel median of the 8 horizon sectors (the plain mean is dominated by the sun-side sector
	// and would make fog glow against the darker sky everywhere else)
	const fogColor = [ 0, 1, 2 ].map( ( k ) => median( m.horizonColors.map( ( c ) => c[ k ] ) ) );

	const meta = {
		id: preset.id,
		name: preset.name,
		description: preset.description,
		hasSun: preset.hasSun,
		sunDirection: roundVec( sunDir, 5 ),
		sunElevationDeg: round( ae.el, 2 ),
		sunAzimuthDeg: round( ae.az, 2 ),
		sunColor: roundVec( sunColor, 4 ),
		sunColorHex: linearToHex( sunColor ),
		sunIntensity: round( sunIntensity, 4 ),
		sunAngularDiameterDeg: preset.hasSun ? 0.53 : null,
		shadowSoftness: preset.shadowSoftness,
		ambientIntensity: preset.ambientIntensity,
		exposure: { aces: exposure.aces, agx: exposure.agx },
		zenithColor: roundVec( m.zenithColor, 4 ),
		horizonColor: roundVec( m.horizonColor, 4 ),
		horizonColors: m.horizonColors.map( ( c ) => roundVec( c, 4 ) ),
		sunsideHazeColor: roundVec( m.sunsideHazeColor, 4 ),
		groundColor: roundVec( m.groundColor, 4 ),
		averageLuminance: round( lum( m.averageColor ), 4 ),
		averageColor: roundVec( m.averageColor, 4 ),
		upperHemisphereLuminance: round( lum( m.upperColor ), 4 ),
		skyIrradiance: roundVec( m.skyIrradiance, 4 ),
		groundIrradiance: roundVec( m.groundIrradiance, 4 ),
		sunIrradianceHorizontal: roundVec( sunIrrHoriz, 4 ),
		sunToSkyRatio: round( lum( sunIrrHoriz ) / lum( m.skyIrradiance ), 3 ),
		envPeakLuminance: round( m.peakL, 3 ),
		skyPeakLuminance: round( skyPeak, 1 ),
		backgroundClamp: skyPeak > BACKGROUND_CLAMP ? BACKGROUND_CLAMP : null,
		fog: { color: roundVec( fogColor, 4 ), density: preset.fogDensity },
		files: {
			sky: `/assets/sky/${preset.id}/sky.hdr`, sky2k: `/assets/sky/${preset.id}/sky_2k.hdr`, env: `/assets/sky/${preset.id}/env.hdr`,
			thumb: `/assets/sky/${preset.id}/thumb.jpg`, meta: `/assets/sky/${preset.id}/meta.json`,
		},
		resolution: { sky: [ W, H ], sky2k: [ W / 2, H / 2 ], env: [ env.width, env.height ] },
		conventions: {
			space: 'three.js world space, Y up, equirect used with EquirectangularReflectionMapping and no rotation',
			azimuth: 'degrees, atan2(x, z): 0 = +Z, 90 = +X, 180 = -Z, 270 = -X; direction = (cos(el) sin(az), sin(el), cos(el) cos(az))',
			horizonColors: `8 sectors of 45 deg centred on azimuth 0, 45, ... 315; elevation band ${HORIZON_BAND[ 0 ]}..${HORIZON_BAND[ 1 ]} deg`,
			fogColor: 'per-channel median of horizonColors (use horizonColors / sunsideHazeColor for direction-dependent fog)',
			colors: 'linear sRGB (Rec.709 primaries), radiance in the units of sky.hdr / env.hdr',
			sunIntensity: 'DirectionalLight.intensity for color = sunColor; intensity * color = irradiance removed from env.hdr',
			backgroundClamp: 'suggested min( skyRadiance, backgroundClamp ) for the visible sky before bloom / TAA (null = not needed)',
		},
		source: `https://polyhaven.com/a/${preset.source}`,
		sourceId: preset.source,
		author: preset.author,
		license: 'CC0',
	};

	if ( sunInfo ) meta.sunRemoval = {
		maskRadiusDeg: SUN_MASK_DEG,
		clampLuminance: round( sunInfo.clampLuminance, 3 ),
		clampedPixels4k: sunInfo.clampedPixels,
		skyPixelsAboveHalfFloatMax: sunInfo.pixelsAboveHalfFloat,
	};

	writeFileSync( join( outDir, 'meta.json' ), toJSON( meta ) );

	// thumbnail: perspective view toward the sun / brightest region (ACES curve)
	const t = preset.thumb;
	let thumbSrc = sky;
	while ( thumbSrc.width > 2048 ) thumbSrc = downsampleEquirect( thumbSrc, 2 );
	const view = renderView( thumbSrc, { azDeg: t.az ?? ( ae.az + t.azOffset ), elDeg: t.el, hfovDeg: t.hfov, width: 512, height: 256, ss: 3 } );
	// thumbnails show only sky, so they use their own (lower) exposure than the scene exposure
	const bytes = tonemapToBytes( view, t.exposure ?? exposure.aces );
	await sharp( bytes, { raw: { width: 512, height: 256, channels: 3 } } ).jpeg( { quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' } ).toFile( join( outDir, 'thumb.jpg' ) );

	const size = ( f ) => statSync( join( outDir, f ) ).size;
	console.log( `[${preset.id}] ${preset.source}  (${Date.now() - t0} ms)` );
	console.log( `  sun dir ${meta.sunDirection.join( ', ' )}  el ${meta.sunElevationDeg}  az ${meta.sunAzimuthDeg}  hasSun ${meta.hasSun}` );
	if ( sunInfo ) console.log( `  sun: peak L ${sunInfo.peakLuminance.toFixed( 0 )}, clamp L ${sunInfo.clampLuminance.toFixed( 2 )}, clamped ${sunInfo.clampedPixels}/${sunInfo.maskPixels} px, > half-float ${sunInfo.pixelsAboveHalfFloat} px` );
	console.log( `  sunColor ${meta.sunColor.join( ', ' )} (#${meta.sunColorHex})  sunIntensity ${meta.sunIntensity}  sun/sky(horizontal) ${meta.sunToSkyRatio}` );
	console.log( `  skyIrradiance ${meta.skyIrradiance.join( ', ' )}  zenith ${meta.zenithColor.join( ', ' )}  horizon ${meta.horizonColor.join( ', ' )}` );
	console.log( `  sunside haze ${meta.sunsideHazeColor.join( ', ' )}  ground ${meta.groundColor.join( ', ' )}  avgL ${meta.averageLuminance}  env peak L ${meta.envPeakLuminance}` );
	console.log( `  files: sky.hdr ${size( 'sky.hdr' )} (md5 ${md5( skyFile )})  sky_2k.hdr ${size( 'sky_2k.hdr' )}  env.hdr ${size( 'env.hdr' )}  thumb.jpg ${size( 'thumb.jpg' )}` );
	return meta;

}

const only = process.argv.slice( 2 );
const metas = [];
for ( const preset of PRESETS ) {

	if ( only.length && ! only.includes( preset.id ) ) {

		// keep the existing meta for presets that are not rebuilt
		const f = join( OUT, preset.id, 'meta.json' );
		if ( existsSync( f ) ) metas.push( JSON.parse( readFileSync( f, 'utf8' ) ) );
		continue;

	}

	metas.push( await build( preset ) );

}

// presets.json: [ { id, name, description, files: { sky, env, thumb, meta }, meta: <content of meta.json> }, ... ]
const presets = metas.map( ( meta ) => ( { id: meta.id, name: meta.name, description: meta.description, files: meta.files, meta } ) );
writeFileSync( join( OUT, 'presets.json' ), toJSON( presets ) );
console.log( 'wrote', join( OUT, 'presets.json' ), `(${presets.length} presets)` );
