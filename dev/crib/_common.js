// Shared helpers for the dev/crib/*.html API verification pages (three r187, WebGPURenderer).
import * as THREE from 'three/webgpu';

export const q = new URLSearchParams( location.search );
export const num = ( k, d ) => ( q.has( k ) ? Number( q.get( k ) ) : d );
export const str = ( k, d ) => ( q.has( k ) ? q.get( k ) : d );
export const flag = ( k ) => q.has( k ) && q.get( k ) !== '0';

/** sRGB checker CanvasTexture (RepeatWrapping). */
export function checkerTexture( size = 256, cells = 8, c1 = '#b9b4a8', c2 = '#6f6a60' ) {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' );
	const s = size / cells;
	for ( let y = 0; y < cells; y ++ ) for ( let x = 0; x < cells; x ++ ) {

		g.fillStyle = ( x + y ) % 2 ? c1 : c2;
		g.fillRect( x * s, y * s, s, s );

	}

	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	return t;

}

function hash2( x, y, seed ) {

	let h = ( x * 374761393 + y * 668265263 + seed * 1442695041 ) | 0;
	h = ( h ^ ( h >>> 13 ) ) * 1274126177 | 0;
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967295;

}

/** Tileable value-noise height field (Float32Array size*size, 0..1). */
export function heightField( size = 256, cell = 16, seed = 1, octaves = 4 ) {

	const out = new Float32Array( size * size );
	let amp = 0.5, total = 0;
	for ( let o = 0; o < octaves; o ++ ) {

		const cs = Math.max( 1, cell >> o ), n = size / cs;
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			const fx = x / cs, fy = y / cs;
			const x0 = Math.floor( fx ), y0 = Math.floor( fy );
			const tx = fx - x0, ty = fy - y0;
			const sx = tx * tx * ( 3 - 2 * tx ), sy = ty * ty * ( 3 - 2 * ty );
			const a = hash2( x0 % n, y0 % n, seed + o ), b = hash2( ( x0 + 1 ) % n, y0 % n, seed + o );
			const c = hash2( x0 % n, ( y0 + 1 ) % n, seed + o ), d = hash2( ( x0 + 1 ) % n, ( y0 + 1 ) % n, seed + o );
			out[ y * size + x ] += amp * ( a + ( b - a ) * sx + ( c - a ) * sy + ( a - b - c + d ) * sx * sy );

		}

		total += amp;
		amp *= 0.5;

	}

	for ( let i = 0; i < out.length; i ++ ) out[ i ] /= total;
	return out;

}

/** Tangent-space normal map (linear, RGBA8 DataTexture, RepeatWrapping, mipmapped) from a tileable noise height field. */
export function noiseNormalTexture( size = 256, strength = 4, cell = 16, seed = 1 ) {

	const h = heightField( size, cell, seed );
	const data = new Uint8Array( size * size * 4 );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const l = h[ y * size + ( x + size - 1 ) % size ], r = h[ y * size + ( x + 1 ) % size ];
		const u = h[ ( ( y + size - 1 ) % size ) * size + x ], d = h[ ( ( y + 1 ) % size ) * size + x ];
		let nx = ( l - r ) * strength, ny = ( u - d ) * strength, nz = 1;
		const len = Math.hypot( nx, ny, nz );
		nx /= len; ny /= len; nz /= len;
		const i = ( y * size + x ) * 4;
		data[ i ] = Math.round( ( nx * 0.5 + 0.5 ) * 255 );
		data[ i + 1 ] = Math.round( ( ny * 0.5 + 0.5 ) * 255 );
		data[ i + 2 ] = Math.round( ( nz * 0.5 + 0.5 ) * 255 );
		data[ i + 3 ] = 255;

	}

	const t = new THREE.DataTexture( data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.magFilter = THREE.LinearFilter;
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.generateMipmaps = true;
	t.colorSpace = THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;

}

/** Greyscale noise texture (sRGB or linear), RepeatWrapping, mipmapped. */
export function noiseTexture( size = 256, cell = 16, seed = 7, srgb = false, tint = [ 1, 1, 1 ] ) {

	const h = heightField( size, cell, seed );
	const data = new Uint8Array( size * size * 4 );
	for ( let i = 0; i < size * size; i ++ ) {

		data[ i * 4 ] = Math.round( h[ i ] * 255 * tint[ 0 ] );
		data[ i * 4 + 1 ] = Math.round( h[ i ] * 255 * tint[ 1 ] );
		data[ i * 4 + 2 ] = Math.round( h[ i ] * 255 * tint[ 2 ] );
		data[ i * 4 + 3 ] = 255;

	}

	const t = new THREE.DataTexture( data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.magFilter = THREE.LinearFilter;
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.generateMipmaps = true;
	t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;

}

/** Leaf-like alpha cutout texture (sRGB RGBA canvas). */
export function leafTexture( size = 256 ) {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' );
	g.clearRect( 0, 0, size, size );
	for ( let i = 0; i < 14; i ++ ) {

		const a = ( i / 14 ) * Math.PI * 2;
		g.save();
		g.translate( size / 2 + Math.cos( a ) * size * 0.22, size / 2 + Math.sin( a ) * size * 0.22 );
		g.rotate( a );
		g.fillStyle = i % 2 ? '#3f7a2c' : '#5a9a35';
		g.beginPath();
		g.ellipse( 0, 0, size * 0.2, size * 0.07, 0, 0, Math.PI * 2 );
		g.fill();
		g.restore();

	}

	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

/** Publish the result for tools/shot.mjs ( --wait-for "window.__ready === true" ). */
export function report( info = {} ) {

	window.__info = info;
	window.__ready = true;

}

/** Run `frames` animation frames, then resolve. */
export function frames( renderer, renderFn, count = 20 ) {

	return new Promise( ( resolve ) => {

		let n = 0;
		renderer.setAnimationLoop( ( t ) => {

			renderFn( t );
			if ( ++ n === count ) resolve();

		} );

	} );

}
