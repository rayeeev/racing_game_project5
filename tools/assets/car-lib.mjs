// Shared helpers for the car asset scripts (Node ESM, no three.js dependency).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export async function makeIO() {

	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	return new NodeIO()
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( {
			'draco3d.decoder': await draco3d.createDecoderModule(),
			'draco3d.encoder': await draco3d.createEncoderModule(),
			'meshopt.decoder': MeshoptDecoder,
			'meshopt.encoder': MeshoptEncoder,
		} );

}

// column-major 4x4 multiply (a * b)
export function mat4mul( a, b ) {

	const o = new Array( 16 );
	for ( let c = 0; c < 4; c ++ ) for ( let r = 0; r < 4; r ++ ) {

		let s = 0;
		for ( let k = 0; k < 4; k ++ ) s += a[ k * 4 + r ] * b[ c * 4 + k ];
		o[ c * 4 + r ] = s;

	}

	return o;

}

export const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

export function worldMatrix( node ) {

	const chain = [];
	for ( let n = node; n; n = n.getParentNode ? n.getParentNode() : null ) chain.unshift( n );
	let m = IDENTITY;
	for ( const n of chain ) m = mat4mul( m, n.getMatrix() );
	return m;

}

// Flatten one primitive into world-space Float32Arrays: positions, normals (renormalised), indices (Uint32Array).
// The node matrices of the car files are rigid (rotation + translation, unit scale), so normals use the upper 3x3 directly.
export function readPrimitiveWorld( prim, m ) {

	const pos = prim.getAttribute( 'POSITION' );
	const nor = prim.getAttribute( 'NORMAL' );
	const n = pos.getCount();
	const P = new Float32Array( n * 3 );
	const N = new Float32Array( n * 3 );
	const v = [ 0, 0, 0 ];
	for ( let i = 0; i < n; i ++ ) {

		pos.getElement( i, v );
		P[ i * 3 ] = m[ 0 ] * v[ 0 ] + m[ 4 ] * v[ 1 ] + m[ 8 ] * v[ 2 ] + m[ 12 ];
		P[ i * 3 + 1 ] = m[ 1 ] * v[ 0 ] + m[ 5 ] * v[ 1 ] + m[ 9 ] * v[ 2 ] + m[ 13 ];
		P[ i * 3 + 2 ] = m[ 2 ] * v[ 0 ] + m[ 6 ] * v[ 1 ] + m[ 10 ] * v[ 2 ] + m[ 14 ];
		if ( nor ) {

			nor.getElement( i, v );
			const x = m[ 0 ] * v[ 0 ] + m[ 4 ] * v[ 1 ] + m[ 8 ] * v[ 2 ];
			const y = m[ 1 ] * v[ 0 ] + m[ 5 ] * v[ 1 ] + m[ 9 ] * v[ 2 ];
			const z = m[ 2 ] * v[ 0 ] + m[ 6 ] * v[ 1 ] + m[ 10 ] * v[ 2 ];
			const l = Math.hypot( x, y, z ) || 1;
			N[ i * 3 ] = x / l; N[ i * 3 + 1 ] = y / l; N[ i * 3 + 2 ] = z / l;

		}

	}

	const idxAcc = prim.getIndices();
	let I;
	if ( idxAcc ) {

		I = new Uint32Array( idxAcc.getCount() );
		for ( let i = 0; i < I.length; i ++ ) I[ i ] = idxAcc.getScalar( i );

	} else {

		I = new Uint32Array( n );
		for ( let i = 0; i < n; i ++ ) I[ i ] = i;

	}

	return { positions: P, normals: nor ? N : null, indices: I };

}

// Connected components of a triangle soup. Vertices closer than `tol` (quantised grid) are treated as the same vertex.
// Returns { comp: Int32Array(triCount) component id per triangle, count, list:[{id,tris,min,max,center,size,area}] } sorted by area desc.
export function connectedComponents( positions, indices, tol = 1e-4 ) {

	const nV = positions.length / 3;
	const key = new Map();
	const weld = new Uint32Array( nV );
	let nW = 0;
	const inv = 1 / tol;
	for ( let i = 0; i < nV; i ++ ) {

		const k = Math.round( positions[ i * 3 ] * inv ) + ',' + Math.round( positions[ i * 3 + 1 ] * inv ) + ',' + Math.round( positions[ i * 3 + 2 ] * inv );
		let w = key.get( k );
		if ( w === undefined ) { w = nW ++; key.set( k, w ); }
		weld[ i ] = w;

	}

	const parent = new Uint32Array( nW );
	for ( let i = 0; i < nW; i ++ ) parent[ i ] = i;
	const find = ( a ) => { while ( parent[ a ] !== a ) { parent[ a ] = parent[ parent[ a ] ]; a = parent[ a ]; } return a; };
	const nT = indices.length / 3;
	for ( let t = 0; t < nT; t ++ ) {

		const a = find( weld[ indices[ t * 3 ] ] ), b = find( weld[ indices[ t * 3 + 1 ] ] ), c = find( weld[ indices[ t * 3 + 2 ] ] );
		if ( a !== b ) parent[ b ] = a;
		const a2 = find( a );
		if ( a2 !== c ) parent[ find( c ) ] = a2;

	}

	const ids = new Map();
	const comp = new Int32Array( nT );
	const list = [];
	for ( let t = 0; t < nT; t ++ ) {

		const r = find( weld[ indices[ t * 3 ] ] );
		let id = ids.get( r );
		if ( id === undefined ) {

			id = list.length; ids.set( r, id );
			list.push( { id, tris: 0, min: [ Infinity, Infinity, Infinity ], max: [ - Infinity, - Infinity, - Infinity ], area: 0 } );

		}

		comp[ t ] = id;
		const c = list[ id ];
		c.tris ++;
		const p = [];
		for ( let k = 0; k < 3; k ++ ) {

			const vi = indices[ t * 3 + k ];
			const x = positions[ vi * 3 ], y = positions[ vi * 3 + 1 ], z = positions[ vi * 3 + 2 ];
			p.push( [ x, y, z ] );
			if ( x < c.min[ 0 ] ) c.min[ 0 ] = x; if ( y < c.min[ 1 ] ) c.min[ 1 ] = y; if ( z < c.min[ 2 ] ) c.min[ 2 ] = z;
			if ( x > c.max[ 0 ] ) c.max[ 0 ] = x; if ( y > c.max[ 1 ] ) c.max[ 1 ] = y; if ( z > c.max[ 2 ] ) c.max[ 2 ] = z;

		}

		const ux = p[ 1 ][ 0 ] - p[ 0 ][ 0 ], uy = p[ 1 ][ 1 ] - p[ 0 ][ 1 ], uz = p[ 1 ][ 2 ] - p[ 0 ][ 2 ];
		const vx = p[ 2 ][ 0 ] - p[ 0 ][ 0 ], vy = p[ 2 ][ 1 ] - p[ 0 ][ 1 ], vz = p[ 2 ][ 2 ] - p[ 0 ][ 2 ];
		c.area += 0.5 * Math.hypot( uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx );

	}

	for ( const c of list ) {

		c.center = c.min.map( ( x, k ) => ( x + c.max[ k ] ) / 2 );
		c.size = c.max.map( ( x, k ) => x - c.min[ k ] );

	}

	return { comp, count: list.length, list };

}

export const r4 = ( v ) => ( Array.isArray( v ) ? v.map( ( x ) => Math.round( x * 10000 ) / 10000 ) : Math.round( v * 10000 ) / 10000 );
export const r3 = ( v ) => ( Array.isArray( v ) ? v.map( ( x ) => Math.round( x * 1000 ) / 1000 ) : Math.round( v * 1000 ) / 1000 );

// ---------------------------------------------------------------------------------------------------------------------
// Geometry containers: { positions: Float32Array(3n), normals: Float32Array(3n), uvs: Float32Array(2n)|null,
//                        ao: Float32Array(n)|null, indices: Uint32Array }
// ---------------------------------------------------------------------------------------------------------------------

export function makeGeo( positions, normals, indices, uvs = null ) {

	return { positions, normals, indices, uvs, ao: null };

}

// Extract the triangles for which keep(t) is true (compacts vertices).
export function subsetGeo( geo, keep ) {

	const nT = geo.indices.length / 3;
	const map = new Int32Array( geo.positions.length / 3 ).fill( - 1 );
	const idx = [];
	let nV = 0;
	for ( let t = 0; t < nT; t ++ ) {

		if ( ! keep( t ) ) continue;
		for ( let k = 0; k < 3; k ++ ) {

			const v = geo.indices[ t * 3 + k ];
			if ( map[ v ] < 0 ) map[ v ] = nV ++;
			idx.push( map[ v ] );

		}

	}

	const P = new Float32Array( nV * 3 ), N = new Float32Array( nV * 3 );
	const U = geo.uvs ? new Float32Array( nV * 2 ) : null;
	const A = geo.ao ? new Float32Array( nV ) : null;
	for ( let v = 0; v < map.length; v ++ ) {

		const d = map[ v ];
		if ( d < 0 ) continue;
		P.set( geo.positions.subarray( v * 3, v * 3 + 3 ), d * 3 );
		N.set( geo.normals.subarray( v * 3, v * 3 + 3 ), d * 3 );
		if ( U ) U.set( geo.uvs.subarray( v * 2, v * 2 + 2 ), d * 2 );
		if ( A ) A[ d ] = geo.ao[ v ];

	}

	return { positions: P, normals: N, uvs: U, ao: A, indices: Uint32Array.from( idx ) };

}

export function mergeGeos( list ) {

	list = list.filter( ( g ) => g && g.indices.length > 0 );
	let nV = 0, nI = 0;
	const hasUv = list.some( ( g ) => g.uvs ), hasAo = list.some( ( g ) => g.ao );
	for ( const g of list ) { nV += g.positions.length / 3; nI += g.indices.length; }
	const P = new Float32Array( nV * 3 ), N = new Float32Array( nV * 3 ), I = new Uint32Array( nI );
	const U = hasUv ? new Float32Array( nV * 2 ) : null;
	const A = hasAo ? new Float32Array( nV ).fill( 1 ) : null;
	let vo = 0, io = 0;
	for ( const g of list ) {

		P.set( g.positions, vo * 3 ); N.set( g.normals, vo * 3 );
		if ( U && g.uvs ) U.set( g.uvs, vo * 2 );
		if ( A && g.ao ) A.set( g.ao, vo );
		for ( let i = 0; i < g.indices.length; i ++ ) I[ io + i ] = g.indices[ i ] + vo;
		vo += g.positions.length / 3; io += g.indices.length;

	}

	return { positions: P, normals: N, uvs: U, ao: A, indices: I };

}

export function cloneGeo( g ) {

	return { positions: g.positions.slice(), normals: g.normals.slice(), uvs: g.uvs ? g.uvs.slice() : null, ao: g.ao ? g.ao.slice() : null, indices: g.indices.slice() };

}

export function translateGeo( g, dx, dy, dz ) {

	const P = g.positions;
	for ( let i = 0; i < P.length; i += 3 ) { P[ i ] += dx; P[ i + 1 ] += dy; P[ i + 2 ] += dz; }
	return g;

}

// Apply a rigid 3x3 rotation matrix (row-major array of 9) to positions and normals.
export function rotateGeo( g, R ) {

	for ( const A of [ g.positions, g.normals ] ) {

		for ( let i = 0; i < A.length; i += 3 ) {

			const x = A[ i ], y = A[ i + 1 ], z = A[ i + 2 ];
			A[ i ] = R[ 0 ] * x + R[ 1 ] * y + R[ 2 ] * z;
			A[ i + 1 ] = R[ 3 ] * x + R[ 4 ] * y + R[ 5 ] * z;
			A[ i + 2 ] = R[ 6 ] * x + R[ 7 ] * y + R[ 8 ] * z;

		}

	}

	return g;

}

export function setUv( g, u, v ) {

	const n = g.positions.length / 3;
	g.uvs = new Float32Array( n * 2 );
	for ( let i = 0; i < n; i ++ ) { g.uvs[ i * 2 ] = u; g.uvs[ i * 2 + 1 ] = v; }
	return g;

}

export function bboxOf( positions ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < positions.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) {

		const v = positions[ i + k ];
		if ( v < min[ k ] ) min[ k ] = v;
		if ( v > max[ k ] ) max[ k ] = v;

	}

	return { min, max, center: min.map( ( x, k ) => ( x + max[ k ] ) / 2 ), size: max.map( ( x, k ) => x - min[ k ] ) };

}

export const triCount = ( g ) => g.indices.length / 3;

// Remove exact duplicate vertices (same quantised position / normal / uv) and degenerate triangles.
export function weldGeo( g, posTol = 1e-5, norTol = 1e-3 ) {

	const n = g.positions.length / 3;
	const map = new Map();
	const remap = new Uint32Array( n );
	const keepList = [];
	const ip = 1 / posTol, inr = 1 / norTol;
	for ( let i = 0; i < n; i ++ ) {

		let k = Math.round( g.positions[ i * 3 ] * ip ) + ',' + Math.round( g.positions[ i * 3 + 1 ] * ip ) + ',' + Math.round( g.positions[ i * 3 + 2 ] * ip ) + '|' +
			Math.round( g.normals[ i * 3 ] * inr ) + ',' + Math.round( g.normals[ i * 3 + 1 ] * inr ) + ',' + Math.round( g.normals[ i * 3 + 2 ] * inr );
		if ( g.uvs ) k += '|' + Math.round( g.uvs[ i * 2 ] * 1e4 ) + ',' + Math.round( g.uvs[ i * 2 + 1 ] * 1e4 );
		let d = map.get( k );
		if ( d === undefined ) { d = keepList.length; map.set( k, d ); keepList.push( i ); }
		remap[ i ] = d;

	}

	const nV = keepList.length;
	const P = new Float32Array( nV * 3 ), N = new Float32Array( nV * 3 );
	const U = g.uvs ? new Float32Array( nV * 2 ) : null, A = g.ao ? new Float32Array( nV ) : null;
	for ( let d = 0; d < nV; d ++ ) {

		const s = keepList[ d ];
		P.set( g.positions.subarray( s * 3, s * 3 + 3 ), d * 3 );
		N.set( g.normals.subarray( s * 3, s * 3 + 3 ), d * 3 );
		if ( U ) U.set( g.uvs.subarray( s * 2, s * 2 + 2 ), d * 2 );
		if ( A ) A[ d ] = g.ao[ s ];

	}

	const idx = [];
	for ( let t = 0; t < g.indices.length; t += 3 ) {

		const a = remap[ g.indices[ t ] ], b = remap[ g.indices[ t + 1 ] ], c = remap[ g.indices[ t + 2 ] ];
		if ( a === b || b === c || a === c ) continue;
		idx.push( a, b, c );

	}

	return { positions: P, normals: N, uvs: U, ao: A, indices: Uint32Array.from( idx ) };

}

// ---------------------------------------------------------------------------------------------------------------------
// BVH (median split) + any-hit ray queries, used for baking per-vertex ambient occlusion.
// ---------------------------------------------------------------------------------------------------------------------

export function buildBVH( geos ) {

	let nT = 0;
	for ( const g of geos ) nT += g.indices.length / 3;
	const tri = new Float32Array( nT * 9 ); // v0, e1, e2
	const cen = new Float32Array( nT * 3 );
	const tmin = new Float32Array( nT * 3 ), tmax = new Float32Array( nT * 3 );
	let t = 0;
	for ( const g of geos ) {

		const P = g.positions, I = g.indices;
		for ( let i = 0; i < I.length; i += 3, t ++ ) {

			const a = I[ i ] * 3, b = I[ i + 1 ] * 3, c = I[ i + 2 ] * 3;
			for ( let k = 0; k < 3; k ++ ) {

				const va = P[ a + k ], vb = P[ b + k ], vc = P[ c + k ];
				tri[ t * 9 + k ] = va; tri[ t * 9 + 3 + k ] = vb - va; tri[ t * 9 + 6 + k ] = vc - va;
				cen[ t * 3 + k ] = ( va + vb + vc ) / 3;
				tmin[ t * 3 + k ] = Math.min( va, vb, vc ); tmax[ t * 3 + k ] = Math.max( va, vb, vc );

			}

		}

	}

	const order = new Uint32Array( nT );
	for ( let i = 0; i < nT; i ++ ) order[ i ] = i;
	const maxNodes = Math.max( 2 * nT, 2 );
	const bb = new Float32Array( maxNodes * 6 );
	const left = new Int32Array( maxNodes ), right = new Int32Array( maxNodes ), start = new Int32Array( maxNodes ), count = new Int32Array( maxNodes );
	let nNodes = 0;
	const LEAF = 4;

	function build( s, e ) {

		const id = nNodes ++;
		let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = - Infinity, y1 = - Infinity, z1 = - Infinity;
		let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = - Infinity, cy1 = - Infinity, cz1 = - Infinity;
		for ( let i = s; i < e; i ++ ) {

			const q = order[ i ] * 3;
			if ( tmin[ q ] < x0 ) x0 = tmin[ q ]; if ( tmin[ q + 1 ] < y0 ) y0 = tmin[ q + 1 ]; if ( tmin[ q + 2 ] < z0 ) z0 = tmin[ q + 2 ];
			if ( tmax[ q ] > x1 ) x1 = tmax[ q ]; if ( tmax[ q + 1 ] > y1 ) y1 = tmax[ q + 1 ]; if ( tmax[ q + 2 ] > z1 ) z1 = tmax[ q + 2 ];
			if ( cen[ q ] < cx0 ) cx0 = cen[ q ]; if ( cen[ q + 1 ] < cy0 ) cy0 = cen[ q + 1 ]; if ( cen[ q + 2 ] < cz0 ) cz0 = cen[ q + 2 ];
			if ( cen[ q ] > cx1 ) cx1 = cen[ q ]; if ( cen[ q + 1 ] > cy1 ) cy1 = cen[ q + 1 ]; if ( cen[ q + 2 ] > cz1 ) cz1 = cen[ q + 2 ];

		}

		bb.set( [ x0, y0, z0, x1, y1, z1 ], id * 6 );
		const n = e - s;
		if ( n <= LEAF ) { left[ id ] = - 1; start[ id ] = s; count[ id ] = n; return id; }
		const dx = cx1 - cx0, dy = cy1 - cy0, dz = cz1 - cz0;
		const axis = dx >= dy && dx >= dz ? 0 : ( dy >= dz ? 1 : 2 );
		const mid = ( [ cx0, cy0, cz0 ][ axis ] + [ cx1, cy1, cz1 ][ axis ] ) / 2;
		let i = s, j = e - 1;
		while ( i <= j ) {

			if ( cen[ order[ i ] * 3 + axis ] < mid ) i ++;
			else { const tmp = order[ i ]; order[ i ] = order[ j ]; order[ j ] = tmp; j --; }

		}

		let m = i;
		if ( m === s || m === e ) m = ( s + e ) >> 1;
		left[ id ] = build( s, m );
		right[ id ] = build( m, e );
		return id;

	}

	build( 0, nT );
	return { tri, order, bb, left, right, start, count, nNodes, nT };

}

const _stack = new Int32Array( 128 );

// true if the ray (o + t d, t in (tmin, tmax)) hits any triangle (double sided)
export function occluded( bvh, ox, oy, oz, dx, dy, dz, tmin, tmax ) {

	const { tri, order, bb, left, right, start, count } = bvh;
	const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
	let sp = 0;
	_stack[ sp ++ ] = 0;
	while ( sp > 0 ) {

		const id = _stack[ -- sp ];
		const b = id * 6;
		let t0 = ( bb[ b ] - ox ) * ix, t1 = ( bb[ b + 3 ] - ox ) * ix;
		let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
		t0 = ( bb[ b + 1 ] - oy ) * iy; t1 = ( bb[ b + 4 ] - oy ) * iy;
		let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
		if ( a > lo ) lo = a; if ( c < hi ) hi = c;
		t0 = ( bb[ b + 2 ] - oz ) * iz; t1 = ( bb[ b + 5 ] - oz ) * iz;
		a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0;
		if ( a > lo ) lo = a; if ( c < hi ) hi = c;
		if ( hi < lo || hi < tmin || lo > tmax ) continue;
		if ( left[ id ] < 0 ) {

			const s = start[ id ], e = s + count[ id ];
			for ( let i = s; i < e; i ++ ) {

				const q = order[ i ] * 9;
				const e1x = tri[ q + 3 ], e1y = tri[ q + 4 ], e1z = tri[ q + 5 ], e2x = tri[ q + 6 ], e2y = tri[ q + 7 ], e2z = tri[ q + 8 ];
				const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
				const det = e1x * px + e1y * py + e1z * pz;
				if ( det > - 1e-12 && det < 1e-12 ) continue;
				const inv = 1 / det;
				const tx = ox - tri[ q ], ty = oy - tri[ q + 1 ], tz = oz - tri[ q + 2 ];
				const u = ( tx * px + ty * py + tz * pz ) * inv;
				if ( u < 0 || u > 1 ) continue;
				const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
				const v = ( dx * qx + dy * qy + dz * qz ) * inv;
				if ( v < 0 || u + v > 1 ) continue;
				const tt = ( e2x * qx + e2y * qy + e2z * qz ) * inv;
				if ( tt > tmin && tt < tmax ) return true;

			}

		} else {

			_stack[ sp ++ ] = left[ id ];
			_stack[ sp ++ ] = right[ id ];

		}

	}

	return false;

}

// cosine-weighted hemisphere directions (Fibonacci spiral), z = up
export function hemisphereSamples( n ) {

	const out = new Float32Array( n * 3 );
	const ga = Math.PI * ( 3 - Math.sqrt( 5 ) );
	for ( let i = 0; i < n; i ++ ) {

		const u = ( i + 0.5 ) / n;
		const r = Math.sqrt( u ), phi = i * ga;
		out[ i * 3 ] = r * Math.cos( phi ); out[ i * 3 + 1 ] = r * Math.sin( phi ); out[ i * 3 + 2 ] = Math.sqrt( 1 - u );

	}

	return out;

}

// Per-vertex sky visibility in [0,1] (1 = unoccluded). `cache` (Map) is optional and keyed by quantised position+normal.
export function bakeAO( geo, bvh, { samples = 64, maxDist = 4, bias = 0.003, cache = null, offset = [ 0, 0, 0 ] } = {} ) {

	const dirs = hemisphereSamples( samples );
	const n = geo.positions.length / 3;
	const ao = new Float32Array( n );
	const P = geo.positions, N = geo.normals;
	let computed = 0;
	for ( let i = 0; i < n; i ++ ) {

		const px = P[ i * 3 ] + offset[ 0 ], py = P[ i * 3 + 1 ] + offset[ 1 ], pz = P[ i * 3 + 2 ] + offset[ 2 ];
		const nx = N[ i * 3 ], ny = N[ i * 3 + 1 ], nz = N[ i * 3 + 2 ];
		let key = null;
		if ( cache ) {

			key = Math.round( px * 2e4 ) + ',' + Math.round( py * 2e4 ) + ',' + Math.round( pz * 2e4 ) + '|' + Math.round( nx * 200 ) + ',' + Math.round( ny * 200 ) + ',' + Math.round( nz * 200 );
			const c = cache.get( key );
			if ( c !== undefined ) { ao[ i ] = c; continue; }

		}

		// orthonormal basis (Duff et al.)
		const sgn = nz >= 0 ? 1 : - 1;
		const a = - 1 / ( sgn + nz ), b = nx * ny * a;
		const tx = 1 + sgn * nx * nx * a, ty = sgn * b, tz = - sgn * nx;
		const bx = b, by = sgn + ny * ny * a, bz = - ny;
		const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
		let free = 0;
		for ( let s = 0; s < samples; s ++ ) {

			const sx = dirs[ s * 3 ], sy = dirs[ s * 3 + 1 ], sz = dirs[ s * 3 + 2 ];
			let dx = tx * sx + bx * sy + nx * sz, dy = ty * sx + by * sy + ny * sz, dz = tz * sx + bz * sy + nz * sz;
			if ( dx === 0 ) dx = 1e-9; if ( dy === 0 ) dy = 1e-9; if ( dz === 0 ) dz = 1e-9;
			if ( ! occluded( bvh, ox, oy, oz, dx, dy, dz, 1e-5, maxDist ) ) free ++;

		}

		ao[ i ] = free / samples;
		computed ++;
		if ( cache ) cache.set( key, ao[ i ] );

	}

	return { ao, computed };

}

// ---------------------------------------------------------------------------------------------------------------------
// Lathe around the X axis. profile: [[x, r, v], ...] ordered so that the outward normal is (dr, -dx) (i.e. running from +x
// over the top towards -x for an outward-facing surface). Vertex = (x, r cos(theta), r sin(theta)); uv = (uOf(j/segments), v).
// ---------------------------------------------------------------------------------------------------------------------
export function latheX( profile, segments, { flipU = false, mirrorX = false } = {} ) {

	const m = profile.length;
	const P = [], N = [], U = [], I = [];
	// profile normals (averaged tangent)
	const pn = [];
	for ( let i = 0; i < m; i ++ ) {

		const a = profile[ Math.max( i - 1, 0 ) ], b = profile[ Math.min( i + 1, m - 1 ) ];
		let dx = b[ 0 ] - a[ 0 ], dr = b[ 1 ] - a[ 1 ];
		const l = Math.hypot( dx, dr ) || 1;
		dx /= l; dr /= l;
		pn.push( [ dr, - dx ] );

	}

	const sx = mirrorX ? - 1 : 1;
	for ( let j = 0; j <= segments; j ++ ) {

		const u = j / segments, th = u * Math.PI * 2;
		const c = Math.cos( th ), s = Math.sin( th );
		for ( let i = 0; i < m; i ++ ) {

			const [ x, r, v ] = profile[ i ];
			P.push( sx * x, r * c, r * s );
			N.push( sx * pn[ i ][ 0 ], pn[ i ][ 1 ] * c, pn[ i ][ 1 ] * s );
			U.push( flipU ? 1 - u : u, v );

		}

	}

	for ( let j = 0; j < segments; j ++ ) for ( let i = 0; i < m - 1; i ++ ) {

		const a = j * m + i, b = j * m + i + 1, c = ( j + 1 ) * m + i + 1, d = ( j + 1 ) * m + i;
		I.push( a, b, c, a, c, d );

	}

	const g = { positions: Float32Array.from( P ), normals: Float32Array.from( N ), uvs: Float32Array.from( U ), ao: null, indices: Uint32Array.from( I ) };
	fixWinding( g );
	return g;

}

// Make triangle winding agree with the vertex normals (flips all triangles if the majority disagrees).
export function fixWinding( g ) {

	const P = g.positions, N = g.normals, I = g.indices;
	let agree = 0, disagree = 0;
	for ( let t = 0; t < I.length; t += 3 ) {

		const a = I[ t ] * 3, b = I[ t + 1 ] * 3, c = I[ t + 2 ] * 3;
		const ux = P[ b ] - P[ a ], uy = P[ b + 1 ] - P[ a + 1 ], uz = P[ b + 2 ] - P[ a + 2 ];
		const vx = P[ c ] - P[ a ], vy = P[ c + 1 ] - P[ a + 1 ], vz = P[ c + 2 ] - P[ a + 2 ];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		const d = gx * ( N[ a ] + N[ b ] + N[ c ] ) + gy * ( N[ a + 1 ] + N[ b + 1 ] + N[ c + 1 ] ) + gz * ( N[ a + 2 ] + N[ b + 2 ] + N[ c + 2 ] );
		if ( d >= 0 ) agree ++; else disagree ++;

	}

	if ( disagree > agree ) for ( let t = 0; t < I.length; t += 3 ) { const tmp = I[ t + 1 ]; I[ t + 1 ] = I[ t + 2 ]; I[ t + 2 ] = tmp; }
	return { agree, disagree };

}

// Fraction of triangles whose geometric normal disagrees with the stored vertex normals (diagnostic).
export function windingStats( g ) {

	const P = g.positions, N = g.normals, I = g.indices;
	let agree = 0, disagree = 0;
	for ( let t = 0; t < I.length; t += 3 ) {

		const a = I[ t ] * 3, b = I[ t + 1 ] * 3, c = I[ t + 2 ] * 3;
		const ux = P[ b ] - P[ a ], uy = P[ b + 1 ] - P[ a + 1 ], uz = P[ b + 2 ] - P[ a + 2 ];
		const vx = P[ c ] - P[ a ], vy = P[ c + 1 ] - P[ a + 1 ], vz = P[ c + 2 ] - P[ a + 2 ];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		const d = gx * ( N[ a ] + N[ b ] + N[ c ] ) + gy * ( N[ a + 1 ] + N[ b + 1 ] + N[ c + 1 ] ) + gz * ( N[ a + 2 ] + N[ b + 2 ] + N[ c + 2 ] );
		if ( d >= 0 ) agree ++; else disagree ++;

	}

	return { agree, disagree };

}
