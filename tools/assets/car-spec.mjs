#!/usr/bin/env node
// Measure the built car GLBs and write the structural spec public/assets/car/car.json.
//   node tools/assets/car-spec.mjs [--dir public/assets/car] [--meta <build meta json>] [--out <car.json>]
// Everything under "measured" comes from reading car.glb / car_lod1.glb back (not from the build script's intentions).
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeIO, worldMatrix, readPrimitiveWorld, connectedComponents, bboxOf, r4 } from './car-lib.mjs';
import { RECIPE } from './car-recipe.mjs';

const argv = process.argv.slice( 2 );
const opt = ( k, d ) => ( argv.includes( '--' + k ) ? argv[ argv.indexOf( '--' + k ) + 1 ] : d );
const DIR = opt( 'dir', 'public/assets/car' );
const META = opt( 'meta', null );
const OUT = opt( 'out', join( DIR, 'car.json' ) );
const meta = META && existsSync( META ) ? JSON.parse( readFileSync( META, 'utf8' ) ) : null;

const io = await makeIO();

async function readCar( file ) {

	const doc = await io.read( file );
	const nodes = {};
	const meshes = {};
	let triangles = 0, vertices = 0, drawCalls = 0;
	const all = { min: [ Infinity, Infinity, Infinity ], max: [ - Infinity, - Infinity, - Infinity ] };
	for ( const node of doc.getRoot().listNodes() ) {

		const m = worldMatrix( node );
		const parent = node.getParentNode() ? node.getParentNode().getName() : null;
		nodes[ node.getName() ] = { parent, translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale(), world: m, children: node.listChildren().map( ( c ) => c.getName() ) };
		const mesh = node.getMesh();
		if ( ! mesh ) continue;
		const prims = mesh.listPrimitives();
		const g = readPrimitiveWorld( prims[ 0 ], m );
		const local = readPrimitiveWorld( prims[ 0 ], [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
		const bb = bboxOf( g.positions );
		for ( let k = 0; k < 3; k ++ ) { all.min[ k ] = Math.min( all.min[ k ], bb.min[ k ] ); all.max[ k ] = Math.max( all.max[ k ], bb.max[ k ] ); }
		const tris = g.indices.length / 3;
		triangles += tris; vertices += g.positions.length / 3; drawCalls += prims.length;
		meshes[ node.getName() ] = {
			parent, material: prims[ 0 ].getMaterial().getName(), triangles: tris, vertices: g.positions.length / 3,
			attributes: prims[ 0 ].listSemantics(), bbox: bb, world: g, local,
		};

	}

	return { doc, nodes, meshes, triangles, vertices, drawCalls, bbox: all, materials: doc.getRoot().listMaterials().map( ( m ) => m.getName() ), bytes: statSync( file ).size };

}

const lod0 = await readCar( join( DIR, 'car.glb' ) );
const lod1 = await readCar( join( DIR, 'car_lod1.glb' ) );
const M = lod0.meshes, N = lod0.nodes;
const comps = ( name, minTris = 0 ) => { const g = M[ name ].world; return connectedComponents( g.positions, g.indices ).list.filter( ( c ) => c.tris >= minTris ); };
const isIdentityQ = ( q ) => Math.abs( q[ 0 ] ) < 1e-6 && Math.abs( q[ 1 ] ) < 1e-6 && Math.abs( q[ 2 ] ) < 1e-6 && Math.abs( Math.abs( q[ 3 ] ) - 1 ) < 1e-6;

// --- wheels ------------------------------------------------------------------------------------------------------------
const wheels = {};
let groundY = Infinity;
for ( const w of [ 'fl', 'fr', 'rl', 'rr' ] ) {

	const hub = N[ `wheel_${w}` ], spin = N[ `wheel_${w}_spin` ];
	const tyre = M[ `wheel_${w}_tire` ], rim = M[ `wheel_${w}_rim` ], disc = M[ `wheel_${w}_disc` ], cal = M[ `wheel_${w}_caliper` ];
	const lp = tyre.local.positions;
	let R = 0;
	for ( let i = 0; i < lp.length; i += 3 ) R = Math.max( R, Math.hypot( lp[ i + 1 ], lp[ i + 2 ] ) );
	const lb = bboxOf( lp );
	let rimR = 0;
	for ( let i = 0; i < rim.local.positions.length; i += 3 ) rimR = Math.max( rimR, Math.hypot( rim.local.positions[ i + 1 ], rim.local.positions[ i + 2 ] ) );
	let discR = 0;
	for ( let i = 0; i < disc.local.positions.length; i += 3 ) discR = Math.max( discR, Math.hypot( disc.local.positions[ i + 1 ], disc.local.positions[ i + 2 ] ) );
	const rb = bboxOf( rim.local.positions ), db = bboxOf( disc.local.positions );
	groundY = Math.min( groundY, tyre.bbox.min[ 1 ] );
	const centre = [ hub.world[ 12 ], hub.world[ 13 ], hub.world[ 14 ] ];
	wheels[ w ] = {
		node: `wheel_${w}`, spinNode: `wheel_${w}_spin`,
		position: r4( centre ),
		radius: r4( R ), width: r4( lb.size[ 0 ] ), tread: undefined,
		axleAxisLocal: [ 1, 0, 0 ], steerAxisLocal: [ 0, 1, 0 ],
		originAtWheelCentre: Math.hypot( ...lb.center ) < 1e-3,
		restRotationIsIdentity: isIdentityQ( hub.rotation ) && isIdentityQ( spin.rotation ),
		tyreBBoxCentreLocal: r4( lb.center ),
		steered: w[ 0 ] === 'f', driven: w[ 0 ] === 'r', side: w[ 1 ] === 'l' ? 'left' : 'right', outboardSign: w[ 1 ] === 'l' ? - 1 : 1,
		rimRadius: r4( rimR ), rimWidthLocalX: r4( [ rb.min[ 0 ], rb.max[ 0 ] ] ),
		discRadius: r4( discR ), discLocalX: r4( [ db.min[ 0 ], db.max[ 0 ] ] ),
		meshes: { tyre: `wheel_${w}_tire`, rim: `wheel_${w}_rim`, disc: `wheel_${w}_disc`, caliper: cal ? `wheel_${w}_caliper` : null },
		caliperBBoxLocal: cal ? { min: r4( bboxOf( cal.local.positions ).min ), max: r4( bboxOf( cal.local.positions ).max ) } : null,
	};
	delete wheels[ w ].tread;

}

const wheelbase = Math.abs( wheels.rl.position[ 2 ] - wheels.fl.position[ 2 ] );
const trackFront = Math.abs( wheels.fr.position[ 0 ] - wheels.fl.position[ 0 ] );
const trackRear = Math.abs( wheels.rr.position[ 0 ] - wheels.rl.position[ 0 ] );

// --- steering wheel ----------------------------------------------------------------------------------------------------
const col = N.steering_column, sw = N.steering_wheel;
const steerAxisWorld = [ col.world[ 8 ], col.world[ 9 ], col.world[ 10 ] ]; // local +Z of the column
const swMeshes = Object.entries( M ).filter( ( [ , m ] ) => m.parent === 'steering_wheel' );
const swBox = bboxOf( Float32Array.from( swMeshes.flatMap( ( [ , m ] ) => [ ...m.local.positions ] ) ) );
const steering = {
	node: 'steering_wheel', parentNode: 'steering_column',
	position: r4( [ sw.world[ 12 ], sw.world[ 13 ], sw.world[ 14 ] ] ),
	rotationAxisLocal: [ 0, 0, 1 ], rotationAxisWorld: r4( steerAxisWorld ),
	columnTiltDeg: r4( Math.atan2( steerAxisWorld[ 1 ], steerAxisWorld[ 2 ] ) * 180 / Math.PI ),
	columnQuaternion: r4( col.rotation ),
	restRotationIsIdentity: isIdentityQ( sw.rotation ),
	rimDiameter: r4( Math.max( swBox.size[ 0 ], swBox.size[ 1 ] ) ),
	bboxLocal: { min: r4( swBox.min ), max: r4( swBox.max ) },
	side: sw.world[ 12 ] < 0 ? 'left (LHD)' : 'right (RHD)',
	usage: 'steering_wheel.rotation.z = +angle turns the wheel counter-clockwise as seen by the driver = steering LEFT (same sign as wheel_f*.rotation.y). Suggested ratio: steering wheel angle = 12 * road-wheel angle, clamp +-450 deg.',
	meshes: swMeshes.map( ( [ n ] ) => n ),
};

// --- lamps, exhausts, mirrors ------------------------------------------------------------------------------------------
const lr = ( list ) => { const s = [ ...list ].sort( ( a, b ) => a.center[ 0 ] - b.center[ 0 ] ); return { left: s[ 0 ], right: s[ s.length - 1 ] }; };
const head = lr( comps( 'light_headlight' ) );
const tail = lr( comps( 'light_tail', 1000 ) );
const exhaust = comps( 'exhaust_tips', 400 ).filter( ( c ) => c.size[ 0 ] > 0.07 ).sort( ( a, b ) => a.center[ 0 ] - b.center[ 0 ] );
const drlAll = comps( 'light_drl' );
const drl = { left: bboxOf( Float32Array.from( drlAll.filter( ( c ) => c.center[ 0 ] < 0 ).flatMap( ( c ) => [ ...c.min, ...c.max ] ) ) ), right: bboxOf( Float32Array.from( drlAll.filter( ( c ) => c.center[ 0 ] > 0 ).flatMap( ( c ) => [ ...c.min, ...c.max ] ) ) ) };
const mirrors = comps( 'mirror' ).sort( ( a, b ) => a.center[ 0 ] - b.center[ 0 ] );
const lamps = {
	headlights: {
		mesh: 'light_headlight', material: 'Projector_Glass', direction: [ 0, 0, - 1 ],
		left: r4( [ head.left.center[ 0 ], head.left.center[ 1 ], head.left.min[ 2 ] ] ), right: r4( [ head.right.center[ 0 ], head.right.center[ 1 ], head.right.min[ 2 ] ] ),
		lensDiameter: r4( head.left.size[ 0 ] ), note: 'position = centre of the projector lens at its front surface; put SpotLights here pointing along direction (dip ~2 deg)',
	},
	drl: { mesh: 'light_drl', material: 'Turn_Signal_LED', leftBBox: { min: r4( drl.left.min ), max: r4( drl.left.max ) }, rightBBox: { min: r4( drl.right.min ), max: r4( drl.right.max ) }, ledCount: drlAll.length },
	tailLights: {
		mesh: 'light_tail', material: 'Taillight_Glass', lensMesh: 'taillight_lens', lensMaterial: 'Taillight_Lens', direction: [ 0, 0, 1 ],
		left: r4( [ tail.left.center[ 0 ], tail.left.center[ 1 ], tail.left.max[ 2 ] ] ), right: r4( [ tail.right.center[ 0 ], tail.right.center[ 1 ], tail.right.max[ 2 ] ] ),
		diameter: r4( tail.left.size[ 0 ] ),
	},
	brakeHigh: { mesh: 'light_brake_high', material: 'Light_Brake_High', center: r4( M.light_brake_high.bbox.center ), size: r4( M.light_brake_high.bbox.size ) },
	reverse: { mesh: 'light_reverse', material: 'Light_Reverse', center: r4( M.light_reverse.bbox.center ), size: r4( M.light_reverse.bbox.size ), note: 'right-hand lower bumper lamp' },
	fogRear: { mesh: 'light_fog', material: 'Light_Fog_Rear', center: r4( M.light_fog.bbox.center ), size: r4( M.light_fog.bbox.size ), note: 'left-hand lower bumper lamp' },
	indicators: {
		material: 'Light_Indicator', left: { mesh: 'light_indicator_l', parts: comps( 'light_indicator_l', 100 ).map( ( c ) => r4( c.center ) ) }, right: { mesh: 'light_indicator_r', parts: comps( 'light_indicator_r', 100 ).map( ( c ) => r4( c.center ) ) },
		note: 'each side = fender repeater + LED cluster in the centre of the round tail lamp. Front indicators: blink the DRL strip amber.',
	},
};
const exhaustTips = { mesh: 'exhaust_tips', material: 'Exhaust_Tip', direction: [ 0, 0, 1 ], tips: exhaust.map( ( c ) => ( { position: r4( [ c.center[ 0 ], c.center[ 1 ], c.max[ 2 ] ] ), outerDiameter: r4( Math.max( c.size[ 0 ], c.size[ 1 ] ) ) } ) ) };

// --- body envelope (for colliders) -------------------------------------------------------------------------------------
const body = M.body.world.positions;
const slices = [];
for ( let z0 = - 2.3; z0 < 2.3; z0 += 0.2 ) {

	let yMin = Infinity, yMax = - Infinity, xMax = 0, n = 0;
	for ( let i = 0; i < body.length; i += 3 ) { const z = body[ i + 2 ]; if ( z < z0 || z >= z0 + 0.2 ) continue; n ++; yMin = Math.min( yMin, body[ i + 1 ] ); yMax = Math.max( yMax, body[ i + 1 ] ); xMax = Math.max( xMax, Math.abs( body[ i ] ) ); }
	if ( n ) slices.push( { z: r4( z0 + 0.1 ), yMin: r4( yMin ), yMax: r4( yMax ), halfWidth: r4( xMax ) } );

}

// body half width without the mirrors: widest body vertex below mirror height
let bodyHalfWidthNoMirrors = 0;
for ( let i = 0; i < body.length; i += 3 ) if ( body[ i + 1 ] < 0.72 ) bodyHalfWidthNoMirrors = Math.max( bodyHalfWidthNoMirrors, Math.abs( body[ i ] ) );
let lowest = Infinity;
for ( const [ name, m ] of Object.entries( M ) ) if ( ! name.startsWith( 'wheel_' ) ) lowest = Math.min( lowest, m.bbox.min[ 1 ] );

// --- seats (for the cockpit camera) ------------------------------------------------------------------------------------
const seatParts = comps( 'interior_seats', 300 ).sort( ( a, b ) => a.center[ 0 ] - b.center[ 0 ] );
const driverSeat = seatParts[ 0 ];

// --- cameras (chosen from the measured seat / bonnet geometry and verified with screenshots) -----------------------------
const driverEye = [ r4( driverSeat.center[ 0 ] ), 1.045, 0.16 ];
const cameras = {
	driverEye: { position: driverEye, lookAt: [ driverEye[ 0 ], 0.97, - 6 ], fovSuggested: 62, near: 0.05, side: steering.side, note: 'head position of a ~1.78 m driver; steering wheel is on the LEFT. Hide nothing: the interior is fully modelled.' },
	passengerEye: { position: [ - driverEye[ 0 ], driverEye[ 1 ], driverEye[ 2 ] ] },
	bonnet: { position: [ 0, 0.98, - 0.86 ], lookAt: [ 0, 0.86, - 8 ], fovSuggested: 58, near: 0.05, note: 'just ahead of the windscreen base, shows the top of the bonnet and both front wings' },
	bumper: { position: [ 0, 0.42, - 2.30 ], lookAt: [ 0, 0.40, - 10 ], fovSuggested: 62, note: 'in front of the nose, nothing of the car visible' },
	chase: { position: [ 0, 1.55, 6.2 ], lookAt: [ 0, 0.75, - 1.5 ], fovSuggested: 45, note: 'default third-person camera in car space' },
};

// --- physics suggestions -----------------------------------------------------------------------------------------------
const zFront = lod0.bbox.min[ 2 ], zRear = lod0.bbox.max[ 2 ];
const chassisBottom = 0.30, chassisTop = 1.00;
const physics = {
	note: 'Suggestions. Car space: origin on the ground under the middle of the car, +Y up, nose towards -Z, +X = right.',
	chassisBox: {
		halfExtents: [ r4( bodyHalfWidthNoMirrors - 0.015 ), r4( ( chassisTop - chassisBottom ) / 2 ), r4( ( zRear - zFront ) / 2 - 0.03 ) ],
		center: [ 0, r4( ( chassisTop + chassisBottom ) / 2 ), r4( ( zRear + zFront ) / 2 ) ],
		note: `covers the body shell from y=${chassisBottom} (below wheel-centre height ${wheels.fl.position[ 1 ]}, above the ${r4( lowest )} m ground clearance) to the top of the rear deck; the lower half of the wheels, the splitter/diffuser lips and the mirrors stick out on purpose`,
	},
	cabinBox: { halfExtents: [ 0.72, 0.12, 0.42 ], center: [ 0, 1.12, - 0.42 ], note: 'optional second collider: windscreen frame / roll-over height' },
	centerOfMass: { position: [ 0, 0.46, r4( wheels.fl.position[ 2 ] + 0.58 * wheelbase ) ], note: 'estimate: mid-rear engine, 42 % front / 58 % rear static weight distribution, CoG height ~0.46 m' },
	massKg: 1535, massNote: 'kerb weight of the real car this model depicts (for reference)',
	wheelRadius: wheels.fl.radius, wheelbase: r4( wheelbase ), trackFront: r4( trackFront ), trackRear: r4( trackRear ),
	suspensionRestLength: 0.11, suspensionTravelNote: 'visual clearance tyre top -> wheel arch is about 0.06 m front / 0.07 m rear; keep visual bump travel within +-0.05 m',
	maxSteerAngleDeg: 33,
	groundClearance: r4( lowest ),
};

// --- roles -------------------------------------------------------------------------------------------------------------
const meshesWith = ( mat ) => Object.entries( M ).filter( ( [ , m ] ) => m.material === mat ).map( ( [ n ] ) => n );
const roles = {
	bodyPaint: { meshes: [ 'body' ], material: 'Body_Color' },
	glass: { windscreen: { meshes: [ 'glass' ], material: 'Glass_Gray' }, lampCovers: { meshes: [ 'glass_lamps' ], material: 'Lamp_Glass' }, tailLampLens: { meshes: [ 'taillight_lens' ], material: 'Taillight_Lens' } },
	rims: { meshes: meshesWith( 'Rim' ), material: 'Rim', uvMasks: 'TEXCOORD_0.x = 1 on the machined spoke face + outer lip, TEXCOORD_0.y = 1 on the centre cap' },
	tires: { meshes: meshesWith( 'Tires' ), material: 'Tires' },
	brakeDiscs: { meshes: meshesWith( 'Brake_Disc' ), material: 'Brake_Disc' },
	brakeCalipers: { meshes: meshesWith( 'Brake_Caliper' ), material: 'Brake_Caliper', note: 'children of the hub node (wheel_xx), NOT of wheel_xx_spin: they steer but do not rotate with the wheel' },
	headlightLens: { meshes: [ 'light_headlight' ], material: 'Projector_Glass' },
	daytimeRunningLights: { meshes: [ 'light_drl' ], material: 'Turn_Signal_LED' },
	tailLights: { meshes: [ 'light_tail' ], material: 'Taillight_Glass', note: 'make emissive when braking (plus light_brake_high)' },
	brakeLightHigh: { meshes: [ 'light_brake_high' ], material: 'Light_Brake_High' },
	reverseLight: { meshes: [ 'light_reverse' ], material: 'Light_Reverse' },
	rearFogLight: { meshes: [ 'light_fog' ], material: 'Light_Fog_Rear' },
	indicators: { left: [ 'light_indicator_l' ], right: [ 'light_indicator_r' ], material: 'Light_Indicator' },
	exteriorTrim: { meshes: [ 'trim_black', 'grille', 'chrome', 'mirror', 'exhaust_tips', 'headlight_housing' ], materials: [ 'Trim_Black', 'Grille_Mesh', 'metal_chrome', 'Mirror', 'Exhaust_Tip', 'Headlight_Housing' ] },
	interior: { group: 'interior', meshes: Object.entries( M ).filter( ( [ , m ] ) => m.parent === 'interior' ).map( ( [ n ] ) => n ), materials: [ ...new Set( Object.entries( M ).filter( ( [ , m ] ) => m.parent === 'interior' || m.parent === 'steering_wheel' ).map( ( [ , m ] ) => m.material ) ) ] },
	steeringWheel: { node: 'steering_wheel', meshes: steering.meshes },
	badges: { meshes: [], note: 'all brand emblems, scripts and shields of the source model were removed in the build (pass --keep-badges to car-build.mjs to keep them as a separate "badges" mesh)' },
};

// --- hierarchy ---------------------------------------------------------------------------------------------------------
function tree( file ) {

	const out = {};
	for ( const [ name, n ] of Object.entries( file.nodes ) ) {

		const m = file.meshes[ name ];
		out[ name ] = { parent: n.parent, ...( m ? { mesh: true, material: m.material, triangles: m.triangles, vertices: m.vertices, attributes: m.attributes } : { group: true } ), ...( ( n.translation.some( ( v ) => Math.abs( v ) > 1e-9 ) ) ? { translation: r4( n.translation ) } : {} ), ...( isIdentityQ( n.rotation ) ? {} : { rotation: r4( n.rotation ) } ) };

	}

	return out;

}

const spec = {
	name: 'Alpenglow player car',
	generatedBy: 'tools/assets/car-build.mjs + tools/assets/car-spec.mjs',
	files: {
		lod0: { file: 'car.glb', bytes: lod0.bytes, triangles: lod0.triangles, vertices: lod0.vertices, meshes: Object.keys( lod0.meshes ).length, drawCalls: lod0.drawCalls, materials: lod0.materials.length, compression: 'KHR_draco_mesh_compression (position 15 bit, normal 13 bit)' },
		lod1: { file: 'car_lod1.glb', bytes: lod1.bytes, triangles: lod1.triangles, vertices: lod1.vertices, meshes: Object.keys( lod1.meshes ).length, drawCalls: lod1.drawCalls, materials: lod1.materials.length, compression: 'KHR_draco_mesh_compression (position 13 bit, normal 10 bit)' },
		groundShadow: 'car_ground_ao.png', textures: [ 'tire_tread_n.png', 'tire_sidewall_n.png' ],
	},
	license: {
		model: 'Ferrari 458 Italia', author: 'vicent091036', authorUrl: 'https://sketchfab.com/vicent091036',
		source: 'https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6', sourceStatus: 'page no longer online (HTTP 404 on 2026-11-17); licence confirmed from the archived page https://web.archive.org/web/20230422084806/https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6/embed',
		obtainedFrom: 'three.js r187 examples/models/gltf/ferrari.glb + ferrari_ao.png (https://github.com/mrdoob/three.js)',
		license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
		requiredAttribution: '"Ferrari 458 Italia" by vicent091036 (https://sketchfab.com/vicent091036), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Modified.',
		modifications: 'meshes re-grouped by role, brand emblems/scripts removed, tyres rebuilt with UVs, brake calipers added, wheel positions symmetrised, ambient occlusion baked to vertex colours, LOD generated',
		trademarkNote: 'CC BY covers the 3D model only. The body shape is that of a real production car; emblems and lettering were removed but the design itself may be protected.',
		ownTextures: 'tire_tread_n.png, tire_sidewall_n.png: generated procedurally by tools/assets/car-textures.mjs (original work, no third-party content)',
	},
	units: 'metres', upAxis: '+Y', forwardAxis: '-Z', rightAxis: '+X', handedness: 'right-handed',
	forwardNote: 'the nose points towards -Z; headlights at z < 0, tail lights at z > 0. Positive yaw (rotation about +Y) and positive steering angle turn LEFT.',
	origin: 'on the ground plane, midway between the bumpers and on the car centre line (x = 0)',
	groundY: r4( groundY ),
	size: { length: r4( lod0.bbox.max[ 2 ] - lod0.bbox.min[ 2 ] ), widthWithMirrors: r4( lod0.bbox.max[ 0 ] - lod0.bbox.min[ 0 ] ), widthBody: r4( bodyHalfWidthNoMirrors * 2 ), height: r4( lod0.bbox.max[ 1 ] - lod0.bbox.min[ 1 ] ) },
	bbox: { min: r4( lod0.bbox.min ), max: r4( lod0.bbox.max ) },
	wheelbase: r4( wheelbase ), trackFront: r4( trackFront ), trackRear: r4( trackRear ),
	wheels,
	wheelAnimation: {
		spin: 'wheel_xx_spin.rotation.x -= distanceTravelled / radius   (negative rotation.x = rolling forward, towards -Z)',
		steer: 'wheel_fl.rotation.y = wheel_fr.rotation.y = steerAngle   (radians, positive = left)',
		suspension: 'wheel_xx.position.y = restY + travel   (restY = wheels.xx.position[1])',
		note: 'hub nodes (wheel_xx) and spin nodes (wheel_xx_spin) have identity rest rotation and their origin at the wheel centre; the axle is the local X axis.',
	},
	steeringWheel: steering,
	lamps, exhaustTips,
	mirrors: { mesh: 'mirror', material: 'Mirror', parts: mirrors.map( ( c ) => ( { center: r4( c.center ), size: r4( c.size ) } ) ) },
	cameras, physics,
	bodyProfile: { note: 'body-paint mesh envelope per 0.2 m slice along Z (yMin/yMax/half width incl. mirrors)', slices },
	roles,
	groundShadow: {
		file: 'car_ground_ao.png', source: 'three.js examples/models/gltf/ferrari_ao.png (baked contact shadow / ground AO for this exact model)',
		geometry: 'PlaneGeometry(0.655 * 4, 1.3 * 4) = 2.62 m (X) x 5.2 m (Z)', size: [ 2.62, 5.2 ],
		placement: 'child of the car root at the origin, rotation.x = -PI/2 (lies on the ground, y = 0); image top = car nose (-Z)',
		material: 'MeshBasicMaterial({ map, blending: MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true })',
		renderOrder: 2,
		notes: [ 'white = no darkening; it multiplies whatever is below, so it needs no alpha channel', 'in r187 WebGPU MultiplyBlending REQUIRES premultipliedAlpha = true', 'add depthWrite: false and a small polygonOffset (or y = 0.005) when the road is not perfectly flat; fade it out with speed/height if the car can leave the ground' ],
	},
	materials: RECIPE,
	hierarchy: { lod0: tree( lod0 ), lod1: tree( lod1 ) },
	lod1Notes: 'same node names for everything that is animated (wheel_xx, wheel_xx_spin, steering_column, steering_wheel) and for the role meshes that still exist; one layer of triangles only (use shadowSide = DoubleSide when it is used as a shadow caster); tyres keep their UV layout, rims keep the UV masks.',
	build: meta ? { droppedBadges: meta.droppedBadges, caliper: Object.fromEntries( Object.entries( meta.wheelInfo ).map( ( [ w, i ] ) => [ w, i.caliper ] ) ), sourceWheelCentres: Object.fromEntries( Object.entries( meta.wheelInfo ).map( ( [ w, i ] ) => [ w, r4( i.sourceCentre ) ] ) ) } : undefined,
	measuredSeat: { driverSeatInsertBBox: { min: r4( driverSeat.min ), max: r4( driverSeat.max ) } },
};

writeFileSync( OUT, JSON.stringify( spec, null, '\t' ) );
console.log( 'wrote', OUT, statSync( OUT ).size, 'bytes' );
console.log( JSON.stringify( { size: spec.size, groundY: spec.groundY, wheelbase: spec.wheelbase, trackFront: spec.trackFront, trackRear: spec.trackRear, wheels: Object.fromEntries( Object.entries( wheels ).map( ( [ k, w ] ) => [ k, { p: w.position, r: w.radius, w: w.width, ok: w.originAtWheelCentre && w.restRotationIsIdentity } ] ) ), steering: { p: steering.position, axis: steering.rotationAxisWorld, d: steering.rimDiameter }, head: lamps.headlights.left, tail: lamps.tailLights.left, exhaust: exhaustTips.tips.map( ( t ) => t.position ), lowest: r4( lowest ), bodyHalfWidthNoMirrors: r4( bodyHalfWidthNoMirrors ), seat: spec.measuredSeat, lod0: spec.files.lod0, lod1: spec.files.lod1 } ) );
