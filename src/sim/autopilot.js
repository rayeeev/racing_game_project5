// AI driver. Works on any Track without hand-written corner data:
//   1. a racing line: the lateral offset d(s) that straightens the path inside the pavement (elastic band),
//   2. a speed profile v(s) from the line's curvature with a traction-limited forward pass and a braking-limited
//      backward pass (friction circle, aero drag, power, gradient),
//   3. a controller: pure-pursuit steering toward a preview point on the line, speed tracking with the profile's own
//      acceleration as feed-forward.
// Deterministic. The same class drives the medal ghosts, the attract mode and supplies the data of the racing-line guide.

import { clamp, lerp, mod } from '../core/math.js';
import { AIR_DENSITY, GRAVITY, RL, RR } from './constants.js';

const STEP = 2; // meters between line samples
const MAX_SPEED = 92; // m/s, cap of the profile

export class Autopilot {

	/**
	 * @param {import('./track.js').Track} track
	 * @param {Object} vehicleConfig   the car's configuration (mass, aero, geometry)
	 * @param {Object} [options]
	 * @param {number} [options.skill=1]    about 0.7 (cautious) .. 1.05 (on the limit): scales grip usage, braking and road use
	 * @param {number} [options.wetness=0]  0 dry .. 1 wet
	 */
	constructor( track, vehicleConfig, { skill = 1, wetness = 0 } = {} ) {

		this.track = track;
		this.skill = skill;
		this.wetness = wetness;
		/** Distance between samples of `offsets` / `speeds` in meters (sample i is at s = i * step). */
		this.step = STEP;
		const n = this.count = Math.round( track.length / STEP );
		this._ds = track.length / n;

		this._wheelbase = vehicleConfig.geometry.wheelbase;
		this._mass = vehicleConfig.mass.total;
		this._dragArea = vehicleConfig.aero?.dragArea ?? 0.72;
		const wet = 1 - 0.27 * wetness;
		this._gripUse = 0.955 * skill * wet;
		this._brakeUse = 0.93 * Math.min( skill, 1.02 ) * wet;
		this._tractionUse = 0.9 * Math.min( skill, 1.02 ) * wet;
		this._power = 372000 * clamp( 0.78 + 0.22 * skill, 0.8, 1 ); // W at the wheels, averaged over gear changes

		/** Racing line: lateral offset from the centreline per sample in meters (positive = left). */
		this.offsets = new Float32Array( n );
		/** Target speed per sample in m/s. */
		this.speeds = new Float32Array( n );
		/** Signed curvature of the racing line per sample in 1/m (positive = left). */
		this.curvatures = new Float32Array( n );
		this._px = new Float64Array( n );
		this._pz = new Float64Array( n );
		this._grade = new Float32Array( n );
		this._vertical = new Float32Array( n ); // vertical curvature in 1/m, positive over a crest

		this._buildLine();
		this._buildSpeeds();

		/** Estimated lap time of the profile in seconds. */
		this.estimatedLapTime = 0;
		for ( let i = 0; i < n; i ++ ) this.estimatedLapTime += this._ds / Math.max( 1, 0.5 * ( this.speeds[ i ] + this.speeds[ ( i + 1 ) % n ] ) );

		this._out = { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };
		this._proj = {};
		this._hint = undefined;
		this._stuckTime = 0;
		this._reverseTime = 0;
		this._steer = 0;

	}

	/** Forgets the controller state (call after the car was teleported). */
	reset() {

		this._hint = undefined;
		this._stuckTime = 0;
		this._reverseTime = 0;
		this._steer = 0;

	}

	// ───────────────────────────── racing line ─────────────────────────────

	_buildLine() {

		const track = this.track, n = this.count, ds = this._ds;
		const cx = new Float64Array( n ), cz = new Float64Array( n ), lx = new Float64Array( n ), lz = new Float64Array( n ), limit = new Float64Array( n );
		const frame = {};
		const margin = 1.3 + 1.1 * clamp( 1 - this.skill, 0, 0.4 ); // half a car plus a buffer to the edge
		for ( let i = 0; i < n; i ++ ) {

			track.frameAt( i * ds, frame );
			cx[ i ] = frame.x;
			cz[ i ] = frame.z;
			const len = Math.hypot( frame.lx, frame.lz ) || 1;
			lx[ i ] = frame.lx / len;
			lz[ i ] = frame.lz / len;
			limit[ i ] = Math.max( 0, frame.halfWidth - margin );
			this._grade[ i ] = frame.grade;

		}

		// Vertical curvature (over +-6 m): the car is lighter over crests and heavier through dips.
		for ( let i = 0; i < n; i ++ ) this._vertical[ i ] = - ( this._grade[ ( i + 3 ) % n ] - this._grade[ mod( i - 3, n ) ] ) / ( 6 * ds );

		// Elastic band: every point moves sideways toward the middle of its neighbours, coarse spans first.
		const d = new Float64Array( n );
		const px = this._px, pz = this._pz;
		const place = () => {

			for ( let i = 0; i < n; i ++ ) {

				px[ i ] = cx[ i ] + d[ i ] * lx[ i ];
				pz[ i ] = cz[ i ] + d[ i ] * lz[ i ];

			}

		};

		place();
		for ( const [ span, sweeps ] of [ [ 14, 90 ], [ 8, 110 ], [ 4, 130 ], [ 2, 110 ], [ 1, 70 ] ] ) {

			for ( let it = 0; it < sweeps; it ++ ) {

				for ( let i = 0; i < n; i ++ ) {

					const a = mod( i - span, n ), b = ( i + span ) % n;
					const move = ( 0.5 * ( px[ a ] + px[ b ] ) - px[ i ] ) * lx[ i ] + ( 0.5 * ( pz[ a ] + pz[ b ] ) - pz[ i ] ) * lz[ i ];
					d[ i ] = clamp( d[ i ] + 0.5 * move, - limit[ i ], limit[ i ] );
					px[ i ] = cx[ i ] + d[ i ] * lx[ i ];
					pz[ i ] = cz[ i ] + d[ i ] * lz[ i ];

				}

			}

		}

		// Cautious drivers use less of the road.
		const use = clamp( 0.45 + 0.55 * this.skill, 0.6, 1 );
		for ( let i = 0; i < n; i ++ ) d[ i ] *= use;
		place();

		// Curvature of the line (three-point circle over +-2 samples), lightly smoothed.
		const raw = new Float64Array( n );
		for ( let i = 0; i < n; i ++ ) {

			const a = mod( i - 2, n ), b = ( i + 2 ) % n;
			const ax = px[ i ] - px[ a ], az = pz[ i ] - pz[ a ], bx = px[ b ] - px[ i ], bz = pz[ b ] - pz[ i ];
			const cross = az * bx - ax * bz; // positive = turning left (see the axis conventions)
			const la = Math.hypot( ax, az ), lb = Math.hypot( bx, bz ), lc = Math.hypot( px[ b ] - px[ a ], pz[ b ] - pz[ a ] );
			raw[ i ] = la * lb * lc > 1e-9 ? 2 * cross / ( la * lb * lc ) : 0;

		}

		for ( let i = 0; i < n; i ++ ) {

			this.curvatures[ i ] = 0.25 * raw[ mod( i - 1, n ) ] + 0.5 * raw[ i ] + 0.25 * raw[ ( i + 1 ) % n ];
			this.offsets[ i ] = d[ i ];

		}

	}

	// ───────────────────────────── speed profile ─────────────────────────────

	/** Lateral acceleration the car can hold at speed v (downforce helps), m/s^2. */
	_lateralLimit( v ) {

		return GRAVITY * ( 1.17 + 0.13 * Math.min( 1, ( v / 45 ) ** 2 ) ) * this._gripUse;

	}

	_drag( v ) {

		return ( 0.5 * AIR_DENSITY * this._dragArea * v * v + 0.014 * this._mass * GRAVITY ) / this._mass;

	}

	/** Forward acceleration available at speed v on level ground with no cornering, m/s^2. */
	_accelLimit( v ) {

		return Math.min( 6.3 * this._tractionUse / 0.9, this._power / ( this._mass * Math.max( v, 8 ) ) ) - this._drag( v );

	}

	_buildSpeeds() {

		const n = this.count, ds = this._ds, k = this.curvatures, v = this.speeds, vertical = this._vertical;
		// share of the car's weight on the tires at speed over sample i (crests unload, dips load)
		const load = ( i, speed ) => clamp( 1 - speed * speed * vertical[ i ] / GRAVITY, 0.3, 1.5 );
		for ( let i = 0; i < n; i ++ ) {

			const bend = Math.abs( k[ i ] );
			let vi = MAX_SPEED;
			if ( bend > 1e-5 ) {

				vi = Math.min( MAX_SPEED, Math.sqrt( this._lateralLimit( 30 ) / bend ) );
				for ( let it = 0; it < 4; it ++ ) vi = Math.min( MAX_SPEED, Math.sqrt( this._lateralLimit( vi ) * load( i, vi ) / bend ) );

			}

			v[ i ] = vi;

		}

		// share of the grip left for accelerating / braking while cornering at v with curvature bend
		const spare = ( speed, bend, i ) => Math.sqrt( Math.max( 0, 1 - ( speed * speed * bend / ( this._lateralLimit( speed ) * load( i, speed ) ) ) ** 2 ) );
		for ( let lap = 0; lap < 2; lap ++ ) {

			// forward: traction and power
			for ( let i = 0; i < n; i ++ ) {

				const j = ( i + 1 ) % n;
				const a = this._accelLimit( v[ i ] ) * spare( v[ i ], Math.abs( k[ i ] ), i ) - GRAVITY * this._grade[ i ];
				v[ j ] = Math.min( v[ j ], Math.sqrt( Math.max( 1, v[ i ] * v[ i ] + 2 * a * ds ) ) );

			}

			// backward: braking
			for ( let i = n - 1; i >= 0; i -- ) {

				const j = ( i + 1 ) % n;
				const brake = GRAVITY * ( 1.16 + 0.1 * Math.min( 1, ( v[ j ] / 55 ) ** 2 ) ) * this._brakeUse;
				const a = brake * load( j, v[ j ] ) * ( 0.25 + 0.75 * spare( v[ j ], Math.abs( k[ j ] ), j ) ) + this._drag( v[ j ] ) + GRAVITY * this._grade[ i ];
				v[ i ] = Math.min( v[ i ], Math.sqrt( v[ j ] * v[ j ] + 2 * Math.max( 0.5, a ) * ds ) );

			}

		}

	}

	// ───────────────────────────── lookups ─────────────────────────────

	_sample( array, s ) {

		const f = mod( s, this.track.length ) / this._ds;
		const i = Math.floor( f ) % this.count, j = ( i + 1 ) % this.count;
		return lerp( array[ i ], array[ j ], f - Math.floor( f ) );

	}

	/** Lateral offset of the racing line at s in meters (positive = left). */
	offsetAt( s ) {

		return this._sample( this.offsets, s );

	}

	/** Target speed at s in m/s. */
	speedAt( s ) {

		return this._sample( this.speeds, s );

	}

	// ───────────────────────────── driving ─────────────────────────────

	/**
	 * One control step.
	 * @param {import('./types.js').VehicleState} state
	 * @param {number} dt seconds
	 * @returns {import('./types.js').VehicleInput} a reused object
	 */
	update( state, dt ) {

		const out = this._out, track = this.track;
		const x = state.position[ 0 ], z = state.position[ 2 ];
		const p = track.project( x, z, this._hint, this._proj );
		this._hint = p.s;
		const speed = Math.max( 0, state.forwardSpeed );
		const error = p.d - this.offsetAt( p.s );
		const offRoad = Math.abs( p.d ) > p.halfWidth + 0.6;

		// steering: pure pursuit toward a preview point on the line
		const preview = clamp( 5.5 + 0.3 * speed, 7, 34 );
		const fi = mod( p.s + preview, track.length ) / this._ds;
		const i = Math.floor( fi ) % this.count, j = ( i + 1 ) % this.count, t = fi - Math.floor( fi );
		const tx = lerp( this._px[ i ], this._px[ j ], t ) - x, tz = lerp( this._pz[ i ], this._pz[ j ], t ) - z;
		const sin = Math.sin( state.yaw ), cos = Math.cos( state.yaw );
		const ahead = - tx * sin - tz * cos; // along forward ( -sin, -cos )
		const left = - tx * cos + tz * sin; // along left ( -cos, sin )
		const dist2 = ahead * ahead + left * left;
		let curvature = dist2 > 1 ? 2 * left / dist2 : 0;
		if ( ahead < 0 ) curvature = Math.sign( left || 1 ) * 0.2; // facing the wrong way: turn around
		// road-wheel angle for that curvature (bicycle model + the car's mild understeer)
		const angle = Math.atan( this._wheelbase * curvature ) + 0.015 * speed * speed * curvature / GRAVITY;
		const target = clamp( - angle / Math.max( 0.05, state.steerLock ?? 0.6 ), - 1, 1 );
		this._steer += ( target - this._steer ) * Math.min( 1, 18 * dt );

		// speed: follow the profile, using its own slope as feed-forward
		const lead = p.s + speed * 0.1;
		let want = this.speedAt( lead );
		const planned = ( this.speedAt( lead + this._ds ) ** 2 - want * want ) / ( 2 * this._ds );
		if ( offRoad ) want = Math.min( want, 16 );
		if ( Math.abs( error ) > 2.5 ) want = Math.min( want, Math.max( 12, want - 4 * ( Math.abs( error ) - 2.5 ) ) );
		const command = planned + 2.2 * ( want - speed );

		let throttle = 0, brake = 0;
		if ( command > - 0.7 ) {

			const hold = this._drag( speed ) + GRAVITY * this._sample( this._grade, p.s );
			throttle = clamp( ( Math.max( 0, command ) + hold ) / Math.max( 1.5, this._accelLimit( speed ) + this._drag( speed ) ), 0, 1 );

		} else {

			brake = clamp( - command / ( GRAVITY * 1.2 ), 0, 1 );

		}

		// ease off when the rear steps out
		const rearSlip = Math.max( state.wheels[ RL ].slip, state.wheels[ RR ].slip );
		if ( throttle > 0 && rearSlip > 1.25 ) throttle *= clamp( 2.2 - rearSlip, 0.25, 1 );
		if ( Math.abs( state.driftAngle ) > 0.2 && speed > 12 ) throttle *= 0.4;

		// stuck against something: back out for a moment
		if ( this._reverseTime > 0 ) {

			this._reverseTime -= dt;
			out.steer = - Math.sign( this._steer || 1 );
			out.throttle = 0;
			out.brake = 1; // the automatic gearbox reverses on brake at standstill
			return out;

		}

		this._stuckTime = state.speed < 0.8 && throttle > 0.3 ? this._stuckTime + dt : 0;
		if ( this._stuckTime > 2.5 ) {

			this._stuckTime = 0;
			this._reverseTime = 1.6;

		}

		out.steer = this._steer;
		out.throttle = throttle;
		out.brake = brake;
		return out;

	}

}
