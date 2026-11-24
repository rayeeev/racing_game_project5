// Shared helpers for the "plants" asset pipeline (ground cover: grass, flowers, ferns, shrubs, debris).
// Pure Node ESM; deps: @gltf-transform/*, meshoptimizer, sharp.  No scripts live in download directories.
//
//   images      loadRGB / loadGray / TexSet (bilinear samplers over 8-bit source maps)
//   geometry    loadSoup (glTF -> local-space triangle soup per node), islandsOf, subMesh, pca3
//   baking      Raster (orthographic software rasteriser with z-buffer, alpha test, normal-map decode)
//               Atlas (float atlas, skyline packing, dilation, WebP export)
//   output      writeGLB (variants x LODs, shared material, meshopt + quantised normals/uvs, float positions)

import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder, dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { resolve } from 'node:path';

export const ROOT = resolve( import.meta.dirname, '../..' );
export const SRC = resolve( ROOT, 'assets-src/plants' );
export const OUT = resolve( ROOT, 'public/assets/plants' );

// ------------------------------------------------------------------ colour helpers

export const SRGB2LIN = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) {

	const c = i / 255;
	SRGB2LIN[ i ] = c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

}

export function lin2srgb( x ) {

	x = x < 0 ? 0 : x > 1 ? 1 : x;
	return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow( x, 1 / 2.4 ) - 0.055;

}

export const lin2srgb8 = ( x ) => Math.round( lin2srgb( x ) * 255 );
export const hex = ( rgbLin ) => '#' + rgbLin.map( ( v ) => lin2srgb8( v ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

// deterministic RNG (mulberry32)
export function rng( seed ) {

	let a = seed >>> 0;
	return () => {

		a |= 0; a = a + 0x6D2B79F5 | 0;
		let t = Math.imul( a ^ a >>> 15, 1 | a );
		t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}

// ------------------------------------------------------------------ images

export async function loadRGB( path, size ) {

	let s = sharp( path ).removeAlpha().toColourspace( 'srgb' );
	if ( size ) s = s.resize( size, size, { kernel: 'lanczos3' } );
	const { data, info } = await s.raw( { depth: 'uchar' } ).toBuffer( { resolveWithObject: true } );
	if ( info.channels !== 3 ) throw new Error( 'expected 3 channels: ' + path );
	return { w: info.width, h: info.height, data: new Uint8Array( data.buffer, data.byteOffset, data.length ) };

}

export async function loadGray( path, size ) {

	let s = sharp( path ).removeAlpha().greyscale().toColourspace( 'b-w' );
	if ( size ) s = s.resize( size, size, { kernel: 'lanczos3' } );
	const { data, info } = await s.raw( { depth: 'uchar' } ).toBuffer( { resolveWithObject: true } );
	if ( info.channels !== 1 ) throw new Error( 'expected 1 channel: ' + path );
	return { w: info.width, h: info.height, data: new Uint8Array( data.buffer, data.byteOffset, data.length ) };

}

/** Source texture set of one Poly Haven asset: diffuse (sRGB), alpha (optional), normal (OpenGL), ARM. All the same size. */
export class TexSet {

	constructor( { diff, alpha = null, nor = null, arm = null, name = '' } ) {

		this.name = name;
		this.w = diff.w; this.h = diff.h;
		this.diff = diff.data;
		this.alpha = alpha ? alpha.data : null;
		this.nor = nor ? nor.data : null;
		this.arm = arm ? arm.data : null;
		for ( const m of [ alpha, nor, arm ] ) if ( m && ( m.w !== this.w || m.h !== this.h ) ) throw new Error( 'TexSet size mismatch ' + name );

	}

	static async load( { diff, alpha, nor, arm, size, name } ) {

		const [ d, a, n, r ] = await Promise.all( [
			loadRGB( diff, size ), alpha ? loadGray( alpha, size ) : null, nor ? loadRGB( nor, size ) : null, arm ? loadRGB( arm, size ) : null,
		] );
		return new TexSet( { diff: d, alpha: a, nor: n, arm: r, name } );

	}

	/** bilinear alpha (0..1) at glTF uv (repeat wrap) */
	alphaAt( u, v ) {

		const a = this.alpha;
		if ( ! a ) return 1;
		const w = this.w, h = this.h;
		let x = u * w - 0.5, y = v * h - 0.5;
		const x0 = Math.floor( x ), y0 = Math.floor( y );
		const fx = x - x0, fy = y - y0;
		const xa = ( ( x0 % w ) + w ) % w, xb = ( xa + 1 ) % w;
		const ya = ( ( y0 % h ) + h ) % h, yb = ( ya + 1 ) % h;
		const r0 = ya * w, r1 = yb * w;
		return ( ( a[ r0 + xa ] * ( 1 - fx ) + a[ r0 + xb ] * fx ) * ( 1 - fy ) + ( a[ r1 + xa ] * ( 1 - fx ) + a[ r1 + xb ] * fx ) * fy ) / 255;

	}

}

// ------------------------------------------------------------------ small linear algebra

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

/** Eigen-decomposition of a symmetric 3x3 matrix given as [xx,xy,xz,yy,yz,zz]. Returns { values:[l0>=l1>=l2], vectors:[v0,v1,v2] }. */
export function eigSym3( m ) {

	const a = [ [ m[ 0 ], m[ 1 ], m[ 2 ] ], [ m[ 1 ], m[ 3 ], m[ 4 ] ], [ m[ 2 ], m[ 4 ], m[ 5 ] ] ];
	const v = [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ];
	for ( let sweep = 0; sweep < 24; sweep ++ ) {

		let off = Math.abs( a[ 0 ][ 1 ] ) + Math.abs( a[ 0 ][ 2 ] ) + Math.abs( a[ 1 ][ 2 ] );
		if ( off < 1e-18 ) break;
		for ( let p = 0; p < 2; p ++ ) for ( let q = p + 1; q < 3; q ++ ) {

			if ( Math.abs( a[ p ][ q ] ) < 1e-30 ) continue;
			const theta = ( a[ q ][ q ] - a[ p ][ p ] ) / ( 2 * a[ p ][ q ] );
			const t = Math.sign( theta || 1 ) / ( Math.abs( theta ) + Math.sqrt( theta * theta + 1 ) );
			const c = 1 / Math.sqrt( t * t + 1 ), s = t * c;
			for ( let k = 0; k < 3; k ++ ) {

				const akp = a[ k ][ p ], akq = a[ k ][ q ];
				a[ k ][ p ] = c * akp - s * akq;
				a[ k ][ q ] = s * akp + c * akq;

			}

			for ( let k = 0; k < 3; k ++ ) {

				const apk = a[ p ][ k ], aqk = a[ q ][ k ];
				a[ p ][ k ] = c * apk - s * aqk;
				a[ q ][ k ] = s * apk + c * aqk;

			}

			for ( let k = 0; k < 3; k ++ ) {

				const vkp = v[ k ][ p ], vkq = v[ k ][ q ];
				v[ k ][ p ] = c * vkp - s * vkq;
				v[ k ][ q ] = s * vkp + c * vkq;

			}

		}

	}

	const order = [ 0, 1, 2 ].sort( ( i, j ) => a[ j ][ j ] - a[ i ][ i ] );
	return {
		values: order.map( ( i ) => a[ i ][ i ] ),
		vectors: order.map( ( i ) => v3.norm( [ v[ 0 ][ i ], v[ 1 ][ i ], v[ 2 ][ i ] ] ) ),
	};

}

/** Weighted moment accumulator (for incremental PCA / plane fits). */
export class Moments {

	constructor() {

		this.w = 0; this.s = [ 0, 0, 0 ]; this.c = [ 0, 0, 0, 0, 0, 0 ];

	}

	add( p, w ) {

		this.w += w;
		this.s[ 0 ] += p[ 0 ] * w; this.s[ 1 ] += p[ 1 ] * w; this.s[ 2 ] += p[ 2 ] * w;
		const c = this.c;
		c[ 0 ] += p[ 0 ] * p[ 0 ] * w; c[ 1 ] += p[ 0 ] * p[ 1 ] * w; c[ 2 ] += p[ 0 ] * p[ 2 ] * w;
		c[ 3 ] += p[ 1 ] * p[ 1 ] * w; c[ 4 ] += p[ 1 ] * p[ 2 ] * w; c[ 5 ] += p[ 2 ] * p[ 2 ] * w;
		return this;

	}

	merge( o ) {

		this.w += o.w;
		for ( let i = 0; i < 3; i ++ ) this.s[ i ] += o.s[ i ];
		for ( let i = 0; i < 6; i ++ ) this.c[ i ] += o.c[ i ];
		return this;

	}

	clone() {

		const m = new Moments();
		m.w = this.w; m.s = [ ...this.s ]; m.c = [ ...this.c ];
		return m;

	}

	/** { mean, values (variances, desc), vectors } */
	pca() {

		const w = this.w || 1e-30;
		const m = [ this.s[ 0 ] / w, this.s[ 1 ] / w, this.s[ 2 ] / w ];
		const c = this.c;
		const cov = [
			c[ 0 ] / w - m[ 0 ] * m[ 0 ], c[ 1 ] / w - m[ 0 ] * m[ 1 ], c[ 2 ] / w - m[ 0 ] * m[ 2 ],
			c[ 3 ] / w - m[ 1 ] * m[ 1 ], c[ 4 ] / w - m[ 1 ] * m[ 2 ], c[ 5 ] / w - m[ 2 ] * m[ 2 ],
		];
		const e = eigSym3( cov );
		return { mean: m, values: e.values.map( ( x ) => Math.max( x, 0 ) ), vectors: e.vectors };

	}

}

// ------------------------------------------------------------------ glTF soup loading

let _io = null;
export async function getIO() {

	if ( _io ) return _io;
	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	_io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );
	return _io;

}

/**
 * Load a glTF and return, per mesh node, its primitives as plain typed arrays in NODE-LOCAL space with the node's
 * rotation/scale applied but its translation removed (Poly Haven lays variants out along X; each node origin is the plant root).
 * mesh = { pos:Float32Array(3n), nrm:Float32Array(3n), uv:Float32Array(2n), idx:Uint32Array(3t), material:string }
 */
export async function loadSoup( path ) {

	const io = await getIO();
	const doc = await io.read( path );
	const out = [];
	for ( const node of doc.getRoot().listNodes() ) {

		const mesh = node.getMesh();
		if ( ! mesh ) continue;
		const wm = node.getWorldMatrix();
		const prims = [];
		for ( const prim of mesh.listPrimitives() ) {

			const P = prim.getAttribute( 'POSITION' ), Nn = prim.getAttribute( 'NORMAL' ), T = prim.getAttribute( 'TEXCOORD_0' );
			const n = P.getCount();
			const pos = new Float32Array( n * 3 ), nrm = new Float32Array( n * 3 ), uv = new Float32Array( n * 2 );
			const e = [ 0, 0, 0 ];
			for ( let i = 0; i < n; i ++ ) {

				P.getElement( i, e );
				const x = e[ 0 ], y = e[ 1 ], z = e[ 2 ];
				pos[ i * 3 ] = wm[ 0 ] * x + wm[ 4 ] * y + wm[ 8 ] * z;
				pos[ i * 3 + 1 ] = wm[ 1 ] * x + wm[ 5 ] * y + wm[ 9 ] * z;
				pos[ i * 3 + 2 ] = wm[ 2 ] * x + wm[ 6 ] * y + wm[ 10 ] * z;
				if ( Nn ) {

					Nn.getElement( i, e );
					const nx = wm[ 0 ] * e[ 0 ] + wm[ 4 ] * e[ 1 ] + wm[ 8 ] * e[ 2 ];
					const ny = wm[ 1 ] * e[ 0 ] + wm[ 5 ] * e[ 1 ] + wm[ 9 ] * e[ 2 ];
					const nz = wm[ 2 ] * e[ 0 ] + wm[ 6 ] * e[ 1 ] + wm[ 10 ] * e[ 2 ];
					const l = Math.hypot( nx, ny, nz ) || 1;
					nrm[ i * 3 ] = nx / l; nrm[ i * 3 + 1 ] = ny / l; nrm[ i * 3 + 2 ] = nz / l;

				}

				if ( T ) {

					T.getElement( i, e );
					uv[ i * 2 ] = e[ 0 ]; uv[ i * 2 + 1 ] = e[ 1 ];

				}

			}

			const I = prim.getIndices();
			const tc = I ? I.getCount() : n;
			const idx = new Uint32Array( tc );
			for ( let i = 0; i < tc; i ++ ) idx[ i ] = I ? I.getScalar( i ) : i;
			prims.push( { pos, nrm, uv, idx, material: prim.getMaterial()?.getName() ?? '' } );

		}

		out.push( { name: node.getName(), translation: node.getTranslation(), prims } );

	}

	return out;

}

/** Connected components of a mesh (vertices welded by position). Returns array of Uint32Array triangle ids. */
export function islandsOf( mesh, weldEps = 1e-5 ) {

	const { pos, idx } = mesh;
	const n = pos.length / 3;
	const key = new Map();
	const remap = new Uint32Array( n );
	const inv = 1 / weldEps;
	for ( let i = 0; i < n; i ++ ) {

		const k = Math.round( pos[ i * 3 ] * inv ) + ',' + Math.round( pos[ i * 3 + 1 ] * inv ) + ',' + Math.round( pos[ i * 3 + 2 ] * inv );
		let j = key.get( k );
		if ( j === undefined ) {

			j = i;
			key.set( k, j );

		}

		remap[ i ] = j;

	}

	const parent = new Uint32Array( n );
	for ( let i = 0; i < n; i ++ ) parent[ i ] = i;
	const find = ( a ) => {

		while ( parent[ a ] !== a ) {

			parent[ a ] = parent[ parent[ a ] ];
			a = parent[ a ];

		}

		return a;

	};
	const tc = idx.length / 3;
	for ( let t = 0; t < tc; t ++ ) {

		const ra = find( remap[ idx[ t * 3 ] ] );
		const rb = find( remap[ idx[ t * 3 + 1 ] ] );
		if ( rb !== ra ) parent[ rb ] = ra;
		const rc = find( remap[ idx[ t * 3 + 2 ] ] );
		if ( rc !== ra ) parent[ rc ] = ra;

	}

	const groups = new Map();
	for ( let t = 0; t < tc; t ++ ) {

		const r = find( remap[ idx[ t * 3 ] ] );
		let g = groups.get( r );
		if ( ! g ) groups.set( r, g = [] );
		g.push( t );

	}

	return [ ...groups.values() ].map( ( g ) => Uint32Array.from( g ) );

}

/** Extract a compact sub-mesh from a list of triangle ids. */
export function subMesh( mesh, tris ) {

	const { pos, nrm, uv, idx } = mesh;
	const map = new Map();
	const p = [], nn = [], t = [], ix = new Uint32Array( tris.length * 3 );
	for ( let k = 0; k < tris.length; k ++ ) for ( let c = 0; c < 3; c ++ ) {

		const vi = idx[ tris[ k ] * 3 + c ];
		let j = map.get( vi );
		if ( j === undefined ) {

			j = map.size;
			map.set( vi, j );
			p.push( pos[ vi * 3 ], pos[ vi * 3 + 1 ], pos[ vi * 3 + 2 ] );
			nn.push( nrm[ vi * 3 ], nrm[ vi * 3 + 1 ], nrm[ vi * 3 + 2 ] );
			t.push( uv[ vi * 2 ], uv[ vi * 2 + 1 ] );

		}

		ix[ k * 3 + c ] = j;

	}

	return { pos: Float32Array.from( p ), nrm: Float32Array.from( nn ), uv: Float32Array.from( t ), idx: ix, material: mesh.material, tex: mesh.tex };

}

/** Concatenate meshes (same tex) into one. */
export function mergeMeshes( list ) {

	let nv = 0, ni = 0;
	for ( const m of list ) {

		nv += m.pos.length / 3; ni += m.idx.length;

	}

	const pos = new Float32Array( nv * 3 ), nrm = new Float32Array( nv * 3 ), uv = new Float32Array( nv * 2 ), idx = new Uint32Array( ni );
	let vo = 0, io = 0;
	for ( const m of list ) {

		pos.set( m.pos, vo * 3 ); nrm.set( m.nrm, vo * 3 ); uv.set( m.uv, vo * 2 );
		for ( let i = 0; i < m.idx.length; i ++ ) idx[ io + i ] = m.idx[ i ] + vo;
		vo += m.pos.length / 3; io += m.idx.length;

	}

	return { pos, nrm, uv, idx, material: list[ 0 ]?.material, tex: list[ 0 ]?.tex };

}

/** Rigid transform copy: rotate about Y by angle, uniform scale, translate. */
export function placeMesh( m, { rotY = 0, scale = 1, tx = 0, ty = 0, tz = 0, mirror = false } = {} ) {

	const c = Math.cos( rotY ), s = Math.sin( rotY );
	const n = m.pos.length / 3;
	const pos = new Float32Array( n * 3 ), nrm = new Float32Array( n * 3 );
	const mx = mirror ? - 1 : 1;
	for ( let i = 0; i < n; i ++ ) {

		const x = m.pos[ i * 3 ] * mx, y = m.pos[ i * 3 + 1 ], z = m.pos[ i * 3 + 2 ];
		pos[ i * 3 ] = ( c * x + s * z ) * scale + tx;
		pos[ i * 3 + 1 ] = y * scale + ty;
		pos[ i * 3 + 2 ] = ( - s * x + c * z ) * scale + tz;
		const nx = m.nrm[ i * 3 ] * mx, ny = m.nrm[ i * 3 + 1 ], nz = m.nrm[ i * 3 + 2 ];
		nrm[ i * 3 ] = c * nx + s * nz;
		nrm[ i * 3 + 1 ] = ny;
		nrm[ i * 3 + 2 ] = - s * nx + c * nz;

	}

	let idx = m.idx;
	if ( mirror ) {

		idx = new Uint32Array( m.idx.length );
		for ( let i = 0; i < idx.length; i += 3 ) {

			idx[ i ] = m.idx[ i ]; idx[ i + 1 ] = m.idx[ i + 2 ]; idx[ i + 2 ] = m.idx[ i + 1 ];

		}

	}

	return { pos, nrm, uv: m.uv, idx, material: m.material, tex: m.tex };

}

export function boundsOf( meshes ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( const m of Array.isArray( meshes ) ? meshes : [ meshes ] ) {

		const p = m.pos;
		for ( let i = 0; i < p.length; i += 3 ) for ( let c = 0; c < 3; c ++ ) {

			if ( p[ i + c ] < min[ c ] ) min[ c ] = p[ i + c ];
			if ( p[ i + c ] > max[ c ] ) max[ c ] = p[ i + c ];

		}

	}

	return { min, max, size: [ max[ 0 ] - min[ 0 ], max[ 1 ] - min[ 1 ], max[ 2 ] - min[ 2 ] ] };

}

export const triCount = ( m ) => m.idx.length / 3;

// ------------------------------------------------------------------ orthographic software rasteriser

/**
 * Card-space rasteriser. Card space: x = right (m), y = up (m), z = towards the viewer (m).
 * frame = { o:[x,y,z] world position of the card's bottom-left corner, u:[..] unit right, v:[..] unit up, n:[..] unit normal (towards viewer) }
 * The raster covers [0,widthM] x [0,heightM]; (w,h) are final pixels; ss = supersampling factor per axis.
 */
export class Raster {

	constructor( w, h, widthM, heightM, ss = 4 ) {

		this.w = w; this.h = h; this.ss = ss;
		this.W = w * ss; this.H = h * ss;
		this.sx = this.W / widthM; this.sy = this.H / heightM;
		this.widthM = widthM; this.heightM = heightM;
		const n = this.W * this.H;
		this.z = new Float32Array( n ).fill( - Infinity );
		this.col = new Float32Array( n * 3 );   // linear albedo
		this.nrm = new Float32Array( n * 3 );   // card-space normal
		this.orm = new Uint8Array( n * 3 );     // ao, rough, metal
		this.cov = new Uint8Array( n );
		this.id = new Int32Array( n ).fill( - 1 );  // user tag of the mesh that won the pixel

	}

	/**
	 * Draw a mesh. opts: { frame, zMin, zMax (clip in card z), alphaCut=0.5, tag=0, tint=[1,1,1] (linear multiplier), flatNormal=false }
	 */
	draw( mesh, frame, opts = {} ) {

		const tex = opts.tex || mesh.tex;
		const { pos, nrm, uv, idx } = mesh;
		const { o, u, v, n } = frame;
		const zMin = opts.zMin ?? - Infinity, zMax = opts.zMax ?? Infinity;
		const alphaCut = opts.alphaCut ?? 0.5;
		const tag = opts.tag ?? 0;
		const tint = opts.tint || null;
		const W = this.W, H = this.H, sx = this.sx, sy = this.sy, heightM = this.heightM;
		const zb = this.z, col = this.col, nb = this.nrm, ob = this.orm, cov = this.cov, idb = this.id;
		const tw = tex.w, th = tex.h, tdiff = tex.diff, talpha = tex.alpha, tnor = tex.nor, tarm = tex.arm;
		const nv = pos.length / 3;
		// transform vertices to card space
		const cp = new Float32Array( nv * 3 ), cn = new Float32Array( nv * 3 );
		for ( let i = 0; i < nv; i ++ ) {

			const x = pos[ i * 3 ] - o[ 0 ], y = pos[ i * 3 + 1 ] - o[ 1 ], z = pos[ i * 3 + 2 ] - o[ 2 ];
			cp[ i * 3 ] = x * u[ 0 ] + y * u[ 1 ] + z * u[ 2 ];
			cp[ i * 3 + 1 ] = x * v[ 0 ] + y * v[ 1 ] + z * v[ 2 ];
			cp[ i * 3 + 2 ] = x * n[ 0 ] + y * n[ 1 ] + z * n[ 2 ];
			const a = nrm[ i * 3 ], b = nrm[ i * 3 + 1 ], c = nrm[ i * 3 + 2 ];
			cn[ i * 3 ] = a * u[ 0 ] + b * u[ 1 ] + c * u[ 2 ];
			cn[ i * 3 + 1 ] = a * v[ 0 ] + b * v[ 1 ] + c * v[ 2 ];
			cn[ i * 3 + 2 ] = a * n[ 0 ] + b * n[ 1 ] + c * n[ 2 ];

		}

		const tc = idx.length / 3;
		for ( let t = 0; t < tc; t ++ ) {

			const i0 = idx[ t * 3 ], i1 = idx[ t * 3 + 1 ], i2 = idx[ t * 3 + 2 ];
			const ax = cp[ i0 * 3 ], ay = cp[ i0 * 3 + 1 ], az = cp[ i0 * 3 + 2 ];
			const bx = cp[ i1 * 3 ], by = cp[ i1 * 3 + 1 ], bz = cp[ i1 * 3 + 2 ];
			const cx = cp[ i2 * 3 ], cy = cp[ i2 * 3 + 1 ], cz = cp[ i2 * 3 + 2 ];
			const zlo = Math.min( az, bz, cz ), zhi = Math.max( az, bz, cz );
			if ( zhi < zMin || zlo > zMax ) continue;
			// pixel-space
			const x0 = ax * sx, y0 = ( heightM - ay ) * sy;
			const x1 = bx * sx, y1 = ( heightM - by ) * sy;
			const x2 = cx * sx, y2 = ( heightM - cy ) * sy;
			let minx = Math.floor( Math.min( x0, x1, x2 ) ), maxx = Math.ceil( Math.max( x0, x1, x2 ) );
			let miny = Math.floor( Math.min( y0, y1, y2 ) ), maxy = Math.ceil( Math.max( y0, y1, y2 ) );
			if ( maxx < 0 || maxy < 0 || minx >= W || miny >= H ) continue;
			if ( minx < 0 ) minx = 0;
			if ( miny < 0 ) miny = 0;
			if ( maxx > W - 1 ) maxx = W - 1;
			if ( maxy > H - 1 ) maxy = H - 1;
			const area = ( x1 - x0 ) * ( y2 - y0 ) - ( x2 - x0 ) * ( y1 - y0 );
			if ( Math.abs( area ) < 1e-10 ) continue;
			const inv = 1 / area;
			const u0 = uv[ i0 * 2 ], v0 = uv[ i0 * 2 + 1 ], u1 = uv[ i1 * 2 ], v1 = uv[ i1 * 2 + 1 ], u2 = uv[ i2 * 2 ], v2 = uv[ i2 * 2 + 1 ];
			// tangent frame (card space). T = dP/du, B = -dP/dv ("image up", OpenGL normal maps as used by glTF/three)
			let Tx = 1, Ty = 0, Tz = 0, Bx = 0, By = 1, Bz = 0, hasTB = false;
			if ( tnor && ! opts.flatNormal ) {

				const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
				const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
				const det = du1 * dv2 - du2 * dv1;
				if ( Math.abs( det ) > 1e-14 ) {

					const r = 1 / det;
					Tx = ( e1x * dv2 - e2x * dv1 ) * r; Ty = ( e1y * dv2 - e2y * dv1 ) * r; Tz = ( e1z * dv2 - e2z * dv1 ) * r;
					Bx = - ( e2x * du1 - e1x * du2 ) * r; By = - ( e2y * du1 - e1y * du2 ) * r; Bz = - ( e2z * du1 - e1z * du2 ) * r;
					const tl = Math.hypot( Tx, Ty, Tz ), bl = Math.hypot( Bx, By, Bz );
					if ( tl > 0 && bl > 0 ) {

						Tx /= tl; Ty /= tl; Tz /= tl; Bx /= bl; By /= bl; Bz /= bl;
						hasTB = true;

					}

				}

			}

			const n0x = cn[ i0 * 3 ], n0y = cn[ i0 * 3 + 1 ], n0z = cn[ i0 * 3 + 2 ];
			const n1x = cn[ i1 * 3 ], n1y = cn[ i1 * 3 + 1 ], n1z = cn[ i1 * 3 + 2 ];
			const n2x = cn[ i2 * 3 ], n2y = cn[ i2 * 3 + 1 ], n2z = cn[ i2 * 3 + 2 ];
			for ( let py = miny; py <= maxy; py ++ ) {

				const sy_ = py + 0.5;
				for ( let px = minx; px <= maxx; px ++ ) {

					const sx_ = px + 0.5;
					const w0 = ( ( x1 - sx_ ) * ( y2 - sy_ ) - ( x2 - sx_ ) * ( y1 - sy_ ) ) * inv;
					if ( w0 < 0 ) continue;
					const w1 = ( ( x2 - sx_ ) * ( y0 - sy_ ) - ( x0 - sx_ ) * ( y2 - sy_ ) ) * inv;
					if ( w1 < 0 ) continue;
					const w2 = 1 - w0 - w1;
					if ( w2 < 0 ) continue;
					const z = w0 * az + w1 * bz + w2 * cz;
					if ( z < zMin || z > zMax ) continue;
					const pi = py * W + px;
					if ( z <= zb[ pi ] ) continue;
					const uu = w0 * u0 + w1 * u1 + w2 * u2, vv = w0 * v0 + w1 * v1 + w2 * v2;
					// bilinear taps
					let fx = uu * tw - 0.5, fy = vv * th - 0.5;
					const xf = Math.floor( fx ), yf = Math.floor( fy );
					fx -= xf; fy -= yf;
					const xa = ( ( xf % tw ) + tw ) % tw, xb = ( xa + 1 ) % tw;
					const ya = ( ( yf % th ) + th ) % th, yb = ( ya + 1 ) % th;
					const k00 = ya * tw + xa, k10 = ya * tw + xb, k01 = yb * tw + xa, k11 = yb * tw + xb;
					const b00 = ( 1 - fx ) * ( 1 - fy ), b10 = fx * ( 1 - fy ), b01 = ( 1 - fx ) * fy, b11 = fx * fy;
					if ( talpha ) {

						const al = ( talpha[ k00 ] * b00 + talpha[ k10 ] * b10 + talpha[ k01 ] * b01 + talpha[ k11 ] * b11 ) / 255;
						if ( al < alphaCut ) continue;

					}

					zb[ pi ] = z;
					cov[ pi ] = 1;
					idb[ pi ] = tag;
					const p3 = pi * 3;
					let r = SRGB2LIN[ tdiff[ k00 * 3 ] ] * b00 + SRGB2LIN[ tdiff[ k10 * 3 ] ] * b10 + SRGB2LIN[ tdiff[ k01 * 3 ] ] * b01 + SRGB2LIN[ tdiff[ k11 * 3 ] ] * b11;
					let g = SRGB2LIN[ tdiff[ k00 * 3 + 1 ] ] * b00 + SRGB2LIN[ tdiff[ k10 * 3 + 1 ] ] * b10 + SRGB2LIN[ tdiff[ k01 * 3 + 1 ] ] * b01 + SRGB2LIN[ tdiff[ k11 * 3 + 1 ] ] * b11;
					let b = SRGB2LIN[ tdiff[ k00 * 3 + 2 ] ] * b00 + SRGB2LIN[ tdiff[ k10 * 3 + 2 ] ] * b10 + SRGB2LIN[ tdiff[ k01 * 3 + 2 ] ] * b01 + SRGB2LIN[ tdiff[ k11 * 3 + 2 ] ] * b11;
					if ( tint ) {

						r *= tint[ 0 ]; g *= tint[ 1 ]; b *= tint[ 2 ];

					}

					col[ p3 ] = r; col[ p3 + 1 ] = g; col[ p3 + 2 ] = b;
					// normal
					let nx = w0 * n0x + w1 * n1x + w2 * n2x, ny = w0 * n0y + w1 * n1y + w2 * n2y, nz = w0 * n0z + w1 * n1z + w2 * n2z;
					let nl = Math.hypot( nx, ny, nz ) || 1;
					nx /= nl; ny /= nl; nz /= nl;
					if ( hasTB ) {

						const mx = ( tnor[ k00 * 3 ] * b00 + tnor[ k10 * 3 ] * b10 + tnor[ k01 * 3 ] * b01 + tnor[ k11 * 3 ] * b11 ) / 127.5 - 1;
						const my = ( tnor[ k00 * 3 + 1 ] * b00 + tnor[ k10 * 3 + 1 ] * b10 + tnor[ k01 * 3 + 1 ] * b01 + tnor[ k11 * 3 + 1 ] * b11 ) / 127.5 - 1;
						const mz = Math.sqrt( Math.max( 0.0, 1 - mx * mx - my * my ) );
						const qx = Tx * mx + Bx * my + nx * mz, qy = Ty * mx + By * my + ny * mz, qz = Tz * mx + Bz * my + nz * mz;
						nl = Math.hypot( qx, qy, qz ) || 1;
						nx = qx / nl; ny = qy / nl; nz = qz / nl;

					}

					if ( nz < 0 ) {

						nx = - nx; ny = - ny; nz = - nz;

					}

					nb[ p3 ] = nx; nb[ p3 + 1 ] = ny; nb[ p3 + 2 ] = nz;
					if ( tarm ) {

						ob[ p3 ] = tarm[ k00 * 3 ] * b00 + tarm[ k10 * 3 ] * b10 + tarm[ k01 * 3 ] * b01 + tarm[ k11 * 3 ] * b11;
						ob[ p3 + 1 ] = tarm[ k00 * 3 + 1 ] * b00 + tarm[ k10 * 3 + 1 ] * b10 + tarm[ k01 * 3 + 1 ] * b01 + tarm[ k11 * 3 + 1 ] * b11;
						ob[ p3 + 2 ] = tarm[ k00 * 3 + 2 ] * b00 + tarm[ k10 * 3 + 2 ] * b10 + tarm[ k01 * 3 + 2 ] * b01 + tarm[ k11 * 3 + 2 ] * b11;

					} else {

						ob[ p3 ] = 255; ob[ p3 + 1 ] = 200; ob[ p3 + 2 ] = 0;

					}

				}

			}

		}

		return this;

	}

	/** Box-filter down to (w,h). Returns { w,h, rgb (linear, avg over covered), a (coverage), nrm (unit), orm (0..1), z (avg over covered, NaN if empty) } */
	resolve() {

		const { w, h, ss, W } = this;
		const n = w * h;
		const rgb = new Float32Array( n * 3 ), a = new Float32Array( n ), nrm = new Float32Array( n * 3 ), orm = new Float32Array( n * 3 ), z = new Float32Array( n );
		const inv = 1 / ( ss * ss );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

			let c = 0, r = 0, g = 0, b = 0, nx = 0, ny = 0, nz = 0, o0 = 0, o1 = 0, o2 = 0, zz = 0;
			for ( let j = 0; j < ss; j ++ ) {

				let pi = ( y * ss + j ) * W + x * ss;
				for ( let i = 0; i < ss; i ++, pi ++ ) {

					if ( ! this.cov[ pi ] ) continue;
					c ++;
					const p3 = pi * 3;
					r += this.col[ p3 ]; g += this.col[ p3 + 1 ]; b += this.col[ p3 + 2 ];
					nx += this.nrm[ p3 ]; ny += this.nrm[ p3 + 1 ]; nz += this.nrm[ p3 + 2 ];
					o0 += this.orm[ p3 ]; o1 += this.orm[ p3 + 1 ]; o2 += this.orm[ p3 + 2 ];
					zz += this.z[ pi ];

				}

			}

			const k = y * w + x;
			a[ k ] = c * inv;
			if ( c > 0 ) {

				rgb[ k * 3 ] = r / c; rgb[ k * 3 + 1 ] = g / c; rgb[ k * 3 + 2 ] = b / c;
				const l = Math.hypot( nx, ny, nz ) || 1;
				nrm[ k * 3 ] = nx / l; nrm[ k * 3 + 1 ] = ny / l; nrm[ k * 3 + 2 ] = nz / l;
				orm[ k * 3 ] = o0 / c / 255; orm[ k * 3 + 1 ] = o1 / c / 255; orm[ k * 3 + 2 ] = o2 / c / 255;
				z[ k ] = zz / c;

			} else {

				nrm[ k * 3 + 2 ] = 1;
				z[ k ] = NaN;

			}

		}

		return { w, h, rgb, a, nrm, orm, z };

	}

}

// ------------------------------------------------------------------ atlas

/** Skyline bottom-left rectangle packer. */
export class SkylinePacker {

	constructor( w, h ) {

		this.w = w; this.h = h;
		this.sky = [ { x: 0, y: 0, w } ];

	}

	_fit( i, rw, rh ) {

		const x = this.sky[ i ].x;
		if ( x + rw > this.w ) return - 1;
		let y = 0, left = rw, k = i;
		while ( left > 0 ) {

			if ( k >= this.sky.length ) return - 1;
			y = Math.max( y, this.sky[ k ].y );
			if ( y + rh > this.h ) return - 1;
			left -= this.sky[ k ].w;
			k ++;

		}

		return y;

	}

	/** returns {x,y} or null */
	add( rw, rh ) {

		let best = - 1, bestY = Infinity, bestW = Infinity;
		for ( let i = 0; i < this.sky.length; i ++ ) {

			const y = this._fit( i, rw, rh );
			if ( y < 0 ) continue;
			if ( y + rh < bestY || ( y + rh === bestY && this.sky[ i ].w < bestW ) ) {

				best = i; bestY = y + rh; bestW = this.sky[ i ].w;

			}

		}

		if ( best < 0 ) return null;
		const x = this.sky[ best ].x, y = bestY - rh;
		const node = { x, y: bestY, w: rw };
		this.sky.splice( best, 0, node );
		for ( let i = best + 1; i < this.sky.length; ) {

			const prev = this.sky[ i - 1 ], cur = this.sky[ i ];
			const overlap = prev.x + prev.w - cur.x;
			if ( overlap <= 0 ) break;
			if ( overlap >= cur.w ) {

				this.sky.splice( i, 1 );

			} else {

				cur.x += overlap; cur.w -= overlap;
				break;

			}

		}

		for ( let i = 0; i < this.sky.length - 1; ) {

			if ( this.sky[ i ].y === this.sky[ i + 1 ].y ) {

				this.sky[ i ].w += this.sky[ i + 1 ].w;
				this.sky.splice( i + 1, 1 );

			} else i ++;

		}

		return { x, y };

	}

}

/** Pack rects [{w,h,...}] (pixels, padding added here) into a WxH atlas; tallest first. Returns false if they do not fit; sets r.x, r.y (top-left, without padding). */
export function packRects( rects, W, H, pad = 2 ) {

	const order = [ ...rects ].sort( ( a, b ) => b.h - a.h || b.w - a.w );
	const packer = new SkylinePacker( W, H );
	for ( const r of order ) {

		const p = packer.add( r.w + pad * 2, r.h + pad * 2 );
		if ( ! p ) return false;
		r.x = p.x + pad; r.y = p.y + pad;

	}

	return true;

}

/** Float atlas with base colour (linear RGB + alpha), normal, ORM. */
export class Atlas {

	constructor( w, h ) {

		this.w = w; this.h = h;
		const n = w * h;
		this.rgb = new Float32Array( n * 3 );
		this.a = new Float32Array( n );
		this.nrm = new Float32Array( n * 3 );
		this.orm = new Float32Array( n * 3 );
		this.filled = new Uint8Array( n );   // texels that carry real colour data (alpha > 0)
		for ( let i = 0; i < n; i ++ ) {

			this.nrm[ i * 3 + 2 ] = 1; this.orm[ i * 3 ] = 1; this.orm[ i * 3 + 1 ] = 0.8;

		}

	}

	/** Copy a resolved raster (see Raster.resolve) to (x,y). */
	blit( r, x, y ) {

		for ( let j = 0; j < r.h; j ++ ) for ( let i = 0; i < r.w; i ++ ) {

			const s = j * r.w + i, d = ( y + j ) * this.w + x + i;
			if ( x + i < 0 || x + i >= this.w || y + j < 0 || y + j >= this.h ) continue;
			this.a[ d ] = r.a[ s ];
			if ( r.a[ s ] > 0 ) {

				this.filled[ d ] = 1;
				for ( let c = 0; c < 3; c ++ ) {

					this.rgb[ d * 3 + c ] = r.rgb[ s * 3 + c ];
					this.nrm[ d * 3 + c ] = r.nrm[ s * 3 + c ];
					this.orm[ d * 3 + c ] = r.orm[ s * 3 + c ];

				}

			}

		}

	}

	/** Bleed colour / normal / orm of filled texels into empty neighbours (so bilinear + mips never pick up black). */
	dilate( passes = 16 ) {

		const { w, h } = this;
		let filled = this.filled;
		for ( let p = 0; p < passes; p ++ ) {

			const next = Uint8Array.from( filled );
			let changed = 0;
			for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

				const k = y * w + x;
				if ( filled[ k ] ) continue;
				let c = 0, r = 0, g = 0, b = 0, nx = 0, ny = 0, nz = 0, o0 = 0, o1 = 0, o2 = 0;
				for ( let dy = - 1; dy <= 1; dy ++ ) {

					const yy = y + dy;
					if ( yy < 0 || yy >= h ) continue;
					for ( let dx = - 1; dx <= 1; dx ++ ) {

						const xx = x + dx;
						if ( xx < 0 || xx >= w ) continue;
						const q = yy * w + xx;
						if ( ! filled[ q ] ) continue;
						const wgt = dx === 0 || dy === 0 ? 2 : 1;
						c += wgt;
						r += this.rgb[ q * 3 ] * wgt; g += this.rgb[ q * 3 + 1 ] * wgt; b += this.rgb[ q * 3 + 2 ] * wgt;
						nx += this.nrm[ q * 3 ] * wgt; ny += this.nrm[ q * 3 + 1 ] * wgt; nz += this.nrm[ q * 3 + 2 ] * wgt;
						o0 += this.orm[ q * 3 ] * wgt; o1 += this.orm[ q * 3 + 1 ] * wgt; o2 += this.orm[ q * 3 + 2 ] * wgt;

					}

				}

				if ( c === 0 ) continue;
				this.rgb[ k * 3 ] = r / c; this.rgb[ k * 3 + 1 ] = g / c; this.rgb[ k * 3 + 2 ] = b / c;
				const l = Math.hypot( nx, ny, nz ) || 1;
				this.nrm[ k * 3 ] = nx / l; this.nrm[ k * 3 + 1 ] = ny / l; this.nrm[ k * 3 + 2 ] = nz / l;
				this.orm[ k * 3 ] = o0 / c; this.orm[ k * 3 + 1 ] = o1 / c; this.orm[ k * 3 + 2 ] = o2 / c;
				next[ k ] = 1;
				changed ++;

			}

			filled = next;
			if ( ! changed ) break;

		}

		// remaining empty texels: global average colour (keeps the lowest mips sane)
		let c = 0, r = 0, g = 0, b = 0, o0 = 0, o1 = 0;
		for ( let k = 0; k < w * h; k ++ ) if ( this.filled[ k ] ) {

			c ++; r += this.rgb[ k * 3 ]; g += this.rgb[ k * 3 + 1 ]; b += this.rgb[ k * 3 + 2 ]; o0 += this.orm[ k * 3 ]; o1 += this.orm[ k * 3 + 1 ];

		}

		if ( c ) for ( let k = 0; k < w * h; k ++ ) if ( ! filled[ k ] ) {

			this.rgb[ k * 3 ] = r / c; this.rgb[ k * 3 + 1 ] = g / c; this.rgb[ k * 3 + 2 ] = b / c;
			this.orm[ k * 3 ] = o0 / c; this.orm[ k * 3 + 1 ] = o1 / c; this.orm[ k * 3 + 2 ] = 0;

		}

		this.dilated = filled;
		return this;

	}

	/** 8-bit buffers: base (RGBA sRGB), normal (RGB), orm (RGB). alphaFn maps coverage -> alpha. */
	toBytes( alphaFn = ( a ) => a ) {

		const n = this.w * this.h;
		const base = Buffer.alloc( n * 4 ), nor = Buffer.alloc( n * 3 ), orm = Buffer.alloc( n * 3 );
		for ( let k = 0; k < n; k ++ ) {

			base[ k * 4 ] = lin2srgb8( this.rgb[ k * 3 ] );
			base[ k * 4 + 1 ] = lin2srgb8( this.rgb[ k * 3 + 1 ] );
			base[ k * 4 + 2 ] = lin2srgb8( this.rgb[ k * 3 + 2 ] );
			base[ k * 4 + 3 ] = Math.round( Math.min( 1, Math.max( 0, alphaFn( this.a[ k ] ) ) ) * 255 );
			for ( let c = 0; c < 3; c ++ ) {

				nor[ k * 3 + c ] = Math.round( Math.min( 1, Math.max( 0, this.nrm[ k * 3 + c ] * 0.5 + 0.5 ) ) * 255 );
				orm[ k * 3 + c ] = Math.round( Math.min( 1, Math.max( 0, this.orm[ k * 3 + c ] ) ) * 255 );

			}

		}

		return { base, nor, orm, w: this.w, h: this.h };

	}

}

/** Encode 8-bit atlas buffers to WebP (base with alpha; `exact` keeps RGB under transparent texels). */
export async function encodeTextures( bytes, { quality = 90, opaque = false, debugDir = null, name = 'atlas' } = {} ) {

	const { base, nor, orm, w, h } = bytes;
	let baseImg;
	if ( opaque ) {

		const rgb = Buffer.alloc( w * h * 3 );
		for ( let k = 0; k < w * h; k ++ ) {

			rgb[ k * 3 ] = base[ k * 4 ]; rgb[ k * 3 + 1 ] = base[ k * 4 + 1 ]; rgb[ k * 3 + 2 ] = base[ k * 4 + 2 ];

		}

		baseImg = await sharp( rgb, { raw: { width: w, height: h, channels: 3 } } ).webp( { quality, effort: 6, smartSubsample: true } ).toBuffer();

	} else {

		baseImg = await sharp( base, { raw: { width: w, height: h, channels: 4 } } ).webp( { quality, alphaQuality: 100, effort: 6, exact: true, smartSubsample: true } ).toBuffer();

	}

	const norImg = await sharp( nor, { raw: { width: w, height: h, channels: 3 } } ).webp( { quality: Math.max( quality, 90 ), effort: 6, smartSubsample: true } ).toBuffer();
	const ormImg = await sharp( orm, { raw: { width: w, height: h, channels: 3 } } ).webp( { quality, effort: 6, smartSubsample: true } ).toBuffer();
	if ( debugDir ) {

		await sharp( base, { raw: { width: w, height: h, channels: 4 } } ).png().toFile( resolve( debugDir, name + '_base.png' ) );
		await sharp( nor, { raw: { width: w, height: h, channels: 3 } } ).png().toFile( resolve( debugDir, name + '_normal.png' ) );
		await sharp( orm, { raw: { width: w, height: h, channels: 3 } } ).png().toFile( resolve( debugDir, name + '_orm.png' ) );
		// flattened preview over grey
		await sharp( base, { raw: { width: w, height: h, channels: 4 } } ).flatten( { background: { r: 70, g: 74, b: 84 } } ).png().toFile( resolve( debugDir, name + '_preview.png' ) );

	}

	return { base: baseImg, nor: norImg, orm: ormImg };

}

// ------------------------------------------------------------------ GLB output

/**
 * Write a GLB following the project conventions.
 *   materials: [ { name, base:Buffer(webp), normal:Buffer|null, orm:Buffer|null, alphaMode:'MASK'|'OPAQUE', alphaCutoff, doubleSided, roughness=1, metallic=1 } ]
 *   variants:  [ { name, lods: [ [ { material:index, pos, nrm, uv, idx } , ... ] , ... ] } ]   (lods[i] = list of primitives, one per material)
 * Positions stay float32 (no node transforms); normals -> int8, uvs -> uint16 (KHR_mesh_quantization); EXT_meshopt_compression.
 */
export async function writeGLB( path, { materials, variants, generator = 'alpenglow plants pipeline' } ) {

	const io = await getIO();
	const doc = new Document();
	doc.getRoot().getAsset().generator = generator;
	const buffer = doc.createBuffer();
	const scene = doc.createScene( 'Scene' );
	doc.getRoot().setDefaultScene( scene );
	doc.createExtension( EXTTextureWebP ).setRequired( true );
	const texCache = [];
	const mats = materials.map( ( m, mi ) => {

		const mat = doc.createMaterial( m.name )
			.setAlphaMode( m.alphaMode || 'OPAQUE' )
			.setDoubleSided( m.doubleSided ?? false )
			.setRoughnessFactor( m.roughness ?? 1 )
			.setMetallicFactor( m.metallic ?? 1 );
		if ( m.alphaMode === 'MASK' ) mat.setAlphaCutoff( m.alphaCutoff ?? 0.5 );
		// `texturesFrom: i` re-uses the texture objects of material i (e.g. bark + leaves that live in the same atlas)
		let t = m.texturesFrom !== undefined ? texCache[ m.texturesFrom ] : null;
		if ( ! t ) {

			const tn = m.textureName || m.name;
			t = { base: doc.createTexture( tn + '_basecolor' ).setImage( m.base ).setMimeType( 'image/webp' ) };
			if ( m.normal ) t.normal = doc.createTexture( tn + '_normal' ).setImage( m.normal ).setMimeType( 'image/webp' );
			if ( m.orm ) t.orm = doc.createTexture( tn + '_orm' ).setImage( m.orm ).setMimeType( 'image/webp' );

		}

		texCache[ mi ] = t;
		mat.setBaseColorTexture( t.base );
		if ( t.normal ) mat.setNormalTexture( t.normal );
		if ( t.orm ) mat.setOcclusionTexture( t.orm ).setMetallicRoughnessTexture( t.orm );
		return mat;

	} );
	for ( const variant of variants ) {

		variant.lods.forEach( ( prims, li ) => {

			const mesh = doc.createMesh( `${variant.name}_LOD${li}` );
			for ( const p of prims ) {

				if ( ! p.idx.length ) continue;
				const nv = p.pos.length / 3;
				const prim = doc.createPrimitive()
					.setAttribute( 'POSITION', doc.createAccessor().setType( 'VEC3' ).setArray( Float32Array.from( p.pos ) ).setBuffer( buffer ) )
					.setAttribute( 'NORMAL', doc.createAccessor().setType( 'VEC3' ).setArray( Float32Array.from( p.nrm ) ).setBuffer( buffer ) )
					.setAttribute( 'TEXCOORD_0', doc.createAccessor().setType( 'VEC2' ).setArray( Float32Array.from( p.uv ) ).setBuffer( buffer ) )
					.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( nv > 65535 ? Uint32Array.from( p.idx ) : Uint16Array.from( p.idx ) ).setBuffer( buffer ) )
					.setMaterial( mats[ p.material || 0 ] );
				mesh.addPrimitive( prim );

			}

			scene.addChild( doc.createNode( `${variant.name}_LOD${li}` ).setMesh( mesh ) );

		} );

	}

	await doc.transform(
		reorder( { encoder: MeshoptEncoder } ),
		quantize( { pattern: /^(NORMAL|TEXCOORD_\d+)$/, quantizeNormal: 8, quantizeTexcoord: 14 } ),
	);
	// normals are int8 / uvs uint16 (positions stay float so that no node transform is needed) -> declare the extension explicitly
	doc.createExtension( KHRMeshQuantization ).setRequired( true );
	doc.createExtension( EXTMeshoptCompression ).setRequired( true ).setEncoderOptions( { method: EXTMeshoptCompression.EncoderMethod.QUANTIZE } );
	await io.write( path, doc );
	return path;

}

// ------------------------------------------------------------------ misc geometry builders

/** Recompute smooth vertex normals (area weighted) for an indexed mesh. */
export function computeNormals( pos, idx ) {

	const n = new Float32Array( pos.length );
	for ( let t = 0; t < idx.length; t += 3 ) {

		const a = idx[ t ] * 3, b = idx[ t + 1 ] * 3, c = idx[ t + 2 ] * 3;
		const e1 = [ pos[ b ] - pos[ a ], pos[ b + 1 ] - pos[ a + 1 ], pos[ b + 2 ] - pos[ a + 2 ] ];
		const e2 = [ pos[ c ] - pos[ a ], pos[ c + 1 ] - pos[ a + 1 ], pos[ c + 2 ] - pos[ a + 2 ] ];
		const cr = v3.cross( e1, e2 );
		for ( const k of [ a, b, c ] ) {

			n[ k ] += cr[ 0 ]; n[ k + 1 ] += cr[ 1 ]; n[ k + 2 ] += cr[ 2 ];

		}

	}

	for ( let i = 0; i < n.length; i += 3 ) {

		const l = Math.hypot( n[ i ], n[ i + 1 ], n[ i + 2 ] ) || 1;
		n[ i ] /= l; n[ i + 1 ] /= l; n[ i + 2 ] /= l;

	}

	return n;

}

export class MeshBuilder {

	constructor() {

		this.pos = []; this.nrm = []; this.uv = []; this.idx = [];

	}

	get vertexCount() {

		return this.pos.length / 3;

	}

	get triangleCount() {

		return this.idx.length / 3;

	}

	vert( p, n, uv ) {

		this.pos.push( p[ 0 ], p[ 1 ], p[ 2 ] ); this.nrm.push( n[ 0 ], n[ 1 ], n[ 2 ] ); this.uv.push( uv[ 0 ], uv[ 1 ] );
		return this.pos.length / 3 - 1;

	}

	tri( a, b, c ) {

		this.idx.push( a, b, c );

	}

	quad( a, b, c, d ) {

		this.idx.push( a, b, c, a, c, d );

	}

	append( m ) {

		const o = this.vertexCount;
		for ( const x of m.pos ) this.pos.push( x );
		for ( const x of m.nrm ) this.nrm.push( x );
		for ( const x of m.uv ) this.uv.push( x );
		for ( const x of m.idx ) this.idx.push( x + o );

	}

	build( material = 0 ) {

		return { material, pos: Float32Array.from( this.pos ), nrm: Float32Array.from( this.nrm ), uv: Float32Array.from( this.uv ), idx: Uint32Array.from( this.idx ) };

	}

}

/** Shift a set of primitives so that x,z are centred at `pivot` (default: keep) and min y = 0. Returns { size, radius, height } */
export function measure( prims ) {

	let minY = Infinity, maxY = - Infinity, minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity, r2 = 0;
	for ( const p of prims ) for ( let i = 0; i < p.pos.length; i += 3 ) {

		const x = p.pos[ i ], y = p.pos[ i + 1 ], z = p.pos[ i + 2 ];
		if ( y < minY ) minY = y;
		if ( y > maxY ) maxY = y;
		if ( x < minX ) minX = x;
		if ( x > maxX ) maxX = x;
		if ( z < minZ ) minZ = z;
		if ( z > maxZ ) maxZ = z;
		const d = x * x + z * z;
		if ( d > r2 ) r2 = d;

	}

	return { min: [ minX, minY, minZ ], max: [ maxX, maxY, maxZ ], size: [ maxX - minX, maxY - minY, maxZ - minZ ], radius: Math.sqrt( r2 ), height: maxY };

}

export const round = ( x, d = 3 ) => Math.round( x * 10 ** d ) / 10 ** d;
