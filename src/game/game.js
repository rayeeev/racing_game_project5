// The Game: boots the renderer, assets, world and simulation, creates the systems, runs the fixed-step loop
// and the session state machine. Contracts: src/game/context.js. Conventions: src/sim/constants.js.

import * as THREE from 'three/webgpu';
import { Emitter } from '../core/events.js';
import { Assets } from '../core/assets.js';
import { Settings } from '../core/settings.js';
import { Records } from '../core/storage.js';
import { Input } from '../core/input.js';
import { clamp } from '../core/math.js';
import { PHYSICS_DT } from '../sim/constants.js';
import { World, fetchReader } from '../sim/world.js';
import { decodePng } from '../core/png.js';
import { uTime, uCarPosition, uCarVelocity } from '../gfx/shared.js';
import { createWorldTextures } from '../gfx/worldTextures.js';

// Lazy loaders for every system module that exists on disk. Globs (instead of literal dynamic imports) let the dev
// harness boot any subset while some systems are still unwritten; the production build bundles whatever is present.
const MODULES = import.meta.glob( [ '../gfx/*.js', '!../gfx/shared.js', '!../gfx/worldTextures.js', '../ui/ui.js', '../audio/audio.js', './sessionController.js' ] );

/** System key → [ module path, factory export name ]. */
const SYSTEM_MODULES = {
	environment: [ '../gfx/environment.js', 'createEnvironment' ],
	terrain: [ '../gfx/terrain.js', 'createTerrain' ],
	road: [ '../gfx/road.js', 'createRoad' ],
	props: [ '../gfx/props.js', 'createProps' ],
	water: [ '../gfx/water.js', 'createWater' ],
	scatter: [ '../gfx/scatter.js', 'createScatter' ],
	grass: [ '../gfx/grass.js', 'createGrass' ],
	car: [ '../gfx/car.js', 'createCar' ],
	ghostCar: [ '../gfx/ghostCar.js', 'createGhostCar' ],
	effects: [ '../gfx/effects.js', 'createEffects' ],
	racingLine: [ '../gfx/racingLine.js', 'createRacingLine' ],
	cameraRig: [ '../gfx/cameraRig.js', 'createCameraRig' ],
	post: [ '../gfx/post.js', 'createPost' ],
	ui: [ '../ui/ui.js', 'createUI' ],
	audio: [ '../audio/audio.js', 'createAudio' ],
};

/** Resolves the factory of a system; null if its module does not exist (the game then runs without that system). */
async function loadSystemFactory( name ) {

	const [ file, exportName ] = SYSTEM_MODULES[ name ];
	const loader = MODULES[ file ];
	if ( ! loader ) return null;
	const factory = ( await loader() )[ exportName ];
	if ( typeof factory !== 'function' ) throw new Error( `${file} does not export ${exportName}()` );
	return factory;

}

/** Systems are created in this order (later ones may use earlier ones through ctx.systems). */
export const CREATE_ORDER = [ 'environment', 'terrain', 'road', 'props', 'water', 'scatter', 'grass', 'car', 'ghostCar', 'effects', 'racingLine', 'cameraRig', 'post', 'audio', 'ui' ];

/** Systems are updated in this order every frame; `post` renders last. */
export const UPDATE_ORDER = [ 'cameraRig', 'environment', 'terrain', 'road', 'props', 'water', 'scatter', 'grass', 'car', 'ghostCar', 'effects', 'racingLine', 'ui', 'audio' ];

const PIXEL_RATIO_CAP = { low: 1, medium: 1.25, high: 1.5, ultra: 2 };
const MAX_STEPS_PER_FRAME = 8;

export class Game {

	/**
	 * @param {Object} options
	 * @param {HTMLCanvasElement} options.canvas
	 * @param {HTMLElement} options.uiRoot
	 * @param {string[]} [options.systems]       system keys to create (default: all)
	 * @param {boolean} [options.simulation]     create the physics simulation (default true)
	 * @param {'menu'|'drive'|'idle'} [options.startPhase]  'menu' = attract mode behind the main menu (default),
	 *                                           'drive' = start a session immediately, 'idle' = car parked on the grid (harness)
	 * @param {boolean} [options.isHarness]
	 * @param {boolean} [options.strict]         true = a failing system aborts the boot (the real game); false = log and continue (harness)
	 * @param {(p: { fraction: number, label: string }) => void} [options.onProgress]
	 * @param {Object} [options.settingsOverride] key → value applied for this run only (not persisted)
	 */
	constructor( options ) {

		this.options = {
			systems: CREATE_ORDER,
			simulation: true,
			startPhase: 'menu',
			isHarness: false,
			strict: true,
			onProgress: null,
			settingsOverride: null,
			...options,
		};

		this.events = new Emitter();
		this.settings = new Settings( this.events );
		if ( this.options.settingsOverride ) {

			for ( const [ key, value ] of Object.entries( this.options.settingsOverride ) ) this.settings.set( key, value, false );

		}

		this.records = new Records();
		this.input = new Input();
		this.assets = new Assets();

		/** @type {string} */
		this.phase = 'boot';
		this.ready = false;
		this.timeScale = 1;

		/** @type {import('./context.js').GameContext|null} */
		this.ctx = null;
		/** @type {import('./sessionController.js').SessionController|null} */
		this.session = null;

		this._systems = {};
		this._updateList = [];
		this._last = 0;
		this._accumulator = 0;
		this._time = 0;
		this._realTime = 0;
		this._teleported = true;
		this._photoPrevPhase = null;
		this._frameMs = 16.7;
		this._frameCount = 0;
		this._resizePending = true;

		this._prevPos = new THREE.Vector3();
		this._prevQuat = new THREE.Quaternion();
		this._currPos = new THREE.Vector3();
		this._currQuat = new THREE.Quaternion();

		/** @type {import('./context.js').Frame} */
		this.frame = {
			dt: 0,
			time: 0,
			realTime: 0,
			alpha: 0,
			paused: false,
			phase: 'boot',
			car: {
				position: new THREE.Vector3(),
				quaternion: new THREE.Quaternion(),
				velocity: new THREE.Vector3(),
				state: null,
				teleported: true,
			},
			ghost: null,
			hud: createHudState(),
			camera: null,
		};

		this._tick = this._tick.bind( this );

	}

	// ───────────────────────────── boot ─────────────────────────────

	async boot() {

		const { canvas, uiRoot } = this.options;
		const progress = ( fraction, label ) => this.options.onProgress?.( { fraction, label } );

		progress( 0.02, 'Starting renderer' );
		const renderer = new THREE.WebGPURenderer( {
			canvas,
			antialias: false,
			reversedDepthBuffer: true,
			powerPreference: 'high-performance',
		} );
		await renderer.init();
		renderer.shadowMap.enabled = true;
		renderer.toneMapping = THREE.AgXToneMapping;

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera( this.settings.get( 'fov' ), 16 / 9, 0.1, 40000 );
		camera.position.set( 0, 60, 120 );
		scene.add( camera );

		const tier = this.settings.get( 'quality' );
		const quality = { tier, pixelRatio: 1, renderScale: this.settings.get( 'renderScale' ) };
		this.assets.maxAnisotropy = { low: 2, medium: 4, high: 8, ultra: 16 }[ tier ] ?? 8;

		progress( 0.05, 'Reading asset indexes' );
		await this.assets.loadIndexes();

		progress( 0.1, 'Loading world' );
		const world = await World.load( fetchReader( '/assets/world/' ), { decodeImage: decodePng } );
		const worldTex = createWorldTextures( world, this.assets );

		/** @type {import('./context.js').GameContext} */
		const ctx = {
			renderer,
			scene,
			camera,
			canvas,
			uiRoot,
			assets: this.assets,
			settings: this.settings,
			records: this.records,
			input: this.input,
			events: this.events,
			quality,
			world,
			track: world.track,
			sim: null,
			worldTex,
			addObstacles: ( list ) => this.session?.sim?.addObstacles?.( list ),
			sky: {
				id: 'dusk',
				sunDirection: new THREE.Vector3( 0.45, 0.6, 0.66 ).normalize(),
				sunColor: new THREE.Color( 1, 1, 1 ),
				hasSun: true,
				wetness: 0,
				night: 0,
				meta: {},
			},
			systems: this._systems,
			game: this,
			isHarness: this.options.isHarness,
		};
		this.ctx = ctx;
		this.frame.camera = camera;
		this._applySize();

		if ( this.options.simulation ) {

			progress( 0.16, 'Building physics' );
			// Loaded on demand so that render-only harness pages do not pull in the simulation stack.
			const loadSession = MODULES[ './sessionController.js' ];
			if ( ! loadSession ) throw new Error( 'src/game/sessionController.js does not exist' );
			const { SessionController } = await loadSession();
			this.session = await SessionController.create( this );
			ctx.sim = this.session.sim;

		}

		// systems
		const names = CREATE_ORDER.filter( ( n ) => this.options.systems.includes( n ) );
		const assetsBefore = this.assets.progress.done;
		this.assets.onProgress = ( { done, total, label } ) => {

			const f = total > assetsBefore ? ( done - assetsBefore ) / ( total - assetsBefore ) : 1;
			this._assetFraction = f;
			this._assetLabel = label;

		};

		for ( let i = 0; i < names.length; i ++ ) {

			const name = names[ i ];
			progress( 0.2 + 0.7 * ( i / names.length ), `Loading ${name}` );
			try {

				const factory = await loadSystemFactory( name );
				if ( ! factory ) {

					console.info( `[game] system "${name}" is not available - skipped` );
					continue;

				}

				this._systems[ name ] = await factory( ctx );

			} catch ( err ) {

				if ( this.options.strict ) throw new Error( `System "${name}" failed to start: ${err?.message ?? err}`, { cause: err } );
				console.error( `[game] system "${name}" failed to start`, err );

			}

		}

		this.assets.onProgress = null;
		this._updateList = UPDATE_ORDER.map( ( n ) => this._systems[ n ] ).filter( ( s ) => s && typeof s.update === 'function' );

		this.session?.onSystemsReady();
		this._bindInputActions();
		this._applySize();

		window.addEventListener( 'resize', () => {

			this._resizePending = true;

		} );
		document.addEventListener( 'visibilitychange', () => {

			if ( document.hidden && this.phase === 'drive' && ! this.options.isHarness ) this.pause();

		} );

		progress( 0.94, 'Compiling shaders' );
		this._snapPose();
		this._buildFrame( 0, 0 );
		await this._warmUp();

		this._last = performance.now();
		renderer.setAnimationLoop( this._tick );

		const start = this.options.startPhase;
		this._setPhase( 'menu' );
		if ( start === 'drive' ) this.startSession( { countdown: false } );
		else if ( start === 'idle' ) this.session?.park();
		else this.session?.startAttract();

		// Let the first frames render behind the loading screen: pipelines compile and textures upload here, not in view.
		await this._waitFrames( this.options.isHarness ? 3 : 24 );

		progress( 1, 'Ready' );
		this.ready = true;
		this.events.emit( 'ready', {} );
		return this;

	}

	// ───────────────────────────── size ─────────────────────────────

	_applySize() {

		const { renderer, camera, canvas, quality } = this.ctx;
		const parent = canvas.parentElement;
		const width = Math.max( 1, parent?.clientWidth || window.innerWidth );
		const height = Math.max( 1, parent?.clientHeight || window.innerHeight );
		const cap = PIXEL_RATIO_CAP[ quality.tier ] ?? 1.5;
		quality.renderScale = clamp( this.settings.get( 'renderScale' ), 0.5, 1 );
		quality.pixelRatio = Math.min( window.devicePixelRatio || 1, cap ) * quality.renderScale;

		renderer.setPixelRatio( quality.pixelRatio );
		renderer.setSize( width, height, false );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();

		for ( const key of Object.keys( this._systems ) ) this._systems[ key ]?.resize?.( width, height, quality.pixelRatio );
		this._resizePending = false;

	}

	// ───────────────────────────── phases / commands (GameApi) ─────────────────────────────

	_setPhase( to ) {

		const from = this.phase;
		if ( from === to ) return;
		this.phase = to;
		this.input.drivingEnabled = to === 'drive';
		this.events.emit( 'phase', { from, to } );

	}

	/** menu → countdown → drive (rolling start from the grid). */
	startSession( { countdown = true } = {} ) {

		if ( ! this.session ) return;
		this.session.beginRace( { countdown } );
		this._teleported = true;
		this._setPhase( countdown ? 'countdown' : 'drive' );

	}

	restartSession() {

		if ( this.phase === 'boot' ) return;
		this.startSession( { countdown: true } );

	}

	quitToMenu() {

		this.session?.startAttract();
		this._teleported = true;
		this._setPhase( 'menu' );

	}

	pause() {

		if ( this.phase === 'drive' || this.phase === 'countdown' ) {

			this._pausedFrom = this.phase;
			this._setPhase( 'paused' );

		}

	}

	resume() {

		if ( this.phase === 'paused' ) this._setPhase( this._pausedFrom ?? 'drive' );

	}

	resetCar() {

		if ( this.phase !== 'drive' || ! this.session ) return;
		this.session.resetCar();
		this._teleported = true;

	}

	/** The time of day is fixed (dusk): switching it rebuilt every shader mid-game. Kept so old callers do not break. */
	async setSky() {}

	setPaint( id ) {

		this.settings.set( 'paint', id );
		this._systems.car?.setPaint?.( id );
		this.events.emit( 'car:paint', { id } );

	}

	setGhostMode( mode ) {

		this.settings.set( 'ghost', mode );
		this.session?.selectGhost( mode );

	}

	setCameraMode( mode ) {

		const rig = this._systems.cameraRig;
		if ( ! rig ) return;
		if ( mode ) rig.setMode?.( mode );
		else rig.nextMode?.();
		this.events.emit( 'camera:mode', { mode: rig.mode } );

	}

	setPhotoMode( on ) {

		if ( on && ( this.phase === 'drive' || this.phase === 'paused' || this.phase === 'menu' ) ) {

			// Leaving photo mode from a running session lands in the pause menu, never straight back at speed.
			if ( this.phase === 'drive' ) this._pausedFrom = 'drive';
			this._photoPrevPhase = this.phase === 'menu' ? 'menu' : 'paused';
			this._setPhase( 'photo' );
			this.events.emit( 'photo', { active: true } );

		} else if ( ! on && this.phase === 'photo' ) {

			this._setPhase( this._photoPrevPhase ?? 'paused' );
			this.events.emit( 'photo', { active: false } );

		}

	}

	setAutopilot( on, skill ) {

		this.session?.setAutopilot( on, skill );

	}

	_bindInputActions() {

		const a = this.input.actions;
		a.on( 'pause', () => {

			if ( this.phase === 'photo' ) this.setPhotoMode( false );
			else if ( this.phase === 'paused' ) this.resume();
			else this.pause();

		} );
		a.on( 'reset', () => this.resetCar() );
		a.on( 'restart', () => {

			if ( this.phase === 'drive' || this.phase === 'paused' ) this.restartSession();

		} );
		a.on( 'camera', () => {

			if ( this.phase === 'drive' || this.phase === 'countdown' ) this.setCameraMode();

		} );
		a.on( 'photo', () => this.setPhotoMode( this.phase !== 'photo' ) );
		a.on( 'mute', () => this.settings.set( 'muted', ! this.settings.get( 'muted' ) ) );

	}

	// ───────────────────────────── loop ─────────────────────────────

	_snapPose() {

		const state = this.session?.vehicle?.state;
		if ( state ) {

			this._currPos.fromArray( state.position );
			this._currQuat.fromArray( state.quaternion );

		} else {

			const pose = this.ctx.track.spawnPose( this.ctx.track.gridS );
			this._currPos.fromArray( pose.position );
			this._currQuat.setFromAxisAngle( THREE.Object3D.DEFAULT_UP, pose.yaw );

		}

		this._prevPos.copy( this._currPos );
		this._prevQuat.copy( this._currQuat );

	}

	_fixedStep() {

		const session = this.session;
		if ( ! session ) return;

		this._prevPos.copy( this._currPos );
		this._prevQuat.copy( this._currQuat );

		const teleported = session.step( this.phase );

		const state = session.vehicle.state;
		this._currPos.fromArray( state.position );
		this._currQuat.fromArray( state.quaternion );

		if ( teleported ) {

			this._prevPos.copy( this._currPos );
			this._prevQuat.copy( this._currQuat );
			this._teleported = true;

		}

	}

	_buildFrame( dt, alpha ) {

		const frame = this.frame;
		const paused = this.phase === 'paused' || this.phase === 'photo' || this.phase === 'boot';
		frame.dt = paused ? 0 : dt;
		frame.time = this._time;
		frame.realTime = this._realTime;
		frame.alpha = alpha;
		frame.paused = paused;
		frame.phase = this.phase;

		const car = frame.car;
		car.position.lerpVectors( this._prevPos, this._currPos, alpha );
		car.quaternion.slerpQuaternions( this._prevQuat, this._currQuat, alpha );
		const state = this.session?.vehicle?.state ?? null;
		car.state = state;
		if ( state ) car.velocity.fromArray( state.linearVelocity );
		else car.velocity.set( 0, 0, 0 );
		car.teleported = this._teleported;

		frame.ghost = this.session ? this.session.ghostPose( alpha ) : null;
		this.session?.fillHud( frame.hud, this );

		uTime.value = this._time;
		uCarPosition.value.copy( car.position );
		uCarVelocity.value.copy( car.velocity );

	}

	_tick() {

		const now = performance.now();
		const rawDt = clamp( ( now - this._last ) / 1000, 0, 0.1 );
		this._last = now;
		this._realTime += rawDt;
		this._frameMs += ( rawDt * 1000 - this._frameMs ) * 0.05;
		this._frameCount ++;

		if ( this._resizePending ) this._applySize();

		this.input.update();

		const simulating = this.phase === 'menu' || this.phase === 'countdown' || this.phase === 'drive';
		const dt = simulating ? rawDt * this.timeScale : 0;

		if ( simulating ) {

			this._time += dt;
			this._accumulator += dt;
			let steps = 0;
			while ( this._accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME ) {

				this._fixedStep();
				this._accumulator -= PHYSICS_DT;
				steps ++;

			}

			if ( steps === MAX_STEPS_PER_FRAME ) this._accumulator = 0; // too slow: drop time instead of spiralling

			const next = this.session?.advancePhase( this.phase, dt );
			if ( next && next !== this.phase ) this._setPhase( next );

		}

		const alpha = this.session ? clamp( this._accumulator / PHYSICS_DT, 0, 1 ) : 0;
		this._buildFrame( dt, simulating ? alpha : 1 );

		const frame = this.frame;
		for ( let i = 0; i < this._updateList.length; i ++ ) this._updateList[ i ].update( frame );
		this.ctx.worldTex.flush();

		const post = this._systems.post;
		if ( post?.render ) post.render( frame );
		else this.ctx.renderer.render( this.ctx.scene, this.ctx.camera );

		this._teleported = false;

	}

	/**
	 * Builds every render pipeline behind the loading screen. Whatever is skipped here (hidden objects, objects outside
	 * the view, empty instance buckets) is compiled on the frame it first appears, and on a cold shader cache that
	 * stalls the game for seconds. So: show everything once, compile, draw one frame, put it all back.
	 */
	async _warmUp() {

		const { scene, camera, renderer } = this.ctx;
		const post = this._systems.post;
		const undo = [];
		try {

			for ( let i = 0; i < this._updateList.length; i ++ ) this._updateList[ i ].update( this.frame );
			this.ctx.worldTex.flush();
			scene.traverse( ( o ) => {

				if ( ! o.visible ) {

					o.visible = true;
					undo.push( () => ( o.visible = false ) );

				}

				if ( o.frustumCulled ) {

					o.frustumCulled = false;
					undo.push( () => ( o.frustumCulled = true ) );

				}

				if ( o.isInstancedMesh && o.count === 0 ) {

					o.count = 1;
					undo.push( () => ( o.count = 0 ) );

				}

			} );

			// the post chain draws the scene into its own targets: the pipelines have to be built for those
			const compiling = post?.compile ? post.compile() : renderer.compileAsync( scene, camera );
			await Promise.race( [ compiling, new Promise( ( resolve ) => setTimeout( resolve, 90000 ) ) ] );
			if ( post?.render ) post.render( this.frame );
			else renderer.render( scene, camera );

		} catch ( err ) {

			console.warn( '[game] shader pre-compilation failed (continuing)', err );

		}

		for ( const restore of undo ) restore();

	}

	/** Resolves after `count` more frames have been rendered (or after 5 s: a hidden tab renders no frames at all). */
	_waitFrames( count ) {

		const target = this._frameCount + count;
		const deadline = performance.now() + 5000;
		return new Promise( ( resolve ) => {

			const check = () => ( this._frameCount >= target || performance.now() > deadline ? resolve() : setTimeout( check, 16 ) );
			check();

		} );

	}

	// ───────────────────────────── diagnostics ─────────────────────────────

	/** Smoothed frame statistics for the debug overlay / automated tests. */
	stats() {

		const info = this.ctx.renderer.info;
		return {
			fps: 1000 / this._frameMs,
			frameMs: this._frameMs,
			frames: this._frameCount,
			drawCalls: info.render?.drawCalls ?? info.render?.calls ?? 0,
			triangles: info.render?.triangles ?? 0,
			geometries: info.memory?.geometries ?? 0,
			textures: info.memory?.textures ?? 0,
			pixelRatio: this.ctx.quality.pixelRatio,
			phase: this.phase,
		};

	}

}

/** @returns {import('./context.js').HudState} */
function createHudState() {

	return {
		speed: 0,
		rpm: 0,
		redline: 9000,
		gear: 0,
		throttle: 0,
		brake: 0,
		steer: 0,
		tcActive: false,
		absActive: false,
		racePhase: 'none',
		lap: 0,
		lapTime: 0,
		lastLap: null,
		bestLap: null,
		record: null,
		delta: null,
		ghostLabel: '',
		sector: 0,
		sectorTimes: [ null, null, null ],
		lapValid: true,
		wrongWay: false,
		offTrack: false,
		countdown: null,
		trackS: 0,
		trackLength: 1,
		carXZ: [ 0, 0 ],
		carYaw: 0,
		ghostXZ: null,
		medals: null,
		medal: null,
		units: 'kmh',
		cameraMode: 'chase',
	};

}
