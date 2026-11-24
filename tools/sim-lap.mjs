#!/usr/bin/env node
// Lets the AI driver lap the baked circuit and prints what happened.
//   node tools/sim-lap.mjs [--skill 1] [--wet 0] [--laps 2] [--trace]
// Lap 1 starts from the rolling-start grid; later laps are flying laps.

import { readFileSync } from 'node:fs';
import { Autopilot } from '../src/sim/autopilot.js';
import { createSimulation, vehicleConfigFromCar } from '../src/sim/session.js';
import { loadWorld } from '../src/sim/world.node.js';
import { formatLapTime } from '../src/core/math.js';

const arg = ( name, fallback ) => {

	const i = process.argv.indexOf( '--' + name );
	return i >= 0 ? Number( process.argv[ i + 1 ] ) : fallback;

};

const skill = arg( 'skill', 1 ), wetness = arg( 'wet', 0 ), laps = arg( 'laps', 2 ), trace = process.argv.includes( '--trace' );
const world = await loadWorld( { maps: false } );
const config = vehicleConfigFromCar( JSON.parse( readFileSync( new URL( '../public/assets/car/car.json', import.meta.url ), 'utf8' ) ) );
const sim = await createSimulation( world, { wetness, vehicleConfig: config } );
const { track, vehicle } = sim;
const ai = new Autopilot( track, config, { skill, wetness } );
vehicle.setAnalogSteering( true );
console.log( `skill ${skill}  wetness ${wetness}  line estimate ${formatLapTime( ai.estimatedLapTime )}` );

const st = vehicle.state, proj = {};
let time = 0, lap = 0, lapStart = null, prevS = track.gridS, hint;
let top = 0, off = 0, impacts = 0, minSpeed = Infinity, maxLat = 0, maxErr = 0;
const cornerMin = track.corners.map( () => Infinity );
const t0 = performance.now();
while ( lap <= laps && time < 900 ) {

	sim.step( ai.update( st, sim.dt ) );
	time += sim.dt;
	track.project( st.position[ 0 ], st.position[ 2 ], hint, proj );
	hint = proj.s;
	if ( lapStart !== null ) {

		top = Math.max( top, st.speed );
		minSpeed = Math.min( minSpeed, st.speed );
		maxLat = Math.max( maxLat, Math.abs( st.latG ) );
		maxErr = Math.max( maxErr, Math.abs( proj.d - ai.offsetAt( proj.s ) ) );
		if ( ! proj.onRoad ) off += sim.dt;
		impacts += st.impacts.length;
		track.corners.forEach( ( c, k ) => {

			if ( Math.abs( proj.s - c.s ) < 25 ) cornerMin[ k ] = Math.min( cornerMin[ k ], st.speed );

		} );

	}

	if ( trace && Math.round( time / sim.dt ) % 240 === 0 ) console.log( `  t ${time.toFixed( 0 ).padStart( 4 )}  s ${proj.s.toFixed( 0 ).padStart( 5 )}  d ${proj.d.toFixed( 1 ).padStart( 5 )}  ${( st.speed * 3.6 ).toFixed( 0 ).padStart( 4 )} km/h  target ${( ai.speedAt( proj.s ) * 3.6 ).toFixed( 0 ).padStart( 4 )}  gear ${st.gear}` );
	if ( prevS > track.length - 60 && proj.s < 60 ) {

		// crossed the line: interpolate the crossing instant inside the step
		const before = track.length - prevS, after = proj.s;
		const crossing = time - sim.dt * after / ( before + after );
		if ( lapStart !== null ) {

			console.log( `lap ${lap}: ${formatLapTime( crossing - lapStart )}  top ${( top * 3.6 ).toFixed( 0 )} km/h  slowest ${( minSpeed * 3.6 ).toFixed( 0 )}  max ${maxLat.toFixed( 2 )} g  off-road ${off.toFixed( 2 )} s  impacts ${impacts}  max line error ${maxErr.toFixed( 2 )} m` );
			console.log( '   corner minimum speeds: ' + track.corners.map( ( c, k ) => `${c.name} ${( cornerMin[ k ] * 3.6 ).toFixed( 0 )}` ).join( ', ' ) );

		}

		lap ++;
		lapStart = crossing;
		top = 0; off = 0; impacts = 0; minSpeed = Infinity; maxLat = 0; maxErr = 0;
		cornerMin.fill( Infinity );

	}

	prevS = proj.s;

}

console.log( `simulated ${time.toFixed( 0 )} s in ${( ( performance.now() - t0 ) / 1000 ).toFixed( 1 )} s` );
