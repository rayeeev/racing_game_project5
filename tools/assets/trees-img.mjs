// Image helpers for the tree pipeline (raw RGBA / float planes on top of sharp).
import sharp from 'sharp';

// Raw 8-bit image container: { w, h, c, data: Uint8Array }
export async function loadImage( file, channels = 3, size = null ) {

	let s = sharp( file, { limitInputPixels: false } );
	if ( size ) s = s.resize( size[ 0 ], size[ 1 ], { kernel: 'lanczos3', fit: 'fill' } );
	if ( channels === 1 ) s = s.greyscale();
	else if ( channels === 3 ) s = s.removeAlpha().toColourspace( 'srgb' );
	else if ( channels === 4 ) s = s.ensureAlpha().toColourspace( 'srgb' );
	const { data, info } = await s.raw().toBuffer( { resolveWithObject: true } );
	if ( info.channels !== channels ) {

		// greyscale sources decoded as 1 channel when 3 were requested, etc.
		const out = new Uint8Array( info.width * info.height * channels );
		for ( let i = 0; i < info.width * info.height; i ++ ) for ( let k = 0; k < channels; k ++ ) out[ i * channels + k ] = k < info.channels ? data[ i * info.channels + k ] : ( k === 3 ? 255 : data[ i * info.channels ] );
		return { w: info.width, h: info.height, c: channels, data: out };

	}

	return { w: info.width, h: info.height, c: channels, data: new Uint8Array( data.buffer, data.byteOffset, data.length ) };

}

export function newImage( w, h, c, fill = null ) {

	const data = new Uint8Array( w * h * c );
	if ( fill ) for ( let i = 0; i < w * h; i ++ ) for ( let k = 0; k < c; k ++ ) data[ i * c + k ] = fill[ k ];
	return { w, h, c, data };

}

export function crop( img, x0, y0, w, h ) {

	const out = newImage( w, h, img.c );
	for ( let y = 0; y < h; y ++ ) {

		const sy = Math.min( img.h - 1, Math.max( 0, y0 + y ) );
		for ( let x = 0; x < w; x ++ ) {

			const sx = Math.min( img.w - 1, Math.max( 0, x0 + x ) );
			for ( let k = 0; k < img.c; k ++ ) out.data[ ( y * w + x ) * img.c + k ] = img.data[ ( sy * img.w + sx ) * img.c + k ];

		}

	}

	return out;

}

export async function resize( img, w, h, kernel = 'lanczos3' ) {

	if ( img.w === w && img.h === h ) return img;
	if ( img.c === 4 ) {

		// sharp premultiplies alpha when resampling, which would wipe the (edge-padded) colour of transparent texels:
		// resample colour and alpha separately
		const rgb = newImage( img.w, img.h, 3 ), a = newImage( img.w, img.h, 1 );
		for ( let i = 0; i < img.w * img.h; i ++ ) {

			rgb.data[ i * 3 ] = img.data[ i * 4 ];
			rgb.data[ i * 3 + 1 ] = img.data[ i * 4 + 1 ];
			rgb.data[ i * 3 + 2 ] = img.data[ i * 4 + 2 ];
			a.data[ i ] = img.data[ i * 4 + 3 ];

		}

		const r2 = await resize( rgb, w, h, kernel ), a2 = await resize( a, w, h, kernel );
		const out = newImage( w, h, 4 );
		for ( let i = 0; i < w * h; i ++ ) {

			out.data[ i * 4 ] = r2.data[ i * 3 ];
			out.data[ i * 4 + 1 ] = r2.data[ i * 3 + 1 ];
			out.data[ i * 4 + 2 ] = r2.data[ i * 3 + 2 ];
			out.data[ i * 4 + 3 ] = a2.data[ i ];

		}

		return out;

	}

	let s = sharp( Buffer.from( img.data.buffer, img.data.byteOffset, img.data.length ), { raw: { width: img.w, height: img.h, channels: img.c }, limitInputPixels: false } )
		.resize( w, h, { kernel, fit: 'fill' } );
	if ( img.c === 1 ) s = s.toColourspace( 'b-w' ); // otherwise sharp expands a 1-channel input to RGB
	const { data, info } = await s.raw().toBuffer( { resolveWithObject: true } );
	if ( info.channels !== img.c ) throw new Error( `resize: expected ${img.c} channels, got ${info.channels}` );
	return { w, h, c: img.c, data: new Uint8Array( data.buffer, data.byteOffset, data.length ) };

}

export function blit( dst, src, dx, dy ) {

	if ( dst.c !== src.c ) throw new Error( 'blit: channel mismatch' );
	for ( let y = 0; y < src.h; y ++ ) {

		const ty = dy + y;
		if ( ty < 0 || ty >= dst.h ) continue;
		for ( let x = 0; x < src.w; x ++ ) {

			const tx = dx + x;
			if ( tx < 0 || tx >= dst.w ) continue;
			for ( let k = 0; k < src.c; k ++ ) dst.data[ ( ty * dst.w + tx ) * dst.c + k ] = src.data[ ( y * src.w + x ) * src.c + k ];

		}

	}

}

export async function savePng( img, file ) {

	await sharp( Buffer.from( img.data.buffer, img.data.byteOffset, img.data.length ), { raw: { width: img.w, height: img.h, channels: img.c }, limitInputPixels: false } ).png().toFile( file );

}

export async function encode( img, format, opts = {} ) {

	const s = sharp( Buffer.from( img.data.buffer, img.data.byteOffset, img.data.length ), { raw: { width: img.w, height: img.h, channels: img.c }, limitInputPixels: false } );
	if ( format === 'webp' ) return s.webp( { quality: 90, alphaQuality: 100, effort: 5, smartSubsample: true, ...opts } ).toBuffer();
	if ( format === 'jpeg' ) return s.jpeg( { quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true, ...opts } ).toBuffer();
	if ( format === 'png' ) return s.png( opts ).toBuffer();
	throw new Error( 'format ' + format );

}

// Bilinear sample (clamped or wrapped) of channel k at pixel-centre coordinates (x, y) in texels.
export function sampleBilinear( img, x, y, out, wrap = false ) {

	x -= 0.5;
	y -= 0.5;
	let x0 = Math.floor( x ), y0 = Math.floor( y );
	const fx = x - x0, fy = y - y0;
	let x1 = x0 + 1, y1 = y0 + 1;
	if ( wrap ) {

		x0 = ( ( x0 % img.w ) + img.w ) % img.w;
		x1 = ( ( x1 % img.w ) + img.w ) % img.w;
		y0 = ( ( y0 % img.h ) + img.h ) % img.h;
		y1 = ( ( y1 % img.h ) + img.h ) % img.h;

	} else {

		x0 = Math.min( img.w - 1, Math.max( 0, x0 ) );
		x1 = Math.min( img.w - 1, Math.max( 0, x1 ) );
		y0 = Math.min( img.h - 1, Math.max( 0, y0 ) );
		y1 = Math.min( img.h - 1, Math.max( 0, y1 ) );

	}

	const c = img.c, d = img.data;
	const i00 = ( y0 * img.w + x0 ) * c, i10 = ( y0 * img.w + x1 ) * c, i01 = ( y1 * img.w + x0 ) * c, i11 = ( y1 * img.w + x1 ) * c;
	const w00 = ( 1 - fx ) * ( 1 - fy ), w10 = fx * ( 1 - fy ), w01 = ( 1 - fx ) * fy, w11 = fx * fy;
	for ( let k = 0; k < c; k ++ ) out[ k ] = d[ i00 + k ] * w00 + d[ i10 + k ] * w10 + d[ i01 + k ] * w01 + d[ i11 + k ] * w11;
	return out;

}

// Fill texels whose mask value is 0 with colours spread from the nearest valid texels ("edge padding"), so that
// bilinear filtering / mip-mapping of alpha-tested foliage never pulls in a foreign background colour.
// img: c-channel image, valid: Uint8Array (w*h) 1 = keep. passes = how far (texels) the padding reaches.
export function dilate( img, valid, passes = 16 ) {

	const { w, h, c, data } = img;
	let cur = Uint8Array.from( valid );
	for ( let pass = 0; pass < passes; pass ++ ) {

		const next = Uint8Array.from( cur );
		let changed = 0;
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

			const i = y * w + x;
			if ( cur[ i ] ) continue;
			let n = 0;
			const acc = [ 0, 0, 0, 0 ];
			for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

				const xx = x + dx, yy = y + dy;
				if ( xx < 0 || yy < 0 || xx >= w || yy >= h ) continue;
				const j = yy * w + xx;
				if ( ! cur[ j ] ) continue;
				const wgt = dx === 0 || dy === 0 ? 2 : 1;
				n += wgt;
				for ( let k = 0; k < c; k ++ ) acc[ k ] += data[ j * c + k ] * wgt;

			}

			if ( n > 0 ) {

				for ( let k = 0; k < c; k ++ ) data[ i * c + k ] = Math.round( acc[ k ] / n );
				next[ i ] = 1;
				changed ++;

			}

		}

		cur = next;
		if ( ! changed ) break;

	}

	return cur;

}

// Simple shelf packer. rects: [{ w, h, ... }] (already padded). Returns true and sets .x/.y when everything fits.
export function shelfPack( rects, W, H ) {

	const order = rects.map( ( r, i ) => i ).sort( ( a, b ) => rects[ b ].h - rects[ a ].h || rects[ b ].w - rects[ a ].w );
	// free rectangles (guillotine, best short side fit) - better than plain shelves for mixed sizes
	let free = [ { x: 0, y: 0, w: W, h: H } ];
	for ( const i of order ) {

		const r = rects[ i ];
		let best = - 1, bestScore = Infinity;
		for ( let f = 0; f < free.length; f ++ ) {

			const fr = free[ f ];
			if ( fr.w < r.w || fr.h < r.h ) continue;
			const score = Math.min( fr.w - r.w, fr.h - r.h );
			if ( score < bestScore ) {

				bestScore = score;
				best = f;

			}

		}

		if ( best < 0 ) return false;
		const fr = free.splice( best, 1 )[ 0 ];
		r.x = fr.x;
		r.y = fr.y;
		// split the remaining L-shape along the shorter leftover axis
		const dw = fr.w - r.w, dh = fr.h - r.h;
		if ( dw > dh ) {

			if ( dw > 0 ) free.push( { x: fr.x + r.w, y: fr.y, w: dw, h: fr.h } );
			if ( dh > 0 ) free.push( { x: fr.x, y: fr.y + r.h, w: r.w, h: dh } );

		} else {

			if ( dh > 0 ) free.push( { x: fr.x, y: fr.y + r.h, w: fr.w, h: dh } );
			if ( dw > 0 ) free.push( { x: fr.x + r.w, y: fr.y, w: dw, h: r.h } );

		}

	}

	return true;

}

// Coverage-preserving alpha for alpha-TESTED foliage whose mip chain is generated by the GPU (plain box filter):
// thin needles cover only 30-50 % of a frond, so the averaged alpha of the lower mips drops below the cutoff and
// distant foliage thins out or disappears. A faint "halo" just BELOW the cutoff around every opaque texel leaves
// mip 0 untouched (halo < cutoff -> still discarded) but lifts the averaged alpha of the lower mips above the cutoff
// inside fronds, which then stay solid at a distance.
//   img: RGBA, cutoff: the material's alphaCutoff (0..1), radius: halo reach in texels.
export function alphaHalo( img, cutoff = 0.4, radius = 3 ) {

	const { w, h, data } = img;
	const peak = Math.floor( cutoff * 255 * 0.9 ); // halo value right next to an opaque texel
	const opaque = new Uint8Array( w * h );
	for ( let i = 0; i < w * h; i ++ ) opaque[ i ] = data[ i * 4 + 3 ] >= 128 ? 1 : 0;
	const out = new Uint8Array( w * h );
	const R = radius + 1;
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const i = y * w + x;
		if ( ! opaque[ i ] ) continue;
		for ( let dy = - R; dy <= R; dy ++ ) {

			const yy = y + dy;
			if ( yy < 0 || yy >= h ) continue;
			for ( let dx = - R; dx <= R; dx ++ ) {

				const xx = x + dx;
				if ( xx < 0 || xx >= w ) continue;
				const j = yy * w + xx;
				if ( opaque[ j ] ) continue;
				const d = Math.hypot( dx, dy );
				if ( d > R ) continue;
				const v = Math.round( peak * Math.max( 0, 1 - ( d - 1 ) / radius ) );
				if ( v > out[ j ] ) out[ j ] = v;

			}

		}

	}

	for ( let i = 0; i < w * h; i ++ ) if ( out[ i ] > data[ i * 4 + 3 ] ) data[ i * 4 + 3 ] = out[ i ];

}
