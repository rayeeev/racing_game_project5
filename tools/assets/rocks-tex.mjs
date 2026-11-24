// Texture processing helpers for the rocks pipeline (float buffers, linear-light maths).
import sharp from 'sharp';
import { SRGB8_TO_LINEAR, linearToOklab, oklabToLinear, linearToSrgb } from './rocks-lib.mjs';

/** Load an image as 8-bit interleaved RGB (greyscale is expanded). */
export async function loadRGB8( path ) {

	const { data, info } = await sharp( path, { limitInputPixels: false } ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	if ( info.channels !== 3 ) throw new Error( `expected 3 channels for ${path}, got ${info.channels}` );
	return { data: new Uint8Array( data.buffer, data.byteOffset, data.byteLength ), width: info.width, height: info.height };

}

/** Load the first channel of an image as 8-bit grey. */
export async function loadGrey8( path, channel = 0 ) {

	const { data, info } = await sharp( path, { limitInputPixels: false } ).removeAlpha().extractChannel( channel ).raw().toBuffer( { resolveWithObject: true } );
	return { data: new Uint8Array( data.buffer, data.byteOffset, data.byteLength ), width: info.width, height: info.height };

}

/** Keep the first `rows` rows of an interleaved image. */
export function cropRows( data, width, channels, rows ) {

	return data.subarray( 0, width * rows * channels );

}

// ---------------------------------------------------------------- push-pull fill

/**
 * Fill texels where mask == 0 from the valid ones (push-pull pyramid). data: Float32Array (w*h*C), modified in place.
 * Texels next to an island receive averages of the adjacent valid texels; far texels converge to regional averages,
 * so every mip level of the final texture stays free of foreign colours (no dark / bright seams at UV island borders).
 */
export function pushPullFill( data, width, height, C, mask ) {

	const levels = [ { w: width, h: height, col: data, valid: mask } ];
	let w = width, h = height, col = data, valid = mask;
	while ( w > 1 || h > 1 ) {

		const nw = Math.max( 1, ( w + 1 ) >> 1 ), nh = Math.max( 1, ( h + 1 ) >> 1 );
		const ncol = new Float32Array( nw * nh * C ), nvalid = new Uint8Array( nw * nh );
		for ( let y = 0; y < nh; y ++ ) {

			for ( let x = 0; x < nw; x ++ ) {

				let cnt = 0;
				const o = ( y * nw + x ) * C;
				for ( let dy = 0; dy < 2; dy ++ ) {

					const sy = y * 2 + dy;
					if ( sy >= h ) continue;
					for ( let dx = 0; dx < 2; dx ++ ) {

						const sx = x * 2 + dx;
						if ( sx >= w ) continue;
						const si = sy * w + sx;
						if ( ! valid[ si ] ) continue;
						cnt ++;
						for ( let c = 0; c < C; c ++ ) ncol[ o + c ] += col[ si * C + c ];

					}

				}

				if ( cnt ) {

					nvalid[ y * nw + x ] = 1;
					for ( let c = 0; c < C; c ++ ) ncol[ o + c ] /= cnt;

				}

			}

		}

		levels.push( { w: nw, h: nh, col: ncol, valid: nvalid } );
		w = nw; h = nh; col = ncol; valid = nvalid;

	}

	// pull: fill invalid texels from the (already complete) coarser level with bilinear interpolation
	for ( let l = levels.length - 2; l >= 0; l -- ) {

		const fine = levels[ l ], coarse = levels[ l + 1 ];
		const fw = fine.w, fh = fine.h, cw = coarse.w, ch = coarse.h;
		for ( let y = 0; y < fh; y ++ ) {

			const fy = ( y + 0.5 ) / 2 - 0.5;
			let y0 = Math.floor( fy ); const ty = fy - y0;
			let y1 = y0 + 1;
			if ( y0 < 0 ) y0 = 0; if ( y1 > ch - 1 ) y1 = ch - 1; if ( y0 > ch - 1 ) y0 = ch - 1;
			for ( let x = 0; x < fw; x ++ ) {

				const i = y * fw + x;
				if ( fine.valid[ i ] ) continue;
				const fx = ( x + 0.5 ) / 2 - 0.5;
				let x0 = Math.floor( fx ); const tx = fx - x0;
				let x1 = x0 + 1;
				if ( x0 < 0 ) x0 = 0; if ( x1 > cw - 1 ) x1 = cw - 1; if ( x0 > cw - 1 ) x0 = cw - 1;
				const a = ( y0 * cw + x0 ) * C, b = ( y0 * cw + x1 ) * C, c2 = ( y1 * cw + x0 ) * C, d = ( y1 * cw + x1 ) * C;
				for ( let c = 0; c < C; c ++ ) {

					const top = coarse.col[ a + c ] * ( 1 - tx ) + coarse.col[ b + c ] * tx;
					const bot = coarse.col[ c2 + c ] * ( 1 - tx ) + coarse.col[ d + c ] * tx;
					fine.col[ i * C + c ] = top * ( 1 - ty ) + bot * ty;

				}

			}

		}

	}

	return data;

}

// ---------------------------------------------------------------- resampling

function lanczos( x, a ) {

	if ( x === 0 ) return 1;
	if ( x <= - a || x >= a ) return 0;
	const px = Math.PI * x;
	return a * Math.sin( px ) * Math.sin( px / a ) / ( px * px );

}

function contributions( srcN, dstN, a ) {

	const scale = srcN / dstN;
	const fscale = Math.max( 1, scale ); // widen the kernel when minifying (antialiasing)
	const support = a * fscale;
	const starts = new Int32Array( dstN ), counts = new Int32Array( dstN );
	const maxTaps = Math.ceil( support * 2 ) + 2;
	const weights = new Float32Array( dstN * maxTaps );
	for ( let i = 0; i < dstN; i ++ ) {

		const center = ( i + 0.5 ) * scale;
		const lo = Math.max( 0, Math.floor( center - support ) ), hi = Math.min( srcN - 1, Math.ceil( center + support ) );
		let sum = 0, n = 0;
		for ( let j = lo; j <= hi; j ++ ) {

			const wgt = lanczos( ( j + 0.5 - center ) / fscale, a );
			weights[ i * maxTaps + n ++ ] = wgt;
			sum += wgt;

		}

		for ( let k = 0; k < n; k ++ ) weights[ i * maxTaps + k ] /= sum;
		starts[ i ] = lo; counts[ i ] = n;

	}

	return { starts, counts, weights, maxTaps };

}

/** Separable Lanczos resampling of an interleaved Float32 image. */
export function resizeLanczos( src, sw, sh, C, dw, dh, a = 3 ) {

	if ( sw === dw && sh === dh ) return src;
	const cx = contributions( sw, dw, a );
	const tmp = new Float32Array( dw * sh * C );
	for ( let y = 0; y < sh; y ++ ) {

		const row = y * sw * C, orow = y * dw * C;
		for ( let x = 0; x < dw; x ++ ) {

			const s = cx.starts[ x ], n = cx.counts[ x ], wo = x * cx.maxTaps;
			for ( let c = 0; c < C; c ++ ) {

				let acc = 0;
				for ( let k = 0; k < n; k ++ ) acc += src[ row + ( s + k ) * C + c ] * cx.weights[ wo + k ];
				tmp[ orow + x * C + c ] = acc;

			}

		}

	}

	const cy = contributions( sh, dh, a );
	const dst = new Float32Array( dw * dh * C );
	for ( let y = 0; y < dh; y ++ ) {

		const s = cy.starts[ y ], n = cy.counts[ y ], wo = y * cy.maxTaps;
		const orow = y * dw * C;
		for ( let k = 0; k < n; k ++ ) {

			const wgt = cy.weights[ wo + k ];
			const row = ( s + k ) * dw * C;
			for ( let i = 0; i < dw * C; i ++ ) dst[ orow + i ] += tmp[ row + i ] * wgt;

		}

	}

	return dst;

}

// ---------------------------------------------------------------- conversions

export function srgb8ToLinearFloat( u8 ) {

	const out = new Float32Array( u8.length );
	for ( let i = 0; i < u8.length; i ++ ) out[ i ] = SRGB8_TO_LINEAR[ u8[ i ] ];
	return out;

}

export function u8ToFloat( u8 ) {

	const out = new Float32Array( u8.length );
	for ( let i = 0; i < u8.length; i ++ ) out[ i ] = u8[ i ] / 255;
	return out;

}

export function linearFloatToSrgb8( f ) {

	const out = new Uint8Array( f.length );
	for ( let i = 0; i < f.length; i ++ ) {

		const v = f[ i ];
		out[ i ] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round( linearToSrgb( v ) * 255 );

	}

	return out;

}

export function floatToU8( f ) {

	const out = new Uint8Array( f.length );
	for ( let i = 0; i < f.length; i ++ ) {

		const v = f[ i ];
		out[ i ] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round( v * 255 );

	}

	return out;

}

// ---------------------------------------------------------------- colour grading

const HUE_PROTECT_START = 97, HUE_PROTECT_END = 118; // OKLab hue (deg): warm rock hues below, moss / lichen greens above

/** 1 for warm / neutral rock hues, 0 for vegetation greens (smooth ramp). */
export function rockWeight( a, b ) {

	const C = Math.hypot( a, b );
	if ( C < 1e-5 ) return 1;
	let h = Math.atan2( b, a ) * 180 / Math.PI; // -180..180
	if ( h < - 60 ) return 1; // purples / blues: treat as rock
	if ( h <= HUE_PROTECT_START ) return 1;
	if ( h >= HUE_PROTECT_END && h <= 175 ) return 0;
	if ( h > 175 ) return 1;
	const t = ( h - HUE_PROTECT_START ) / ( HUE_PROTECT_END - HUE_PROTECT_START );
	return 1 - t * t * ( 3 - 2 * t );

}

/** OKLab statistics of the rock (non-vegetation) texels inside the mask. lin: Float32 linear RGB. */
export function rockStats( lin, mask, step = 1 ) {

	const lab = [ 0, 0, 0 ];
	let n = 0, sw = 0, sL = 0, sa = 0, sb = 0, sLL = 0, sC = 0, green = 0;
	for ( let i = 0; i < mask.length; i += step ) {

		if ( ! mask[ i ] ) continue;
		linearToOklab( lin[ i * 3 ], lin[ i * 3 + 1 ], lin[ i * 3 + 2 ], lab );
		const wgt = rockWeight( lab[ 1 ], lab[ 2 ] );
		n ++;
		green += 1 - wgt;
		sw += wgt; sL += lab[ 0 ] * wgt; sa += lab[ 1 ] * wgt; sb += lab[ 2 ] * wgt; sLL += lab[ 0 ] * lab[ 0 ] * wgt; sC += Math.hypot( lab[ 1 ], lab[ 2 ] ) * wgt;

	}

	const L = sL / sw, a = sa / sw, b = sb / sw;
	return { L, a, b, Lstd: Math.sqrt( Math.max( 0, sLL / sw - L * L ) ), chroma: Math.hypot( a, b ), meanChroma: sC / sw, hue: Math.atan2( b, a ) * 180 / Math.PI, greenFraction: green / n, samples: n };

}

/**
 * Grade linear RGB (in place) towards a common "alpine grey rock" look, in OKLab. Model: every texel's chroma (a, b) is split
 * into a component t along the asset's mean rock tint (the ochre / orange cast of the source rock) and a residual r
 * perpendicular to it (r > 0 = greener than the rock tint: moss, lichen; r < 0 = redder: iron stains, pink feldspar).
 *  - t is scaled so that the mean rock chroma becomes target.chroma, and re-oriented to target.hue (limited to +-maxHueShift)
 *  - r is kept, scaled by target.greenResidual (r > 0) / target.redResidual (r < 0)
 *  - lightness: gain so the mean rock lightness moves towards target.L (target.lightnessPull = 0..1, in log space)
 * Neutral texels stay neutral, strongly tinted texels stay proportionally warmer, vegetation keeps its green offset.
 */
export function gradeRock( lin, stats, target ) {

	const gainL = Math.pow( target.L / stats.L, target.lightnessPull ?? 0.75 );
	const kT = Math.min( target.maxChromaGain ?? 1, target.chroma / Math.max( stats.chroma, 1e-4 ) );
	const maxH = target.maxHueShift ?? 30;
	const hueT = stats.hue + Math.max( - maxH, Math.min( maxH, target.hue - stats.hue ) );
	const hm = stats.hue * Math.PI / 180, ht = hueT * Math.PI / 180;
	const u0 = Math.cos( hm ), u1 = Math.sin( hm ), v0 = - u1, v1 = u0;
	const p0 = Math.cos( ht ), p1 = Math.sin( ht ), q0 = - p1, q1 = p0;
	const kGreen = target.greenResidual ?? 1, kRed = target.redResidual ?? 0.7;
	const lab = [ 0, 0, 0 ], rgb = [ 0, 0, 0 ];
	for ( let i = 0; i < lin.length; i += 3 ) {

		linearToOklab( lin[ i ], lin[ i + 1 ], lin[ i + 2 ], lab );
		const t = ( lab[ 1 ] * u0 + lab[ 2 ] * u1 ) * kT;
		let r = lab[ 1 ] * v0 + lab[ 2 ] * v1;
		r *= r > 0 ? kGreen : kRed;
		oklabToLinear( lab[ 0 ] * gainL, t * p0 + r * q0, t * p1 + r * q1, rgb );
		lin[ i ] = rgb[ 0 ] < 0 ? 0 : rgb[ 0 ]; lin[ i + 1 ] = rgb[ 1 ] < 0 ? 0 : rgb[ 1 ]; lin[ i + 2 ] = rgb[ 2 ] < 0 ? 0 : rgb[ 2 ];

	}

	return { gainL, chromaGain: kT, hueShiftDeg: hueT - stats.hue };

}

// ---------------------------------------------------------------- normal maps

/** Renormalise an interleaved xyz normal map stored as 0..1 floats (in place). */
export function renormalizeNormals( f ) {

	for ( let i = 0; i < f.length; i += 3 ) {

		let x = f[ i ] * 2 - 1, y = f[ i + 1 ] * 2 - 1, z = f[ i + 2 ] * 2 - 1;
		if ( z < 0.05 ) z = 0.05; // tangent-space normals never point into the surface
		const l = Math.hypot( x, y, z ) || 1;
		x /= l; y /= l; z /= l;
		f[ i ] = x * 0.5 + 0.5; f[ i + 1 ] = y * 0.5 + 0.5; f[ i + 2 ] = z * 0.5 + 0.5;

	}

	return f;

}

// ---------------------------------------------------------------- encoding

export async function encodeTexture( u8, width, height, { format = 'webp', quality = 90, kind = 'color' } = {} ) {

	const img = sharp( Buffer.from( u8.buffer, u8.byteOffset, u8.byteLength ), { raw: { width, height, channels: 3 }, limitInputPixels: false } );
	if ( format === 'webp' ) {

		// smartSubsample = sharp YUV conversion (much less chroma bleeding, important for normal / ORM data)
		return { buffer: await img.webp( { quality, effort: 6, smartSubsample: true, preset: kind === 'color' ? 'photo' : 'default' } ).toBuffer(), mime: 'image/webp' };

	}

	if ( format === 'jpeg' ) return { buffer: await img.jpeg( { quality, chromaSubsampling: '4:4:4', mozjpeg: true } ).toBuffer(), mime: 'image/jpeg' };
	if ( format === 'png' ) return { buffer: await img.png( { compressionLevel: 9 } ).toBuffer(), mime: 'image/png' };
	throw new Error( 'unknown format ' + format );

}
