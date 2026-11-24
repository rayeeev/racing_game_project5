// Maneuver runner for the vehicle dynamics model (Node only).
//
//   node tools/sim-vehicle.mjs                       run every maneuver and print the metrics table
//   node tools/sim-vehicle.mjs launch skidpad50      run selected maneuvers
//   node tools/sim-vehicle.mjs --charts <dir>        also write PNG charts (speed / rpm / gear, g-g, steer vs lateral g ...)
//   node tools/sim-vehicle.mjs --list                list the maneuver names
//
// The maneuvers are exported so that tests/sim/vehicle.test.mjs asserts on exactly the numbers printed here.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEG2RAD, RAD2DEG, angleDelta, clamp } from '../src/core/math.js';
import { GRAVITY, PHYSICS_DT, Surface } from '../src/sim/constants.js';
import { PhysicsWorld, loadRapier } from '../src/sim/physics.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { SPORTS_CAR } from '../src/sim/vehicleConfig.js';

const KMH = 3.6;
const GROUND_CELLS = 64, GROUND_CELL = 500; // a 32 km square of ground

/**
 * A self-contained test rig: a physics world with ground, one car, an input object and a telemetry log.
 * @typedef {Object} Rig
 * @property {PhysicsWorld} physics
 * @property {Vehicle} car
 * @property {import('../src/sim/types.js').VehicleState} state
 * @property {import('../src/sim/types.js').VehicleInput} input
 * @property {Object<string, number[]>} log   per-step samples (see LOG_FIELDS)
 * @property {number} time                    simulated seconds since the rig was created
 * @property {boolean} finite                 false once any state value was NaN / infinite
 */

const LOG_FIELDS = [ 't', 'speed', 'rpm', 'gear', 'longG', 'latG', 'steerAngle', 'steerInput', 'yawRate', 'yaw', 'drift', 'x', 'y', 'z', 'throttle', 'brake', 'roll', 'pitch' ];

/**
 * Builds a rig.
 * @param {Object} [options]
 * @param {number} [options.grade]        slope of the ground along the forward (-Z) direction (0.15 = 15 % uphill)
 * @param {number} [options.surface]      Surface id of the whole ground (default asphalt)
 * @param {(x: number, z: number) => number} [options.surfaceQuery]  per-position surface (overrides `surface`)
 * @param {(physics: PhysicsWorld) => void} [options.build]          adds extra colliders (kerbs, ramps ...)
 * @param {number} [options.wetness]      0..1
 * @param {Object} [options.assists]      passed to vehicle.setAssists()
 * @param {boolean} [options.analog]      analog steering mode
 * @param {number} [options.speed]        initial speed in m/s
 * @param {number[]} [options.position]   initial position
 * @param {number} [options.yaw]          initial heading
 * @param {typeof SPORTS_CAR} [options.config]
 * @returns {Promise<Rig>}
 */
export async function createRig( { grade = 0, surface = Surface.ASPHALT, surfaceQuery = null, build = null, wetness = 0, assists = null, analog = false, speed = 0, position = [ 0, 0, 0 ], yaw = 0, config = SPORTS_CAR } = {} ) {

	const RAPIER = await loadRapier();
	const physics = new PhysicsWorld( RAPIER );
	const n = GROUND_CELLS + 1, half = GROUND_CELLS * GROUND_CELL / 2;
	const heights = new Float32Array( n * n );
	for ( let iz = 0; iz < n; iz ++ ) heights.fill( - grade * ( - half + iz * GROUND_CELL ), iz * n, ( iz + 1 ) * n );
	const plainAsphalt = surfaceQuery === null && surface === Surface.ASPHALT;
	physics.addHeightfield( { heights, n, cell: GROUND_CELL, minX: - half, minZ: - half, kind: plainAsphalt ? 'road' : 'terrain' } );
	if ( ! plainAsphalt ) physics.setSurfaceQuery( surfaceQuery ?? ( () => surface ) );
	if ( build ) build( physics );

	const car = new Vehicle( physics, config );
	if ( assists ) car.setAssists( assists );
	car.setAnalogSteering( analog );
	car.setWetness( wetness );
	car.reset( { position: [ position[ 0 ], position[ 1 ] - grade * position[ 2 ], position[ 2 ] ], yaw }, speed );

	const log = {};
	for ( const field of LOG_FIELDS ) log[ field ] = [];
	return { physics, car, state: car.state, input: { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false }, log, time: 0, finite: true };

}

/**
 * Advances a rig. `control( rig )` is called before every step to set rig.input; returning true stops the run.
 * @param {Rig} rig
 * @param {number} duration                 seconds
 * @param {(rig: Rig) => (boolean|void)} [control]
 * @returns {Rig} the rig
 */
export function run( rig, duration, control = null ) {

	const { physics, car, state, input, log } = rig;
	const steps = Math.round( duration / PHYSICS_DT );
	for ( let i = 0; i < steps; i ++ ) {

		if ( control !== null && control( rig ) === true ) break;
		car.step( input );
		physics.step();
		car.afterStep();
		input.shiftUp = input.shiftDown = false;
		rig.time += PHYSICS_DT;

		const q = state.quaternion;
		log.t.push( rig.time );
		log.speed.push( state.speed );
		log.rpm.push( state.rpm );
		log.gear.push( state.gear );
		log.longG.push( state.longG );
		log.latG.push( state.latG );
		log.steerAngle.push( state.steerAngle );
		log.steerInput.push( state.steerInput );
		log.yawRate.push( state.yawRate );
		log.yaw.push( state.yaw );
		log.drift.push( state.driftAngle );
		log.x.push( state.position[ 0 ] );
		log.y.push( state.position[ 1 ] );
		log.z.push( state.position[ 2 ] );
		log.throttle.push( state.throttle );
		log.brake.push( state.brake );
		// Roll (about the forward axis, positive = right side down) and pitch (positive = nose up) from the basis.
		const rightY = 2 * ( q[ 0 ] * q[ 1 ] + q[ 2 ] * q[ 3 ] ), backY = 2 * ( q[ 1 ] * q[ 2 ] - q[ 0 ] * q[ 3 ] );
		log.roll.push( - Math.asin( clamp( rightY, - 1, 1 ) ) );
		log.pitch.push( Math.asin( clamp( backY, - 1, 1 ) ) );

		if ( rig.finite ) {

			let sum = state.speed + state.rpm + state.longG + state.latG + state.yawRate + q[ 0 ] + q[ 1 ] + q[ 2 ] + q[ 3 ];
			for ( let k = 0; k < 3; k ++ ) sum += state.position[ k ] + state.linearVelocity[ k ] + state.angularVelocity[ k ];
			for ( const wheel of state.wheels ) sum += wheel.load + wheel.angularVelocity + wheel.slipRatio + wheel.slipAngle + wheel.longForce + wheel.latForce + wheel.skid;
			if ( ! Number.isFinite( sum ) ) rig.finite = false;

		}

	}

	return rig;

}

/** Frees the physics world of a rig. */
function dispose( rig ) {

	rig.physics.dispose();

}

/** Throttle / brake command that holds a target speed (simple proportional cruise control). */
function holdSpeed( rig, target, gain = 0.6 ) {

	const error = target - rig.state.forwardSpeed;
	rig.input.throttle = clamp( 0.12 + gain * error + target * target * 0.00006, 0, 1 );
	rig.input.brake = clamp( - 0.3 * ( error + 1.5 ), 0, 1 );

}

const mean = ( values, from = 0, to = values.length ) => {

	let sum = 0;
	for ( let i = from; i < to; i ++ ) sum += values[ i ];
	return sum / Math.max( 1, to - from );

};

const maxAbs = ( values, from = 0, to = values.length ) => {

	let best = 0;
	for ( let i = from; i < to; i ++ ) best = Math.max( best, Math.abs( values[ i ] ) );
	return best;

};

const round = ( value, digits = 2 ) => Number( value.toFixed( digits ) );

// ───────────────────────────────────────────── maneuvers ─────────────────────────────────────────────
// Every maneuver returns { metrics: { name: number|boolean }, log, finite } (log = telemetry of its main run).

/** Standing start at full throttle: 0-100, 0-200, standing 400 m. */
async function launch( { assists = null } = {} ) {

	const rig = await createRig( { assists } );
	run( rig, 0.5 );
	const start = rig.time;
	let t100 = NaN, t200 = NaN, t400 = NaN, v400 = NaN, maxSlip = 0, shifts = 0, lastGear = 1;
	run( rig, 30, ( r ) => {

		r.input.throttle = 1;
		const v = r.state.forwardSpeed * KMH, t = r.time - start, d = - r.state.position[ 2 ];
		if ( Number.isNaN( t100 ) && v >= 100 ) t100 = t;
		if ( Number.isNaN( t200 ) && v >= 200 ) t200 = t;
		if ( Number.isNaN( t400 ) && d >= 400 ) {

			t400 = t;
			v400 = v;

		}

		if ( r.state.gear !== lastGear ) {

			shifts ++;
			lastGear = r.state.gear;

		}

		maxSlip = Math.max( maxSlip, r.state.wheels[ 2 ].slipRatio, r.state.wheels[ 3 ].slipRatio );
		return ! Number.isNaN( t200 ) && ! Number.isNaN( t400 );

	} );
	const result = {
		metrics: { t0_100: round( t100 ), t0_200: round( t200 ), t400m: round( t400 ), v400m_kmh: round( v400, 1 ), maxDriveSlip: round( maxSlip ), shifts, lateralDrift_m: round( Math.abs( rig.state.position[ 0 ] ), 3 ) },
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Full throttle from a rolling start until the speed no longer rises. */
async function topSpeed() {

	const rig = await createRig( { speed: 70, position: [ 0, 0, 14000 ] } );
	let last = 0, top = 0;
	run( rig, 150, ( r ) => {

		r.input.throttle = 1;
		top = Math.max( top, r.state.forwardSpeed );
		if ( Math.round( r.time / PHYSICS_DT ) % 600 === 0 ) {

			if ( r.time > 20 && r.state.forwardSpeed - last < 0.02 ) return true;
			last = r.state.forwardSpeed;

		}

		return false;

	} );
	const result = {
		metrics: { topSpeed_kmh: round( top * KMH, 1 ), gear: rig.state.gear, rpm: Math.round( rig.state.rpm ), time_s: round( rig.time, 1 ), lateralDrift_m: round( Math.abs( rig.state.position[ 0 ] ), 3 ) },
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Full braking from `kmh` to standstill. */
async function braking( { kmh = 100, assists = null, wetness = 0, surface = Surface.ASPHALT } = {} ) {

	const v0 = kmh / KMH;
	const rig = await createRig( { speed: v0 + 1, assists, wetness, surface } );
	run( rig, 2.5, ( r ) => holdSpeed( r, v0 + 0.3 ) );
	let startZ = NaN, startT = 0, peak = 0, lockedTime = 0, stopT = NaN;
	run( rig, 20, ( r ) => {

		r.input.throttle = 0;
		r.input.brake = 1;
		if ( Number.isNaN( startZ ) ) {

			startZ = r.state.position[ 2 ];
			startT = r.time;

		}

		peak = Math.max( peak, - r.state.longG );
		if ( r.state.speed > 3 && r.state.wheels.some( ( w ) => w.contact && Math.abs( w.angularVelocity ) < 0.5 ) ) lockedTime += PHYSICS_DT;
		if ( Number.isNaN( stopT ) && r.state.speed < 0.1 ) {

			stopT = r.time - startT;
			return true;

		}

		return false;

	} );
	const distance = startZ - rig.state.position[ 2 ];
	const result = {
		metrics: { entry_kmh: kmh, distance_m: round( distance, 1 ), time_s: round( stopT ), meanDecel_g: round( v0 * v0 / ( 2 * distance ) / GRAVITY ), peakDecel_g: round( peak ), wheelLock_s: round( lockedTime ), lateralDrift_m: round( Math.abs( rig.state.position[ 0 ] ), 3 ) },
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/**
 * Steady-state circle of radius R driven with a path-following steering controller while the speed creeps up until
 * the car cannot hold the radius any more. Reports the maximum lateral acceleration, the understeer gradient in the
 * linear range and the balance at the limit.
 */
async function skidpad( { radius = 50, assists = null, wetness = 0, surface = Surface.ASPHALT } = {} ) {

	const startSpeed = Math.sqrt( 0.25 * GRAVITY * radius );
	const rig = await createRig( { speed: startSpeed, assists, wetness, surface, analog: true } );
	const memory = {};
	let target = startSpeed, offTime = 0;
	run( rig, 140, ( r ) => {

		const error = followCircle( r, radius, memory );
		target += 0.22 * PHYSICS_DT;
		holdSpeed( r, target, 0.35 );
		offTime = error > 2.5 || Math.abs( r.state.driftAngle ) > 0.6 ? offTime + PHYSICS_DT : 0;
		return offTime > 1.0 || target - r.state.forwardSpeed > 2.5;

	} );

	const { log } = rig;
	// Maximum 1.5 s mean of the lateral acceleration.
	const window = Math.round( 1.5 / PHYSICS_DT );
	let best = 0, bestAt = 0, sum = 0;
	for ( let i = 0; i < log.latG.length; i ++ ) {

		sum += log.latG[ i ];
		if ( i >= window ) sum -= log.latG[ i - window ];
		if ( i >= window && sum / window > best ) {

			best = sum / window;
			bestAt = i;

		}

	}

	// Understeer gradient: least-squares slope of the steer angle over lateral g between 0.3 g and 0.8 g.
	let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
	for ( let i = 0; i < log.latG.length; i ++ ) {

		const g = log.latG[ i ];
		if ( g < 0.3 || g > 0.8 ) continue;
		const d = log.steerAngle[ i ] * RAD2DEG;
		n ++; sx += g; sy += d; sxx += g * g; sxy += g * d;

	}

	const gradient = n > 10 ? ( n * sxy - sx * sy ) / ( n * sxx - sx * sx ) : NaN;
	const result = {
		metrics: {
			radius_m: radius,
			maxLatG: round( best ),
			speedAtMax_kmh: round( mean( log.speed, bestAt - window, bestAt ) * KMH, 1 ),
			understeerGradient_degPerG: round( gradient ),
			steerAtMax_deg: round( mean( log.steerAngle, bestAt - window, bestAt ) * RAD2DEG, 1 ),
			driftAtMax_deg: round( mean( log.drift, bestAt - window, bestAt ) * RAD2DEG, 1 ),
			finalDrift_deg: round( rig.state.driftAngle * RAD2DEG, 1 ),
			endedBy: Math.abs( rig.state.driftAngle ) > 0.6 ? 'spin' : 'understeer',
		},
		log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Steering lock (rad) the vehicle allows at a speed, mirroring its speed-dependent lock. */
function steerLockAt( rig, speed ) {

	const st = rig.car.config.steering;
	if ( ! rig.car.assists.steerAssist ) return st.maxAngle;
	return Math.min( st.maxAngle, Math.atan( rig.car.config.geometry.wheelbase * st.lockLatAccel / Math.max( speed * speed, 1 ) ) + st.lockSlipFactor * rig.car.config.tires.front.peakSlipAngle );

}

/** Path-following steering for a left-hand circle of radius R around ( -R, 0 ): sets rig.input.steer. */
function followCircle( rig, radius, memory ) {

	const s = rig.state;
	const dx = s.position[ 0 ] + radius, dz = s.position[ 2 ];
	const distance = Math.hypot( dx, dz );
	const error = distance - radius; // > 0 = running wide
	const radialSpeed = ( s.linearVelocity[ 0 ] * dx + s.linearVelocity[ 2 ] * dz ) / distance;
	memory.integral = clamp( ( memory.integral ?? 0 ) + error * PHYSICS_DT, - 3, 3 );
	const angle = Math.atan( rig.car.config.geometry.wheelbase / radius ) + ( 0.08 * error + 0.10 * radialSpeed ) * Math.min( 1, 18 / Math.max( 1, s.forwardSpeed ) ) + 0.04 * memory.integral;
	rig.input.steer = clamp( - angle / Math.max( 0.02, steerLockAt( rig, s.forwardSpeed ) ), - 1, 1 );
	return error;

}

/** Step steer at `kmh` sized for about `targetG` of steady lateral acceleration (analog input, assists on). */
async function stepSteer( { kmh = 100, targetG = 0.5 } = {} ) {

	const v = kmh / KMH;
	const rig = await createRig( { speed: v, analog: true } );
	run( rig, 1.5, ( r ) => holdSpeed( r, v ) );
	const curvature = targetG * GRAVITY / ( v * v );
	const angle = SPORTS_CAR.geometry.wheelbase * curvature + 0.7 * DEG2RAD * targetG;
	const steer = - angle / steerLockAt( rig, v );
	const from = rig.log.t.length;
	run( rig, 3.5, ( r ) => {

		holdSpeed( r, v );
		r.input.steer = steer;

	} );
	const yawRate = rig.log.yawRate.slice( from );
	const steady = mean( yawRate, yawRate.length - 120 );
	let peak = 0, rise = NaN, settle = 0;
	for ( let i = 0; i < yawRate.length; i ++ ) {

		peak = Math.max( peak, yawRate[ i ] );
		if ( Number.isNaN( rise ) && yawRate[ i ] >= 0.9 * steady ) rise = i * PHYSICS_DT;
		if ( Math.abs( yawRate[ i ] - steady ) > 0.05 * Math.abs( steady ) ) settle = ( i + 1 ) * PHYSICS_DT;

	}

	const result = {
		metrics: { speed_kmh: kmh, steer_deg: round( angle * RAD2DEG ), steadyLatG: round( mean( rig.log.latG, rig.log.latG.length - 120 ) ), riseTime_s: round( rise ), overshoot_pct: round( ( peak / steady - 1 ) * 100, 1 ), settle_s: round( settle ) },
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Throttle lift in the middle of a corner taken near the limit, steering held. */
async function liftOff() {

	const radius = 60, v = Math.sqrt( 1.1 * GRAVITY * radius );
	const rig = await createRig( { speed: v * 0.9, analog: true } );
	const memory = {};
	run( rig, 9, ( r ) => {

		followCircle( r, radius, memory );
		holdSpeed( r, v, 0.35 );

	} );
	const before = mean( rig.log.yawRate, rig.log.yawRate.length - 60 ), latBefore = mean( rig.log.latG, rig.log.latG.length - 60 );
	const steer = rig.input.steer, from = rig.log.t.length;
	run( rig, 3, ( r ) => {

		r.input.steer = steer;
		r.input.throttle = 0;
		r.input.brake = 0;

	} );
	const result = {
		metrics: {
			latGBefore: round( latBefore ),
			yawRateGain_pct: round( ( Math.max( ...rig.log.yawRate.slice( from, from + 180 ) ) / before - 1 ) * 100, 1 ),
			maxDrift_deg: round( maxAbs( rig.log.drift, from ) * RAD2DEG, 1 ),
			finalDrift_deg: round( Math.abs( rig.state.driftAngle ) * RAD2DEG, 1 ),
			spun: maxAbs( rig.log.drift, from ) > 0.8,
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/**
 * Full throttle in 2nd gear in a tight corner with the traction control off: the tail must step out progressively
 * (not snap), and easing the throttle with the steering released must bring the car back.
 */
async function powerOn( { assists = { tc: false, stability: false, autoGearbox: false } } = {} ) {

	const radius = 25, v = Math.sqrt( 0.85 * GRAVITY * radius );
	const rig = await createRig( { speed: v, analog: true, assists } );
	rig.input.shiftUp = true; // 1st -> 2nd (manual gearbox)
	const memory = {};
	run( rig, 6, ( r ) => {

		followCircle( r, radius, memory );
		holdSpeed( r, v, 0.35 );

	} );
	const steer = rig.input.steer, from = rig.log.t.length, gear = rig.state.gear;
	let t10 = NaN, t30 = NaN;
	run( rig, 2.5, ( r ) => {

		r.input.steer = steer;
		r.input.throttle = 1;
		r.input.brake = 0;
		const drift = Math.abs( r.state.driftAngle ) * RAD2DEG, t = ( r.log.t.length - from ) * PHYSICS_DT;
		if ( Number.isNaN( t10 ) && drift > 10 ) t10 = t;
		if ( Number.isNaN( t30 ) && drift > 30 ) t30 = t;
		return ! Number.isNaN( t30 ); // the driver reacts once the tail is 30 degrees out

	} );
	const driftAtRelease = Math.abs( rig.state.driftAngle ) * RAD2DEG;
	const recover = rig.log.t.length;
	let recovered = NaN;
	run( rig, 5, ( r ) => {

		// The driver comes off the power and lets go of the wheel; the counter-steer help does the rest.
		r.input.steer = 0;
		r.input.throttle = 0.15;
		const t = ( r.log.t.length - recover ) * PHYSICS_DT;
		if ( Number.isNaN( recovered ) && Math.abs( r.state.driftAngle ) < 4 * DEG2RAD && Math.abs( r.state.yawRate ) < 0.12 ) recovered = t;

	} );
	const result = {
		metrics: {
			gear,
			drift05s_deg: round( Math.abs( rig.log.drift[ from + 60 ] ) * RAD2DEG, 1 ),
			drift10s_deg: round( Math.abs( rig.log.drift[ from + 120 ] ) * RAD2DEG, 1 ),
			timeTo10deg_s: round( t10 ), timeTo30deg_s: round( t30 ),
			driftAtRelease_deg: round( driftAtRelease, 1 ),
			maxDrift_deg: round( maxAbs( rig.log.drift, from ) * RAD2DEG, 1 ),
			recovered_s: round( recovered ),
			spun: maxAbs( rig.log.drift, from ) > 100 * DEG2RAD,
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Handbrake turn from 60 km/h with keyboard inputs: full lock + handbrake, then release and drive away. */
async function handbrakeTurn() {

	const v = 60 / KMH;
	const rig = await createRig( { speed: v } );
	run( rig, 1, ( r ) => holdSpeed( r, v ) );
	const yaw0 = rig.state.yaw, from = rig.log.t.length;
	let heading = 0, lastYaw = yaw0;
	const track = ( r ) => {

		heading += angleDelta( lastYaw, r.state.yaw );
		lastYaw = r.state.yaw;

	};

	run( rig, 0.3, ( r ) => {

		// Turn in first, then pull the handbrake.
		track( r );
		r.input.steer = - 1;
		r.input.throttle = 0;

	} );
	run( rig, 0.65, ( r ) => {

		track( r );
		r.input.steer = - 1;
		r.input.handbrake = 1;

	} );
	const rotationAtRelease = heading;
	let recovered = NaN;
	const release = rig.log.t.length;
	run( rig, 5, ( r ) => {

		track( r );
		r.input.steer = 0;
		r.input.handbrake = 0;
		r.input.throttle = 1;
		const t = ( r.log.t.length - release ) * PHYSICS_DT;
		if ( Number.isNaN( recovered ) && t > 0.3 && Math.abs( r.state.driftAngle ) < 5 * DEG2RAD && Math.abs( r.state.yawRate ) < 0.15 && r.state.forwardSpeed > 3 ) recovered = t;

	} );
	const result = {
		metrics: {
			rotationAtRelease_deg: round( rotationAtRelease * RAD2DEG, 1 ),
			totalRotation_deg: round( heading * RAD2DEG, 1 ),
			maxDrift_deg: round( maxAbs( rig.log.drift, from ) * RAD2DEG, 1 ),
			minSpeed_kmh: round( Math.min( ...rig.log.speed.slice( from ) ) * KMH, 1 ),
			recovered_s: round( recovered ),
			finalSpeed_kmh: round( rig.state.forwardSpeed * KMH, 1 ),
			finalYawRate: round( rig.state.yawRate, 3 ),
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Zero steering at 300 km/h for 5 s; then a yaw kick (a gust) to see how the disturbance dies out. */
async function straight300() {

	const v = 300 / KMH;
	const rig = await createRig( { speed: v, position: [ 0, 0, 3000 ] } );
	run( rig, 2, ( r ) => holdSpeed( r, v ) );
	const from = rig.log.t.length, x0 = rig.state.position[ 0 ];
	run( rig, 5, ( r ) => holdSpeed( r, v ) );
	let deviation = 0;
	for ( let i = from; i < rig.log.x.length; i ++ ) deviation = Math.max( deviation, Math.abs( rig.log.x[ i ] - x0 ) );

	const w = rig.car.body.angvel(), yaw0 = rig.state.yaw, kick = 0.05; // 2.9 deg/s of yaw rate
	rig.car.body.setAngvel( { x: w.x, y: w.y + kick, z: w.z }, true );
	const kicked = rig.log.t.length;
	run( rig, 4, ( r ) => holdSpeed( r, v ) );
	let settle = 0, reversals = 0;
	for ( let i = kicked + 1; i < rig.log.yawRate.length; i ++ ) {

		if ( Math.abs( rig.log.yawRate[ i ] ) > 0.1 * kick ) settle = ( i - kicked ) * PHYSICS_DT;
		if ( rig.log.yawRate[ i ] * rig.log.yawRate[ i - 1 ] < 0 && Math.abs( rig.log.yawRate[ i ] - rig.log.yawRate[ i - 1 ] ) > 1e-5 ) reversals ++;

	}

	const result = {
		metrics: {
			maxDeviation_m: round( deviation, 3 ), speed_kmh: round( rig.state.speed * KMH, 1 ),
			kickSettle_s: round( settle ), kickHeadingChange_deg: round( angleDelta( yaw0, rig.state.yaw ) * RAD2DEG, 3 ), kickYawReversals: reversals,
			finalYawRate: round( Math.abs( rig.state.yawRate ), 5 ),
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Slalom with keyboard inputs: full throttle, the steering flipped between full left and full right. */
async function slalom( { kmh = 70, halfPeriod = 0.9, wetness = 0, assists = null } = {} ) {

	const rig = await createRig( { speed: kmh / KMH, wetness, assists } );
	const from = rig.log.t.length;
	let spun = false, flips = 0;
	run( rig, 12 * halfPeriod, ( r ) => {

		const phase = Math.floor( ( r.log.t.length - from ) * PHYSICS_DT / halfPeriod );
		flips = phase;
		r.input.steer = phase % 2 === 0 ? - 1 : 1;
		r.input.throttle = 1;
		if ( Math.abs( r.state.driftAngle ) > 60 * DEG2RAD ) spun = true;

	} );
	run( rig, 2.5, ( r ) => {

		r.input.steer = 0;
		r.input.throttle = 1;

	} );
	const result = {
		metrics: {
			entry_kmh: kmh, flips: flips + 1,
			maxDrift_deg: round( maxAbs( rig.log.drift, from ) * RAD2DEG, 1 ),
			maxLatG: round( maxAbs( rig.log.latG, from ) ),
			maxYawRate: round( maxAbs( rig.log.yawRate, from ) ),
			exit_kmh: round( rig.state.forwardSpeed * KMH, 1 ),
			finalDrift_deg: round( Math.abs( rig.state.driftAngle ) * RAD2DEG, 1 ),
			finalYawRate: round( Math.abs( rig.state.yawRate ), 3 ),
			spun,
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Keyboard abuse: full throttle and full lock held, released, then full opposite lock, at several speeds. */
async function keyboardTaps( { assists = null, wetness = 0 } = {} ) {

	const metrics = {};
	let finite = true, log = null, spunAny = false;
	for ( const kmh of [ 50, 90, 140 ] ) {

		const rig = await createRig( { speed: kmh / KMH, assists, wetness } );
		let spun = false;
		const drive = ( steer, duration ) => run( rig, duration, ( r ) => {

			r.input.steer = steer;
			r.input.throttle = 1;
			if ( Math.abs( r.state.driftAngle ) > 60 * DEG2RAD ) spun = true;

		} );
		drive( - 1, 1.5 );
		drive( 0, 0.6 );
		drive( 1, 1.5 );
		drive( 0, 2.0 );
		metrics[ `maxDrift${kmh}_deg` ] = round( maxAbs( rig.log.drift ) * RAD2DEG, 1 );
		metrics[ `finalDrift${kmh}_deg` ] = round( Math.abs( rig.state.driftAngle ) * RAD2DEG, 1 );
		spunAny ||= spun;
		finite &&= rig.finite;
		log = rig.log;
		dispose( rig );

	}

	metrics.spun = spunAny;
	return { metrics, log, finite };

}

/** Standstill on a 15 % slope: brake only (manual gearbox), then handbrake only; nose uphill or downhill. */
async function slopeHold() {

	const metrics = {};
	let finite = true, log = null;
	for ( const [ label, yaw ] of [ [ 'uphill', 0 ], [ 'downhill', Math.PI ], [ 'across', Math.PI / 2 ] ] ) {

		const rig = await createRig( { grade: 0.15, yaw, assists: { autoGearbox: false } } );
		const start = rig.state.position.slice();
		const moved = () => Math.hypot( rig.state.position[ 0 ] - start[ 0 ], rig.state.position[ 1 ] - start[ 1 ], rig.state.position[ 2 ] - start[ 2 ] );
		run( rig, 5, ( r ) => {

			r.input.brake = 1;

		} );
		metrics[ `${label}Brake_mm` ] = round( moved() * 1000, 1 );
		const afterBrake = moved();
		run( rig, 0.3, ( r ) => {

			r.input.brake = 1;
			r.input.handbrake = 1;

		} );
		run( rig, 5, ( r ) => {

			r.input.brake = 0;
			r.input.handbrake = 1;

		} );
		metrics[ `${label}Handbrake_mm` ] = round( ( moved() - afterBrake ) * 1000, 1 );
		metrics[ `${label}Speed_mms` ] = round( rig.state.speed * 1000, 2 );
		finite &&= rig.finite;
		log = rig.log;
		dispose( rig );

	}

	return { metrics, log, finite };

}

/** Standstill on flat ground with no input, then a stop from 30 km/h held on the brake: jitter and creep. */
async function standstill() {

	const rig = await createRig( { assists: { autoGearbox: false } } );
	run( rig, 5 );
	const restDrift = Math.hypot( rig.state.position[ 0 ], rig.state.position[ 2 ] );
	const restSpeed = maxAbs( rig.log.speed, 120 );
	const restBounce = maxAbs( rig.log.y, 120 );
	rig.car.reset( { position: [ 0, 0, 0 ], yaw: 0 }, 30 / KMH );
	let stopAt = - 1;
	run( rig, 6, ( r ) => {

		r.input.brake = 1;
		if ( stopAt < 0 && r.state.speed < 0.02 ) stopAt = r.log.t.length;

	} );
	const stopped = stopAt > 0 ? stopAt + 60 : rig.log.t.length - 1;
	const result = {
		metrics: {
			restDrift_mm: round( restDrift * 1000, 2 ), restMaxSpeed_mms: round( restSpeed * 1000, 2 ), restBounce_mm: round( restBounce * 1000, 2 ),
			stopCreep_mm: round( Math.abs( rig.log.z.at( - 1 ) - rig.log.z[ stopped ] ) * 1000, 2 ),
			stopMaxSpeed_mms: round( maxAbs( rig.log.speed, stopped ) * 1000, 2 ),
			stopMaxPitchRate_degs: round( maxAbs( rig.log.pitch.slice( stopped ).map( ( p, i, all ) => ( i ? ( p - all[ i - 1 ] ) / PHYSICS_DT : 0 ) ) ) * RAD2DEG, 2 ),
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Automatic gearbox: reverse by holding the brake at standstill, back to 1st with the throttle; shift hunting. */
async function gearbox() {

	const rig = await createRig();
	run( rig, 3, ( r ) => {

		r.input.brake = 1;

	} );
	const reverseGear = rig.state.gear, reverseSpeed = rig.state.forwardSpeed;
	let selectedFirstAt = NaN;
	run( rig, 3, ( r ) => {

		r.input.brake = 0;
		r.input.throttle = 1;
		if ( Number.isNaN( selectedFirstAt ) && r.state.gear === 1 ) selectedFirstAt = r.state.forwardSpeed;

	} );
	const forwardSpeed = rig.state.forwardSpeed;

	// Part throttle from low speed: every shift must be an up-shift (no hunting).
	rig.car.reset( { position: [ 0, 0, 0 ], yaw: 0 }, 8 );
	let last = rig.state.gear, ups = 0, downs = 0;
	const count = ( r ) => {

		if ( r.state.shifting ) return;
		if ( r.state.gear > last ) ups ++;
		if ( r.state.gear < last ) downs ++;
		last = r.state.gear;

	};

	run( rig, 25, ( r ) => {

		r.input.throttle = 0.45;
		count( r );

	} );
	const cruiseGear = rig.state.gear, cruiseDowns = downs;

	// Lift, then brake to 40 km/h, then floor it: down-shifts only, then up-shifts only.
	downs = 0;
	let upsWhileSlowing = 0;
	run( rig, 20, ( r ) => {

		r.input.throttle = 0;
		r.input.brake = 0.6;
		const before = ups;
		count( r );
		upsWhileSlowing += ups - before;
		return r.state.forwardSpeed < 40 / KMH;

	} );
	const result = {
		metrics: {
			reverseGear, reverseSpeed_kmh: round( reverseSpeed * KMH, 1 ), speedWhenFirstSelected_kmh: round( selectedFirstAt * KMH, 1 ), forwardAgain_kmh: round( forwardSpeed * KMH, 1 ),
			partThrottleGear: cruiseGear, partThrottleDownshifts: cruiseDowns, upshiftsWhileBraking: upsWhileSlowing, gearAt40: rig.state.gear,
		},
		log: rig.log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** A 5 cm kerb, 0.7 m wide and 25 m long, taken with the left wheels at `kmh`, no steering correction. */
async function kerb( { kmh = 100 } = {} ) {

	const v = kmh / KMH;
	const build = ( physics ) => physics.addStaticBox( { center: [ - 0.835, 0.025 - 0.2, - 60 - 12.5 ], halfExtents: [ 0.35, 0.225, 12.5 ], kind: 'road' } );
	const rig = await createRig( { speed: v, build } );
	let impacts = 0, airborne = 0;
	run( rig, 5, ( r ) => {

		holdSpeed( r, v );
		impacts += r.state.impacts.length;
		if ( r.state.wheelsOnGround < 4 ) airborne += PHYSICS_DT;

	} );
	const { log } = rig;
	let maxVertical = 0;
	for ( let i = 1; i < log.y.length; i ++ ) maxVertical = Math.max( maxVertical, Math.abs( log.y[ i ] - log.y[ i - 1 ] ) / PHYSICS_DT );
	const result = {
		metrics: {
			maxRoll_deg: round( maxAbs( log.roll ) * RAD2DEG ), maxPitch_deg: round( maxAbs( log.pitch ) * RAD2DEG ), maxBodyVerticalSpeed_ms: round( maxVertical ),
			lateralDeviation_m: round( maxAbs( log.x ), 3 ), maxYawRate: round( maxAbs( log.yawRate ), 3 ), shellImpacts: impacts, wheelOffGround_s: round( airborne ),
			finalRoll_deg: round( Math.abs( log.roll.at( - 1 ) ) * RAD2DEG ), finalSpeed_kmh: round( rig.state.speed * KMH, 1 ),
		},
		log, finite: rig.finite,
	};
	dispose( rig );
	return result;

}

/** Loose or wet ground: maximum cornering and braking grip, and a keyboard-driven return from the verge to the road. */
async function looseSurface( { surface = Surface.GRASS } = {} ) {

	const pad = await skidpad( { radius: 50, surface } );
	const stop = await braking( { kmh: 100, surface } );

	// The car runs along the verge 4.5 m left of the road edge ( x < 0 is `surface`, x >= 0 asphalt ) and steers back.
	const rig = await createRig( { speed: 70 / KMH, position: [ - 4.5, 0, 0 ], surfaceQuery: ( x ) => ( x < 0 ? surface : Surface.ASPHALT ) } );
	let spun = false, reachedRoad = NaN;
	run( rig, 9, ( r ) => {

		const s = r.state, x = s.position[ 0 ];
		// A keyboard driver: taps right until the car points at the road, then taps to straighten on the lane at x = 3.
		const heading = - s.yaw; // > 0 = pointing right
		const want = clamp( ( 3 - x ) * 0.035, - 0.14, 0.14 );
		r.input.steer = heading < want - 0.012 ? 1 : heading > want + 0.012 ? - 1 : 0;
		r.input.throttle = 0.6;
		if ( Number.isNaN( reachedRoad ) && x > 1 ) reachedRoad = r.time;
		if ( Math.abs( s.driftAngle ) > 60 * DEG2RAD ) spun = true;

	} );
	const result = {
		metrics: {
			skidpadLatG: pad.metrics.maxLatG, brake100_m: stop.metrics.distance_m,
			backOnRoad_s: round( reachedRoad ), finalX_m: round( rig.state.position[ 0 ] ), maxDrift_deg: round( maxAbs( rig.log.drift ) * RAD2DEG, 1 ),
			finalDrift_deg: round( Math.abs( rig.state.driftAngle ) * RAD2DEG, 1 ), finalSpeed_kmh: round( rig.state.speed * KMH, 1 ), spun,
		},
		log: rig.log, finite: rig.finite && pad.finite && stop.finite,
	};
	dispose( rig );
	return result;

}

/** Wet asphalt: grip in cornering and braking, plus the keyboard slalom. */
async function wet() {

	const pad = await skidpad( { radius: 50, wetness: 1 } );
	const stop = await braking( { kmh: 100, wetness: 1 } );
	const cones = await slalom( { kmh: 70, wetness: 1 } );
	return {
		metrics: { skidpadLatG: pad.metrics.maxLatG, brake100_m: stop.metrics.distance_m, slalomMaxDrift_deg: cones.metrics.maxDrift_deg, slalomSpun: cones.metrics.spun },
		log: cones.log, finite: pad.finite && stop.finite && cones.finite,
	};

}

/** Landings: a 1.5 m drop at 54 km/h and a jump of more than 15 m off a ramp. */
async function landings() {

	const metrics = {};
	let finite = true, log = null;
	const scenarios = {
		drop: { speed: 15, position: [ 0, 1.5, 0 ], build: null },
		jump: {
			speed: 29, position: [ 0, 0, 0 ],
			// A 12 m long wedge rising 0.85 m, 30 m ahead.
			build: ( physics ) => physics.addTriMesh( {
				positions: [ - 4, 0, - 30, 4, 0, - 30, - 4, 0.85, - 42, 4, 0.85, - 42, - 4, 0, - 42, 4, 0, - 42 ],
				indices: [ 0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4 ],
			} ),
		},
	};
	for ( const [ label, scenario ] of Object.entries( scenarios ) ) {

		const rig = await createRig( { speed: scenario.speed, build: scenario.build } );
		if ( label === 'drop' ) {

			rig.car.body.setTranslation( { x: 0, y: 1.5, z: 0 }, true );
			rig.car.afterStep();

		}

		let airTime = 0, flight = 0, flightStartZ = 0, jumpLength = 0, impacts = 0, peakImpulse = 0, upside = false, peakLoad = 0;
		run( rig, 6, ( r ) => {

			r.input.throttle = 0.3;
			const s = r.state;
			if ( s.airborne ) {

				// Length of the longest stretch with all four wheels off the ground.
				if ( flight === 0 ) flightStartZ = s.position[ 2 ];
				flight += PHYSICS_DT;
				if ( flight > airTime ) {

					airTime = flight;
					jumpLength = flightStartZ - s.position[ 2 ];

				}

			} else flight = 0;
			impacts += s.impacts.length;
			for ( const impact of s.impacts ) peakImpulse = Math.max( peakImpulse, impact.impulse );
			for ( const wheel of s.wheels ) peakLoad = Math.max( peakLoad, wheel.load );
			if ( s.upsideDown ) upside = true;

		} );
		const { log: l } = rig;
		metrics[ `${label}AirTime_s` ] = round( airTime );
		if ( label === 'jump' ) metrics.jumpLength_m = round( jumpLength, 1 );
		metrics[ `${label}PeakShellImpulse_Ns` ] = Math.round( peakImpulse );
		metrics[ `${label}MaxPitch_deg` ] = round( maxAbs( l.pitch ) * RAD2DEG, 1 );
		metrics[ `${label}MaxRoll_deg` ] = round( maxAbs( l.roll ) * RAD2DEG, 1 );
		metrics[ `${label}ShellImpacts` ] = impacts;
		metrics[ `${label}PeakWheelLoad_kN` ] = round( peakLoad / 1000, 1 );
		metrics[ `${label}FinalPitch_deg` ] = round( Math.abs( l.pitch.at( - 1 ) ) * RAD2DEG, 2 );
		metrics[ `${label}FinalSpeed_kmh` ] = round( rig.state.speed * KMH, 1 );
		metrics[ `${label}Upright` ] = ! upside && Math.abs( l.roll.at( - 1 ) ) < 0.1 && rig.state.wheelsOnGround === 4;
		finite &&= rig.finite;
		log = l;
		dispose( rig );

	}

	return { metrics, log, finite };

}

/** All maneuvers by name. */
export const MANEUVERS = {
	launch: () => launch(),
	launchNoTc: () => launch( { assists: { tc: false } } ),
	topSpeed: () => topSpeed(),
	brake100: () => braking( { kmh: 100 } ),
	brake200: () => braking( { kmh: 200 } ),
	brake100NoAbs: () => braking( { kmh: 100, assists: { abs: false } } ),
	skidpad50: () => skidpad( { radius: 50 } ),
	skidpad150: () => skidpad( { radius: 150 } ),
	skidpad50NoAids: () => skidpad( { radius: 50, assists: { tc: false, stability: false, steerAssist: false } } ),
	stepSteer100: () => stepSteer( { kmh: 100 } ),
	stepSteer180: () => stepSteer( { kmh: 180 } ),
	liftOff: () => liftOff(),
	powerOn: () => powerOn(),
	powerOnWithAids: () => powerOn( { assists: { autoGearbox: false } } ),
	handbrakeTurn: () => handbrakeTurn(),
	straight300: () => straight300(),
	slalom70: () => slalom( { kmh: 70, halfPeriod: 0.9 } ),
	slalom120: () => slalom( { kmh: 120, halfPeriod: 1.1 } ),
	keyboardTaps: () => keyboardTaps(),
	slopeHold: () => slopeHold(),
	standstill: () => standstill(),
	gearbox: () => gearbox(),
	kerb: () => kerb(),
	grass: () => looseSurface( { surface: Surface.GRASS } ),
	gravel: () => looseSurface( { surface: Surface.GRAVEL } ),
	wet: () => wet(),
	landings: () => landings(),
};

/**
 * Runs maneuvers by name.
 * @param {string[]} [names]  defaults to all
 * @returns {Promise<Object<string, { metrics: Object, log: Object, finite: boolean }>>}
 */
export async function runManeuvers( names = Object.keys( MANEUVERS ) ) {

	const results = {};
	for ( const name of names ) {

		if ( ! MANEUVERS[ name ] ) throw new Error( `unknown maneuver "${name}" (use --list)` );
		results[ name ] = await MANEUVERS[ name ]();

	}

	return results;

}

function printTable( results ) {

	for ( const [ name, result ] of Object.entries( results ) ) {

		const cells = Object.entries( result.metrics ).map( ( [ key, value ] ) => `${key}=${value}` );
		console.log( `${name.padEnd( 18 )} ${result.finite ? '' : 'NON-FINITE STATE!  '}${cells.join( '  ' )}` );

	}

}

//#CHARTS#

async function main() {

	const args = process.argv.slice( 2 );
	if ( args.includes( '--list' ) ) {

		console.log( Object.keys( MANEUVERS ).join( '\n' ) );
		return;

	}

	const chartsAt = args.indexOf( '--charts' );
	const chartDir = chartsAt >= 0 ? args[ chartsAt + 1 ] : null;
	const names = args.filter( ( arg, i ) => ! arg.startsWith( '--' ) && ( chartsAt < 0 || i !== chartsAt + 1 ) );
	const started = performance.now();
	const results = await runManeuvers( names.length ? names : undefined );
	printTable( results );
	console.log( `(${Object.keys( results ).length} maneuvers in ${( ( performance.now() - started ) / 1000 ).toFixed( 1 )} s)` );
	if ( chartDir ) {

		await mkdir( chartDir, { recursive: true } );
		console.log( `charts: ${path.resolve( chartDir )}` );

	}

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href ) await main();
