#!/usr/bin/env node
// Build the game-ready player car from the three.js "ferrari.glb" sample (Ferrari 458 Italia by vicent091036, CC BY 4.0).
//
//   node tools/assets/car-build.mjs [--src assets-src/car/ferrari/ferrari.glb] [--out public/assets/car]
//                                   [--no-ao] [--ao-samples 96] [--ao-cache <file>] [--keep-badges] [--meta <file.json>]
//
// What it does (see the structured report / car.json for the resulting conventions):
//   * flattens every source mesh to world space and splits it into loose parts (connected components)
//   * re-classifies the parts by ROLE (paint, glass, lamps, trim, interior ...) -> one mesh per role/material
//   * removes brand badges/lettering, rebuilds the tyres as UV-mapped lathes, adds brake calipers
//   * normalises the hierarchy: animated nodes have identity rest rotation and their origin on the rotation axis
//   * bakes per-vertex ambient occlusion (sky visibility) into COLOR_0
//   * writes car.glb (full detail) and car_lod1.glb (<= 35k triangles, same node names), Draco compressed
import { Document } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	makeIO, worldMatrix, readPrimitiveWorld, connectedComponents, subsetGeo, mergeGeos, cloneGeo, translateGeo, rotateGeo, setUv,
	bboxOf, triCount, weldGeo, buildBVH, bakeAO, latheX, fixWinding, windingStats, r3, r4,
} from './car-lib.mjs';
import { buildCaliper } from './car-caliper.mjs';

const argv = process.argv.slice( 2 );
const opt = ( k, d ) => ( argv.includes( '--' + k ) ? argv[ argv.indexOf( '--' + k ) + 1 ] : d );
const flag = ( k ) => argv.includes( '--' + k );
const SRC = opt( 'src', 'assets-src/car/ferrari/ferrari.glb' );
const OUT = opt( 'out', 'public/assets/car' );
const AO = ! flag( 'no-ao' );
const AO_SAMPLES = Number( opt( 'ao-samples', 96 ) );
const AO_CACHE = opt( 'ao-cache', null );
const KEEP_BADGES = flag( 'keep-badges' );
const META = opt( 'meta', null );
const LOD1_BUDGET = Number( opt( 'lod1-tris', 34000 ) );

const log = ( ...a ) => console.log( '[car-build]', ...a );
const t0 = Date.now();

// ---------------------------------------------------------------------------------------------------------------------
// 1. Load source, flatten to world space
// ---------------------------------------------------------------------------------------------------------------------
const io = await makeIO();
const srcDoc = await io.read( SRC );
const src = new Map(); // 'parent/node' -> geo (world space)
for ( const node of srcDoc.getRoot().listNodes() ) {

	if ( ! node.getMesh() ) continue;
	const parent = node.getParentNode() ? node.getParentNode().getName() : '';
	const m = worldMatrix( node );
	const prims = node.getMesh().listPrimitives();
	if ( prims.length !== 1 ) throw new Error( 'unexpected multi-primitive mesh ' + node.getName() );
	const { positions, normals, indices } = readPrimitiveWorld( prims[ 0 ], m );
	src.set( `${parent}/${node.getName()}`, { positions, normals, indices, uvs: null, ao: null, material: prims[ 0 ].getMaterial().getName() } );

}

log( 'source meshes:', src.size, 'triangles:', [ ...src.values() ].reduce( ( a, g ) => a + triCount( g ), 0 ) );

// ---------------------------------------------------------------------------------------------------------------------
// 2. Layout constants (measured from the source; all in metres, car space: +Y up, nose towards -Z, +X = car's right)
// ---------------------------------------------------------------------------------------------------------------------
const WHEELS = [ 'fl', 'fr', 'rl', 'rr' ];
const wheelSrcCentre = {}; // actual centre of each source wheel (tyre bbox centre)
for ( const w of WHEELS ) wheelSrcCentre[ w ] = bboxOf( src.get( `wheel_${w}/tire` ).positions ).center;
const tyreBox = {};
for ( const w of WHEELS ) tyreBox[ w ] = bboxOf( src.get( `wheel_${w}/tire` ).positions );
// symmetrised hub centres (the source is off by up to 14 mm left/right and the front-right wheel sits 2.7 mm high)
const frontX = ( Math.abs( wheelSrcCentre.fl[ 0 ] ) + Math.abs( wheelSrcCentre.fr[ 0 ] ) ) / 2;
const rearX = ( Math.abs( wheelSrcCentre.rl[ 0 ] ) + Math.abs( wheelSrcCentre.rr[ 0 ] ) ) / 2;
const frontZ = ( wheelSrcCentre.fl[ 2 ] + wheelSrcCentre.fr[ 2 ] ) / 2;
const rearZ = ( wheelSrcCentre.rl[ 2 ] + wheelSrcCentre.rr[ 2 ] ) / 2;
const TYRE_RADIUS = tyreBox.fl.size[ 1 ] / 2;
const wheelCentre = {
	fl: [ - frontX, TYRE_RADIUS, frontZ ], fr: [ frontX, TYRE_RADIUS, frontZ ],
	rl: [ - rearX, TYRE_RADIUS, rearZ ], rr: [ rearX, TYRE_RADIUS, rearZ ],
};
const tyreHalfWidth = { fl: tyreBox.fl.size[ 0 ] / 2, fr: tyreBox.fr.size[ 0 ] / 2, rl: tyreBox.rl.size[ 0 ] / 2, rr: tyreBox.rr.size[ 0 ] / 2 };
log( 'wheel centres (symmetrised):', JSON.stringify( Object.fromEntries( WHEELS.map( ( w ) => [ w, r4( wheelCentre[ w ] ) ] ) ) ), 'tyre radius', r4( TYRE_RADIUS ) );

// steering wheel frame: origin on the column axis at the horn-push centre; +Z = column axis pointing at the driver
const steerNode = srcDoc.getRoot().listNodes().find( ( n ) => n.getName() === 'steering_wheel' );
const STEER_ORIGIN = steerNode.getTranslation().slice();
const steerM = worldMatrix( steerNode );
// source local +Y points down the column (towards the dashboard) -> our +Z is the opposite direction
const STEER_AXIS = [ - steerM[ 4 ], - steerM[ 5 ], - steerM[ 6 ] ];
const STEER_TILT = Math.atan2( STEER_AXIS[ 1 ], STEER_AXIS[ 2 ] ); // rotation about X by -tilt takes +Z onto the axis
// column frame = Rx(-tilt): X = (1,0,0), Y = (0, cos, -sin), Z = (0, sin, cos)
const cT = Math.cos( STEER_TILT ), sT = Math.sin( STEER_TILT );
const STEER_R_INV = [ 1, 0, 0, 0, cT, - sT, 0, sT, cT ]; // rows = local axes (world -> local)
const STEER_QUAT = [ - Math.sin( STEER_TILT / 2 ), 0, 0, Math.cos( STEER_TILT / 2 ) ];
log( 'steering origin', r4( STEER_ORIGIN ), 'axis (towards driver)', r4( STEER_AXIS ), 'tilt deg', r3( STEER_TILT * 180 / Math.PI ) );

// ---------------------------------------------------------------------------------------------------------------------
// 3. Classification: source mesh + loose part -> target mesh (or null = drop)
// ---------------------------------------------------------------------------------------------------------------------
const near = ( c, x, y, z, tol = 0.03 ) => Math.abs( c.center[ 0 ] - x ) < tol && Math.abs( c.center[ 1 ] - y ) < tol && Math.abs( c.center[ 2 ] - z ) < tol;
const nearSym = ( c, x, y, z, tol = 0.03 ) => Math.abs( Math.abs( c.center[ 0 ] ) - x ) < tol && Math.abs( c.center[ 1 ] - y ) < tol && Math.abs( c.center[ 2 ] - z ) < tol;
const maxSize = ( c ) => Math.max( ...c.size );
// loose part sits inside the cabin (dashboard .. rear bulkhead, above the floor pan)
const inCabin = ( c ) => Math.abs( c.center[ 0 ] ) < 0.80 && c.center[ 2 ] > - 1.18 && c.center[ 2 ] < 0.80 && c.center[ 1 ] > 0.235 && maxSize( c ) < 1.75;
const inHeadlight = ( c ) => Math.abs( c.center[ 0 ] ) > 0.55 && Math.abs( c.center[ 0 ] ) < 0.90 && c.center[ 1 ] > 0.50 && c.center[ 1 ] < 0.85 && c.center[ 2 ] > - 2.1 && c.center[ 2 ] < - 1.40;
const side = ( c ) => ( c.center[ 0 ] < 0 ? 'l' : 'r' );
const BADGE = KEEP_BADGES ? 'badges' : null;

const badgeNotes = [];
// De-badging leaves holes where a badge sat in a cut-out of the body: FILL[kind] = true keeps the flat badge PLATE as a
// body-coloured blank (role bodyPaint) so the panel reads as one painted surface. The raised chrome frames are always dropped.
const isSideScript = ( c ) => Math.abs( c.center[ 0 ] ) > 0.905 && c.center[ 1 ] > 0.355 && c.center[ 1 ] < 0.395 && c.center[ 2 ] > 0.84 && c.center[ 2 ] < 1.0;
const isNoseBadge = ( c ) => near( c, - 0.004, 0.5865, - 2.0945, 0.02 );
const isFenderShield = ( c ) => nearSym( c, 0.917, 0.7375, - 0.803, 0.02 );
const FRAME_AS_BODY = ( process.env.CAR_BADGE_FRAMES || 'drop' ) === 'body';
function isChromeBadge( c ) {

	if ( near( c, 0, 0.84, 2.19, 0.04 ) && c.tris > 1000 ) return 'rear emblem';
	if ( near( c, 0, 0.289, - 2.198, 0.04 ) && c.tris > 1000 ) return 'front emblem';
	if ( Math.abs( c.center[ 0 ] ) < 0.13 && c.center[ 1 ] > 0.94 && c.center[ 1 ] < 0.956 && c.center[ 2 ] > 1.90 && c.center[ 2 ] < 1.935 ) return 'rear deck script';
	if ( isSideScript( c ) ) return 'side script';
	if ( isFenderShield( c ) ) return 'fender shield frame';
	if ( isNoseBadge( c ) ) return 'nose badge frame';
	if ( c.center[ 0 ] > 0.44 && c.center[ 0 ] < 0.53 && c.center[ 1 ] > 0.78 && c.center[ 1 ] < 0.805 && c.center[ 2 ] > - 0.60 && c.center[ 2 ] < - 0.575 ) return 'dashboard model script';
	return null;

}

const RULES = {
	'main/body': () => 'body',
	'main/glass': ( c ) => {

		if ( c.area > 1 ) return 'glass'; // windscreen
		if ( near( c, 0, 1.016, 0.573, 0.05 ) ) return 'glass'; // wind stop behind the seats
		if ( inHeadlight( c ) || ( Math.abs( c.center[ 0 ] ) > 0.6 && c.center[ 2 ] < - 1.4 ) ) return 'glass_lamps'; // headlamp covers
		if ( c.center[ 2 ] > 2.0 ) return maxSize( c ) > 0.08 ? 'glass_lamps' : `light_indicator_${side( c )}`; // tail lamp centre: clear lens / LED cluster
		if ( inCabin( c ) ) return 'interior_display';
		return 'glass_lamps';

	},
	'main/lights': () => 'light_headlight',
	'main/leds': ( c ) => ( Math.abs( c.center[ 0 ] ) > 0.9 ? `light_indicator_${side( c )}` : 'light_drl' ),
	'main/brakes': ( c ) => ( Math.abs( c.center[ 0 ] ) < 0.3 ? 'light_brake_high' : 'taillight_lens' ),
	'main/lights_red': ( c ) => {

		if ( inCabin( c ) ) return 'interior_stitching'; // red buttons on the tunnel
		if ( Math.abs( c.center[ 0 ] ) > 0.7 && c.center[ 1 ] > 0.8 ) return 'light_tail';
		if ( Math.abs( c.center[ 0 ] ) < 0.3 ) return 'light_brake_high';
		// lower bumper lamps: lens = light, housing + bulb = reflector
		if ( c.tris === 270 ) return c.center[ 0 ] < 0 ? 'light_fog' : 'light_reverse';
		return 'chrome';

	},
	'main/yellow_trim': ( c ) => {

		if ( inCabin( c ) ) return 'interior_gauge';
		if ( KEEP_BADGES ) return BADGE;
		// yellow plates of the nose badge and of the two fender shields: they close cut-outs of the bonnet / front wings
		if ( isNoseBadge( c ) ) { badgeNotes.push( 'nose badge plate -> body-colour blank' ); return 'body'; }
		if ( isFenderShield( c ) ) { badgeNotes.push( 'fender shield plate -> body-colour blank' ); return 'body'; }
		return null;

	},
	'main/chrome': ( c ) => {

		const b = isChromeBadge( c );
		if ( b && FRAME_AS_BODY && ! KEEP_BADGES && / frame$/.test( b ) ) { badgeNotes.push( b + ' -> body colour' ); return 'body'; }
		if ( b ) { badgeNotes.push( b ); return BADGE; }
		if ( Math.abs( c.center[ 0 ] ) > 1.0 && c.center[ 1 ] > 0.8 ) return 'mirror';
		if ( near( c, 0, 1.091, - 0.286, 0.04 ) ) return 'mirror';
		if ( c.center[ 2 ] > 2.15 && c.center[ 1 ] < 0.5 ) return 'exhaust_tips';
		if ( inCabin( c ) ) return 'interior_metal';
		return 'chrome';

	},
	'main/metal': ( c ) => {

		if ( inHeadlight( c ) ) return 'light_drl'; // third row of LED dots
		if ( nearSym( c, 0.352, 1.2, - 0.116, 0.03 ) ) return 'interior_plastic'; // warning labels on the sun visors
		if ( inCabin( c ) ) return 'interior_metal';
		if ( c.center[ 2 ] > 2.0 && c.center[ 1 ] < 0.5 ) return 'trim_black'; // exhaust surround / heat shields
		if ( c.center[ 1 ] < 0.235 ) return 'trim_black'; // undertray plates
		return 'chrome'; // number-plate lamps, door lock barrels
	},
	'main/plastic_gray': ( c ) => {

		if ( inHeadlight( c ) ) return 'headlight_housing';
		if ( c.center[ 2 ] > 2.15 && c.center[ 1 ] < 0.5 ) return 'exhaust_tips'; // inner pipes
		if ( inCabin( c ) ) return 'interior_plastic';
		return 'trim_black';

	},
	'main/grills': () => 'grille',
	'main/wipers': () => 'trim_black',
	'main/interior_light': ( c ) => ( inCabin( c ) ? 'interior_plastic' : 'trim_black' ), // source material "Interior_dark"
	'main/interior_dark': ( c ) => { // source material "Interior_light"

		if ( nearSym( c, 0.347, 0.645, 0.203, 0.03 ) && c.tris > 500 ) return 'interior_seats';
		if ( inHeadlight( c ) ) return 'headlight_housing';
		if ( near( c, - 0.005, 0.293, - 2.172, 0.02 ) ) { badgeNotes.push( 'front emblem bracket' ); return BADGE; }
		if ( isSideScript( c ) ) { badgeNotes.push( 'side script backing' ); return BADGE; }
		if ( inCabin( c ) ) return 'interior_plastic';
		return 'trim_black';

	},
	'main/leather': () => 'interior_leather',
	'main/trim': () => 'interior_stitching',
	'main/carpet': () => 'interior_carpet',
	'main/carbon_fibre_trim': () => 'interior_carbon',
	'main/carbon fibre': () => 'interior_carbon',
	'main/blue': () => 'steering_wheel_plastic',
	'steering_wheel/steering_carbon': () => 'steering_wheel_carbon',
	'steering_wheel/steering_centre': () => 'steering_wheel_plastic',
	'steering_wheel/steering_column': () => 'steering_wheel_plastic',
	'steering_wheel/steering_leather': () => 'steering_wheel_leather',
	'steering_wheel/steering_metal': () => 'steering_wheel_plastic',
	'steering_wheel/steering_red_lights': () => 'steering_wheel_red',
	'steering_wheel/steering_trim': () => 'steering_wheel_red',
};

// target mesh -> { group, material }
const TARGETS = {
	body: { group: 'exterior', material: 'Body_Color' },
	glass: { group: 'exterior', material: 'Glass_Gray', noOcclude: true },
	glass_lamps: { group: 'exterior', material: 'Lamp_Glass', noOcclude: true },
	taillight_lens: { group: 'exterior', material: 'Taillight_Lens', noOcclude: true },
	trim_black: { group: 'exterior', material: 'Trim_Black' },
	grille: { group: 'exterior', material: 'Grille_Mesh' },
	chrome: { group: 'exterior', material: 'metal_chrome' },
	mirror: { group: 'exterior', material: 'Mirror' },
	exhaust_tips: { group: 'exterior', material: 'Exhaust_Tip' },
	headlight_housing: { group: 'exterior', material: 'Headlight_Housing' },
	light_headlight: { group: 'exterior', material: 'Projector_Glass' },
	light_drl: { group: 'exterior', material: 'Turn_Signal_LED' },
	light_tail: { group: 'exterior', material: 'Taillight_Glass' },
	light_brake_high: { group: 'exterior', material: 'Light_Brake_High' },
	light_reverse: { group: 'exterior', material: 'Light_Reverse' },
	light_fog: { group: 'exterior', material: 'Light_Fog_Rear' },
	light_indicator_l: { group: 'exterior', material: 'Light_Indicator' },
	light_indicator_r: { group: 'exterior', material: 'Light_Indicator' },
	badges: { group: 'exterior', material: 'metal_chrome' },
	interior_plastic: { group: 'interior', material: 'Interior_dark' },
	interior_leather: { group: 'interior', material: 'Leather' },
	interior_stitching: { group: 'interior', material: 'Leather_red' },
	interior_carbon: { group: 'interior', material: 'Carbon_Fiber' },
	interior_carpet: { group: 'interior', material: 'Carpet' },
	interior_seats: { group: 'interior', material: 'Seat_Fabric' },
	interior_metal: { group: 'interior', material: 'metal_gray' },
	interior_display: { group: 'interior', material: 'Display_Glass' },
	interior_gauge: { group: 'interior', material: 'Gauge_Face' },
	steering_wheel_leather: { group: 'steering', material: 'Leather' },
	steering_wheel_carbon: { group: 'steering', material: 'Carbon_Fiber' },
	steering_wheel_plastic: { group: 'steering', material: 'Interior_dark' },
	steering_wheel_red: { group: 'steering', material: 'Leather_red' },
};
for ( const w of WHEELS ) {

	TARGETS[ `wheel_${w}_tire` ] = { group: `spin_${w}`, material: 'Tires' };
	TARGETS[ `wheel_${w}_rim` ] = { group: `spin_${w}`, material: 'Rim' };
	TARGETS[ `wheel_${w}_disc` ] = { group: `spin_${w}`, material: 'Brake_Disc' };
	TARGETS[ `wheel_${w}_caliper` ] = { group: `hub_${w}`, material: 'Brake_Caliper' };

}

// Fit a (nearly flat, double-layered) badge plate to the cut-out of the body it sits in: the bevelled rim of the cut-out is
// located in the body mesh, the plate is centred on it (the source plates are off-centre by up to 4 mm), stretched in its
// own plane until it overlaps the rim by PLATE_OVERLAP and lifted until its border is PLATE_PROUD above the skin.
const PLATE_OVERLAP = Number( process.env.CAR_PLATE_OVERLAP || 0.0025 ), PLATE_PROUD = Number( process.env.CAR_PLATE_PROUD || 0.0004 );
const badgeBlanks = []; // { centre, normal, radius } of every blank plate (see patchBadgeCutouts)
function inflatePlate( g, body ) {

	const c = bboxOf( g.positions ).center;
	const ref = [ c[ 0 ], c[ 1 ] - 0.4, c[ 2 ] ];
	let n = [ 0, 0, 0 ];
	const P = g.positions, I = g.indices;
	for ( let t = 0; t < I.length; t += 3 ) {

		const a = I[ t ] * 3, b = I[ t + 1 ] * 3, d = I[ t + 2 ] * 3;
		const ux = P[ b ] - P[ a ], uy = P[ b + 1 ] - P[ a + 1 ], uz = P[ b + 2 ] - P[ a + 2 ];
		const vx = P[ d ] - P[ a ], vy = P[ d + 1 ] - P[ a + 1 ], vz = P[ d + 2 ] - P[ a + 2 ];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		if ( gx * ref[ 0 ] + gy * ref[ 1 ] + gz * ref[ 2 ] > 0 ) { n[ 0 ] += gx; n[ 1 ] += gy; n[ 2 ] += gz; }

	}

	const l = Math.hypot( ...n ) || 1; n = n.map( ( v ) => v / l );
	// in-plane axes: e1 = the world axis least aligned with n, projected; e2 = n x e1
	const ax = [ Math.abs( n[ 0 ] ), Math.abs( n[ 1 ] ), Math.abs( n[ 2 ] ) ], k0 = ax.indexOf( Math.min( ...ax ) );
	let e1 = [ 0, 0, 0 ]; e1[ k0 ] = 1;
	const d0 = e1[ 0 ] * n[ 0 ] + e1[ 1 ] * n[ 1 ] + e1[ 2 ] * n[ 2 ];
	e1 = e1.map( ( v, k ) => v - d0 * n[ k ] ); const l1 = Math.hypot( ...e1 ); e1 = e1.map( ( v ) => v / l1 );
	const e2 = [ n[ 1 ] * e1[ 2 ] - n[ 2 ] * e1[ 1 ], n[ 2 ] * e1[ 0 ] - n[ 0 ] * e1[ 2 ], n[ 0 ] * e1[ 1 ] - n[ 1 ] * e1[ 0 ] ];
	const local = ( A, i ) => { const x = A[ i ] - c[ 0 ], y = A[ i + 1 ] - c[ 1 ], z = A[ i + 2 ] - c[ 2 ]; return [ x * e1[ 0 ] + y * e1[ 1 ] + z * e1[ 2 ], x * e2[ 0 ] + y * e2[ 1 ] + z * e2[ 2 ], x * n[ 0 ] + y * n[ 1 ] + z * n[ 2 ] ]; };
	const R = Math.hypot( ...bboxOf( g.positions ).size ) * 0.8;
	// rim of the cut-out in the body: outward-facing vertices of the bevel (normal 30..55 deg off the panel normal) and of the skin next to it
	const pl = []; for ( let i = 0; i < P.length; i += 3 ) pl.push( local( P, i ) );
	const bevel = [], skin = [];
	for ( let i = 0; i < body.positions.length; i += 3 ) {

		const q = local( body.positions, i );
		if ( Math.hypot( q[ 0 ], q[ 1 ] ) > R || Math.abs( q[ 2 ] ) > 0.015 ) continue;
		let near = Infinity;
		for ( const m of pl ) near = Math.min( near, Math.hypot( m[ 0 ] - q[ 0 ], m[ 1 ] - q[ 1 ] ) );
		if ( near > 0.010 ) continue; // only what touches the plate (keeps door shut lines etc. out)
		const dot = body.normals[ i ] * n[ 0 ] + body.normals[ i + 1 ] * n[ 1 ] + body.normals[ i + 2 ] * n[ 2 ];
		if ( dot > 0.55 && dot < 0.85 ) bevel.push( q ); else if ( dot > 0.95 ) skin.push( q );

	}

	const range = ( arr, k ) => [ Math.min( ...arr.map( ( q ) => q[ k ] ) ), Math.max( ...arr.map( ( q ) => q[ k ] ) ) ];
	let shift = [ 0, 0 ], scale = [ 1.1, 1.1 ], lift = 0.002;
	if ( bevel.length >= 8 ) {

		const hole = [ range( bevel, 0 ), range( bevel, 1 ) ], plate = [ range( pl, 0 ), range( pl, 1 ) ];
		for ( const k of [ 0, 1 ] ) {

			shift[ k ] = ( hole[ k ][ 0 ] + hole[ k ][ 1 ] ) / 2 - ( plate[ k ][ 0 ] + plate[ k ][ 1 ] ) / 2;
			scale[ k ] = Math.max( 1, ( ( hole[ k ][ 1 ] - hole[ k ][ 0 ] ) / 2 + PLATE_OVERLAP ) / ( ( plate[ k ][ 1 ] - plate[ k ][ 0 ] ) / 2 ) );

		}

		// lift: every skin vertex next to the cut-out must end up below the (moved) plate vertex nearest to it
		const pc = [ ( plate[ 0 ][ 0 ] + plate[ 0 ][ 1 ] ) / 2, ( plate[ 1 ][ 0 ] + plate[ 1 ][ 1 ] ) / 2 ];
		const moved = pl.map( ( q ) => [ pc[ 0 ] + shift[ 0 ] + ( q[ 0 ] - pc[ 0 ] ) * scale[ 0 ], pc[ 1 ] + shift[ 1 ] + ( q[ 1 ] - pc[ 1 ] ) * scale[ 1 ], q[ 2 ] ] );
		const gaps = [];
		for ( const q of skin ) {

			let best = Infinity, h = 0;
			for ( const m of moved ) { const d = Math.hypot( m[ 0 ] - q[ 0 ], m[ 1 ] - q[ 1 ] ); if ( d < best ) { best = d; h = m[ 2 ]; } }
			if ( best < 0.012 ) gaps.push( q[ 2 ] - h );

		}

		gaps.sort( ( a, b ) => a - b );
		lift = gaps.length ? gaps[ Math.floor( gaps.length * 0.8 ) ] + PLATE_PROUD : 0.002;
		const pcs = pc;
		for ( let i = 0, v = 0; i < P.length; i += 3, v ++ ) {

			const q = pl[ v ];
			const a = pcs[ 0 ] + shift[ 0 ] + ( q[ 0 ] - pcs[ 0 ] ) * scale[ 0 ], b = pcs[ 1 ] + shift[ 1 ] + ( q[ 1 ] - pcs[ 1 ] ) * scale[ 1 ], h = q[ 2 ] + lift;
			for ( let k = 0; k < 3; k ++ ) P[ i + k ] = c[ k ] + a * e1[ k ] + b * e2[ k ] + h * n[ k ];

		}

	} else for ( let i = 0; i < P.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) P[ i + k ] = c[ k ] + ( P[ i + k ] - c[ k ] ) * 1.1 + n[ k ] * lift;

	const info = { centre: bboxOf( g.positions ).center, normal: n, radius: Math.hypot( ...bboxOf( g.positions ).size ) * 0.56, rimVertices: bevel.length, shiftMm: shift.map( ( v ) => r3( v * 1000 ) ), scale: scale.map( ( v ) => r3( v ) ), liftMm: r3( lift * 1000 ) };
	badgeBlanks.push( info );
	return g;

}

// The walls of the cut-outs behind the blank plates belong to the body mesh: they would stay visible as a dark, oddly shaded
// sliver next to the plate. Give them the normal of the panel and the ambient occlusion of the surrounding skin.
function patchBadgeCutouts( g ) {

	const P = g.positions, N = g.normals, A = g.ao, nV = P.length / 3;
	let touched = 0;
	for ( const { centre: c, normal: n, radius } of badgeBlanks ) {

		const inside = [], ringAo = [];
		for ( let v = 0; v < nV; v ++ ) {

			const d = Math.hypot( P[ v * 3 ] - c[ 0 ], P[ v * 3 + 1 ] - c[ 1 ], P[ v * 3 + 2 ] - c[ 2 ] );
			const dot = N[ v * 3 ] * n[ 0 ] + N[ v * 3 + 1 ] * n[ 1 ] + N[ v * 3 + 2 ] * n[ 2 ];
			if ( d < radius ) inside.push( [ v, dot ] );
			else if ( d < radius * 1.8 && dot > 0.9 && A ) ringAo.push( A[ v ] );

		}

		ringAo.sort( ( a, b ) => a - b );
		const med = ringAo.length ? ringAo[ ringAo.length >> 1 ] : 1;
		for ( const [ v, dot ] of inside ) {

			if ( dot < - 0.5 ) continue; // inward-facing copy of the skin
			if ( dot < 0.9 ) { N[ v * 3 ] = n[ 0 ]; N[ v * 3 + 1 ] = n[ 1 ]; N[ v * 3 + 2 ] = n[ 2 ]; touched ++; }
			if ( A && A[ v ] < med ) A[ v ] = med;

		}

	}

	return touched;

}

// Flatten a small recess of a smooth panel (the pocket in the dashboard leather in which the model script sat): fit a
// quadratic height field w(u,v) to the surface around `box` and move every vertex of the pocket onto it; the collapsed
// pocket walls become degenerate and the normals are rebuilt from the triangles (so both layers keep their orientation).
function flattenRecess( g, box, { pad = 0.014, maxDepth = 0.006, yMin = - Infinity } = {} ) {

	const P = g.positions, N = g.normals, nV = P.length / 3;
	const inBox = ( i, e ) => P[ i ] > box[ 0 ] - e && P[ i ] < box[ 1 ] + e && P[ i + 1 ] > Math.max( box[ 2 ] - e, yMin ) && P[ i + 1 ] < box[ 3 ] + e && P[ i + 2 ] > box[ 4 ] - e && P[ i + 2 ] < box[ 5 ] + e;
	// local frame: w = mean outward normal of the surroundings (outward = the hemisphere with positive Y here)
	const w = [ 0, 0, 0 ];
	const ring = [];
	for ( let v = 0; v < nV; v ++ ) if ( inBox( v * 3, pad ) && ! inBox( v * 3, 0 ) && N[ v * 3 + 1 ] > 0.3 ) { ring.push( v ); w[ 0 ] += N[ v * 3 ]; w[ 1 ] += N[ v * 3 + 1 ]; w[ 2 ] += N[ v * 3 + 2 ]; }
	if ( ring.length < 12 ) return { moved: 0, ring: ring.length };
	const wl = Math.hypot( ...w ); w[ 0 ] /= wl; w[ 1 ] /= wl; w[ 2 ] /= wl;
	const u = [ 1, 0, 0 ]; { const d = w[ 0 ]; u[ 0 ] -= d * w[ 0 ]; u[ 1 ] -= d * w[ 1 ]; u[ 2 ] -= d * w[ 2 ]; const l = Math.hypot( ...u ); u[ 0 ] /= l; u[ 1 ] /= l; u[ 2 ] /= l; }
	const vv = [ w[ 1 ] * u[ 2 ] - w[ 2 ] * u[ 1 ], w[ 2 ] * u[ 0 ] - w[ 0 ] * u[ 2 ], w[ 0 ] * u[ 1 ] - w[ 1 ] * u[ 0 ] ];
	const c = [ ( box[ 0 ] + box[ 1 ] ) / 2, ( box[ 2 ] + box[ 3 ] ) / 2, ( box[ 4 ] + box[ 5 ] ) / 2 ];
	const uvw = ( i ) => { const x = P[ i ] - c[ 0 ], y = P[ i + 1 ] - c[ 1 ], z = P[ i + 2 ] - c[ 2 ]; return [ x * u[ 0 ] + y * u[ 1 ] + z * u[ 2 ], x * vv[ 0 ] + y * vv[ 1 ] + z * vv[ 2 ], x * w[ 0 ] + y * w[ 1 ] + z * w[ 2 ] ]; };
	const basis = ( a, b ) => [ 1, a, b, a * a, a * b, b * b ];
	// least squares with outlier rejection (Gaussian elimination on the 6x6 normal equations)
	let use = ring.map( ( v ) => uvw( v * 3 ) ), coef = null;
	for ( let iter = 0; iter < 4; iter ++ ) {

		const A = Array.from( { length: 6 }, () => new Float64Array( 7 ) );
		for ( const [ a, b, h ] of use ) { const f = basis( a, b ); for ( let r = 0; r < 6; r ++ ) { for ( let k = 0; k < 6; k ++ ) A[ r ][ k ] += f[ r ] * f[ k ]; A[ r ][ 6 ] += f[ r ] * h; } }
		for ( let r = 0; r < 6; r ++ ) {

			let piv = r; for ( let k = r + 1; k < 6; k ++ ) if ( Math.abs( A[ k ][ r ] ) > Math.abs( A[ piv ][ r ] ) ) piv = k;
			[ A[ r ], A[ piv ] ] = [ A[ piv ], A[ r ] ];
			for ( let k = 0; k < 6; k ++ ) if ( k !== r ) { const m = A[ k ][ r ] / A[ r ][ r ]; for ( let j = r; j < 7; j ++ ) A[ k ][ j ] -= m * A[ r ][ j ]; }

		}

		coef = A.map( ( row, r ) => row[ 6 ] / row[ r ] );
		const res = use.map( ( [ a, b, h ] ) => Math.abs( h - basis( a, b ).reduce( ( acc, f, k ) => acc + f * coef[ k ], 0 ) ) );
		const sorted = res.slice().sort( ( x, y ) => x - y ), lim = Math.max( 0.0004, sorted[ Math.floor( sorted.length * 0.75 ) ] * 1.5 );
		use = use.filter( ( _, k ) => res[ k ] <= lim );

	}

	const height = ( a, b ) => basis( a, b ).reduce( ( acc, f, k ) => acc + f * coef[ k ], 0 );
	const movedSet = new Set();
	for ( let v = 0; v < nV; v ++ ) {

		if ( ! inBox( v * 3, 0 ) ) continue;
		const [ a, b, h ] = uvw( v * 3 );
		const dh = height( a, b ) - h;
		if ( Math.abs( dh ) > maxDepth ) continue;
		P[ v * 3 ] += w[ 0 ] * dh; P[ v * 3 + 1 ] += w[ 1 ] * dh; P[ v * 3 + 2 ] += w[ 2 ] * dh;
		movedSet.add( v );

	}

	// rebuild the normals of the moved vertices from their triangles (area weighted; winding gives the layer orientation)
	const acc = new Map();
	const I = g.indices;
	for ( let t = 0; t < I.length; t += 3 ) {

		const ia = I[ t ], ib = I[ t + 1 ], ic = I[ t + 2 ];
		if ( ! movedSet.has( ia ) && ! movedSet.has( ib ) && ! movedSet.has( ic ) ) continue;
		const a = ia * 3, b = ib * 3, d = ic * 3;
		const ux = P[ b ] - P[ a ], uy = P[ b + 1 ] - P[ a + 1 ], uz = P[ b + 2 ] - P[ a + 2 ];
		const vx = P[ d ] - P[ a ], vy = P[ d + 1 ] - P[ a + 1 ], vz = P[ d + 2 ] - P[ a + 2 ];
		const gn = [ uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx ];
		for ( const i of [ ia, ib, ic ] ) if ( movedSet.has( i ) ) { const e = acc.get( i ) || [ 0, 0, 0 ]; e[ 0 ] += gn[ 0 ]; e[ 1 ] += gn[ 1 ]; e[ 2 ] += gn[ 2 ]; acc.set( i, e ); }

	}

	for ( const [ i, e ] of acc ) {

		// orientation of the layer = sign of the accumulated geometric normal along w; direction = analytic normal of the fitted surface
		const [ a, b ] = uvw( i * 3 );
		const du = coef[ 1 ] + 2 * coef[ 3 ] * a + coef[ 4 ] * b, dv = coef[ 2 ] + coef[ 4 ] * a + 2 * coef[ 5 ] * b;
		let n = [ w[ 0 ] - du * u[ 0 ] - dv * vv[ 0 ], w[ 1 ] - du * u[ 1 ] - dv * vv[ 1 ], w[ 2 ] - du * u[ 2 ] - dv * vv[ 2 ] ];
		const l = Math.hypot( ...n ), sgn = ( e[ 0 ] * w[ 0 ] + e[ 1 ] * w[ 1 ] + e[ 2 ] * w[ 2 ] ) >= 0 ? 1 : - 1;
		N[ i * 3 ] = sgn * n[ 0 ] / l; N[ i * 3 + 1 ] = sgn * n[ 1 ] / l; N[ i * 3 + 2 ] = sgn * n[ 2 ] / l;

	}

	return { moved: movedSet.size, ring: ring.length, fitted: use.length };

}

const buckets = new Map(); // target -> [geo] (world space, rest pose)
const push = ( target, geo ) => { if ( ! TARGETS[ target ] ) throw new Error( 'unknown target ' + target ); if ( ! buckets.has( target ) ) buckets.set( target, [] ); buckets.get( target ).push( geo ); };
const anchors = {}; // measured positions of interesting loose parts
const dropped = { tris: 0, parts: 0 };
const classifyLog = [];

for ( const [ key, geo ] of src ) {

	if ( key.startsWith( 'wheel_' ) ) continue; // wheels handled below
	const rule = RULES[ key ];
	if ( ! rule ) throw new Error( 'no rule for ' + key );
	const cc = connectedComponents( geo.positions, geo.indices );
	const byTarget = new Map();
	for ( const c of cc.list ) {

		const target = rule( c );
		if ( target === null ) { dropped.tris += c.tris; dropped.parts ++; continue; }
		if ( ! byTarget.has( target ) ) byTarget.set( target, new Set() );
		byTarget.get( target ).add( c.id );
		// anchors
		if ( key === 'main/lights' ) ( anchors.headlights ??= [] ).push( c.center );
		if ( target === 'exhaust_tips' && key === 'main/chrome' ) ( anchors.exhaustTips ??= [] ).push( { center: c.center, max: c.max, size: c.size } );
		if ( target === 'light_tail' ) ( anchors.tailLights ??= [] ).push( { center: c.center, max: c.max } );
		if ( target === 'light_brake_high' && c.tris > 300 ) anchors.brakeHigh = { center: c.center, max: c.max };
		if ( target === 'light_reverse' ) anchors.reverse = { center: c.center, max: c.max };
		if ( target === 'light_fog' ) anchors.fog = { center: c.center, max: c.max };
		if ( target === 'mirror' ) ( anchors.mirrors ??= [] ).push( { center: c.center, size: c.size } );
		if ( target && target.startsWith( 'light_indicator' ) ) ( anchors.indicators ??= [] ).push( { target, center: c.center } );
		if ( target === 'light_drl' ) ( anchors.drl ??= [] ).push( c.center );
		if ( target === 'interior_gauge' ) anchors.tachFace = { center: c.center, size: c.size };

	}

	for ( const [ target, ids ] of byTarget ) {

		if ( key === 'main/yellow_trim' && target === 'body' ) {

			// badge plates kept as body-coloured blanks: one by one, grown a little so they close the cut-out without a visible seam
			for ( const id of ids ) push( target, inflatePlate( subsetGeo( geo, ( t ) => cc.comp[ t ] === id ), src.get( 'main/body' ) ) );
			classifyLog.push( `${key} -> ${target}: ${ids.size} blank plates` );
			continue;

		}

		const g = subsetGeo( geo, ( t ) => ids.has( cc.comp[ t ] ) );
		push( target, g );
		classifyLog.push( `${key} -> ${target}: ${triCount( g )} tris (${ids.size} parts)` );

	}

}

log( 'dropped (badges):', dropped.parts, 'parts,', dropped.tris, 'tris:', [ ...new Set( badgeNotes ) ].join( ', ' ) );

// ---------------------------------------------------------------------------------------------------------------------
// 4. Wheels: rim (+ masks in UV), disc, regenerated tyre, generated caliper. Everything is built in WHEEL-LOCAL space
//    (origin = wheel centre, +X = car right) and then moved to the symmetrised hub position.
// ---------------------------------------------------------------------------------------------------------------------
// Tyre cross-section (x = distance from the wheel centre plane towards the OUTBOARD side, r = radius). Returns
// [[x, r, v]] running outboard bead -> tread -> inboard bead. v: 0..0.25 outboard sidewall, 0.25..0.75 tread, 0.75..1 inboard sidewall.
function tyreProfile( hw, R, rimR ) {

	const half = [ // [dx from hw, r]
		[ - 0.0100, rimR - 0.0060 ], // bead, hidden behind the rim flange
		[ - 0.0020, rimR + 0.0005 ],
		[ 0.0025, rimR + 0.0080 ],
		[ 0.0040, rimR + 0.0190 ], // rim protector bulge = widest point
		[ 0.0020, R - 0.0400 ],
		[ - 0.0005, R - 0.0290 ],
		[ - 0.0040, R - 0.0190 ],
		[ - 0.0090, R - 0.0112 ], // shoulder point: end of the sidewall texture, start of the tread texture
		[ - 0.0150, R - 0.0058 ],
		[ - 0.0220, R - 0.0022 ],
		[ - 0.0300, R - 0.0004 ], // edge of the flat crown
		[ - 0.0600, R ],
	];
	const SHOULDER = 7;
	const pts = half.map( ( [ dx, r ] ) => [ hw + dx, r ] );
	// arc length along the sidewall for v
	const len = [ 0 ];
	for ( let i = 1; i <= SHOULDER; i ++ ) len.push( len[ i - 1 ] + Math.hypot( pts[ i ][ 0 ] - pts[ i - 1 ][ 0 ], pts[ i ][ 1 ] - pts[ i - 1 ][ 1 ] ) );
	const xs = pts[ SHOULDER ][ 0 ];
	const out = [];
	for ( let i = 0; i < pts.length; i ++ ) {

		const v = i <= SHOULDER ? 0.25 * len[ i ] / len[ SHOULDER ] : 0.5 - 0.25 * pts[ i ][ 0 ] / xs;
		out.push( [ pts[ i ][ 0 ], pts[ i ][ 1 ], v ] );

	}

	// flat crown
	for ( const f of [ 0.5, 0 ] ) { const x = pts[ pts.length - 1 ][ 0 ] * f; out.push( [ x, R, 0.5 - 0.25 * x / xs ] ); }
	// mirror for the inboard half
	const n = out.length;
	for ( let i = n - 2; i >= 0; i -- ) out.push( [ - out[ i ][ 0 ], out[ i ][ 1 ], 1 - out[ i ][ 2 ] ] );
	return { profile: out, sidewallLength: len[ SHOULDER ], treadHalfWidth: xs };

}

const wheelInfo = {};
for ( const w of WHEELS ) {

	const c = wheelSrcCentre[ w ];
	const sideSign = c[ 0 ] < 0 ? - 1 : 1; // outboard direction along X
	const local = ( name ) => translateGeo( cloneGeo( src.get( `wheel_${w}/${name}` ) ), - c[ 0 ], - c[ 1 ], - c[ 2 ] );
	const rimName = [ ...src.keys() ].find( ( k ) => k.startsWith( `wheel_${w}/rim_` ) ).split( '/' )[ 1 ];
	const rim = mergeGeos( [
		setUv( local( 'wheel' ), 0, 0 ),
		setUv( local( rimName ), 1, 0 ), // UV.x = 1 -> machined spoke face / outer lip ("rim_xx" in the source)
		setUv( local( 'centre' ), 0, 1 ), // UV.y = 1 -> centre cap
		setUv( local( 'nuts' ), 0, 0 ),
	] );
	const disc = local( 'brake' );
	let discVR = 0, discVRin = Infinity;
	for ( let i = 0; i < disc.positions.length; i += 3 ) { const r = Math.hypot( disc.positions[ i + 1 ], disc.positions[ i + 2 ] ); discVR = Math.max( discVR, r ); discVRin = Math.min( discVRin, r ); }
	setUv( disc, discVR, discVRin ); // constants per disc: UV.x = outer radius, UV.y = inner radius (used by the procedural drilled-disc shader)
	const rimBox = bboxOf( rim.positions ), discBox = bboxOf( disc.positions );
	// rim flange radius = max radius of the rim
	let rimR = 0;
	for ( let i = 0; i < rim.positions.length; i += 3 ) rimR = Math.max( rimR, Math.hypot( rim.positions[ i + 1 ], rim.positions[ i + 2 ] ) );
	let discR = 0, discRin = Infinity;
	for ( let i = 0; i < disc.positions.length; i += 3 ) { const r = Math.hypot( disc.positions[ i + 1 ], disc.positions[ i + 2 ] ); discR = Math.max( discR, r ); discRin = Math.min( discRin, r ); }
	const hw = tyreHalfWidth[ w ];
	const { profile, sidewallLength, treadHalfWidth } = tyreProfile( hw, TYRE_RADIUS, rimR );
	// profile is defined with +x = outboard; lathe runs from +x over the top to -x so normals point outwards
	const tyre = latheX( profile, 96, { mirrorX: sideSign < 0, flipU: sideSign > 0 } );
	const caliper = buildCaliper( { sideSign, discOuterR: discR, discInnerR: discRin, discXMin: discBox.min[ 0 ], discXMax: discBox.max[ 0 ], front: w[ 0 ] === 'f', rim } );
	const wc = wheelCentre[ w ];
	const toWorld = ( g ) => translateGeo( g, wc[ 0 ], wc[ 1 ], wc[ 2 ] );
	push( `wheel_${w}_rim`, toWorld( rim ) );
	push( `wheel_${w}_disc`, toWorld( disc ) );
	push( `wheel_${w}_tire`, toWorld( tyre ) );
	if ( caliper ) push( `wheel_${w}_caliper`, toWorld( caliper.geo ) );
	const tb = bboxOf( tyre.positions );
	wheelInfo[ w ] = {
		centre: wc, sideSign, radius: TYRE_RADIUS, tyreWidth: tb.size[ 0 ], sourceTyreWidth: hw * 2, rimRadius: rimR, rimWidthX: [ rimBox.min[ 0 ], rimBox.max[ 0 ] ],
		discRadius: discR, discInnerRadius: discRin, discX: [ discBox.min[ 0 ], discBox.max[ 0 ] ], sidewallLength, treadHalfWidth,
		sourceCentre: c, caliper: caliper ? caliper.info : null,
	};

}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Merge buckets -> one geometry per target (still world space, rest pose)
// ---------------------------------------------------------------------------------------------------------------------
const meshes = new Map();
for ( const [ target, list ] of buckets ) meshes.set( target, weldGeo( mergeGeos( list ) ) );
if ( ! KEEP_BADGES ) log( 'dashboard script pocket flattened:', JSON.stringify( flattenRecess( meshes.get( 'interior_leather' ), [ 0.428, 0.536, 0.781, 0.810, - 0.604, - 0.573 ], { yMin: 0.778 } ) ) );
for ( const [ target, g ] of meshes ) { const ws = windingStats( g ); if ( ws.disagree > ws.agree * 0.02 ) log( `note: ${target} has ${ws.disagree}/${ws.agree + ws.disagree} triangles whose winding disagrees with the vertex normals` ); }

// ---------------------------------------------------------------------------------------------------------------------
// 6. Ambient occlusion (per-vertex sky visibility, stored in COLOR_0)
// ---------------------------------------------------------------------------------------------------------------------
let aoCache = null;
if ( AO && AO_CACHE && existsSync( AO_CACHE ) ) { aoCache = new Map( JSON.parse( readFileSync( AO_CACHE, 'utf8' ) ) ); log( 'AO cache entries:', aoCache.size ); } else if ( AO && AO_CACHE ) aoCache = new Map();

// ground footprint under the car: the ground there is in the car's own shadow, so it counts as an occluder
function groundFootprint() {

	const x = 0.97, z0 = - 2.2, z1 = 2.2, y = 0;
	return { positions: Float32Array.from( [ - x, y, z0, x, y, z0, x, y, z1, - x, y, z1 ] ), normals: new Float32Array( 12 ), indices: Uint32Array.from( [ 0, 2, 1, 0, 3, 2 ] ) };

}

const isWheelTarget = ( t ) => /^wheel_(fl|fr|rl|rr)_(tire|rim|disc)$/.test( t );
function bakeAll( meshMap, occluderMap, label ) {

	const tA = Date.now();
	const bodyOccluders = [ groundFootprint() ];
	for ( const [ target, g ] of occluderMap ) if ( ! TARGETS[ target ].noOcclude ) bodyOccluders.push( g );
	const bodyBVH = buildBVH( bodyOccluders );
	// per-wheel BVH: the spinning parts only see themselves plus a virtual wall on the inboard side (stands in for the arch)
	const wheelBVH = {};
	for ( const w of WHEELS ) {

		const wc = wheelCentre[ w ], s = wheelInfo[ w ].sideSign;
		const xi = wc[ 0 ] - s * ( tyreHalfWidth[ w ] + 0.03 ), R = 0.6;
		const wall = { positions: Float32Array.from( [ xi, wc[ 1 ] - R, wc[ 2 ] - R, xi, wc[ 1 ] + R, wc[ 2 ] - R, xi, wc[ 1 ] + R, wc[ 2 ] + R, xi, wc[ 1 ] - R, wc[ 2 ] + R ] ), normals: new Float32Array( 12 ), indices: Uint32Array.from( [ 0, 1, 2, 0, 2, 3 ] ) };
		const list = [ wall ];
		for ( const part of [ 'tire', 'rim', 'disc', 'caliper' ] ) { const g = occluderMap.get( `wheel_${w}_${part}` ); if ( g ) list.push( g ); }
		wheelBVH[ w ] = buildBVH( list );

	}

	let computed = 0, total = 0;
	for ( const [ target, g ] of meshMap ) {

		const wheel = isWheelTarget( target ) ? target.slice( 6, 8 ) : null;
		const res = bakeAO( g, wheel ? wheelBVH[ wheel ] : bodyBVH, { samples: AO_SAMPLES, maxDist: wheel ? 1.2 : 6, bias: 0.004, cache: aoCache } );
		g.ao = res.ao;
		computed += res.computed; total += g.ao.length;

	}

	log( `AO ${label}: ${total} vertices (${computed} ray-traced, ${AO_SAMPLES} rays each) in ${( ( Date.now() - tA ) / 1000 ).toFixed( 1 )} s` );

}

if ( AO ) bakeAll( meshes, meshes, 'lod0' );
if ( badgeBlanks.length ) log( 'badge cut-outs patched:', patchBadgeCutouts( meshes.get( 'body' ) ), 'wall vertices;', JSON.stringify( badgeBlanks.map( ( b ) => ( { c: r3( b.centre ), rim: b.rimVertices, shiftMm: b.shiftMm, scale: b.scale, liftMm: b.liftMm } ) ) ) );

// ---------------------------------------------------------------------------------------------------------------------
// 7. LOD1: single-layer surfaces, aggressive simplification, fewer meshes (same node names for everything that is animated)
// ---------------------------------------------------------------------------------------------------------------------
await MeshoptSimplifier.ready;

// NOTE: in the source EVERY triangle exists twice (a second copy with reversed winding and flipped normals: the model is
// "double sided by duplication"). LOD0 keeps both layers (each layer gets its own AO; default FrontSide materials and default
// shadow sides just work). For LOD1 only the layer that can see the sky is kept (both when both are visible, e.g. thin fins).
function dropHiddenLayer( g, bothThreshold = 0.10 ) {

	const nV = g.positions.length / 3;
	const key = new Map();
	const weld = new Uint32Array( nV );
	let nW = 0;
	for ( let i = 0; i < nV; i ++ ) {

		const k = Math.round( g.positions[ i * 3 ] * 2e4 ) + ',' + Math.round( g.positions[ i * 3 + 1 ] * 2e4 ) + ',' + Math.round( g.positions[ i * 3 + 2 ] * 2e4 );
		let w = key.get( k );
		if ( w === undefined ) { w = nW ++; key.set( k, w ); }
		weld[ i ] = w;

	}

	const nT = g.indices.length / 3;
	const keep = new Uint8Array( nT ).fill( 1 );
	const seen = new Map(); // sorted key -> [tri, parity, ao]
	const I = g.indices;
	// fallback visibility when no AO was baked: does the normal point away from the car's centre line?
	const vis = ( t ) => {

		const a = I[ t * 3 ], b = I[ t * 3 + 1 ], c = I[ t * 3 + 2 ];
		if ( g.ao ) return ( g.ao[ a ] + g.ao[ b ] + g.ao[ c ] ) / 3;
		const px = g.positions[ a * 3 ], py = g.positions[ a * 3 + 1 ] - 0.45;
		return ( g.normals[ a * 3 ] * px + g.normals[ a * 3 + 1 ] * py ) > 0 ? 1 : 0;

	};

	for ( let t = 0; t < nT; t ++ ) {

		const a = weld[ I[ t * 3 ] ], b = weld[ I[ t * 3 + 1 ] ], c = weld[ I[ t * 3 + 2 ] ];
		if ( a === b || b === c || a === c ) { keep[ t ] = 0; continue; }
		const s = [ a, b, c ].sort( ( x, y ) => x - y );
		const parity = ( ( a === s[ 0 ] && b === s[ 1 ] ) || ( b === s[ 0 ] && c === s[ 1 ] ) || ( c === s[ 0 ] && a === s[ 1 ] ) ) ? 1 : - 1;
		const k = s[ 0 ] + '_' + s[ 1 ] + '_' + s[ 2 ];
		const e = seen.get( k );
		if ( e === undefined ) { seen.set( k, [ t, parity, vis( t ) ] ); continue; }
		if ( e[ 1 ] === parity ) { keep[ t ] = 0; continue; } // same-direction duplicate
		const v = vis( t );
		if ( v >= bothThreshold && e[ 2 ] >= bothThreshold ) continue; // both sides visible: keep both
		if ( v > e[ 2 ] ) { keep[ e[ 0 ] ] = 0; seen.set( k, [ t, parity, v ] ); } else keep[ t ] = 0;

	}

	return subsetGeo( g, ( t ) => keep[ t ] === 1 );

}

function simplify( g, targetTris, maxError = 0.02 ) {

	if ( triCount( g ) <= targetTris ) return g;
	const target = Math.max( 12, targetTris * 3 );
	let idx;
	[ idx ] = MeshoptSimplifier.simplifyWithAttributes( g.indices, g.positions, 3, g.normals, 3, [ 0.4, 0.4, 0.4 ], null, target, maxError, [] );
	if ( idx.length > target * 1.25 ) [ idx ] = MeshoptSimplifier.simplify( g.indices, g.positions, 3, target, maxError * 2, [ 'Permissive' ] );
	return subsetGeo( { positions: g.positions, normals: g.normals, uvs: g.uvs, ao: g.ao, indices: idx }, () => true );

}

// drop loose parts whose bounding-box diagonal is below `minSize`
function dropSmallParts( g, minSize ) {

	const cc = connectedComponents( g.positions, g.indices, 1e-4 );
	const keepIds = new Set( cc.list.filter( ( c ) => Math.hypot( ...c.size ) >= minSize ).map( ( c ) => c.id ) );
	return subsetGeo( g, ( t ) => keepIds.has( cc.comp[ t ] ) );

}

// LOD1 plan: target -> { from: [lod0 targets], tris: triangle budget, minPart: drop loose parts smaller than this (m), err }
const LOD1_PLAN = {
	body: { from: [ 'body' ], tris: 13000, minPart: 0.05, err: 0.01 },
	glass: { from: [ 'glass', 'glass_lamps' ], tris: 520, minPart: 0.12, err: 0.01 },
	trim_black: { from: [ 'trim_black', 'grille', 'headlight_housing', 'exhaust_tips' ], tris: 5000, minPart: 0.16, err: 0.02 },
	chrome: { from: [ 'chrome', 'mirror' ], tris: 420, minPart: 0.09, err: 0.02 },
	light_headlight: { from: [ 'light_headlight', 'light_drl' ], tris: 220, minPart: 0.012, err: 0.02 },
	light_tail: { from: [ 'taillight_lens', 'light_brake_high' ], tris: 420, minPart: 0.1, err: 0.02 },
	interior_plastic: { from: [ 'interior_plastic', 'interior_leather', 'interior_carbon', 'interior_carpet', 'interior_seats' ], tris: 4400, minPart: 0.30, err: 0.03 },
	steering_wheel_leather: { from: [ 'steering_wheel_leather', 'steering_wheel_carbon', 'steering_wheel_plastic' ], tris: 300, minPart: 0.15, err: 0.03 },
};
for ( const w of WHEELS ) {

	LOD1_PLAN[ `wheel_${w}_rim` ] = { from: [ `wheel_${w}_rim`, `wheel_${w}_disc` ], tris: 1700, minPart: 0.12, err: 0.02, keepUv: true };
	LOD1_PLAN[ `wheel_${w}_tire` ] = { tyre: w };

}

function buildLod1() {

	const out = new Map();
	const report = {};
	for ( const [ target, plan ] of Object.entries( LOD1_PLAN ) ) {

		if ( plan.tyre ) {

			const w = plan.tyre, info = wheelInfo[ w ];
			const { profile } = tyreProfile( tyreHalfWidth[ w ], TYRE_RADIUS, info.rimRadius );
			// thin the profile: bead, bulge, mid sidewall, shoulder, tread edge, crown (and their mirror images)
			const keepIdx = new Set( [ 0, 3, 5, 7, 10, 13 ] );
			const n = profile.length;
			const thin = profile.filter( ( p, i ) => keepIdx.has( i ) || keepIdx.has( n - 1 - i ) );
			out.set( target, translateGeo( latheX( thin, 28, { mirrorX: info.sideSign < 0, flipU: info.sideSign > 0 } ), ...wheelCentre[ w ] ) );
			continue;

		}

		let g = mergeGeos( plan.from.map( ( t ) => [ t, meshes.get( t ) ] ).filter( ( [ , x ] ) => x ).map( ( [ t, x ] ) => ( { ...x, uvs: plan.keepUv && ! /_disc$/.test( t ) ? x.uvs : null } ) ) );
		const n0 = triCount( g );
		g = dropHiddenLayer( g );
		const n1 = triCount( g );
		g = dropSmallParts( g, plan.minPart );
		const n2 = triCount( g );
		g = simplify( g, plan.tris, plan.err );
		g.ao = null;
		out.set( target, weldGeo( g ) );
		report[ target ] = `${n0} -> single layer ${n1} -> no small parts ${n2} -> ${triCount( g )}`;

	}

	return { out, report };

}

const { out: lod1, report: lod1Report } = buildLod1();
let lod1Tris = 0;
for ( const g of lod1.values() ) lod1Tris += triCount( g );
log( 'LOD1 triangles:', lod1Tris );
for ( const [ k, v ] of Object.entries( lod1Report ) ) log( '   ', k.padEnd( 24 ), v );
if ( lod1Tris > LOD1_BUDGET + 1000 ) log( 'WARNING: LOD1 exceeds budget', LOD1_BUDGET );
if ( AO ) bakeAll( lod1, meshes, 'lod1' );
if ( badgeBlanks.length ) patchBadgeCutouts( lod1.get( 'body' ) );
if ( AO && AO_CACHE ) writeFileSync( AO_CACHE, JSON.stringify( [ ...aoCache ] ) );

// ---------------------------------------------------------------------------------------------------------------------
// 8. Write glTF
// ---------------------------------------------------------------------------------------------------------------------
// Plain fallback materials (the game replaces them with the recipe in car.json; these make the file look sane in any viewer)
const MATERIALS = {
	Body_Color: { color: [ 0.45, 0.012, 0.016 ], metallic: 0.0, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.04 },
	Glass_Gray: { color: [ 0.05, 0.07, 0.07 ], metallic: 0, roughness: 0.03, alpha: 0.32 },
	Lamp_Glass: { color: [ 0.9, 0.9, 0.9 ], metallic: 0, roughness: 0.03, alpha: 0.16 },
	Taillight_Lens: { color: [ 0.45, 0.01, 0.01 ], metallic: 0, roughness: 0.05, alpha: 0.55 },
	Trim_Black: { color: [ 0.012, 0.012, 0.013 ], metallic: 0, roughness: 0.55 },
	Grille_Mesh: { color: [ 0.01, 0.01, 0.01 ], metallic: 0.2, roughness: 0.6 },
	metal_chrome: { color: [ 0.9, 0.9, 0.9 ], metallic: 1, roughness: 0.06 },
	Mirror: { color: [ 0.95, 0.95, 0.95 ], metallic: 1, roughness: 0.0 },
	Exhaust_Tip: { color: [ 0.62, 0.6, 0.56 ], metallic: 1, roughness: 0.22 },
	Headlight_Housing: { color: [ 0.22, 0.22, 0.23 ], metallic: 1, roughness: 0.32 },
	Projector_Glass: { color: [ 0.85, 0.9, 1.0 ], metallic: 0, roughness: 0.02, emissive: [ 0, 0, 0 ] },
	Turn_Signal_LED: { color: [ 0.9, 0.9, 0.9 ], metallic: 0, roughness: 0.25, emissive: [ 0, 0, 0 ] },
	Taillight_Glass: { color: [ 0.35, 0.005, 0.005 ], metallic: 0, roughness: 0.25, emissive: [ 0, 0, 0 ] },
	Light_Brake_High: { color: [ 0.3, 0.005, 0.005 ], metallic: 0, roughness: 0.2, emissive: [ 0, 0, 0 ] },
	Light_Reverse: { color: [ 0.85, 0.85, 0.85 ], metallic: 0, roughness: 0.15, emissive: [ 0, 0, 0 ] },
	Light_Fog_Rear: { color: [ 0.35, 0.005, 0.005 ], metallic: 0, roughness: 0.15, emissive: [ 0, 0, 0 ] },
	Light_Indicator: { color: [ 0.8, 0.45, 0.1 ], metallic: 0, roughness: 0.2, emissive: [ 0, 0, 0 ] },
	Interior_dark: { color: [ 0.018, 0.018, 0.019 ], metallic: 0, roughness: 0.6 },
	Leather: { color: [ 0.02, 0.019, 0.019 ], metallic: 0, roughness: 0.48 },
	Leather_red: { color: [ 0.33, 0.012, 0.01 ], metallic: 0, roughness: 0.55 },
	Carbon_Fiber: { color: [ 0.02, 0.02, 0.022 ], metallic: 0.1, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 },
	Carpet: { color: [ 0.012, 0.012, 0.012 ], metallic: 0, roughness: 0.95 },
	Seat_Fabric: { color: [ 0.028, 0.027, 0.027 ], metallic: 0, roughness: 0.9 },
	metal_gray: { color: [ 0.55, 0.55, 0.56 ], metallic: 1, roughness: 0.35 },
	Display_Glass: { color: [ 0.005, 0.005, 0.006 ], metallic: 0, roughness: 0.05 },
	Gauge_Face: { color: [ 0.85, 0.62, 0.0 ], metallic: 0, roughness: 0.5 },
	Tires: { color: [ 0.016, 0.016, 0.017 ], metallic: 0, roughness: 0.85 },
	Rim: { color: [ 0.56, 0.57, 0.58 ], metallic: 1, roughness: 0.28 },
	Brake_Disc: { color: [ 0.17, 0.17, 0.18 ], metallic: 0.6, roughness: 0.5 },
	Brake_Caliper: { color: [ 0.55, 0.42, 0.0 ], metallic: 0.1, roughness: 0.35 },
};

function qFromGeo() { return [ 0, 0, 0, 1 ]; }

function writeDoc( meshMap, file, { lod } ) {

	const doc = new Document();
	doc.getRoot().getAsset().generator = 'alpenglow tools/assets/car-build.mjs';
	doc.getRoot().getAsset().copyright = 'Model: "Ferrari 458 Italia" by vicent091036 (https://sketchfab.com/vicent091036), CC BY 4.0; modified (re-grouped, de-badged, tyres/calipers rebuilt, AO baked).';
	const buffer = doc.createBuffer();
	const clearcoatExt = doc.createExtension( KHRMaterialsClearcoat );
	const mats = new Map();
	const getMat = ( name ) => {

		if ( mats.has( name ) ) return mats.get( name );
		const d = MATERIALS[ name ];
		if ( ! d ) throw new Error( 'no material def ' + name );
		const m = doc.createMaterial( name ).setBaseColorFactor( [ ...d.color, d.alpha ?? 1 ] ).setMetallicFactor( d.metallic ).setRoughnessFactor( d.roughness );
		if ( d.alpha !== undefined ) m.setAlphaMode( 'BLEND' );
		if ( d.emissive ) m.setEmissiveFactor( d.emissive );
		if ( d.clearcoat ) m.setExtension( 'KHR_materials_clearcoat', clearcoatExt.createClearcoat().setClearcoatFactor( d.clearcoat ).setClearcoatRoughnessFactor( d.clearcoatRoughness ) );
		mats.set( name, m );
		return m;

	};

	const scene = doc.createScene( 'car' );
	const root = doc.createNode( 'car' );
	scene.addChild( root );
	const groups = {};
	const group = ( name, parent = root ) => { if ( ! groups[ name ] ) { groups[ name ] = doc.createNode( name ); parent.addChild( groups[ name ] ); } return groups[ name ]; };
	group( 'exterior' ); group( 'interior' );
	const column = group( 'steering_column', groups.interior ).setTranslation( STEER_ORIGIN ).setRotation( STEER_QUAT );
	const steering = group( 'steering_wheel', column );
	const hubs = {}, spins = {};
	for ( const w of WHEELS ) {

		hubs[ w ] = group( `wheel_${w}` ).setTranslation( wheelCentre[ w ] );
		spins[ w ] = group( `wheel_${w}_spin`, hubs[ w ] );

	}

	const stats = { meshes: 0, triangles: 0, vertices: 0, perMesh: {} };
	const order = Object.keys( TARGETS );
	const names = [ ...meshMap.keys() ].sort( ( a, b ) => order.indexOf( a ) - order.indexOf( b ) );
	for ( const target of names ) {

		let g = meshMap.get( target );
		if ( ! g || triCount( g ) === 0 ) continue;
		g = cloneGeo( g );
		const def = TARGETS[ target ];
		let parent;
		if ( def.group === 'exterior' || def.group === 'interior' ) parent = groups[ def.group ];
		else if ( def.group === 'steering' ) {

			parent = steering;
			translateGeo( g, - STEER_ORIGIN[ 0 ], - STEER_ORIGIN[ 1 ], - STEER_ORIGIN[ 2 ] );
			rotateGeo( g, STEER_R_INV );

		} else {

			const w = def.group.slice( - 2 );
			parent = def.group.startsWith( 'spin' ) ? spins[ w ] : hubs[ w ];
			translateGeo( g, - wheelCentre[ w ][ 0 ], - wheelCentre[ w ][ 1 ], - wheelCentre[ w ][ 2 ] );

		}

		const prim = doc.createPrimitive().setMaterial( getMat( def.material ) )
			.setAttribute( 'POSITION', doc.createAccessor().setType( 'VEC3' ).setArray( g.positions ).setBuffer( buffer ) )
			.setAttribute( 'NORMAL', doc.createAccessor().setType( 'VEC3' ).setArray( g.normals ).setBuffer( buffer ) )
			.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( g.indices ).setBuffer( buffer ) );
		if ( g.uvs ) prim.setAttribute( 'TEXCOORD_0', doc.createAccessor().setType( 'VEC2' ).setArray( g.uvs ).setBuffer( buffer ) );
		if ( g.ao ) {

			const col = new Uint8Array( g.ao.length * 3 );
			for ( let i = 0; i < g.ao.length; i ++ ) { const v = Math.round( Math.min( 1, Math.max( 0, g.ao[ i ] ) ) * 255 ); col[ i * 3 ] = v; col[ i * 3 + 1 ] = v; col[ i * 3 + 2 ] = v; }
			prim.setAttribute( 'COLOR_0', doc.createAccessor().setType( 'VEC3' ).setNormalized( true ).setArray( col ).setBuffer( buffer ) );

		}

		const node = doc.createNode( target ).setMesh( doc.createMesh( target ).addPrimitive( prim ) );
		parent.addChild( node );
		stats.meshes ++; stats.triangles += triCount( g ); stats.vertices += g.positions.length / 3;
		stats.perMesh[ target ] = { triangles: triCount( g ), vertices: g.positions.length / 3, material: def.material, parent: parent.getName() };

	}

	doc.createExtension( KHRDracoMeshCompression ).setRequired( true ).setEncoderOptions( {
		method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER, encodeSpeed: 3, decodeSpeed: 5,
		quantizationBits: { POSITION: lod === 0 ? 15 : 13, NORMAL: lod === 0 ? 13 : 10, COLOR: 8, TEX_COORD: 12, GENERIC: 12 },
	} );
	return { doc, stats };

}

mkdirSync( OUT, { recursive: true } );
const result = {};
for ( const [ meshMap, name, lod ] of [ [ meshes, 'car.glb', 0 ], [ lod1, 'car_lod1.glb', 1 ] ] ) {

	if ( lod === 0 && ! KEEP_BADGES ) meshMap.delete( 'badges' );
	const { doc, stats } = writeDoc( meshMap, name, { lod } );
	const file = join( OUT, name );
	await io.write( file, doc );
	stats.bytes = statSync( file ).size;
	result[ name ] = stats;
	log( `${name}: ${stats.meshes} meshes, ${stats.triangles} triangles, ${stats.vertices} vertices, ${( stats.bytes / 1024 ).toFixed( 0 )} KiB` );

}

if ( META ) {

	writeFileSync( META, JSON.stringify( {
		wheelInfo, wheelCentre, steering: { origin: STEER_ORIGIN, axisTowardsDriver: STEER_AXIS, tiltDeg: STEER_TILT * 180 / Math.PI, columnQuaternion: STEER_QUAT },
		anchors, result, classifyLog, droppedBadges: { ...dropped, kinds: [ ...new Set( badgeNotes ) ] },
		targets: TARGETS, materials: MATERIALS,
	}, null, 1 ) );

}

log( 'done in', ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ), 's' );
