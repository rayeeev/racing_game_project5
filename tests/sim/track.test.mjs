// Generic correctness tests of the track machinery (not of the circuit design): frames, continuity, sign conventions,
// projection round trips, spawn poses, determinism, performance budgets, and the layout checker's own logic.
// Run with: node --test tests/sim/track.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { DEG2RAD, angleDelta, loopDelta } from '../../src/core/math.js';
import { makeRng, randRange } from '../../src/core/rng.js';
import { LAYOUT, WORLD, baseHeight } from '../../src/sim/layout.js';
import { SPEED_MODEL, checkLayout, estimateSpeedProfile } from '../../src/sim/layoutCheck.js';
import { createNoise2D, fbm, ridged, warp } from '../../src/sim/noise.js';
import { Track } from '../../src/sim/track.js';

/** Gentle analytic terrain for the synthetic layouts. */
function testTerrain( x, z ) {

	return 30 + 0.03 * x + 5 * Math.sin( z / 60 ) + 3 * Math.cos( x / 90 );

}

/**
 * A synthetic layout that exercises everything: two hairpins whose legs run 60 m apart (switchback), a left-right
 * wiggle, explicit heights, width and bank overrides, a relaxed crest. It drives clockwise (mostly right turns).
 */
const STRESS_LAYOUT = {
	name: 'Stress loop',
	closed: true,
	controlPoints: [
		{ x: - 300, z: 0, width: 11, name: 'Start' },
		{ x: - 180, z: 0, width: 11 },
		{ x: - 60, z: - 26 },
		{ x: 60, z: 22 },
		{ x: 180, z: 0, bank: 0.05 },
		{ x: 300, z: 0, width: 10 },
		{ x: 326, z: 15, width: 10 },
		{ x: 330, z: 30, width: 10, name: 'East hairpin' },
		{ x: 326, z: 45, width: 10 },
		{ x: 300, z: 60, width: 10 },
		{ x: 150, z: 60, y: 38 },
		{ x: 0, z: 60, y: 44, crestRadius: 150 },
		{ x: - 150, z: 60, y: 36 },
		{ x: - 300, z: 60, width: 10 },
		{ x: - 326, z: 45, width: 10 },
		{ x: - 330, z: 30, width: 10, name: 'West hairpin' },
		{ x: - 326, z: 15, width: 10 },
	],
	defaultWidth: 9,
	smoothing: 4,
	gridOffset: 120,
	checkpointSpacing: 150,
	sectors: [ 0, 0.3, 0.7 ],
	corners: [ { name: 'East', cp: 7 }, { name: 'West', cp: 15 }, { name: 'Fixed', s: 100 } ],
	elevation: { smoothing: 40, offset: 0.4, terrainFollow: 1, minHeight: 3.5, maxGrade: 0.1, minCrestRadius: 350, minSagRadius: 220 },
	banking: { gain: 6, maxDeg: 6, smoothing: 10 },
};

const stress = new Track( STRESS_LAYOUT, { heightFn: testTerrain, waterLevel: 0 } );
const provisional = new Track( LAYOUT );
const TRACKS = [ [ 'stress layout', stress ], [ 'layout.js', provisional ] ];

const dot3 = ( a, i, b, j ) => a[ i ] * b[ j ] + a[ i + 1 ] * b[ j + 1 ] + a[ i + 2 ] * b[ j + 2 ];

for ( const [ label, track ] of TRACKS ) {

	test( `${label}: basic shape of the sampled data`, () => {

		assert.equal( track.closed, true );
		assert.equal( track.spacing, 1 );
		assert.equal( track.length, track.count );
		assert.ok( Number.isInteger( track.length ) && track.length > 500 );
		assert.ok( Math.abs( track.scale - 1 ) <= 0.51 / track.length, `scale ${track.scale}` );
		for ( const name of [ 'xs', 'ys', 'zs', 'curvatures', 'halfWidths', 'banks', 'grades', 'yaws' ] ) assert.equal( track[ name ].length, track.count, name );
		for ( const name of [ 'tangents', 'lefts', 'ups' ] ) assert.equal( track[ name ].length, track.count * 3, name );
		for ( let i = 0; i < track.count; i ++ ) {

			for ( const name of [ 'xs', 'ys', 'zs', 'curvatures', 'halfWidths', 'banks', 'grades' ] ) assert.ok( Number.isFinite( track[ name ][ i ] ), `${name}[${i}]` );

		}

		// s = 0 is at control point 0 (the Gaussian rounding may move the curve off the point by a few centimeters).
		const first = track.layout.controlPoints[ 0 ];
		assert.ok( Math.hypot( track.xs[ 0 ] - first.x, track.zs[ 0 ] - first.z ) < 1.5 );
		assert.equal( track.controlPointS[ 0 ], 0 );
		for ( let k = 1; k < track.controlPointS.length; k ++ ) assert.ok( track.controlPointS[ k ] > track.controlPointS[ k - 1 ] );
		// Every control point lies on the curve (within the rounding of the smoothing pass).
		track.layout.controlPoints.forEach( ( cp, k ) => {

			const projection = track.project( cp.x, cp.z );
			assert.ok( Math.abs( projection.d ) < 1.5, `control point ${k} is ${projection.d} m off the centreline` );
			assert.ok( Math.abs( loopDelta( projection.s, track.controlPointS[ k ], track.length ) ) < 1.5 );

		} );

	} );

	test( `${label}: frames are orthonormal and follow the conventions`, () => {

		const { tangents, lefts, ups, count } = track;
		for ( let i = 0; i < count; i ++ ) {

			const o = i * 3;
			assert.ok( Math.abs( dot3( tangents, o, tangents, o ) - 1 ) < 1e-12 );
			assert.ok( Math.abs( dot3( lefts, o, lefts, o ) - 1 ) < 1e-12 );
			assert.ok( Math.abs( dot3( ups, o, ups, o ) - 1 ) < 1e-12 );
			assert.ok( Math.abs( dot3( tangents, o, lefts, o ) ) < 1e-12 );
			// up = tangent x left
			assert.ok( Math.abs( ups[ o ] - ( tangents[ o + 1 ] * lefts[ o + 2 ] - tangents[ o + 2 ] * lefts[ o + 1 ] ) ) < 1e-12 );
			assert.ok( Math.abs( ups[ o + 1 ] - ( tangents[ o + 2 ] * lefts[ o ] - tangents[ o ] * lefts[ o + 2 ] ) ) < 1e-12 );
			assert.ok( Math.abs( ups[ o + 2 ] - ( tangents[ o ] * lefts[ o + 1 ] - tangents[ o + 1 ] * lefts[ o ] ) ) < 1e-12 );
			assert.ok( ups[ o + 1 ] > 0.97, 'the road normal points up' );
			// left = worldUp x forward in plan view: for a heading (hx, hz) that is (hz, -hx).
			const hx = - Math.sin( track.yaws[ i ] ), hz = - Math.cos( track.yaws[ i ] );
			assert.ok( lefts[ o ] * hz - lefts[ o + 2 ] * hx > 0.99, 'left vector on the left-hand side' );
			assert.ok( tangents[ o ] * hx + tangents[ o + 2 ] * hz > 0.99, 'tangent along the heading' );
			// grade = dy/ds, bank > 0 lowers the left edge.
			assert.ok( Math.abs( tangents[ o + 1 ] / Math.hypot( tangents[ o ], tangents[ o + 2 ] ) - track.grades[ i ] ) < 1e-12 );
			assert.ok( Math.abs( lefts[ o + 1 ] + Math.sin( track.banks[ i ] ) * ups[ o + 1 ] / Math.cos( track.banks[ i ] ) ) < 1e-9 );
			if ( Math.abs( track.banks[ i ] ) > 1e-6 ) assert.equal( Math.sign( lefts[ o + 1 ] ), - Math.sign( track.banks[ i ] ) );

		}

		const rng = makeRng( 11 );
		const frame = {};
		for ( let k = 0; k < 4000; k ++ ) {

			const s = randRange( rng, - 50, track.length + 50 );
			assert.equal( track.frameAt( s, frame ), frame );
			const t = [ frame.tx, frame.ty, frame.tz ], l = [ frame.lx, frame.ly, frame.lz ], u = [ frame.ux, frame.uy, frame.uz ];
			assert.ok( Math.abs( dot3( t, 0, t, 0 ) - 1 ) < 1e-12 && Math.abs( dot3( l, 0, l, 0 ) - 1 ) < 1e-12 && Math.abs( dot3( u, 0, u, 0 ) - 1 ) < 1e-12 );
			assert.ok( Math.abs( dot3( t, 0, l, 0 ) ) < 1e-12 && Math.abs( dot3( t, 0, u, 0 ) ) < 1e-12 && Math.abs( dot3( l, 0, u, 0 ) ) < 1e-12 );
			assert.ok( Math.abs( u[ 0 ] - ( t[ 1 ] * l[ 2 ] - t[ 2 ] * l[ 1 ] ) ) < 1e-12 );
			// left = up x tangent
			assert.ok( Math.abs( l[ 0 ] - ( u[ 1 ] * t[ 2 ] - u[ 2 ] * t[ 1 ] ) ) < 1e-12 && Math.abs( l[ 2 ] - ( u[ 0 ] * t[ 1 ] - u[ 1 ] * t[ 0 ] ) ) < 1e-12 );
			assert.ok( frame.s >= 0 && frame.s < track.length );

		}

	} );

	test( `${label}: no jumps in position, heading, curvature, height, bank or width (including the seam)`, () => {

		const { count } = track;
		let tightest = 0;
		for ( let i = 0; i < count; i ++ ) tightest = Math.max( tightest, Math.abs( track.curvatures[ i ] ) );
		for ( let i = 0; i < count; i ++ ) {

			const j = ( i + 1 ) % count;
			const chord = Math.hypot( track.xs[ j ] - track.xs[ i ], track.zs[ j ] - track.zs[ i ] );
			assert.ok( Math.abs( chord - 1 ) < 5e-4, `chord ${chord} at ${i}` );
			const turn = angleDelta( track.yaws[ i ], track.yaws[ j ] );
			assert.ok( Math.abs( turn ) <= tightest * 1.01 + 1e-9, `heading jump at ${i}` );
			// The curvature is the rate of change of the heading ...
			assert.ok( Math.abs( turn - 0.5 * ( track.curvatures[ i ] + track.curvatures[ j ] ) ) < 2e-4, `curvature inconsistent with the heading at ${i}` );
			// ... and it changes gradually.
			assert.ok( Math.abs( track.curvatures[ j ] - track.curvatures[ i ] ) < 0.008, `curvature jump ${track.curvatures[ j ] - track.curvatures[ i ]} at ${i}` );
			assert.ok( Math.abs( track.ys[ j ] - track.ys[ i ] ) < 0.13, `height jump at ${i}` );
			assert.ok( Math.abs( track.grades[ j ] - track.grades[ i ] ) < 0.006, `grade jump at ${i}` );
			assert.ok( Math.abs( track.banks[ j ] - track.banks[ i ] ) < 0.5 * DEG2RAD, `bank jump at ${i}` );
			assert.ok( Math.abs( track.halfWidths[ j ] - track.halfWidths[ i ] ) < 0.03, `width jump at ${i}` );

		}

		// Interpolated queries are continuous across the seam as well.
		const before = track.frameAt( track.length - 1e-6 ), after = track.frameAt( 1e-6 ), wrapped = track.frameAt( track.length + 1e-6 );
		for ( const key of [ 'x', 'y', 'z', 'tx', 'ty', 'tz', 'lx', 'ly', 'lz', 'ux', 'uy', 'uz', 'curvature', 'halfWidth', 'bank', 'grade' ] ) {

			assert.ok( Math.abs( before[ key ] - after[ key ] ) < 1e-4, `${key} jumps at the seam` );
			assert.ok( Math.abs( wrapped[ key ] - after[ key ] ) < 1e-9, `${key} does not wrap` );

		}

		assert.ok( Math.abs( track.heightAt( - 0.5 ) - 0.5 * ( track.ys[ count - 1 ] + track.ys[ 0 ] ) ) < 1e-9 );
		assert.equal( track.frameAt( track.length ).s, 0 );

	} );

	test( `${label}: banking has the sign of the curvature in corners and stays within 6 degrees`, () => {

		const overridden = track.layout.controlPoints.some( ( cp ) => cp.bank !== undefined );
		let corners = 0;
		for ( let i = 0; i < track.count; i ++ ) {

			assert.ok( Math.abs( track.banks[ i ] ) <= 6 * DEG2RAD + 1e-12 );
			if ( Math.abs( track.curvatures[ i ] ) < 1 / 150 ) continue;
			corners ++;
			// The bank profile is smoothed, so right where the curvature changes sign the bank may lag behind slightly.
			let uniform = true;
			for ( let o = - 25; o <= 25; o ++ ) uniform &&= Math.sign( track.curvatures[ ( i + o + track.count ) % track.count ] ) === Math.sign( track.curvatures[ i ] );
			if ( uniform && ! overridden ) assert.equal( Math.sign( track.banks[ i ] ), Math.sign( track.curvatures[ i ] ), `bank sign at ${i}` );

		}

		if ( track === stress ) assert.ok( corners > 100 );

	} );

	test( `${label}: project() inverts pointAt() with and without a hint`, () => {

		const rng = makeRng( 2026 );
		const point = [ 0, 0, 0 ], out = {};
		const check = ( s, d, hint ) => {

			assert.equal( track.pointAt( s, d, point ), point );
			assert.equal( track.project( point[ 0 ], point[ 2 ], hint, out ), out );
			assert.ok( Math.abs( loopDelta( s, out.s, track.length ) ) < 0.01, `s ${s} d ${d} hint ${hint}: got s ${out.s}` );
			assert.ok( Math.abs( out.d - d ) < 0.01, `s ${s} d ${d} hint ${hint}: got d ${out.d}` );
			assert.ok( out.s >= 0 && out.s < track.length );
			assert.ok( Math.abs( out.halfWidth - track.halfWidthAt( out.s ) ) < 1e-3 );
			assert.equal( out.onRoad, Math.abs( out.d ) <= out.halfWidth );

		};

		for ( let k = 0; k < 6000; k ++ ) {

			// Every tenth sample hugs the seam.
			const s = k % 10 === 0 ? randRange( rng, - 3, 3 ) : randRange( rng, 0, track.length );
			const d = randRange( rng, - 1, 1 ) * ( track.halfWidthAt( s ) + 2.5 );
			check( s, d, undefined );
			check( s, d, s + randRange( rng, - 20, 20 ) );
			check( s, d, s + track.length ); // hints wrap

		}

		check( 0, 0, 0 );
		check( 0, 2, track.length - 0.5 );
		check( track.length - 0.25, - 2, 0.5 );

	} );

	test( `${label}: the hinted projection is continuous along a driven path`, () => {

		const point = [ 0, 0, 0 ], out = {};
		let hint = track.gridS, previous = track.gridS, travelled = 0;
		for ( let step = 1; step <= 12000; step ++ ) {

			const s = track.gridS + step * 0.74;
			const d = 3.5 * Math.sin( step * 0.013 );
			track.pointAt( s, d, point );
			track.project( point[ 0 ], point[ 2 ], hint, out );
			const advance = loopDelta( previous, out.s, track.length );
			assert.ok( advance > 0.5 && advance < 1.0, `advance ${advance} at s ${s}` );
			travelled += advance;
			hint = previous = out.s;

		}

		assert.ok( Math.abs( travelled - 12000 * 0.74 ) < 0.05 );

	} );

	test( `${label}: the global projection finds the nearest part of the road anywhere`, () => {

		const rng = makeRng( 77 );
		const out = {};
		for ( let k = 0; k < 3000; k ++ ) {

			const far = k % 3 === 0;
			const x = far ? randRange( rng, - 6000, 6000 ) : track.xs[ Math.floor( rng() * track.count ) ] + randRange( rng, - 90, 90 );
			const z = far ? randRange( rng, - 6000, 6000 ) : track.zs[ Math.floor( rng() * track.count ) ] + randRange( rng, - 90, 90 );
			let nearest = Infinity;
			for ( let i = 0; i < track.count; i ++ ) nearest = Math.min( nearest, Math.hypot( track.xs[ i ] - x, track.zs[ i ] - z ) );
			track.project( x, z, undefined, out );
			const frame = track.frameAt( out.s );
			const found = Math.hypot( frame.x - x, frame.z - z );
			assert.ok( found <= nearest + 0.1, `(${x}, ${z}): found ${found}, nearest sample ${nearest}` );

		}

	} );

	test( `${label}: spawn poses sit on the road and face the driving direction`, () => {

		const rng = makeRng( 3 );
		const samples = [ [ track.gridS, 0 ], [ 0, 0 ], [ track.length - 0.2, 1.5 ] ];
		for ( let k = 0; k < 500; k ++ ) samples.push( [ randRange( rng, 0, track.length ), randRange( rng, - 4, 4 ) ] );
		for ( const [ s, d ] of samples ) {

			const pose = track.spawnPose( s, d );
			const frame = track.frameAt( s );
			const expected = track.pointAt( s, d );
			for ( let axis = 0; axis < 3; axis ++ ) assert.ok( Math.abs( pose.position[ axis ] - expected[ axis ] ) < 1e-12 );
			// forward(yaw) = ( -sin, 0, -cos ) must be the horizontal direction of the tangent.
			const horizontal = Math.hypot( frame.tx, frame.tz );
			assert.ok( Math.abs( - Math.sin( pose.yaw ) - frame.tx / horizontal ) < 1e-9 );
			assert.ok( Math.abs( - Math.cos( pose.yaw ) - frame.tz / horizontal ) < 1e-9 );
			// A positive lateral offset lies to the left: left = worldUp x forward = ( -cos(yaw), 0, sin(yaw) ).
			const leftward = track.pointAt( s, d + 1 );
			assert.ok( ( leftward[ 0 ] - expected[ 0 ] ) * - Math.cos( pose.yaw ) + ( leftward[ 2 ] - expected[ 2 ] ) * Math.sin( pose.yaw ) > 0.99 );

		}

		// Driving forward from the pose increases s.
		const pose = track.spawnPose( track.gridS );
		const ahead = track.project( pose.position[ 0 ] - 5 * Math.sin( pose.yaw ), pose.position[ 2 ] - 5 * Math.cos( pose.yaw ), track.gridS );
		assert.ok( Math.abs( loopDelta( track.gridS, ahead.s, track.length ) - 5 ) < 0.05 );

	} );

	test( `${label}: markers, minimap polyline and scalar queries`, () => {

		assert.equal( track.gridS, track.length - track.layout.gridOffset );
		assert.equal( track.sectors.length, 3 );
		assert.equal( track.sectors[ 0 ], 0 );
		assert.ok( track.sectors[ 1 ] > 0 && track.sectors[ 2 ] > track.sectors[ 1 ] && track.sectors[ 2 ] < track.length );
		assert.ok( track.checkpoints.length >= 3 );
		track.checkpoints.forEach( ( checkpoint, index ) => {

			assert.equal( checkpoint.index, index );
			assert.ok( Math.abs( checkpoint.s - index * track.length / track.checkpoints.length ) < 1e-9 );

		} );
		assert.ok( Math.abs( track.length / track.checkpoints.length - track.layout.checkpointSpacing ) < 0.2 * track.layout.checkpointSpacing );
		assert.equal( track.corners.length, track.layout.corners.length );
		for ( const corner of track.corners ) {

			const position = track.pointAt( corner.s );
			assert.ok( corner.s >= 0 && corner.s < track.length && typeof corner.name === 'string' );
			assert.ok( Math.hypot( corner.x - position[ 0 ], corner.y - position[ 1 ], corner.z - position[ 2 ] ) < 1e-9 );

		}

		const line = track.polyline();
		assert.ok( line instanceof Float32Array );
		assert.equal( line.length, 2 * Math.round( track.length / 5 ) );
		assert.ok( Math.abs( line[ 0 ] - track.xs[ 0 ] ) < 1e-3 && Math.abs( line[ 1 ] - track.zs[ 0 ] ) < 1e-3 );
		for ( let k = 0; k < line.length; k += 2 ) assert.ok( Math.abs( track.project( line[ k ], line[ k + 1 ] ).d ) < 1e-3 );
		assert.equal( track.polyline( 20 ).length, 2 * Math.round( track.length / 20 ) );

		const frame = track.frameAt( 123.4 );
		assert.ok( Math.abs( track.curvatureAt( 123.4 ) - frame.curvature ) < 1e-12 );
		assert.ok( Math.abs( track.halfWidthAt( 123.4 ) - frame.halfWidth ) < 1e-12 );
		assert.ok( Math.abs( track.bankAt( 123.4 ) - frame.bank ) < 1e-12 );
		assert.ok( Math.abs( track.gradeAt( 123.4 ) - frame.grade ) < 1e-12 );
		assert.ok( Math.abs( track.heightAt( 123.4 ) - frame.y ) < 1e-9 );
		assert.ok( Math.abs( track.heightAt( 123.4 + 3 * track.length ) - track.heightAt( 123.4 ) ) < 1e-9 ); // wrapping s costs a few ulps

	} );

}

test( 'stress layout: explicit heights, limits, width and bank overrides are honoured', () => {

	const track = stress, points = STRESS_LAYOUT.controlPoints;
	// Explicit heights (the limits win where they conflict; the track reports by how much).
	assert.ok( track.elevationInfo.maxPinError < 1.5, `pin error ${track.elevationInfo.maxPinError}` );
	points.forEach( ( cp, k ) => {

		if ( cp.y !== undefined ) assert.ok( Math.abs( track.heightAt( track.controlPointS[ k ] ) - cp.y ) <= track.elevationInfo.maxPinError + 1e-9 );

	} );
	const speeds = estimateSpeedProfile( track );
	for ( let i = 0; i < track.count; i ++ ) {

		const prev = ( i + track.count - 1 ) % track.count, next = ( i + 1 ) % track.count;
		assert.ok( Math.abs( track.ys[ next ] - track.ys[ i ] ) <= 0.1 * 1.01, `grade at ${i}` );
		const bend = track.ys[ prev ] - 2 * track.ys[ i ] + track.ys[ next ];
		assert.ok( bend <= 1.03 / 220, `dip too sharp at ${i}` );
		// Crests: never sharper than the relaxed radius, and never more than 0.85 g of lift at the estimated speed.
		assert.ok( - bend <= 1.03 / 150, `crest too sharp at ${i}` );
		assert.ok( - bend * speeds[ i ] ** 2 / 9.81 <= 0.85, `crest lift at ${i}` );
		assert.ok( track.ys[ i ] >= 3.5 - 1e-9 );

	}

	// Width: as specified at the control points, the default elsewhere, eased in between.
	assert.ok( Math.abs( 2 * track.halfWidthAt( track.controlPointS[ 1 ] ) - 11 ) < 0.02 );
	assert.ok( Math.abs( 2 * track.halfWidthAt( 0 ) - 11 ) < 0.08 ); // the neighbour 15 m before the line is 10 m wide
	assert.ok( Math.abs( 2 * track.halfWidthAt( track.controlPointS[ 7 ] ) - 10 ) < 0.02 );
	assert.ok( Math.abs( 2 * track.halfWidthAt( track.controlPointS[ 3 ] ) - 9 ) < 0.02 );
	for ( let i = 0; i < track.count; i ++ ) assert.ok( 2 * track.halfWidths[ i ] >= 9 - 1e-9 && 2 * track.halfWidths[ i ] <= 11 + 1e-9 );

	// Bank override on control point 4 (a left bank where the curvature alone would give almost none).
	assert.ok( Math.abs( track.bankAt( track.controlPointS[ 4 ] ) - 0.05 ) < 0.012 );

	// The hairpins turn right (clockwise loop): negative curvature, banked to the right.
	const east = track.controlPointS[ 7 ];
	assert.ok( track.curvatureAt( east ) < - 1 / 40 );
	assert.ok( track.bankAt( east ) < - 3 * DEG2RAD );
	// The wiggle before it contains a left turn.
	let leftTurn = 0;
	for ( let i = 0; i < track.count; i ++ ) leftTurn = Math.max( leftTurn, track.curvatures[ i ] );
	assert.ok( leftTurn > 1 / 300 );

} );

test( 'stress layout: projection between the switchback legs', () => {

	const track = stress;
	// Leg A runs along z = 0 towards +x, leg B comes back along z = 60 (60 m apart). Take the pair of stations at x = 180.
	const onA = track.project( 180, 0 ), onB = track.project( 180, 60 );
	assert.ok( onA.onRoad && onB.onRoad );
	assert.ok( Math.abs( loopDelta( onA.s, onB.s, track.length ) ) > 250 );

	// Sliding off leg A towards leg B: a hinted projection keeps following leg A ...
	const out = {};
	let hint = onA.s;
	for ( let z = 0; z <= 36; z += 0.5 ) {

		track.project( 180, z, hint, out );
		hint = out.s;
		// (leg A is slightly slanted at this station, so s drifts by about 0.27 m per meter of lateral offset)
		assert.ok( Math.abs( loopDelta( onA.s, out.s, track.length ) ) < 12, `left leg A at z = ${z}` );

	}

	assert.ok( ! out.onRoad );
	// ... although leg B is already closer there (the global search says so) ...
	assert.ok( Math.abs( loopDelta( onB.s, track.project( 180, 36 ).s, track.length ) ) < 8 );
	// ... and only moves over to leg B once that is less than half as far away.
	for ( let z = 36; z <= 60; z += 0.5 ) {

		track.project( 180, z, hint, out );
		hint = out.s;

	}

	assert.ok( Math.abs( loopDelta( onB.s, out.s, track.length ) ) < 1 );
	assert.ok( out.onRoad );

	// A stale hint (far away along the lap) still gives the right answer.
	track.project( 180, 1, onA.s + 400, out );
	assert.ok( Math.abs( loopDelta( onA.s, out.s, track.length ) ) < 1 );
	// The lateral offset is signed: leg A drives towards +x, so +z is on its right.
	assert.ok( track.project( 180, 3, onA.s ).d < - 2 );
	assert.ok( track.project( 180, - 3, onA.s ).d > 2 );

} );

test( 'a track is rebuilt identically (determinism)', () => {

	const again = new Track( STRESS_LAYOUT, { heightFn: testTerrain, waterLevel: 0 } );
	for ( const name of [ 'xs', 'ys', 'zs', 'tangents', 'lefts', 'ups', 'curvatures', 'halfWidths', 'banks', 'grades', 'yaws', 'controlPointS' ] ) {

		assert.deepEqual( again[ name ], stress[ name ], name );

	}

	assert.equal( again.length, stress.length );
	assert.deepEqual( new Track( LAYOUT ).ys, provisional.ys );

} );

test( 'a circle is reproduced accurately', () => {

	const radius = 200, points = [];
	// Clockwise seen from above (x right, z down) = counter-clockwise in the game's yaw sense: a constant LEFT turn.
	for ( let k = 0; k < 16; k ++ ) points.push( { x: radius * Math.cos( - k * Math.PI / 8 ), z: radius * Math.sin( - k * Math.PI / 8 ), y: 10 } );
	const circle = new Track( { ...STRESS_LAYOUT, controlPoints: points, corners: [], smoothing: 0 }, { heightFn: () => 0, waterLevel: 0 } );
	assert.ok( Math.abs( circle.length - 2 * Math.PI * radius ) < 1.5 );
	for ( let i = 0; i < circle.count; i ++ ) {

		assert.ok( Math.abs( Math.hypot( circle.xs[ i ], circle.zs[ i ] ) - radius ) < 0.1 );
		assert.ok( Math.abs( circle.curvatures[ i ] - 1 / radius ) < 2e-4, `curvature ${circle.curvatures[ i ]} at ${i}` );
		assert.ok( Math.abs( circle.ys[ i ] - 10 ) < 1e-6 );
		assert.ok( circle.banks[ i ] > 0 );

	}

	// The centre of the circle is on the left of the road (d is measured along the banked surface, hence slightly longer).
	assert.ok( Math.abs( circle.project( 0, 0 ).d - radius ) < 0.5 );
	const speeds = estimateSpeedProfile( circle );
	assert.ok( Math.abs( speeds[ 100 ] - Math.sqrt( SPEED_MODEL.lateral * radius ) ) < 0.5 );

} );

test( 'performance budgets: build < 150 ms, hinted project() < 2 us, frameAt() well below 1 us', () => {

	let build = Infinity;
	for ( let k = 0; k < 5; k ++ ) {

		const start = performance.now();
		new Track( LAYOUT );
		build = Math.min( build, performance.now() - start );

	}

	assert.ok( build < 150, `track build took ${build.toFixed( 1 )} ms` );

	const track = provisional, n = 200000;
	const xs = new Float64Array( n ), zs = new Float64Array( n ), point = [ 0, 0, 0 ], out = {}, frame = {};
	for ( let k = 0; k < n; k ++ ) {

		track.pointAt( k * 0.75, 4 * Math.sin( k * 0.01 ), point );
		xs[ k ] = point[ 0 ];
		zs[ k ] = point[ 2 ];

	}

	// Best of several batches, so that a busy machine does not fail the test.
	let hinted = Infinity, global = Infinity, framed = Infinity, sink = 0;
	for ( let batch = 0; batch < 6; batch ++ ) {

		let start = performance.now(), hint = 0;
		for ( let k = 0; k < n; k ++ ) {

			track.project( xs[ k ], zs[ k ], hint, out );
			hint = out.s;

		}

		hinted = Math.min( hinted, ( performance.now() - start ) / n * 1000 );
		start = performance.now();
		for ( let k = 0; k < n; k ++ ) sink += track.project( xs[ k ], zs[ k ], undefined, out ).d;
		global = Math.min( global, ( performance.now() - start ) / n * 1000 );
		start = performance.now();
		for ( let k = 0; k < n; k ++ ) sink += track.frameAt( k * 0.75, frame ).x;
		framed = Math.min( framed, ( performance.now() - start ) / n * 1000 );

	}

	assert.ok( Number.isFinite( sink ) );
	assert.ok( hinted < 2, `hinted project(): ${hinted.toFixed( 3 )} us` );
	assert.ok( global < 5, `global project(): ${global.toFixed( 3 )} us` );
	assert.ok( framed < 1, `frameAt(): ${framed.toFixed( 3 )} us` );

} );

test( 'layout checker: speed model, corner detection and rule violations', () => {

	const result = checkLayout( stress, { size: 3072, minX: - 1536, minZ: - 1536, waterLevel: 0 }, testTerrain );
	assert.equal( result.speedProfile.length, stress.count );
	// Two hairpins, both turning right, found at the hairpin control points.
	const hairpins = result.corners.filter( ( corner ) => corner.hairpin );
	assert.equal( hairpins.length, 2 );
	assert.equal( result.metrics.hairpins, 2 );
	for ( const corner of hairpins ) {

		assert.equal( corner.direction, 'R' );
		assert.ok( corner.angle > 150 && corner.angle < 210 );
		assert.ok( corner.radius > 16 && corner.radius < 40 );
		assert.ok( Math.abs( corner.minSpeed - Math.sqrt( SPEED_MODEL.lateral * corner.radius ) ) < 0.3 );
		assert.ok( corner.entrySpeed > corner.minSpeed && corner.exitSpeed >= corner.minSpeed );

	}

	assert.ok( Math.abs( loopDelta( hairpins[ 0 ].s, stress.controlPointS[ 7 ], stress.length ) ) < 40 );
	assert.ok( result.corners.some( ( corner ) => corner.direction === 'L' ) );
	// The speed profile respects the acceleration and braking limits everywhere (v^2 changes by at most 2 a ds).
	for ( let i = 0; i < stress.count; i ++ ) {

		const next = ( i + 1 ) % stress.count;
		const change = ( result.speedProfile[ next ] ** 2 - result.speedProfile[ i ] ** 2 ) / 2;
		assert.ok( change <= SPEED_MODEL.accelerate + 0.01 && change >= - SPEED_MODEL.brake - 0.01, `speed change at ${i}` );
		assert.ok( result.speedProfile[ i ] <= Math.sqrt( SPEED_MODEL.lateral / Math.abs( stress.curvatures[ i ] ) ) + 1e-3 );

	}

	assert.ok( Math.abs( result.estimatedLapTime - stress.length / result.metrics.averageSpeed ) < 1e-6 );
	// This loop is far too short, its wiggle comes within 38 m of the return leg and the road is only 10 m wide just
	// before the line: exactly these rules must fire.
	const rules = result.violations.map( ( violation ) => violation.rule ).sort();
	assert.equal( result.ok, false );
	assert.deepEqual( rules, [ 'length', 'separation', 'startWidth' ] );
	assert.equal( result.metrics.selfIntersections, 0 );
	assert.ok( result.metrics.minSeparation > 30 && result.metrics.minSeparation < 38 );
	assert.ok( Math.abs( result.metrics.minBorderMargin - ( 1536 - 330 - 5 ) ) < 2 );
	assert.ok( result.metrics.maxGrade <= 0.101 );

	// A figure of eight crosses itself once.
	const eight = new Track( { ...STRESS_LAYOUT, corners: [], controlPoints: [
		{ x: 4, z: - 3 }, { x: 150, z: 120 }, { x: 300, z: 0 }, { x: 150, z: - 120 }, { x: - 4, z: 3 }, { x: - 150, z: 120 }, { x: - 300, z: 0 }, { x: - 150, z: - 120 },
	] }, { heightFn: () => 20, waterLevel: 0 } );
	const crossing = checkLayout( eight, { size: 3072, minX: - 1536, minZ: - 1536, waterLevel: 0 }, () => 20 );
	assert.equal( crossing.metrics.selfIntersections, 1 );
	assert.ok( crossing.violations.some( ( violation ) => violation.rule === 'selfIntersection' ) );
	assert.ok( crossing.violations.some( ( violation ) => violation.rule === 'separation' ) );

	// Legs closer than 38 m, a road too close to the water and outside the keep-in square are reported.
	const tight = new Track( { ...STRESS_LAYOUT, corners: [], controlPoints: STRESS_LAYOUT.controlPoints.map( ( p ) => ( { x: p.x, z: p.z * 0.55, width: p.width } ) ) }, { heightFn: () => 1, waterLevel: 0 } );
	const tightResult = checkLayout( tight, { size: 700, minX: - 350, minZ: - 350, waterLevel: 2 }, () => 1 );
	const tightRules = tightResult.violations.map( ( violation ) => violation.rule );
	for ( const rule of [ 'separation', 'heightAboveWater', 'borderMargin' ] ) assert.ok( tightRules.includes( rule ), `${rule} not reported` );
	assert.ok( tightResult.metrics.minSeparation < 38 );

} );

test( 'layout.js: the current circuit data builds and its terrain function is usable', () => {

	const result = checkLayout( provisional, WORLD, baseHeight );
	assert.equal( typeof result.ok, 'boolean' );
	assert.ok( Number.isFinite( result.estimatedLapTime ) && result.estimatedLapTime > 20 );
	assert.equal( LAYOUT.closed, true );
	assert.equal( WORLD.minX, - WORLD.size / 2 );
	// Deterministic, finite and smooth at the 10 m scale, also far outside the playable square.
	const rng = makeRng( 9 );
	for ( let k = 0; k < 2000; k ++ ) {

		const x = randRange( rng, - 12000, 12000 ), z = randRange( rng, - 12000, 12000 );
		const h = baseHeight( x, z );
		assert.ok( Number.isFinite( h ) );
		assert.equal( baseHeight( x, z ), h );
		assert.ok( Math.abs( baseHeight( x + 10, z ) - h ) < 30, `terrain step at (${x}, ${z})` );

	}

} );

test( 'noise: range, determinism, continuity', () => {

	const noise = createNoise2D( 42 ), same = createNoise2D( 42 ), other = createNoise2D( 43 );
	let low = Infinity, high = - Infinity, sum = 0, different = 0;
	const warped = [ 0, 0 ];
	for ( let k = 0; k < 200000; k ++ ) {

		const x = ( k % 997 ) * 0.173 - 60, y = Math.floor( k / 997 ) * 0.211 - 20;
		const v = noise( x, y );
		low = Math.min( low, v );
		high = Math.max( high, v );
		sum += v;
		if ( k % 50 === 0 ) {

			assert.equal( same( x, y ), v );
			if ( other( x, y ) !== v ) different ++;
			assert.ok( Math.abs( noise( x + 1e-4, y ) - v ) < 1e-3 );
			const f = fbm( noise, x, y, 5, 2, 0.5 ), r = ridged( noise, x, y, 5, 2, 0.5 );
			assert.ok( f >= - 1 && f <= 1 && r >= 0 && r <= 1 );
			assert.equal( warp( noise, x, y, 3, 0.2, warped ), warped );
			assert.ok( Math.abs( warped[ 0 ] - x ) <= 3 && Math.abs( warped[ 1 ] - y ) <= 3 );

		}

	}

	assert.ok( low >= - 1 && high <= 1 && low < - 0.9 && high > 0.9, `range ${low} .. ${high}` );
	assert.ok( Math.abs( sum / 200000 ) < 0.02 );
	assert.ok( different > 3900 );

} );
