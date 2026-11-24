// Keyboard + gamepad input → driving controls and discrete actions.
//
// Driving controls are polled once per rendered frame (input.update()) and read from input.controls
// (a VehicleInput, see src/sim/types.js). Discrete actions are emitted on input.actions (an Emitter):
//   'pause', 'reset', 'restart', 'camera', 'photo', 'headlights', 'mute', 'hud', 'horn'
//   'lookBack' { active }  (held)
//   'menu' { dir: 'up'|'down'|'left'|'right'|'confirm'|'back' }   keyboard / gamepad menu navigation
//   'any'  the first key / button press of any kind (used to unlock audio and to skip intros)
//
// Bindings
//   throttle  W / ArrowUp        | RT (button 7)        brake      S / ArrowDown   | LT (button 6)
//   steer     A,D / ArrowLeft,Right | left stick X      handbrake  Space           | A (button 0)
//   shift up  E / ShiftRight     | RB (5) / B (1)       shift down Q / ControlLeft | LB (4) / X (2)
//   reset R | restart Backspace | camera C / Y (3) | look back V / right stick click (11) | pause Escape,P / Start (9)
//   photo F | headlights H / D-pad up (12) | mute M | HUD Tab | horn G / left stick click (10) | reset on gamepad: Back (8)

import { Emitter } from './events.js';
import { clamp } from './math.js';

const KEY_ACTIONS = {
	Escape: 'pause',
	KeyP: 'pause',
	KeyR: 'reset',
	Backspace: 'restart',
	KeyC: 'camera',
	KeyF: 'photo',
	KeyH: 'headlights',
	KeyM: 'mute',
	Tab: 'hud',
	KeyG: 'horn',
};

const KEY_MENU = {
	ArrowUp: 'up', KeyW: 'up',
	ArrowDown: 'down', KeyS: 'down',
	ArrowLeft: 'left', KeyA: 'left',
	ArrowRight: 'right', KeyD: 'right',
	Enter: 'confirm', Space: 'confirm',
	Escape: 'back',
};

const PAD_ACTIONS = { 9: 'pause', 8: 'reset', 3: 'camera', 12: 'headlights', 10: 'horn' };
const PAD_MENU = { 12: 'up', 13: 'down', 14: 'left', 15: 'right', 0: 'confirm', 1: 'back' };

const STICK_DEADZONE = 0.08;

export class Input {

	/**
	 * @param {HTMLElement|Window} [target=window]  element that receives keyboard events
	 */
	constructor( target = globalThis.window ) {

		/** Current driving controls (reused object). @type {import('../sim/types.js').VehicleInput} */
		this.controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };

		/** Discrete actions (see the header comment). */
		this.actions = new Emitter();

		/** True while the most recent steering input came from an analog stick. */
		this.analogSteering = false;

		/** Free-look axes from the right stick, -1..1 (0 with keyboard). */
		this.look = { x: 0, y: 0 };

		/** When false, driving controls read as zero (menus, pause) but actions are still emitted. */
		this.drivingEnabled = true;

		this._keys = new Set();
		this._shiftUpQueued = false;
		this._shiftDownQueued = false;
		this._padButtons = [];
		this._padIndex = null;
		this._target = target;

		this._onKeyDown = ( e ) => this._keyDown( e );
		this._onKeyUp = ( e ) => this._keyUp( e );
		this._onBlur = () => this._releaseAll();

		if ( target ) {

			target.addEventListener( 'keydown', this._onKeyDown );
			target.addEventListener( 'keyup', this._onKeyUp );
			globalThis.window?.addEventListener( 'blur', this._onBlur );

		}

	}

	dispose() {

		this._target?.removeEventListener( 'keydown', this._onKeyDown );
		this._target?.removeEventListener( 'keyup', this._onKeyUp );
		globalThis.window?.removeEventListener( 'blur', this._onBlur );

	}

	_isTyping( e ) {

		const el = e.target;
		return el && ( el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable );

	}

	_keyDown( e ) {

		if ( this._isTyping( e ) || e.metaKey || e.altKey ) return;
		const code = e.code;

		// Keep the page from scrolling / moving focus with game keys.
		if ( code.startsWith( 'Arrow' ) || code === 'Space' || code === 'Tab' || code === 'Backspace' ) e.preventDefault();

		if ( e.repeat ) return;
		if ( this._keys.size === 0 ) this.actions.emit( 'any' );
		this._keys.add( code );

		if ( code === 'KeyE' || code === 'ShiftRight' ) this._shiftUpQueued = true;
		if ( code === 'KeyQ' || code === 'ControlLeft' ) this._shiftDownQueued = true;
		if ( code === 'KeyV' ) this.actions.emit( 'lookBack', { active: true } );

		const action = KEY_ACTIONS[ code ];
		if ( action ) this.actions.emit( action );
		const dir = KEY_MENU[ code ];
		if ( dir ) this.actions.emit( 'menu', { dir } );

	}

	_keyUp( e ) {

		this._keys.delete( e.code );
		if ( e.code === 'KeyV' ) this.actions.emit( 'lookBack', { active: false } );

	}

	_releaseAll() {

		if ( this._keys.has( 'KeyV' ) ) this.actions.emit( 'lookBack', { active: false } );
		this._keys.clear();

	}

	_down( ...codes ) {

		for ( const c of codes ) if ( this._keys.has( c ) ) return true;
		return false;

	}

	_pollGamepad() {

		const pads = globalThis.navigator?.getGamepads?.();
		if ( ! pads ) return null;
		let pad = this._padIndex !== null ? pads[ this._padIndex ] : null;
		if ( ! pad || ! pad.connected ) {

			pad = null;
			for ( const p of pads ) {

				if ( p && p.connected && p.mapping === 'standard' ) {

					pad = p;
					break;

				}

			}

			this._padIndex = pad ? pad.index : null;
			this._padButtons.length = 0;

		}

		return pad;

	}

	/** Polls devices and refreshes `controls`. Call once per rendered frame before the physics steps. */
	update() {

		const c = this.controls;

		// keyboard
		let steer = ( this._down( 'KeyD', 'ArrowRight' ) ? 1 : 0 ) - ( this._down( 'KeyA', 'ArrowLeft' ) ? 1 : 0 );
		let throttle = this._down( 'KeyW', 'ArrowUp' ) ? 1 : 0;
		let brake = this._down( 'KeyS', 'ArrowDown' ) ? 1 : 0;
		let handbrake = this._down( 'Space' ) ? 1 : 0;
		let shiftUp = this._shiftUpQueued;
		let shiftDown = this._shiftDownQueued;
		this._shiftUpQueued = false;
		this._shiftDownQueued = false;
		let lookX = 0, lookY = 0;

		if ( steer !== 0 ) this.analogSteering = false;

		// gamepad
		const pad = this._pollGamepad();
		if ( pad ) {

			const axis = ( i ) => {

				const v = pad.axes[ i ] ?? 0;
				const a = Math.abs( v );
				return a < STICK_DEADZONE ? 0 : Math.sign( v ) * ( a - STICK_DEADZONE ) / ( 1 - STICK_DEADZONE );

			};

			const value = ( i ) => pad.buttons[ i ]?.value ?? 0;
			const pressed = ( i ) => pad.buttons[ i ]?.pressed ?? false;

			const sx = axis( 0 );
			if ( sx !== 0 ) {

				// Slightly progressive response for precision around the centre.
				steer = clamp( steer + Math.sign( sx ) * Math.pow( Math.abs( sx ), 1.4 ), - 1, 1 );
				this.analogSteering = true;

			}

			throttle = Math.max( throttle, value( 7 ) );
			brake = Math.max( brake, value( 6 ) );
			handbrake = Math.max( handbrake, pressed( 0 ) ? 1 : 0 );
			lookX = axis( 2 );
			lookY = axis( 3 );

			for ( let i = 0; i < pad.buttons.length; i ++ ) {

				const now = pressed( i );
				const before = this._padButtons[ i ] === true;
				this._padButtons[ i ] = now;
				if ( now === before ) continue;

				if ( i === 11 ) this.actions.emit( 'lookBack', { active: now } );
				if ( ! now ) continue;

				this.actions.emit( 'any' );
				if ( i === 5 || i === 1 ) shiftUp = true;
				if ( i === 4 || i === 2 ) shiftDown = true;
				if ( PAD_ACTIONS[ i ] ) this.actions.emit( PAD_ACTIONS[ i ] );
				if ( PAD_MENU[ i ] ) this.actions.emit( 'menu', { dir: PAD_MENU[ i ] } );

			}

		}

		this.look.x = lookX;
		this.look.y = lookY;

		if ( this.drivingEnabled ) {

			c.steer = steer;
			c.throttle = throttle;
			c.brake = brake;
			c.handbrake = handbrake;
			c.shiftUp = shiftUp;
			c.shiftDown = shiftDown;

		} else {

			c.steer = 0;
			c.throttle = 0;
			c.brake = 0;
			c.handbrake = 0;
			c.shiftUp = false;
			c.shiftDown = false;

		}

		return c;

	}

	/**
	 * Gamepad rumble (no-op without a capable pad).
	 * @param {number} strong  0..1 low-frequency motor
	 * @param {number} weak    0..1 high-frequency motor
	 * @param {number} [ms=120]
	 */
	rumble( strong, weak, ms = 120 ) {

		if ( this._padIndex === null ) return;
		const pad = globalThis.navigator?.getGamepads?.()[ this._padIndex ];
		const actuator = pad?.vibrationActuator;
		if ( ! actuator?.playEffect ) return;
		actuator.playEffect( 'dual-rumble', {
			duration: ms,
			strongMagnitude: clamp( strong, 0, 1 ),
			weakMagnitude: clamp( weak, 0, 1 ),
		} ).catch( () => {} );

	}

}
