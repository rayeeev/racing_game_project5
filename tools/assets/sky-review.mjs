#!/usr/bin/env node
// Renders the verification screenshots of all sky presets with the running dev server (http://127.0.0.1:5173).
//
//   node tools/assets/sky-review.mjs <outDir> [presetId ...]
//
// Per preset:
//   <id>_1_toward_sun.png        dev/preview-sky.html mode=dir   view=sun   (marker ring at meta.sunDirection, shadows toward the camera)
//   <id>_1b_sun_marker_zoom.png  camera aimed at meta.sunDirection, 9 deg fov, very low exposure (sun presets): the disc must sit inside the tick marks
//   <id>_2_side.png              mode=dir view=side  (shadows must follow the cyan arrow, away from the sun)
//   <id>_2b_top.png              mode=dir view=top
//   <id>_3_energy.png            mode=energy (sky.hdr as IBL vs exact reference vs env.hdr + DirectionalLight) + measured ratios
//   <id>_4_beauty.png            mode=beauty, ACES at meta.exposure.aces (car, grey ground, exposure cards)
//   <id>_4b_beauty_toward_sun.png
//   <id>_4c_beauty_agx.png       AgX at meta.exposure.agx
//   <id>_5_viewer_toward_sun.png / <id>_5b_viewer_side.png   generic dev/viewer.html with the car (convention cross-check)
// Prints the exposure-card readings and energy ratios; the last line is a JSON summary.

import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { sRGBToLinear } from './sky-lib.mjs';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../..' );
const BASE = 'http://127.0.0.1:5173';
const [ outDirArg, ...only ] = process.argv.slice( 2 );
if ( ! outDirArg ) { console.error( 'usage: node tools/assets/sky-review.mjs <outDir> [presetId ...]' ); process.exit( 2 ); }
const outDir = resolve( outDirArg );
mkdirSync( outDir, { recursive: true } );

const presets = JSON.parse( readFileSync( join( ROOT, 'public/assets/sky/presets.json' ), 'utf8' ) ).filter( ( p ) => ! only.length || only.includes( p.id ) );

function shot( url, out, evalExpr = null, width = 1600, height = 900 ) {

	const args = [ join( ROOT, 'tools/shot.mjs' ), '--url', url, '--out', out, '--wait-for', 'window.__ready === true', '--delay', '500', '--width', String( width ), '--height', String( height ) ];
	if ( evalExpr ) args.push( '--eval', evalExpr );
	return new Promise( ( res ) => {

		execFile( 'node', args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }, ( err, stdout ) => {

			const lines = stdout.trim().split( '\n' );
			let summary = {};
			try { summary = JSON.parse( lines[ lines.length - 1 ] ); } catch { summary = { ok: false, errors: [ 'no summary: ' + stdout.slice( - 300 ) ] }; }
			let value = null;
			const ev = lines.find( ( l ) => l.startsWith( '[shot] eval result: ' ) );
			if ( ev ) { try { value = JSON.parse( JSON.parse( ev.slice( '[shot] eval result: '.length ) ) ); } catch { value = null; } }
			res( { ok: summary.ok === true && ( summary.errors || [] ).length === 0, errors: summary.errors || [], value, out } );

		} );

	} );

}

async function readCards( file, cards ) {

	const { data, info } = await sharp( file ).removeAlpha().raw().toBuffer( { resolveWithObject: true } );
	const out = {};
	for ( const c of cards || [] ) {

		const s = [ 0, 0, 0 ];
		let n = 0;
		for ( let y = c.y - 4; y <= c.y + 4; y ++ ) for ( let x = c.x - 4; x <= c.x + 4; x ++ ) {

			if ( x < 0 || y < 0 || x >= info.width || y >= info.height ) continue;
			const o = ( y * info.width + x ) * 3;
			s[ 0 ] += data[ o ]; s[ 1 ] += data[ o + 1 ]; s[ 2 ] += data[ o + 2 ]; n ++;

		}

		if ( ! n ) continue;
		const rgb = s.map( ( v ) => Math.round( v / n ) );
		const lin = rgb.map( ( v ) => sRGBToLinear( v / 255 ) );
		out[ c.name ] = { srgb: rgb, Y: Number( ( 0.2126 * lin[ 0 ] + 0.7152 * lin[ 1 ] + 0.0722 * lin[ 2 ] ).toFixed( 3 ) ) };

	}

	return out;

}

const summary = {};
const failures = [];

for ( const { id, meta } of presets ) {

	const q = `${BASE}/dev/preview-sky.html?preset=${id}`;
	const f = ( name ) => join( outDir, `${id}_${name}.png` );
	const jobs = [];
	const run = ( name, url, evalExpr ) => jobs.push( shot( url, f( name ), evalExpr ).then( ( r ) => { if ( ! r.ok ) failures.push( `${id}_${name}: ${r.errors.join( ' | ' ).slice( 0, 300 )}` ); return [ name, r ]; } ) );

	run( '1_toward_sun', `${q}&mode=dir&view=sun` );
	if ( meta.hasSun ) run( '1b_sun_marker_zoom', `${q}&mode=dir&view=custom&yaw=${meta.sunAzimuthDeg}&pitch=${meta.sunElevationDeg}&fov=9&exposure=0.0006` );
	run( '2_side', `${q}&mode=dir&view=side` );
	if ( meta.hasSun ) run( '2b_top', `${q}&mode=dir&view=top` );
	await Promise.all( jobs.splice( 0 ) );

	run( '3_energy', `${q}&mode=energy`, 'JSON.stringify({ variants: window.__energy.variants, ratios: window.__energy.ratios })' );
	run( '4_beauty', `${q}&mode=beauty&view=front&tone=aces`, 'JSON.stringify(window.__cards)' );
	run( '4b_beauty_toward_sun', `${q}&mode=beauty&view=sun&tone=aces`, 'JSON.stringify(window.__cards)' );
	run( '4c_beauty_agx', `${q}&mode=beauty&view=front&tone=agx`, 'JSON.stringify(window.__cards)' );
	const res = Object.fromEntries( await Promise.all( jobs.splice( 0 ) ) );

	// generic viewer cross-check (same conventions as the rest of the asset pipeline)
	const s = meta.sunDirection;
	const viewer = `${BASE}/dev/viewer.html?models=/assets-src/car/ferrari/ferrari.glb&hdr=${meta.files.sky}&envhdr=${meta.files.env}`
		+ `&sun=${s.join( ',' )}&sunI=${meta.sunIntensity}&sunColor=${meta.sunColorHex}&exposure=${meta.exposure.aces}&tone=aces&groundColor=777777`;
	const wide = meta.sunElevationDeg > 30;
	run( '5_viewer_toward_sun', `${viewer}&az=${( meta.sunAzimuthDeg + 180 ).toFixed( 2 )}&el=${wide ? 2 : 3}&dist=${wide ? 0.75 : 1.6}&fov=${wide ? 112 : 45}` );
	run( '5b_viewer_side', `${viewer}&az=${( meta.sunAzimuthDeg + 90 ).toFixed( 2 )}&el=10&dist=1.5&fov=45` );
	await Promise.all( jobs.splice( 0 ) );

	const e = res[ '3_energy' ].value;
	const entry = { exposure: meta.exposure };
	if ( e ) {

		const lum = ( c ) => 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
		entry.energy = {
			sunFacingCap_E_lum: { A_skyAsIBL: + lum( e.variants.A.capE ).toFixed( 3 ), Aref_exact: + lum( e.variants.Aref.capE ).toFixed( 3 ), B_envPlusLight: + lum( e.variants.B.capE ).toFixed( 3 ) },
			upFacing_E_lum: { A_skyAsIBL: + lum( e.variants.A.upE ).toFixed( 3 ), Aref_exact: + lum( e.variants.Aref.upE ).toFixed( 3 ), B_envPlusLight: + lum( e.variants.B.upE ).toFixed( 3 ) },
			ratios: Object.fromEntries( Object.entries( e.ratios ).map( ( [ k, v ] ) => [ k, + v.toFixed( 4 ) ] ) ),
		};

	}

	entry.cards = {
		aces_front: await readCards( f( '4_beauty' ), res[ '4_beauty' ].value ),
		aces_towardSun: await readCards( f( '4b_beauty_toward_sun' ), res[ '4b_beauty_toward_sun' ].value ),
		agx_front: await readCards( f( '4c_beauty_agx' ), res[ '4c_beauty_agx' ].value ),
	};
	summary[ id ] = entry;

	console.log( `[${id}] exposure aces ${meta.exposure.aces} agx ${meta.exposure.agx}` );
	if ( entry.energy ) console.log( `  energy: sun-facing cap B/A ${entry.energy.ratios.B_over_A_cap}  B/A' ${entry.energy.ratios.B_over_Aref_cap}  B/CPU ${entry.energy.ratios.B_cap_over_expected} | up-facing B/A ${entry.energy.ratios.B_over_A_up}  B/A' ${entry.energy.ratios.B_over_Aref_up}  B/CPU ${entry.energy.ratios.B_up_over_expected}` );
	for ( const [ k, cards ] of Object.entries( entry.cards ) ) console.log( `  cards ${k}: ` + Object.entries( cards ).map( ( [ n, c ] ) => `${n} ${c.srgb.join( ',' )} (Y ${c.Y})` ).join( ' | ' ) );

}

if ( failures.length ) console.log( 'FAILURES:\n' + failures.join( '\n' ) );
console.log( JSON.stringify( { ok: failures.length === 0, outDir, summary } ) );
process.exit( failures.length ? 1 : 0 );
