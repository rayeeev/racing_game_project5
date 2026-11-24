#!/usr/bin/env node
// Candidate / final texture set statistics.
//
//   node tools/assets/tex-stats.mjs --src <polyhavenId> [<polyhavenId> ...]     raw downloads in assets-src/textures/<id>/
//   node tools/assets/tex-stats.mjs --set <name> [<name> ...]                   delivered sets in public/assets/textures/<name>/
//   add --json to print machine readable output
//
// Prints per set: albedo average colour (linear + sRGB), luminance percentiles, saturation, mean AO / roughness / metalness,
// normal map sanity, seam ratio (wrap edge vs interior, ~1 = seamless) and the baked-directional-light correlation
// (|directional| < ~0.12 = clean de-lit albedo).

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { albedoStats, channelStats, seamRatio, bakedLightCheck, normalStats, meta } from './tex-lib.mjs';

const argv = process.argv.slice( 2 );
const json = argv.includes( '--json' );
const mode = argv.includes( '--set' ) ? 'set' : 'src';
const names = argv.filter( ( a ) => ! a.startsWith( '--' ) );

export function findMaps( mode, name ) {

	if ( mode === 'set' ) {

		const dir = resolve( 'public/assets/textures', name );
		return { dir, albedo: join( dir, 'albedo.jpg' ), normal: join( dir, 'normal.jpg' ), arm: join( dir, 'arm.jpg' ), height: join( dir, 'height.jpg' ) };

	}

	const dir = resolve( 'assets-src/textures', name );
	const files = existsSync( dir ) ? readdirSync( dir ) : [];
	const pick = ( tag ) => {

		const re = new RegExp( `_(${tag})_(\\d+)k\\.jpg$` );
		const f = files.filter( ( n ) => re.test( n ) ).sort( ( a, b ) => Number( re.exec( b )[ 2 ] ) - Number( re.exec( a )[ 2 ] ) )[ 0 ];
		return f ? join( dir, f ) : null;

	};
	// Poly Haven names the base colour map "diff" for most assets but "diffuse"/"col" for a few older ones
	return { dir, albedo: pick( 'diff|diffuse|col|color' ), normal: pick( 'nor_gl' ), arm: pick( 'arm' ), height: pick( 'disp' ) };

}

const out = [];
for ( const name of names ) {

	const m = findMaps( mode, name );
	if ( ! m.albedo || ! existsSync( m.albedo ) ) {

		console.error( `${name}: no albedo found in ${m.dir}` );
		continue;

	}

	const a = await albedoStats( m.albedo );
	const arm = await channelStats( m.arm );
	const nrm = await normalStats( m.normal );
	const seamA = await seamRatio( m.albedo );
	const seamN = await seamRatio( m.normal );
	const seamH = m.height ? await seamRatio( m.height ) : null;
	const baked = await bakedLightCheck( m.albedo, m.normal, m.arm );
	const metas = { albedo: await meta( m.albedo ), normal: await meta( m.normal ), arm: await meta( m.arm ), height: m.height ? await meta( m.height ) : null };
	const hgt = m.height ? await channelStats( m.height ) : null;
	out.push( { name, ...a, ao: arm.mean[ 0 ], roughness: arm.mean[ 1 ], roughnessStd: arm.std[ 1 ], roughnessRange: [ arm.min[ 1 ], arm.max[ 1 ] ], metalness: arm.mean[ 2 ], normal: nrm, seam: { albedo: seamA, normal: seamN, height: seamH }, baked, height: hgt ? { mean: hgt.mean[ 0 ], std: hgt.std[ 0 ], min: hgt.min[ 0 ], max: hgt.max[ 0 ] } : null, metas } );

}

if ( json ) {

	console.log( JSON.stringify( out, null, 1 ) );

} else {

	const pad = ( s, n ) => String( s ).padEnd( n );
	console.log( pad( 'name', 22 ) + pad( 'avgSRGB', 9 ) + pad( 'lumLin', 8 ) + pad( 'sat', 6 ) + pad( 'lum p1/50/99', 14 ) + pad( 'AO', 6 ) + pad( 'rough(sd)', 12 ) + pad( 'metal', 7 ) + pad( 'nrmSlope', 9 ) + pad( 'seamA u/v', 11 ) + pad( 'seamN u/v', 11 ) + pad( 'baked dir(rx,ry) rAO', 26 ) + 'sizes a/n/arm/h' );
	for ( const o of out ) {

		const sz = ( k ) => ( o.metas[ k ] ? `${o.metas[ k ].width}c${o.metas[ k ].channels}` : '-' );
		console.log(
			pad( o.name, 22 ) + pad( o.avgColorSRGB, 9 ) + pad( o.avgLuminanceLinear.toFixed( 3 ), 8 ) + pad( o.avgSaturation.toFixed( 2 ), 6 ) + pad( o.lumSRGB_p01_p50_p99.join( '/' ), 14 ) +
			pad( o.ao.toFixed( 2 ), 6 ) + pad( `${o.roughness.toFixed( 2 )}(${o.roughnessStd.toFixed( 2 )})`, 12 ) + pad( o.metalness.toFixed( 2 ), 7 ) + pad( o.normal.meanSlope.toFixed( 3 ), 9 ) +
			pad( `${o.seam.albedo.u}/${o.seam.albedo.v}`, 11 ) + pad( `${o.seam.normal.u}/${o.seam.normal.v}`, 11 ) +
			pad( `${o.baked.directional.toFixed( 3 )}(${o.baked.rx},${o.baked.ry}) ${o.baked.rAO}`, 26 ) + `${sz( 'albedo' )}/${sz( 'normal' )}/${sz( 'arm' )}/${sz( 'height' )}`
		);

	}

}
