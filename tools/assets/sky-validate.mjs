#!/usr/bin/env node
// Validates the delivered sky presets:
//   - env.hdr / sky.hdr parse with three.js' own HDRLoader (Node, no DOM) and match this pipeline's decoder
//   - sky.hdr / sky_2k.hdr are byte-identical to the raw downloads (and show the same panorama), env.hdr has no value above
//     the half-float range
//   - meta.json / presets.json are consistent (unit sun vector, az/el, energy bookkeeping)
//   node tools/assets/sky-validate.mjs

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FloatType } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { readHDR, rowSolidAngle, luminance, dirFromAzEl, downsampleEquirect } from './sky-lib.mjs';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../..' );
const OUT = join( ROOT, 'public/assets/sky' );
const md5 = ( f ) => createHash( 'md5' ).update( readFileSync( f ) ).digest( 'hex' );
let failures = 0;
const check = ( ok, msg ) => { if ( ! ok ) { failures ++; console.log( '  FAIL: ' + msg ); } };

const presets = JSON.parse( readFileSync( join( OUT, 'presets.json' ), 'utf8' ) );
check( Array.isArray( presets ) && presets.length === 4, 'presets.json must list 4 presets' );
let total = statSync( join( OUT, 'presets.json' ) ).size;

for ( const p of presets ) {

	const dir = join( OUT, p.id );
	const meta = JSON.parse( readFileSync( join( dir, 'meta.json' ), 'utf8' ) );
	check( JSON.stringify( meta ) === JSON.stringify( p.meta ), `${p.id}: presets.json meta differs from meta.json` );
	for ( const f of readdirSync( dir ) ) total += statSync( join( dir, f ) ).size;

	// raw download untouched
	const raw = join( ROOT, 'assets-src/sky', meta.sourceId, meta.sourceId + '_4k.hdr' );
	check( md5( raw ) === md5( join( dir, 'sky.hdr' ) ), `${p.id}: sky.hdr is not byte-identical to the download` );

	// optional 2k background: untouched download of the same panorama (same orientation and units as sky.hdr)
	const raw2k = join( ROOT, 'assets-src/sky', meta.sourceId + '_2k', meta.sourceId + '_2k.hdr' );
	check( md5( raw2k ) === md5( join( dir, 'sky_2k.hdr' ) ), `${p.id}: sky_2k.hdr is not byte-identical to the download` );
	{

		const a = downsampleEquirect( readHDR( join( dir, 'sky.hdr' ) ), 16 ), b2 = readHDR( join( dir, 'sky_2k.hdr' ) );
		check( b2.width === 2048 && b2.height === 1024, `${p.id}: sky_2k.hdr must be 2048x1024` );
		const b = downsampleEquirect( b2, 8 );
		// compare the two panoramas at 256x128 (sun pixel excluded: its peak depends on the resampling filter)
		let sum = 0, n = 0, worst = 0;
		for ( let i = 0; i < a.width * a.height; i ++ ) {

			const la = luminance( a.data[ i * 3 ], a.data[ i * 3 + 1 ], a.data[ i * 3 + 2 ] ), lb = luminance( b.data[ i * 3 ], b.data[ i * 3 + 1 ], b.data[ i * 3 + 2 ] );
			if ( la > 50 ) continue;
			const rel = Math.abs( la - lb ) / Math.max( la, 1e-3 );
			sum += rel; n ++;
			if ( rel > worst ) worst = rel;

		}

		check( sum / n < 0.01 && worst < 0.2, `${p.id}: sky_2k.hdr does not match sky.hdr (mean ${( sum / n * 100 ).toFixed( 2 )} %, worst ${( worst * 100 ).toFixed( 1 )} %)` );
		console.log( `[${p.id}] sky_2k.hdr vs sky.hdr at 256x128: mean |diff| ${( sum / n * 100 ).toFixed( 3 )} %, worst ${( worst * 100 ).toFixed( 2 )} %` );

	}

	// three.js HDRLoader agreement
	const report = [];
	for ( const name of [ 'env.hdr', 'sky.hdr' ] ) {

		const buf = readFileSync( join( dir, name ) );
		const three = new HDRLoader().setDataType( FloatType ).parse( buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength ) );
		const mine = readHDR( join( dir, name ) );
		check( three.width === mine.width && three.height === mine.height, `${p.id}/${name}: size mismatch` );
		let maxRel = 0, peak = 0;
		for ( let i = 0, n = mine.width * mine.height; i < n; i ++ ) for ( let k = 0; k < 3; k ++ ) {

			const a = three.data[ i * 4 + k ], b = mine.data[ i * 3 + k ];
			if ( b > peak ) peak = b;
			const rel = Math.abs( a - b ) / Math.max( 1e-6, Math.abs( b ) );
			if ( rel > maxRel ) maxRel = rel;

		}

		check( maxRel < 1e-5, `${p.id}/${name}: decoder mismatch ${maxRel}` );
		if ( name === 'env.hdr' ) {

			check( mine.width === 1024 && mine.height === 512, `${p.id}: env.hdr must be 1024x512` );
			check( peak < 65504, `${p.id}: env.hdr peak ${peak} exceeds the half-float range` );

		} else check( mine.width === 4096 && mine.height === 2048, `${p.id}: sky.hdr must be 4096x2048` );
		report.push( `${name} ${mine.width}x${mine.height} peak ${peak.toPrecision( 4 )} (three.js HDRLoader max rel. diff ${maxRel.toExponential( 1 )})` );

	}

	// meta consistency
	const s = meta.sunDirection;
	check( Math.abs( Math.hypot( ...s ) - 1 ) < 1e-4, `${p.id}: sunDirection is not unit length` );
	const d = dirFromAzEl( meta.sunAzimuthDeg, meta.sunElevationDeg );
	check( Math.hypot( d[ 0 ] - s[ 0 ], d[ 1 ] - s[ 1 ], d[ 2 ] - s[ 2 ] ) < 2e-4, `${p.id}: az/el do not reproduce sunDirection` );
	check( Math.abs( Math.max( ...meta.sunColor ) - 1 ) < 1e-6, `${p.id}: sunColor must be normalised to max = 1` );
	check( meta.hasSun === ( meta.sunIntensity > 0 ), `${p.id}: hasSun / sunIntensity mismatch` );
	check( meta.horizonColors.length === 8, `${p.id}: horizonColors must have 8 entries` );

	// energy bookkeeping: total flux of sky.hdr == flux of env.hdr + sun (sum of radiance * solid angle)
	const flux = ( img ) => {

		const t = [ 0, 0, 0 ];
		for ( let r = 0; r < img.height; r ++ ) {

			const sa = rowSolidAngle( r, img.width, img.height );
			for ( let c = 0; c < img.width; c ++ ) for ( let k = 0; k < 3; k ++ ) t[ k ] += img.data[ ( r * img.width + c ) * 3 + k ] * sa;

		}

		return t;

	};
	const fs = flux( readHDR( join( dir, 'sky.hdr' ) ) ), fe = flux( readHDR( join( dir, 'env.hdr' ) ) );
	const sum = fe.map( ( v, k ) => v + meta.sunColor[ k ] * meta.sunIntensity );
	const rel = luminance( ...sum ) / luminance( ...fs ) - 1;
	check( Math.abs( rel ) < 2e-3, `${p.id}: flux(env) + sun differs from flux(sky) by ${( rel * 100 ).toFixed( 3 )} %` );

	console.log( `[${p.id}] ${report.join( ' | ' )} | flux(env)+sun vs flux(sky): ${( rel * 100 ).toFixed( 4 )} %` );

}

console.log( `total size of public/assets/sky: ${total} bytes (${( total / 1048576 ).toFixed( 1 )} MB)` );
console.log( failures ? `${failures} FAILURE(S)` : 'all checks passed' );
process.exit( failures ? 1 : 0 );
