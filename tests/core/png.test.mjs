import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodePng } from '../../src/core/png.js';
import { makeRng } from '../../src/core/rng.js';

async function roundTrip( width, height, channels, options = {} ) {

	const rng = makeRng( width * 31 + height * 7 + channels );
	const raw = new Uint8Array( width * height * channels );
	// smooth-ish content with noise so every PNG filter type gets exercised; alpha fully random (incl. 0)
	for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) for ( let c = 0; c < channels; c ++ ) {

		const i = ( y * width + x ) * channels + c;
		raw[ i ] = c === 3 ? Math.floor( rng() * 256 ) : ( x * 3 + y * 5 + c * 40 + Math.floor( rng() * 30 ) ) & 255;

	}

	const png = await sharp( raw, { raw: { width, height, channels } } ).png( options ).toBuffer();
	const out = await decodePng( png );
	assert.equal( out.width, width );
	assert.equal( out.height, height );
	for ( let i = 0, n = width * height; i < n; i ++ ) {

		for ( let c = 0; c < 4; c ++ ) {

			let expected;
			if ( channels === 4 ) expected = raw[ i * 4 + c ];
			else if ( channels === 3 ) expected = c < 3 ? raw[ i * 3 + c ] : 255;
			else expected = c < 3 ? raw[ i ] : 255;
			if ( out.data[ i * 4 + c ] !== expected ) assert.fail( `pixel ${i} channel ${c}: got ${out.data[ i * 4 + c ]}, expected ${expected}` );

		}

	}

}

test( 'decodePng returns exact RGBA bytes (alpha is not premultiplied)', async () => {

	await roundTrip( 67, 41, 4 );
	await roundTrip( 769, 769, 4, { compressionLevel: 9, adaptiveFiltering: true } );

} );

test( 'decodePng expands RGB and greyscale', async () => {

	await roundTrip( 50, 33, 3, { adaptiveFiltering: true } );
	await roundTrip( 40, 20, 1 );

} );

test( 'decodePng rejects non-PNG data', async () => {

	await assert.rejects( decodePng( new Uint8Array( 32 ) ), /not a PNG/ );

} );
