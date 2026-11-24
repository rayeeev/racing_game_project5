// Shared image analysis helpers for the texture pipeline (sharp based, no colour management:
// JPG pixel values are interpreted as sRGB for albedo and as linear data for normal/arm/height).

import sharp from 'sharp';

export const srgbToLinear = ( c ) => ( c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ) );
export const linearToSrgb = ( c ) => ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );
const LUT = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) LUT[ i ] = srgbToLinear( i / 255 );

export const hex = ( rgb ) => '#' + rgb.map( ( c ) => Math.max( 0, Math.min( 255, Math.round( c ) ) ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
export const round = ( v, d = 4 ) => Number( v.toFixed( d ) );

export async function meta( file ) {

	const m = await sharp( file ).metadata();
	return { width: m.width, height: m.height, channels: m.channels, depth: m.depth, space: m.space, format: m.format, progressive: !! m.isProgressive, subsampling: m.chromaSubsampling, hasProfile: !! m.icc };

}

/** raw 8-bit pixels, optionally box-resampled to size x size */
export async function raw( file, size = null, channels = 3 ) {

	let img = sharp( file );
	if ( size ) img = img.resize( size, size, { kernel: 'cubic', fit: 'fill' } );
	if ( channels === 1 ) img = img.greyscale().toColourspace( 'b-w' );
	else img = img.removeAlpha().toColourspace( 'srgb' );
	const { data, info } = await img.raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height, channels: info.channels };

}

/** average colour of an sRGB albedo: linear-space mean (what a mip chain converges to) + luminance statistics */
export async function albedoStats( file ) {

	const { data, width, height, channels } = await raw( file );
	const n = width * height;
	let r = 0, g = 0, b = 0;
	const lumHist = new Uint32Array( 256 );
	let satSum = 0;
	for ( let i = 0; i < data.length; i += channels ) {

		const R = LUT[ data[ i ] ], G = LUT[ data[ i + 1 ] ], B = LUT[ data[ i + 2 ] ];
		r += R; g += G; b += B;
		const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
		lumHist[ Math.min( 255, Math.round( linearToSrgb( Y ) * 255 ) ) ] ++;
		const mx = Math.max( data[ i ], data[ i + 1 ], data[ i + 2 ] ), mn = Math.min( data[ i ], data[ i + 1 ], data[ i + 2 ] );
		satSum += mx > 0 ? ( mx - mn ) / mx : 0;

	}

	const lin = [ r / n, g / n, b / n ];
	const pct = ( p ) => {

		let acc = 0;
		for ( let i = 0; i < 256; i ++ ) {

			acc += lumHist[ i ];
			if ( acc >= p * n ) return i;

		}

		return 255;

	};
	const srgb = lin.map( ( c ) => linearToSrgb( c ) * 255 );
	const mx = Math.max( ...srgb ), mn = Math.min( ...srgb );
	return {
		avgColorLinear: lin.map( ( c ) => round( c, 4 ) ),
		avgColorSRGB: hex( srgb ),
		avgLuminanceLinear: round( 0.2126 * lin[ 0 ] + 0.7152 * lin[ 1 ] + 0.0722 * lin[ 2 ], 4 ),
		avgSaturation: round( mx > 0 ? ( mx - mn ) / mx : 0, 3 ), // HSV saturation of the average colour
		meanPixelSaturation: round( satSum / n, 3 ),
		lumSRGB_p01_p50_p99: [ pct( 0.01 ), pct( 0.5 ), pct( 0.99 ) ],
	};

}

/** channel means/std of a data texture (0..1) */
export async function channelStats( file ) {

	const { data, width, height, channels } = await raw( file );
	const n = width * height;
	const sum = [ 0, 0, 0 ], sq = [ 0, 0, 0 ], mn = [ 255, 255, 255 ], mx = [ 0, 0, 0 ];
	for ( let i = 0; i < data.length; i += channels ) {

		for ( let c = 0; c < 3; c ++ ) {

			const v = data[ i + c ];
			sum[ c ] += v; sq[ c ] += v * v;
			if ( v < mn[ c ] ) mn[ c ] = v;
			if ( v > mx[ c ] ) mx[ c ] = v;

		}

	}

	const mean = sum.map( ( s ) => s / n / 255 );
	const std = sq.map( ( s, c ) => Math.sqrt( Math.max( 0, s / n / 65025 - mean[ c ] * mean[ c ] ) ) );
	return { mean: mean.map( ( v ) => round( v, 4 ) ), std: std.map( ( v ) => round( v, 4 ) ), min: mn.map( ( v ) => round( v / 255, 3 ) ), max: mx.map( ( v ) => round( v / 255, 3 ) ) };

}

/**
 * Seam check: mean absolute difference across the wrap-around edge divided by the mean absolute difference
 * between neighbouring interior rows/columns. ~1.0 = perfectly tileable, > ~1.6 = visible seam.
 */
export async function seamRatio( file ) {

	const { data, width, height, channels } = await raw( file );
	const px = ( x, y, c ) => data[ ( y * width + x ) * channels + c ];
	const rowDiff = ( y0, y1 ) => {

		let s = 0;
		for ( let x = 0; x < width; x ++ ) for ( let c = 0; c < 3; c ++ ) s += Math.abs( px( x, y0, c ) - px( x, y1, c ) );
		return s / ( width * 3 );

	};
	const colDiff = ( x0, x1 ) => {

		let s = 0;
		for ( let y = 0; y < height; y ++ ) for ( let c = 0; c < 3; c ++ ) s += Math.abs( px( x0, y, c ) - px( x1, y, c ) );
		return s / ( height * 3 );

	};
	let ri = 0, ci = 0, k = 0;
	for ( let i = 8; i < Math.min( width, height ) - 9; i += Math.floor( Math.min( width, height ) / 64 ) ) {

		ri += rowDiff( i, i + 1 ); ci += colDiff( i, i + 1 ); k ++;

	}

	ri /= k; ci /= k;
	return { v: round( rowDiff( height - 1, 0 ) / Math.max( ri, 1e-6 ), 2 ), u: round( colDiff( width - 1, 0 ) / Math.max( ci, 1e-6 ), 2 ) };

}

/**
 * Baked directional light test. A de-lit albedo has no correlation between its (high-passed) luminance and the
 * surface slope stored in the normal map. Returns Pearson r against normal X and Y (OpenGL convention) measured
 * at meso scale (maps resampled to 512), the combined magnitude and the correlation with the AO channel.
 */
export async function bakedLightCheck( albedoFile, normalFile, armFile, size = 512 ) {

	const a = await raw( albedoFile, size );
	const nrm = await raw( normalFile, size );
	const arm = armFile ? await raw( armFile, size ) : null;
	const n = size * size;
	const lum = new Float32Array( n ), nx = new Float32Array( n ), ny = new Float32Array( n ), ao = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		lum[ i ] = Math.log( 0.004 + 0.2126 * LUT[ a.data[ i * 3 ] ] + 0.7152 * LUT[ a.data[ i * 3 + 1 ] ] + 0.0722 * LUT[ a.data[ i * 3 + 2 ] ] );
		nx[ i ] = nrm.data[ i * 3 ] / 127.5 - 1;
		ny[ i ] = nrm.data[ i * 3 + 1 ] / 127.5 - 1;
		if ( arm ) ao[ i ] = arm.data[ i * 3 ] / 255;

	}

	// high-pass the luminance (subtract a wrap-around box blur, radius = size/32) to remove large colour patches
	const rad = Math.max( 2, Math.floor( size / 32 ) );
	const tmp = new Float32Array( n ), blur = new Float32Array( n );
	const win = 2 * rad + 1;
	for ( let y = 0; y < size; y ++ ) {

		let s = 0;
		for ( let k = - rad; k <= rad; k ++ ) s += lum[ y * size + ( ( k + size ) % size ) ];
		for ( let x = 0; x < size; x ++ ) {

			tmp[ y * size + x ] = s / win;
			s += lum[ y * size + ( ( x + rad + 1 ) % size ) ] - lum[ y * size + ( ( x - rad + size ) % size ) ];

		}

	}

	for ( let x = 0; x < size; x ++ ) {

		let s = 0;
		for ( let k = - rad; k <= rad; k ++ ) s += tmp[ ( ( k + size ) % size ) * size + x ];
		for ( let y = 0; y < size; y ++ ) {

			blur[ y * size + x ] = s / win;
			s += tmp[ ( ( y + rad + 1 ) % size ) * size + x ] - tmp[ ( ( y - rad + size ) % size ) * size + x ];

		}

	}

	const hp = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) hp[ i ] = lum[ i ] - blur[ i ];

	const corr = ( p, q ) => {

		let sp = 0, sq = 0, spp = 0, sqq = 0, spq = 0;
		for ( let i = 0; i < n; i ++ ) {

			sp += p[ i ]; sq += q[ i ]; spp += p[ i ] * p[ i ]; sqq += q[ i ] * q[ i ]; spq += p[ i ] * q[ i ];

		}

		const cov = spq / n - ( sp / n ) * ( sq / n );
		const vp = spp / n - ( sp / n ) ** 2, vq = sqq / n - ( sq / n ) ** 2;
		return vp > 1e-12 && vq > 1e-12 ? cov / Math.sqrt( vp * vq ) : 0;

	};

	const rx = corr( hp, nx ), ry = corr( hp, ny );
	return { rx: round( rx, 3 ), ry: round( ry, 3 ), directional: round( Math.hypot( rx, ry ), 3 ), rAO: arm ? round( corr( hp, ao ), 3 ) : null };

}

/** normal map sanity: mean direction (should be ~[0,0,1]) and slope strength */
export async function normalStats( file ) {

	const { data, width, height, channels } = await raw( file );
	const n = width * height;
	let sx = 0, sy = 0, sz = 0, slope = 0, lenErr = 0;
	for ( let i = 0; i < data.length; i += channels ) {

		const x = data[ i ] / 127.5 - 1, y = data[ i + 1 ] / 127.5 - 1, z = data[ i + 2 ] / 127.5 - 1;
		sx += x; sy += y; sz += z;
		slope += Math.hypot( x, y );
		lenErr += Math.abs( Math.hypot( x, y, z ) - 1 );

	}

	return { mean: [ round( sx / n, 4 ), round( sy / n, 4 ), round( sz / n, 4 ) ], meanSlope: round( slope / n, 4 ), meanLengthError: round( lenErr / n, 4 ) };

}

/**
 * Calibrates the (unitless) height map against the normal map: finds the displacement range in metres (black -> white)
 * for which the slopes of the height field best match the slopes stored in the OpenGL normal map.
 * Returns { scaleMeters, scaleX, scaleY, rx, ry } - scaleX / scaleY are the independent fits along u and v (they should
 * agree and both be positive: a negative scaleY would mean a DirectX-convention normal map), rx / ry the correlations.
 */
export async function heightScaleFromNormal( heightFile, normalFile, tileSizeMeters, size = 1024 ) {

	const h = await raw( heightFile, size, 1 );
	const n = await raw( normalFile, size, 3 );
	const N = size * size, px = tileSizeMeters / size;
	const box = ( src ) => { // 5x5 wrap-around box blur to suppress JPEG noise before differentiating

		const tmp = new Float32Array( N ), out = new Float32Array( N );
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			let a = 0;
			for ( let k = - 2; k <= 2; k ++ ) a += src[ y * size + ( ( x + k + size ) % size ) ];
			tmp[ y * size + x ] = a / 5;

		}

		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			let a = 0;
			for ( let k = - 2; k <= 2; k ++ ) a += tmp[ ( ( y + k + size ) % size ) * size + x ];
			out[ y * size + x ] = a / 5;

		}

		return out;

	};
	const H = new Float32Array( N ), tx = new Float32Array( N ), ty = new Float32Array( N );
	for ( let i = 0; i < N; i ++ ) {

		H[ i ] = h.data[ i ] / 255;
		const x = n.data[ i * 3 ] / 127.5 - 1, y = n.data[ i * 3 + 1 ] / 127.5 - 1, z = Math.max( 0.2, n.data[ i * 3 + 2 ] / 127.5 - 1 );
		tx[ i ] = - x / z; // dh/dx
		ty[ i ] = y / z; // dh/d(row): rows run down while +Y of an OpenGL normal map points up

	}

	const Hs = box( H ), txs = box( tx ), tys = box( ty );
	let gxt = 0, gxg = 0, gyt = 0, gyg = 0, txx = 0, tyy = 0;
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const i = y * size + x;
		const gx = ( Hs[ y * size + ( ( x + 1 ) % size ) ] - Hs[ y * size + ( ( x - 1 + size ) % size ) ] ) / ( 2 * px );
		const gy = ( Hs[ ( ( y + 1 ) % size ) * size + x ] - Hs[ ( ( y - 1 + size ) % size ) * size + x ] ) / ( 2 * px );
		gxt += gx * txs[ i ]; gxg += gx * gx; txx += txs[ i ] * txs[ i ];
		gyt += gy * tys[ i ]; gyg += gy * gy; tyy += tys[ i ] * tys[ i ];

	}

	const scaleX = gxt / Math.max( gxg, 1e-12 ), scaleY = gyt / Math.max( gyg, 1e-12 );
	return {
		scaleMeters: round( ( gxt + gyt ) / Math.max( gxg + gyg, 1e-12 ), 4 ), scaleX: round( scaleX, 4 ), scaleY: round( scaleY, 4 ),
		rx: round( gxt / Math.sqrt( Math.max( gxg * txx, 1e-12 ) ), 3 ), ry: round( gyt / Math.sqrt( Math.max( gyg * tyy, 1e-12 ) ), 3 ),
	};

}
