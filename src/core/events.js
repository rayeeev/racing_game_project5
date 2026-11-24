// Minimal synchronous event emitter used for decoupled communication between game systems.

export class Emitter {

	constructor() {

		/** @type {Map<string, Set<Function>>} */
		this._listeners = new Map();

	}

	/**
	 * Subscribes to an event. Returns an unsubscribe function.
	 * @param {string} type
	 * @param {(payload: any) => void} fn
	 */
	on( type, fn ) {

		let set = this._listeners.get( type );
		if ( ! set ) this._listeners.set( type, ( set = new Set() ) );
		set.add( fn );
		return () => set.delete( fn );

	}

	once( type, fn ) {

		const off = this.on( type, ( payload ) => {

			off();
			fn( payload );

		} );
		return off;

	}

	off( type, fn ) {

		this._listeners.get( type )?.delete( fn );

	}

	emit( type, payload ) {

		const set = this._listeners.get( type );
		if ( ! set ) return;
		for ( const fn of [ ...set ] ) {

			try {

				fn( payload );

			} catch ( err ) {

				console.error( `[events] listener for "${type}" threw`, err );

			}

		}

	}

}
