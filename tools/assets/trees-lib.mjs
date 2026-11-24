// Shared helpers for the tree asset pipeline (tools/assets/trees-*.mjs).
// Geometry conventions used everywhere in these tools: metres, Y up (glTF). Blender dumps (Z up) are converted on load.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve( import.meta.dirname, '../..' );
export const SRC = join( ROOT, 'assets-src/trees' );
export const OUT = join( ROOT, 'public/assets/trees' );

// ---------------------------------------------------------------------------------------------------------------
// Blender dump loader (see trees-blender.mjs for the .bin layout). Returns typed arrays, converted to Y-up.
// ---------------------------------------------------------------------------------------------------------------
export function loadDump( id, name ) {

	const base = join( SRC, '_dump', id, name.replace( /[^A-Za-z0-9_.-]/g, '_' ) );
	if ( ! existsSync( base + '.json' ) ) throw new Error( 'missing dump ' + base + '.json' );
	const meta = JSON.parse( readFileSync( base + '.json', 'utf8' ) );
	const buf = readFileSync( base + '.bin' );
	const ab = buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength );
	let off = 0;
	const f32 = ( n ) => {

		const a = new Float32Array( ab, off, n );
		off += n * 4;
		return a;

	};

	const i32 = ( n ) => {

		const a = new Int32Array( ab, off, n );
		off += n * 4;
		return a;

	};

	const nv = meta.vertices, nc = meta.corners, np = meta.polygons;
	const position = f32( nv * 3 );
	const cornerVert = i32( nc );
	const polyStart = i32( np );
	const polyCount = i32( np );
	const polyMat = i32( np );
	const uv = meta.hasUV ? f32( nc * 2 ) : null;
	const normal = f32( nc * 3 );
	const color = meta.hasColor ? f32( nc * 4 ) : null;
	// Z-up -> Y-up : (x, y, z) -> (x, z, -y)
	for ( let i = 0; i < nv; i ++ ) {

		const y = position[ i * 3 + 1 ], z = position[ i * 3 + 2 ];
		position[ i * 3 + 1 ] = z;
		position[ i * 3 + 2 ] = - y;

	}

	for ( let i = 0; i < nc; i ++ ) {

		const y = normal[ i * 3 + 1 ], z = normal[ i * 3 + 2 ];
		normal[ i * 3 + 1 ] = z;
		normal[ i * 3 + 2 ] = - y;

	}

	return { meta, nv, nc, np, position, cornerVert, polyStart, polyCount, polyMat, uv, normal, color };

}

// Union-find --------------------------------------------------------------------------------------------------
export class DSU {

	constructor( n ) {

		this.p = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) this.p[ i ] = i;

	}

	find( a ) {

		const p = this.p;
		while ( p[ a ] !== a ) {

			p[ a ] = p[ p[ a ] ];
			a = p[ a ];

		}

		return a;

	}

	union( a, b ) {

		a = this.find( a );
		b = this.find( b );
		if ( a !== b ) this.p[ b ] = a;

	}

}

// Small linear algebra ----------------------------------------------------------------------------------------
export const v3 = {
	sub: ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ],
	add: ( a, b ) => [ a[ 0 ] + b[ 0 ], a[ 1 ] + b[ 1 ], a[ 2 ] + b[ 2 ] ],
	scale: ( a, s ) => [ a[ 0 ] * s, a[ 1 ] * s, a[ 2 ] * s ],
	dot: ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ],
	cross: ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ],
	len: ( a ) => Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] ),
	norm: ( a ) => {

		const l = Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] ) || 1;
		return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ];

	},
	lerp: ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ],
};

// 3x3 matrices are row-major arrays of 9 numbers.
export const m3 = {
	mulv: ( m, v ) => [
		m[ 0 ] * v[ 0 ] + m[ 1 ] * v[ 1 ] + m[ 2 ] * v[ 2 ],
		m[ 3 ] * v[ 0 ] + m[ 4 ] * v[ 1 ] + m[ 5 ] * v[ 2 ],
		m[ 6 ] * v[ 0 ] + m[ 7 ] * v[ 1 ] + m[ 8 ] * v[ 2 ] ],
	mul: ( a, b ) => {

		const r = new Array( 9 );
		for ( let i = 0; i < 3; i ++ ) for ( let j = 0; j < 3; j ++ ) r[ i * 3 + j ] = a[ i * 3 ] * b[ j ] + a[ i * 3 + 1 ] * b[ 3 + j ] + a[ i * 3 + 2 ] * b[ 6 + j ];
		return r;

	},
	transpose: ( m ) => [ m[ 0 ], m[ 3 ], m[ 6 ], m[ 1 ], m[ 4 ], m[ 7 ], m[ 2 ], m[ 5 ], m[ 8 ] ],
	det: ( m ) => m[ 0 ] * ( m[ 4 ] * m[ 8 ] - m[ 5 ] * m[ 7 ] ) - m[ 1 ] * ( m[ 3 ] * m[ 8 ] - m[ 5 ] * m[ 6 ] ) + m[ 2 ] * ( m[ 3 ] * m[ 7 ] - m[ 4 ] * m[ 6 ] ),
};

// Jacobi eigen-decomposition of a symmetric 3x3 matrix (row-major). Returns { values:[3], vectors:[[3],[3],[3]] }
// sorted by descending eigenvalue; vectors are unit length.
export function eigSym3( a ) {

	const A = [ [ a[ 0 ], a[ 1 ], a[ 2 ] ], [ a[ 3 ], a[ 4 ], a[ 5 ] ], [ a[ 6 ], a[ 7 ], a[ 8 ] ] ];
	const V = [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ];
	for ( let sweep = 0; sweep < 60; sweep ++ ) {

		let offd = Math.abs( A[ 0 ][ 1 ] ) + Math.abs( A[ 0 ][ 2 ] ) + Math.abs( A[ 1 ][ 2 ] );
		if ( offd < 1e-30 ) break;
		for ( let p = 0; p < 2; p ++ ) for ( let q = p + 1; q < 3; q ++ ) {

			if ( Math.abs( A[ p ][ q ] ) < 1e-300 ) continue;
			const theta = ( A[ q ][ q ] - A[ p ][ p ] ) / ( 2 * A[ p ][ q ] );
			const t = Math.sign( theta || 1 ) / ( Math.abs( theta ) + Math.sqrt( theta * theta + 1 ) );
			const c = 1 / Math.sqrt( t * t + 1 ), s = t * c;
			for ( let k = 0; k < 3; k ++ ) {

				const akp = A[ k ][ p ], akq = A[ k ][ q ];
				A[ k ][ p ] = c * akp - s * akq;
				A[ k ][ q ] = s * akp + c * akq;

			}

			for ( let k = 0; k < 3; k ++ ) {

				const apk = A[ p ][ k ], aqk = A[ q ][ k ];
				A[ p ][ k ] = c * apk - s * aqk;
				A[ q ][ k ] = s * apk + c * aqk;

			}

			for ( let k = 0; k < 3; k ++ ) {

				const vkp = V[ k ][ p ], vkq = V[ k ][ q ];
				V[ k ][ p ] = c * vkp - s * vkq;
				V[ k ][ q ] = s * vkp + c * vkq;

			}

		}

	}

	const idx = [ 0, 1, 2 ].sort( ( i, j ) => A[ j ][ j ] - A[ i ][ i ] );
	return {
		values: idx.map( ( i ) => A[ i ][ i ] ),
		vectors: idx.map( ( i ) => v3.norm( [ V[ 0 ][ i ], V[ 1 ][ i ], V[ 2 ][ i ] ] ) ),
	};

}

// Least-squares similarity transform (Umeyama / Horn) mapping points P (array of [x,y,z]) onto Q:  q ~ s * R * p + t.
// Returns { s, R (row-major 3x3), t, rms }.  Uses the polar decomposition of the covariance through eigSym3.
export function fitSimilarity( P, Q ) {

	const n = P.length;
	const cp = [ 0, 0, 0 ], cq = [ 0, 0, 0 ];
	for ( let i = 0; i < n; i ++ ) for ( let k = 0; k < 3; k ++ ) {

		cp[ k ] += P[ i ][ k ] / n;
		cq[ k ] += Q[ i ][ k ] / n;

	}

	// H = sum (q - cq)(p - cp)^T
	const H = new Array( 9 ).fill( 0 );
	let varP = 0;
	for ( let i = 0; i < n; i ++ ) {

		const a = v3.sub( P[ i ], cp ), b = v3.sub( Q[ i ], cq );
		varP += v3.dot( a, a );
		for ( let r = 0; r < 3; r ++ ) for ( let c = 0; c < 3; c ++ ) H[ r * 3 + c ] += b[ r ] * a[ c ];

	}

	// R = H (H^T H)^(-1/2) with reflection handling
	const HtH = m3.mul( m3.transpose( H ), H );
	const e = eigSym3( HtH );
	const sv = e.values.map( ( x ) => Math.sqrt( Math.max( x, 0 ) ) );
	// U = H V S^-1 ; R = U D V^T
	const Vv = e.vectors; // columns
	const U = [];
	for ( let k = 0; k < 3; k ++ ) {

		const hv = m3.mulv( H, Vv[ k ] );
		U.push( sv[ k ] > 1e-12 ? v3.scale( hv, 1 / sv[ k ] ) : null );

	}

	// complete degenerate directions (flat / collinear point sets)
	if ( ! U[ 0 ] ) U[ 0 ] = [ 1, 0, 0 ];
	if ( ! U[ 1 ] ) {

		const t = Math.abs( U[ 0 ][ 0 ] ) < 0.9 ? [ 1, 0, 0 ] : [ 0, 1, 0 ];
		U[ 1 ] = v3.norm( v3.cross( U[ 0 ], t ) );

	}

	let d = 1;
	if ( ! U[ 2 ] ) {

		// planar source: choose the proper rotation
		U[ 2 ] = v3.norm( v3.cross( U[ 0 ], U[ 1 ] ) );
		const vz = v3.cross( Vv[ 0 ], Vv[ 1 ] );
		if ( v3.dot( vz, Vv[ 2 ] ) < 0 ) U[ 2 ] = v3.scale( U[ 2 ], - 1 );

	} else {

		const detU = v3.dot( U[ 0 ], v3.cross( U[ 1 ], U[ 2 ] ) );
		const detV = v3.dot( Vv[ 0 ], v3.cross( Vv[ 1 ], Vv[ 2 ] ) );
		if ( detU * detV < 0 ) d = - 1;

	}

	const R = new Array( 9 ).fill( 0 );
	const D = [ 1, 1, d ];
	for ( let k = 0; k < 3; k ++ ) for ( let r = 0; r < 3; r ++ ) for ( let c = 0; c < 3; c ++ ) R[ r * 3 + c ] += D[ k ] * U[ k ][ r ] * Vv[ k ][ c ];
	const s = varP > 0 ? ( sv[ 0 ] + sv[ 1 ] + d * sv[ 2 ] ) / varP : 1;
	const rc = m3.mulv( R, cp );
	const t = [ cq[ 0 ] - s * rc[ 0 ], cq[ 1 ] - s * rc[ 1 ], cq[ 2 ] - s * rc[ 2 ] ];
	let err = 0;
	for ( let i = 0; i < n; i ++ ) {

		const rp = m3.mulv( R, P[ i ] );
		const dx = s * rp[ 0 ] + t[ 0 ] - Q[ i ][ 0 ], dy = s * rp[ 1 ] + t[ 1 ] - Q[ i ][ 1 ], dz = s * rp[ 2 ] + t[ 2 ] - Q[ i ][ 2 ];
		err += dx * dx + dy * dy + dz * dz;

	}

	return { s, R, t, rms: Math.sqrt( err / n ) };

}

export function applySim( T, p ) {

	const r = m3.mulv( T.R, p );
	return [ T.s * r[ 0 ] + T.t[ 0 ], T.s * r[ 1 ] + T.t[ 1 ], T.s * r[ 2 ] + T.t[ 2 ] ];

}

// Deterministic PRNG (mulberry32)
export function rng( seed ) {

	let a = seed >>> 0;
	return () => {

		a |= 0;
		a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

export const srgbToLinear = ( c ) => ( c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ) );
export const linearToSrgb = ( c ) => ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );
export const hex = ( r, g, b ) => '#' + [ r, g, b ].map( ( x ) => Math.max( 0, Math.min( 255, Math.round( x ) ) ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

// ---------------------------------------------------------------------------------------------------------------
// Instance recovery.
// The artist's LOD1 trees are "realized" geometry-node instances: every twig card of the tree is a verbatim copy of
// one of a few prototype meshes (same polygon order, same per-corner UVs), only moved/rotated/scaled. We find the
// copies by matching the per-corner UV sequence of each prototype against the tree's corner stream, then solve the
// similarity transform prototype -> instance from the vertex positions.
//   tree, protos[i] : loadDump() results.   matIndex : polygon material index of the foliage in the tree.
// Returns [{ proto: index, polyStart, cornerStart, T: {s,R,t,rms} }]
// ---------------------------------------------------------------------------------------------------------------
export function findInstances( tree, protos, matIndex, { uvTol = 3e-5 } = {} ) {

	const order = protos.map( ( p, i ) => i ).sort( ( a, b ) => protos[ b ].nc - protos[ a ].nc ); // longest first
	const protoPts = protos.map( ( p ) => {

		const pts = [];
		for ( let v = 0; v < p.nv; v ++ ) pts.push( [ p.position[ v * 3 ], p.position[ v * 3 + 1 ], p.position[ v * 3 + 2 ] ] );
		return pts;

	} );
	const out = [];
	let unmatched = 0;
	let p = 0;
	while ( p < tree.np ) {

		if ( tree.polyMat[ p ] !== matIndex ) {

			p ++;
			continue;

		}

		const c0 = tree.polyStart[ p ];
		let found = - 1;
		for ( const i of order ) {

			const pr = protos[ i ];
			if ( p + pr.np > tree.np || c0 + pr.nc > tree.nc ) continue;
			if ( tree.polyCount[ p ] !== pr.polyCount[ 0 ] ) continue;
			let ok = true;
			for ( let k = 0; k < pr.nc * 2; k ++ ) if ( Math.abs( tree.uv[ c0 * 2 + k ] - pr.uv[ k ] ) > uvTol ) {

				ok = false;
				break;

			}

			if ( ! ok ) continue;
			for ( let q = 0; q < pr.np; q ++ ) if ( tree.polyCount[ p + q ] !== pr.polyCount[ q ] || tree.polyMat[ p + q ] !== matIndex ) {

				ok = false;
				break;

			}

			if ( ok ) {

				found = i;
				break;

			}

		}

		if ( found < 0 ) {

			unmatched ++;
			p ++;
			continue;

		}

		const pr = protos[ found ];
		// vertex correspondence through corners
		const Q = new Array( pr.nv ).fill( null );
		for ( let k = 0; k < pr.nc; k ++ ) {

			const pv = pr.cornerVert[ k ], tv = tree.cornerVert[ c0 + k ];
			if ( ! Q[ pv ] ) Q[ pv ] = [ tree.position[ tv * 3 ], tree.position[ tv * 3 + 1 ], tree.position[ tv * 3 + 2 ] ];

		}

		const P2 = [], Q2 = [];
		for ( let v = 0; v < pr.nv; v ++ ) if ( Q[ v ] ) {

			P2.push( protoPts[ found ][ v ] );
			Q2.push( Q[ v ] );

		}

		const T = fitSimilarity( P2, Q2 );
		out.push( { proto: found, polyStart: p, cornerStart: c0, T } );
		p += pr.np;

	}

	out.unmatchedPolys = unmatched;
	return out;

}

// Triangulate the polygons of a dump (fan). Returns { cornerTri: Int32Array (3 corner indices per triangle), polyOfTri }.
export function triangulate( d, filter = null ) {

	const tri = [], polyOfTri = [];
	for ( let p = 0; p < d.np; p ++ ) {

		if ( filter && ! filter( p ) ) continue;
		const s = d.polyStart[ p ], n = d.polyCount[ p ];
		for ( let k = 1; k < n - 1; k ++ ) {

			tri.push( s, s + k, s + k + 1 );
			polyOfTri.push( p );

		}

	}

	return { cornerTri: Int32Array.from( tri ), polyOfTri: Int32Array.from( polyOfTri ) };

}
