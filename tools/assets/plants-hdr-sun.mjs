#!/usr/bin/env node
// Find the sun in an equirect Radiance .hdr and print its direction in three.js equirect convention
// (u = atan2(z,x)/2pi + 0.5, v = asin(y)/pi + 0.5, HDRLoader flipY).   node tools/assets/plants-hdr-sun.mjs <file.hdr>
import { readFileSync } from 'node:fs';
const buf = readFileSync( process.argv[ 2 ] );
let p = 0;
const line = () => {

	let s = '';
	while ( buf[ p ] !== 10 ) s += String.fromCharCode( buf[ p ++ ] );
	p ++;
	return s;

};
let l;
while ( ( l = line() ) !== '' ) { /* header */ }
const m = /-Y (\d+) \+X (\d+)/.exec( line() );
const H = + m[ 1 ], W = + m[ 2 ];
const lum = new Float32Array( W * H );
const scan = new Uint8Array( W * 4 );
for ( let y = 0; y < H; y ++ ) {

	if ( buf[ p ] !== 2 || buf[ p + 1 ] !== 2 ) throw new Error( 'only new RLE supported' );
	p += 4;
	for ( let c = 0; c < 4; c ++ ) {

		let x = 0;
		while ( x < W ) {

			let n = buf[ p ++ ];
			if ( n > 128 ) {

				n -= 128;
				const v = buf[ p ++ ];
				while ( n -- ) scan[ ( x ++ ) * 4 + c ] = v;

			} else while ( n -- ) scan[ ( x ++ ) * 4 + c ] = buf[ p ++ ];

		}

	}

	for ( let x = 0; x < W; x ++ ) {

		const e = scan[ x * 4 + 3 ];
		const f = e ? Math.pow( 2, e - 136 ) : 0;
		lum[ y * W + x ] = ( scan[ x * 4 ] * 0.2126 + scan[ x * 4 + 1 ] * 0.7152 + scan[ x * 4 + 2 ] * 0.0722 ) * f;

	}

}

let max = 0;
for ( const v of lum ) if ( v > max ) max = v;
// centroid of the pixels above 50% of the peak
let sx = 0, sy = 0, sz = 0, sw = 0, total = 0, sunE = 0;
for ( let y = 0; y < H; y ++ ) {

	const v = 1 - ( y + 0.5 ) / H, th = ( v - 0.5 ) * Math.PI, dOmega = Math.cos( th ) * ( Math.PI / H ) * ( 2 * Math.PI / W );
	for ( let x = 0; x < W; x ++ ) {

		const L = lum[ y * W + x ];
		total += L * dOmega * Math.max( 0, Math.sin( th ) );
		if ( L < max * 0.5 ) continue;
		const ph = ( ( x + 0.5 ) / W - 0.5 ) * 2 * Math.PI;
		sx += Math.cos( ph ) * Math.cos( th ) * L; sy += Math.sin( th ) * L; sz += Math.sin( ph ) * Math.cos( th ) * L; sw += L;
		sunE += L * dOmega * Math.max( 0, Math.sin( th ) );

	}

}

const d = [ sx / sw, sy / sw, sz / sw ];
const len = Math.hypot( ...d );
console.log( JSON.stringify( { W, H, peakLuminance: max, sunDir: d.map( ( v ) => + ( v / len ).toFixed( 4 ) ), elevationDeg: + ( Math.asin( d[ 1 ] / len ) * 180 / Math.PI ).toFixed( 1 ), skyIrradianceUp: + total.toFixed( 3 ), sunDiscIrradianceUp: + sunE.toFixed( 3 ) } ) );
