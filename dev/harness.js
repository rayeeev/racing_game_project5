// Dev harness: boots the real Game with a SUBSET of systems so one system can be developed and screenshotted
// in the real engine context (real renderer settings, world, assets, shared uniforms, frame contract).
//
// Quick use without writing any page:   /dev/sys.html?systems=environment,terrain&s=350&h=2.5&ls=420
// Custom page:
//   <script type="module">
//     import { bootHarness } from '/dev/harness.js';
//     const { game, ctx } = await bootHarness( { systems: [ 'environment', 'terrain', 'road' ] } );
//     // ... poke at ctx.systems.road, add helpers to ctx.scene, etc.
//   </script>
//
// URL parameters (all optional; they override the options passed to bootHarness):
//   systems=a,b,c     system keys to create (see CREATE_ORDER in src/game/game.js); "all" = every system
//   sim=1             create the physics simulation (needed by car / effects / cameraRig / ui / audio); default 0
//   phase=idle|drive|menu   idle = car parked on the grid (default), drive = session running, menu = attract mode
//   autopilot=1       let the AI drive (phase=drive); autopilot=0.9 sets the skill
//   sky=golden|noon|overcast|dusk      quality=low|medium|high|ultra      paint=<id>
//   set.<key>=<value> any other setting from src/core/settings.js (numbers / booleans are parsed)
//   Camera (used when the camera rig is absent, or to override it):
//     cam=x,y,z & look=x,y,z [& fov=50]                     free camera in world coordinates
//     s=350 [& d=0 & h=2.5 & ls=<s+40> & ld=0 & lh=1]       track-relative: stand at track distance s, lateral offset d,
//                                                           h meters above the road, look at (ls, ld) lh meters above the road
//   tp=s[,d[,kmh]]    teleport the car (needs sim=1)
//   wait=2.5          seconds to keep running before window.__ready becomes true (default 1.0 after boot)
//   ui=0              hide the DOM UI
// After boot:  window.__ready === true,  window.__game (debug API, see src/game/debugApi.js),  window.__h = { game, ctx }.
// A boot failure sets window.__ready = true as well and window.__error to the message (so screenshot runs do not hang).

import * as THREE from 'three/webgpu';
import { Game, CREATE_ORDER } from '/src/game/game.js';
import { installDebugApi } from '/src/game/debugApi.js';

function parseValue( v ) {

	if ( v === 'true' ) return true;
	if ( v === 'false' ) return false;
	if ( v !== '' && ! Number.isNaN( Number( v ) ) ) return Number( v );
	return v;

}

const numbers = ( str ) => str.split( ',' ).map( Number );

/** A coarse (8 m) terrain mesh coloured with the ground tint - only a visual stand-in for the real terrain system. */
function createFallbackTerrain( ctx ) {

	const { world, worldTex } = ctx;
	const step = 4;
	const count = Math.floor( ( world.n - 1 ) / step ) + 1;
	const positions = new Float32Array( count * count * 3 );
	const uvs = new Float32Array( count * count * 2 );
	for ( let j = 0; j < count; j ++ ) {

		for ( let i = 0; i < count; i ++ ) {

			const ix = i * step, iz = j * step;
			const k = j * count + i;
			positions[ k * 3 ] = world.minX + ix * world.cell;
			positions[ k * 3 + 1 ] = world.heights[ iz * world.n + ix ];
			positions[ k * 3 + 2 ] = world.minZ + iz * world.cell;
			uvs[ k * 2 ] = ( ix + 0.5 ) / world.n;
			uvs[ k * 2 + 1 ] = ( iz + 0.5 ) / world.n;

		}

	}

	const indices = new Uint32Array( ( count - 1 ) * ( count - 1 ) * 6 );
	let p = 0;
	for ( let j = 0; j < count - 1; j ++ ) {

		for ( let i = 0; i < count - 1; i ++ ) {

			const a = j * count + i, b = a + 1, c = a + count, d = c + 1;
			indices[ p ++ ] = a; indices[ p ++ ] = c; indices[ p ++ ] = b;
			indices[ p ++ ] = b; indices[ p ++ ] = c; indices[ p ++ ] = d;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeVertexNormals();
	const material = new THREE.MeshStandardMaterial( { map: worldTex.groundTint, roughness: 0.95, metalness: 0 } );
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'harness-fallback-terrain';
	mesh.receiveShadow = true;
	return mesh;

}

/**
 * @param {Object} [options]
 * @param {string[]} [options.systems]
 * @param {boolean} [options.simulation]
 * @param {'idle'|'drive'|'menu'} [options.phase]
 * @param {Object} [options.settings]   setting overrides for this run (not persisted)
 * @param {number} [options.wait]       seconds before __ready
 * @returns {Promise<{ game: Game, ctx: import('/src/game/context.js').GameContext, api: Object }>}
 */
export async function bootHarness( options = {} ) {

	const q = new URLSearchParams( location.search );

	document.documentElement.style.cssText = 'margin:0;height:100%;background:#000';
	document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#000';
	const app = document.createElement( 'div' );
	app.style.cssText = 'position:fixed;inset:0';
	const canvas = document.createElement( 'canvas' );
	canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
	const uiRoot = document.createElement( 'div' );
	uiRoot.id = 'ui';
	uiRoot.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
	app.append( canvas, uiRoot );
	document.body.append( app );

	let systems = options.systems ?? [];
	if ( q.has( 'systems' ) ) systems = q.get( 'systems' ) === 'all' ? CREATE_ORDER : q.get( 'systems' ).split( ',' ).filter( Boolean );

	const settings = { ...( options.settings ?? {} ) };
	for ( const key of [ 'sky', 'quality', 'paint' ] ) if ( q.has( key ) ) settings[ key ] = q.get( key );
	for ( const [ key, value ] of q ) if ( key.startsWith( 'set.' ) ) settings[ key.slice( 4 ) ] = parseValue( value );

	const simulation = q.has( 'sim' ) ? q.get( 'sim' ) !== '0' : ( options.simulation ?? false );
	const phase = q.get( 'phase' ) ?? options.phase ?? 'idle';
	const wait = q.has( 'wait' ) ? Number( q.get( 'wait' ) ) : ( options.wait ?? 1.0 );

	const game = new Game( {
		canvas,
		uiRoot,
		systems,
		simulation,
		startPhase: phase,
		isHarness: true,
		strict: false,
		settingsOverride: settings,
	} );
	const api = installDebugApi( game );
	globalThis.__h = { game, get ctx() {

		return game.ctx;

	} };

	try {

		await game.boot();

	} catch ( err ) {

		console.error( '[harness] boot failed', err );
		globalThis.__error = String( err?.stack ?? err );
		globalThis.__ready = true;
		throw err;

	}

	const ctx = game.ctx;

	// Fallback lighting so geometry is visible when the environment system is not part of the run.
	if ( ! ctx.systems.environment ) {

		ctx.scene.background = new THREE.Color( 0x9fb4c8 );
		const hemi = new THREE.HemisphereLight( 0xbfd4ff, 0x54493a, 1.2 );
		const sun = new THREE.DirectionalLight( 0xfff1dc, 3.0 );
		sun.position.copy( ctx.sky.sunDirection ).multiplyScalar( 1000 );
		ctx.scene.add( hemi, sun );
		ctx.renderer.toneMappingExposure = 1;

	}

	// Stand-in ground (8 m grid, flat-tinted) so objects have something to sit on when the terrain system is not part of the run.
	if ( ! ctx.systems.terrain && q.get( 'ground' ) !== '0' ) ctx.scene.add( createFallbackTerrain( ctx ) );

	if ( q.get( 'ui' ) === '0' ) api.showUI( false );

	if ( q.has( 'tp' ) && game.session ) {

		const [ s, d = 0, kmh = 0 ] = numbers( q.get( 'tp' ) );
		api.teleport( s, d, kmh );

	}

	if ( q.has( 'autopilot' ) ) {

		const v = Number( q.get( 'autopilot' ) );
		api.setAutopilot( v > 0, v > 0 && v !== 1 ? v : 1 );

	}

	// camera
	const fov = q.has( 'fov' ) ? Number( q.get( 'fov' ) ) : undefined;
	if ( q.has( 'cam' ) ) {

		api.freeCamera( numbers( q.get( 'cam' ) ), q.has( 'look' ) ? numbers( q.get( 'look' ) ) : [ 0, 0, 0 ], fov );

	} else if ( q.has( 's' ) || ! ctx.systems.cameraRig ) {

		const track = ctx.track;
		const s = q.has( 's' ) ? Number( q.get( 's' ) ) : track.gridS - 12;
		const d = Number( q.get( 'd' ) ?? 0 );
		const h = Number( q.get( 'h' ) ?? 2.2 );
		const ls = q.has( 'ls' ) ? Number( q.get( 'ls' ) ) : s + 40;
		api.trackCamera( s, d, h, ls, Number( q.get( 'ld' ) ?? 0 ), Number( q.get( 'lh' ) ?? 1 ), fov );

	}

	setTimeout( () => {

		globalThis.__ready = true;

	}, wait * 1000 );

	return { game, ctx, api };

}
