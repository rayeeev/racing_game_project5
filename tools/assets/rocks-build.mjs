#!/usr/bin/env node
// Build game-ready rock GLBs (variants + LODs + shared WebP textures) and public/assets/rocks/index.json from Poly Haven sources.
//
//   node tools/assets/rocks-build.mjs [--only id1,id2] [--out public/assets/rocks] [--cache <dir>] [--no-index]
//                                     [--lod-mode attr|pos|update] [--normal-weight 0.5] [--lod-normals keep|recompute|blend]
//                                     [--suffix _test] [--no-grade] [--orm-size <px>] [--tex-format webp|jpeg] [--normal-format jpeg|webp] [--quality 90]
//
// Conventions of the output (see the report / index.json): meters, Y up, one GLB per asset, nodes "<variant>_LOD<n>" at the scene
// root with identity transforms, geometry pivot at the bottom centre of the variant's bounding box, one shared material per file.
import { Document } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ASSETS, GRADE_TARGET, LOD_BUDGETS } from './rocks-config.mjs';
import {
	makeIO, extractNodeGeometry, weldGeometry, transformGeometry, boundsOf, surfaceArea, meanFaceNormal, rasterizeUvMask,
	simplifyGeometry, recomputeNormals, blendNormals, meshDeviation, approximateHull, SRGB8_TO_LINEAR, linearToSrgb, toHex,
} from './rocks-lib.mjs';
import {
	loadRGB8, loadGrey8, pushPullFill, resizeLanczos, srgb8ToLinearFloat, u8ToFloat, linearFloatToSrgb8, floatToU8,
	rockStats, gradeRock, renormalizeNormals, encodeTexture,
} from './rocks-tex.mjs';

const ROOT = resolve( import.meta.dirname, '../..' );
const args = {};
for ( let i = 2; i < process.argv.length; i ++ ) {

	const a = process.argv[ i ];
	if ( ! a.startsWith( '--' ) ) continue;
	const next = process.argv[ i + 1 ];
	if ( next === undefined || next.startsWith( '--' ) ) args[ a.slice( 2 ) ] = true; else { args[ a.slice( 2 ) ] = next; i ++; }

}

const OUT = resolve( ROOT, args.out || 'public/assets/rocks' );
const CACHE = resolve( args.cache || '/private/tmp/claude-501/-Users-rayeeev-Desktop-Coding-Playground-Game/c7fa453a-8723-4335-bdc3-fea318946bcc/scratchpad/rocks/texcache' );
const SUFFIX = typeof args.suffix === 'string' ? args.suffix : '';
const LOD_MODE = args[ 'lod-mode' ] || 'attr';
const NORMAL_WEIGHT = args[ 'normal-weight' ] !== undefined ? Number( args[ 'normal-weight' ] ) : 0.5;
const LOD_NORMALS = args[ 'lod-normals' ] || 'recompute';
const TEX_FORMAT = args[ 'tex-format' ] || 'webp';
const NORMAL_FORMAT = args[ 'normal-format' ] || 'jpeg';
const QUALITY = args.quality !== undefined ? Number( args.quality ) : 90;
const AO_MEAN_MIN = 0.7, AO_GAMMA_MIN = 0.6;
mkdirSync( OUT, { recursive: true } );
mkdirSync( CACHE, { recursive: true } );
const URL_BASE = '/' + relative( join( ROOT, 'public' ), OUT ).split( '\\' ).join( '/' );

const io = await makeIO();
const log = ( ...a ) => console.log( ...a );
const r3 = ( v ) => Math.round( v * 1000 ) / 1000;
const r4 = ( v ) => Math.round( v * 10000 ) / 10000;

// ------------------------------------------------------------------------------------------------ textures

async function buildTextures( asset, srcGeos ) {

	// srcGeos: welded source geometries with their ORIGINAL uvs (before any crop) - used for the coverage mask.
	const maps = asset.maps;
	const size = asset.textureSize;
	// AO / roughness are low-frequency: half resolution is visually identical (verified in close-ups) and saves 25 % of the GPU memory
	const ormSize = args[ 'orm-size' ] ? Number( args[ 'orm-size' ] ) : ( asset.ormSize || size / 2 );
	const grade = args[ 'no-grade' ] ? null : { ...GRADE_TARGET, ...( asset.grade || {} ) };

	// --- UV extent -> optional crop of unused rows (v = 0 is the top row)
	let maxV = 0;
	for ( const g of srcGeos ) for ( let i = 1; i < g.uv.length; i += 2 ) if ( g.uv[ i ] > maxV ) maxV = g.uv[ i ];
	const probe = await loadRGB8( resolve( ROOT, maps.baseColor ) );
	const SW = probe.width, SH = probe.height;
	let cropRows = SH;
	if ( maxV < 0.9 ) cropRows = Math.min( SH, Math.ceil( maxV * SH ) + 4 );
	const uvScale = [ 1, SH / cropRows ];

	const key = createHash( 'md5' ).update( JSON.stringify( { v: 9, ao: [ AO_MEAN_MIN, AO_GAMMA_MIN ], id: asset.id, maps, size, ormSize, grade, cropRows, fmt: TEX_FORMAT, nfmt: NORMAL_FORMAT, q: QUALITY, nofix: !! args[ 'no-normal-fix' ], scale: asset.scale || 1 } ) ).digest( 'hex' ).slice( 0, 12 );
	const metaFile = join( CACHE, `${asset.id}_${key}.json` );
	if ( existsSync( metaFile ) && ! args[ 'no-cache' ] ) {

		const meta = JSON.parse( readFileSync( metaFile, 'utf8' ) );
		log( `  textures: cache hit (${key})` );
		return { ...meta, uvScale, textures: Object.fromEntries( Object.entries( meta.files ).map( ( [ k, f ] ) => [ k, { buffer: readFileSync( join( CACHE, f.file ) ), mime: f.mime, width: f.width, height: f.height } ] ) ) };

	}

	const t0 = performance.now();
	// coverage mask at source resolution (texel centre inside a UV triangle)
	const maskFull = rasterizeUvMask( srcGeos, SW, SH, 0 );
	const mask = maskFull.subarray( 0, SW * cropRows );
	let covered = 0;
	for ( let i = 0; i < mask.length; i ++ ) covered += mask[ i ];
	log( `  textures: source ${SW}x${SH}, crop rows ${cropRows}, UV coverage ${( covered / mask.length * 100 ).toFixed( 1 )}% (${( performance.now() - t0 ).toFixed( 0 )} ms)` );

	const outW = size, outH = size;
	const result = { files: {}, gradeInfo: null, sourceStats: null, gradedStats: null, cropRows, sourceSize: [ SW, SH ] };
	const save = async ( name, u8, w, h, kind ) => {

		// lossy WebP always subsamples chroma (4:2:0), which costs ~2 deg mean angular error on normal maps even at q98;
		// normal maps are therefore stored as 4:4:4 JPEG (measured 1.5 deg at q90), colour + ORM as WebP
		const fmt = kind === 'normal' ? NORMAL_FORMAT : TEX_FORMAT;
		const enc = await encodeTexture( u8, w, h, { format: fmt, quality: QUALITY, kind } );
		const file = `${asset.id}_${key}_${name}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
		writeFileSync( join( CACHE, file ), enc.buffer );
		// keep the exact 8-bit pixels as well (PNG) for avgColor sampling / verification
		result.files[ name ] = { file, mime: enc.mime, width: w, height: h, bytes: enc.buffer.length };
		return enc;

	};

	// --- base colour
	{

		const lin = srgb8ToLinearFloat( probe.data.subarray( 0, SW * cropRows * 3 ) );
		const stats = rockStats( lin, mask, 3 );
		result.sourceStats = stats;
		if ( grade ) {

			result.gradeInfo = gradeRock( lin, stats, grade );
			result.gradedStats = rockStats( lin, mask, 3 );

		}

		pushPullFill( lin, SW, cropRows, 3, mask );
		const small = resizeLanczos( lin, SW, cropRows, 3, outW, outH );
		const u8 = linearFloatToSrgb8( small );
		await save( 'basecolor', u8, outW, outH, 'color' );
		writeFileSync( join( CACHE, `${asset.id}_${key}_basecolor.raw` ), u8 );
		log( `  basecolor: source rock mean L ${stats.L.toFixed( 3 )} C ${stats.chroma.toFixed( 4 )} hue ${stats.hue.toFixed( 0 )} green ${( stats.greenFraction * 100 ).toFixed( 1 )}%` + ( grade ? ` -> graded L ${result.gradedStats.L.toFixed( 3 )} C ${result.gradedStats.chroma.toFixed( 4 )} hue ${result.gradedStats.hue.toFixed( 0 )} (gainL ${result.gradeInfo.gainL.toFixed( 3 )}, chroma x${result.gradeInfo.chromaGain.toFixed( 2 )}, hue ${result.gradeInfo.hueShiftDeg.toFixed( 0 )} deg)` : '' ) );

	}

	// --- normal map (OpenGL convention, +Y up)
	{

		const src = await loadRGB8( resolve( ROOT, maps.normal ) );
		if ( src.width !== SW || src.height !== SH ) throw new Error( 'normal map size mismatch' );
		const f = u8ToFloat( src.data.subarray( 0, SW * cropRows * 3 ) );
		if ( maps.normalFixFromHeight && ! args[ 'no-normal-fix' ] ) {

			// rebuild the green channel detail from the height map: y = +gain * dh/drow (OpenGL), see rocks-config.mjs
			const hgt = await sharpBlurGrey( resolve( ROOT, maps.normalFixFromHeight.height ), 0.8 );
			if ( hgt.width !== SW || hgt.height !== SH ) throw new Error( 'height map size mismatch' );
			const gain = maps.normalFixFromHeight.gain / 255; // per 8-bit height level, in 0..1 normal-map units
			for ( let y = 1; y < cropRows - 1; y ++ ) for ( let x = 0; x < SW; x ++ ) {

				const i = y * SW + x;
				const dhdrow = ( hgt.data[ i + SW ] - hgt.data[ i - SW ] ) * 0.5;
				f[ i * 3 + 1 ] = Math.max( 0, Math.min( 1, f[ i * 3 + 1 ] + gain * dhdrow ) );

			}

			// z from unit length
			for ( let i = 0; i < f.length; i += 3 ) {

				const x = f[ i ] * 2 - 1, y = f[ i + 1 ] * 2 - 1;
				f[ i + 2 ] = Math.sqrt( Math.max( 0.04, 1 - x * x - y * y ) ) * 0.5 + 0.5;

			}

			log( '  normal: green channel detail rebuilt from the height map' );

		}

		pushPullFill( f, SW, cropRows, 3, mask );
		const small = resizeLanczos( f, SW, cropRows, 3, outW, outH );
		renormalizeNormals( small );
		await save( 'normal', floatToU8( small ), outW, outH, 'normal' );

	}

	// --- ORM (R = occlusion, G = roughness, B = metallic = 0)
	{

		const f = new Float32Array( SW * cropRows * 3 );
		let aoData = null, roughData = null;
		if ( maps.arm ) {

			const arm = await loadRGB8( resolve( ROOT, maps.arm ) );
			if ( arm.width !== SW || arm.height !== SH ) throw new Error( 'arm map size mismatch' );
			for ( let i = 0; i < SW * cropRows; i ++ ) { f[ i * 3 ] = arm.data[ i * 3 ] / 255; f[ i * 3 + 1 ] = arm.data[ i * 3 + 1 ] / 255; }

		} else {

			const loadCh = async ( spec ) => {

				if ( ! spec ) return null;
				const path = typeof spec === 'string' ? spec : spec.path;
				const ch = typeof spec === 'string' ? 0 : spec.channel;
				const g = typeof spec === 'string' ? await loadGrey8( resolve( ROOT, path ), 0 ) : { ...( await loadRGB8( resolve( ROOT, path ) ) ), rgb: true };
				if ( g.width !== SW || g.height !== SH ) throw new Error( 'map size mismatch: ' + path );
				return g.rgb ? { data: g.data, stride: 3, offset: ch } : { data: g.data, stride: 1, offset: 0 };

			};

			aoData = await loadCh( maps.ao );
			roughData = await loadCh( maps.rough );
			for ( let i = 0; i < SW * cropRows; i ++ ) {

				f[ i * 3 ] = aoData ? aoData.data[ i * aoData.stride + aoData.offset ] / 255 : 1;
				f[ i * 3 + 1 ] = roughData ? roughData.data[ i * roughData.stride + roughData.offset ] / 255 : 1;

			}

		}

		// statistics inside the mask
		const ormMean = () => {

			let n = 0, sAo = 0, sR = 0;
			for ( let i = 0; i < mask.length; i += 7 ) if ( mask[ i ] ) { n ++; sAo += f[ i * 3 ]; sR += f[ i * 3 + 1 ]; }
			return { meanAO: sAo / n, meanRoughness: sR / n };

		};

		const src = ormMean();
		// AO strength normalisation: some scans ship very heavy AO (mean ~0.5), which makes them much darker than the rest of the
		// set in ambient light. Lift those with a gamma so the mean lands near AO_MEAN_MIN (gamma never below AO_GAMMA_MIN).
		let aoGamma = 1;
		if ( src.meanAO < AO_MEAN_MIN ) aoGamma = Math.max( AO_GAMMA_MIN, Math.log( AO_MEAN_MIN ) / Math.log( src.meanAO ) );
		if ( aoGamma !== 1 ) for ( let i = 0; i < f.length; i += 3 ) f[ i ] = Math.pow( f[ i ], aoGamma );
		pushPullFill( f, SW, cropRows, 3, mask );
		for ( let i = 2; i < f.length; i += 3 ) f[ i ] = 0;
		const small = resizeLanczos( f, SW, cropRows, 3, ormSize, ormSize );
		const fin = ormMean();
		result.ormStats = { meanAO: r3( fin.meanAO ), meanRoughness: r3( fin.meanRoughness ), sourceMeanAO: r3( src.meanAO ), aoGamma: r3( aoGamma ) };
		await save( 'orm', floatToU8( small ), ormSize, ormSize, 'data' );
		log( `  orm: mean AO ${result.ormStats.meanAO} (source ${result.ormStats.sourceMeanAO}, gamma ${result.ormStats.aoGamma}) mean roughness ${result.ormStats.meanRoughness}` );

	}

	writeFileSync( metaFile, JSON.stringify( result ) );
	log( `  textures built in ${( ( performance.now() - t0 ) / 1000 ).toFixed( 1 )} s: ` + Object.entries( result.files ).map( ( [ k, f ] ) => `${k} ${f.width}x${f.height} ${( f.bytes / 1024 ).toFixed( 0 )} kB` ).join( ', ' ) );
	return { ...result, uvScale, textures: Object.fromEntries( Object.entries( result.files ).map( ( [ k, f ] ) => [ k, { buffer: readFileSync( join( CACHE, f.file ) ), mime: f.mime, width: f.width, height: f.height } ] ) ), key };

}

async function sharpBlurGrey( path, sigma ) {

	// greyscale image -> Float32 (0..255 scale), blurred with a separable gaussian in float precision
	const { data: raw, width: W, height: H } = await loadGrey8( path, 0 );
	const radius = Math.ceil( sigma * 3 );
	const kernel = [];
	let ksum = 0;
	for ( let k = - radius; k <= radius; k ++ ) { const w = Math.exp( - k * k / ( 2 * sigma * sigma ) ); kernel.push( w ); ksum += w; }
	const tmp = new Float32Array( W * H ), f = new Float32Array( W * H );
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		let acc = 0;
		for ( let k = - radius; k <= radius; k ++ ) { const xx = Math.min( W - 1, Math.max( 0, x + k ) ); acc += raw[ y * W + xx ] * kernel[ k + radius ]; }
		tmp[ y * W + x ] = acc / ksum;

	}

	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		let acc = 0;
		for ( let k = - radius; k <= radius; k ++ ) { const yy = Math.min( H - 1, Math.max( 0, y + k ) ); acc += tmp[ yy * W + x ] * kernel[ k + radius ]; }
		f[ y * W + x ] = acc / ksum;

	}

	return { data: f, width: W, height: H };

}

// ------------------------------------------------------------------------------------------------ geometry

function quantizeGrid( maxDim ) {

	// power-of-two grid giving >= 13 bits of precision over the largest dimension (floats stay exactly representable)
	return Math.pow( 2, Math.floor( Math.log2( maxDim / 8192 ) ) );

}

function finalizeGeometry( geo, grid ) {

	// reorder for vertex cache / compression, snap positions to the grid, quantise normals + uvs
	const index = new Uint32Array( geo.index );
	const [ remap, unique ] = MeshoptEncoder.reorderMesh( index, true, true );
	const position = new Float32Array( unique * 3 ), normal = new Int16Array( unique * 3 ), uv = new Uint16Array( unique * 2 );
	const n = geo.position.length / 3;
	for ( let i = 0; i < n; i ++ ) {

		const r = remap[ i ];
		if ( r === 0xffffffff ) continue;
		for ( let k = 0; k < 3; k ++ ) {

			position[ r * 3 + k ] = Math.round( geo.position[ i * 3 + k ] / grid ) * grid;
			normal[ r * 3 + k ] = Math.max( - 32767, Math.min( 32767, Math.round( geo.normal[ i * 3 + k ] * 32767 ) ) );

		}

		uv[ r * 2 ] = Math.max( 0, Math.min( 65535, Math.round( geo.uv[ i * 2 ] * 65535 ) ) );
		uv[ r * 2 + 1 ] = Math.max( 0, Math.min( 65535, Math.round( geo.uv[ i * 2 + 1 ] * 65535 ) ) );

	}

	return { position, normal, uv, index: unique <= 65535 ? new Uint16Array( index ) : index, vertices: unique };

}

function sampleAverageColor( geo, texU8, tw, th, sink ) {

	// area-weighted average of the base colour over the visible surface (above the sink line, not facing straight down), linear light
	const { position: p, uv, index } = geo;
	let sr = 0, sg = 0, sb = 0, sw = 0;
	const bary = [ [ 1 / 3, 1 / 3 ], [ 0.6, 0.2 ], [ 0.2, 0.6 ], [ 0.2, 0.2 ] ];
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ], b = index[ t + 1 ], c = index[ t + 2 ];
		const ux = p[ b * 3 ] - p[ a * 3 ], uy = p[ b * 3 + 1 ] - p[ a * 3 + 1 ], uz = p[ b * 3 + 2 ] - p[ a * 3 + 2 ];
		const vx = p[ c * 3 ] - p[ a * 3 ], vy = p[ c * 3 + 1 ] - p[ a * 3 + 1 ], vz = p[ c * 3 + 2 ] - p[ a * 3 + 2 ];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const area = 0.5 * Math.hypot( nx, ny, nz );
		if ( area === 0 ) continue;
		const cy = ( p[ a * 3 + 1 ] + p[ b * 3 + 1 ] + p[ c * 3 + 1 ] ) / 3;
		if ( cy < sink ) continue;
		if ( ny / ( 2 * area ) < - 0.5 ) continue;
		for ( const [ w1, w2 ] of bary ) {

			const w0 = 1 - w1 - w2;
			const u = uv[ a * 2 ] * w0 + uv[ b * 2 ] * w1 + uv[ c * 2 ] * w2, v = uv[ a * 2 + 1 ] * w0 + uv[ b * 2 + 1 ] * w1 + uv[ c * 2 + 1 ] * w2;
			const x = Math.min( tw - 1, Math.max( 0, Math.floor( u * tw ) ) ), y = Math.min( th - 1, Math.max( 0, Math.floor( v * th ) ) );
			const o = ( y * tw + x ) * 3;
			sr += SRGB8_TO_LINEAR[ texU8[ o ] ] * area; sg += SRGB8_TO_LINEAR[ texU8[ o + 1 ] ] * area; sb += SRGB8_TO_LINEAR[ texU8[ o + 2 ] ] * area; sw += area;

		}

	}

	return { hex: toHex( linearToSrgb( sr / sw ) * 255, linearToSrgb( sg / sw ) * 255, linearToSrgb( sb / sw ) * 255 ), linear: [ r4( sr / sw ), r4( sg / sw ), r4( sb / sw ) ] };

}

function uvArea( geo ) {

	const { uv, index } = geo;
	let a = 0;
	for ( let t = 0; t < index.length; t += 3 ) {

		const i0 = index[ t ] * 2, i1 = index[ t + 1 ] * 2, i2 = index[ t + 2 ] * 2;
		a += 0.5 * Math.abs( ( uv[ i1 ] - uv[ i0 ] ) * ( uv[ i2 + 1 ] - uv[ i0 + 1 ] ) - ( uv[ i2 ] - uv[ i0 ] ) * ( uv[ i1 + 1 ] - uv[ i0 + 1 ] ) );

	}

	return a;

}

/** Bottom edge of an open shell: lowest border vertex per x-bin (the line that has to disappear in the terrain). */
function baseProfile( geo, size, bins = 12 ) {

	const { position: pos, index } = geo;
	const n = pos.length / 3;
	const map = new Map(), pid = new Int32Array( n );
	for ( let i = 0; i < n; i ++ ) { const k = pos[ i * 3 ] + ',' + pos[ i * 3 + 1 ] + ',' + pos[ i * 3 + 2 ]; let id = map.get( k ); if ( id === undefined ) { id = map.size; map.set( k, id ); } pid[ i ] = id; }
	const edges = new Map();
	for ( let t = 0; t < index.length; t += 3 ) for ( let e = 0; e < 3; e ++ ) {

		const a = pid[ index[ t + e ] ], b = pid[ index[ t + ( e + 1 ) % 3 ] ];
		const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
		const rec = edges.get( k );
		if ( rec ) rec.c ++; else edges.set( k, { c: 1, v: index[ t + e ], w: index[ t + ( e + 1 ) % 3 ] } );

	}

	const low = new Array( bins ).fill( null );
	for ( const rec of edges.values() ) {

		if ( rec.c !== 1 ) continue;
		for ( const v of [ rec.v, rec.w ] ) {

			const y = pos[ v * 3 + 1 ];
			if ( y > size[ 1 ] * 0.6 ) continue; // top edge
			const b = Math.min( bins - 1, Math.max( 0, Math.floor( ( pos[ v * 3 ] + size[ 0 ] / 2 ) / size[ 0 ] * bins ) ) );
			if ( low[ b ] === null || y < low[ b ][ 1 ] ) low[ b ] = [ pos[ v * 3 ], y, pos[ v * 3 + 2 ] ];

		}

	}

	return low.map( ( q, b ) => ( q ? [ r3( ( b + 0.5 ) / bins * size[ 0 ] - size[ 0 ] / 2 ), Math.round( q[ 1 ] * 100 ) / 100, Math.round( q[ 2 ] * 100 ) / 100 ] : null ) ).filter( Boolean );

}

function buildCollider( asset, geo, size ) {

	if ( asset.class === 'small' ) return { collider: { type: 'none' }, info: 'none' };
	const round = ( pts ) => pts.map( ( q ) => q.map( r3 ) );
	if ( asset.class === 'cliff' || asset.class === 'setpiece' ) {

		// concave / sheet-like pieces: slabs along the long horizontal axis (X after orientation), one hull per slab
		const pieces = asset.hullPieces || Math.max( 3, Math.min( 7, Math.round( size[ 0 ] / 2.8 ) ) );
		const n = geo.position.length / 3;
		const minX = - size[ 0 ] / 2, step = size[ 0 ] / pieces, overlap = step * 0.06;
		const hulls = [];
		let worst = 0;
		for ( let k = 0; k < pieces; k ++ ) {

			const lo = minX + k * step - overlap, hi = minX + ( k + 1 ) * step + overlap;
			const ids = [];
			for ( let i = 0; i < n; i ++ ) { const x = geo.position[ i * 3 ]; if ( x >= lo && x <= hi ) ids.push( i ); }
			if ( ids.length < 4 ) continue;
			// the visual mesh is an open shell: give every slab real thickness by sweeping it backwards (-Z, into the hillside)
			const sweep = asset.colliderBackExtrude ?? 1.0;
			const pts = new Float32Array( ids.length * 6 );
			ids.forEach( ( id, q ) => {

				pts[ q * 6 ] = pts[ q * 6 + 3 ] = geo.position[ id * 3 ];
				pts[ q * 6 + 1 ] = pts[ q * 6 + 4 ] = geo.position[ id * 3 + 1 ];
				pts[ q * 6 + 2 ] = geo.position[ id * 3 + 2 ];
				pts[ q * 6 + 5 ] = geo.position[ id * 3 + 2 ] - sweep;

			} );
			const h = approximateHull( pts, asset.hullPoints || 24 );
			// error against the visual surface only (front points)
			if ( h.points.length >= 4 ) { hulls.push( round( h.points ) ); worst = Math.max( worst, h.maxError ); }

		}

		return { collider: { type: 'hulls', hulls }, info: `${hulls.length} hulls (${hulls.map( ( h ) => h.length ).join( '/' )} pts), max error ${( worst * 100 ).toFixed( 1 )} cm` };

	}

	const h = approximateHull( geo.position, 24 );
	return { collider: { type: 'hull', points: round( h.points ) }, info: `hull ${h.points.length} pts, max error ${( h.maxError * 100 ).toFixed( 1 )} cm` };

}

// ------------------------------------------------------------------------------------------------ main

const only = typeof args.only === 'string' ? args.only.split( ',' ) : null;
const indexEntries = [];
for ( const asset of ASSETS ) {

	if ( only && ! only.includes( asset.id ) ) continue;
	const tStart = performance.now();
	log( `\n=== ${asset.id} (${asset.class})` );
	const doc = await io.read( resolve( ROOT, asset.gltf ) );
	const nodes = doc.getRoot().listNodes();
	const scale = asset.scale || 1;
	const budgets = asset.lods || LOD_BUDGETS[ asset.class ];

	// ---- source geometry per variant (world space of the source file, welded)
	const variants = [];
	for ( const v of asset.variants ) {

		const node = nodes.find( ( nd ) => nd.getName() === v.node );
		if ( ! node ) throw new Error( `node ${v.node} not found in ${asset.gltf}` );
		const raw = weldGeometry( extractNodeGeometry( node ) );
		let clamped = 0;
		for ( let i = 0; i < raw.uv.length; i ++ ) { if ( raw.uv[ i ] < 0 ) { raw.uv[ i ] = 0; clamped ++; } else if ( raw.uv[ i ] > 1 ) { raw.uv[ i ] = 1; clamped ++; } }
		variants.push( { cfg: v, raw, clamped } );

	}

	// ---- textures (mask from the original UVs)
	const tex = await buildTextures( asset, variants.map( ( v ) => v.raw ) );
	const baseU8 = new Uint8Array( readFileSync( join( CACHE, tex.files.basecolor.file.replace( /\.(webp|jpg|png)$/, '.raw' ) ) ) );

	// ---- output document
	const out = new Document();
	out.createBuffer();
	const scene = out.createScene( asset.id );
	out.getRoot().setDefaultScene( scene );
	out.getRoot().getAsset().generator = 'alpenglow rocks pipeline (gltf-transform + meshoptimizer)';
	out.getRoot().getAsset().copyright = `CC0 - ${asset.author} - https://polyhaven.com/a/${asset.id}`;
	if ( TEX_FORMAT === 'webp' ) out.createExtension( EXTTextureWebP ).setRequired( true );
	out.createExtension( KHRMeshQuantization ).setRequired( true );
	out.createExtension( EXTMeshoptCompression ).setRequired( true ).setEncoderOptions( { method: EXTMeshoptCompression.EncoderMethod.QUANTIZE } );
	const mkTex = ( name, t ) => out.createTexture( `${asset.id}_${name}` ).setImage( new Uint8Array( t.buffer ) ).setMimeType( t.mime );
	const tBase = mkTex( 'basecolor', tex.textures.basecolor ), tNormal = mkTex( 'normal', tex.textures.normal ), tOrm = mkTex( 'orm', tex.textures.orm );
	const material = out.createMaterial( asset.id )
		.setBaseColorTexture( tBase ).setNormalTexture( tNormal ).setMetallicRoughnessTexture( tOrm ).setOcclusionTexture( tOrm )
		.setMetallicFactor( 0 ).setRoughnessFactor( 1 ).setDoubleSided( !! asset.openMesh );
	const CLAMP = 33071, LINEAR = 9729, LINEAR_MIPMAP_LINEAR = 9987;
	for ( const info of [ material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getMetallicRoughnessTextureInfo(), material.getOcclusionTextureInfo() ] ) {

		info.setWrapS( CLAMP ).setWrapT( CLAMP ).setMagFilter( LINEAR ).setMinFilter( LINEAR_MIPMAP_LINEAR );

	}

	const entry = {
		id: asset.id, file: `${URL_BASE}/${asset.id}${SUFFIX}.glb`, source: `https://polyhaven.com/a/${asset.id}`, author: asset.author, license: 'CC0',
		class: asset.class, textureResolution: asset.textureSize,
		textures: Object.fromEntries( Object.entries( tex.files ).map( ( [ k, f ] ) => [ k, [ f.width, f.height ] ] ) ),
		sourceScale: scale, doubleSided: !! asset.openMesh, bytes: 0, variants: [],
	};

	for ( const variant of variants ) {

		const v = variant.cfg;
		// scale + orientation + pivot
		let geo = transformGeometry( variant.raw, { scale } );
		const srcBounds = boundsOf( geo.position );
		let yaw = ( v.yawDeg || 0 ) * Math.PI / 180;
		let facing = null;
		if ( asset.orient === 'faceZ' ) {

			// rotate about Y so that the area-weighted mean normal of the (open) surface points towards +Z (unless yawDeg is given)
			const m = meanFaceNormal( geo );
			if ( v.yawDeg === undefined ) yaw = - Math.atan2( m[ 0 ], m[ 2 ] );
			facing = m;

		}

		if ( yaw !== 0 ) geo = transformGeometry( geo, { yaw } );
		const b0 = boundsOf( geo.position );
		geo = transformGeometry( geo, { translate: [ - ( b0.min[ 0 ] + b0.max[ 0 ] ) / 2, - b0.min[ 1 ], - ( b0.min[ 2 ] + b0.max[ 2 ] ) / 2 ] } );
		// uv crop scale
		if ( tex.uvScale[ 1 ] !== 1 ) { const uv = new Float32Array( geo.uv ); for ( let i = 1; i < uv.length; i += 2 ) uv[ i ] = Math.min( 1, uv[ i ] * tex.uvScale[ 1 ] ); geo = { ...geo, uv }; }
		const b = boundsOf( geo.position );
		const size = b.size;
		const maxDim = Math.max( ...size );
		const grid = quantizeGrid( maxDim );
		const srcTris = geo.index.length / 3;
		const area = surfaceArea( geo );

		// ---- LODs
		const lods = [];
		let lod0Geo = null;
		for ( let l = 0; l < budgets.length; l ++ ) {

			const budget = ( v.lods && v.lods[ l ] ) || budgets[ l ];
			let lodGeo, err = 0;
			if ( srcTris <= budget && l === 0 ) { lodGeo = geo; } else {

				const target = Math.min( budget, l === 0 ? budget : Math.floor( srcTris * 0.9 ) );
				const res = simplifyGeometry( geo, target, { mode: LOD_MODE, normalWeight: l === 0 ? Math.min( NORMAL_WEIGHT, 0.5 ) : NORMAL_WEIGHT, uvWeight: 0 } );
				lodGeo = res.geo; err = res.errorMeters;

			}

			if ( l > 0 && lodGeo !== geo && LOD_NORMALS !== 'keep' ) {

				// coarse LODs: vertex normals recomputed from the simplified surface shade cleaner than the sparse original normals
				const rec = recomputeNormals( lodGeo );
				lodGeo = { ...lodGeo, normal: LOD_NORMALS === 'recompute' ? rec : blendNormals( lodGeo.normal, rec, l === 1 ? 0.5 : 0.8 ) };

			}

			const dev = lodGeo === geo ? { max: 0, rms: 0, p99: 0 } : meshDeviation( geo, lodGeo, geo.position.length / 3 > 60000 ? 2 : 1 );
			const fin = finalizeGeometry( lodGeo, grid );
			if ( l === 0 ) lod0Geo = lodGeo;
			const name = `${v.name}_LOD${l}`;
			const prim = out.createPrimitive()
				.setAttribute( 'POSITION', out.createAccessor( name + '_position' ).setType( 'VEC3' ).setArray( fin.position ) )
				.setAttribute( 'NORMAL', out.createAccessor( name + '_normal' ).setType( 'VEC3' ).setArray( fin.normal ).setNormalized( true ) )
				.setAttribute( 'TEXCOORD_0', out.createAccessor( name + '_uv' ).setType( 'VEC2' ).setArray( fin.uv ).setNormalized( true ) )
				.setIndices( out.createAccessor( name + '_index' ).setType( 'SCALAR' ).setArray( fin.index ) )
				.setMaterial( material );
			scene.addChild( out.createNode( name ).setMesh( out.createMesh( name + '_geo' ).addPrimitive( prim ) ) );
			lods.push( { node: name, triangles: fin.index.length / 3, vertices: fin.vertices, error: r4( dev.p99 ), maxError: r4( dev.max ) } );
			log( `  ${name}: ${fin.index.length / 3} tris / ${fin.vertices} verts (budget ${budget}), deviation p99 ${( dev.p99 * 1000 ).toFixed( 1 )} mm max ${( dev.max * 1000 ).toFixed( 1 )} mm (meshopt err ${( err * 1000 ).toFixed( 1 )} mm)` );

		}

		// ---- metrics
		let radius = 0;
		for ( let i = 0; i < lod0Geo.position.length; i += 3 ) radius = Math.max( radius, Math.hypot( lod0Geo.position[ i ], lod0Geo.position[ i + 2 ] ) );
		const authoredSink = Math.max( 0, - srcBounds.min[ 1 ] );
		const k = { boulder: 0.06, medium: 0.08, small: 0.12, cliff: 0.03, setpiece: 0.02 }[ asset.class ];
		const sink = v.sink !== undefined ? v.sink : Math.max( authoredSink, k * size[ 1 ] );
		const avg = sampleAverageColor( lod0Geo, baseU8, tex.files.basecolor.width, tex.files.basecolor.height, sink );
		const col = buildCollider( asset, lod0Geo, size );
		const texel = Math.sqrt( uvArea( geo ) * tex.files.basecolor.width * tex.files.basecolor.height / area );
		const ventry = {
			name: v.name, size: size.map( r3 ), radius: r3( radius ), lods,
			avgColor: avg.hex, collider: col.collider, sink: Math.round( sink * 100 ) / 100,
			notes: v.notes || asset.notes || '',
			surfaceArea: Math.round( area * 100 ) / 100, texelsPerMeter: Math.round( texel ), sourceNode: v.node, sourceTriangles: srcTris,
		};
		if ( authoredSink > 0.08 ) ventry.authoredSink = Math.round( authoredSink * 100 ) / 100;
		if ( v.sinkRange ) ventry.sinkRange = v.sinkRange;
		if ( facing ) {

			// open shell: front = +Z, the back (-Z) is the open inside and must be embedded in terrain
			ventry.front = [ 0, 0, 1 ];
			ventry.faceSlopeDeg = Math.round( 90 - Math.atan2( facing[ 1 ], Math.hypot( facing[ 0 ], facing[ 2 ] ) ) * 180 / Math.PI );
			ventry.baseProfile = baseProfile( lod0Geo, size );

		}
		entry.variants.push( ventry );
		log( `  ${v.name}: size ${size.map( ( x ) => x.toFixed( 2 ) ).join( ' x ' )} m, radius ${radius.toFixed( 2 )}, area ${area.toFixed( 1 )} m2, avgColor ${avg.hex}, sink ${sink.toFixed( 2 )} (authored ${authoredSink.toFixed( 2 )}), ${col.info}` + ( variant.clamped ? `, ${variant.clamped} uv components clamped` : '' ) + ( facing ? `, yaw ${( yaw * 180 / Math.PI ).toFixed( 1 )} deg, face slope ${ventry.faceSlopeDeg} deg` : '' ) + `, ${Math.round( texel )} px/m` );

	}

	const file = join( OUT, `${asset.id}${SUFFIX}.glb` );
	await io.write( file, out );
	entry.bytes = statSync( file ).size;
	entry.gpuTextureBytes = Math.round( Object.values( tex.files ).reduce( ( s, f ) => s + f.width * f.height * 4 * 4 / 3, 0 ) );
	entry.grade = tex.gradeInfo ? { lightnessGain: r3( tex.gradeInfo.gainL ), chromaGain: r3( tex.gradeInfo.chromaGain ), hueShiftDeg: Math.round( tex.gradeInfo.hueShiftDeg ) } : null;
	indexEntries.push( entry );

	// ---- validate by reading the file back
	const back = await io.read( file );
	const backNodes = back.getRoot().listScenes()[ 0 ].listChildren();
	let ok = true;
	for ( const nd of backNodes ) {

		const t = nd.getTranslation(), r = nd.getRotation(), s = nd.getScale();
		if ( t.some( ( x ) => x !== 0 ) || r[ 3 ] !== 1 || s.some( ( x ) => x !== 1 ) ) { ok = false; log( '  !! non-identity transform on', nd.getName() ); }
		if ( nd.getMesh().listPrimitives().length !== 1 ) { ok = false; log( '  !! primitive count on', nd.getName() ); }

	}

	log( `  wrote ${file} ${( entry.bytes / 1024 ).toFixed( 0 )} kB, ${backNodes.length} nodes, materials ${back.getRoot().listMaterials().length}, textures ${back.getRoot().listTextures().length}, extensions ${back.getRoot().listExtensionsUsed().map( ( e ) => e.extensionName ).join( '+' )}, valid ${ok} (${( ( performance.now() - tStart ) / 1000 ).toFixed( 1 )} s)` );

}

// ---- index.json (merge with existing entries so partial builds keep the others)
if ( ! args[ 'no-index' ] && ! SUFFIX ) {

	const indexFile = join( OUT, 'index.json' );
	let existing = { category: 'rocks', assets: [] };
	if ( existsSync( indexFile ) ) existing = JSON.parse( readFileSync( indexFile, 'utf8' ) );
	const byId = new Map( existing.assets.map( ( a ) => [ a.id, a ] ) );
	for ( const e of indexEntries ) byId.set( e.id, e );
	const ordered = ASSETS.map( ( a ) => byId.get( a.id ) ).filter( Boolean );
	const index = {
		category: 'rocks',
		conventions: 'meters, Y up; nodes "<variant>_LOD<n>" at scene root with identity transforms; pivot = bottom centre of the variant bbox; lods[].error = 99th percentile geometric deviation from the source mesh in meters; sink = recommended burial depth in meters; avgColor = area-weighted mean base colour (averaged in linear light, written as sRGB hex)',
		gradeTarget: GRADE_TARGET,
		assets: ordered,
	};
	writeFileSync( indexFile, JSON.stringify( index, null, '\t' ) + '\n' );
	log( `\nindex.json: ${ordered.length} assets, ${ordered.reduce( ( s, a ) => s + a.variants.length, 0 )} variants, ${( ordered.reduce( ( s, a ) => s + a.bytes, 0 ) / 1e6 ).toFixed( 1 )} MB` );

}
