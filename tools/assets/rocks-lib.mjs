// Shared helpers for the rocks asset pipeline (geometry extraction, UV masks, colour math, convex hulls).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

export async function makeIO() {

	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	await MeshoptSimplifier.ready;
	return new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );

}

// ---------------------------------------------------------------- colour

export const srgbToLinear = ( c ) => ( c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ) );
export const linearToSrgb = ( c ) => ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );

const S2L = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) S2L[ i ] = srgbToLinear( i / 255 );
export const SRGB8_TO_LINEAR = S2L;

export function linearToOklab( r, g, b, out, o = 0 ) {

	const l = Math.cbrt( 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b );
	const m = Math.cbrt( 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b );
	const s = Math.cbrt( 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b );
	out[ o ] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
	out[ o + 1 ] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
	out[ o + 2 ] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
	return out;

}

export function oklabToLinear( L, a, b, out, o = 0 ) {

	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
	const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
	out[ o ] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	out[ o + 1 ] = - 1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	out[ o + 2 ] = - 0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
	return out;

}

export const toHex = ( r, g, b ) => '#' + [ r, g, b ].map( ( v ) => Math.max( 0, Math.min( 255, Math.round( v ) ) ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

// ---------------------------------------------------------------- geometry

/** Extract a node's first-primitive geometry in world space (node TRS applied, incl. non-uniform scale), as plain typed arrays. */
export function extractNodeGeometry( node ) {

	const mesh = node.getMesh();
	const prims = mesh.listPrimitives();
	if ( prims.length !== 1 ) throw new Error( `node ${node.getName()} has ${prims.length} primitives (expected 1)` );
	const prim = prims[ 0 ];
	const m = node.getWorldMatrix();
	const srcPos = prim.getAttribute( 'POSITION' ).getArray();
	const srcNrm = prim.getAttribute( 'NORMAL' ).getArray();
	const srcUv = prim.getAttribute( 'TEXCOORD_0' ).getArray();
	const n = srcPos.length / 3;
	const position = new Float32Array( n * 3 ), normal = new Float32Array( n * 3 ), uv = new Float32Array( n * 2 );
	// normal matrix = inverse transpose of the upper 3x3; for (possibly non-uniform) scale + rotation compute via cofactors
	const a = m[ 0 ], b = m[ 1 ], c = m[ 2 ], d = m[ 4 ], e = m[ 5 ], f = m[ 6 ], g = m[ 8 ], h = m[ 9 ], i = m[ 10 ];
	const n00 = e * i - f * h, n01 = f * g - d * i, n02 = d * h - e * g;
	const n10 = c * h - b * i, n11 = a * i - c * g, n12 = b * g - a * h;
	const n20 = b * f - c * e, n21 = c * d - a * f, n22 = a * e - b * d;
	for ( let k = 0; k < n; k ++ ) {

		const x = srcPos[ k * 3 ], y = srcPos[ k * 3 + 1 ], z = srcPos[ k * 3 + 2 ];
		position[ k * 3 ] = a * x + d * y + g * z + m[ 12 ];
		position[ k * 3 + 1 ] = b * x + e * y + h * z + m[ 13 ];
		position[ k * 3 + 2 ] = c * x + f * y + i * z + m[ 14 ];
		const nx = srcNrm[ k * 3 ], ny = srcNrm[ k * 3 + 1 ], nz = srcNrm[ k * 3 + 2 ];
		let wx = n00 * nx + n01 * ny + n02 * nz, wy = n10 * nx + n11 * ny + n12 * nz, wz = n20 * nx + n21 * ny + n22 * nz;
		const len = Math.hypot( wx, wy, wz ) || 1;
		normal[ k * 3 ] = wx / len; normal[ k * 3 + 1 ] = wy / len; normal[ k * 3 + 2 ] = wz / len;
		uv[ k * 2 ] = srcUv[ k * 2 ]; uv[ k * 2 + 1 ] = srcUv[ k * 2 + 1 ];

	}

	const idxAcc = prim.getIndices();
	const index = idxAcc ? Uint32Array.from( idxAcc.getArray() ) : Uint32Array.from( { length: n }, ( _, k ) => k );
	return { position, normal, uv, index };

}

/**
 * Weld vertices that share position + uv (normals are averaged, area-weighted by the incident faces through the source normals).
 * Removes degenerate triangles. Keeps UV seams (different uv at the same position stay separate vertices).
 */
export function weldGeometry( geo ) {

	const { position, normal, uv, index } = geo;
	const n = position.length / 3;
	const map = new Map();
	const remap = new Uint32Array( n );
	const pos = [], nrm = [], uvs = [];
	for ( let i = 0; i < n; i ++ ) {

		const key = position[ i * 3 ] + ',' + position[ i * 3 + 1 ] + ',' + position[ i * 3 + 2 ] + ',' + uv[ i * 2 ] + ',' + uv[ i * 2 + 1 ];
		let id = map.get( key );
		if ( id === undefined ) {

			id = map.size;
			map.set( key, id );
			pos.push( position[ i * 3 ], position[ i * 3 + 1 ], position[ i * 3 + 2 ] );
			nrm.push( 0, 0, 0 );
			uvs.push( uv[ i * 2 ], uv[ i * 2 + 1 ] );

		}

		remap[ i ] = id;
		nrm[ id * 3 ] += normal[ i * 3 ]; nrm[ id * 3 + 1 ] += normal[ i * 3 + 1 ]; nrm[ id * 3 + 2 ] += normal[ i * 3 + 2 ];

	}

	const outIdx = [];
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = remap[ index[ t ] ], b = remap[ index[ t + 1 ] ], c = remap[ index[ t + 2 ] ];
		if ( a === b || b === c || a === c ) continue;
		outIdx.push( a, b, c );

	}

	const N = new Float32Array( nrm );
	for ( let i = 0; i < N.length; i += 3 ) {

		const l = Math.hypot( N[ i ], N[ i + 1 ], N[ i + 2 ] ) || 1;
		N[ i ] /= l; N[ i + 1 ] /= l; N[ i + 2 ] /= l;

	}

	return { position: new Float32Array( pos ), normal: N, uv: new Float32Array( uvs ), index: new Uint32Array( outIdx ) };

}

/** Drop unreferenced vertices and re-index. */
export function compactGeometry( geo ) {

	const { position, normal, uv, index } = geo;
	const n = position.length / 3;
	const remap = new Int32Array( n ).fill( - 1 );
	let count = 0;
	for ( let i = 0; i < index.length; i ++ ) if ( remap[ index[ i ] ] < 0 ) remap[ index[ i ] ] = count ++;
	const P = new Float32Array( count * 3 ), N = new Float32Array( count * 3 ), U = new Float32Array( count * 2 );
	for ( let i = 0; i < n; i ++ ) {

		const r = remap[ i ];
		if ( r < 0 ) continue;
		P.set( position.subarray( i * 3, i * 3 + 3 ), r * 3 );
		N.set( normal.subarray( i * 3, i * 3 + 3 ), r * 3 );
		U.set( uv.subarray( i * 2, i * 2 + 2 ), r * 2 );

	}

	const I = new Uint32Array( index.length );
	for ( let i = 0; i < index.length; i ++ ) I[ i ] = remap[ index[ i ] ];
	return { position: P, normal: N, uv: U, index: I };

}

export function boundsOf( position ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < position.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) {

		const v = position[ i + k ];
		if ( v < min[ k ] ) min[ k ] = v;
		if ( v > max[ k ] ) max[ k ] = v;

	}

	return { min, max, size: max.map( ( v, k ) => v - min[ k ] ) };

}

export function surfaceArea( geo ) {

	const { position: p, index } = geo;
	let area = 0;
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ] * 3, b = index[ t + 1 ] * 3, c = index[ t + 2 ] * 3;
		const ux = p[ b ] - p[ a ], uy = p[ b + 1 ] - p[ a + 1 ], uz = p[ b + 2 ] - p[ a + 2 ];
		const vx = p[ c ] - p[ a ], vy = p[ c + 1 ] - p[ a + 1 ], vz = p[ c + 2 ] - p[ a + 2 ];
		area += 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );

	}

	return area;

}

// ---------------------------------------------------------------- UV coverage mask

/**
 * Rasterise UV triangles into a width x height coverage mask (Uint8Array, 1 = covered). glTF convention: v = 0 is the top row.
 * expand (texels): 0 = texel centre inside a triangle; > 0 grows every triangle by that distance, < 0 shrinks it.
 * uvScale = [su, sv] is applied to the UVs first (used when the texture is cropped).
 */
export function rasterizeUvMask( geos, width, height = width, expand = 0, uvScale = [ 1, 1 ] ) {

	const mask = new Uint8Array( width * height );
	const pad = Math.max( 0, Math.ceil( expand ) );
	for ( const geo of geos ) {

		const { uv, index } = geo;
		for ( let t = 0; t < index.length; t += 3 ) {

			const a = index[ t ] * 2, b = index[ t + 1 ] * 2, c = index[ t + 2 ] * 2;
			const x0 = uv[ a ] * uvScale[ 0 ] * width - 0.5, y0 = uv[ a + 1 ] * uvScale[ 1 ] * height - 0.5;
			const x1 = uv[ b ] * uvScale[ 0 ] * width - 0.5, y1 = uv[ b + 1 ] * uvScale[ 1 ] * height - 0.5;
			const x2 = uv[ c ] * uvScale[ 0 ] * width - 0.5, y2 = uv[ c + 1 ] * uvScale[ 1 ] * height - 0.5;
			const area = ( x1 - x0 ) * ( y2 - y0 ) - ( x2 - x0 ) * ( y1 - y0 );
			if ( area === 0 ) continue;
			const sign = area < 0 ? - 1 : 1;
			const minX = Math.max( 0, Math.floor( Math.min( x0, x1, x2 ) ) - pad ), maxX = Math.min( width - 1, Math.ceil( Math.max( x0, x1, x2 ) ) + pad );
			const minY = Math.max( 0, Math.floor( Math.min( y0, y1, y2 ) ) - pad ), maxY = Math.min( height - 1, Math.ceil( Math.max( y0, y1, y2 ) ) + pad );
			// edge functions: w = sign * cross( edge, p - origin ) = signed distance * edge length
			const e0x = x1 - x0, e0y = y1 - y0, e1x = x2 - x1, e1y = y2 - y1, e2x = x0 - x2, e2y = y0 - y2;
			const b0 = - expand * Math.hypot( e0x, e0y ), b1 = - expand * Math.hypot( e1x, e1y ), b2 = - expand * Math.hypot( e2x, e2y );
			for ( let y = minY; y <= maxY; y ++ ) {

				for ( let x = minX; x <= maxX; x ++ ) {

					const w0 = sign * ( e0x * ( y - y0 ) - ( x - x0 ) * e0y );
					if ( w0 < b0 ) continue;
					const w1 = sign * ( e1x * ( y - y1 ) - ( x - x1 ) * e1y );
					if ( w1 < b1 ) continue;
					const w2 = sign * ( e2x * ( y - y2 ) - ( x - x2 ) * e2y );
					if ( w2 < b2 ) continue;
					mask[ y * width + x ] = 1;

				}

			}

		}

	}

	return mask;

}

// ---------------------------------------------------------------- convex hull (small point sets) + greedy reduction

/**
 * Supporting planes of the convex hull of a SMALL point set (brute force over triples, fine for n <= ~40).
 * Returns [{ n:[x,y,z] (outward unit normal), d (n.p = d on the plane), idx:[i,j,k] }]. Coplanar faces may be reported more than once.
 */
export function hullPlanes( pts ) {

	const n = pts.length;
	const planes = [];
	let scale = 0;
	for ( const p of pts ) scale = Math.max( scale, Math.abs( p[ 0 ] - pts[ 0 ][ 0 ] ), Math.abs( p[ 1 ] - pts[ 0 ][ 1 ] ), Math.abs( p[ 2 ] - pts[ 0 ][ 2 ] ) );
	const eps = 1e-7 * Math.max( scale, 1e-9 );
	for ( let i = 0; i < n; i ++ ) for ( let j = i + 1; j < n; j ++ ) for ( let k = j + 1; k < n; k ++ ) {

		const a = pts[ i ], b = pts[ j ], c = pts[ k ];
		const ux = b[ 0 ] - a[ 0 ], uy = b[ 1 ] - a[ 1 ], uz = b[ 2 ] - a[ 2 ];
		const vx = c[ 0 ] - a[ 0 ], vy = c[ 1 ] - a[ 1 ], vz = c[ 2 ] - a[ 2 ];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const len = Math.hypot( nx, ny, nz );
		if ( len < 1e-10 * scale * scale ) continue;
		nx /= len; ny /= len; nz /= len;
		let pos = false, neg = false;
		for ( let m = 0; m < n; m ++ ) {

			if ( m === i || m === j || m === k ) continue;
			const dist = ( pts[ m ][ 0 ] - a[ 0 ] ) * nx + ( pts[ m ][ 1 ] - a[ 1 ] ) * ny + ( pts[ m ][ 2 ] - a[ 2 ] ) * nz;
			if ( dist > eps ) pos = true; else if ( dist < - eps ) neg = true;
			if ( pos && neg ) break;

		}

		if ( pos && neg ) continue;
		if ( pos ) { nx = - nx; ny = - ny; nz = - nz; }
		planes.push( { n: [ nx, ny, nz ], d: nx * a[ 0 ] + ny * a[ 1 ] + nz * a[ 2 ], idx: pos ? [ i, k, j ] : [ i, j, k ] } );

	}

	return planes;

}

/** Largest distance by which any of the given vertices (ids into position) lies outside the hull described by planes. */
export function maxOutside( position, ids, planes ) {

	let best = - 1, bestD = 0;
	for ( let q = 0; q < ids.length; q ++ ) {

		const i = ids[ q ];
		const x = position[ i * 3 ], y = position[ i * 3 + 1 ], z = position[ i * 3 + 2 ];
		let out = 0;
		for ( let f = 0; f < planes.length; f ++ ) {

			const pl = planes[ f ];
			const d = pl.n[ 0 ] * x + pl.n[ 1 ] * y + pl.n[ 2 ] * z - pl.d;
			if ( d > out ) out = d;

		}

		if ( out > bestD ) { bestD = out; best = i; }

	}

	return { index: best, distance: bestD };

}

/**
 * Approximate convex hull with at most maxPoints points, all taken from the input vertices (an inner approximation of the true hull).
 * Greedy farthest-point insertion: seed with the axis extremes, then repeatedly add the vertex farthest outside the current hull.
 * Returns { points: [[x,y,z],...], maxError } - maxError = largest distance of an input vertex outside the reduced hull (meters).
 */
export function approximateHull( position, maxPoints = 24, subset = null ) {

	const n = position.length / 3;
	const ids = subset || Uint32Array.from( { length: n }, ( _, i ) => i );
	if ( ids.length < 4 ) return { points: Array.from( ids, ( i ) => [ position[ i * 3 ], position[ i * 3 + 1 ], position[ i * 3 + 2 ] ] ), maxError: 0 };
	const P = ( i ) => [ position[ i * 3 ], position[ i * 3 + 1 ], position[ i * 3 + 2 ] ];
	const chosen = new Set();
	for ( let axis = 0; axis < 3; axis ++ ) {

		let lo = ids[ 0 ], hi = ids[ 0 ];
		for ( let q = 0; q < ids.length; q ++ ) {

			const i = ids[ q ];
			if ( position[ i * 3 + axis ] < position[ lo * 3 + axis ] ) lo = i;
			if ( position[ i * 3 + axis ] > position[ hi * 3 + axis ] ) hi = i;

		}

		chosen.add( lo ); chosen.add( hi );

	}

	let pts = [ ...chosen ].map( P );
	let maxError = Infinity;
	for ( let iter = 0; iter < 400; iter ++ ) {

		const planes = hullPlanes( pts );
		let far;
		if ( planes.length === 0 ) {

			// degenerate seed (all chosen points collinear / coplanar): take the vertex farthest from the first seed that is not chosen yet
			far = { index: - 1, distance: 0 };
			for ( let q = 0; q < ids.length; q ++ ) {

				const i = ids[ q ];
				if ( chosen.has( i ) ) continue;
				const d = Math.hypot( position[ i * 3 ] - pts[ 0 ][ 0 ], position[ i * 3 + 1 ] - pts[ 0 ][ 1 ], position[ i * 3 + 2 ] - pts[ 0 ][ 2 ] );
				if ( d > far.distance ) far = { index: i, distance: d };

			}

		} else {

			far = maxOutside( position, ids, planes );
			maxError = far.distance;

		}

		if ( far.index < 0 || far.distance < 1e-6 || chosen.size >= maxPoints ) break;
		chosen.add( far.index );
		pts = [ ...chosen ].map( P );

	}

	// drop points that ended up inside the final hull
	const planes = hullPlanes( pts );
	const used = new Set();
	for ( const f of planes ) for ( const i of f.idx ) used.add( i );
	const points = planes.length ? pts.filter( ( _, i ) => used.has( i ) ) : pts;
	if ( ! Number.isFinite( maxError ) ) maxError = 0;
	return { points, maxError };

}

// ---------------------------------------------------------------- transforms / normals / simplification

/** Uniform scale, then yaw (rotation about +Y, radians, counter-clockwise seen from above), then translation. Returns a new geometry. */
export function transformGeometry( geo, { scale = 1, yaw = 0, translate = [ 0, 0, 0 ] } = {} ) {

	const n = geo.position.length / 3;
	const position = new Float32Array( n * 3 ), normal = new Float32Array( n * 3 );
	const c = Math.cos( yaw ), s = Math.sin( yaw );
	for ( let i = 0; i < n; i ++ ) {

		const x = geo.position[ i * 3 ] * scale, y = geo.position[ i * 3 + 1 ] * scale, z = geo.position[ i * 3 + 2 ] * scale;
		position[ i * 3 ] = c * x + s * z + translate[ 0 ];
		position[ i * 3 + 1 ] = y + translate[ 1 ];
		position[ i * 3 + 2 ] = - s * x + c * z + translate[ 2 ];
		const nx = geo.normal[ i * 3 ], nz = geo.normal[ i * 3 + 2 ];
		normal[ i * 3 ] = c * nx + s * nz;
		normal[ i * 3 + 1 ] = geo.normal[ i * 3 + 1 ];
		normal[ i * 3 + 2 ] = - s * nx + c * nz;

	}

	return { position, normal, uv: geo.uv, index: geo.index };

}

/** Area-weighted mean face normal (not normalised) - used to find the facing direction of open "sheet" meshes. */
export function meanFaceNormal( geo ) {

	const { position: p, index } = geo;
	const m = [ 0, 0, 0 ];
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ] * 3, b = index[ t + 1 ] * 3, c = index[ t + 2 ] * 3;
		const ux = p[ b ] - p[ a ], uy = p[ b + 1 ] - p[ a + 1 ], uz = p[ b + 2 ] - p[ a + 2 ];
		const vx = p[ c ] - p[ a ], vy = p[ c + 1 ] - p[ a + 1 ], vz = p[ c + 2 ] - p[ a + 2 ];
		m[ 0 ] += 0.5 * ( uy * vz - uz * vy ); m[ 1 ] += 0.5 * ( uz * vx - ux * vz ); m[ 2 ] += 0.5 * ( ux * vy - uy * vx );

	}

	return m;

}

/** Smooth vertex normals recomputed from the triangles (area weighted), continuous across UV seams (accumulated per position). */
export function recomputeNormals( geo ) {

	const { position: p, index } = geo;
	const n = p.length / 3;
	const map = new Map(), pid = new Int32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		const k = p[ i * 3 ] + ',' + p[ i * 3 + 1 ] + ',' + p[ i * 3 + 2 ];
		let id = map.get( k ); if ( id === undefined ) { id = map.size; map.set( k, id ); } pid[ i ] = id;

	}

	const acc = new Float64Array( map.size * 3 );
	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ] * 3, b = index[ t + 1 ] * 3, c = index[ t + 2 ] * 3;
		const ux = p[ b ] - p[ a ], uy = p[ b + 1 ] - p[ a + 1 ], uz = p[ b + 2 ] - p[ a + 2 ];
		const vx = p[ c ] - p[ a ], vy = p[ c + 1 ] - p[ a + 1 ], vz = p[ c + 2 ] - p[ a + 2 ];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for ( const v of [ index[ t ], index[ t + 1 ], index[ t + 2 ] ] ) { const o = pid[ v ] * 3; acc[ o ] += nx; acc[ o + 1 ] += ny; acc[ o + 2 ] += nz; }

	}

	const normal = new Float32Array( n * 3 );
	for ( let i = 0; i < n; i ++ ) {

		const o = pid[ i ] * 3;
		const l = Math.hypot( acc[ o ], acc[ o + 1 ], acc[ o + 2 ] );
		if ( l > 0 ) { normal[ i * 3 ] = acc[ o ] / l; normal[ i * 3 + 1 ] = acc[ o + 1 ] / l; normal[ i * 3 + 2 ] = acc[ o + 2 ] / l; } else { normal[ i * 3 ] = geo.normal[ i * 3 ]; normal[ i * 3 + 1 ] = geo.normal[ i * 3 + 1 ]; normal[ i * 3 + 2 ] = geo.normal[ i * 3 + 2 ]; }

	}

	return normal;

}

/** normalize( a * (1 - t) + b * t ) per vertex. */
export function blendNormals( a, b, t ) {

	const out = new Float32Array( a.length );
	for ( let i = 0; i < a.length; i += 3 ) {

		const x = a[ i ] * ( 1 - t ) + b[ i ] * t, y = a[ i + 1 ] * ( 1 - t ) + b[ i + 1 ] * t, z = a[ i + 2 ] * ( 1 - t ) + b[ i + 2 ] * t;
		const l = Math.hypot( x, y, z ) || 1;
		out[ i ] = x / l; out[ i + 1 ] = y / l; out[ i + 2 ] = z / l;

	}

	return out;

}

/**
 * Simplify a welded geometry to at most targetTris triangles with meshoptimizer. UV seams are respected (vertices on a seam only
 * collapse along it, both sides in lockstep), so the texture mapping stays intact and the surface stays watertight.
 * mode: 'pos' (position error only), 'attr' (position + normal/uv attribute error), 'update' (attr + optimised vertex positions).
 * Returns { geo (compacted), error: meshopt's relative error, errorMeters }.
 */
export function simplifyGeometry( geo, targetTris, { mode = 'attr', normalWeight = 0.5, uvWeight = 0, flags = [], maxError = 1 } = {} ) {

	const nV = geo.position.length / 3;
	const scale = MeshoptSimplifier.getScale( geo.position, 3 );
	const target = Math.floor( targetTris ) * 3;
	let index, error, position = geo.position, normal = geo.normal, uv = geo.uv;
	if ( geo.index.length <= target ) return { geo, error: 0, errorMeters: 0 };
	if ( mode === 'pos' ) {

		[ index, error ] = MeshoptSimplifier.simplify( geo.index, geo.position, 3, target, maxError, flags );

	} else {

		const attrs = new Float32Array( nV * 5 );
		for ( let i = 0; i < nV; i ++ ) {

			attrs[ i * 5 ] = geo.normal[ i * 3 ]; attrs[ i * 5 + 1 ] = geo.normal[ i * 3 + 1 ]; attrs[ i * 5 + 2 ] = geo.normal[ i * 3 + 2 ];
			attrs[ i * 5 + 3 ] = geo.uv[ i * 2 ]; attrs[ i * 5 + 4 ] = geo.uv[ i * 2 + 1 ];

		}

		const weights = [ normalWeight, normalWeight, normalWeight, uvWeight, uvWeight ];
		if ( mode === 'attr' ) {

			[ index, error ] = MeshoptSimplifier.simplifyWithAttributes( geo.index, geo.position, 3, attrs, 5, weights, null, target, maxError, flags );

		} else {

			position = new Float32Array( geo.position );
			index = new Uint32Array( geo.index );
			let count;
			[ count, error ] = MeshoptSimplifier.simplifyWithUpdate( index, position, 3, attrs, 5, weights, null, target, maxError, flags );
			index = index.slice( 0, count );
			normal = new Float32Array( nV * 3 ); uv = new Float32Array( nV * 2 );
			for ( let i = 0; i < nV; i ++ ) {

				const l = Math.hypot( attrs[ i * 5 ], attrs[ i * 5 + 1 ], attrs[ i * 5 + 2 ] ) || 1;
				normal[ i * 3 ] = attrs[ i * 5 ] / l; normal[ i * 3 + 1 ] = attrs[ i * 5 + 1 ] / l; normal[ i * 3 + 2 ] = attrs[ i * 5 + 2 ] / l;
				uv[ i * 2 ] = attrs[ i * 5 + 3 ]; uv[ i * 2 + 1 ] = attrs[ i * 5 + 4 ];

			}

		}

	}

	return { geo: compactGeometry( { position, normal, uv, index } ), error, errorMeters: error * scale };

}

// ---------------------------------------------------------------- point-to-mesh distance (uniform grid)

function closestPointOnTriangleSq( px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz ) {

	const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
	let qx, qy, qz;
	if ( d1 <= 0 && d2 <= 0 ) { qx = ax; qy = ay; qz = az; } else {

		const bpx = px - bx, bpy = py - by, bpz = pz - bz;
		const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
		if ( d3 >= 0 && d4 <= d3 ) { qx = bx; qy = by; qz = bz; } else {

			const vc = d1 * d4 - d3 * d2;
			if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) { const v = d1 / ( d1 - d3 ); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; } else {

				const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
				const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
				if ( d6 >= 0 && d5 <= d6 ) { qx = cx; qy = cy; qz = cz; } else {

					const vb = d5 * d2 - d1 * d6;
					if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) { const w = d2 / ( d2 - d6 ); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; } else {

						const va = d3 * d6 - d5 * d4;
						if ( va <= 0 && ( d4 - d3 ) >= 0 && ( d5 - d6 ) >= 0 ) { const w = ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) ); qx = bx + w * ( cx - bx ); qy = by + w * ( cy - by ); qz = bz + w * ( cz - bz ); } else {

							const denom = 1 / ( va + vb + vc );
							const v = vb * denom, w = vc * denom;
							qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;

						}

					}

				}

			}

		}

	}

	const dx = px - qx, dy = py - qy, dz = pz - qz;
	return dx * dx + dy * dy + dz * dz;

}

/** Distances (max, rms, p99) from the vertices of `from` to the surface of `to` (one-sided Hausdorff-type measure), in mesh units. */
export function meshDeviation( from, to, sampleStep = 1 ) {

	const b = boundsOf( to.position );
	const maxDim = Math.max( ...b.size );
	const triCount = to.index.length / 3;
	const N = Math.max( 4, Math.min( 96, Math.round( Math.cbrt( triCount ) * 1.6 ) ) );
	const cell = maxDim / N || 1;
	const gx = Math.max( 1, Math.ceil( b.size[ 0 ] / cell ) ), gy = Math.max( 1, Math.ceil( b.size[ 1 ] / cell ) ), gz = Math.max( 1, Math.ceil( b.size[ 2 ] / cell ) );
	const cells = Array.from( { length: gx * gy * gz }, () => [] );
	const p = to.position, idx = to.index;
	const ci = ( v, k, g ) => Math.max( 0, Math.min( g - 1, Math.floor( ( v - b.min[ k ] ) / cell ) ) );
	for ( let t = 0; t < triCount; t ++ ) {

		const a = idx[ t * 3 ] * 3, bb = idx[ t * 3 + 1 ] * 3, c = idx[ t * 3 + 2 ] * 3;
		const x0 = ci( Math.min( p[ a ], p[ bb ], p[ c ] ), 0, gx ), x1 = ci( Math.max( p[ a ], p[ bb ], p[ c ] ), 0, gx );
		const y0 = ci( Math.min( p[ a + 1 ], p[ bb + 1 ], p[ c + 1 ] ), 1, gy ), y1 = ci( Math.max( p[ a + 1 ], p[ bb + 1 ], p[ c + 1 ] ), 1, gy );
		const z0 = ci( Math.min( p[ a + 2 ], p[ bb + 2 ], p[ c + 2 ] ), 2, gz ), z1 = ci( Math.max( p[ a + 2 ], p[ bb + 2 ], p[ c + 2 ] ), 2, gz );
		for ( let z = z0; z <= z1; z ++ ) for ( let y = y0; y <= y1; y ++ ) for ( let x = x0; x <= x1; x ++ ) cells[ ( z * gy + y ) * gx + x ].push( t );

	}

	const q = from.position;
	const nq = q.length / 3;
	const dists = [];
	let sum2 = 0, max = 0;
	const maxRing = Math.max( gx, gy, gz );
	for ( let i = 0; i < nq; i += sampleStep ) {

		const px = q[ i * 3 ], py = q[ i * 3 + 1 ], pz = q[ i * 3 + 2 ];
		const cx = ci( px, 0, gx ), cy = ci( py, 1, gy ), cz = ci( pz, 2, gz );
		let best = Infinity;
		for ( let r = 0; r <= maxRing; r ++ ) {

			// once the best distance is closer than the nearest face of the not-yet-visited shell, stop
			if ( best < Infinity && Math.sqrt( best ) <= ( r - 1 ) * cell ) break;
			for ( let z = cz - r; z <= cz + r; z ++ ) {

				if ( z < 0 || z >= gz ) continue;
				for ( let y = cy - r; y <= cy + r; y ++ ) {

					if ( y < 0 || y >= gy ) continue;
					const edgeZY = Math.abs( z - cz ) === r || Math.abs( y - cy ) === r;
					for ( let x = cx - r; x <= cx + r; x ++ ) {

						if ( x < 0 || x >= gx ) continue;
						if ( ! edgeZY && Math.abs( x - cx ) !== r ) continue; // only the shell of ring r
						const list = cells[ ( z * gy + y ) * gx + x ];
						for ( let k = 0; k < list.length; k ++ ) {

							const t = list[ k ];
							const a = idx[ t * 3 ] * 3, bb = idx[ t * 3 + 1 ] * 3, c = idx[ t * 3 + 2 ] * 3;
							const d = closestPointOnTriangleSq( px, py, pz, p[ a ], p[ a + 1 ], p[ a + 2 ], p[ bb ], p[ bb + 1 ], p[ bb + 2 ], p[ c ], p[ c + 1 ], p[ c + 2 ] );
							if ( d < best ) best = d;

						}

					}

				}

			}

		}

		const d = Math.sqrt( best );
		dists.push( d );
		sum2 += best;
		if ( d > max ) max = d;

	}

	dists.sort( ( a, b2 ) => a - b2 );
	return { max, rms: Math.sqrt( sum2 / dists.length ), p99: dists[ Math.floor( dists.length * 0.99 ) ], p95: dists[ Math.floor( dists.length * 0.95 ) ] };

}
