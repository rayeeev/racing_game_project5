// The bridge between the Game shell and the simulation: owns the physics session, decides who drives (player, AI,
// nobody), runs the race (countdown, laps, records, medals, ghosts) and fills the HUD state.
// The Game calls step() once per physics step and the query methods once per rendered frame.

import * as THREE from 'three/webgpu';
import { PHYSICS_DT } from '../sim/constants.js';
import { Autopilot } from '../sim/autopilot.js';
import { GhostPlayer, GhostRecorder, decodeGhost, encodeGhost, fromBase64, toBase64 } from '../sim/ghost.js';
import { RaceSession } from '../sim/race.js';
import { createSimulation, vehicleConfigFromCar } from '../sim/session.js';

const COUNTDOWN_SECONDS = 3;
const MEDALS = [ 'gold', 'silver', 'bronze' ];
const HOLD = Object.freeze( { steer: 0, throttle: 0, brake: 1, handbrake: 1, shiftUp: false, shiftDown: false } );
const ATTRACT_SKILL = 0.86;

export class SessionController {

	/**
	 * @param {import('./game.js').Game} game  (game.ctx must exist; ctx.sim is filled by the Game afterwards)
	 * @returns {Promise<SessionController>}
	 */
	static async create( game ) {

		const ctx = game.ctx;
		const config = vehicleConfigFromCar( ctx.assets.index.car );
		const sim = await createSimulation( ctx.world, { wetness: ctx.sky.wetness, vehicleConfig: config } );
		return new SessionController( game, sim, config );

	}

	constructor( game, sim, config ) {

		this.game = game;
		this.ctx = game.ctx;
		/** The simulation ({ physics, vehicle, track, world, dt, step, addObstacles }). */
		this.sim = sim;
		this.vehicle = sim.vehicle;
		this.track = sim.track;
		this.config = config;
		this.race = new RaceSession( sim.track );
		this.recorder = new GhostRecorder( sim.track.length, config.geometry.rearWheelRadius );

		/** 'idle' (parked) | 'attract' (AI drives behind the menu) | 'race' */
		this.mode = 'idle';
		this.autopilotOn = false;
		this.condition = 'dry';
		this._autopilotSkill = 1;
		this._ai = null;
		this._aiKey = '';
		this._countdown = 0;
		this._countdownShown = null;
		this._goFlash = 0;
		this._gear = this.vehicle.state.gear;
		this._flipTimer = 0;
		this._strayTimer = 0;
		this._hint = undefined;
		this._proj = {};

		// ghost
		this.ghostMode = 'off';
		this._ghostPlayer = null;
		this._ghostLabel = '';
		this._ghostCache = new Map();
		this._ghostRequest = 0;
		this._ghostSample = { position: [ 0, 0, 0 ], quaternion: [ 0, 0, 0, 1 ] };
		this._ghostPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), steer: 0, speed: 0, wheelSpin: 0, braking: false, label: '' };

		this._bindRace();

	}

	// ───────────────────────────── setup ─────────────────────────────

	_bindRace() {

		const events = this.ctx.events, race = this.race;
		for ( const name of [ 'lapStart', 'checkpoint', 'sector', 'wrongWay', 'offTrack', 'invalidated' ] ) race.events.on( name, ( e ) => events.emit( 'race:' + name, e ) );
		race.events.on( 'lapStart', () => this.recorder.begin() );
		race.events.on( 'needsReset', ( e ) => {

			if ( this.mode === 'race' && ! this.autopilotOn ) events.emit( 'notify', { text: e.reason === 'upsideDown' ? 'Press R to get back on the road' : 'Stuck? Press R to reset', kind: 'info' } );

		} );
		race.events.on( 'lapComplete', ( e ) => this._onLapComplete( e ) );

	}

	/** Called by the Game once every system exists. */
	onSystemsReady() {

		const settings = this.ctx.settings;
		this._applyAssists();
		this.ctx.events.on( 'settings:change', ( { key } ) => {

			if ( [ 'abs', 'tc', 'stability', 'steerAssist', 'gearbox' ].includes( key ) ) this._applyAssists();

		} );
		this.onSkyChanged();
		this.selectGhost( settings.get( 'ghost' ) );

	}

	_applyAssists() {

		const s = this.ctx.settings;
		this.vehicle.setAssists( { abs: s.get( 'abs' ), tc: s.get( 'tc' ), stability: s.get( 'stability' ), steerAssist: s.get( 'steerAssist' ), autoGearbox: s.get( 'gearbox' ) !== 'manual' } );

	}

	/** Re-reads the weather from ctx.sky (grip, AI lines, records and ghosts depend on it). */
	onSkyChanged() {

		const wetness = this.ctx.sky.wetness ?? 0;
		this.vehicle.setWetness( wetness );
		const condition = wetness > 0.5 ? 'wet' : 'dry';
		if ( condition !== this.condition || this._ghostPlayer === null ) {

			this.condition = condition;
			this.selectGhost( this.ghostMode );

		}

		this._ai = null;

	}

	/** The AI driver for the current mode and weather (built on demand: it takes a few milliseconds). */
	_driver() {

		const skill = this.mode === 'attract' ? ATTRACT_SKILL : this._autopilotSkill;
		const wetness = this.ctx.sky.wetness > 0.5 ? 1 : 0;
		const key = `${skill}|${wetness}`;
		if ( ! this._ai || this._aiKey !== key ) {

			this._ai = new Autopilot( this.track, this.config, { skill, wetness } );
			this._aiKey = key;

		}

		return this._ai;

	}

	// ───────────────────────────── modes ─────────────────────────────

	_place( pose, speed ) {

		this.vehicle.reset( pose, speed );
		this._ai?.reset();
		this._hint = undefined;
		this._gear = this.vehicle.state.gear;
		this._flipTimer = 0;
		this._strayTimer = 0;

	}

	/** Parks the car on the grid (harness 'idle'). */
	park() {

		this.mode = 'idle';
		this.race.reset();
		this._place( this.track.spawnPose( this.track.gridS ), 0 );

	}

	/** The AI cruises around the circuit (menu background). */
	startAttract() {

		this.mode = 'attract';
		this.race.reset();
		this._countdownShown = null;
		const s = this.track.sectors[ 1 ] + 180; // start on the ridge: the best view first
		this._place( this.track.spawnPose( s ), this._driver().speedAt( s ) * 0.9 );

	}

	/** Puts the car on the grid and starts the countdown (or releases it immediately). */
	beginRace( { countdown = true } = {} ) {

		this.mode = 'race';
		this.race.reset();
		this.recorder.begin();
		this._place( this.track.spawnPose( this.track.gridS ), 0 );
		this.ctx.systems.effects?.clear?.();
		this.ctx.events.emit( 'car:reset', { pose: null } );
		if ( countdown ) {

			this._countdown = COUNTDOWN_SECONDS;
			this._countdownShown = null;

		} else {

			this._countdown = 0;
			this._countdownShown = null;
			this.race.start();

		}

	}

	/**
	 * Countdown clock; called by the Game once per frame while simulating.
	 * @returns {string|null} the phase the Game should switch to, or null
	 */
	advancePhase( phase, dt ) {

		if ( this._goFlash > 0 ) {

			this._goFlash -= dt;
			if ( this._goFlash <= 0 ) this._countdownShown = null;

		}

		if ( phase !== 'countdown' ) return null;
		const n = Math.ceil( this._countdown );
		if ( n !== this._countdownShown && n > 0 ) {

			this._countdownShown = n;
			this.ctx.events.emit( 'countdown', { n } );

		}

		this._countdown -= dt;
		if ( this._countdown > 0 ) return null;
		this._countdownShown = 0;
		this._goFlash = 1.2;
		this.ctx.events.emit( 'countdown', { n: 0 } );
		this.race.start();
		return 'drive';

	}

	/** Back onto the road at the last checkpoint (costs the lap). */
	resetCar() {

		const pose = this.mode === 'race' ? this.race.resetPose() : this.track.spawnPose( this._nearestS() );
		this._place( pose, 0 );
		this.race.notifyTeleport();
		this.ctx.events.emit( 'car:reset', { pose } );

	}

	/** Debug / harness: place the car at track distance s, lateral offset d, rolling at `speed` m/s. */
	teleport( s, d = 0, speed = 0 ) {

		this._place( this.track.spawnPose( s, d ), speed );
		this.race.notifyTeleport();

	}

	setAutopilot( on, skill = 1 ) {

		this.autopilotOn = Boolean( on );
		this._autopilotSkill = skill;
		this._ai = null;

	}

	_nearestS() {

		const p = this.vehicle.state.position;
		return this.track.project( p[ 0 ], p[ 2 ], undefined, this._proj ).s;

	}

	// ───────────────────────────── per physics step ─────────────────────────────

	/**
	 * Advances the simulation by one fixed step.
	 * @param {string} phase the Game's phase
	 * @returns {boolean} true if the car was teleported during this step
	 */
	step( phase ) {

		const vehicle = this.vehicle, state = vehicle.state;
		const aiDrives = this.mode === 'attract' || ( this.autopilotOn && phase === 'drive' );
		let input = HOLD;
		if ( aiDrives ) {

			vehicle.setAnalogSteering( true );
			input = this._driver().update( state, PHYSICS_DT );

		} else if ( phase === 'drive' && this.mode === 'race' ) {

			vehicle.setAnalogSteering( this.game.input.analogSteering );
			input = this.game.input.controls;

		}

		this.sim.step( input );

		if ( this.mode === 'race' ) {

			this.race.update( state, PHYSICS_DT );
			if ( this.race.phase === 'lap' ) this.recorder.sample( this.race.lapTime, state, this.race.s );

		}

		// events for audio, effects, camera, rumble
		const events = this.ctx.events;
		for ( let i = 0; i < state.impacts.length; i ++ ) {

			const impact = state.impacts[ i ];
			events.emit( 'car:impact', impact );
			if ( ! aiDrives && impact.impulse > 300 ) this.game.input.rumble( Math.min( 1, impact.impulse / 6000 ), Math.min( 1, impact.impulse / 2500 ), 140 );

		}

		if ( state.gear !== this._gear ) {

			events.emit( 'car:gear', { gear: state.gear, previous: this._gear } );
			this._gear = state.gear;

		}

		return this._rescue( state, aiDrives );

	}

	/** Puts the car back when it has left the world, sunk into the lake, or (AI) lost the road. */
	_rescue( state, aiDrives ) {

		const world = this.ctx.world, p = state.position;
		this._flipTimer = state.upsideDown ? this._flipTimer + PHYSICS_DT : 0;
		const lost = ! world.inBounds( p[ 0 ], p[ 2 ], 30 ) || p[ 1 ] < world.waterLevel - 1.4 || ! Number.isFinite( p[ 1 ] );
		let rescue = lost || this._flipTimer > ( aiDrives ? 1.5 : 4 );
		if ( aiDrives && ! rescue ) {

			const proj = this.track.project( p[ 0 ], p[ 2 ], this._hint, this._proj );
			this._hint = proj.s;
			const stray = Math.abs( proj.d ) > proj.halfWidth + 6 || state.speed < 0.5;
			this._strayTimer = stray ? this._strayTimer + PHYSICS_DT : 0;
			rescue = this._strayTimer > 5;

		}

		if ( ! rescue ) return false;
		if ( lost && ! aiDrives && this.mode === 'race' ) this.ctx.events.emit( 'notify', { text: 'Back on the road', kind: 'info' } );
		this.resetCar();
		return true;

	}

	// ───────────────────────────── laps, records, medals ─────────────────────────────

	/** Medal target times for the current weather, or null if the ghosts were not baked. */
	medals() {

		const set = this.ctx.assets.index.ghosts?.[ this.condition ];
		if ( ! set?.gold ) return null;
		return { bronze: set.bronze.time, silver: set.silver.time, gold: set.gold.time };

	}

	/** Best medal a lap time earns: 'gold' | 'silver' | 'bronze' | null. */
	medalFor( time ) {

		const medals = this.medals();
		if ( ! medals || time === null || time === undefined ) return null;
		for ( const name of MEDALS ) if ( time <= medals[ name ] ) return name;
		return null;

	}

	_onLapComplete( e ) {

		const records = this.ctx.records, events = this.ctx.events;
		const previous = records.get( this.condition );
		const previousMedal = this.medalFor( previous?.time ?? null );
		let isRecord = false;
		// Laps driven by the AI never count as the player's.
		if ( e.valid && ! this.autopilotOn ) {

			const lap = this.recorder.finish( e.time );
			isRecord = records.submit( this.condition, { time: e.time, sectors: e.sectors, date: new Date().toISOString(), ghost: toBase64( encodeGhost( lap ) ) } );
			if ( isRecord ) {

				this._ghostCache.delete( 'best|' + this.condition );
				if ( this.ghostMode === 'best' ) this.selectGhost( 'best' );

			}

		}

		const medal = e.valid ? this.medalFor( e.time ) : null;
		events.emit( 'race:lapComplete', {
			...e,
			isRecord,
			previousRecord: previous?.time ?? null,
			medal,
			newMedal: isRecord && medal !== previousMedal ? medal : null,
		} );

	}

	// ───────────────────────────── ghost ─────────────────────────────

	/**
	 * Chooses the ghost to race against.
	 * @param {string} mode 'off' | 'best' (own record) | 'bronze' | 'silver' | 'gold'
	 */
	selectGhost( mode ) {

		this.ghostMode = mode;
		const request = ++ this._ghostRequest;
		const apply = ( player, label ) => {

			if ( request !== this._ghostRequest ) return; // a newer selection won
			this._ghostPlayer = player;
			this._ghostLabel = player ? label : '';

		};

		if ( mode === 'off' ) return apply( null, '' );
		const key = mode + '|' + this.condition;
		if ( this._ghostCache.has( key ) ) return apply( this._ghostCache.get( key ), mode.toUpperCase() );

		if ( mode === 'best' ) {

			const record = this.ctx.records.get( this.condition );
			let player = null;
			try {

				if ( record?.ghost ) player = new GhostPlayer( decodeGhost( fromBase64( record.ghost ) ) );

			} catch ( err ) {

				console.warn( '[session] stored ghost could not be read', err );

			}

			if ( player ) this._ghostCache.set( key, player );
			return apply( player, 'BEST' );

		}

		const entry = this.ctx.assets.index.ghosts?.[ this.condition ]?.[ mode ];
		if ( ! entry ) return apply( null, '' );
		apply( null, '' );
		this.ctx.assets.arrayBuffer( '/assets/world/' + entry.file ).then( ( buffer ) => {

			const player = new GhostPlayer( decodeGhost( buffer ) );
			this._ghostCache.set( key, player );
			apply( player, mode.toUpperCase() );

		} ).catch( ( err ) => console.warn( '[session] ghost could not be loaded', err ) );

	}

	/**
	 * Pose of the ghost for the frame being rendered, or null when there is nothing to show.
	 * @param {number} alpha physics interpolation factor of the frame
	 * @returns {import('./context.js').GhostPose|null}
	 */
	ghostPose( alpha ) {

		const player = this._ghostPlayer;
		if ( ! player || this.mode !== 'race' || this.race.phase !== 'lap' ) return null;
		const t = this.race.lapTime - ( 1 - alpha ) * PHYSICS_DT;
		if ( t > player.duration + 1.5 ) return null;
		const sample = player.poseAt( t, this._ghostSample ), pose = this._ghostPose;
		pose.position.fromArray( sample.position );
		pose.quaternion.fromArray( sample.quaternion );
		pose.steer = sample.steer;
		pose.speed = sample.speed;
		pose.wheelSpin = sample.wheelSpin;
		pose.braking = sample.braking;
		pose.label = this._ghostLabel;
		return pose;

	}

	// ───────────────────────────── HUD ─────────────────────────────

	/**
	 * Fills the HudState of the frame.
	 * @param {import('./context.js').HudState} hud
	 * @param {import('./game.js').Game} game
	 */
	fillHud( hud, game ) {

		const state = this.vehicle.state, race = this.race, racing = this.mode === 'race';
		hud.speed = state.speed;
		hud.rpm = state.rpm;
		hud.redline = this.config.engine?.limiterRpm ?? this.config.engine?.redline ?? 9000;
		hud.gear = state.gear;
		hud.throttle = state.throttle;
		hud.brake = state.brake;
		hud.steer = state.steerInput;
		hud.tcActive = state.tcActive;
		hud.absActive = state.absActive;
		hud.racePhase = racing ? race.phase : 'none';
		hud.lap = racing ? race.lap : 0;
		hud.lapTime = racing && race.phase === 'lap' ? race.lapTime : 0;
		hud.lastLap = racing ? race.lastLap : null;
		hud.bestLap = racing ? race.bestLap : null;
		const record = this.ctx.records.get( this.condition );
		hud.record = record?.time ?? null;
		hud.sector = race.sector;
		for ( let i = 0; i < 3; i ++ ) hud.sectorTimes[ i ] = racing ? race.sectorTimes[ i ] : null;
		hud.lapValid = race.valid;
		hud.wrongWay = racing && race.wrongWay;
		hud.offTrack = racing && race.offTrack;
		hud.countdown = this._countdownShown;
		hud.trackLength = this.track.length;
		hud.trackS = racing ? race.s : ( this._hint ?? this.track.gridS );
		hud.carXZ[ 0 ] = state.position[ 0 ];
		hud.carXZ[ 1 ] = state.position[ 2 ];
		hud.carYaw = state.yaw;
		hud.medals = this.medals();
		hud.medal = this.medalFor( record?.time ?? null );
		hud.units = this.ctx.settings.get( 'units' );
		hud.cameraMode = this.ctx.systems.cameraRig?.mode ?? '';

		const ghost = game.frame.ghost;
		if ( ghost && racing && race.phase === 'lap' ) {

			hud.delta = race.lapTime - this._ghostPlayer.timeAtS( race.s );
			hud.ghostLabel = this._ghostLabel;
			hud.ghostXZ = hud.ghostXZ ?? [ 0, 0 ];
			hud.ghostXZ[ 0 ] = ghost.position.x;
			hud.ghostXZ[ 1 ] = ghost.position.z;

		} else {

			hud.delta = null;
			hud.ghostLabel = this._ghostPlayer ? this._ghostLabel : '';
			hud.ghostXZ = null;

		}

	}

}
