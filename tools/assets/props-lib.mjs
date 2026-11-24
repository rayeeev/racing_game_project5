// Shared helpers for the props asset pipeline (geometry on plain typed arrays, texture processing with sharp).
// Mesh representation used everywhere:  { material: string, pos: Float32Array(n*3), nrm: Float32Array(n*3), uv: Float32Array(n*2), idx: Uint32Array }
import sharp from 'sharp';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

// ------------------------------------------------------------------------------------------------ math (column-major mat4)

export const mat4 = {

	identity: () => [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ],

	multiply( a, b ) {

		const o = new Array( 16 );
		for ( let c = 0; c < 4; c ++ ) for ( let r = 0; r < 4; r ++ ) {

			let s = 0;
			for ( let k = 0; k < 4; k ++ ) s += a[ k * 4 + r ] * b[ c * 4 + k ];
			o[ c * 4 + r ] = s;

		}

		return o;

	},

	translation: ( x, y, z ) => [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 ],
	scale: ( x, y, z ) => [ x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 ],

	rotationX( deg ) {

		const a = deg * Math.PI / 180, c = Math.cos( a ), s = Math.sin( a );
		return [ 1, 0, 0, 0, 0, c, s, 0, 0, - s, c, 0, 0, 0, 0, 1 ];

	},

	rotationY( deg ) {

		const a = deg * Math.PI / 180, c = Math.cos( a ), s = Math.sin( a );
		return [ c, 0, - s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1 ];

	},

	rotationZ( deg ) {

		const a = deg * Math.PI / 180, c = Math.cos( a ), s = Math.sin( a );
		return [ c, s, 0, 0, - s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

	},

	/** chain: mat4.chain(A, B, C) = A * B * C  (C is applied to the vertex first) */
	chain( ...ms ) {

		return ms.reduce( ( a, b ) => mat4.multiply( a, b ) );

	},

};

function det3( m ) {

	return m[ 0 ] * ( m[ 5 ] * m[ 10 ] - m[ 9 ] * m[ 6 ] ) - m[ 4 ] * ( m[ 1 ] * m[ 10 ] - m[ 9 ] * m[ 2 ] ) + m[ 8 ] * ( m[ 1 ] * m[ 6 ] - m[ 5 ] * m[ 2 ] );

}

/** inverse-transpose of the upper 3x3 (row-major 9 array usable as n' = N * n) */
function normalMatrix( m ) {

	const a = m[ 0 ], b = m[ 4 ], c = m[ 8 ], d = m[ 1 ], e = m[ 5 ], f = m[ 9 ], g = m[ 2 ], h = m[ 6 ], i = m[ 10 ];
	const det = det3( m );
	// cofactor matrix (= det * inverse-transpose)
	return [
		( e * i - f * h ) / det, ( f * g - d * i ) / det, ( d * h - e * g ) / det,
		( c * h - b * i ) / det, ( a * i - c * g ) / det, ( b * g - a * h ) / det,
		( b * f - c * e ) / det, ( c * d - a * f ) / det, ( a * e - b * d ) / det,
	];

}

// ------------------------------------------------------------------------------------------------ mesh ops

/** Returns a transformed copy of the mesh (positions by m, normals by inverse-transpose; winding flipped for mirroring). */
export function transformMesh( mesh, m ) {

	const n = mesh.pos.length / 3;
	const pos = new Float32Array( n * 3 ), nrm = new Float32Array( n * 3 );
	const N = normalMatrix( m );
	for ( let i = 0; i < n; i ++ ) {

		const x = mesh.pos[ i * 3 ], y = mesh.pos[ i * 3 + 1 ], z = mesh.pos[ i * 3 + 2 ];
		pos[ i * 3 ] = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
		pos[ i * 3 + 1 ] = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
		pos[ i * 3 + 2 ] = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];
		const nx = mesh.nrm[ i * 3 ], ny = mesh.nrm[ i * 3 + 1 ], nz = mesh.nrm[ i * 3 + 2 ];
		let ox = N[ 0 ] * nx + N[ 1 ] * ny + N[ 2 ] * nz, oy = N[ 3 ] * nx + N[ 4 ] * ny + N[ 5 ] * nz, oz = N[ 6 ] * nx + N[ 7 ] * ny + N[ 8 ] * nz;
		const l = Math.hypot( ox, oy, oz ) || 1;
		nrm[ i * 3 ] = ox / l; nrm[ i * 3 + 1 ] = oy / l; nrm[ i * 3 + 2 ] = oz / l;

	}

	const idx = new Uint32Array( mesh.idx );
	if ( det3( m ) < 0 ) for ( let i = 0; i < idx.length; i += 3 ) { const t = idx[ i + 1 ]; idx[ i + 1 ] = idx[ i + 2 ]; idx[ i + 2 ] = t; }
	return { material: mesh.material, pos, nrm, uv: new Float32Array( mesh.uv ), idx };

}

/** Concatenates meshes that share a material -> Map(material -> mesh) preserving first-seen material order. */
export function mergeByMaterial( meshes ) {

	const groups = new Map();
	for ( const m of meshes ) {

		if ( ! groups.has( m.material ) ) groups.set( m.material, [] );
		groups.get( m.material ).push( m );

	}

	const out = [];
	for ( const [ material, list ] of groups ) {

		let nv = 0, ni = 0;
		for ( const m of list ) { nv += m.pos.length / 3; ni += m.idx.length; }
		const pos = new Float32Array( nv * 3 ), nrm = new Float32Array( nv * 3 ), uv = new Float32Array( nv * 2 ), idx = new Uint32Array( ni );
		let vo = 0, io = 0;
		for ( const m of list ) {

			pos.set( m.pos, vo * 3 ); nrm.set( m.nrm, vo * 3 ); uv.set( m.uv, vo * 2 );
			for ( let i = 0; i < m.idx.length; i ++ ) idx[ io + i ] = m.idx[ i ] + vo;
			vo += m.pos.length / 3; io += m.idx.length;

		}

		out.push( { material, pos, nrm, uv, idx } );

	}

	return out;

}

export function bounds( meshes ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( const m of meshes ) for ( let i = 0; i < m.idx.length; i ++ ) {

		const v = m.idx[ i ] * 3;
		for ( let k = 0; k < 3; k ++ ) { const p = m.pos[ v + k ]; if ( p < min[ k ] ) min[ k ] = p; if ( p > max[ k ] ) max[ k ] = p; }

	}

	return { min, max, size: max.map( ( v, k ) => v - min[ k ] ), center: max.map( ( v, k ) => ( v + min[ k ] ) / 2 ) };

}

export const triCount = ( meshes ) => meshes.reduce( ( s, m ) => s + m.idx.length / 3, 0 );

/** Exact weld: merges vertices with bit-identical position+normal+uv, drops unused vertices and degenerate triangles. */
export function weld( mesh ) {

	const n = mesh.pos.length / 3;
	const buf = new Float32Array( 8 ), key32 = new Uint32Array( buf.buffer );
	const map = new Map();
	const remap = new Uint32Array( n ).fill( 0xffffffff );
	const keep = [];
	const used = new Uint8Array( n );
	for ( let i = 0; i < mesh.idx.length; i ++ ) used[ mesh.idx[ i ] ] = 1;
	for ( let i = 0; i < n; i ++ ) {

		if ( ! used[ i ] ) continue;
		buf[ 0 ] = mesh.pos[ i * 3 ]; buf[ 1 ] = mesh.pos[ i * 3 + 1 ]; buf[ 2 ] = mesh.pos[ i * 3 + 2 ];
		buf[ 3 ] = mesh.nrm[ i * 3 ]; buf[ 4 ] = mesh.nrm[ i * 3 + 1 ]; buf[ 5 ] = mesh.nrm[ i * 3 + 2 ];
		buf[ 6 ] = mesh.uv[ i * 2 ]; buf[ 7 ] = mesh.uv[ i * 2 + 1 ];
		for ( let k = 0; k < 8; k ++ ) if ( buf[ k ] === 0 ) buf[ k ] = 0; // -0 -> +0
		const key = String.fromCharCode( ...new Uint16Array( key32.buffer ) );
		let j = map.get( key );
		if ( j === undefined ) { j = keep.length; map.set( key, j ); keep.push( i ); }
		remap[ i ] = j;

	}

	const pos = new Float32Array( keep.length * 3 ), nrm = new Float32Array( keep.length * 3 ), uv = new Float32Array( keep.length * 2 );
	keep.forEach( ( src, j ) => {

		pos.set( mesh.pos.subarray( src * 3, src * 3 + 3 ), j * 3 );
		nrm.set( mesh.nrm.subarray( src * 3, src * 3 + 3 ), j * 3 );
		uv.set( mesh.uv.subarray( src * 2, src * 2 + 2 ), j * 2 );

	} );
	const idx = [];
	for ( let i = 0; i < mesh.idx.length; i += 3 ) {

		const a = remap[ mesh.idx[ i ] ], b = remap[ mesh.idx[ i + 1 ] ], c = remap[ mesh.idx[ i + 2 ] ];
		if ( a === b || b === c || a === c ) continue;
		idx.push( a, b, c );

	}

	return { material: mesh.material, pos, nrm, uv, idx: new Uint32Array( idx ) };

}

/** Removes unreferenced vertices and reorders vertices/indices for vertex-cache + compression efficiency. */
export function compact( mesh ) {

	const idx = new Uint32Array( mesh.idx );
	const [ remap, unique ] = MeshoptEncoder.reorderMesh( idx, true, false );
	const pos = new Float32Array( unique * 3 ), nrm = new Float32Array( unique * 3 ), uv = new Float32Array( unique * 2 );
	for ( let i = 0; i < remap.length; i ++ ) {

		const j = remap[ i ];
		if ( j === 0xffffffff ) continue;
		pos.set( mesh.pos.subarray( i * 3, i * 3 + 3 ), j * 3 );
		nrm.set( mesh.nrm.subarray( i * 3, i * 3 + 3 ), j * 3 );
		uv.set( mesh.uv.subarray( i * 2, i * 2 + 2 ), j * 2 );

	}

	return { material: mesh.material, pos, nrm, uv, idx };

}

/**
 * Attribute-aware simplification (meshoptimizer simplifyWithAttributes: normals + uvs).
 * target = triangle count; error = max relative error (fraction of the mesh extent) or errorAbs = max error in metres.
 * Flags: permissive = allow collapses across UV/normal seams (needed to reach low counts on hard-surface props),
 * prune = drop small disconnected parts whose size is below the error limit.
 * Returns { mesh, error (absolute, meters), tris }.
 */
export function simplify( mesh, target, { error = 0.02, errorAbs = null, prune = false, lockBorder = false, permissive = false, normalWeight = 0.5, uvWeight = 0.5, regularize = false } = {} ) {

	const srcTris = mesh.idx.length / 3;
	if ( target >= srcTris ) return { mesh, error: 0, tris: srcTris };
	const n = mesh.pos.length / 3;
	const scale = MeshoptSimplifier.getScale( mesh.pos, 3 );
	const limit = errorAbs !== null ? errorAbs / scale : error; // errorAbs is in metres
	const flags = [];
	if ( prune ) flags.push( 'Prune' );
	if ( lockBorder ) flags.push( 'LockBorder' );
	if ( permissive ) flags.push( 'Permissive' );
	if ( regularize ) flags.push( 'Regularize' );
	const targetIndices = Math.max( 3, Math.floor( target ) * 3 );
	let idx, relError;
	if ( normalWeight === 0 && uvWeight === 0 ) {

		[ idx, relError ] = MeshoptSimplifier.simplify( mesh.idx, mesh.pos, 3, targetIndices, limit, flags );

	} else {

		const attrs = new Float32Array( n * 5 );
		for ( let i = 0; i < n; i ++ ) {

			attrs[ i * 5 ] = mesh.nrm[ i * 3 ]; attrs[ i * 5 + 1 ] = mesh.nrm[ i * 3 + 1 ]; attrs[ i * 5 + 2 ] = mesh.nrm[ i * 3 + 2 ];
			attrs[ i * 5 + 3 ] = mesh.uv[ i * 2 ]; attrs[ i * 5 + 4 ] = mesh.uv[ i * 2 + 1 ];

		}

		const weights = [ normalWeight, normalWeight, normalWeight, uvWeight, uvWeight ];
		[ idx, relError ] = MeshoptSimplifier.simplifyWithAttributes( mesh.idx, mesh.pos, 3, attrs, 5, weights, null, targetIndices, limit, flags );

	}

	if ( idx.length === 0 ) return { mesh: { material: mesh.material, pos: new Float32Array( 0 ), nrm: new Float32Array( 0 ), uv: new Float32Array( 0 ), idx: new Uint32Array( 0 ) }, error: relError * scale, tris: 0 };
	const out = compact( { material: mesh.material, pos: mesh.pos, nrm: mesh.nrm, uv: mesh.uv, idx } );
	return { mesh: out, error: relError * scale, tris: idx.length / 3 };

}

/** Counts boundary edges (edges used by exactly one triangle after welding by POSITION only) -> detects open shells. */
export function openEdgeStats( mesh ) {

	const remap = MeshoptSimplifier.generatePositionRemap( mesh.pos, 3 );
	const edges = new Map();
	for ( let i = 0; i < mesh.idx.length; i += 3 ) {

		for ( let k = 0; k < 3; k ++ ) {

			const a = remap[ mesh.idx[ i + k ] ], b = remap[ mesh.idx[ i + ( k + 1 ) % 3 ] ];
			const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
			edges.set( key, ( edges.get( key ) || 0 ) + 1 );

		}

	}

	let open = 0, nonManifold = 0;
	for ( const c of edges.values() ) { if ( c === 1 ) open ++; else if ( c > 2 ) nonManifold ++; }
	return { edges: edges.size, open, nonManifold, openRatio: open / Math.max( 1, edges.size ) };

}

/** Triangle-area weighted surface area of a mesh list (m^2). */
export function surfaceArea( mesh ) {

	let area = 0;
	const p = mesh.pos;
	for ( let i = 0; i < mesh.idx.length; i += 3 ) {

		const a = mesh.idx[ i ] * 3, b = mesh.idx[ i + 1 ] * 3, c = mesh.idx[ i + 2 ] * 3;
		const ux = p[ b ] - p[ a ], uy = p[ b + 1 ] - p[ a + 1 ], uz = p[ b + 2 ] - p[ a + 2 ];
		const vx = p[ c ] - p[ a ], vy = p[ c + 1 ] - p[ a + 1 ], vz = p[ c + 2 ] - p[ a + 2 ];
		area += 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );

	}

	return area;

}

// ------------------------------------------------------------------------------------------------ colour

export const srgbToLinear = ( c ) => ( c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ) );
export const linearToSrgb = ( c ) => ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );

/**
 * Area-weighted average albedo of a mesh, sampled from its base-colour image (raw RGBA, sRGB) -> linear rgb sum + weight.
 * Texels with alpha below `cutoff` are skipped (alpha-masked materials).
 */
export function sampleAlbedo( mesh, image, { samplesPerM2 = 4000, factor = [ 1, 1, 1 ], cutoff = 0 } = {} ) {

	const { data, width, height, channels } = image;
	const p = mesh.pos, uv = mesh.uv;
	let seed = 12345;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	const sum = [ 0, 0, 0 ];
	let weight = 0;
	for ( let i = 0; i < mesh.idx.length; i += 3 ) {

		const ia = mesh.idx[ i ], ib = mesh.idx[ i + 1 ], ic = mesh.idx[ i + 2 ];
		const a = ia * 3, b = ib * 3, c = ic * 3;
		const ux = p[ b ] - p[ a ], uy = p[ b + 1 ] - p[ a + 1 ], uz = p[ b + 2 ] - p[ a + 2 ];
		const vx = p[ c ] - p[ a ], vy = p[ c + 1 ] - p[ a + 1 ], vz = p[ c + 2 ] - p[ a + 2 ];
		const area = 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );
		const exact = area * samplesPerM2;
		let count = Math.floor( exact );
		if ( rnd() < exact - count ) count ++;
		for ( let s = 0; s < count; s ++ ) {

			let r1 = rnd(), r2 = rnd();
			if ( r1 + r2 > 1 ) { r1 = 1 - r1; r2 = 1 - r2; }
			const w0 = 1 - r1 - r2;
			let u = uv[ ia * 2 ] * w0 + uv[ ib * 2 ] * r1 + uv[ ic * 2 ] * r2;
			let v = uv[ ia * 2 + 1 ] * w0 + uv[ ib * 2 + 1 ] * r1 + uv[ ic * 2 + 1 ] * r2;
			u -= Math.floor( u ); v -= Math.floor( v );
			const px = Math.min( width - 1, Math.floor( u * width ) ), py = Math.min( height - 1, Math.floor( v * height ) );
			const o = ( py * width + px ) * channels;
			if ( channels === 4 && data[ o + 3 ] / 255 < cutoff ) continue;
			sum[ 0 ] += srgbToLinear( data[ o ] / 255 ) * factor[ 0 ];
			sum[ 1 ] += srgbToLinear( data[ o + 1 ] / 255 ) * factor[ 1 ];
			sum[ 2 ] += srgbToLinear( data[ o + 2 ] / 255 ) * factor[ 2 ];
			weight ++;

		}

	}

	return { sum, weight };

}

export function toHex( linearRgb ) {

	return '#' + linearRgb.map( ( c ) => Math.round( Math.min( 1, Math.max( 0, linearToSrgb( c ) ) ) * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

}

// ------------------------------------------------------------------------------------------------ textures

/** Resizes to size x size (Lanczos3), returns raw RGB(A) pixels. */
export async function loadResized( input, size, { alpha = false } = {} ) {

	let img = sharp( input ).resize( size, size, { kernel: 'lanczos3', fit: 'fill' } );
	img = alpha ? img.ensureAlpha() : img.removeAlpha();
	const { data, info } = await img.toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height, channels: info.channels };

}

/** Loads a single-channel map (opacity etc.) resized, returns Uint8 buffer (0..255). */
export async function loadGrey( input, size ) {

	const { data } = await sharp( input ).resize( size, size, { kernel: 'lanczos3', fit: 'fill' } ).toColourspace( 'b-w' ).extractChannel( 0 ).raw().toBuffer( { resolveWithObject: true } );
	return data;

}

/**
 * Builds an RGBA base-colour image from RGB + coverage, bleeding colour from opaque texels into transparent ones
 * (avoids dark fringes under bilinear/mip filtering of alpha-tested textures).
 */
export async function composeAlpha( rgb, alpha, width, height ) {

	const n = width * height;
	const out = Buffer.alloc( n * 4 );
	// premultiplied colour, blurred at two radii; divide by the blurred alpha to recover the dilated colour
	const pre = Buffer.alloc( n * 3 );
	for ( let i = 0; i < n; i ++ ) {

		const a = alpha[ i ] / 255;
		pre[ i * 3 ] = rgb[ i * 3 ] * a; pre[ i * 3 + 1 ] = rgb[ i * 3 + 1 ] * a; pre[ i * 3 + 2 ] = rgb[ i * 3 + 2 ] * a;

	}

	const blur = async ( buf, ch, sigma ) => ( await sharp( buf, { raw: { width, height, channels: ch } } ).blur( sigma ).raw().toBuffer() );
	const levels = [];
	for ( const sigma of [ 2, 8, 32 ] ) levels.push( { c: await blur( pre, 3, sigma ), a: await blur( Buffer.from( alpha ), 1, sigma ) } );
	// global average as the last resort
	let gs = [ 0, 0, 0 ], gw = 0;
	for ( let i = 0; i < n; i ++ ) { gw += alpha[ i ]; for ( let k = 0; k < 3; k ++ ) gs[ k ] += pre[ i * 3 + k ]; }
	const g = gs.map( ( v ) => ( gw > 0 ? v / ( gw / 255 ) : 128 ) );
	for ( let i = 0; i < n; i ++ ) {

		const a = alpha[ i ];
		let r = rgb[ i * 3 ], gg = rgb[ i * 3 + 1 ], b = rgb[ i * 3 + 2 ];
		if ( a < 250 ) {

			let filled = false;
			for ( const lv of levels ) {

				const la = lv.a[ i ];
				if ( la >= 6 ) {

					const k = 255 / la;
					const br = Math.min( 255, lv.c[ i * 3 ] * k ), bg = Math.min( 255, lv.c[ i * 3 + 1 ] * k ), bb = Math.min( 255, lv.c[ i * 3 + 2 ] * k );
					const t = a / 255; // keep the original colour where the texel is mostly opaque
					r = r * t + br * ( 1 - t ); gg = gg * t + bg * ( 1 - t ); b = b * t + bb * ( 1 - t );
					filled = true;
					break;

				}

			}

			if ( ! filled ) { r = g[ 0 ]; gg = g[ 1 ]; b = g[ 2 ]; }

		}

		out[ i * 4 ] = r; out[ i * 4 + 1 ] = gg; out[ i * 4 + 2 ] = b; out[ i * 4 + 3 ] = a;

	}

	return out;

}

export const encodeWebp = ( raw, width, height, channels, quality = 90 ) =>
	sharp( raw, { raw: { width, height, channels } } ).webp( { quality, alphaQuality: 100, effort: 6, smartSubsample: true } ).toBuffer();

/** Normal maps: JPEG 4:4:4 keeps the X/Y channels at full resolution (WebP's 4:2:0 chroma gives large angular errors at edges). */
export const encodeJpeg444 = ( raw, width, height, quality = 90 ) =>
	sharp( raw, { raw: { width, height, channels: 3 } } ).jpeg( { quality, chromaSubsampling: '4:4:4', mozjpeg: true } ).toBuffer();

// ------------------------------------------------------------------------------------------------ UV-space helpers

/**
 * Rasterises the UV triangles of a mesh into a size x size coverage mask (1 = texel used by the mesh).
 * glTF convention: v = 0 is the top image row. UVs outside 0..1 wrap (repeat).
 */
export function rasterizeUvMask( mesh, size, mask = new Uint8Array( size * size ) ) {

	const uv = mesh.uv;
	const set = ( x, y ) => { mask[ ( ( ( y % size ) + size ) % size ) * size + ( ( ( x % size ) + size ) % size ) ] = 1; };
	for ( let i = 0; i < mesh.idx.length; i += 3 ) {

		const a = mesh.idx[ i ] * 2, b = mesh.idx[ i + 1 ] * 2, c = mesh.idx[ i + 2 ] * 2;
		const x0 = uv[ a ] * size, y0 = uv[ a + 1 ] * size, x1 = uv[ b ] * size, y1 = uv[ b + 1 ] * size, x2 = uv[ c ] * size, y2 = uv[ c + 1 ] * size;
		const minX = Math.floor( Math.min( x0, x1, x2 ) ), maxX = Math.ceil( Math.max( x0, x1, x2 ) );
		const minY = Math.floor( Math.min( y0, y1, y2 ) ), maxY = Math.ceil( Math.max( y0, y1, y2 ) );
		if ( maxX - minX > size * 4 || maxY - minY > size * 4 ) continue; // absurd UVs
		const area = ( x1 - x0 ) * ( y2 - y0 ) - ( x2 - x0 ) * ( y1 - y0 );
		if ( Math.abs( area ) > 1e-9 ) {

			const inv = 1 / area;
			for ( let y = minY; y <= maxY; y ++ ) {

				for ( let x = minX; x <= maxX; x ++ ) {

					const px = x + 0.5, py = y + 0.5;
					const w0 = ( ( x1 - px ) * ( y2 - py ) - ( x2 - px ) * ( y1 - py ) ) * inv;
					const w1 = ( ( x2 - px ) * ( y0 - py ) - ( x0 - px ) * ( y2 - py ) ) * inv;
					const w2 = 1 - w0 - w1;
					if ( w0 >= - 0.01 && w1 >= - 0.01 && w2 >= - 0.01 ) set( x, y );

				}

			}

		}

		// edges + vertices (thin triangles may not contain any texel centre)
		const edge = ( ax, ay, bx, by ) => {

			const steps = Math.max( 1, Math.ceil( Math.hypot( bx - ax, by - ay ) * 2 ) );
			for ( let s = 0; s <= steps; s ++ ) set( Math.floor( ax + ( bx - ax ) * s / steps ), Math.floor( ay + ( by - ay ) * s / steps ) );

		};

		edge( x0, y0, x1, y1 ); edge( x1, y1, x2, y2 ); edge( x2, y2, x0, y0 );

	}

	return mask;

}

/** Grows a binary mask by `px` texels (wrapping). */
export function dilateMask( mask, size, px ) {

	let cur = mask;
	for ( let p = 0; p < px; p ++ ) {

		const next = new Uint8Array( cur );
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			if ( cur[ y * size + x ] ) continue;
			const xm = ( x + size - 1 ) % size, xp = ( x + 1 ) % size, ym = ( y + size - 1 ) % size, yp = ( y + 1 ) % size;
			if ( cur[ y * size + xm ] || cur[ y * size + xp ] || cur[ ym * size + x ] || cur[ yp * size + x ] ) next[ y * size + x ] = 1;

		}

		cur = next;

	}

	return cur;

}

/**
 * Push-pull fill: texels outside the mask get the colour of the nearest covered texels (smoothly, via an image pyramid).
 * Prevents the atlas background from bleeding into UV-island borders in the mip chain (dark seams at distance).
 * data: Uint8 buffer (size*size*channels), modified in place. size must be a power of two.
 */
export function fillUncovered( data, mask, size, channels ) {

	const levels = [];
	let w = size;
	let col = new Float32Array( w * w * channels ), wt = new Float32Array( w * w );
	for ( let i = 0; i < w * w; i ++ ) if ( mask[ i ] ) { wt[ i ] = 1; for ( let c = 0; c < channels; c ++ ) col[ i * channels + c ] = data[ i * channels + c ]; }
	levels.push( { w, col, wt } );
	while ( w > 1 ) {

		const hw = w >> 1;
		const hc = new Float32Array( hw * hw * channels ), hwt = new Float32Array( hw * hw );
		for ( let y = 0; y < hw; y ++ ) for ( let x = 0; x < hw; x ++ ) {

			let sw = 0;
			const o = y * hw + x;
			for ( let dy = 0; dy < 2; dy ++ ) for ( let dx = 0; dx < 2; dx ++ ) {

				const s = ( y * 2 + dy ) * w + x * 2 + dx;
				const k = wt[ s ];
				if ( k > 0 ) { sw += k; for ( let c = 0; c < channels; c ++ ) hc[ o * channels + c ] += col[ s * channels + c ] * k; }

			}

			if ( sw > 0 ) { for ( let c = 0; c < channels; c ++ ) hc[ o * channels + c ] /= sw; hwt[ o ] = 1; }

		}

		levels.push( { w: hw, col: hc, wt: hwt } );
		w = hw; col = hc; wt = hwt;

	}

	for ( let l = levels.length - 2; l >= 0; l -- ) {

		const lo = levels[ l ], hi = levels[ l + 1 ];
		for ( let y = 0; y < lo.w; y ++ ) for ( let x = 0; x < lo.w; x ++ ) {

			const o = y * lo.w + x;
			if ( lo.wt[ o ] > 0 ) continue;
			// bilinear sample of the coarser level
			const fx = Math.min( hi.w - 1, Math.max( 0, ( x + 0.5 ) / 2 - 0.5 ) ), fy = Math.min( hi.w - 1, Math.max( 0, ( y + 0.5 ) / 2 - 0.5 ) );
			const x0 = Math.floor( fx ), y0 = Math.floor( fy ), x1 = Math.min( hi.w - 1, x0 + 1 ), y1 = Math.min( hi.w - 1, y0 + 1 );
			const tx = fx - x0, ty = fy - y0;
			for ( let c = 0; c < channels; c ++ ) {

				const a = hi.col[ ( y0 * hi.w + x0 ) * channels + c ], b = hi.col[ ( y0 * hi.w + x1 ) * channels + c ];
				const d = hi.col[ ( y1 * hi.w + x0 ) * channels + c ], e = hi.col[ ( y1 * hi.w + x1 ) * channels + c ];
				lo.col[ o * channels + c ] = ( a * ( 1 - tx ) + b * tx ) * ( 1 - ty ) + ( d * ( 1 - tx ) + e * tx ) * ty;

			}

			lo.wt[ o ] = 1;

		}

	}

	const out = levels[ 0 ].col;
	for ( let i = 0; i < size * size; i ++ ) if ( ! mask[ i ] ) for ( let c = 0; c < channels; c ++ ) data[ i * channels + c ] = Math.round( out[ i * channels + c ] );
	return data;

}

/** Decodes an image to raw RGB at its native resolution. */
export async function loadNative( input ) {

	const { data, info } = await sharp( input ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height, channels: info.channels };

}

/** Lanczos resize of a raw RGB(A) buffer. */
export async function resizeRaw( raw, size ) {

	if ( raw.width === size && raw.height === size ) return raw;
	const { data, info } = await sharp( raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } } ).resize( size, size, { kernel: 'lanczos3', fit: 'fill' } ).raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height, channels: info.channels };

}
