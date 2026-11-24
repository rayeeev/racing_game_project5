#!/usr/bin/env node
// Diagnostic: radial luminance profile and encircled energy around the brightest region of an equirect HDR.
//   node tools/assets/sky-profile.mjs <file.hdr> [maxDeg=12]

import { readHDR, luminance, rowSolidAngle, pixelDir, azElFromDir } from './sky-lib.mjs';

const [ file, maxDegS = '12' ] = process.argv.slice( 2 );
const maxDeg = Number( maxDegS );
const img = readHDR( file );
const { width: W, height: H, data } = img;

let peak = 0, pc = 0, pr = 0, over = 0;
for ( let r = 0; r < H; r ++ ) for ( let c = 0; c < W; c ++ ) {

	const o = ( r * W + c ) * 3;
	const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
	if ( Math.max( data[ o ], data[ o + 1 ], data[ o + 2 ] ) > 65504 ) over ++;
	if ( L > peak ) { peak = L; pc = c; pr = r; }

}

const d0 = pixelDir( pc, pr, W, H );
// centroid of the pixels above 20 % of the peak within 1.5 deg
const cen = [ 0, 0, 0 ];
const cos15 = Math.cos( 1.5 * Math.PI / 180 );
const r0 = Math.max( 0, pr - 60 ), r1 = Math.min( H - 1, pr + 60 );
for ( let r = r0; r <= r1; r ++ ) {

	const sa = rowSolidAngle( r, W, H );
	for ( let c = 0; c < W; c ++ ) {

		const d = pixelDir( c, r, W, H );
		if ( d[ 0 ] * d0[ 0 ] + d[ 1 ] * d0[ 1 ] + d[ 2 ] * d0[ 2 ] < cos15 ) continue;
		const o = ( r * W + c ) * 3;
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		if ( L < 0.2 * peak ) continue;
		for ( let k = 0; k < 3; k ++ ) cen[ k ] += d[ k ] * L * sa;

	}

}

const cl = Math.hypot( ...cen );
const sun = cen.map( ( v ) => v / cl );
const ae = azElFromDir( sun );
console.log( `size ${W}x${H}  peak L ${peak.toPrecision( 5 )} at col ${pc} row ${pr}  pixels > 65504: ${over}` );
console.log( `sun centroid dir ${sun.map( ( v ) => v.toFixed( 5 ) ).join( ', ' )}  az ${ae.az.toFixed( 3 )}  el ${ae.el.toFixed( 3 )}` );

const step = 0.1;
const nb = Math.round( maxDeg / step );
const sumL = new Float64Array( nb ), sumSA = new Float64Array( nb ), maxL = new Float64Array( nb ), cnt = new Float64Array( nb );
const sumRGB = [ new Float64Array( nb ), new Float64Array( nb ), new Float64Array( nb ) ];
const cosMax = Math.cos( maxDeg * Math.PI / 180 );
for ( let r = 0; r < H; r ++ ) {

	const sa = rowSolidAngle( r, W, H );
	for ( let c = 0; c < W; c ++ ) {

		const d = pixelDir( c, r, W, H );
		const cs = d[ 0 ] * sun[ 0 ] + d[ 1 ] * sun[ 1 ] + d[ 2 ] * sun[ 2 ];
		if ( cs < cosMax ) continue;
		const ang = Math.acos( Math.min( 1, cs ) ) * 180 / Math.PI;
		const b = Math.min( nb - 1, Math.floor( ang / step ) );
		const o = ( r * W + c ) * 3;
		const L = luminance( data[ o ], data[ o + 1 ], data[ o + 2 ] );
		sumL[ b ] += L * sa; sumSA[ b ] += sa; cnt[ b ] ++;
		for ( let k = 0; k < 3; k ++ ) sumRGB[ k ][ b ] += data[ o + k ] * sa;
		if ( L > maxL[ b ] ) maxL[ b ] = L;

	}

}

let E = 0;
const ER = [ 0, 0, 0 ];
console.log( 'ring(deg)   n    meanL       maxL     E(<r) lum     E rgb' );
for ( let b = 0; b < nb; b ++ ) {

	E += sumL[ b ];
	for ( let k = 0; k < 3; k ++ ) ER[ k ] += sumRGB[ k ][ b ];
	const show = b < 20 || ( b < 50 && b % 5 === 4 ) || b % 10 === 9;
	if ( show ) console.log( `${( ( b + 1 ) * step ).toFixed( 1 ).padStart( 5 )} ${String( cnt[ b ] ).padStart( 6 )} ${( sumL[ b ] / ( sumSA[ b ] || 1 ) ).toPrecision( 4 ).padStart( 10 )} ${maxL[ b ].toPrecision( 4 ).padStart( 10 )} ${E.toPrecision( 5 ).padStart( 10 )}   ${ER.map( ( v ) => v.toPrecision( 4 ) ).join( ' ' )}` );

}
