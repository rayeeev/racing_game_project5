// Design constraints of the shipped circuit (src/sim/layout.js). Generic Track behaviour is covered in track.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../../src/sim/track.js';
import { checkLayout } from '../../src/sim/layoutCheck.js';
import { LAYOUT, WORLD, baseHeight } from '../../src/sim/layout.js';

const track = new Track( LAYOUT );
const result = checkLayout( track, WORLD, baseHeight );

test( 'the circuit meets every hard design constraint', () => {

	assert.deepEqual( result.violations.map( ( v ) => `${v.rule} @ ${Math.round( v.s ?? 0 )}` ), [] );
	assert.equal( result.ok, true );

} );

test( 'the circuit has the intended character', () => {

	const hairpins = result.corners.filter( ( c ) => c.hairpin );
	assert.ok( hairpins.length >= 3 && hairpins.length <= 5, `${hairpins.length} hairpins` );
	assert.ok( result.estimatedLapTime > 105 && result.estimatedLapTime < 140, `estimated lap ${result.estimatedLapTime.toFixed( 1 )} s` );
	// a real top-speed straight and a real mix of corner speeds
	let top = 0;
	for ( const v of result.speedProfile ) top = Math.max( top, v );
	assert.ok( top * 3.6 >= 300 );
	const mins = result.corners.map( ( c ) => c.minSpeed * 3.6 );
	assert.ok( mins.some( ( v ) => v < 70 ) && mins.some( ( v ) => v > 100 && v < 160 ) && mins.some( ( v ) => v > 190 ) );
	// climbs about a hundred meters above the lake
	let high = - Infinity, low = Infinity;
	for ( const y of track.ys ) {

		high = Math.max( high, y );
		low = Math.min( low, y );

	}

	assert.ok( high - low > 95 && high - low < 150 );
	// the road never strays far from the macro terrain (the bake can only cut / fill so much)
	assert.ok( result.metrics.maxCut < 10 && result.metrics.maxFill < 15, `cut ${result.metrics.maxCut}, fill ${result.metrics.maxFill}` );

} );

test( 'the circuit is deterministic', () => {

	const again = new Track( LAYOUT );
	assert.equal( again.length, track.length );
	for ( let i = 0; i < track.count; i += 97 ) {

		assert.equal( again.xs[ i ], track.xs[ i ] );
		assert.equal( again.ys[ i ], track.ys[ i ] );
		assert.equal( again.zs[ i ], track.zs[ i ] );

	}

} );
