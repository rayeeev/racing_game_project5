// window.__game - a small automation surface used by the screenshot / smoke tests and handy in the dev console.
// Not used by gameplay code.

import * as THREE from 'three/webgpu';

/**
 * @param {import('./game.js').Game} game
 */
export function installDebugApi( game ) {

	const api = {
		game,
		get ctx() {

			return game.ctx;

		},
		get ready() {

			return game.ready;

		},
		get phase() {

			return game.phase;

		},
		stats: () => game.stats(),
		hud: () => ( { ...game.frame.hud } ),

		start: ( countdown = false ) => game.startSession( { countdown } ),
		menu: () => game.quitToMenu(),
		pause: () => game.pause(),
		resume: () => game.resume(),
		reset: () => game.resetCar(),
		setSky: ( id ) => game.setSky( id ),
		setPaint: ( id ) => game.setPaint( id ),
		setGhost: ( mode ) => game.setGhostMode( mode ),
		setCamera: ( mode ) => game.setCameraMode( mode ),
		setAutopilot: ( on = true, skill = 1 ) => game.setAutopilot( on, skill ),
		setTimeScale: ( s ) => {

			game.timeScale = s;

		},
		setSetting: ( key, value ) => game.settings.set( key, value, false ),

		/** Places the car on the track at distance s (m), lateral offset d (m), with the given speed (km/h). */
		teleport: ( s, d = 0, speedKmh = 0 ) => {

			game.session?.teleport( s, d, speedKmh / 3.6 );
			game._teleported = true;

		},

		/**
		 * Detaches the camera from the rig and places it freely. Pass null to give control back to the camera rig.
		 * @param {number[]|null} position [x,y,z]
		 * @param {number[]} [target] [x,y,z]
		 * @param {number} [fov]
		 */
		freeCamera: ( position, target = [ 0, 0, 0 ], fov ) => {

			const rig = game.ctx.systems.cameraRig;
			if ( position === null ) {

				if ( rig ) rig.enabled = true;
				return;

			}

			if ( rig ) rig.enabled = false;
			const cam = game.ctx.camera;
			cam.position.fromArray( position );
			if ( fov ) cam.fov = fov;
			cam.updateProjectionMatrix();
			cam.lookAt( new THREE.Vector3().fromArray( target ) );

		},

		/** Free camera relative to the track: stands at (s, d) `height` meters above the road and looks at (lookS, lookD, lookHeight). */
		trackCamera: ( s, d, height, lookS, lookD = 0, lookHeight = 1, fov ) => {

			const track = game.ctx.track;
			const p = track.pointAt( s, d );
			const t = track.pointAt( lookS, lookD );
			api.freeCamera( [ p[ 0 ], p[ 1 ] + height, p[ 2 ] ], [ t[ 0 ], t[ 1 ] + lookHeight, t[ 2 ] ], fov );

		},

		/** Shows / hides the whole DOM UI (for clean screenshots). */
		showUI: ( visible ) => {

			game.ctx.uiRoot.style.visibility = visible ? 'visible' : 'hidden';

		},

		/** Resolves after n rendered frames. */
		frames: ( n = 2 ) => new Promise( ( resolve ) => {

			const target = game._frameCount + n;
			const check = () => ( game._frameCount >= target ? resolve( game._frameCount ) : requestAnimationFrame( check ) );
			check();

		} ),
	};

	globalThis.__game = api;
	return api;

}
