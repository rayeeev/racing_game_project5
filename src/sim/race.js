// Race session logic: rolling start, continuous timed laps, checkpoints, sectors, wrong-way and off-track detection.
// Pure logic on top of a Track and the VehicleState; announces what happens through an Emitter.
//
// Phases: 'grid' (waiting on the rolling-start grid) → start() → 'outlap' (until the line is crossed) → 'lap' (timed laps)
// Events (emitter.on):
//   'phase' { phase }                    'lapStart' { lap }
//   'checkpoint' { index, time }         'sector' { index, time, best, delta }    (delta vs. the best so far, null if none)
//   'lapComplete' { lap, time, valid, sectors, isSessionBest, topSpeed }
//   'wrongWay' { active }                'offTrack' { active }
//   'invalidated' { reason }             'needsReset' { reason }

import { Emitter } from '../core/events.js';
import { loopDelta, mod } from '../core/math.js';

const WRONG_WAY_DELAY = 1.5; // s driving against the direction before the warning
const OFF_TRACK_MARGIN = 3.4; // m beyond the pavement edge at which the whole car has left the shoulder
const GATE_MARGIN = 7; // m beyond the pavement edge within which a checkpoint still counts as passed
const STUCK_DELAY = 4; // s without moving, off the road or upside down, before a reset is suggested

export class RaceSession {

	/**
	 * @param {import('./track.js').Track} track
	 */
	constructor( track ) {

		this.track = track;
		/** Subscribe with events.on( name, fn ). */
		this.events = new Emitter();
		this._proj = {};
		this.reset();

	}

	/** Back to the grid: clears laps and times. */
	reset() {

		/** @type {'grid'|'outlap'|'lap'} */
		this.phase = 'grid';
		/** Current lap number (0 until the line is crossed for the first time). */
		this.lap = 0;
		/** Time of the current lap in seconds. */
		this.lapTime = 0;
		/** @type {number|null} */
		this.lastLap = null;
		/** Best valid lap of this session. @type {number|null} */
		this.bestLap = null;
		/** Sector times of the current lap so far. */
		this.sectorTimes = [ null, null, null ];
		/** Best sector times of this session. */
		this.bestSectors = [ null, null, null ];
		/** Sector the car is in (0..2). */
		this.sector = 0;
		/** False once the current lap cannot count (missed checkpoint, reset, wrong way across the line). */
		this.valid = true;
		this.invalidReason = '';
		/** Track coordinates of the car. */
		this.s = this.track.gridS;
		this.d = 0;
		this.onRoad = true;
		this.wrongWay = false;
		this.offTrack = false;
		/** Highest speed of the current lap in m/s. */
		this.topSpeed = 0;
		this._nextCheckpoint = 1;
		this._lastCheckpoint = 0;
		this._passed = 0;
		this._sectorStart = 0;
		this._hint = undefined;
		this._wrongTimer = 0;
		this._stuckTimer = 0;
		this._resetAsked = false;

	}

	/** Releases the car from the grid (the caller runs the countdown before this). */
	start() {

		if ( this.phase !== 'grid' ) return;
		this.phase = 'outlap';
		this.events.emit( 'phase', { phase: this.phase } );

	}

	/** Tells the session that the car was teleported (reset to track): the lap no longer counts. */
	notifyTeleport( reason = 'reset' ) {

		this._hint = undefined;
		this._wrongTimer = 0;
		this._stuckTimer = 0;
		this._resetAsked = false;
		if ( this.phase === 'lap' ) this._invalidate( reason );

	}

	/**
	 * Where to put the car after a reset: the last checkpoint it passed (the grid before the first lap).
	 * @returns {import('./types.js').SpawnPose}
	 */
	resetPose() {

		const track = this.track;
		if ( this.phase === 'grid' ) return track.spawnPose( track.gridS );
		// never further back than the car's own position would suggest, and not past the car
		const cp = track.checkpoints[ this._lastCheckpoint ];
		const behind = mod( this.s - cp.s, track.length );
		const s = behind < 400 ? cp.s : mod( this.s - 30, track.length );
		return track.spawnPose( s );

	}

	_invalidate( reason ) {

		if ( ! this.valid ) return;
		this.valid = false;
		this.invalidReason = reason;
		this.events.emit( 'invalidated', { reason } );

	}

	_startLap( timeIntoLap ) {

		this.lap ++;
		this.lapTime = timeIntoLap;
		this.sectorTimes = [ null, null, null ];
		this.sector = 0;
		this._sectorStart = 0;
		this.valid = true;
		this.invalidReason = '';
		this.topSpeed = 0;
		this._nextCheckpoint = 1 % this.track.checkpoints.length;
		this._lastCheckpoint = 0;
		this._passed = 1; // the line itself is checkpoint 0
		this.events.emit( 'lapStart', { lap: this.lap } );

	}

	_closeSector( index, time ) {

		const duration = time - this._sectorStart;
		this.sectorTimes[ index ] = duration;
		const best = this.bestSectors[ index ];
		const delta = best === null ? null : duration - best;
		if ( this.valid && ( best === null || duration < best ) ) this.bestSectors[ index ] = duration;
		this._sectorStart = time;
		this.events.emit( 'sector', { index, time: duration, best, delta } );

	}

	/**
	 * Advances the session by one physics step.
	 * @param {import('./types.js').VehicleState} state  telemetry AFTER the step
	 * @param {number} dt
	 */
	update( state, dt ) {

		const track = this.track, length = track.length;
		const previousS = this.s;
		const p = track.project( state.position[ 0 ], state.position[ 2 ], this._hint, this._proj );
		this._hint = p.s;
		this.s = p.s;
		this.d = p.d;
		this.onRoad = p.onRoad;
		const advance = loopDelta( previousS, p.s, length );

		// off track / wrong way / stuck
		const off = Math.abs( p.d ) > p.halfWidth + OFF_TRACK_MARGIN;
		if ( off !== this.offTrack ) {

			this.offTrack = off;
			this.events.emit( 'offTrack', { active: off } );

		}

		if ( this.phase !== 'grid' ) {

			this._wrongTimer = advance < - 0.02 && state.forwardSpeed > 3 ? this._wrongTimer + dt : Math.max( 0, this._wrongTimer - 2 * dt );
			const wrong = this._wrongTimer > WRONG_WAY_DELAY;
			if ( wrong !== this.wrongWay ) {

				this.wrongWay = wrong;
				this.events.emit( 'wrongWay', { active: wrong } );

			}

			const stuck = state.upsideDown || ( state.speed < 0.6 && ( off || state.wheelsOnGround < 2 ) );
			this._stuckTimer = stuck ? this._stuckTimer + dt : 0;
			if ( this._stuckTimer > ( state.upsideDown ? 1.5 : STUCK_DELAY ) && ! this._resetAsked ) {

				this._resetAsked = true;
				this.events.emit( 'needsReset', { reason: state.upsideDown ? 'upsideDown' : 'stuck' } );

			}

			if ( ! stuck ) this._resetAsked = false;

		}

		if ( this.phase === 'grid' ) return;
		if ( this.phase === 'lap' ) {

			this.lapTime += dt;
			if ( state.speed > this.topSpeed ) this.topSpeed = state.speed;

		}

		if ( advance <= 0 ) {

			// backward across the line: the lap cannot count any more
			if ( this.phase === 'lap' && previousS < 40 && p.s > length - 40 ) this._invalidate( 'wrongWay' );
			return;

		}

		// the start / finish line (s wraps from just under `length` to just over 0)
		if ( p.s < previousS && previousS > length - 60 && p.s < 60 ) {

			const fraction = ( length - previousS ) / advance; // share of this step driven before the line
			if ( this.phase === 'outlap' ) {

				this.phase = 'lap';
				this.events.emit( 'phase', { phase: this.phase } );
				this._startLap( dt * ( 1 - fraction ) );

			} else {

				const time = this.lapTime - dt * ( 1 - fraction );
				if ( this._passed < track.checkpoints.length ) this._invalidate( 'missedCheckpoint' );
				this._closeSector( 2, time );
				const valid = this.valid;
				const isSessionBest = valid && ( this.bestLap === null || time < this.bestLap );
				if ( isSessionBest ) this.bestLap = time;
				this.lastLap = time;
				this.events.emit( 'lapComplete', { lap: this.lap, time, valid, sectors: this.sectorTimes.slice(), isSessionBest, topSpeed: this.topSpeed } );
				this._startLap( dt * ( 1 - fraction ) );

			}

			return;

		}

		if ( this.phase !== 'lap' ) return;

		// checkpoints, in order
		const checkpoints = track.checkpoints;
		for ( let guard = 0; guard < 3; guard ++ ) {

			const cp = checkpoints[ this._nextCheckpoint ];
			if ( this._nextCheckpoint === 0 || ! ( previousS < cp.s && p.s >= cp.s ) ) break;
			if ( Math.abs( p.d ) > p.halfWidth + GATE_MARGIN ) this._invalidate( 'cut' );
			else this._passed ++;
			this._lastCheckpoint = this._nextCheckpoint;
			this.events.emit( 'checkpoint', { index: cp.index, time: this.lapTime } );
			this._nextCheckpoint = ( this._nextCheckpoint + 1 ) % checkpoints.length;

		}

		// sector lines (sector k starts at track.sectors[k])
		for ( let k = this.sector + 1; k < 3; k ++ ) {

			const line = track.sectors[ k ];
			if ( previousS < line && p.s >= line ) {

				const fraction = ( line - previousS ) / advance;
				this._closeSector( k - 1, this.lapTime - dt * ( 1 - fraction ) );
				this.sector = k;

			}

		}

	}

}
