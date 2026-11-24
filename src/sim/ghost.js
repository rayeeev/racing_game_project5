// Ghost laps: recording, a compact binary encoding, and smooth playback.
//
// Binary format (little-endian), version 1:
//   header 24 bytes: 'AGH1', uint32 sample count, float32 lap time (s), float32 sample rate (Hz), float32 track length (m),
//                    float32 wheel radius (m)
//   per sample 28 bytes: float32 x, y, z | int16 quaternion x, y, z, w (/32767) | float32 s (unwrapped, 0 .. length)
//                    | uint16 speed (cm/s) | int8 steer (/127 * 0.7 rad) | uint8 flags (bit 7 = braking, bits 0-3 = gear + 1)

import { clamp, cubic, lerp } from '../core/math.js';

const MAGIC = 0x31484741; // 'AGH1'
const HEADER = 24, RECORD = 28;
const STEER_RANGE = 0.7;

/** Sample rate of recordings in Hz. */
export const GHOST_RATE = 20;

/**
 * @typedef {Object} GhostLap
 * @property {number} time         lap time in seconds
 * @property {number} rate         samples per second
 * @property {number} trackLength
 * @property {number} wheelRadius
 * @property {number} count
 * @property {Float32Array} positions    count * 3
 * @property {Float32Array} quaternions  count * 4
 * @property {Float32Array} distances    count: s since the line, unwrapped and non-decreasing
 * @property {Float32Array} speeds       count, m/s
 * @property {Float32Array} steers       count, rad (positive = left)
 * @property {Uint8Array} gears          count, gear + 1 (0 = reverse)
 * @property {Uint8Array} braking        count, 0 / 1
 */

/** Records one lap. Call begin() when the lap starts, sample() every physics step, finish() at the line. */
export class GhostRecorder {

	/**
	 * @param {number} trackLength
	 * @param {number} [wheelRadius]
	 */
	constructor( trackLength, wheelRadius = 0.358 ) {

		this.trackLength = trackLength;
		this.wheelRadius = wheelRadius;
		this._capacity = 0;
		this._grow( GHOST_RATE * 200 );
		this.begin();

	}

	_grow( capacity ) {

		const copy = ( Type, old, stride ) => {

			const next = new Type( capacity * stride );
			if ( old ) next.set( old );
			return next;

		};

		this._pos = copy( Float32Array, this._pos, 3 );
		this._quat = copy( Float32Array, this._quat, 4 );
		this._dist = copy( Float32Array, this._dist, 1 );
		this._speed = copy( Float32Array, this._speed, 1 );
		this._steer = copy( Float32Array, this._steer, 1 );
		this._gear = copy( Uint8Array, this._gear, 1 );
		this._brake = copy( Uint8Array, this._brake, 1 );
		this._capacity = capacity;

	}

	/** Starts a new recording (discarding the previous one). */
	begin() {

		this.count = 0;
		this._last = 0;

	}

	/**
	 * Call every physics step; a sample is stored whenever the next 1 / GHOST_RATE tick has passed.
	 * @param {number} lapTime seconds since the line
	 * @param {import('./types.js').VehicleState} state
	 * @param {number} s track distance of the car
	 */
	sample( lapTime, state, s ) {

		if ( lapTime + 1e-9 < this.count / GHOST_RATE ) return;
		if ( this.count === this._capacity ) this._grow( this._capacity * 2 );
		const i = this.count ++;
		// unwrap s so it only grows (the first samples may read slightly below the line's 0)
		let distance = s;
		if ( i === 0 ) distance = s > this.trackLength / 2 ? s - this.trackLength : s;
		else {

			while ( distance < this._last - this.trackLength / 2 ) distance += this.trackLength;
			distance = Math.max( distance, this._last );

		}

		this._last = distance;
		this._pos.set( state.position, i * 3 );
		this._quat.set( state.quaternion, i * 4 );
		this._dist[ i ] = distance;
		this._speed[ i ] = state.speed;
		this._steer[ i ] = state.steerAngle;
		this._gear[ i ] = clamp( state.gear + 1, 0, 15 );
		this._brake[ i ] = state.brake > 0.05 ? 1 : 0;

	}

	/**
	 * Closes the recording.
	 * @param {number} lapTime final lap time
	 * @returns {GhostLap}
	 */
	finish( lapTime ) {

		const n = this.count;
		return {
			time: lapTime, rate: GHOST_RATE, trackLength: this.trackLength, wheelRadius: this.wheelRadius, count: n,
			positions: this._pos.slice( 0, n * 3 ), quaternions: this._quat.slice( 0, n * 4 ), distances: this._dist.slice( 0, n ),
			speeds: this._speed.slice( 0, n ), steers: this._steer.slice( 0, n ), gears: this._gear.slice( 0, n ), braking: this._brake.slice( 0, n ),
		};

	}

}

/** @param {GhostLap} lap @returns {Uint8Array} */
export function encodeGhost( lap ) {

	const bytes = new Uint8Array( HEADER + lap.count * RECORD );
	const view = new DataView( bytes.buffer );
	view.setUint32( 0, MAGIC, true );
	view.setUint32( 4, lap.count, true );
	view.setFloat32( 8, lap.time, true );
	view.setFloat32( 12, lap.rate, true );
	view.setFloat32( 16, lap.trackLength, true );
	view.setFloat32( 20, lap.wheelRadius, true );
	for ( let i = 0; i < lap.count; i ++ ) {

		const o = HEADER + i * RECORD;
		for ( let k = 0; k < 3; k ++ ) view.setFloat32( o + k * 4, lap.positions[ i * 3 + k ], true );
		for ( let k = 0; k < 4; k ++ ) view.setInt16( o + 12 + k * 2, Math.round( clamp( lap.quaternions[ i * 4 + k ], - 1, 1 ) * 32767 ), true );
		view.setFloat32( o + 20, lap.distances[ i ], true );
		view.setUint16( o + 24, Math.round( clamp( lap.speeds[ i ] * 100, 0, 65535 ) ), true );
		view.setInt8( o + 26, Math.round( clamp( lap.steers[ i ] / STEER_RANGE, - 1, 1 ) * 127 ) );
		view.setUint8( o + 27, ( lap.braking[ i ] ? 0x80 : 0 ) | ( lap.gears[ i ] & 0x0f ) );

	}

	return bytes;

}

/** @param {ArrayBuffer|Uint8Array} data @returns {GhostLap} */
export function decodeGhost( data ) {

	const bytes = data instanceof Uint8Array ? data : new Uint8Array( data );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	if ( bytes.length < HEADER || view.getUint32( 0, true ) !== MAGIC ) throw new Error( 'decodeGhost: not a ghost lap' );
	const count = view.getUint32( 4, true );
	if ( bytes.length < HEADER + count * RECORD ) throw new Error( 'decodeGhost: truncated data' );
	const lap = {
		time: view.getFloat32( 8, true ), rate: view.getFloat32( 12, true ), trackLength: view.getFloat32( 16, true ), wheelRadius: view.getFloat32( 20, true ), count,
		positions: new Float32Array( count * 3 ), quaternions: new Float32Array( count * 4 ), distances: new Float32Array( count ),
		speeds: new Float32Array( count ), steers: new Float32Array( count ), gears: new Uint8Array( count ), braking: new Uint8Array( count ),
	};
	for ( let i = 0; i < count; i ++ ) {

		const o = HEADER + i * RECORD;
		for ( let k = 0; k < 3; k ++ ) lap.positions[ i * 3 + k ] = view.getFloat32( o + k * 4, true );
		for ( let k = 0; k < 4; k ++ ) lap.quaternions[ i * 4 + k ] = view.getInt16( o + 12 + k * 2, true ) / 32767;
		lap.distances[ i ] = view.getFloat32( o + 20, true );
		lap.speeds[ i ] = view.getUint16( o + 24, true ) / 100;
		lap.steers[ i ] = view.getInt8( o + 26 ) / 127 * STEER_RANGE;
		const flags = view.getUint8( o + 27 );
		lap.gears[ i ] = flags & 0x0f;
		lap.braking[ i ] = flags >> 7;

	}

	return lap;

}

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64( bytes ) {

	let binary = '';
	for ( let i = 0; i < bytes.length; i += 0x8000 ) binary += String.fromCharCode.apply( null, bytes.subarray( i, i + 0x8000 ) );
	return btoa( binary );

}

/** @param {string} text @returns {Uint8Array} */
export function fromBase64( text ) {

	const binary = atob( text );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );
	return bytes;

}

/** Plays a GhostLap back with smooth interpolation. */
export class GhostPlayer {

	/** @param {GhostLap} lap */
	constructor( lap ) {

		this.lap = lap;
		/** Lap time of the ghost in seconds. */
		this.duration = lap.time;
		// accumulated wheel rotation per sample
		this._spin = new Float32Array( lap.count );
		for ( let i = 1; i < lap.count; i ++ ) this._spin[ i ] = this._spin[ i - 1 ] + Math.max( 0, lap.distances[ i ] - lap.distances[ i - 1 ] ) / lap.wheelRadius;

	}

	/**
	 * Pose at lap time t (clamped to the recording).
	 * @param {number} t seconds since the ghost crossed the line
	 * @param {{ position: number[], quaternion: number[], steer: number, speed: number, wheelSpin: number, braking: boolean, gear: number, distance: number }} [out]
	 */
	poseAt( t, out = { position: [ 0, 0, 0 ], quaternion: [ 0, 0, 0, 1 ] } ) {

		const lap = this.lap, last = lap.count - 1;
		const f = clamp( t * lap.rate, 0, last );
		const i1 = Math.min( last, Math.floor( f ) ), i2 = Math.min( last, i1 + 1 ), i0 = Math.max( 0, i1 - 1 ), i3 = Math.min( last, i2 + 1 );
		const u = f - i1;
		const p = lap.positions;
		for ( let k = 0; k < 3; k ++ ) out.position[ k ] = cubic( p[ i0 * 3 + k ], p[ i1 * 3 + k ], p[ i2 * 3 + k ], p[ i3 * 3 + k ], u );

		// normalised lerp along the shorter arc (the samples are close together)
		const q = lap.quaternions, a = i1 * 4, b = i2 * 4;
		const sign = q[ a ] * q[ b ] + q[ a + 1 ] * q[ b + 1 ] + q[ a + 2 ] * q[ b + 2 ] + q[ a + 3 ] * q[ b + 3 ] < 0 ? - 1 : 1;
		let len = 0;
		for ( let k = 0; k < 4; k ++ ) {

			out.quaternion[ k ] = lerp( q[ a + k ], sign * q[ b + k ], u );
			len += out.quaternion[ k ] ** 2;

		}

		len = Math.sqrt( len ) || 1;
		for ( let k = 0; k < 4; k ++ ) out.quaternion[ k ] /= len;

		out.steer = lerp( lap.steers[ i1 ], lap.steers[ i2 ], u );
		out.speed = lerp( lap.speeds[ i1 ], lap.speeds[ i2 ], u );
		out.wheelSpin = lerp( this._spin[ i1 ], this._spin[ i2 ], u );
		out.distance = lerp( lap.distances[ i1 ], lap.distances[ i2 ], u );
		out.braking = lap.braking[ i1 ] === 1;
		out.gear = lap.gears[ i1 ] - 1;
		return out;

	}

	/**
	 * Lap time at which the ghost reached distance s after the line (for the live delta: myLapTime - ghost.timeAtS( myS )).
	 * @param {number} s meters since the line, 0 .. trackLength
	 * @returns {number} seconds
	 */
	timeAtS( s ) {

		const d = this.lap.distances, n = this.lap.count;
		if ( s <= d[ 0 ] ) return 0;
		if ( s >= d[ n - 1 ] ) return this.duration;
		let lo = 0, hi = n - 1;
		while ( hi - lo > 1 ) {

			const mid = ( lo + hi ) >> 1;
			if ( d[ mid ] <= s ) lo = mid;
			else hi = mid;

		}

		const span = d[ hi ] - d[ lo ];
		return ( lo + ( span > 1e-6 ? ( s - d[ lo ] ) / span : 0 ) ) / this.lap.rate;

	}

}
