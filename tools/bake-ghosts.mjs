#!/usr/bin/env node
// Bakes the medal ghosts: the AI driver laps the circuit at three skill levels, dry and wet.
//   node tools/bake-ghosts.mjs            writes public/assets/world/ghost_*.bin + ghosts.json
//   node tools/bake-ghosts.mjs --sweep    only prints lap time versus skill (for choosing the levels)
// Each ghost is the second flying lap (the first timed lap still carries the rolling start).

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatLapTime } from '../src/core/math.js';
import { Autopilot } from '../src/sim/autopilot.js';
import { GhostRecorder, decodeGhost, encodeGhost } from '../src/sim/ghost.js';
import { RaceSession } from '../src/sim/race.js';
import { createSimulation, vehicleConfigFromCar } from '../src/sim/session.js';
import { WORLD_DIR, loadWorld } from '../src/sim/world.node.js';

// AI skill per medal. In the wet the driver keeps a little more in reserve.
const LEVELS = { dry: { gold: 1.03, silver: 0.91, bronze: 0.78 }, wet: { gold: 0.99, silver: 0.89, bronze: 0.77 } };
const world = await loadWorld( { maps: false } );
const config = vehicleConfigFromCar( JSON.parse( readFileSync( new URL( '../public/assets/car/car.json', import.meta.url ), 'utf8' ) ) );

/** Runs one AI session and returns the recorded second timed lap. */
async function drive( skill, wetness ) {

	const sim = await createSimulation( world, { wetness, vehicleConfig: config } );
	const ai = new Autopilot( sim.track, config, { skill, wetness } );
	sim.vehicle.setAnalogSteering( true );
	const race = new RaceSession( sim.track );
	const recorder = new GhostRecorder( sim.track.length, config.geometry.rearWheelRadius );
	const laps = [];
	let impacts = 0, offRoad = 0, result = null;
	race.events.on( 'lapStart', () => {

		recorder.begin();
		impacts = 0;
		offRoad = 0;

	} );
	race.events.on( 'lapComplete', ( e ) => {

		laps.push( e );
		if ( e.lap === 2 ) result = { ...e, ghost: recorder.finish( e.time ), impacts, offRoad };

	} );
	race.start();
	const state = sim.vehicle.state;
	for ( let step = 0; step < 120 * 700 && ! result; step ++ ) {

		sim.step( ai.update( state, sim.dt ) );
		race.update( state, sim.dt );
		if ( race.phase === 'lap' ) {

			recorder.sample( race.lapTime, state, race.s );
			impacts += state.impacts.filter( ( i ) => i.impulse > 400 ).length;
			if ( ! race.onRoad ) offRoad += sim.dt;

		}

	}

	sim.physics.dispose();
	if ( ! result ) throw new Error( `skill ${skill} wetness ${wetness}: the AI did not finish two laps` );
	return result;

}

if ( process.argv.includes( '--sweep' ) ) {

	for ( const skill of [ 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.03, 1.06 ] ) {

		const r = await drive( skill, 0 );
		console.log( `skill ${skill.toFixed( 2 )}  lap ${formatLapTime( r.time )}  valid ${r.valid}  top ${( r.topSpeed * 3.6 ).toFixed( 0 )} km/h  hard impacts ${r.impacts}  off-road ${r.offRoad.toFixed( 2 )} s` );

	}

	process.exit( 0 );

}

const index = { trackLength: world.track.length, car: 'sports_car', dry: {}, wet: {} };
for ( const [ condition, wetness ] of [ [ 'dry', 0 ], [ 'wet', 1 ] ] ) {

	for ( const [ medal, skill ] of Object.entries( LEVELS[ condition ] ) ) {

		const r = await drive( skill, wetness );
		if ( ! r.valid || r.impacts > 0 || r.offRoad > 1 ) throw new Error( `${condition} ${medal}: not a clean lap (valid ${r.valid}, impacts ${r.impacts}, off-road ${r.offRoad.toFixed( 2 )} s)` );
		const file = `ghost_${medal}${wetness ? '_wet' : ''}.bin`;
		const bytes = encodeGhost( r.ghost );
		if ( Math.abs( decodeGhost( bytes ).time - r.time ) > 1e-3 ) throw new Error( 'ghost encoding round trip failed' );
		await writeFile( path.join( WORLD_DIR, file ), bytes );
		index[ condition ][ medal ] = { file, time: Math.round( r.time * 1000 ) / 1000, sectors: r.sectors.map( ( t ) => Math.round( t * 1000 ) / 1000 ), skill, bytes: bytes.length };
		console.log( `${condition.padEnd( 4 )} ${medal.padEnd( 7 )} ${formatLapTime( r.time )}  sectors ${r.sectors.map( ( t ) => t.toFixed( 2 ) ).join( ' / ' )}  top ${( r.topSpeed * 3.6 ).toFixed( 0 )} km/h  ${( bytes.length / 1024 ).toFixed( 0 )} KB` );

	}

}

await writeFile( path.join( WORLD_DIR, 'ghosts.json' ), JSON.stringify( index, null, '\t' ) + '\n' );
console.log( 'ghosts.json written' );
