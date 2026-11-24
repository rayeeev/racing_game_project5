// Minimal PNG decoder that returns the EXACT stored bytes (no colour management, no alpha premultiplication),
// which is what data maps (splat weights, masks) need. Works in browsers and in Node (uses DecompressionStream).
// Supports 8-bit, non-interlaced PNGs with colour type 0 (grey), 2 (RGB), 4 (grey + alpha) or 6 (RGBA).

const SIGNATURE = [ 137, 80, 78, 71, 13, 10, 26, 10 ];

async function inflate( bytes ) {

	const stream = new Blob( [ bytes ] ).stream().pipeThrough( new DecompressionStream( 'deflate' ) );
	return new Uint8Array( await new Response( stream ).arrayBuffer() );

}

function paeth( a, b, c ) {

	const p = a + b - c;
	const pa = Math.abs( p - a ), pb = Math.abs( p - b ), pc = Math.abs( p - c );
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;

}

/**
 * Decodes a PNG into RGBA bytes.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>} data is RGBA, row-major, top row first
 */
export async function decodePng( buffer ) {

	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer );
	for ( let i = 0; i < 8; i ++ ) if ( bytes[ i ] !== SIGNATURE[ i ] ) throw new Error( 'decodePng: not a PNG file' );

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
	const idat = [];
	let idatLength = 0;

	let offset = 8;
	while ( offset + 8 <= bytes.length ) {

		const length = view.getUint32( offset );
		const type = String.fromCharCode( bytes[ offset + 4 ], bytes[ offset + 5 ], bytes[ offset + 6 ], bytes[ offset + 7 ] );
		const start = offset + 8;

		if ( type === 'IHDR' ) {

			width = view.getUint32( start );
			height = view.getUint32( start + 4 );
			bitDepth = bytes[ start + 8 ];
			colorType = bytes[ start + 9 ];
			interlace = bytes[ start + 12 ];

		} else if ( type === 'IDAT' ) {

			idat.push( bytes.subarray( start, start + length ) );
			idatLength += length;

		} else if ( type === 'IEND' ) {

			break;

		}

		offset = start + length + 4; // skip data + CRC

	}

	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ colorType ];
	if ( bitDepth !== 8 || channels === undefined || interlace !== 0 ) {

		throw new Error( `decodePng: unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})` );

	}

	// zlib stream = all IDAT chunks concatenated
	const compressed = new Uint8Array( idatLength );
	let p = 0;
	for ( const chunk of idat ) {

		compressed.set( chunk, p );
		p += chunk.length;

	}

	const raw = await inflate( compressed );
	const stride = width * channels;
	if ( raw.length < ( stride + 1 ) * height ) throw new Error( 'decodePng: truncated image data' );

	// undo the per-scanline filters in place
	const pixels = new Uint8Array( stride * height );
	for ( let y = 0; y < height; y ++ ) {

		const filter = raw[ y * ( stride + 1 ) ];
		const src = y * ( stride + 1 ) + 1;
		const dst = y * stride;
		const up = dst - stride;

		for ( let x = 0; x < stride; x ++ ) {

			const a = x >= channels ? pixels[ dst + x - channels ] : 0;
			const b = y > 0 ? pixels[ up + x ] : 0;
			const c = x >= channels && y > 0 ? pixels[ up + x - channels ] : 0;
			let value = raw[ src + x ];
			if ( filter === 1 ) value += a;
			else if ( filter === 2 ) value += b;
			else if ( filter === 3 ) value += ( a + b ) >> 1;
			else if ( filter === 4 ) value += paeth( a, b, c );
			pixels[ dst + x ] = value & 255;

		}

	}

	if ( channels === 4 ) return { width, height, data: pixels };

	// expand to RGBA
	const data = new Uint8Array( width * height * 4 );
	for ( let i = 0, j = 0, n = width * height; i < n; i ++, j += 4 ) {

		if ( channels === 3 ) {

			data[ j ] = pixels[ i * 3 ];
			data[ j + 1 ] = pixels[ i * 3 + 1 ];
			data[ j + 2 ] = pixels[ i * 3 + 2 ];
			data[ j + 3 ] = 255;

		} else if ( channels === 1 ) {

			data[ j ] = data[ j + 1 ] = data[ j + 2 ] = pixels[ i ];
			data[ j + 3 ] = 255;

		} else {

			data[ j ] = data[ j + 1 ] = data[ j + 2 ] = pixels[ i * 2 ];
			data[ j + 3 ] = pixels[ i * 2 + 1 ];

		}

	}

	return { width, height, data };

}
