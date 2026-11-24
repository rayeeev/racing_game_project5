// Camera rig: every view of the game. Moves ctx.camera once per frame, before any other system runs.
//
// Driving modes ............ 'chase', 'chaseFar', 'bonnet', 'cockpit' (cycled with nextMode; look-back and free look on top)
// Automatic modes .......... 'orbit' (countdown / idle), 'cinematic' (menu attract mode), 'photo' (free fly while frozen)
// Phase → mode ............. menu → cinematic, countdown → orbit easing into the driving mode, drive → driving mode, photo → photo

import * as THREE from 'three/webgpu';
import { angleDelta, clamp, damp, lerp, smoothstep } from '../core/math.js';
import { SURFACES } from '../sim/constants.js';

const DRIVING_MODES = [ 'chase', 'chaseFar', 'bonnet', 'cockpit' ];
const CHASE = { chase: { distance: 5.5, height: 1.55, look: 0.95 }, chaseFar: { distance: 8.2, height: 2.35, look: 1.0 } };
const UP = new THREE.Vector3( 0, 1, 0 );

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createCameraRig( ctx ) {

	const { camera, world, track, settings, input } = ctx;
	const anchors = ctx.systems.car?.getCameraAnchors?.() ?? {
		cockpit: { position: [ - 0.35, 1.05, 0.16 ], lookAt: [ - 0.35, 0.97, - 6 ] },
		bonnet: { position: [ 0, 0.98, - 0.86 ], lookAt: [ 0, 0.86, - 8 ] },
	};

	let drivingMode = DRIVING_MODES.includes( settings.get( 'camera' ) ) ? settings.get( 'camera' ) : 'chase';
	let lookBack = false;
	const offLook = input.actions.on( 'lookBack', ( { active } ) => {

		lookBack = active;

	} );

	// shared scratch
	const forward = new THREE.Vector3(), right = new THREE.Vector3(), carUp = new THREE.Vector3(), target = new THREE.Vector3(), desired = new THREE.Vector3();
	const tmp = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), photoEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );

	// chase state
	let yaw = 0, distance = CHASE.chase.distance, pitchLead = 0, fov = settings.get( 'fov' ), sideShift = 0, snap = true;
	// shake state
	let trauma = 0, shakeTime = 0;
	const offImpact = ctx.events.on( 'car:impact', ( e ) => {

		trauma = Math.min( 1, trauma + clamp( e.impulse / 9000, 0, 0.7 ) );

	} );
	// orbit / cinematic / photo state
	let orbitAngle = 0;
	const shot = { type: '', time: 0, duration: 0, index: 0, position: new THREE.Vector3(), side: 1, fov: 30 };
	const photo = { yaw: 0, pitch: 0, roll: 0, fov: 45, focusDistance: 8, aperture: 0.03, keys: new Set(), dragging: false, initialised: false };
	const proj = {};

	// ── helpers
	function basis( car ) {

		forward.set( 0, 0, - 1 ).applyQuaternion( car.quaternion );
		right.set( 1, 0, 0 ).applyQuaternion( car.quaternion );
		carUp.set( 0, 1, 0 ).applyQuaternion( car.quaternion );

	}

	/** Never below the ground: lift the position to `clearance` above terrain and road. */
	function keepAbove( position, clearance, hintS ) {

		const ground = world.groundAt( position.x, position.z, hintS, proj );
		if ( position.y < ground.y + clearance ) position.y = ground.y + clearance;

	}

	function setFov( value ) {

		if ( Math.abs( camera.fov - value ) > 0.01 ) {

			camera.fov = value;
			camera.updateProjectionMatrix();

		}

	}

	function applyShake( frame, amount ) {

		const strength = settings.get( 'cameraShake' );
		if ( strength <= 0 || amount <= 0 ) return;
		shakeTime += frame.dt * 34;
		const a = amount * strength;
		camera.position.x += a * 0.5 * Math.sin( shakeTime * 1.13 + 0.3 ) * Math.sin( shakeTime * 0.37 );
		camera.position.y += a * Math.sin( shakeTime * 1.71 + 1.1 ) * Math.sin( shakeTime * 0.53 + 2 );
		camera.rotateZ( a * 0.012 * Math.sin( shakeTime * 0.91 ) );

	}

	// ── driving cameras
	function chase( frame, config ) {

		const car = frame.car, state = car.state, dt = frame.dt;
		basis( car );
		const speed = state ? state.speed : 0;
		const carYaw = Math.atan2( - forward.x, - forward.z );
		// follow a blend of where the car points and where it is going: slides stay visible
		let wantYaw = carYaw;
		if ( speed > 4 ) wantYaw += clamp( angleDelta( carYaw, Math.atan2( - car.velocity.x, - car.velocity.z ) ), - 0.6, 0.6 ) * 0.5;
		if ( lookBack ) wantYaw += Math.PI;
		wantYaw += input.look.x * 1.9;

		const wantDistance = config.distance + speed * 0.011 + ( state ? clamp( state.longG, - 1.4, 1 ) * 0.28 : 0 );
		const wantSide = state ? clamp( state.latG, - 1.5, 1.5 ) * 0.22 : 0;
		const wantFov = settings.get( 'fov' ) + 13 * smoothstep( 0, 85, speed );
		if ( snap || car.teleported ) {

			yaw = wantYaw;
			distance = wantDistance;
			sideShift = wantSide;
			pitchLead = forward.y;
			fov = wantFov;

		} else {

			yaw += angleDelta( yaw, wantYaw ) * ( 1 - Math.exp( - ( lookBack ? 14 : 5.2 ) * dt ) );
			distance = damp( distance, wantDistance, 3.5, dt );
			sideShift = damp( sideShift, wantSide, 2.5, dt );
			pitchLead = damp( pitchLead, forward.y, 3, dt );
			fov = damp( fov, wantFov, 2.5, dt );

		}

		const sin = Math.sin( yaw ), cos = Math.cos( yaw );
		// behind the car along the followed heading, raised with the slope of the road
		desired.set( car.position.x + sin * distance, car.position.y + config.height - pitchLead * distance * 0.6 - input.look.y * 1.2, car.position.z + cos * distance );
		keepAbove( desired, 0.55 );
		camera.position.copy( desired );
		// look a little ahead of the car, shifted against lateral g so the car leans into the frame
		target.copy( car.position ).addScaledVector( UP, config.look ).addScaledVector( forward, lookBack ? - 1 : 2.2 + speed * 0.035 ).addScaledVector( right, - sideShift );
		camera.up.copy( UP );
		camera.lookAt( target );
		setFov( fov );

		const rough = state ? SURFACES[ state.wheels[ 0 ].surface ]?.bump ?? 0 : 0;
		applyShake( frame, 0.004 * smoothstep( 20, 90, speed ) + rough * 0.9 * smoothstep( 2, 25, speed ) + trauma * trauma * 0.09 );

	}

	function onboard( frame, anchor, { fovOffset, headLook } ) {

		const car = frame.car, state = car.state;
		basis( car );
		desired.fromArray( anchor.position ).applyQuaternion( car.quaternion ).add( car.position );
		target.fromArray( anchor.lookAt ).applyQuaternion( car.quaternion ).add( car.position );
		const speed = state ? state.speed : 0;
		if ( state && headLook ) {

			// the head leans against the g-forces and the eyes go into the corner
			desired.addScaledVector( right, clamp( state.latG, - 1.5, 1.5 ) * 0.022 ).addScaledVector( forward, clamp( state.longG, - 1.5, 1.2 ) * - 0.03 );
			target.addScaledVector( right, - clamp( state.steerAngle * 14 + state.yawRate * 1.6, - 3.2, 3.2 ) );

		}

		if ( lookBack ) target.copy( desired ).addScaledVector( forward, - 6 ).addScaledVector( carUp, 0.2 );
		camera.position.copy( desired );
		camera.up.copy( carUp );
		camera.lookAt( target );
		const wantFov = settings.get( 'fov' ) + fovOffset + 8 * smoothstep( 0, 85, speed );
		fov = snap || car.teleported ? wantFov : damp( fov, wantFov, 2.5, frame.dt );
		setFov( fov );
		const rough = state ? SURFACES[ state.wheels[ 0 ].surface ]?.bump ?? 0 : 0;
		applyShake( frame, 0.0025 * smoothstep( 15, 90, speed ) + rough * 0.5 * smoothstep( 2, 25, speed ) + trauma * trauma * 0.05 );

	}

	function driving( frame ) {

		if ( drivingMode === 'bonnet' ) onboard( frame, anchors.bonnet, { fovOffset: 2, headLook: false } );
		else if ( drivingMode === 'cockpit' ) onboard( frame, anchors.cockpit, { fovOffset: 6, headLook: true } );
		else chase( frame, CHASE[ drivingMode ] );

	}

	// ── orbit (countdown, parked car)
	function orbit( frame, speed = 0.22 ) {

		const car = frame.car;
		orbitAngle += frame.dt * speed;
		basis( car );
		const carYaw = Math.atan2( - forward.x, - forward.z );
		const a = carYaw + Math.PI * 0.82 + orbitAngle; // start at the front three-quarter view
		desired.set( car.position.x + Math.sin( a ) * 6.6, car.position.y + 1.25 + 0.35 * Math.sin( orbitAngle * 0.7 ), car.position.z + Math.cos( a ) * 6.6 );
		keepAbove( desired, 0.5 );
		camera.position.copy( desired );
		camera.up.copy( UP );
		camera.lookAt( target.copy( car.position ).addScaledVector( UP, 0.62 ) );
		setFov( 38 );

	}

	// ── cinematic director (attract mode)
	function nextShot( frame ) {

		const car = frame.car;
		const s = track.project( car.position.x, car.position.z, undefined, proj ).s;
		const types = [ 'trackside', 'drone', 'trackside', 'lead', 'trackside', 'high' ];
		shot.type = types[ shot.index ++ % types.length ];
		shot.time = 0;
		shot.side = shot.index % 2 ? 1 : - 1;
		const speed = car.state ? Math.max( 15, car.state.speed ) : 30;
		if ( shot.type === 'trackside' ) {

			// a tripod beside the road ahead of the car, long lens
			const ahead = s + speed * 3.2;
			const half = track.halfWidthAt( ahead );
			const p = track.pointAt( ahead, shot.side * ( half + 4 + ( shot.index % 3 ) * 2.5 ) );
			shot.position.set( p[ 0 ], p[ 1 ], p[ 2 ] );
			shot.position.y = world.heightAt( p[ 0 ], p[ 2 ] ) + 1.1 + ( shot.index % 4 ) * 0.5;
			shot.duration = 6.5;
			shot.fov = 24;

		} else if ( shot.type === 'high' ) {

			const ahead = s + speed * 4;
			const p = track.pointAt( ahead, shot.side * 38 );
			shot.position.set( p[ 0 ], Math.max( p[ 1 ], world.heightAt( p[ 0 ], p[ 2 ] ) ) + 26, p[ 2 ] );
			shot.duration = 8;
			shot.fov = 30;

		} else {

			shot.duration = shot.type === 'drone' ? 8 : 6;
			shot.fov = shot.type === 'drone' ? 46 : 40;
			snap = true;

		}

	}

	function cinematic( frame ) {

		const car = frame.car;
		shot.time += frame.dt;
		if ( shot.type === '' || shot.time > shot.duration || car.teleported ) nextShot( frame );
		basis( car );
		if ( shot.type === 'trackside' || shot.type === 'high' ) {

			camera.position.copy( shot.position );
			// cut away once the car is well past the tripod
			if ( tmp.copy( car.position ).sub( shot.position ).dot( forward ) > 45 && shot.time > 2.5 ) shot.time = shot.duration;
			setFov( lerp( shot.fov, shot.fov * 0.8, clamp( shot.time / shot.duration, 0, 1 ) ) );

		} else {

			const back = shot.type === 'drone' ? 11 : - 8.5, height = shot.type === 'drone' ? 5.5 : 0.75, side = shot.type === 'drone' ? 4.5 : 2.2;
			desired.copy( car.position ).addScaledVector( forward, - back ).addScaledVector( right, shot.side * side );
			desired.y = car.position.y + height;
			keepAbove( desired, 0.45 );
			if ( snap ) camera.position.copy( desired );
			else camera.position.lerp( desired, 1 - Math.exp( - 2.2 * frame.dt ) );
			setFov( shot.fov );

		}

		camera.up.copy( UP );
		camera.lookAt( target.copy( car.position ).addScaledVector( UP, 0.6 ) );

	}

	// ── photo mode
	const onKey = ( e ) => {

		if ( ctx.game.phase !== 'photo' ) return;
		if ( e.type === 'keydown' ) photo.keys.add( e.code );
		else photo.keys.delete( e.code );

	};
	const onPointerDown = ( e ) => {

		photo.dragging = ctx.game.phase === 'photo' && e.button === 0;

	};
	const onPointerUp = () => {

		photo.dragging = false;

	};
	const onPointerMove = ( e ) => {

		if ( ! photo.dragging ) return;
		photo.yaw -= e.movementX * 0.0026;
		photo.pitch = clamp( photo.pitch - e.movementY * 0.0026, - 1.45, 1.45 );

	};
	const onWheel = ( e ) => {

		if ( ctx.game.phase === 'photo' ) photo.fov = clamp( photo.fov + Math.sign( e.deltaY ) * 2, 12, 100 );

	};
	window.addEventListener( 'keydown', onKey );
	window.addEventListener( 'keyup', onKey );
	ctx.canvas.addEventListener( 'pointerdown', onPointerDown );
	window.addEventListener( 'pointerup', onPointerUp );
	window.addEventListener( 'pointermove', onPointerMove );
	ctx.canvas.addEventListener( 'wheel', onWheel, { passive: true } );

	function photoMode( frame ) {

		if ( ! photo.initialised ) {

			// start from the current view
			photoEuler.setFromQuaternion( camera.quaternion, 'YXZ' );
			photo.yaw = photoEuler.y;
			photo.pitch = photoEuler.x;
			photo.roll = 0;
			photo.fov = camera.fov;
			photo.keys.clear();
			photo.initialised = true;

		}

		const dt = Math.min( 0.05, frame.realTime - ( photo.lastTime ?? frame.realTime ) );
		photo.lastTime = frame.realTime;
		const k = photo.keys;
		const pace = ( k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' ) ? 14 : 3.5 ) * dt;
		tmpQ.setFromEuler( photoEuler.set( photo.pitch, photo.yaw, photo.roll, 'YXZ' ) );
		forward.set( 0, 0, - 1 ).applyQuaternion( tmpQ );
		right.set( 1, 0, 0 ).applyQuaternion( tmpQ );
		const ahead = ( k.has( 'KeyW' ) || k.has( 'ArrowUp' ) ? 1 : 0 ) - ( k.has( 'KeyS' ) || k.has( 'ArrowDown' ) ? 1 : 0 );
		const strafe = ( k.has( 'KeyD' ) || k.has( 'ArrowRight' ) ? 1 : 0 ) - ( k.has( 'KeyA' ) || k.has( 'ArrowLeft' ) ? 1 : 0 );
		const lift = ( k.has( 'KeyE' ) ? 1 : 0 ) - ( k.has( 'KeyQ' ) ? 1 : 0 );
		camera.position.addScaledVector( forward, ahead * pace ).addScaledVector( right, strafe * pace ).addScaledVector( UP, lift * pace );
		keepAbove( camera.position, 0.25 );
		photo.roll += ( ( k.has( 'BracketRight' ) ? 1 : 0 ) - ( k.has( 'BracketLeft' ) ? 1 : 0 ) ) * dt * 0.6;
		camera.quaternion.copy( tmpQ );
		setFov( photo.fov );
		photo.focusDistance = camera.position.distanceTo( frame.car.position );

	}

	// ── per frame
	const system = {
		/** The active mode. */
		mode: drivingMode,
		/** Driving modes the player can cycle through. */
		modes: DRIVING_MODES,
		/** Set to false to leave the camera alone (debug free camera). */
		enabled: true,
		/** Photo-mode lens state for the post system: { focusDistance (m), aperture, fov }. */
		photo,

		setMode( name ) {

			if ( ! DRIVING_MODES.includes( name ) ) return;
			drivingMode = name;
			settings.set( 'camera', name );
			snap = true;

		},

		nextMode() {

			system.setMode( DRIVING_MODES[ ( DRIVING_MODES.indexOf( drivingMode ) + 1 ) % DRIVING_MODES.length ] );

		},

		/** @param {import('../game/context.js').Frame} frame */
		update( frame ) {

			if ( ! system.enabled ) return;
			trauma = Math.max( 0, trauma - frame.dt * 1.6 );
			const phase = frame.phase;
			if ( phase !== 'photo' ) photo.initialised = false;

			if ( phase === 'photo' ) {

				system.mode = 'photo';
				photoMode( frame );

			} else if ( phase === 'menu' && ! ctx.isHarness ) {

				system.mode = 'cinematic';
				cinematic( frame );

			} else if ( phase === 'countdown' ) {

				// orbit, then settle behind the car during the last second (driven by the HUD countdown)
				const n = frame.hud.countdown;
				if ( n !== null && n <= 1 ) {

					system.mode = drivingMode;
					driving( frame );

				} else {

					system.mode = 'orbit';
					orbit( frame, 0.5 );
					snap = true;
					return;

				}

			} else if ( phase === 'paused' ) {

				// keep the last view

			} else {

				system.mode = drivingMode;
				driving( frame );

			}

			snap = false;

		},

		dispose() {

			offLook();
			offImpact();
			window.removeEventListener( 'keydown', onKey );
			window.removeEventListener( 'keyup', onKey );
			ctx.canvas.removeEventListener( 'pointerdown', onPointerDown );
			window.removeEventListener( 'pointerup', onPointerUp );
			window.removeEventListener( 'pointermove', onPointerMove );
			ctx.canvas.removeEventListener( 'wheel', onWheel );

		},
	};

	return system;

}
