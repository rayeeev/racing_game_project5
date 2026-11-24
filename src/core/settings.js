// Persistent user settings (localStorage) with change notification.

const STORAGE_KEY = 'alpenglow.settings.v1';

/** Defaults double as the schema: only these keys are accepted. */
export const DEFAULT_SETTINGS = Object.freeze( {
	// graphics
	quality: 'high', // 'low' | 'medium' | 'high' | 'ultra'   (applies after reload)
	renderScale: 1.0, // 0.5 .. 1.0 internal resolution multiplier
	motionBlur: true,
	cameraShake: 1.0, // 0 .. 1
	fov: 60, // base vertical field of view of the chase camera in degrees
	// session
	sky: 'golden', // sky preset id
	paint: '', // paint id ('' = the car system's default)
	ghost: 'gold', // 'off' | 'best' | 'bronze' | 'silver' | 'gold'
	camera: 'chase', // camera mode to start with
	// driving
	racingLine: 'braking', // 'off' | 'braking' (brake zones only) | 'full'
	gearbox: 'auto', // 'auto' | 'manual'
	abs: true,
	tc: true,
	stability: true,
	steerAssist: true,
	// HUD
	units: 'kmh', // 'kmh' | 'mph'
	showMinimap: true,
	showInputs: true,
	// audio
	masterVolume: 0.8, // 0 .. 1
	engineVolume: 1.0,
	effectsVolume: 1.0,
	ambienceVolume: 0.7,
	muted: false,
} );

export class Settings {

	/**
	 * @param {import('./events.js').Emitter} [events]  receives 'settings:change' { key, value }
	 */
	constructor( events = null ) {

		this._events = events;
		this._values = { ...DEFAULT_SETTINGS };
		this._load();

	}

	_load() {

		try {

			const raw = globalThis.localStorage?.getItem( STORAGE_KEY );
			if ( ! raw ) return;
			const stored = JSON.parse( raw );
			for ( const key of Object.keys( DEFAULT_SETTINGS ) ) {

				if ( key in stored && typeof stored[ key ] === typeof DEFAULT_SETTINGS[ key ] ) this._values[ key ] = stored[ key ];

			}

		} catch ( err ) {

			console.warn( '[settings] could not read stored settings', err );

		}

	}

	_save() {

		try {

			globalThis.localStorage?.setItem( STORAGE_KEY, JSON.stringify( this._values ) );

		} catch ( err ) {

			console.warn( '[settings] could not persist settings', err );

		}

	}

	/** @param {keyof typeof DEFAULT_SETTINGS} key */
	get( key ) {

		return this._values[ key ];

	}

	/** Snapshot of all settings. */
	all() {

		return { ...this._values };

	}

	/**
	 * Sets a value (ignored if the key is unknown or the type does not match), persists it and emits 'settings:change'.
	 * @param {keyof typeof DEFAULT_SETTINGS} key
	 * @param {any} value
	 * @param {boolean} [persist=true]  false = change for this run only (used by tests / the debug API)
	 */
	set( key, value, persist = true ) {

		if ( ! ( key in DEFAULT_SETTINGS ) || typeof value !== typeof DEFAULT_SETTINGS[ key ] ) {

			console.warn( `[settings] rejected ${String( key )} =`, value );
			return;

		}

		if ( this._values[ key ] === value ) return;
		this._values[ key ] = value;
		if ( persist ) this._save();
		this._events?.emit( 'settings:change', { key, value } );

	}

	reset() {

		for ( const key of Object.keys( DEFAULT_SETTINGS ) ) this.set( key, DEFAULT_SETTINGS[ key ] );

	}

}
