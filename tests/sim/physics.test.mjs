// Tests of the Rapier wrapper: heightfield layout, ray casts, collider kinds / surfaces, props, impacts, determinism.
// Run with: node --test tests/sim/physics.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng, randRange } from '../../src/core/rng.js';
import { GRAVITY, PHYSICS_DT, Surface } from '../../src/sim/constants.js';
import { PhysicsWorld, loadRapier } from '../../src/sim/physics.js';

const RAPIER = await loadRapier();

/** Asymmetric analytic terrain: different slopes along x and z plus a wave along x only. */
function terrainHeight( x, z ) {

	return 0.1 * x + 0.03 * z + 2 * Math.sin( x / 7 );

}

/** Builds the row-major (index = iz * n + ix) height grid the contract describes. */
function sampleGrid( fn, n, cell, minX, minZ ) {

	const heights = new Float32Array( n * n );
	for ( let iz = 0; iz < n; iz ++ ) {

		for ( let ix = 0; ix < n; ix ++ ) heights[ iz * n + ix ] = fn( minX + ix * cell, minZ + iz * cell );

	}

	return heights;

}

function addFlatGround( physics, { y = 0, kind = 'terrain', n = 33, cell = 4, minX = - 64, minZ = - 64 } = {} ) {

	return physics.addHeightfield( { heights: new Float32Array( n * n ).fill( y ), n, cell, minX, minZ, kind } );

}

/** A box-shaped point cloud centred on (0, cy, 0). */
function boxHull( hx, hy, hz, cy = 0 ) {

	const points = [];
	for ( const sx of [ - 1, 1 ] ) for ( const sy of [ - 1, 1 ] ) for ( const sz of [ - 1, 1 ] ) points.push( sx * hx, cy + sy * hy, sz * hz );
	return new Float32Array( points );

}

function addTestVehicleBody( physics, position, mass = 1200 ) {

	return physics.addVehicleBody( {
		hulls: [ boxHull( 0.9, 0.3, 2.0, 0.5 ) ],
		position,
		mass,
		centerOfMass: [ 0, 0.5, 0 ],
		principalInertia: [ 1500, 1700, 450 ],
	} );

}

test( 'loadRapier is idempotent', async () => {

	const first = loadRapier(), second = loadRapier();
	assert.equal( first, second );
	assert.equal( await first, RAPIER );
	assert.equal( typeof RAPIER.World, 'function' );

} );

test( 'heightfield orientation, origin and scale match the row-major grid contract', () => {

	const n = 65, cell = 1.5, minX = - 31, minZ = 12; // minX != minZ, so a swapped or mis-centred field cannot pass
	const size = ( n - 1 ) * cell;
	const physics = new PhysicsWorld( RAPIER );
	const heights = sampleGrid( terrainHeight, n, cell, minX, minZ );
	physics.addHeightfield( { heights, n, cell, minX, minZ } );
	physics.step();

	// The wave has |d2h/dx2| <= 2 / 49 and the function is linear in z, so linear interpolation over one cell is
	// off by at most cell^2 / 8 * 2 / 49.
	const triangulationError = cell * cell / 8 * ( 2 / 49 );
	const rng = makeRng( 1234 );
	let worstAnalytic = 0, worstGrid = 0;
	for ( let i = 0; i < 500; i ++ ) {

		const x = randRange( rng, minX + 0.01, minX + size - 0.01 );
		const z = randRange( rng, minZ + 0.01, minZ + size - 0.01 );
		const hit = physics.raycast( x, 60, z, 0, - 1, 0, 200 );
		assert.ok( hit, `ray ${i} at (${x}, ${z}) must hit the heightfield` );
		const y = 60 - hit.distance;
		assert.ok( Math.abs( hit.point[ 0 ] - x ) < 1e-9 && Math.abs( hit.point[ 2 ] - z ) < 1e-9 && Math.abs( hit.point[ 1 ] - y ) < 1e-9 );
		worstAnalytic = Math.max( worstAnalytic, Math.abs( y - terrainHeight( x, z ) ) );

		// With no x*z twist the four corners of every cell are coplanar: the collider must reproduce the
		// bilinear interpolation of the grid we handed over, whichever diagonal it splits the cells along.
		const fx = ( x - minX ) / cell, fz = ( z - minZ ) / cell;
		const ix = Math.min( n - 2, Math.floor( fx ) ), iz = Math.min( n - 2, Math.floor( fz ) );
		const tx = fx - ix, tz = fz - iz;
		const h00 = heights[ iz * n + ix ], h10 = heights[ iz * n + ix + 1 ];
		const h01 = heights[ ( iz + 1 ) * n + ix ], h11 = heights[ ( iz + 1 ) * n + ix + 1 ];
		const expected = ( h00 * ( 1 - tx ) + h10 * tx ) * ( 1 - tz ) + ( h01 * ( 1 - tx ) + h11 * tx ) * tz;
		worstGrid = Math.max( worstGrid, Math.abs( y - expected ) );

		// The normal faces the ray and matches the analytic gradient within the faceting error.
		const gx = 0.1 + ( 2 / 7 ) * Math.cos( x / 7 ), gz = 0.03;
		const inv = 1 / Math.hypot( gx, 1, gz );
		const dot = hit.normal[ 0 ] * - gx * inv + hit.normal[ 1 ] * inv + hit.normal[ 2 ] * - gz * inv;
		assert.ok( hit.normal[ 1 ] > 0 && dot > 0.999, `normal at (${x}, ${z}) deviates: dot = ${dot}` );
		assert.equal( hit.kind, 'terrain' );

	}

	assert.ok( worstGrid < 2e-4, `heights differ from the grid interpolation by ${worstGrid}` );
	assert.ok( worstAnalytic <= triangulationError + 2e-4, `analytic error ${worstAnalytic} exceeds the triangulation bound ${triangulationError}` );

	// Extent: hits just inside every edge, misses just outside.
	const midX = minX + size / 2, midZ = minZ + size / 2;
	for ( const [ x, z, inside ] of [
		[ minX + 0.05, midZ, true ], [ minX - 0.05, midZ, false ],
		[ minX + size - 0.05, midZ, true ], [ minX + size + 0.05, midZ, false ],
		[ midX, minZ + 0.05, true ], [ midX, minZ - 0.05, false ],
		[ midX, minZ + size - 0.05, true ], [ midX, minZ + size + 0.05, false ],
	] ) {

		assert.equal( physics.raycast( x, 60, z, 0, - 1, 0, 200 ) !== null, inside, `extent check at (${x}, ${z})` );

	}

	physics.dispose();

} );

test( 'triangle-mesh ray casts report height, normal, kind and surface', () => {

	const physics = new PhysicsWorld( RAPIER );
	const plane = ( x ) => 2 + 0.2 * x; // road strip tilted about the z axis
	const positions = new Float32Array( [
		- 4, plane( - 4 ), - 10, 4, plane( 4 ), - 10, 4, plane( 4 ), 10, - 4, plane( - 4 ), 10,
	] );
	const collider = physics.addTriMesh( { positions, indices: new Uint32Array( [ 0, 3, 2, 0, 2, 1 ] ) } );
	physics.step();

	const rng = makeRng( 99 );
	for ( let i = 0; i < 100; i ++ ) {

		const x = randRange( rng, - 3.9, 3.9 ), z = randRange( rng, - 9.9, 9.9 );
		const hit = physics.raycast( x, 20, z, 0, - 1, 0, 100 );
		assert.ok( hit );
		assert.ok( Math.abs( hit.point[ 1 ] - plane( x ) ) < 1e-4 );
		assert.equal( hit.kind, 'road' );
		assert.equal( hit.surface, Surface.ASPHALT );
		assert.equal( hit.collider.handle, collider.handle );
		const inv = 1 / Math.hypot( 0.2, 1 );
		assert.ok( Math.abs( hit.normal[ 0 ] + 0.2 * inv ) < 1e-4 && Math.abs( hit.normal[ 1 ] - inv ) < 1e-4 && Math.abs( hit.normal[ 2 ] ) < 1e-4 );

	}

	// Oblique, non-normalised ray: distance is metric and the hit lies on the plane.
	const hit = physics.raycast( - 3, 10, - 5, 2, - 4, 3, 100 );
	assert.ok( hit );
	assert.ok( Math.abs( hit.point[ 1 ] - plane( hit.point[ 0 ] ) ) < 1e-4 );
	assert.ok( Math.abs( hit.distance - Math.hypot( hit.point[ 0 ] + 3, hit.point[ 1 ] - 10, hit.point[ 2 ] + 5 ) ) < 1e-4 );

	// Too short a ray, a ray beside the mesh and a zero direction all miss.
	assert.equal( physics.raycast( 0, 20, 0, 0, - 1, 0, 5 ), null );
	assert.equal( physics.raycast( 6, 20, 0, 0, - 1, 0, 100 ), null );
	assert.equal( physics.raycast( 0, 20, 0, 0, 0, 0, 100 ), null );

	physics.dispose();

} );

test( 'ray hits report collider kinds and surfaces, honouring the surface query and the filters', () => {

	const physics = new PhysicsWorld( RAPIER );
	addFlatGround( physics, { y: 0 } );
	physics.addTriMesh( { positions: [ - 3, 0.05, - 20, 3, 0.05, - 20, 3, 0.05, 20, - 3, 0.05, 20 ], indices: [ 0, 3, 2, 0, 2, 1 ] } );
	physics.addStaticBox( { center: [ 10, 0.4, 0 ], halfExtents: [ 0.2, 0.4, 5 ], kind: 'rail' } );
	physics.addStaticCylinder( { center: [ 14, 1, 0 ], radius: 0.3, halfHeight: 1, kind: 'tree' } );
	physics.addStaticHull( { points: [ - 1, 0, - 1, 1, 0, - 1, 1, 0, 1, - 1, 0, 1, 0, 1, 0 ], position: [ 20, 0, 0 ], scale: [ 1, 2, 1 ], kind: 'rock' } );
	const prop = physics.addDynamicBody( { shape: { type: 'box', halfExtents: [ 0.3, 0.3, 0.3 ] }, position: [ 30, 0.3, 0 ], mass: 5, userData: 'cone-7' } );
	assert.equal( prop.userData, 'cone-7' );
	assert.equal( physics.dynamicBodies.length, 1 );
	assert.equal( physics.dynamicBodies[ 0 ], prop );

	const calls = [];
	const cast = ( x, z, ...rest ) => physics.raycast( x, 10, z, 0, - 1, 0, 50, ...rest );

	// Colliders are hit before the first step too (they are not in the scene-query structure yet).
	for ( const phase of [ 'before the first step', 'after a step' ] ) {

		// Without a surface query terrain reports asphalt.
		physics.setSurfaceQuery( null );
		assert.equal( cast( 40, 3 ).surface, Surface.ASPHALT, phase );

		physics.setSurfaceQuery( ( x, z ) => {

			calls.push( [ x, z ] );
			return x > 45 ? Surface.GRAVEL : Surface.GRASS;

		} );

		calls.length = 0;
		let hit = cast( 40, 3 );
		assert.deepEqual( [ hit.kind, hit.surface ], [ 'terrain', Surface.GRASS ], phase );
		assert.deepEqual( calls, [ [ 40, 3 ] ], 'the query receives the world x / z of the hit' );
		assert.equal( cast( 50, 3 ).surface, Surface.GRAVEL, phase );

		calls.length = 0;
		hit = cast( 0, 0 );
		assert.deepEqual( [ hit.kind, hit.surface ], [ 'road', Surface.ASPHALT ], phase );
		assert.ok( Math.abs( hit.point[ 1 ] - 0.05 ) < 1e-5 );
		assert.equal( calls.length, 0, 'road hits do not consult the surface query' );

		hit = cast( 10, 0 );
		assert.deepEqual( [ hit.kind, hit.surface ], [ 'rail', Surface.ASPHALT ], phase );
		assert.ok( Math.abs( hit.point[ 1 ] - 0.8 ) < 1e-5 );

		hit = cast( 14, 0 );
		assert.equal( hit.kind, 'tree', phase );
		assert.ok( Math.abs( hit.point[ 1 ] - 2 ) < 1e-5 );

		hit = cast( 20, 0 );
		assert.deepEqual( [ hit.kind, hit.surface ], [ 'rock', Surface.ROCK ], phase );
		assert.ok( Math.abs( hit.point[ 1 ] - 2 ) < 1e-4, 'the hull scale is applied' );

		hit = cast( 30, 0 );
		assert.equal( hit.kind, 'prop', phase );
		assert.ok( Math.abs( hit.point[ 1 ] - 0.6 ) < 0.02 );
		assert.equal( hit.collider.handle, prop.collider.handle );

		hit = cast( 30, 0, null, true );
		assert.equal( hit.kind, 'terrain', `${phase}: staticOnly rays ignore dynamic bodies` );
		hit = cast( 30, 0, prop.body );
		assert.equal( hit.kind, 'terrain', `${phase}: excluded bodies are ignored` );
		assert.equal( cast( 10, 0, null, true ).kind, 'rail', `${phase}: staticOnly rays still hit static colliders` );

		physics.step();

	}

	// The hit object is reused between calls.
	assert.equal( cast( 0, 0 ), cast( 40, 3 ) );

	physics.dispose();

} );

test( 'a dropped dynamic box comes to rest on the heightfield at the right height', () => {

	const physics = new PhysicsWorld( RAPIER );
	const groundY = 3.25;
	addFlatGround( physics, { y: groundY, n: 17, cell: 2.5, minX: - 7, minZ: 31 } );
	const half = 0.4;
	const box = physics.addDynamicBody( { shape: { type: 'box', halfExtents: [ half, half, half ] }, position: [ 9.3, groundY + 2.5, 47.7 ], mass: 20 } );
	assert.ok( Math.abs( box.body.mass() - 20 ) < 1e-3, 'the mass is available right after creation' );

	for ( let i = 0; i < 360; i ++ ) physics.step();

	const p = box.body.translation(), v = box.body.linvel();
	assert.ok( Math.abs( p.y - ( groundY + half ) ) < 0.01, `rest height ${p.y}` );
	assert.ok( Math.abs( p.x - 9.3 ) < 0.02 && Math.abs( p.z - 47.7 ) < 0.02, 'no sideways drift on flat ground' );
	assert.ok( Math.hypot( v.x, v.y, v.z ) < 0.02, 'the box is at rest' );

	// A cylinder and a hull behave too.
	const cylinder = physics.addDynamicBody( { shape: { type: 'cylinder', radius: 0.3, halfHeight: 0.5 }, position: [ 4, groundY + 1.5, 40 ], mass: 8 } );
	const hull = physics.addDynamicBody( { shape: { type: 'hull', points: boxHull( 1, 1, 1 ), scale: [ 0.5, 0.25, 0.5 ] }, position: [ 14, groundY + 1.5, 40 ], mass: 8 } );
	for ( let i = 0; i < 360; i ++ ) physics.step();
	assert.ok( Math.abs( cylinder.body.translation().y - ( groundY + 0.5 ) ) < 0.01 );
	assert.ok( Math.abs( hull.body.translation().y - ( groundY + 0.25 ) ) < 0.01 );

	// A prop created asleep stays where it was put until something touches it.
	const sleeper = physics.addDynamicBody( { shape: { type: 'box', halfExtents: [ 0.2, 0.2, 0.2 ] }, position: [ 0, groundY + 5, 40 ], mass: 2, sleeping: true } );
	for ( let i = 0; i < 60; i ++ ) physics.step();
	assert.ok( Math.abs( sleeper.body.translation().y - ( groundY + 5 ) ) < 1e-6 );

	physics.dispose();

} );

test( 'vehicle bodies get the requested mass properties', () => {

	const physics = new PhysicsWorld( RAPIER );
	const handle = physics.addVehicleBody( {
		hulls: [ boxHull( 0.9, 0.3, 2.0, 0.5 ), boxHull( 0.6, 0.25, 0.8, 1.0 ) ],
		position: [ 5, 2, - 3 ],
		mass: 1480,
		centerOfMass: [ 0, 0.44, 0.21 ],
		principalInertia: [ 1950, 2100, 520 ],
	} );
	const body = handle.body;
	assert.equal( handle.colliders.length, 2 );
	assert.equal( physics.dynamicBodies.length, 0, 'vehicle bodies are not props' );
	assert.ok( Math.abs( body.mass() - 1480 ) < 1e-3 );
	const com = body.localCom();
	assert.ok( Math.abs( com.x ) < 1e-6 && Math.abs( com.y - 0.44 ) < 1e-6 && Math.abs( com.z - 0.21 ) < 1e-6 );
	const worldCom = body.worldCom();
	assert.ok( Math.abs( worldCom.x - 5 ) < 1e-5 && Math.abs( worldCom.y - 2.44 ) < 1e-5 && Math.abs( worldCom.z + 2.79 ) < 1e-5 );

	// The world-space inverse inertia of the unrotated body is diag( 1 / Ixx, 1 / Iyy, 1 / Izz ).
	const inv = body.effectiveWorldInvInertia();
	assert.ok( Math.abs( 1 / inv.m11 - 1950 ) < 0.5 && Math.abs( 1 / inv.m22 - 2100 ) < 0.5 && Math.abs( 1 / inv.m33 - 520 ) < 0.5 );
	assert.ok( Math.abs( inv.m12 ) < 1e-9 && Math.abs( inv.m13 ) < 1e-9 && Math.abs( inv.m23 ) < 1e-9 );

	// Free fall: the colliders add no mass, so gravity alone acts and the body does not rotate.
	for ( let i = 0; i < 12; i ++ ) physics.step();
	const t = 12 * PHYSICS_DT;
	assert.ok( Math.abs( body.linvel().y + GRAVITY * t ) < 1e-3 );
	const w = body.angvel();
	assert.ok( Math.hypot( w.x, w.y, w.z ) < 1e-6 );
	assert.equal( body.isSleeping(), false );

	physics.dispose();

} );

test( 'impact events fire with sensible impulse, speed, normal, point and kind', () => {

	const physics = new PhysicsWorld( RAPIER );
	addFlatGround( physics, { y: 0 } );
	physics.addStaticBox( { center: [ 0, 1, - 30 ], halfExtents: [ 10, 1, 0.5 ], kind: 'rail' } );
	const mass = 1200, dropHeight = 1.2;
	const { body } = addTestVehicleBody( physics, [ 0, dropHeight, 0 ], mass ); // shell bottom is 0.2 m above the origin
	const impacts = [];

	// 1) Free fall produces no events; the landing does.
	let airborneEvents = 0, landingImpulse = 0, landingSpeed = 0, landingStep = - 1, first = null;
	for ( let i = 0; i < 240; i ++ ) {

		physics.step();
		physics.drainImpacts( body, impacts );
		if ( landingStep < 0 && impacts.length > 0 ) {

			landingStep = i;
			first = structuredClone( impacts[ 0 ] );

		}

		if ( landingStep < 0 ) airborneEvents += impacts.length;
		else if ( i < landingStep + 6 ) for ( const impact of impacts ) {

			landingImpulse += impact.impulse;
			landingSpeed = Math.max( landingSpeed, impact.speed );

		}

	}

	const fallSpeed = Math.sqrt( 2 * GRAVITY * ( dropHeight + 0.2 ) );
	assert.equal( airborneEvents, 0 );
	assert.ok( landingStep > 0, 'the landing must generate an impact' );
	assert.equal( first.kind, 'terrain' );
	assert.ok( first.normal[ 1 ] > 0.99, `landing normal points up, away from the ground: ${first.normal}` );
	assert.ok( Math.abs( first.point[ 1 ] ) < 0.05 && Math.abs( first.point[ 0 ] ) < 0.2 && Math.abs( first.point[ 2 ] ) < 0.2, `contact point under the body: ${first.point}` );
	assert.ok( Math.abs( landingSpeed - fallSpeed ) < 0.12 * fallSpeed, `impact speed ${landingSpeed} vs free-fall speed ${fallSpeed}` );
	const momentum = mass * fallSpeed;
	assert.ok( landingImpulse > 0.9 * momentum && landingImpulse < 1.35 * momentum, `landing impulse ${landingImpulse} vs momentum ${momentum}` );

	// 2) Resting on the ground: the weight is reported as a steady low-speed contact.
	physics.drainImpacts( body, impacts );
	physics.step();
	physics.drainImpacts( body, impacts );
	assert.equal( impacts.length, 1 );
	assert.ok( Math.abs( impacts[ 0 ].impulse - mass * GRAVITY * PHYSICS_DT ) < 0.1 * mass * GRAVITY * PHYSICS_DT );
	assert.ok( impacts[ 0 ].speed < 0.05 );

	// 3) Driving into a wall: horizontal normal facing away from the wall, kind of the wall.
	body.setTranslation( { x: 0, y: 0.02, z: - 20 }, true );
	body.setLinvel( { x: 0, y: 0, z: - 12 }, true );
	let wallImpact = null;
	for ( let i = 0; i < 120 && wallImpact === null; i ++ ) {

		physics.step();
		for ( const impact of physics.drainImpacts( body, impacts ) ) if ( impact.kind === 'rail' ) wallImpact = structuredClone( impact );

	}

	assert.ok( wallImpact, 'the wall hit must generate an impact' );
	assert.ok( wallImpact.normal[ 2 ] > 0.95, `wall normal points back toward the car: ${wallImpact.normal}` );
	assert.ok( wallImpact.speed > 8 && wallImpact.speed < 12.5, `wall impact speed ${wallImpact.speed}` );
	assert.ok( wallImpact.impulse > 0.3 * mass * 12 && wallImpact.impulse < 1.5 * mass * 12, `wall impulse ${wallImpact.impulse}` );
	assert.ok( Math.abs( wallImpact.point[ 2 ] + 29.5 ) < 0.6, `wall contact point ${wallImpact.point}` );

	// 4) Hitting a resting prop: the approach speed is the car's, although the prop flies off with it.
	for ( let i = 0; i < 240; i ++ ) physics.step();
	physics.drainImpacts( body, impacts );
	const prop = physics.addDynamicBody( { shape: { type: 'box', halfExtents: [ 0.3, 0.5, 0.3 ] }, position: [ 0, 0.5, 20 ], mass: 15 } );
	for ( let i = 0; i < 60; i ++ ) physics.step();
	body.setTranslation( { x: 0, y: 0.02, z: 10 }, true );
	body.setRotation( { x: 0, y: 0, z: 0, w: 1 }, true );
	body.setAngvel( { x: 0, y: 0, z: 0 }, true );
	body.setLinvel( { x: 0, y: 0, z: 9 }, true );
	let propImpact = null;
	for ( let i = 0; i < 120 && propImpact === null; i ++ ) {

		physics.step();
		for ( const impact of physics.drainImpacts( body, impacts ) ) if ( impact.kind === 'prop' ) propImpact = structuredClone( impact );

	}

	assert.ok( propImpact, 'the prop hit must generate an impact' );
	assert.ok( propImpact.normal[ 2 ] < - 0.9, `prop normal points back toward the car: ${propImpact.normal}` );
	assert.ok( propImpact.speed > 6 && propImpact.speed < 9.5, `prop impact speed ${propImpact.speed}` );
	assert.ok( prop.body.linvel().z > 3, 'the prop was knocked away' );

	// 5) drainImpacts clears: nothing is reported twice.
	physics.drainImpacts( body, impacts );
	assert.equal( physics.drainImpacts( body, impacts ).length, 0 );

	physics.dispose();

} );

test( 'the same 5 s simulation run twice ends in an identical state', () => {

	const run = () => {

		const physics = new PhysicsWorld( RAPIER );
		const n = 33, cell = 2, minX = - 30, minZ = - 34;
		physics.addHeightfield( { heights: sampleGrid( ( x, z ) => 0.2 * terrainHeight( x, z ), n, cell, minX, minZ ), n, cell, minX, minZ } );
		physics.addStaticBox( { center: [ 6, 1, 0 ], halfExtents: [ 0.3, 2, 8 ], kind: 'rail' } );
		const rng = makeRng( 7 );
		for ( let i = 0; i < 12; i ++ ) {

			physics.addDynamicBody( {
				shape: i % 2 ? { type: 'box', halfExtents: [ 0.3, 0.4, 0.5 ] } : { type: 'cylinder', radius: 0.3, halfHeight: 0.4 },
				position: [ randRange( rng, - 8, 4 ), randRange( rng, 3, 9 ), randRange( rng, - 8, 8 ) ],
				mass: randRange( rng, 2, 30 ),
			} );

		}

		const vehicle = addTestVehicleBody( physics, [ - 12, 2.5, 0 ] );
		vehicle.body.setLinvel( { x: 14, y: 0, z: 1.5 }, true );
		vehicle.body.setAngvel( { x: 0.2, y: 0.7, z: - 0.1 }, true );

		const impacts = [];
		let impulseSum = 0;
		for ( let i = 0; i < 600; i ++ ) {

			physics.step();
			for ( const impact of physics.drainImpacts( vehicle.body, impacts ) ) impulseSum += impact.impulse;

		}

		const state = [ impulseSum ];
		for ( const body of [ vehicle.body, ...physics.dynamicBodies.map( ( handle ) => handle.body ) ] ) {

			const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel();
			state.push( p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z );

		}

		physics.dispose();
		return state;

	};

	const a = run(), b = run();
	assert.ok( a.every( Number.isFinite ) );
	assert.ok( a[ 0 ] > 0, 'the scenario includes collisions' );
	assert.deepEqual( a, b );

} );

test( 'invalid geometry is rejected with a clear error', () => {

	const physics = new PhysicsWorld( RAPIER );
	assert.throws( () => physics.addHeightfield( { heights: new Float32Array( 10 ), n: 4, cell: 1, minX: 0, minZ: 0 } ), /expected 16 heights/ );
	assert.throws( () => physics.addDynamicBody( { shape: { type: 'sphere' }, position: [ 0, 0, 0 ], mass: 1 } ), /unknown shape type/ );
	physics.dispose();

} );
