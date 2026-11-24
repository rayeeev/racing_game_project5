// Geometry helpers for the tree pipeline: mesh builder, card fitting, tubes, AO grid, value noise, GLB writer.
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP, KHRMeshQuantization, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { reorder, quantize, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { v3, m3, eigSym3 } from './trees-lib.mjs';

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

// ---------------------------------------------------------------------------------------------------------------
// One primitive under construction (one material of one LOD node).
// ---------------------------------------------------------------------------------------------------------------
export class MeshBuilder {

	constructor() {

		this.pos = [];
		this.nor = [];
		this.uv = [];
		this.col = [];
		this.idx = [];

	}

	get vertexCount() {

		return this.pos.length / 3;

	}

	get triangleCount() {

		return this.idx.length / 3;

	}

	addVertex( p, n, uv, c = [ 1, 1, 1 ] ) {

		const i = this.pos.length / 3;
		this.pos.push( p[ 0 ], p[ 1 ], p[ 2 ] );
		this.nor.push( n[ 0 ], n[ 1 ], n[ 2 ] );
		this.uv.push( uv[ 0 ], uv[ 1 ] );
		this.col.push( c[ 0 ], c[ 1 ], c[ 2 ] );
		return i;

	}

	addTri( a, b, c ) {

		this.idx.push( a, b, c );

	}

	append( other ) {

		const base = this.vertexCount;
		for ( const x of other.pos ) this.pos.push( x );
		for ( const x of other.nor ) this.nor.push( x );
		for ( const x of other.uv ) this.uv.push( x );
		for ( const x of other.col ) this.col.push( x );
		for ( const x of other.idx ) this.idx.push( x + base );

	}

	bounds() {

		const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
		for ( let i = 0; i < this.pos.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) {

			if ( this.pos[ i + k ] < min[ k ] ) min[ k ] = this.pos[ i + k ];
			if ( this.pos[ i + k ] > max[ k ] ) max[ k ] = this.pos[ i + k ];

		}

		return { min, max };

	}

	translate( t ) {

		for ( let i = 0; i < this.pos.length; i += 3 ) {

			this.pos[ i ] += t[ 0 ];
			this.pos[ i + 1 ] += t[ 1 ];
			this.pos[ i + 2 ] += t[ 2 ];

		}

	}

}

// ---------------------------------------------------------------------------------------------------------------
// Smooth 3D value noise in [0,1] (2 octaves) - stands in for Blender's noise texture that tints the needles.
// ---------------------------------------------------------------------------------------------------------------
function hash3( x, y, z, seed ) {

	let h = Math.imul( x, 374761393 ) ^ Math.imul( y, 668265263 ) ^ Math.imul( z, 2147483647 ) ^ Math.imul( seed, 1274126177 );
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	h ^= h >>> 16;
	return ( h >>> 0 ) / 4294967296;

}

function vnoise( x, y, z, seed ) {

	const xi = Math.floor( x ), yi = Math.floor( y ), zi = Math.floor( z );
	const f = ( t ) => t * t * ( 3 - 2 * t );
	const fx = f( x - xi ), fy = f( y - yi ), fz = f( z - zi );
	let r = 0;
	for ( let dz = 0; dz < 2; dz ++ ) for ( let dy = 0; dy < 2; dy ++ ) for ( let dx = 0; dx < 2; dx ++ ) {

		const w = ( dx ? fx : 1 - fx ) * ( dy ? fy : 1 - fy ) * ( dz ? fz : 1 - fz );
		r += w * hash3( xi + dx, yi + dy, zi + dz, seed );

	}

	return r;

}

export function noise3( p, scale = 1, seed = 1 ) {

	const a = vnoise( p[ 0 ] * scale, p[ 1 ] * scale, p[ 2 ] * scale, seed );
	const b = vnoise( p[ 0 ] * scale * 2.03 + 17.1, p[ 1 ] * scale * 2.03 - 3.7, p[ 2 ] * scale * 2.03 + 9.2, seed + 7 );
	return ( a * 2 + b ) / 3;

}

// ---------------------------------------------------------------------------------------------------------------
// Least squares fit of a smooth "bent card" surface P(u,v) through scattered samples.
// basis: [1, u, v, v^2] (+ u^2 when cross = true).  samples: [{ uv:[u,v], p:[x,y,z] }], uv normalised to -1..1.
// ---------------------------------------------------------------------------------------------------------------
export function fitSurface( samples, cross = false, bend = true ) {

	const nb = ( bend ? 4 : 3 ) + ( cross ? 1 : 0 );
	const basis = ( u, v ) => {

		const b = [ 1, u, v ];
		if ( bend ) b.push( v * v );
		if ( cross ) b.push( u * u );
		return b;

	};
	const A = Array.from( { length: nb }, () => new Array( nb ).fill( 0 ) );
	const B = Array.from( { length: nb }, () => [ 0, 0, 0 ] );
	for ( const s of samples ) {

		const b = basis( s.uv[ 0 ], s.uv[ 1 ] );
		const w = s.w ?? 1;
		for ( let i = 0; i < nb; i ++ ) {

			for ( let j = 0; j < nb; j ++ ) A[ i ][ j ] += w * b[ i ] * b[ j ];
			for ( let k = 0; k < 3; k ++ ) B[ i ][ k ] += w * b[ i ] * s.p[ k ];

		}

	}

	for ( let i = 0; i < nb; i ++ ) A[ i ][ i ] += 1e-9;
	// Gauss-Jordan
	for ( let i = 0; i < nb; i ++ ) {

		let piv = i;
		for ( let r = i + 1; r < nb; r ++ ) if ( Math.abs( A[ r ][ i ] ) > Math.abs( A[ piv ][ i ] ) ) piv = r;
		[ A[ i ], A[ piv ] ] = [ A[ piv ], A[ i ] ];
		[ B[ i ], B[ piv ] ] = [ B[ piv ], B[ i ] ];
		const d = A[ i ][ i ];
		for ( let j = 0; j < nb; j ++ ) A[ i ][ j ] /= d;
		for ( let k = 0; k < 3; k ++ ) B[ i ][ k ] /= d;
		for ( let r = 0; r < nb; r ++ ) {

			if ( r === i ) continue;
			const f = A[ r ][ i ];
			if ( f === 0 ) continue;
			for ( let j = 0; j < nb; j ++ ) A[ r ][ j ] -= f * A[ i ][ j ];
			for ( let k = 0; k < 3; k ++ ) B[ r ][ k ] -= f * B[ i ][ k ];

		}

	}

	const evalP = ( u, v ) => {

		const b = basis( u, v );
		const p = [ 0, 0, 0 ];
		for ( let i = 0; i < nb; i ++ ) for ( let k = 0; k < 3; k ++ ) p[ k ] += b[ i ] * B[ i ][ k ];
		return p;

	};

	const evalN = ( u, v ) => {

		const e = 1e-3;
		const du = v3.sub( evalP( u + e, v ), evalP( u - e, v ) );
		const dv = v3.sub( evalP( u, v + e ), evalP( u, v - e ) );
		return v3.norm( v3.cross( du, dv ) );

	};

	let err = 0;
	for ( const s of samples ) {

		const p = evalP( s.uv[ 0 ], s.uv[ 1 ] );
		err += ( p[ 0 ] - s.p[ 0 ] ) ** 2 + ( p[ 1 ] - s.p[ 1 ] ) ** 2 + ( p[ 2 ] - s.p[ 2 ] ) ** 2;

	}

	return { evalP, evalN, rms: Math.sqrt( err / Math.max( 1, samples.length ) ) };

}

// ---------------------------------------------------------------------------------------------------------------
// Tubes (branches / trunks).  A tube is a list of rings: { c:[x,y,z] centre, r: radius, v: texture v, ao }
// ---------------------------------------------------------------------------------------------------------------
// Split a mesh island that is an open generalised cylinder into rings through BFS levels from one boundary loop.
// verts: array of vertex ids, adjacency: Map(id -> Set(id)), boundary: Set of ids on open edges.
export function ringsFromTube( verts, adjacency, boundaryEdges, getPos ) {

	// boundary loops
	const bAdj = new Map();
	for ( const [ a, b ] of boundaryEdges ) {

		if ( ! bAdj.has( a ) ) bAdj.set( a, [] );
		if ( ! bAdj.has( b ) ) bAdj.set( b, [] );
		bAdj.get( a ).push( b );
		bAdj.get( b ).push( a );

	}

	const seen = new Set();
	const loops = [];
	for ( const s of bAdj.keys() ) {

		if ( seen.has( s ) ) continue;
		const loop = [];
		const stack = [ s ];
		seen.add( s );
		while ( stack.length ) {

			const v = stack.pop();
			loop.push( v );
			for ( const n of bAdj.get( v ) ) if ( ! seen.has( n ) ) {

				seen.add( n );
				stack.push( n );

			}

		}

		loops.push( loop );

	}

	if ( loops.length === 0 ) return null;
	// start from the loop with the largest radius (the attached, thick end)
	const loopInfo = loops.map( ( l ) => {

		const c = [ 0, 0, 0 ];
		for ( const v of l ) {

			const p = getPos( v );
			for ( let k = 0; k < 3; k ++ ) c[ k ] += p[ k ] / l.length;

		}

		let r = 0;
		for ( const v of l ) r += v3.len( v3.sub( getPos( v ), c ) ) / l.length;
		return { l, c, r };

	} );
	loopInfo.sort( ( a, b ) => b.r - a.r );
	const level = new Map();
	let frontier = loopInfo[ 0 ].l.slice();
	for ( const v of frontier ) level.set( v, 0 );
	const rings = [ frontier ];
	while ( frontier.length ) {

		const next = [];
		for ( const v of frontier ) for ( const n of adjacency.get( v ) ) if ( ! level.has( n ) ) {

			level.set( n, rings.length );
			next.push( n );

		}

		if ( next.length ) rings.push( next );
		frontier = next;

	}

	return rings.map( ( ids ) => {

		const c = [ 0, 0, 0 ];
		for ( const v of ids ) {

			const p = getPos( v );
			for ( let k = 0; k < 3; k ++ ) c[ k ] += p[ k ] / ids.length;

		}

		let r = 0;
		for ( const v of ids ) r += v3.len( v3.sub( getPos( v ), c ) ) / ids.length;
		return { c, r, ids, n: ids.length };

	} );

}

// Pick a subset of rings: keep ends and those needed to stay within `tol` (relative to radius / absolute metres) of
// the original centre line and radius profile, never more than maxRings.
export function decimateRings( rings, maxRings, tol = 0.01 ) {

	if ( rings.length <= 2 ) return rings.slice();
	const keep = new Set( [ 0, rings.length - 1 ] );
	const errOf = ( a, b, i ) => {

		// distance of ring i from the segment a-b, plus radius deviation
		const A = rings[ a ].c, B = rings[ b ].c, P = rings[ i ].c;
		const ab = v3.sub( B, A );
		const t = Math.max( 0, Math.min( 1, v3.dot( v3.sub( P, A ), ab ) / Math.max( v3.dot( ab, ab ), 1e-12 ) ) );
		const q = v3.add( A, v3.scale( ab, t ) );
		const rr = rings[ a ].r + ( rings[ b ].r - rings[ a ].r ) * t;
		return v3.len( v3.sub( P, q ) ) + Math.abs( rings[ i ].r - rr );

	};

	for ( ;; ) {

		const ks = [ ...keep ].sort( ( x, y ) => x - y );
		if ( ks.length >= maxRings ) break;
		let worst = - 1, worstErr = tol;
		for ( let s = 0; s < ks.length - 1; s ++ ) for ( let i = ks[ s ] + 1; i < ks[ s + 1 ]; i ++ ) {

			const e = errOf( ks[ s ], ks[ s + 1 ], i );
			if ( e > worstErr ) {

				worstErr = e;
				worst = i;

			}

		}

		if ( worst < 0 ) break;
		keep.add( worst );

	}

	return [ ...keep ].sort( ( x, y ) => x - y ).map( ( i ) => rings[ i ] );

}

// Emit a tube into a MeshBuilder. rings: [{ c, r, uvRow: v (number), sides, col:[r,g,b], pts?: explicit ring points }]
// uvOf(u01, ring) -> [u, v] atlas uv. When two consecutive rings have different side counts they are zipped.
// Each ring gets (sides + 1) vertices (u seam). Frames are parallel transported so the tube does not twist.
export function emitTube( mb, rings, uvOf, { capEnd = false, startFrame = null } = {} ) {

	if ( rings.length < 2 ) return;
	const tangents = rings.map( ( r, i ) => {

		const a = rings[ Math.max( 0, i - 1 ) ].c, b = rings[ Math.min( rings.length - 1, i + 1 ) ].c;
		return v3.norm( v3.sub( b, a ) );

	} );
	let ref = startFrame || ( Math.abs( tangents[ 0 ][ 1 ] ) < 0.9 ? [ 0, 1, 0 ] : [ 1, 0, 0 ] );
	const ringVerts = [];
	for ( let i = 0; i < rings.length; i ++ ) {

		const t = tangents[ i ];
		// project the reference onto the plane perpendicular to the tangent (parallel transport)
		let x = v3.sub( ref, v3.scale( t, v3.dot( ref, t ) ) );
		if ( v3.len( x ) < 1e-6 ) x = Math.abs( t[ 1 ] ) < 0.9 ? [ 0, 1, 0 ] : [ 1, 0, 0 ];
		x = v3.norm( x );
		const y = v3.cross( t, x );
		ref = x;
		const ring = rings[ i ];
		const ids = [];
		const S = ring.sides;
		for ( let j = 0; j <= S; j ++ ) {

			const a = ( j / S ) * Math.PI * 2;
			let p, n;
			if ( ring.pts ) {

				p = ring.pts[ j % S ];
				n = v3.norm( v3.sub( p, ring.c ) );

			} else {

				n = v3.add( v3.scale( x, Math.cos( a ) ), v3.scale( y, Math.sin( a ) ) );
				p = v3.add( ring.c, v3.scale( n, ring.r ) );

			}

			ids.push( mb.addVertex( p, n, uvOf( j / S, ring ), ring.col || [ 1, 1, 1 ] ) );

		}

		ringVerts.push( ids );

	}

	for ( let i = 0; i < rings.length - 1; i ++ ) {

		const A = ringVerts[ i ], B = ringVerts[ i + 1 ];
		const na = A.length - 1, nb = B.length - 1;
		// zip two polylines parametrised by u = j / n
		let a = 0, b = 0;
		while ( a < na || b < nb ) {

			const ua = ( a + 1 ) / na, ub = ( b + 1 ) / nb;
			if ( b >= nb || ( a < na && ua <= ub + 1e-9 ) ) {

				mb.addTri( A[ a ], A[ a + 1 ], B[ b ] );
				a ++;

			} else {

				mb.addTri( A[ a ], B[ b + 1 ], B[ b ] );
				b ++;

			}

		}

	}

	if ( capEnd ) {

		const last = rings[ rings.length - 1 ];
		const ids = ringVerts[ ringVerts.length - 1 ];
		const tip = mb.addVertex( v3.add( last.c, v3.scale( tangents[ tangents.length - 1 ], last.r * 0.6 ) ), tangents[ tangents.length - 1 ], uvOf( 0.5, last ), last.col || [ 1, 1, 1 ] );
		for ( let j = 0; j < ids.length - 1; j ++ ) mb.addTri( ids[ j ], ids[ j + 1 ], tip );

	}

}

// ---------------------------------------------------------------------------------------------------------------
// Sky visibility ("crown AO") from a voxel grid of foliage density.
// ---------------------------------------------------------------------------------------------------------------
export class DensityGrid {

	constructor( min, max, voxel ) {

		this.voxel = voxel;
		this.min = min.map( ( x ) => x - voxel * 1.5 );
		this.n = max.map( ( x, k ) => Math.max( 1, Math.ceil( ( x + voxel * 1.5 - this.min[ k ] ) / voxel ) ) );
		this.d = new Float32Array( this.n[ 0 ] * this.n[ 1 ] * this.n[ 2 ] );
		// ray directions: stratified over the upper hemisphere, cosine weighted
		this.dirs = [];
		const N = 6, M = 5;
		for ( let i = 0; i < N * M; i ++ ) {

			const u = ( ( i % N ) + 0.5 ) / N, w = ( Math.floor( i / N ) + 0.5 ) / M;
			const phi = 2 * Math.PI * ( u + 0.37 * Math.floor( i / N ) );
			const cosT = Math.sqrt( 1 - w * 0.94 ); // cosine-weighted, slightly reaching towards the horizon
			const sinT = Math.sqrt( 1 - cosT * cosT );
			this.dirs.push( [ Math.cos( phi ) * sinT, cosT, Math.sin( phi ) * sinT ] );

		}

	}

	// one-sided area (m^2) * coverage splatted at p
	add( p, area ) {

		const i = Math.floor( ( p[ 0 ] - this.min[ 0 ] ) / this.voxel ), j = Math.floor( ( p[ 1 ] - this.min[ 1 ] ) / this.voxel ), k = Math.floor( ( p[ 2 ] - this.min[ 2 ] ) / this.voxel );
		if ( i < 0 || j < 0 || k < 0 || i >= this.n[ 0 ] || j >= this.n[ 1 ] || k >= this.n[ 2 ] ) return;
		this.d[ ( k * this.n[ 1 ] + j ) * this.n[ 0 ] + i ] += area;

	}

	finalize() {

		// area -> extinction coefficient (randomly oriented flat elements project half their area), light blur
		const vol = this.voxel ** 3;
		const [ nx, ny, nz ] = this.n;
		const src = this.d, dst = new Float32Array( src.length );
		for ( let k = 0; k < nz; k ++ ) for ( let j = 0; j < ny; j ++ ) for ( let i = 0; i < nx; i ++ ) {

			let s = 0, w = 0;
			for ( let dk = - 1; dk <= 1; dk ++ ) for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

				const ii = i + di, jj = j + dj, kk = k + dk;
				if ( ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz ) continue;
				const wt = di === 0 && dj === 0 && dk === 0 ? 4 : 1;
				s += wt * src[ ( kk * ny + jj ) * nx + ii ];
				w += wt;

			}

			dst[ ( k * ny + j ) * nx + i ] = 0.5 * ( s / w ) / vol;

		}

		this.d = dst;

	}

	sample( p ) {

		const i = Math.floor( ( p[ 0 ] - this.min[ 0 ] ) / this.voxel ), j = Math.floor( ( p[ 1 ] - this.min[ 1 ] ) / this.voxel ), k = Math.floor( ( p[ 2 ] - this.min[ 2 ] ) / this.voxel );
		if ( i < 0 || j < 0 || k < 0 || i >= this.n[ 0 ] || j >= this.n[ 1 ] || k >= this.n[ 2 ] ) return - 1;
		return this.d[ ( k * this.n[ 1 ] + j ) * this.n[ 0 ] + i ];

	}

	// mean transmittance towards the sky, 0 (buried) .. 1 (open)
	visibility( p ) {

		const step = this.voxel * 0.75;
		let acc = 0;
		for ( const d of this.dirs ) {

			let tau = 0;
			const q = [ p[ 0 ] + d[ 0 ] * step * 0.6, p[ 1 ] + d[ 1 ] * step * 0.6, p[ 2 ] + d[ 2 ] * step * 0.6 ];
			if ( this.sample( q ) < 0 ) {

				// start outside the grid (e.g. a trunk base far below the crown): jump to the entry point, if any
				let t0 = 0, t1 = Infinity;
				for ( let k = 0; k < 3; k ++ ) {

					const lo = this.min[ k ], hi = this.min[ k ] + this.n[ k ] * this.voxel;
					if ( Math.abs( d[ k ] ) < 1e-9 ) {

						if ( q[ k ] < lo || q[ k ] > hi ) t1 = - 1;
						continue;

					}

					let a = ( lo - q[ k ] ) / d[ k ], b = ( hi - q[ k ] ) / d[ k ];
					if ( a > b ) [ a, b ] = [ b, a ];
					t0 = Math.max( t0, a );
					t1 = Math.min( t1, b );

				}

				if ( t1 < t0 ) {

					acc += 1;
					continue;

				}

				const tt = t0 + step * 0.01;
				q[ 0 ] += d[ 0 ] * tt;
				q[ 1 ] += d[ 1 ] * tt;
				q[ 2 ] += d[ 2 ] * tt;

			}

			for ( let s = 0; s < 400; s ++ ) {

				const dens = this.sample( q );
				if ( dens < 0 ) break;
				tau += dens * step;
				if ( tau > 6 ) break;
				q[ 0 ] += d[ 0 ] * step;
				q[ 1 ] += d[ 1 ] * step;
				q[ 2 ] += d[ 2 ] * step;

			}

			acc += Math.exp( - tau );

		}

		return acc / this.dirs.length;

	}

}

// ---------------------------------------------------------------------------------------------------------------
// Simplification of a solid textured mesh with meshoptimizer (keeps UV seams, optional locked vertices).
// mesh: { pos: Float32Array(n*3), nor: Float32Array(n*3), uv: Float32Array(n*2), idx: Uint32Array, lock?: Uint8Array }
// ---------------------------------------------------------------------------------------------------------------
export function simplifyMesh( mesh, targetTriangles, { error = 0.05, uvWeight = 0.5, normalWeight = 0.3, lockBorder = false } = {} ) {

	const n = mesh.pos.length / 3;
	const attrs = new Float32Array( n * 5 );
	for ( let i = 0; i < n; i ++ ) {

		attrs[ i * 5 ] = mesh.nor[ i * 3 ];
		attrs[ i * 5 + 1 ] = mesh.nor[ i * 3 + 1 ];
		attrs[ i * 5 + 2 ] = mesh.nor[ i * 3 + 2 ];
		attrs[ i * 5 + 3 ] = mesh.uv[ i * 2 ];
		attrs[ i * 5 + 4 ] = mesh.uv[ i * 2 + 1 ];

	}

	const flags = lockBorder ? [ 'LockBorder' ] : [];
	const [ idx, err ] = MeshoptSimplifier.simplifyWithAttributes(
		mesh.idx, mesh.pos, 3, attrs, 5, [ normalWeight, normalWeight, normalWeight, uvWeight, uvWeight ],
		mesh.lock || null, Math.max( 3, Math.floor( targetTriangles ) * 3 ), error, flags );
	return { idx, err };

}

// Compact a mesh to the vertices its index buffer references.
export function compactMesh( mesh, idx ) {

	const n = mesh.pos.length / 3;
	const remap = new Int32Array( n ).fill( - 1 );
	let m = 0;
	for ( const i of idx ) if ( remap[ i ] < 0 ) remap[ i ] = m ++;
	const out = { pos: new Float32Array( m * 3 ), nor: new Float32Array( m * 3 ), uv: new Float32Array( m * 2 ), idx: new Uint32Array( idx.length ) };
	if ( mesh.col ) out.col = new Float32Array( m * 3 );
	for ( let i = 0; i < n; i ++ ) {

		const j = remap[ i ];
		if ( j < 0 ) continue;
		for ( let k = 0; k < 3; k ++ ) {

			out.pos[ j * 3 + k ] = mesh.pos[ i * 3 + k ];
			out.nor[ j * 3 + k ] = mesh.nor[ i * 3 + k ];
			if ( mesh.col ) out.col[ j * 3 + k ] = mesh.col[ i * 3 + k ];

		}

		out.uv[ j * 2 ] = mesh.uv[ i * 2 ];
		out.uv[ j * 2 + 1 ] = mesh.uv[ i * 2 + 1 ];

	}

	for ( let i = 0; i < idx.length; i ++ ) out.idx[ i ] = remap[ idx[ i ] ];
	return out;

}

// ---------------------------------------------------------------------------------------------------------------
// GLB writer.
// variants: [{ name, lods: [ { parts: [ { material: 'name', mb: MeshBuilder } ] } ] }]
// materials: { name: { baseColor: Buffer, baseColorMime, normal, normalMime, orm, ormMime, alphaMode, alphaCutoff, doubleSided, roughness } }
// ---------------------------------------------------------------------------------------------------------------
export async function writeGLB( file, variants, materials, { quantizeTexcoord = 14 } = {} ) {

	await MeshoptEncoder.ready;
	const doc = new Document();
	doc.createExtension( EXTTextureWebP ).setRequired( true );
	const buffer = doc.createBuffer();
	const scene = doc.createScene( 'Scene' );
	const mats = {};
	for ( const [ name, m ] of Object.entries( materials ) ) {

		const mat = doc.createMaterial( name ).setMetallicFactor( m.metallic ?? 0 ).setRoughnessFactor( m.roughness ?? 1 ).setDoubleSided( !! m.doubleSided );
		if ( m.baseColorFactor ) mat.setBaseColorFactor( m.baseColorFactor );
		if ( m.alphaMode === 'MASK' ) mat.setAlphaMode( 'MASK' ).setAlphaCutoff( m.alphaCutoff ?? 0.5 );
		if ( m.baseColor ) mat.setBaseColorTexture( doc.createTexture( name + '_baseColor' ).setMimeType( m.baseColorMime ).setImage( m.baseColor ) );
		if ( m.normal ) {

			mat.setNormalTexture( doc.createTexture( name + '_normal' ).setMimeType( m.normalMime ).setImage( m.normal ) );
			if ( m.normalScale !== undefined ) mat.setNormalScale( m.normalScale );

		}

		if ( m.orm ) {

			const t = doc.createTexture( name + '_orm' ).setMimeType( m.ormMime ).setImage( m.orm );
			mat.setOcclusionTexture( t ).setMetallicRoughnessTexture( t );
			if ( m.occlusionStrength !== undefined ) mat.setOcclusionStrength( m.occlusionStrength );

		}

		mats[ name ] = mat;

	}

	for ( const v of variants ) {

		v.lods.forEach( ( lod, li ) => {

			const mesh = doc.createMesh( `${v.name}_LOD${li}` );
			for ( const part of lod.parts ) {

				const mb = part.mb;
				if ( mb.triangleCount === 0 ) continue;
				const nv = mb.vertexCount;
				const col = new Uint8Array( nv * 4 );
				for ( let i = 0; i < nv; i ++ ) {

					for ( let k = 0; k < 3; k ++ ) col[ i * 4 + k ] = Math.max( 0, Math.min( 255, Math.round( mb.col[ i * 3 + k ] * 255 ) ) );
					col[ i * 4 + 3 ] = 255;

				}

				const prim = doc.createPrimitive()
					.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( nv > 65535 ? new Uint32Array( mb.idx ) : new Uint16Array( mb.idx ) ).setBuffer( buffer ) )
					.setAttribute( 'POSITION', doc.createAccessor().setType( 'VEC3' ).setArray( Float32Array.from( mb.pos, ( x ) => Math.round( x * 4096 ) / 4096 ) ).setBuffer( buffer ) )
					.setAttribute( 'NORMAL', doc.createAccessor().setType( 'VEC3' ).setArray( new Float32Array( mb.nor ) ).setBuffer( buffer ) )
					.setAttribute( 'TEXCOORD_0', doc.createAccessor().setType( 'VEC2' ).setArray( new Float32Array( mb.uv ) ).setBuffer( buffer ) )
					.setMaterial( mats[ part.material ] );
				if ( part.vertexColors !== false ) prim.setAttribute( 'COLOR_0', doc.createAccessor().setType( 'VEC4' ).setNormalized( true ).setArray( col ).setBuffer( buffer ) );
				mesh.addPrimitive( prim );

			}

			scene.addChild( doc.createNode( `${v.name}_LOD${li}` ).setMesh( mesh ) );

		} );

	}

	doc.createExtension( KHRMeshQuantization ).setRequired( true );
	doc.createExtension( EXTMeshoptCompression ).setRequired( true ).setEncoderOptions( { method: EXTMeshoptCompression.EncoderMethod.QUANTIZE } );
	await doc.transform(
		dedup(),
		prune(),
		reorder( { encoder: MeshoptEncoder, target: 'size' } ),
		// POSITION stays float32 (snapped to 1/4096 m above): quantising it would put a de-quantisation transform on the
		// LOD nodes, and the asset convention requires identity node transforms. Normals / UVs / colours are quantised.
		quantize( { pattern: /^(NORMAL|TEXCOORD_0|COLOR_0)$/, quantizeNormal: 10, quantizeTexcoord, quantizeColor: 8 } ),
	);
	const io = new NodeIO().registerExtensions( [ EXTTextureWebP, KHRMeshQuantization, EXTMeshoptCompression ] ).registerDependencies( { 'meshopt.encoder': MeshoptEncoder } );
	await io.write( file, doc );

}

export { v3, m3, eigSym3 };
