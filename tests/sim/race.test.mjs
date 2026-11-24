// Race logic, ghost recording / playback and the AI driver's precomputed data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS_DT } from '../../src/sim/constants.js';
import { Autopilot } from '../../src/sim/autopilot.js';
import { GhostPlayer, GhostRecorder, decodeGhost, encodeGhost, fromBase64, toBase64 } from '../../src/sim/ghost.js';
import { LAYOUT } from '../../src/sim/layout.js';
import { RaceSession } from '../../src/sim/race.js';
import { Track } from '../../src/sim/track.js';
import { SPORTS_CAR } from '../../src/sim/vehicleConfig.js';

const track = new Track( LAYOUT );

/** A fake car gliding along the road at constant speed, `d` meters left of the centreline. */
function glide( race, speed, laps, { d = () => 0, onStep = () => {} } = {} ) {

	const p = [ 0, 0, 0 ];
	const state = { position: p, quaternion: [ 0, 0, 0, 1 ], speed, forwardSpeed: speed, steerAngle: 0, gear: 4, brake: 0, upsideDown: false, wheelsOnGround: 4 };
	let s = track.gridS;
	const steps = Math.ceil( ( laps * track.length + 200 ) / ( speed * PHYSICS_DT ) );
	for ( let i = 0; i < steps; i ++ ) {

		s += speed * PHYSICS_DT;
		track.pointAt( s, d( s % track.length ), p );
		race.update( state, PHYSICS_DT );
		onStep( state );

	}

}

test( 'lap times are interpolated across the line, not quantised to the step', () => {

	for ( const speed of [ 41.37, 63.9 ] ) {

		const race = new RaceSession( track );
		const laps = [];
		race.events.on( 'lapComplete', ( e ) => laps.push( e ) );
		race.start();
		glide( race, speed, 2.2 );
		assert.equal( laps.length, 2 );
		for ( const lap of laps ) {

			assert.ok( lap.valid );
			assert.ok( Math.abs( lap.time - track.length / speed ) < 0.002, `lap ${lap.time} vs ${track.length / speed}` );
			assert.ok( Math.abs( lap.sectors[ 0 ] + lap.sectors[ 1 ] + lap.sectors[ 2 ] - lap.time ) < 1e-6 );
			assert.ok( Math.abs( lap.sectors[ 1 ] - ( track.sectors[ 2 ] - track.sectors[ 1 ] ) / speed ) < 0.003 );

		}

		assert.ok( race.bestLap !== null && race.lap === 3 );

	}

} );

test( 'cutting past a checkpoint invalidates the lap; resets go back to a checkpoint', () => {

	const race = new RaceSession( track );
	const laps = [], reasons = [];
	race.events.on( 'lapComplete', ( e ) => laps.push( e ) );
	race.events.on( 'invalidated', ( e ) => reasons.push( e.reason ) );
	race.start();
	const far = track.checkpoints[ 5 ].s;
	glide( race, 50, 1.2, { d: ( s ) => ( Math.abs( s - far ) < 30 ? 40 : 0 ) } ); // 40 m off the road while passing checkpoint 5
	assert.equal( laps.length, 1 );
	assert.equal( laps[ 0 ].valid, false );
	assert.equal( reasons[ 0 ], 'cut' ); // (the second lap passes the same spot again and is cut as well)

	const pose = race.resetPose();
	const back = track.project( pose.position[ 0 ], pose.position[ 2 ] );
	assert.ok( Math.abs( back.d ) < 0.01 );
	assert.ok( track.checkpoints.some( ( c ) => Math.abs( c.s - back.s ) < 0.5 ) || Math.abs( back.s - race.s + 30 ) < 1 );
	race.notifyTeleport();
	assert.equal( race.valid, false );

} );

test( 'ghost: record, encode, decode, play back and time-at-distance', () => {

	const race = new RaceSession( track );
	const recorder = new GhostRecorder( track.length );
	let lap = null;
	race.events.on( 'lapStart', () => recorder.begin() );
	race.events.on( 'lapComplete', ( e ) => {

		if ( ! lap ) lap = recorder.finish( e.time );

	} );
	race.start();
	const speed = 55;
	glide( race, speed, 1.2, { onStep: ( state ) => {

		if ( race.phase === 'lap' && ! lap ) recorder.sample( race.lapTime, state, race.s );

	} } );
	assert.ok( lap && lap.count > 1000 );

	const bytes = encodeGhost( lap );
	assert.ok( bytes.length < 150000 );
	const copy = decodeGhost( fromBase64( toBase64( bytes ) ) );
	assert.equal( copy.count, lap.count );
	assert.ok( Math.abs( copy.time - lap.time ) < 1e-4 );
	for ( let i = 0; i < lap.count; i += 53 ) {

		for ( let k = 0; k < 3; k ++ ) assert.ok( Math.abs( copy.positions[ i * 3 + k ] - lap.positions[ i * 3 + k ] ) < 1e-3 );
		assert.ok( Math.abs( copy.speeds[ i ] - lap.speeds[ i ] ) < 0.01 );

	}

	const player = new GhostPlayer( copy );
	const pose = player.poseAt( 40.123 ), p = [ 0, 0, 0 ];
	track.pointAt( speed * 40.123, 0, p );
	assert.ok( Math.hypot( pose.position[ 0 ] - p[ 0 ], pose.position[ 2 ] - p[ 2 ] ) < 0.5, 'interpolated pose is on the path' );
	assert.ok( Math.abs( pose.speed - speed ) < 0.01 );
	let previous = - 1;
	for ( let s = 0; s <= track.length; s += 37 ) {

		const t = player.timeAtS( s );
		assert.ok( t >= previous );
		assert.ok( Math.abs( t - s / speed ) < 0.06, `timeAtS(${s}) = ${t}` );
		previous = t;

	}

	assert.throws( () => decodeGhost( new Uint8Array( 40 ) ) );

} );

test( 'autopilot: the racing line stays on the road and the speed profile is sane', () => {

	const fast = new Autopilot( track, SPORTS_CAR, { skill: 1 } ), slow = new Autopilot( track, SPORTS_CAR, { skill: 0.8 } ), wet = new Autopilot( track, SPORTS_CAR, { skill: 1, wetness: 1 } );
	let top = 0, low = Infinity;
	for ( let i = 0; i < fast.count; i ++ ) {

		const s = i * fast.step;
		assert.ok( Math.abs( fast.offsets[ i ] ) <= track.halfWidthAt( s ) - 1.2, `line leaves the road at s = ${s}` );
		assert.ok( fast.speeds[ i ] > 8 && fast.speeds[ i ] <= 92 );
		assert.ok( slow.speeds[ i ] <= fast.speeds[ i ] + 0.5 && wet.speeds[ i ] <= fast.speeds[ i ] + 0.5 );
		top = Math.max( top, fast.speeds[ i ] );
		low = Math.min( low, fast.speeds[ i ] );

	}

	assert.ok( top * 3.6 > 260 && low * 3.6 < 60 );
	assert.ok( fast.estimatedLapTime < slow.estimatedLapTime && fast.estimatedLapTime < wet.estimatedLapTime );
	assert.ok( fast.estimatedLapTime > 110 && fast.estimatedLapTime < 150 );
	// the line uses the road: it reaches well off-centre somewhere
	let reach = 0;
	for ( const d of fast.offsets ) reach = Math.max( reach, Math.abs( d ) );
	assert.ok( reach > 2.5 );

} );
