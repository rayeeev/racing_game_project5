// Vehicle dynamics: a custom raycast-wheel car on ONE dynamic rigid body.
//
// Each physics step the vehicle computes every force itself and hands Rapier a single net force + torque:
//   suspension ... ground rays per wheel, spring with preload, digressive bump / rebound damping, progressive bump
//                  stops, anti-roll bars
//   tires ........ combined-slip Pacejka-style model (tire.js) with load sensitivity and surface scaling; the lateral
//                  slip comes from a relaxation-length state, which doubles as static grip at standstill; a braked,
//                  stopped wheel holds through a longitudinal stiction spring
//   wheels ....... spin integrated implicitly (one Newton step on the tire force), so it is stable at 120 Hz
//   drivetrain ... torque-curve engine, launch clutch, 7-speed gearbox, limited-slip differential, rear-wheel drive
//   aids ......... keyboard steering shaping, speed-dependent lock, counter-steer help, ABS, TC, stability control
//
// Call order per step:  vehicle.step( input );  physics.step();  vehicle.afterStep();
// Conventions (axes, signs, wheel order): see constants.js.

import { clamp, lerp, moveToward, saturate, smoothstep, tableLookup } from '../core/math.js';
import { AIR_DENSITY, FL, FR, GRAVITY, RL, RR, SURFACES, Surface } from './constants.js';
import { combinedForce, loadGripFactor, solveStiffnessFactor } from './tire.js';
import { SPORTS_CAR } from './vehicleConfig.js';

/** @typedef {import('./types.js').VehicleInput} VehicleInput */
/** @typedef {import('./types.js').VehicleState} VehicleState */
/** @typedef {import('./types.js').SpawnPose} SpawnPose */

const RPM_TO_RAD = Math.PI / 30;
const RAD_TO_RPM = 30 / Math.PI;
const MOUNT_HEADROOM = 0.12; // m, the ground rays start this far above the wheel centre at full bump
const G_FILTER_RATE = 14; // 1/s, low-pass of the reported g-forces
const MAX_SPEED = 160; // m/s, hard sanity limit on the body speed
const MAX_SPIN = 60; // rad/s, hard sanity limit on the body angular speed

/**
 * The player / AI car. Owns one Rapier rigid body inside a PhysicsWorld.
 */
export class Vehicle {

	/**
	 * @param {import('./physics.js').PhysicsWorld} physics
	 * @param {typeof SPORTS_CAR} [config]
	 */
	constructor( physics, config = SPORTS_CAR ) {

		/** The physics world the car lives in. */
		this.physics = physics;

		/** The configuration the car was built from (not copied: do not mutate while driving). */
		this.config = config;

		const g = config.geometry, m = config.mass;
		this._dt = physics.dt;
		this._mass = m.total;

		// Centre of mass and wheel layout in body space.
		const comZ = g.rearAxleZ - m.frontWeightFraction * g.wheelbase;
		this._com = [ 0, m.comHeight, comZ ];
		this._wheelX = new Float64Array( [ - g.frontTrack / 2, g.frontTrack / 2, - g.rearTrack / 2, g.rearTrack / 2 ] );
		this._wheelZ = new Float64Array( [ g.frontAxleZ, g.frontAxleZ, g.rearAxleZ, g.rearAxleZ ] );
		this._radius = new Float64Array( [ g.frontWheelRadius, g.frontWheelRadius, g.rearWheelRadius, g.rearWheelRadius ] );
		this._axleSuspension = [ config.suspension.front, config.suspension.front, config.suspension.rear, config.suspension.rear ];
		this._axleTire = [ config.tires.front, config.tires.front, config.tires.rear, config.tires.rear ];

		// Suspension rates from the ride frequency and the static corner loads.
		this._staticLoad = new Float64Array( 4 );
		this._springRate = new Float64Array( 4 );
		this._bumpDamping = new Float64Array( 4 );
		this._reboundDamping = new Float64Array( 4 );
		this._mountY = new Float64Array( 4 ); // body-space y of the ray origin
		this._rayLength = new Float64Array( 4 ); // ray origin -> tire bottom at full droop
		this._travel = new Float64Array( 4 ); // droop + bump travel
		for ( let i = 0; i < 4; i ++ ) {

			const axle = this._axleSuspension[ i ];
			const share = i < 2 ? m.frontWeightFraction : 1 - m.frontWeightFraction;
			const cornerMass = m.total * share / 2;
			const omega = 2 * Math.PI * axle.frequency;
			this._staticLoad[ i ] = cornerMass * GRAVITY;
			this._springRate[ i ] = cornerMass * omega * omega;
			const critical = 2 * cornerMass * omega;
			this._bumpDamping[ i ] = critical * axle.dampingRatio * axle.bumpReboundSplit;
			this._reboundDamping[ i ] = critical * axle.dampingRatio * ( 2 - axle.bumpReboundSplit );
			this._mountY[ i ] = this._radius[ i ] + axle.bumpTravel + MOUNT_HEADROOM;
			this._rayLength[ i ] = this._mountY[ i ] + axle.droopTravel;
			this._travel[ i ] = axle.droopTravel + axle.bumpTravel;

		}

		// Tire curve.
		this._shapeC = config.tires.shapeC;
		this._shapeE = config.tires.shapeE;
		this._shapeB = solveStiffnessFactor( this._shapeC, this._shapeE );

		// Rigid body.
		const handle = physics.addVehicleBody( {
			hulls: [ buildShellHull( g ) ],
			mass: m.total,
			centerOfMass: this._com,
			principalInertia: m.inertia,
			friction: config.shell.friction,
			restitution: config.shell.restitution,
		} );

		/** The Rapier rigid body of the chassis. */
		this.body = handle.body;

		// Per-wheel simulation state.
		this._omega = new Float64Array( 4 ); // wheel angular velocity, rad/s (positive = rolling forward)
		this._compression = new Float64Array( 4 ); // suspension compression from full droop, m
		this._hadContact = new Uint8Array( 4 );
		this._load = new Float64Array( 4 ); // tire load, N
		this._deflection = new Float64Array( 4 ); // lateral tire deflection (relaxation state), m
		this._anchor = new Float64Array( 4 ); // longitudinal stiction-spring stretch of a held wheel, m
		this._absScale = new Float64Array( [ 1, 1, 1, 1 ] ); // ABS brake-pressure factor
		this._slipRatio = new Float64Array( 4 );
		this._brakeTorque = new Float64Array( 4 );
		this._wheelSteer = new Float64Array( 4 );

		// Per-wheel scratch of the current step.
		this._contact = new Uint8Array( 4 );
		this._surface = new Uint8Array( 4 );
		this._cp = new Float64Array( 12 ); // contact points
		this._cn = new Float64Array( 12 ); // contact normals
		this._fwd = new Float64Array( 12 ); // rolling direction in the ground plane
		this._left = new Float64Array( 12 ); // lateral direction in the ground plane (toward the wheel's left)
		this._vx = new Float64Array( 4 ); // contact-patch velocity along the rolling direction
		this._vy = new Float64Array( 4 ); // contact-patch velocity toward the wheel's left
		this._fxMax = new Float64Array( 4 );
		this._fyMax = new Float64Array( 4 );
		this._peakRatio = new Float64Array( 4 );
		this._peakTan = new Float64Array( 4 );
		this._sy = new Float64Array( 4 );
		this._fx = new Float64Array( 4 );
		this._fy = new Float64Array( 4 );
		this._stiffness = new Float64Array( 4 ); // secant stiffness Fx / (slip speed), N s/m
		this._slipSpeed = new Float64Array( 4 ); // slip speed the wheel-speed solve starts from, m/s
		this._relief = new Float64Array( 4 ); // 1 / ( 1 + stiffness * dt / mass share ): the body's give within a step
		this._prevVx = new Float64Array( 4 );
		this._omegaBefore = new Float64Array( 4 );
		this._prevFx = new Float64Array( 4 );
		this._hadTire = new Uint8Array( 4 );
		this._locked = new Uint8Array( 4 );
		this._tire = new Float64Array( 3 );

		// Body state cache (world space), refreshed by _readBody().
		this._p = { x: 0, y: 0, z: 0 };
		this._q = { x: 0, y: 0, z: 0, w: 1 };
		this._v = { x: 0, y: 0, z: 0 };
		this._w = { x: 0, y: 0, z: 0 };
		this._right = [ 1, 0, 0 ];
		this._up = [ 0, 1, 0 ];
		this._back = [ 0, 0, 1 ];
		this._comWorld = [ 0, 0, 0 ];
		this._force = { x: 0, y: 0, z: 0 };
		this._torque = { x: 0, y: 0, z: 0 };
		this._prevVelocity = [ 0, 0, 0 ];

		// Driver-aid switches and environment.
		const a = config.assists;
		this._assists = { abs: a.abs, tc: a.tc, stability: a.stability, steerAssist: a.steerAssist, autoGearbox: a.autoGearbox };
		this._analogSteering = false;
		this._wetness = 0;

		// Controls and drivetrain state.
		this._steerInput = 0;
		this._steerAngle = 0;
		this._steerLock = 0.6;
		this._throttle = 0;
		this._brake = 0;
		this._handbrake = 0;
		this._gear = 1;
		this._targetGear = 1;
		this._shiftTimer = 0;
		this._shiftCooldown = 0;
		this._shiftThrottle = 0;
		this._reverseTimer = 0;
		this._engineOmega = config.engine.idleRpm * RPM_TO_RAD;
		this._clutchLocked = false;
		this._limiter = false;
		this._tcScale = 1;
		this._axleTorqueLimit = Infinity;
		this._stabilityLevel = 0;
		this._stabilityWheel = FL;
		this._engineLoad = 0;
		this._appliedThrottle = 0;
		this._tcActive = false;
		this._absActive = false;
		this._longG = 0;
		this._latG = 0;
		this._odometer = 0;

		/**
		 * Telemetry of the car after the last afterStep(). Arrays and nested objects are reused between steps.
		 * @type {VehicleState}
		 */
		this.state = createState();

		this.reset( { position: [ 0, 0, 0 ], yaw: 0 }, 0 );

	}

	/**
	 * Switches driver aids on or off. Omitted keys keep their value.
	 * @param {{ abs?: boolean, tc?: boolean, stability?: boolean, steerAssist?: boolean, autoGearbox?: boolean }} assists
	 */
	setAssists( assists ) {

		for ( const key of Object.keys( this._assists ) ) {

			if ( assists[ key ] !== undefined ) this._assists[ key ] = Boolean( assists[ key ] );

		}

	}

	/**
	 * The current driver-aid switches (a live object: read only).
	 * @returns {{ abs: boolean, tc: boolean, stability: boolean, steerAssist: boolean, autoGearbox: boolean }}
	 */
	get assists() {

		return this._assists;

	}

	/**
	 * Sets how wet the ground is; the grip of every surface is scaled toward its `wetGrip` factor.
	 * @param {number} wetness  0 (dry) .. 1 (soaked)
	 */
	setWetness( wetness ) {

		this._wetness = saturate( wetness );

	}

	/**
	 * Chooses between keyboard-style steering shaping (false, the default) and near-direct analog steering (true).
	 * @param {boolean} analog
	 */
	setAnalogSteering( analog ) {

		this._analogSteering = Boolean( analog );

	}

	/**
	 * Places the car on the ground at static ride height, aligned with the ground under its wheels, rolling at
	 * `speed` with matching wheel and engine speeds. Every internal state is cleared.
	 * @param {SpawnPose} pose
	 * @param {number} [speed]  m/s along the car's forward axis
	 */
	reset( pose, speed = 0 ) {

		const config = this.config, body = this.body;
		const sin = Math.sin( pose.yaw ), cos = Math.cos( pose.yaw );
		let px = pose.position[ 0 ], py = pose.position[ 1 ], pz = pose.position[ 2 ];

		// Basis of a pure yaw rotation: right = ( cos, 0, -sin ), back = ( sin, 0, cos ).
		const right = this._right, up = this._up, back = this._back;
		right[ 0 ] = cos; right[ 1 ] = 0; right[ 2 ] = - sin;
		up[ 0 ] = 0; up[ 1 ] = 1; up[ 2 ] = 0;
		back[ 0 ] = sin; back[ 1 ] = 0; back[ 2 ] = cos;

		// Probe the ground under the four wheels and lay the car onto the plane through the hits.
		const hits = this._cp;
		let allHit = true;
		for ( let i = 0; i < 4 && allHit; i ++ ) {

			const wx = px + right[ 0 ] * this._wheelX[ i ] + back[ 0 ] * this._wheelZ[ i ];
			const wz = pz + right[ 2 ] * this._wheelX[ i ] + back[ 2 ] * this._wheelZ[ i ];
			const hit = this.physics.raycast( wx, py + 2.5, wz, 0, - 1, 0, 8, body, true );
			if ( hit === null ) allHit = false;
			else {

				hits[ i * 3 ] = hit.point[ 0 ]; hits[ i * 3 + 1 ] = hit.point[ 1 ]; hits[ i * 3 + 2 ] = hit.point[ 2 ];

			}

		}

		if ( allHit ) {

			// forward = front midpoint - rear midpoint, right = right midpoint - left midpoint, up = right x forward.
			const c = FL * 3, d = FR * 3, e = RL * 3, f = RR * 3;
			let fx = hits[ c ] + hits[ d ] - hits[ e ] - hits[ f ];
			let fy = hits[ c + 1 ] + hits[ d + 1 ] - hits[ e + 1 ] - hits[ f + 1 ];
			let fz = hits[ c + 2 ] + hits[ d + 2 ] - hits[ e + 2 ] - hits[ f + 2 ];
			const rx = hits[ d ] + hits[ f ] - hits[ c ] - hits[ e ];
			const ry = hits[ d + 1 ] + hits[ f + 1 ] - hits[ c + 1 ] - hits[ e + 1 ];
			const rz = hits[ d + 2 ] + hits[ f + 2 ] - hits[ c + 2 ] - hits[ e + 2 ];
			let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
			const ul = Math.hypot( ux, uy, uz ), fl = Math.hypot( fx, fy, fz );
			if ( ul > 1e-9 && fl > 1e-9 && uy / ul > 0.3 ) {

				ux /= ul; uy /= ul; uz /= ul;
				fx /= fl; fy /= fl; fz /= fl;
				up[ 0 ] = ux; up[ 1 ] = uy; up[ 2 ] = uz;
				back[ 0 ] = - fx; back[ 1 ] = - fy; back[ 2 ] = - fz;
				right[ 0 ] = fy * uz - fz * uy; right[ 1 ] = fz * ux - fx * uz; right[ 2 ] = fx * uy - fy * ux; // forward x up

				// The body origin lies on the plane, under the point whose mean wheel offset is ( 0, midZ ).
				const midZ = ( this._wheelZ[ FL ] + this._wheelZ[ RL ] ) / 2;
				px = ( hits[ c ] + hits[ d ] + hits[ e ] + hits[ f ] ) / 4 - back[ 0 ] * midZ;
				py = ( hits[ c + 1 ] + hits[ d + 1 ] + hits[ e + 1 ] + hits[ f + 1 ] ) / 4 - back[ 1 ] * midZ;
				pz = ( hits[ c + 2 ] + hits[ d + 2 ] + hits[ e + 2 ] + hits[ f + 2 ] ) / 4 - back[ 2 ] * midZ;

			}

		}

		quaternionFromBasis( right, up, back, this._q );
		this._p.x = px; this._p.y = py; this._p.z = pz;
		this._v.x = - back[ 0 ] * speed; this._v.y = - back[ 1 ] * speed; this._v.z = - back[ 2 ] * speed;
		this._w.x = this._w.y = this._w.z = 0;
		body.setTranslation( this._p, true );
		body.setRotation( this._q, true );
		body.setLinvel( this._v, true );
		body.setAngvel( this._w, true );
		body.resetForces( true );
		body.resetTorques( true );
		this.physics.drainImpacts( body, this.state.impacts );
		this.state.impacts.length = 0;

		for ( let i = 0; i < 4; i ++ ) {

			this._omega[ i ] = speed / this._radius[ i ];
			this._compression[ i ] = this._axleSuspension[ i ].droopTravel;
			this._hadContact[ i ] = 0;
			this._load[ i ] = this._staticLoad[ i ];
			this._deflection[ i ] = 0;
			this._anchor[ i ] = 0;
			this._absScale[ i ] = 1;
			this._slipRatio[ i ] = 0;
			this._brakeTorque[ i ] = 0;
			this._wheelSteer[ i ] = 0;
			this._fx[ i ] = this._fy[ i ] = 0;
			this._sy[ i ] = 0;
			this._contact[ i ] = 0;
			this._locked[ i ] = 0;
			this._hadTire[ i ] = 0;
			this._prevFx[ i ] = 0;
			this.state.wheels[ i ].spin = 0;
			this.state.wheels[ i ].slip = 0;
			this.state.wheels[ i ].skid = 0;

		}

		// Gear that suits the speed, engine synchronised with the wheels.
		const drivetrain = config.drivetrain, engine = config.engine;
		let gear = speed < - drivetrain.standstillSpeed ? - 1 : 1;
		if ( gear > 0 ) {

			const shaft = Math.abs( speed ) / this._radius[ RL ] * drivetrain.finalDrive;
			while ( gear < drivetrain.gearRatios.length && shaft * drivetrain.gearRatios[ gear - 1 ] * RAD_TO_RPM > 7000 ) gear ++;

		}

		this._gear = this._targetGear = gear;
		const inputSpeed = Math.abs( speed ) / this._radius[ RL ] * Math.abs( this._gearRatio( gear ) );
		this._clutchLocked = inputSpeed > drivetrain.clutchReleaseRpm * RPM_TO_RAD * 1.1;
		this._engineOmega = this._clutchLocked ? inputSpeed : engine.idleRpm * RPM_TO_RAD;

		this._steerInput = this._steerAngle = 0;
		this._throttle = this._brake = this._handbrake = 0;
		this._shiftTimer = this._shiftCooldown = this._shiftThrottle = this._reverseTimer = 0;
		this._limiter = false;
		this._tcScale = 1;
		this._stabilityLevel = 0;
		this._engineLoad = this._appliedThrottle = 0;
		this._tcActive = this._absActive = false;
		this._longG = this._latG = 0;
		this._odometer = 0;
		this._prevVelocity[ 0 ] = this._v.x; this._prevVelocity[ 1 ] = this._v.y; this._prevVelocity[ 2 ] = this._v.z;

		this._readBody();
		this._writeState( false );

	}

	/**
	 * Computes and applies all forces for one fixed step. Call BEFORE physics.step().
	 * @param {VehicleInput} input
	 */
	step( input ) {

		this._readBody();
		this._force.x = this._force.y = this._force.z = 0;
		this._torque.x = this._torque.y = this._torque.z = 0;

		this._updateControls( input );
		this._updateSuspension();
		this._updateTires();
		this._applyAero();

		const body = this.body, f = this._force, t = this._torque;
		body.resetForces( false );
		body.resetTorques( false );
		if ( Number.isFinite( f.x + f.y + f.z + t.x + t.y + t.z ) ) {

			body.addForce( f, true );
			body.addTorque( t, true );

		} else this._clearWheelStates();

	}

	/**
	 * Reads the body back and updates `state`. Call AFTER physics.step().
	 */
	afterStep() {

		this._readBody();

		// Never let a numerical accident or a physics glitch run away.
		const v = this._v, w = this._w;
		const speed = Math.hypot( v.x, v.y, v.z ), spin = Math.hypot( w.x, w.y, w.z );
		if ( ! Number.isFinite( speed + spin + this._p.x + this._p.y + this._p.z ) ) {

			this._p.x = this.state.position[ 0 ]; this._p.y = this.state.position[ 1 ]; this._p.z = this.state.position[ 2 ];
			this._q.x = this.state.quaternion[ 0 ]; this._q.y = this.state.quaternion[ 1 ]; this._q.z = this.state.quaternion[ 2 ]; this._q.w = this.state.quaternion[ 3 ];
			v.x = v.y = v.z = w.x = w.y = w.z = 0;
			this.body.setTranslation( this._p, true );
			this.body.setRotation( this._q, true );
			this.body.setLinvel( v, true );
			this.body.setAngvel( w, true );
			this._clearWheelStates();
			this._readBody();

		} else {

			if ( speed > MAX_SPEED ) {

				const k = MAX_SPEED / speed;
				v.x *= k; v.y *= k; v.z *= k;
				this.body.setLinvel( v, true );

			}

			if ( spin > MAX_SPIN ) {

				const k = MAX_SPIN / spin;
				w.x *= k; w.y *= k; w.z *= k;
				this.body.setAngvel( w, true );

			}

		}

		this._writeState( true );

	}

	// ───────────────────────────────────────────── internals ─────────────────────────────────────────────

	/** Signed overall ratio engine : wheels of a gear (negative for reverse, 0 for neutral). */
	_gearRatio( gear ) {

		const drivetrain = this.config.drivetrain;
		if ( gear > 0 ) return drivetrain.gearRatios[ gear - 1 ] * drivetrain.finalDrive;
		if ( gear < 0 ) return - drivetrain.reverseRatio * drivetrain.finalDrive;
		return 0;

	}

	_clearWheelStates() {

		for ( let i = 0; i < 4; i ++ ) {

			if ( ! Number.isFinite( this._omega[ i ] ) ) this._omega[ i ] = 0;
			this._deflection[ i ] = 0;
			this._anchor[ i ] = 0;
			this._fx[ i ] = this._fy[ i ] = 0;
			this._load[ i ] = 0;
			this._compression[ i ] = 0;
			this._hadContact[ i ] = 0;
			this._hadTire[ i ] = 0;
			this._prevFx[ i ] = 0;

		}

		if ( ! Number.isFinite( this._engineOmega ) ) this._engineOmega = this.config.engine.idleRpm * RPM_TO_RAD;

	}

	/** Refreshes the cached body pose, velocities, basis vectors and world centre of mass. */
	_readBody() {

		const body = this.body;
		const p = body.translation( this._p ), q = body.rotation( this._q );
		body.linvel( this._v );
		body.angvel( this._w );

		const x = q.x, y = q.y, z = q.z, w = q.w;
		const right = this._right, up = this._up, back = this._back;
		right[ 0 ] = 1 - 2 * ( y * y + z * z ); right[ 1 ] = 2 * ( x * y + z * w ); right[ 2 ] = 2 * ( x * z - y * w );
		up[ 0 ] = 2 * ( x * y - z * w ); up[ 1 ] = 1 - 2 * ( x * x + z * z ); up[ 2 ] = 2 * ( y * z + x * w );
		back[ 0 ] = 2 * ( x * z + y * w ); back[ 1 ] = 2 * ( y * z - x * w ); back[ 2 ] = 1 - 2 * ( x * x + y * y );

		const c = this._com, cw = this._comWorld;
		cw[ 0 ] = p.x + right[ 0 ] * c[ 0 ] + up[ 0 ] * c[ 1 ] + back[ 0 ] * c[ 2 ];
		cw[ 1 ] = p.y + right[ 1 ] * c[ 0 ] + up[ 1 ] * c[ 1 ] + back[ 1 ] * c[ 2 ];
		cw[ 2 ] = p.z + right[ 2 ] * c[ 0 ] + up[ 2 ] * c[ 1 ] + back[ 2 ] * c[ 2 ];

	}

	/** Accumulates a world-space force acting at a world-space point. */
	_addForceAt( fx, fy, fz, px, py, pz ) {

		const c = this._comWorld, f = this._force, t = this._torque;
		const rx = px - c[ 0 ], ry = py - c[ 1 ], rz = pz - c[ 2 ];
		f.x += fx; f.y += fy; f.z += fz;
		t.x += ry * fz - rz * fy;
		t.y += rz * fx - rx * fz;
		t.z += rx * fy - ry * fx;

	}

	/** Full-throttle-curve engine torque at an engine speed and throttle opening (negative = engine braking). */
	_engineTorque( omega, throttle ) {

		const engine = this.config.engine;
		const rpm = omega * RAD_TO_RPM;
		const friction = engine.frictionTorque + engine.frictionPerRpm * Math.max( 0, rpm - engine.idleRpm );
		return throttle * ( tableLookup( engine.torqueCurve, rpm ) + friction ) - friction;

	}

	/** Starts a timed gear change (torque cut, clutch open) toward `gear`. */
	_startShift( gear ) {

		this._targetGear = gear;
		this._shiftTimer = this.config.drivetrain.shiftTime;
		this._shiftCooldown = this.config.drivetrain.shiftCooldown;
		this._clutchLocked = false;

	}

	/** Selects a gear immediately (used at standstill for 1st <-> reverse). */
	_selectGear( gear ) {

		this._gear = this._targetGear = gear;
		this._shiftTimer = 0;
		this._clutchLocked = false;
		this._reverseTimer = 0;

	}

	/** Steering shaping, pedals, gear selection and the driver aids. Uses the tire telemetry of the previous step. */
	_updateControls( input ) {

		const config = this.config, dt = this._dt, assists = this._assists;
		const steering = config.steering, drivetrain = config.drivetrain, engine = config.engine, aid = config.assists;
		const v = this._v, back = this._back, right = this._right;
		const forwardSpeed = - ( v.x * back[ 0 ] + v.y * back[ 1 ] + v.z * back[ 2 ] );
		const lateralSpeed = - ( v.x * right[ 0 ] + v.y * right[ 1 ] + v.z * right[ 2 ] ); // toward the car's left
		const speed = Math.abs( forwardSpeed );

		let throttleIn = saturate( Number( input.throttle ) || 0 );
		let brakeIn = saturate( Number( input.brake ) || 0 );
		const handbrakeIn = saturate( Number( input.handbrake ) || 0 );
		const steerIn = clamp( Number( input.steer ) || 0, - 1, 1 );

		// ── Gear selection ──
		const gearCount = drivetrain.gearRatios.length;
		const rearOmega = 0.5 * ( this._omega[ RL ] + this._omega[ RR ] );
		this._shiftCooldown = Math.max( 0, this._shiftCooldown - dt );
		if ( assists.autoGearbox ) {

			if ( this._gear === 0 && this._shiftTimer <= 0 ) this._selectGear( 1 );

			if ( this._gear > 0 ) {

				// Holding the brake at standstill selects reverse.
				if ( speed < drivetrain.standstillSpeed && brakeIn > 0.1 && throttleIn < 0.1 && handbrakeIn < 0.1 && this._shiftTimer <= 0 ) {

					this._reverseTimer += dt;
					if ( this._reverseTimer >= drivetrain.reverseDelay ) this._selectGear( - 1 );

				} else this._reverseTimer = 0;

			} else if ( throttleIn > 0.1 && forwardSpeed > - drivetrain.standstillSpeed ) {

				// Throttle while reversing brakes first, then selects 1st.
				this._selectGear( 1 );

			}

			if ( this._gear < 0 ) {

				// In reverse the pedals swap roles.
				const swap = throttleIn;
				throttleIn = brakeIn;
				brakeIn = swap;

			} else if ( this._shiftTimer <= 0 && this._shiftCooldown <= 0 && ( this._contact[ RL ] || this._contact[ RR ] ) ) {

				this._autoShift( rearOmega, brakeIn );

			}

		} else if ( this._shiftTimer <= 0 ) {

			if ( input.shiftUp && this._gear < gearCount ) {

				if ( this._gear <= 0 ) this._selectGear( this._gear + 1 ); else this._startShift( this._gear + 1 );

			} else if ( input.shiftDown && this._gear > - 1 ) {

				const target = this._gear - 1;
				if ( target >= 1 ) {

					// Refuse a down-shift that would over-rev the engine.
					if ( Math.abs( rearOmega * this._gearRatio( target ) ) < engine.limiterRpm * RPM_TO_RAD ) this._startShift( target );

				} else if ( target === 0 || forwardSpeed < 2 ) this._selectGear( target );

			}

		}

		// ── Pedals ──
		const throttleTarget = Math.pow( throttleIn, engine.throttleExponent );
		this._throttle += ( throttleTarget - this._throttle ) * ( 1 - Math.exp( - engine.throttleRate * dt ) );
		this._brake += ( brakeIn - this._brake ) * ( 1 - Math.exp( - config.brakes.rate * dt ) );
		if ( throttleTarget === 0 && this._throttle < 1e-3 ) this._throttle = 0;
		if ( brakeIn === 0 && this._brake < 1e-3 ) this._brake = 0;
		this._handbrake = handbrakeIn;
		this._shiftThrottle = Math.max( this._throttle, this._shiftThrottle - 0.45 * dt );

		// ── Steering ──
		let lock = steering.maxAngle;
		const frontPeak = Math.atan( 0.5 * ( this._peakTan[ FL ] + this._peakTan[ FR ] ) ) || config.tires.front.peakSlipAngle;
		if ( assists.steerAssist ) {

			const geometric = Math.atan( config.geometry.wheelbase * steering.lockLatAccel / Math.max( speed * speed, 1 ) );
			lock = Math.min( lock, geometric + steering.lockSlipFactor * frontPeak );

		}

		this._steerLock = lock;

		let rate;
		if ( this._analogSteering ) rate = steering.analogRate;
		else if ( Math.abs( steerIn ) < 0.01 ) rate = steering.returnRate;
		else if ( steerIn * this._steerInput < - 1e-4 ) rate = steering.counterRate;
		else rate = lerp( steering.rateLow, steering.rateHigh, saturate( speed / steering.rateSpeed ) );
		this._steerInput = moveToward( this._steerInput, steerIn, rate * dt );

		// Slip angle of the rear axle (> 0: the rear travels to the left of the heading) against its peak-grip angle.
		let rearSlip = 0;
		const rearPeak = Math.atan( 0.5 * ( this._peakTan[ RL ] + this._peakTan[ RR ] ) ) || config.tires.rear.peakSlipAngle;
		if ( forwardSpeed > 1 ) {

			const w = this._w, up = this._up;
			const yawRate = w.x * up[ 0 ] + w.y * up[ 1 ] + w.z * up[ 2 ];
			rearSlip = Math.atan2( lateralSpeed - yawRate * ( config.geometry.rearAxleZ - this._com[ 2 ] ), forwardSpeed );

		}

		let angle = - this._steerInput * lock;
		if ( assists.steerAssist && forwardSpeed > steering.counterSteerMinSpeed ) {

			// Counter-steer help: once the rear tires slide past their peak, turn the front wheels into the slide.
			const excess = Math.abs( rearSlip ) - steering.counterSteerThreshold * rearPeak;
			if ( excess > 0 ) {

				const fade = smoothstep( steering.counterSteerMinSpeed, steering.counterSteerMinSpeed + 6, forwardSpeed );
				angle += Math.sign( rearSlip ) * Math.min( steering.counterSteerMax, steering.counterSteerGain * excess ) * fade;

			}

		}

		angle = clamp( angle, - steering.maxAngle, steering.maxAngle );
		this._steerAngle = angle;
		this._wheelSteer[ FL ] = this._wheelSteer[ FR ] = angle;
		if ( Math.abs( angle ) > 1e-4 ) {

			// Ackermann: cot( inner / outer ) = cot( mean ) -/+ track / ( 2 * wheelbase ).
			const cot = 1 / Math.tan( angle ), offset = config.geometry.frontTrack / ( 2 * config.geometry.wheelbase );
			this._wheelSteer[ FL ] = lerp( angle, Math.atan( 1 / ( cot - offset ) ), steering.ackermann );
			this._wheelSteer[ FR ] = lerp( angle, Math.atan( 1 / ( cot + offset ) ), steering.ackermann );

		}

		// ── Traction control ──
		// Feed-forward: the drive torque is capped at what the rear tires can transmit next to their lateral force.
		// Feedback: a throttle factor from the drive-wheel slip of the previous step trims the rest.
		const driveSign = this._gear < 0 ? - 1 : 1;
		let tcTarget = 1;
		this._axleTorqueLimit = Infinity;
		if ( assists.tc ) {

			let limit = 0, slip = 0;
			for ( let i = RL; i <= RR; i ++ ) {

				if ( ! this._contact[ i ] ) continue;
				const lateralUse = Math.min( 1, Math.abs( this._fy[ i ] ) / Math.max( 1, this._fyMax[ i ] ) );
				limit += this._radius[ i ] * this._fxMax[ i ] * Math.sqrt( 1 - aid.tcLateralWeight * lateralUse * lateralUse );
				slip = Math.max( slip, driveSign * this._slipRatio[ i ] / this._peakRatio[ i ] );

			}

			this._axleTorqueLimit = limit * aid.tcTorqueFactor;
			const allowed = lerp( aid.tcSlip, aid.tcCorneringSlip, saturate( Math.abs( this._latG ) / aid.tcCorneringG ) );
			tcTarget = saturate( 1 - ( slip - allowed ) / aid.tcBand );

		}

		this._tcScale = moveToward( this._tcScale, tcTarget, ( tcTarget < this._tcScale ? 30 : 6 ) * dt );

		// ── Stability control: when the rear axle slides, cut the throttle and brake the outer front wheel ──
		let stabilityTarget = 0;
		if ( assists.stability && forwardSpeed > aid.stabilityMinSpeed && handbrakeIn < 0.1 && ( this._contact[ RL ] || this._contact[ RR ] ) ) {

			stabilityTarget = saturate( ( Math.abs( rearSlip ) - aid.stabilitySlip * rearPeak ) / aid.stabilityBand );
			this._stabilityWheel = rearSlip < 0 ? FR : FL; // rear sliding right = the car over-rotates to the left

		}

		this._stabilityLevel = moveToward( this._stabilityLevel, stabilityTarget, ( stabilityTarget > this._stabilityLevel ? 12 : 5 ) * dt );

		// ── Brake torques with ABS ──
		const brakes = config.brakes;
		const frontTorque = this._brake * brakes.maxTorque * brakes.frontBias / 2;
		const rearTorque = this._brake * brakes.maxTorque * ( 1 - brakes.frontBias ) / 2;
		let absActive = false;
		for ( let i = 0; i < 4; i ++ ) {

			let target = 1;
			if ( assists.abs && this._brake > 0.02 && this._contact[ i ] && Math.abs( this._vx[ i ] ) > aid.absMinSpeed ) {

				const slip = - Math.sign( this._vx[ i ] ) * this._slipRatio[ i ] / this._peakRatio[ i ];
				target = clamp( 1 - ( slip - aid.absSlip ) / aid.absBand, aid.absMinPressure, 1 );

			}

			this._absScale[ i ] += ( target - this._absScale[ i ] ) * ( target < this._absScale[ i ] ? 0.3 : 0.16 );
			if ( this._absScale[ i ] < 0.9 && this._brake > 0.02 ) absActive = true;
			this._brakeTorque[ i ] = ( i < 2 ? frontTorque : rearTorque ) * this._absScale[ i ];

		}

		this._absActive = absActive;
		this._brakeTorque[ RL ] += this._handbrake * brakes.handbrakeTorque;
		this._brakeTorque[ RR ] += this._handbrake * brakes.handbrakeTorque;
		this._brakeTorque[ this._stabilityWheel ] += this._stabilityLevel * aid.stabilityYawBrake;

		// Throttle that reaches the engine (the shift cut and the limiter are applied in the drivetrain).
		this._appliedThrottle = this._throttle * this._tcScale * ( 1 - aid.stabilityThrottleCut * this._stabilityLevel );

	}

	/** Automatic gearbox: decides up- and down-shifts from the gearbox input speed, the throttle and the driving state. */
	_autoShift( rearOmega, brakeIn ) {

		const drivetrain = this.config.drivetrain, gear = this._gear;
		const ratios = drivetrain.gearRatios;
		const rpm = rearOmega * this._gearRatio( gear ) * RAD_TO_RPM;
		const throttle = this._shiftThrottle;
		let upRpm = lerp( drivetrain.upshiftRpm[ 0 ], drivetrain.upshiftRpm[ 1 ], throttle );
		let downRpm = lerp( drivetrain.downshiftRpm[ 0 ], drivetrain.downshiftRpm[ 1 ], throttle * throttle );
		if ( brakeIn > 0.3 ) downRpm = Math.max( downRpm, drivetrain.brakingDownshiftRpm );
		if ( Math.abs( this._latG ) > drivetrain.corneringHoldG ) {

			// Hold the gear in hard cornering unless the engine would leave its usable band.
			downRpm = Math.min( downRpm, drivetrain.corneringHoldRpm[ 0 ] );
			upRpm = Math.max( upRpm, drivetrain.corneringHoldRpm[ 1 ] );

		}

		if ( gear < ratios.length && rpm > upRpm && brakeIn < 0.1 ) {

			// Not while the drive wheels spin, and only if the next gear will not ask for a down-shift right away.
			const slip = Math.max( this._slipRatio[ RL ], this._slipRatio[ RR ] );
			const nextRpm = rpm * ratios[ gear ] / ratios[ gear - 1 ];
			if ( slip < 0.3 && nextRpm > downRpm + 300 ) this._startShift( gear + 1 );

		} else if ( gear > 1 && rpm < downRpm ) {

			const nextRpm = rpm * ratios[ gear - 2 ] / ratios[ gear - 1 ];
			if ( nextRpm < Math.min( upRpm - 400, 8400 ) ) this._startShift( gear - 1 );

		}

	}

	/** Ground rays, suspension forces and the contact frames / patch velocities of the four wheels. */
	_updateSuspension() {

		const suspension = this.config.suspension, dt = this._dt, physics = this.physics;
		const p = this._p, v = this._v, w = this._w, com = this._comWorld;
		const right = this._right, up = this._up, back = this._back;
		const offsets = suspension.rayOffsets;
		const cp = this._cp, cn = this._cn;

		for ( let i = 0; i < 4; i ++ ) {

			const radius = this._radius[ i ], k = i * 3;
			const lx = this._wheelX[ i ], ly = this._mountY[ i ], lz = this._wheelZ[ i ];
			const mx = p.x + right[ 0 ] * lx + up[ 0 ] * ly + back[ 0 ] * lz;
			const my = p.y + right[ 1 ] * lx + up[ 1 ] * ly + back[ 1 ] * lz;
			const mz = p.z + right[ 2 ] * lx + up[ 2 ] * ly + back[ 2 ] * lz;

			// The wheel rests on the highest ground sample under its round profile.
			let distance = Infinity, surface = Surface.ASPHALT, nx = 0, ny = 1, nz = 0;
			for ( let j = 0; j < offsets.length; j ++ ) {

				const ahead = offsets[ j ] * radius;
				const hit = physics.raycast( mx - back[ 0 ] * ahead, my - back[ 1 ] * ahead, mz - back[ 2 ] * ahead, - up[ 0 ], - up[ 1 ], - up[ 2 ], this._rayLength[ i ] + 0.1, this.body, true );
				if ( hit === null ) continue;
				const n = hit.normal;
				if ( n[ 0 ] * up[ 0 ] + n[ 1 ] * up[ 1 ] + n[ 2 ] * up[ 2 ] < 0.35 ) continue; // a wall, not ground
				let d = hit.distance + radius - Math.sqrt( radius * radius - ahead * ahead );
				const surf = SURFACES[ hit.surface ];
				if ( surf.bump > 0 ) d -= surf.bump * roughness( hit.point[ 0 ], hit.point[ 2 ], surf.bumpFreq );
				if ( d < distance ) {

					distance = d;
					surface = hit.surface;
					nx = n[ 0 ]; ny = n[ 1 ]; nz = n[ 2 ];

				}

			}

			let compression = this._rayLength[ i ] - distance;
			if ( ! ( compression > 0 ) ) {

				this._contact[ i ] = 0;
				this._hadContact[ i ] = 0;
				this._compression[ i ] = 0;
				this._load[ i ] = 0;
				continue;

			}

			compression = Math.min( compression, this._travel[ i ] + 0.04 );
			cp[ k ] = mx - up[ 0 ] * distance; cp[ k + 1 ] = my - up[ 1 ] * distance; cp[ k + 2 ] = mz - up[ 2 ] * distance;
			cn[ k ] = nx; cn[ k + 1 ] = ny; cn[ k + 2 ] = nz;

			// Compression speed: finite difference while in contact, closing speed along the normal on touch-down.
			const rx = cp[ k ] - com[ 0 ], ry = cp[ k + 1 ] - com[ 1 ], rz = cp[ k + 2 ] - com[ 2 ];
			const pvx = v.x + w.y * rz - w.z * ry, pvy = v.y + w.z * rx - w.x * rz, pvz = v.z + w.x * ry - w.y * rx;
			let rate;
			if ( this._hadContact[ i ] ) rate = ( compression - this._compression[ i ] ) / dt;
			else rate = - ( pvx * nx + pvy * ny + pvz * nz ) / Math.max( 0.35, nx * up[ 0 ] + ny * up[ 1 ] + nz * up[ 2 ] );
			rate = clamp( rate, - 8, 8 );

			const axle = this._axleSuspension[ i ];
			let force = this._springRate[ i ] * ( compression - axle.droopTravel ) + this._staticLoad[ i ];
			const damping = rate > 0 ? this._bumpDamping[ i ] : this._reboundDamping[ i ];
			const knee = suspension.damperKneeSpeed, absRate = Math.abs( rate );
			force += damping * Math.sign( rate ) * ( absRate <= knee ? absRate : knee + ( absRate - knee ) * suspension.damperHighSpeedRatio );
			const intoStop = compression - ( this._travel[ i ] - axle.bumpStopLength );
			if ( intoStop > 0 ) force += 0.5 * axle.bumpStopRate * intoStop * intoStop / axle.bumpStopLength;

			this._contact[ i ] = 1;
			this._hadContact[ i ] = 1;
			this._compression[ i ] = compression;
			this._surface[ i ] = surface;
			this._load[ i ] = force;

			// Contact frame: rolling direction and left direction in the ground plane.
			const steer = this._wheelSteer[ i ], cos = Math.cos( steer ), sin = Math.sin( steer );
			let fx = - back[ 0 ] * cos - right[ 0 ] * sin, fy = - back[ 1 ] * cos - right[ 1 ] * sin, fz = - back[ 2 ] * cos - right[ 2 ] * sin;
			const along = fx * nx + fy * ny + fz * nz;
			fx -= along * nx; fy -= along * ny; fz -= along * nz;
			const inv = 1 / Math.max( 1e-6, Math.hypot( fx, fy, fz ) );
			fx *= inv; fy *= inv; fz *= inv;
			const sx = ny * fz - nz * fy, sy = nz * fx - nx * fz, sz = nx * fy - ny * fx; // left = normal x forward
			this._fwd[ k ] = fx; this._fwd[ k + 1 ] = fy; this._fwd[ k + 2 ] = fz;
			this._left[ k ] = sx; this._left[ k + 1 ] = sy; this._left[ k + 2 ] = sz;
			this._vx[ i ] = pvx * fx + pvy * fy + pvz * fz;
			this._vy[ i ] = pvx * sx + pvy * sy + pvz * sz;

		}

		// Anti-roll bars shift load toward the more compressed wheel of an axle; then clamp and apply.
		for ( let axleIndex = 0; axleIndex < 2; axleIndex ++ ) {

			const l = axleIndex * 2, r = l + 1;
			const transfer = this._axleSuspension[ l ].antiRollRate * ( this._compression[ l ] - this._compression[ r ] );
			if ( this._contact[ l ] ) this._load[ l ] += transfer;
			if ( this._contact[ r ] ) this._load[ r ] -= transfer;

		}

		for ( let i = 0; i < 4; i ++ ) {

			if ( ! this._contact[ i ] ) continue;
			const k = i * 3;
			const load = clamp( this._load[ i ], 0, suspension.maxForceFactor * this._staticLoad[ i ] );
			this._load[ i ] = load;
			this._addForceAt( cn[ k ] * load, cn[ k + 1 ] * load, cn[ k + 2 ] * load, cp[ k ], cp[ k + 1 ], cp[ k + 2 ] );

		}

	}

	/** Tire force of wheel i at a slip speed (m/s): fills _fx, _fy, _stiffness, _slipRatio; returns the combined slip. */
	_evaluateTire( i, slipSpeed ) {

		const reference = Math.max( Math.abs( this._vx[ i ] ), this.config.tires.lowSpeed );
		const ratio = slipSpeed / reference;
		const out = this._tire;
		const slip = combinedForce( ratio / this._peakRatio[ i ], this._sy[ i ], this._fxMax[ i ], this._fyMax[ i ], this._shapeB, this._shapeC, this._shapeE, out );
		this._slipRatio[ i ] = ratio;
		this._fx[ i ] = out[ 0 ];
		this._fy[ i ] = out[ 1 ];
		this._stiffness[ i ] = out[ 2 ] / ( this._peakRatio[ i ] * reference );
		return slip;

	}

	/** Tire limits and lateral slip of every wheel, the drivetrain / wheel-speed solve, then the tire forces. */
	_updateTires() {

		const config = this.config, tires = config.tires, dt = this._dt;
		const inertia = tires.wheelInertia;
		const totalLoad = this._load[ FL ] + this._load[ FR ] + this._load[ RL ] + this._load[ RR ];

		// ── Grip limits, peak slips and the lateral relaxation state ──
		for ( let i = 0; i < 4; i ++ ) {

			if ( ! this._contact[ i ] || ! ( this._load[ i ] > 0 ) ) {

				this._deflection[ i ] = 0;
				this._anchor[ i ] = 0;
				this._fx[ i ] = this._fy[ i ] = this._stiffness[ i ] = this._slipSpeed[ i ] = 0;
				this._relief[ i ] = 1;
				this._sy[ i ] = 0;
				this._slipRatio[ i ] = 0;
				this._fxMax[ i ] = this._fyMax[ i ] = 0;
				this._hadTire[ i ] = 0;
				continue;

			}

			const tire = this._axleTire[ i ], surf = SURFACES[ this._surface[ i ] ], load = this._load[ i ];
			const grip = surf.grip * lerp( 1, surf.wetGrip, this._wetness ) * loadGripFactor( load, tire.referenceLoad, tires.loadSensitivity );
			const peakScale = surf.slipPeakScale * ( 1 + tires.peakSlipLoadGain * clamp( load / tire.referenceLoad - 1, - 0.5, 1.5 ) );
			this._fxMax[ i ] = tire.muLong * grip * load;
			this._fyMax[ i ] = tire.muLat * grip * load;
			this._peakRatio[ i ] = tire.peakSlipRatio * peakScale;
			this._peakTan[ i ] = Math.tan( Math.min( 0.6, tire.peakSlipAngle * peakScale ) );

			// d(deflection)/dt = -vy - |vx| * deflection / relaxationLength, integrated implicitly. At standstill this
			// is a spring (static grip); at speed the deflection settles at relaxationLength * tan( slip angle ).
			const absVx = Math.abs( this._vx[ i ] ), length = tire.relaxationLength;
			let deflection = ( this._deflection[ i ] - dt * this._vy[ i ] ) / ( 1 + dt * absVx / length );
			const limit = length * this._peakTan[ i ] * lerp( 1, tires.maxSlipDeflection, smoothstep( 1, 6, absVx ) );
			deflection = clamp( deflection, - limit, limit );
			this._deflection[ i ] = deflection;
			this._sy[ i ] = deflection / ( length * this._peakTan[ i ] );

			// Longitudinal: the force is linearised as stiffness * slip speed (secant). Within the step the wheel
			// speed AND the car respond to it: the car is assumed to keep the acceleration it had over the last
			// step, corrected for the change of this tire's own force acting on its share of the mass. That makes
			// the wheel-speed step an implicit integration of the wheel / body pair: stable at any speed, and free
			// of the lag a frozen body speed would cause under hard acceleration.
			const slipSpeed = this._omega[ i ] * this._radius[ i ] - this._vx[ i ];
			this._evaluateTire( i, slipSpeed );
			const massShare = this._mass * load / totalLoad;
			this._relief[ i ] = 1 / ( 1 + this._stiffness[ i ] * dt / massShare );
			this._slipSpeed[ i ] = slipSpeed;
			if ( this._hadTire[ i ] ) this._slipSpeed[ i ] += dt * this._prevFx[ i ] / massShare - clamp( this._vx[ i ] - this._prevVx[ i ], - 1, 1 );
			this._stiffness[ i ] *= this._relief[ i ];
			this._hadTire[ i ] = 1;
			this._prevVx[ i ] = this._vx[ i ];

		}

		for ( let i = 0; i < 4; i ++ ) this._omegaBefore[ i ] = this._omega[ i ];

		// ── Front wheels: independent implicit spin update ──
		for ( let i = FL; i <= FR; i ++ ) {

			const radius = this._radius[ i ];
			const a = inertia + dt * radius * radius * this._stiffness[ i ];
			this._finishWheel( i, this._omega[ i ] - dt * radius * this._stiffness[ i ] * this._slipSpeed[ i ] / a, a );

		}

		// ── Rear axle with the drivetrain ──
		this._updateDrivetrain();

		// ── Forces at the new wheel speeds ──
		const cp = this._cp, state = this.state;
		for ( let i = 0; i < 4; i ++ ) {

			const wheel = state.wheels[ i ];
			if ( ! this._hadTire[ i ] ) {

				wheel.slip = 0;
				this._prevFx[ i ] = 0;
				continue;

			}

			const k = i * 3, vx = this._vx[ i ], vy = this._vy[ i ], load = this._load[ i ];
			const held = this._locked[ i ] && Math.abs( vx ) < tires.staticSpeed;
			let slip;
			if ( held ) {

				// A braked, stopped wheel: static grip through a stiction spring instead of the slip model.
				slip = combinedForce( 0, this._sy[ i ], this._fxMax[ i ], this._fyMax[ i ], this._shapeB, this._shapeC, this._shapeE, this._tire );
				this._fy[ i ] = this._tire[ 1 ];
				const limit = Math.min( this._fxMax[ i ], this._brakeTorque[ i ] / this._radius[ i ] );
				const stretch = clamp( this._anchor[ i ] + vx * dt, - limit / tires.holdStiffness, limit / tires.holdStiffness );
				this._anchor[ i ] = stretch;
				this._fx[ i ] = clamp( - tires.holdStiffness * stretch - tires.lowSpeedDamping * vx, - limit, limit );
				this._slipRatio[ i ] = 0;

			} else {

				// Slip speed at the end of the step as the linearised wheel / body pair predicts it.
				this._anchor[ i ] = 0;
				slip = this._evaluateTire( i, ( this._slipSpeed[ i ] + this._radius[ i ] * ( this._omega[ i ] - this._omegaBefore[ i ] ) ) * this._relief[ i ] );

			}

			// Extra patch damping near standstill, then keep the total inside the friction ellipse.
			let fx = this._fx[ i ];
			let fy = this._fy[ i ] - tires.lowSpeedDamping * vy * ( 1 - smoothstep( 1, 4, Math.abs( vx ) ) );
			const usage = Math.hypot( fx / Math.max( 1, this._fxMax[ i ] ), fy / Math.max( 1, this._fyMax[ i ] ) );
			if ( usage > 1 ) {

				fx /= usage;
				fy /= usage;

			}

			this._fx[ i ] = this._prevFx[ i ] = fx;
			this._fy[ i ] = fy;
			wheel.slip = slip;

			// Rolling resistance and surface drag act on the body only.
			const surf = SURFACES[ this._surface[ i ] ];
			const bx = fx - surf.rolling * load * clamp( vx * 2, - 1, 1 ) - surf.drag * vx;
			const by = fy - surf.drag * vy;
			const f = this._fwd, l = this._left;
			this._addForceAt( f[ k ] * bx + l[ k ] * by, f[ k + 1 ] * bx + l[ k + 1 ] * by, f[ k + 2 ] * bx + l[ k + 2 ] * by, cp[ k ], cp[ k + 1 ], cp[ k + 2 ] );

		}

	}

	/** Applies the brake to a wheel whose speed without brake would be `omega`; `a` is its effective inertia. */
	_finishWheel( i, omega, a ) {

		const brakeStep = this._dt * this._brakeTorque[ i ] / a;
		if ( brakeStep > 0 && Math.abs( omega ) <= brakeStep ) {

			this._omega[ i ] = 0;
			this._locked[ i ] = 1;

		} else {

			this._omega[ i ] = clamp( omega - Math.sign( omega ) * brakeStep, - 600, 600 );
			this._locked[ i ] = 0;

		}

	}

	/** Engine, clutch, gearbox and limited-slip differential; integrates the rear wheel speeds and the engine speed. */
	_updateDrivetrain() {

		const config = this.config, engine = config.engine, drivetrain = config.drivetrain, dt = this._dt;
		const inertia = config.tires.wheelInertia;
		const idle = engine.idleRpm * RPM_TO_RAD;
		const shifting = this._shiftTimer > 0;
		const ratio = shifting ? 0 : this._gearRatio( this._gear );
		const omegaL = this._omega[ RL ], omegaR = this._omega[ RR ];
		const carrier = 0.5 * ( omegaL + omegaR );
		const inputSpeed = ratio * carrier;

		// Rev limiter with hysteresis.
		if ( this._engineOmega >= engine.limiterRpm * RPM_TO_RAD ) this._limiter = true;
		else if ( this._engineOmega < engine.limiterResumeRpm * RPM_TO_RAD ) this._limiter = false;
		const throttle = shifting || this._limiter ? 0 : this._appliedThrottle;
		this._engineLoad = throttle;
		this._tcActive = false;

		let axleTorque = 0, reflected = 0, tcLimited = false;
		if ( shifting ) {

			// Clutch open: the engine is rev-matched to the next gear while the torque is cut.
			const target = Math.max( idle, Math.abs( this._gearRatio( this._targetGear ) * carrier ) );
			this._engineOmega += ( target - this._engineOmega ) * Math.min( 1, dt / this._shiftTimer );
			this._shiftTimer -= dt;
			if ( this._shiftTimer <= 0 ) {

				this._shiftTimer = 0;
				this._gear = this._targetGear;
				this._clutchLocked = this._gearRatio( this._gear ) * carrier > drivetrain.clutchReleaseRpm * RPM_TO_RAD;

			}

		} else if ( ratio === 0 ) {

			// Neutral: the engine revs freely.
			this._integrateFreeEngine( throttle, 0, Infinity );

		} else {

			if ( this._clutchLocked && inputSpeed < drivetrain.clutchReleaseRpm * RPM_TO_RAD ) this._clutchLocked = false;
			else if ( ! this._clutchLocked && inputSpeed >= this._engineOmega && inputSpeed > drivetrain.clutchReleaseRpm * RPM_TO_RAD * 1.05 ) this._clutchLocked = true;

			// Engine torque the traction control lets through in this gear: what the tires can transmit plus what
			// the engine needs to spin itself up at the rate the car is accelerating.
			const spinUp = this._clutchLocked ? engine.inertia * Math.abs( ratio ) * Math.max( 0, this._longG * Math.sign( ratio ) ) * GRAVITY / this._radius[ RL ] : 0;
			const torqueCap = this._axleTorqueLimit / ( Math.abs( ratio ) * drivetrain.efficiency ) + spinUp;
			let torque;
			if ( this._clutchLocked ) {

				this._engineOmega = inputSpeed;
				torque = Math.min( this._engineTorque( inputSpeed, throttle ), torqueCap );
				axleTorque = torque * ratio * ( torque > 0 ? drivetrain.efficiency : 1 );
				reflected = engine.inertia * ratio * ratio;

			} else {

				// Launch clutch: transmits more the further the engine revs beyond the bite point.
				const bite = lerp( drivetrain.clutchBiteRpm, drivetrain.clutchLaunchRpm, this._throttle ) * RPM_TO_RAD;
				const clutchTorque = Math.min( clamp( drivetrain.clutchGain * ( this._engineOmega - bite ), 0, drivetrain.clutchMaxTorque ) * this._tcScale, torqueCap );
				torque = this._integrateFreeEngine( throttle, clutchTorque, torqueCap );
				axleTorque = clutchTorque * ratio * drivetrain.efficiency;

			}

			tcLimited = torque >= torqueCap && this._throttle > 0.05;
			this._engineLoad = saturate( Math.max( torque, 0 ) / tableLookup( engine.torqueCurve, this._engineOmega * RAD_TO_RPM ) );

		}

		this._tcActive = this._assists.tc && this._throttle > 0.05 && ( tcLimited || this._tcScale < 0.93 );

		// Limited-slip differential as a secant stiffness, so that it can be solved implicitly.
		const differential = drivetrain.differential;
		const difference = omegaR - omegaL;
		const lockTorque = differential.preload + ( axleTorque * Math.sign( ratio ) >= 0 ? differential.powerLock : differential.coastLock ) * Math.abs( axleTorque );
		const coupling = Math.min( differential.viscousRate, lockTorque / Math.max( Math.abs( difference ), 1e-3 ) );

		// Implicit 2 x 2 solve for the two wheel-speed changes (tire forces and coupling linearised).
		const rl = this._radius[ RL ], rr = this._radius[ RR ];
		const a11 = inertia + reflected / 4 + dt * ( rl * rl * this._stiffness[ RL ] + coupling );
		const a22 = inertia + reflected / 4 + dt * ( rr * rr * this._stiffness[ RR ] + coupling );
		const a12 = reflected / 4 - dt * coupling;
		const b1 = dt * ( axleTorque / 2 - rl * this._stiffness[ RL ] * this._slipSpeed[ RL ] + coupling * difference );
		const b2 = dt * ( axleTorque / 2 - rr * this._stiffness[ RR ] * this._slipSpeed[ RR ] - coupling * difference );
		const det = a11 * a22 - a12 * a12;
		this._finishWheel( RL, omegaL + ( b1 * a22 - b2 * a12 ) / det, a11 );
		this._finishWheel( RR, omegaR + ( b2 * a11 - b1 * a12 ) / det, a22 );

		if ( this._clutchLocked && ! shifting && ratio !== 0 ) this._engineOmega = Math.max( 0.5 * idle, ratio * 0.5 * ( this._omega[ RL ] + this._omega[ RR ] ) );

	}

	/**
	 * Integrates the engine speed while it is not locked to the wheels (idle control included; it never stalls).
	 * `torqueCap` limits the combustion torque (traction control). Returns the combustion torque used.
	 */
	_integrateFreeEngine( throttle, clutchTorque, torqueCap ) {

		const engine = this.config.engine;
		const idle = engine.idleRpm * RPM_TO_RAD;
		const idleTorque = Math.max( 0, 4 * ( idle - this._engineOmega ) ) + ( this._engineOmega < idle * 1.15 ? engine.frictionTorque : 0 );
		const torque = Math.min( this._engineTorque( this._engineOmega, throttle ), torqueCap );
		this._engineOmega = clamp( this._engineOmega + this._dt * ( torque + idleTorque - clutchTorque ) / engine.inertia, 0.6 * idle, engine.limiterRpm * RPM_TO_RAD * 1.03 );
		return torque;

	}

	/** Aerodynamic drag at the centre of mass and downforce on the two axles. */
	_applyAero() {

		const aero = this.config.aero, v = this._v, up = this._up, back = this._back, p = this._p, com = this._com;
		const speed = Math.hypot( v.x, v.y, v.z );
		const drag = 0.5 * AIR_DENSITY * aero.dragArea * speed;
		this._force.x -= drag * v.x; this._force.y -= drag * v.y; this._force.z -= drag * v.z;

		const forwardSpeed = v.x * back[ 0 ] + v.y * back[ 1 ] + v.z * back[ 2 ];
		const downforce = 0.5 * AIR_DENSITY * aero.liftArea * forwardSpeed * forwardSpeed;
		for ( let axleIndex = 0; axleIndex < 2; axleIndex ++ ) {

			const share = axleIndex === 0 ? aero.frontDownforceFraction : 1 - aero.frontDownforceFraction;
			const z = this._wheelZ[ axleIndex * 2 ], f = - downforce * share;
			this._addForceAt( up[ 0 ] * f, up[ 1 ] * f, up[ 2 ] * f,
				p.x + up[ 0 ] * com[ 1 ] + back[ 0 ] * z, p.y + up[ 1 ] * com[ 1 ] + back[ 1 ] * z, p.z + up[ 2 ] * com[ 1 ] + back[ 2 ] * z );

		}

	}

	/** Fills `state` from the cached body state and the per-wheel simulation state. */
	_writeState( advance ) {

		const state = this.state, dt = this._dt;
		const p = this._p, q = this._q, v = this._v, w = this._w;
		const right = this._right, up = this._up, back = this._back;

		state.position[ 0 ] = p.x; state.position[ 1 ] = p.y; state.position[ 2 ] = p.z;
		state.quaternion[ 0 ] = q.x; state.quaternion[ 1 ] = q.y; state.quaternion[ 2 ] = q.z; state.quaternion[ 3 ] = q.w;
		state.linearVelocity[ 0 ] = v.x; state.linearVelocity[ 1 ] = v.y; state.linearVelocity[ 2 ] = v.z;
		state.angularVelocity[ 0 ] = w.x; state.angularVelocity[ 1 ] = w.y; state.angularVelocity[ 2 ] = w.z;

		const speed = Math.hypot( v.x, v.y, v.z );
		const forwardSpeed = - ( v.x * back[ 0 ] + v.y * back[ 1 ] + v.z * back[ 2 ] );
		const lateralSpeed = - ( v.x * right[ 0 ] + v.y * right[ 1 ] + v.z * right[ 2 ] );
		state.speed = speed;
		state.forwardSpeed = forwardSpeed;
		state.lateralSpeed = lateralSpeed;
		state.yaw = Math.atan2( back[ 0 ], back[ 2 ] );
		state.yawRate = w.x * up[ 0 ] + w.y * up[ 1 ] + w.z * up[ 2 ];
		state.driftAngle = Math.atan2( lateralSpeed, forwardSpeed ) * smoothstep( 1, 3, speed );

		// Lightly filtered accelerations in the car frame.
		const prev = this._prevVelocity;
		if ( advance ) {

			const ax = ( v.x - prev[ 0 ] ) / dt, ay = ( v.y - prev[ 1 ] ) / dt, az = ( v.z - prev[ 2 ] ) / dt;
			const blend = 1 - Math.exp( - G_FILTER_RATE * dt );
			const longG = - ( ax * back[ 0 ] + ay * back[ 1 ] + az * back[ 2 ] ) / GRAVITY;
			const latG = - ( ax * right[ 0 ] + ay * right[ 1 ] + az * right[ 2 ] ) / GRAVITY;
			this._longG += ( clamp( longG, - 8, 8 ) - this._longG ) * blend;
			this._latG += ( clamp( latG, - 8, 8 ) - this._latG ) * blend;
			this._odometer += speed * dt;
			this.physics.drainImpacts( this.body, state.impacts );

		}

		prev[ 0 ] = v.x; prev[ 1 ] = v.y; prev[ 2 ] = v.z;
		state.longG = this._longG;
		state.latG = this._latG;
		state.odometer = this._odometer;

		state.rpm = this._engineOmega * RAD_TO_RPM;
		state.gear = this._shiftTimer > 0 ? this._targetGear : this._gear;
		state.shifting = this._shiftTimer > 0;
		state.throttle = this._engineLoad;
		state.brake = this._brake;
		state.handbrake = this._handbrake;
		state.steerInput = this._steerInput;
		state.steerAngle = this._steerAngle;
		state.steerLock = this._steerLock;
		state.engineLoad = this._engineLoad;
		state.revLimiter = this._limiter;
		state.tcActive = this._tcActive;
		state.absActive = this._absActive;
		state.upsideDown = up[ 1 ] < 0;

		let onGround = 0;
		for ( let i = 0; i < 4; i ++ ) {

			const wheel = state.wheels[ i ], k = i * 3, contact = this._contact[ i ] === 1;
			if ( contact ) onGround ++;
			const radius = this._radius[ i ];
			const lx = this._wheelX[ i ], lz = this._wheelZ[ i ];
			const ly = this._mountY[ i ] - ( this._rayLength[ i ] - this._compression[ i ] - radius );
			wheel.position[ 0 ] = p.x + right[ 0 ] * lx + up[ 0 ] * ly + back[ 0 ] * lz;
			wheel.position[ 1 ] = p.y + right[ 1 ] * lx + up[ 1 ] * ly + back[ 1 ] * lz;
			wheel.position[ 2 ] = p.z + right[ 2 ] * lx + up[ 2 ] * ly + back[ 2 ] * lz;
			wheel.contact = contact;
			wheel.compression = Math.min( this._compression[ i ], this._travel[ i ] );
			wheel.travel = saturate( this._compression[ i ] / this._travel[ i ] );
			wheel.steer = this._wheelSteer[ i ];
			wheel.angularVelocity = this._omega[ i ];
			if ( advance ) wheel.spin += this._omega[ i ] * dt;
			wheel.load = this._load[ i ];
			if ( contact ) {

				wheel.surface = this._surface[ i ];
				wheel.contactPoint[ 0 ] = this._cp[ k ]; wheel.contactPoint[ 1 ] = this._cp[ k + 1 ]; wheel.contactPoint[ 2 ] = this._cp[ k + 2 ];
				wheel.contactNormal[ 0 ] = this._cn[ k ]; wheel.contactNormal[ 1 ] = this._cn[ k + 1 ]; wheel.contactNormal[ 2 ] = this._cn[ k + 2 ];
				wheel.slipRatio = this._slipRatio[ i ];
				wheel.slipAngle = Math.atan( this._sy[ i ] * this._peakTan[ i ] );
				wheel.longForce = this._fx[ i ];
				wheel.latForce = this._fy[ i ];
				const sliding = Math.hypot( this._omega[ i ] * radius - this._vx[ i ], this._vy[ i ] );
				wheel.skid = saturate( ( wheel.slip - 1.05 ) / 1.3 ) * smoothstep( 0.8, 3.5, sliding ) * saturate( 1.5 * this._load[ i ] / this._staticLoad[ i ] );

			} else {

				wheel.slipRatio = wheel.slipAngle = wheel.slip = wheel.skid = 0;
				wheel.longForce = wheel.latForce = 0;

			}

		}

		state.wheelsOnGround = onGround;
		state.airborne = onGround === 0;

	}

}

/**
 * Convex point cloud of the body shell in body space: a chamfered floor at the ground clearance, the full outline at
 * bumper and belt height, and the roof.
 */
function buildShellHull( g ) {

	const points = [];
	const ring = ( y, halfWidth, frontZ, rearZ ) => {

		points.push( - halfWidth, y, frontZ, halfWidth, y, frontZ, halfWidth, y, rearZ, - halfWidth, y, rearZ );

	};

	const bumper = g.groundClearance + 0.2;
	ring( g.groundClearance, g.bodyHalfWidth - 0.14, g.bodyFrontZ + 0.42, g.bodyRearZ - 0.38 );
	ring( bumper, g.bodyHalfWidth, g.bodyFrontZ, g.bodyRearZ );
	ring( g.beltHeight, g.bodyHalfWidth, g.bodyFrontZ + 0.12, g.bodyRearZ - 0.06 );
	ring( g.roofHeight, g.cabinHalfWidth, g.cabinFrontZ, g.cabinRearZ );
	return new Float32Array( points );

}

/** Deterministic small-scale ground roughness in -1 .. 1 at a world position (two crossed sine waves). */
function roughness( x, z, frequency ) {

	const k = 2 * Math.PI * frequency;
	return 0.5 * ( Math.sin( k * ( x + 0.37 * z ) ) + Math.sin( 1.71 * k * ( z - 0.21 * x ) + 1.3 ) );

}

/** Writes the quaternion of the rotation whose columns are the unit vectors `right`, `up`, `back`. */
function quaternionFromBasis( right, up, back, out ) {

	const m00 = right[ 0 ], m10 = right[ 1 ], m20 = right[ 2 ];
	const m01 = up[ 0 ], m11 = up[ 1 ], m21 = up[ 2 ];
	const m02 = back[ 0 ], m12 = back[ 1 ], m22 = back[ 2 ];
	const trace = m00 + m11 + m22;
	if ( trace > 0 ) {

		const s = 0.5 / Math.sqrt( trace + 1 );
		out.w = 0.25 / s; out.x = ( m21 - m12 ) * s; out.y = ( m02 - m20 ) * s; out.z = ( m10 - m01 ) * s;

	} else if ( m00 > m11 && m00 > m22 ) {

		const s = 2 * Math.sqrt( 1 + m00 - m11 - m22 );
		out.w = ( m21 - m12 ) / s; out.x = 0.25 * s; out.y = ( m01 + m10 ) / s; out.z = ( m02 + m20 ) / s;

	} else if ( m11 > m22 ) {

		const s = 2 * Math.sqrt( 1 + m11 - m00 - m22 );
		out.w = ( m02 - m20 ) / s; out.x = ( m01 + m10 ) / s; out.y = 0.25 * s; out.z = ( m12 + m21 ) / s;

	} else {

		const s = 2 * Math.sqrt( 1 + m22 - m00 - m11 );
		out.w = ( m10 - m01 ) / s; out.x = ( m02 + m20 ) / s; out.y = ( m12 + m21 ) / s; out.z = 0.25 * s;

	}

	return out;

}

/** @returns {VehicleState} */
function createState() {

	const wheels = [];
	for ( let i = 0; i < 4; i ++ ) {

		wheels.push( {
			contact: false, surface: Surface.ASPHALT, position: [ 0, 0, 0 ], contactPoint: [ 0, 0, 0 ], contactNormal: [ 0, 1, 0 ],
			compression: 0, travel: 0, steer: 0, spin: 0, angularVelocity: 0, slipRatio: 0, slipAngle: 0, slip: 0, skid: 0,
			load: 0, longForce: 0, latForce: 0,
		} );

	}

	return {
		position: [ 0, 0, 0 ], quaternion: [ 0, 0, 0, 1 ], linearVelocity: [ 0, 0, 0 ], angularVelocity: [ 0, 0, 0 ],
		speed: 0, forwardSpeed: 0, lateralSpeed: 0, yaw: 0, yawRate: 0, driftAngle: 0,
		rpm: 0, gear: 1, shifting: false, throttle: 0, brake: 0, handbrake: 0, steerInput: 0, steerAngle: 0, steerLock: 0.6,
		engineLoad: 0, revLimiter: false, longG: 0, latG: 0,
		wheels, wheelsOnGround: 0, airborne: false, upsideDown: false, tcActive: false, absActive: false,
		impacts: [], odometer: 0,
	};

}
