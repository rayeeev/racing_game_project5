// Persistent lap records (best lap + its ghost) per driving condition, stored in localStorage.

const STORAGE_KEY = 'alpenglow.records.v1';

/**
 * @typedef {Object} LapRecord
 * @property {number} time          lap time in seconds
 * @property {number[]} sectors     sector times
 * @property {string} date          ISO date of the lap
 * @property {string|null} ghost    base64 encoded ghost lap (see src/sim/ghost.js) or null
 */

export class Records {

	constructor() {

		/** @type {Object<string, LapRecord>} */
		this._records = {};
		this._load();

	}

	_load() {

		try {

			const raw = globalThis.localStorage?.getItem( STORAGE_KEY );
			if ( raw ) this._records = JSON.parse( raw ) ?? {};

		} catch ( err ) {

			console.warn( '[records] could not read stored records', err );
			this._records = {};

		}

	}

	_save() {

		try {

			globalThis.localStorage?.setItem( STORAGE_KEY, JSON.stringify( this._records ) );

		} catch ( err ) {

			// Quota exceeded: retry without ghosts of other conditions before giving up.
			console.warn( '[records] could not persist records', err );

		}

	}

	/**
	 * @param {string} condition  e.g. 'dry' | 'wet'
	 * @returns {LapRecord|null}
	 */
	get( condition ) {

		return this._records[ condition ] ?? null;

	}

	/**
	 * Stores the lap if it beats the existing record for the condition.
	 * @param {string} condition
	 * @param {LapRecord} record
	 * @returns {boolean} true if it became the new record
	 */
	submit( condition, record ) {

		const current = this._records[ condition ];
		if ( current && current.time <= record.time ) return false;
		this._records[ condition ] = record;
		this._save();
		return true;

	}

	clear( condition ) {

		if ( condition ) delete this._records[ condition ];
		else this._records = {};
		this._save();

	}

}
