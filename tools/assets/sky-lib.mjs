// Shared helpers for the sky pipeline (Radiance RGBE I/O, equirect geometry, tone mapping).
// Pure Node, no DOM. Imported by the other tools/assets/sky-*.mjs scripts.
//
// CONVENTIONS (verified empirically against three r187 WebGPURenderer, see dev/preview-sky.html):
//   image row 0 = top = +Y (up); column c <-> u = (c + 0.5) / W
//   phi = (u - 0.5) * 2PI,  lat = (0.5 - (r + 0.5) / H) * PI
//   world direction = ( cos(lat) cos(phi), sin(lat), cos(lat) sin(phi) )        (three.js equirectUV inverse)
//   => image centre column looks at +X, u = 0.75 at +Z, u = 0.25 at -Z, left/right edge at -X.
//   azimuth (deg) = atan2( x, z )  ->  0 = +Z, 90 = +X, 180 = -Z, 270 = -X   (same as dev/viewer.html "az")

import { readFileSync, writeFileSync } from 'node:fs';

export const LUMA = [ 0.2126, 0.7152, 0.0722 ]; // Rec.709 / linear sRGB

export function luminance( r, g, b ) {

	return 0.2126 * r + 0.7152 * g + 0.0722 * b;

}

// ---------------------------------------------------------------------------------------------
// Radiance RGBE (.hdr)
// ---------------------------------------------------------------------------------------------

/**
 * Reads a Radiance .hdr file (RLE or flat scanlines, -Y H +X W orientation).
 * Returns { width, height, data: Float32Array (RGB, row 0 = top), header: string }.
 */
export function readHDR( path ) {

	const buf = readFileSync( path );
	return parseHDR( buf );

}

export function parseHDR( buf ) {

	let pos = 0;
	const readLine = () => {

		let end = pos;
		while ( end < buf.length && buf[ end ] !== 0x0a ) end ++;
		if ( end >= buf.length ) throw new Error( 'HDR: unexpected end of header' );
		const line = buf.toString( 'latin1', pos, end );
		pos = end + 1;
		return line;

	};

	const first = readLine();
	if ( ! /^#\?(RADIANCE|RGBE)/.test( first ) ) throw new Error( 'HDR: bad magic: ' + first.slice( 0, 20 ) );
	let header = first + '\n';
	let format = null, exposure = 1, width = 0, height = 0;
	for ( ;; ) {

		const line = readLine();
		header += line + '\n';
		let m;
		if ( ( m = /^FORMAT=(\S+)/.exec( line ) ) ) format = m[ 1 ];
		else if ( ( m = /^EXPOSURE\s*=\s*([0-9.eE+-]+)/.exec( line ) ) ) exposure *= parseFloat( m[ 1 ] );
		else if ( ( m = /^-Y\s+(\d+)\s+\+X\s+(\d+)/.exec( line ) ) ) {

			height = parseInt( m[ 1 ], 10 );
			width = parseInt( m[ 2 ], 10 );
			break;

		} else if ( /^[+-][XY]\s+\d+\s+[+-][XY]\s+\d+/.test( line ) ) {

			throw new Error( 'HDR: unsupported orientation: ' + line );

		}

	}

	if ( format !== '32-bit_rle_rgbe' ) throw new Error( 'HDR: unsupported format ' + format );
	if ( exposure !== 1 ) throw new Error( 'HDR: EXPOSURE header present (' + exposure + ') - three.js ignores it, handle explicitly' );

	const rgbe = new Uint8Array( width * height * 4 );
	const scan = new Uint8Array( width * 4 );

	for ( let y = 0; y < height; y ++ ) {

		const isRLE = width >= 8 && width <= 0x7fff && buf[ pos ] === 2 && buf[ pos + 1 ] === 2 && ( buf[ pos + 2 ] & 0x80 ) === 0;
		if ( ! isRLE ) {

			if ( y !== 0 ) throw new Error( 'HDR: mixed flat/RLE scanlines are not supported' );
			// flat file
			if ( buf.length - pos < width * height * 4 ) throw new Error( 'HDR: flat data too short' );
			rgbe.set( buf.subarray( pos, pos + width * height * 4 ) );
			pos += width * height * 4;
			break;

		}

		if ( ( ( buf[ pos + 2 ] << 8 ) | buf[ pos + 3 ] ) !== width ) throw new Error( 'HDR: bad scanline width' );
		pos += 4;
		for ( let ch = 0; ch < 4; ch ++ ) {

			let x = 0;
			const base = ch * width;
			while ( x < width ) {

				let count = buf[ pos ++ ];
				if ( count > 128 ) {

					count -= 128;
					if ( count === 0 || x + count > width ) throw new Error( 'HDR: bad RLE run' );
					const v = buf[ pos ++ ];
					scan.fill( v, base + x, base + x + count );
					x += count;

				} else {

					if ( count === 0 || x + count > width ) throw new Error( 'HDR: bad RLE literal' );
					scan.set( buf.subarray( pos, pos + count ), base + x );
					pos += count;
					x += count;

				}

			}

		}

		const o = y * width * 4;
		for ( let x = 0; x < width; x ++ ) {

			rgbe[ o + x * 4 ] = scan[ x ];
			rgbe[ o + x * 4 + 1 ] = scan[ width + x ];
			rgbe[ o + x * 4 + 2 ] = scan[ 2 * width + x ];
			rgbe[ o + x * 4 + 3 ] = scan[ 3 * width + x ];

		}

	}

	const data = new Float32Array( width * height * 3 );
	for ( let i = 0, n = width * height; i < n; i ++ ) {

		const e = rgbe[ i * 4 + 3 ];
		if ( e === 0 ) continue;
		const s = Math.pow( 2, e - 128 ) / 255; // same decode as three.js HDRLoader (Ward's reference uses / 256: 0.4 % darker)
		data[ i * 3 ] = rgbe[ i * 4 ] * s;
		data[ i * 3 + 1 ] = rgbe[ i * 4 + 1 ] * s;
		data[ i * 3 + 2 ] = rgbe[ i * 4 + 2 ] * s;

	}

	return { width, height, data, header };

}

function floatToRGBE( r, g, b, out, o ) {

	// Encoder matched to the three.js HDRLoader decoder: value = mantissa / 255 * 2^(e - 128), mantissa rounded.
	const v = Math.max( r, g, b );
	if ( ! ( v > 1e-32 ) ) {

		out[ o ] = out[ o + 1 ] = out[ o + 2 ] = out[ o + 3 ] = 0;
		return;

	}

	// frexp: v = f * 2^e with 0.5 <= f < 1
	let e = Math.floor( Math.log2( v ) ) + 1;
	if ( v >= Math.pow( 2, e ) ) e ++;
	else if ( v < Math.pow( 2, e - 1 ) ) e --;
	const s = 255 / Math.pow( 2, e );
	out[ o ] = Math.min( 255, Math.max( 0, Math.round( r * s ) ) );
	out[ o + 1 ] = Math.min( 255, Math.max( 0, Math.round( g * s ) ) );
	out[ o + 2 ] = Math.min( 255, Math.max( 0, Math.round( b * s ) ) );
	out[ o + 3 ] = Math.min( 255, Math.max( 1, e + 128 ) );

}

function rleChannel( src, base, width, out ) {

	// Standard Radiance "new RLE" for one channel of one scanline.
	let x = 0;
	while ( x < width ) {

		// find the next run of >= 4 identical bytes
		let runStart = x, runLen = 0;
		while ( runStart < width ) {

			runLen = 1;
			while ( runLen < 127 && runStart + runLen < width && src[ base + runStart + runLen ] === src[ base + runStart ] ) runLen ++;
			if ( runLen >= 4 ) break;
			runStart += runLen;

		}

		if ( runStart >= width ) { runStart = width; runLen = 0; }

		// literals before the run
		while ( x < runStart ) {

			const n = Math.min( 128, runStart - x );
			out.push( n );
			for ( let i = 0; i < n; i ++ ) out.push( src[ base + x + i ] );
			x += n;

		}

		if ( runLen >= 4 ) {

			out.push( 128 + runLen, src[ base + runStart ] );
			x += runLen;

		}

	}

}

/**
 * Writes a Radiance .hdr file. data = Float32Array RGB (row 0 = top). rle=true -> run-length encoded scanlines.
 */
export function writeHDR( path, width, height, data, { rle = true, comment = '' } = {} ) {

	const head = '#?RADIANCE\n' + ( comment ? '# ' + comment.replace( /\n/g, ' ' ) + '\n' : '' ) + 'FORMAT=32-bit_rle_rgbe\n\n-Y ' + height + ' +X ' + width + '\n';
	const rgbe = new Uint8Array( width * height * 4 );
	for ( let i = 0, n = width * height; i < n; i ++ ) floatToRGBE( data[ i * 3 ], data[ i * 3 + 1 ], data[ i * 3 + 2 ], rgbe, i * 4 );

	const chunks = [ Buffer.from( head, 'latin1' ) ];
	if ( ! rle || width < 8 || width > 0x7fff ) {

		chunks.push( Buffer.from( rgbe.buffer, rgbe.byteOffset, rgbe.byteLength ) );

	} else {

		const planar = new Uint8Array( width * 4 );
		for ( let y = 0; y < height; y ++ ) {

			const o = y * width * 4;
			for ( let x = 0; x < width; x ++ ) {

				planar[ x ] = rgbe[ o + x * 4 ];
				planar[ width + x ] = rgbe[ o + x * 4 + 1 ];
				planar[ 2 * width + x ] = rgbe[ o + x * 4 + 2 ];
				planar[ 3 * width + x ] = rgbe[ o + x * 4 + 3 ];

			}

			const out = [ 2, 2, ( width >> 8 ) & 0xff, width & 0xff ];
			for ( let ch = 0; ch < 4; ch ++ ) rleChannel( planar, ch * width, width, out );
			chunks.push( Buffer.from( out ) );

		}

	}

	writeFileSync( path, Buffer.concat( chunks ) );

}

// ---------------------------------------------------------------------------------------------
// Equirect geometry
// ---------------------------------------------------------------------------------------------

export function rowLat( r, H ) {

	return ( 0.5 - ( r + 0.5 ) / H ) * Math.PI;

}

/** Exact solid angle of one pixel in row r. */
export function rowSolidAngle( r, W, H ) {

	const top = ( 0.5 - r / H ) * Math.PI, bottom = ( 0.5 - ( r + 1 ) / H ) * Math.PI;
	return ( 2 * Math.PI / W ) * ( Math.sin( top ) - Math.sin( bottom ) );

}

/** Pixel centre (c, r) -> unit direction [x, y, z] in three.js world space. */
export function pixelDir( c, r, W, H ) {

	const phi = ( ( c + 0.5 ) / W - 0.5 ) * 2 * Math.PI;
	const lat = rowLat( r, H );
	const cl = Math.cos( lat );
	return [ cl * Math.cos( phi ), Math.sin( lat ), cl * Math.sin( phi ) ];

}

/** Unit direction -> continuous pixel coordinates { c, r } (pixel centres at integer + 0.5). */
export function dirToPixel( d, W, H ) {

	const u = Math.atan2( d[ 2 ], d[ 0 ] ) / ( 2 * Math.PI ) + 0.5;
	const v = Math.asin( Math.max( - 1, Math.min( 1, d[ 1 ] ) ) ) / Math.PI + 0.5;
	return { c: u * W, r: ( 1 - v ) * H };

}

export function dirFromAzEl( azDeg, elDeg ) {

	const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
	return [ Math.cos( el ) * Math.sin( az ), Math.sin( el ), Math.cos( el ) * Math.cos( az ) ];

}

export function azElFromDir( d ) {

	let az = Math.atan2( d[ 0 ], d[ 2 ] ) * 180 / Math.PI;
	if ( az < 0 ) az += 360;
	const el = Math.asin( Math.max( - 1, Math.min( 1, d[ 1 ] ) ) ) * 180 / Math.PI;
	return { az, el };

}

/** Bilinear sample of an equirect float RGB image in direction d (wraps horizontally). */
export function sampleEquirect( img, d, out = [ 0, 0, 0 ] ) {

	const { width: W, height: H, data } = img;
	const p = dirToPixel( d, W, H );
	const fx = p.c - 0.5, fy = Math.max( 0, Math.min( H - 1, p.r - 0.5 ) );
	const x0 = Math.floor( fx ), y0 = Math.min( H - 1, Math.floor( fy ) );
	const tx = fx - x0, ty = fy - y0;
	const xa = ( ( x0 % W ) + W ) % W, xb = ( xa + 1 ) % W;
	const yb = Math.min( H - 1, y0 + 1 );
	for ( let k = 0; k < 3; k ++ ) {

		const a = data[ ( y0 * W + xa ) * 3 + k ], b = data[ ( y0 * W + xb ) * 3 + k ];
		const c = data[ ( yb * W + xa ) * 3 + k ], e = data[ ( yb * W + xb ) * 3 + k ];
		out[ k ] = ( a * ( 1 - tx ) + b * tx ) * ( 1 - ty ) + ( c * ( 1 - tx ) + e * tx ) * ty;

	}

	return out;

}

/** Energy-conserving integer-factor box downsample of an equirect (weights = exact pixel solid angles). */
export function downsampleEquirect( img, factor ) {

	const { width: W, height: H, data } = img;
	if ( W % factor || H % factor ) throw new Error( 'downsample factor must divide the image size' );
	const w = W / factor, h = H / factor;
	const out = new Float32Array( w * h * 3 );
	for ( let y = 0; y < h; y ++ ) {

		let wsum = 0;
		const weights = [];
		for ( let j = 0; j < factor; j ++ ) {

			const sa = rowSolidAngle( y * factor + j, W, H );
			weights.push( sa );
			wsum += sa * factor;

		}

		for ( let x = 0; x < w; x ++ ) {

			let r = 0, g = 0, b = 0;
			for ( let j = 0; j < factor; j ++ ) {

				const rowOff = ( y * factor + j ) * W;
				const wj = weights[ j ];
				for ( let i = 0; i < factor; i ++ ) {

					const o = ( rowOff + x * factor + i ) * 3;
					r += data[ o ] * wj; g += data[ o + 1 ] * wj; b += data[ o + 2 ] * wj;

				}

			}

			const o = ( y * w + x ) * 3;
			out[ o ] = r / wsum; out[ o + 1 ] = g / wsum; out[ o + 2 ] = b / wsum;

		}

	}

	return { width: w, height: h, data: out };

}

// ---------------------------------------------------------------------------------------------
// Tone mapping (CPU previews only; matches three.js ACESFilmicToneMapping closely enough for thumbnails)
// ---------------------------------------------------------------------------------------------

function rrtOdtFit( v ) {

	const a = v * ( v + 0.0245786 ) - 0.000090537;
	const b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;

}

/** three.js ACESFilmicToneMapping (Stephen Hill fit), input linear sRGB * exposure, output linear [0,1]. */
export function acesFilmic( r, g, b, exposure = 1, out = [ 0, 0, 0 ] ) {

	r *= exposure / 0.6; g *= exposure / 0.6; b *= exposure / 0.6;
	const r1 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
	const g1 = 0.07600 * r + 0.90834 * g + 0.01566 * b;
	const b1 = 0.02840 * r + 0.13383 * g + 0.83777 * b;
	const r2 = rrtOdtFit( r1 ), g2 = rrtOdtFit( g1 ), b2 = rrtOdtFit( b1 );
	out[ 0 ] = Math.min( 1, Math.max( 0, 1.60475 * r2 - 0.53108 * g2 - 0.07367 * b2 ) );
	out[ 1 ] = Math.min( 1, Math.max( 0, - 0.10208 * r2 + 1.10813 * g2 - 0.00605 * b2 ) );
	out[ 2 ] = Math.min( 1, Math.max( 0, - 0.00327 * r2 - 0.07276 * g2 + 1.07602 * b2 ) );
	return out;

}

export function linearToSRGB( v ) {

	return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow( v, 1 / 2.4 ) - 0.055;

}

export function sRGBToLinear( v ) {

	return v <= 0.04045 ? v / 12.92 : Math.pow( ( v + 0.055 ) / 1.055, 2.4 );

}

/** Linear RGB (0..1) -> 'rrggbb' sRGB hex (for THREE.Color('#...') / viewer sunColor=...). */
export function linearToHex( rgb ) {

	return rgb.map( ( v ) => Math.round( 255 * linearToSRGB( Math.min( 1, Math.max( 0, v ) ) ) ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

}

/** Tone maps a float RGB image to an 8-bit sRGB RGB buffer (for sharp raw input). */
export function tonemapToBytes( img, exposure ) {

	const { width, height, data } = img;
	const out = Buffer.alloc( width * height * 3 );
	const t = [ 0, 0, 0 ];
	for ( let i = 0, n = width * height; i < n; i ++ ) {

		acesFilmic( data[ i * 3 ], data[ i * 3 + 1 ], data[ i * 3 + 2 ], exposure, t );
		out[ i * 3 ] = Math.round( 255 * linearToSRGB( t[ 0 ] ) );
		out[ i * 3 + 1 ] = Math.round( 255 * linearToSRGB( t[ 1 ] ) );
		out[ i * 3 + 2 ] = Math.round( 255 * linearToSRGB( t[ 2 ] ) );

	}

	return out;

}

export const round = ( v, digits = 4 ) => {

	const f = Math.pow( 10, digits );
	return Math.round( v * f ) / f;

};

export const roundVec = ( v, digits = 4 ) => v.map( ( x ) => round( x, digits ) );

// ---------------------------------------------------------------------------------------------
// Perspective view of an equirect (CPU "camera"), used for thumbnails / selection previews
// ---------------------------------------------------------------------------------------------

/**
 * Renders a rectilinear view of an equirect float image.
 * azDeg/elDeg = view direction (azimuth convention of this file), hfovDeg = horizontal field of view.
 * ss = supersampling factor per axis. Returns { width, height, data: Float32Array RGB }.
 */
export function renderView( img, { azDeg, elDeg, hfovDeg = 90, width = 512, height = 256, ss = 3 } ) {

	const f = dirFromAzEl( azDeg, elDeg ); // forward
	// right = forward x up (three.js camera: right-handed, looking down -Z in camera space)
	let rx = f[ 1 ] * 0 - f[ 2 ] * 1, ry = f[ 2 ] * 0 - f[ 0 ] * 0, rz = f[ 0 ] * 1 - f[ 1 ] * 0;
	const rl = Math.hypot( rx, ry, rz );
	rx /= rl; ry /= rl; rz /= rl;
	// up = right x forward
	const ux = ry * f[ 2 ] - rz * f[ 1 ], uy = rz * f[ 0 ] - rx * f[ 2 ], uz = rx * f[ 1 ] - ry * f[ 0 ];
	const tanH = Math.tan( hfovDeg * Math.PI / 360 );
	const tanV = tanH * height / width;
	const out = new Float32Array( width * height * 3 );
	const s = [ 0, 0, 0 ];
	const n = ss * ss;
	for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

		let r = 0, g = 0, b = 0;
		for ( let j = 0; j < ss; j ++ ) for ( let i = 0; i < ss; i ++ ) {

			const px = ( ( x + ( i + 0.5 ) / ss ) / width * 2 - 1 ) * tanH;
			const py = ( 1 - ( y + ( j + 0.5 ) / ss ) / height * 2 ) * tanV;
			const dx = f[ 0 ] + rx * px + ux * py, dy = f[ 1 ] + ry * px + uy * py, dz = f[ 2 ] + rz * px + uz * py;
			const l = Math.hypot( dx, dy, dz );
			sampleEquirect( img, [ dx / l, dy / l, dz / l ], s );
			r += s[ 0 ]; g += s[ 1 ]; b += s[ 2 ];

		}

		const o = ( y * width + x ) * 3;
		out[ o ] = r / n; out[ o + 1 ] = g / n; out[ o + 2 ] = b / n;

	}

	return { width, height, data: out };

}
