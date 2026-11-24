#!/usr/bin/env node
// Regenerates every review image of the texture pipeline (needs the dev server on http://127.0.0.1:5173).
//
//   node tools/assets/tex-review.mjs <absolute out dir> [--only <substring>]
//
// Rendered views (dev/preview-tex.html through tools/shot.mjs, headless Chrome + WebGPU) and offline sheets (sharp).
// Exits non-zero if any page reported a console error.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve( process.argv[ 2 ] ?? '' );
if ( ! process.argv[ 2 ] ) {

	console.error( 'usage: tex-review.mjs <out dir> [--only <substring>]' );
	process.exit( 2 );

}

const only = process.argv.includes( '--only' ) ? process.argv[ process.argv.indexOf( '--only' ) + 1 ] : null;
mkdirSync( out, { recursive: true } );
const tmp = join( out, '_tmp' );

const PAGE = 'http://127.0.0.1:5173/dev/preview-tex.html';
const GOLD = 'hdr=/assets-src/textures/_hdri/syferfontein_6d_clear_puresky/syferfontein_6d_clear_puresky_2k.hdr';
const LUTS = '/assets/textures/fx/luts';
const LUT_VIEW = `mode=scene&sets=grass_meadow,rock_cliff&${GOLD}&envRot=285&exposure=0.42&labels=0`;

// [ file, query, width, height ]
const VIEWS = [
	[ 'grid_all_sets_midday.png', 'cols=6', 1900, 1000 ],
	[ 'grid_all_sets_golden_hour.png', `cols=6&${GOLD}&envRot=250&exposure=0.8`, 1900, 1000 ],
	[ 'asphalt_main_chase_midday.png', 'mode=road&sets=asphalt_main&stripW=8&camH=1.1&lookAhead=16&envRot=200', 1800, 1000 ],
	[ 'asphalt_main_chase_golden_hour.png', `mode=road&sets=asphalt_main&stripW=8&camH=1.1&lookAhead=16&${GOLD}&envRot=160`, 1800, 1000 ],
	[ 'asphalt_bumper_cam_golden_hour.png', `mode=road&sets=asphalt_main,asphalt_worn&stripW=3.6&camH=0.55&lookAhead=7&${GOLD}&envRot=215`, 1800, 1000 ],
	[ 'meadow_cliff_midday.png', 'mode=scene&sets=grass_meadow,rock_cliff&envRot=-25', 1800, 1000 ],
	[ 'meadow_cliff_golden_hour.png', `mode=scene&sets=grass_meadow,rock_cliff&${GOLD}&envRot=285&exposure=0.42`, 1800, 1000 ],
	[ 'meadow_cliff_midday_displaced.png', 'mode=scene&sets=grass_meadow,rock_cliff&disp=auto&envRot=-25&camZ=7&camH=1.6', 1800, 1000 ],
	[ 'grass_meadow_closeup_midday.png', 'mode=scene&sets=grass_meadow,rock_cliff&envRot=-25&camH=1.3&lookY=-6', 1800, 1000 ],
	[ 'rock_cliff_vs_rock_detail_at_5m.png', 'mode=wall&sets=rock_cliff,rock_detail&camZ=5&fov=60&camH=1.6&lookY=2.2&envRot=-25', 1800, 1000 ],
	[ 'displaced_ground_sets_2m.png', 'sets=dirt,rock_ground,shore,snow&cols=4&size=2&el=24&az=-20&disp=auto', 1800, 640 ],
	[ 'closeup_manmade_1p5m.png', 'sets=metal_galvanized,concrete,wood_weathered,wood_planks&cols=4&size=1.5&el=34&az=-18', 1800, 700 ],
	[ '_tmp/lut0.png', LUT_VIEW, 900, 500 ],
	[ '_tmp/lut1.png', `${LUT_VIEW}&lut=${LUTS}/presetpro_cinematic.3dl&lutI=1`, 900, 500 ],
	[ '_tmp/lut2.png', `${LUT_VIEW}&lut=${LUTS}/bourbon_64_warm.cube&lutI=0.5`, 900, 500 ],
	[ '_tmp/lut3.png', `${LUT_VIEW}&lut=${LUTS}/remy_24.cube&lutI=0.6`, 900, 500 ],
];

const node = ( args ) => spawnSync( process.execPath, args, { encoding: 'utf8' } );
let failures = 0;

for ( const [ file, query, w, h ] of VIEWS ) {

	if ( only && ! file.includes( only ) ) continue;
	const r = node( [ 'tools/shot.mjs', '--url', `${PAGE}?${query}`, '--out', join( out, file ), '--wait-for', 'window.__ready === true', '--delay', '700', '--width', String( w ), '--height', String( h ) ] );
	let summary = null;
	try { summary = JSON.parse( r.stdout.trim().split( '\n' ).pop() ); } catch ( e ) { /* handled below */ }
	const ok = summary && summary.ok && summary.errors.length === 0 && summary.webgpu === true;
	if ( ! ok ) failures ++;
	console.log( `${ok ? 'ok  ' : 'FAIL'} ${file}${ok ? '' : '  ' + JSON.stringify( summary?.errors ?? r.stderr ).slice( 0, 300 )}` );

}

// ---- offline sheets
const index = JSON.parse( readFileSync( resolve( 'public/assets/textures/index.json' ), 'utf8' ) );
const ids = index.sets.map( ( s ) => s.id );
const fxTex = index.fx.filter( ( f ) => f.type === 'texture' );
const sheets = [
	[ 'seam_cross_albedo_1to1.png', [ 'tools/assets/tex-seam.mjs', '--out', join( out, 'seam_cross_albedo_1to1.png' ), '--cell', '300', '--cols', '6', ...ids ] ],
	[ 'seam_cross_normal_1to1.png', [ 'tools/assets/tex-seam.mjs', '--out', join( out, 'seam_cross_normal_1to1.png' ), '--cell', '300', '--cols', '6', '--map', 'normal', ...ids ] ],
	[ 'tile3x3_albedo.png', [ 'tools/assets/tex-sheet.mjs', '--out', join( out, 'tile3x3_albedo.png' ), '--cell', '300', '--cols', '6', '--tile', '3', ...index.sets.map( ( s ) => 'public' + s.maps.albedo ) ] ],
	[ 'albedo_swatches.png', [ 'tools/assets/tex-swatches.mjs', '--out', join( out, 'albedo_swatches.png' ), '--rows', 'grass_meadow,grass_dry,forest_floor,dirt,gravel,rock_ground,rock_cliff,rock_detail,shore,snow;asphalt_main,asphalt_worn,concrete,metal_galvanized,wood_weathered,wood_planks' ] ],
	[ 'fx_sheet.png', [ 'tools/assets/tex-sheet.mjs', '--out', join( out, 'fx_sheet.png' ), '--cell', '216', '--cols', '8', '--bg', '26303c', '--labels', fxTex.map( ( f ) => `${f.id} ${f.width}${f.license.includes( 'NC' ) ? ' (NC)' : ''}` ).join( ',' ), ...fxTex.map( ( f ) => 'public' + f.file ) ] ],
	[ 'luts_in_engine_golden_hour.png', [ 'tools/assets/tex-sheet.mjs', '--out', join( out, 'luts_in_engine_golden_hour.png' ), '--cell', '880', '--cols', '2', '--aspect', '1.8', '--labels', 'no LUT (ACES only),lut_cinematic_neutral  presetpro_cinematic.3dl  intensity 1,lut_warm_bourbon  bourbon_64_warm.cube  intensity 0.5,lut_alpenglow_remy  remy_24.cube  intensity 0.6', ...[ 0, 1, 2, 3 ].map( ( i ) => join( tmp, `lut${i}.png` ) ) ] ],
];

for ( const [ file, args ] of sheets ) {

	if ( only && ! file.includes( only ) ) continue;
	const r = node( args );
	const ok = r.status === 0;
	if ( ! ok ) failures ++;
	console.log( `${ok ? 'ok  ' : 'FAIL'} ${file}${ok ? '' : '  ' + r.stderr.slice( 0, 300 )}` );

}

process.exit( failures ? 1 : 0 );
