// Node-only helpers for loading the baked world (never import this from browser code).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../core/png.js';
import { World } from './world.js';

/** Default location of the baked files. */
export const WORLD_DIR = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../../public/assets/world' );

/**
 * A reader for World.load() that reads from a directory.
 * @param {string} [dir]
 * @returns {(file: string) => Promise<ArrayBuffer>}
 */
export function nodeReader( dir = WORLD_DIR ) {

	return async ( file ) => {

		const buffer = await readFile( path.join( dir, file ) );
		return buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength );

	};

}

/**
 * Loads the baked world from disk.
 * @param {Object} [options]
 * @param {string} [options.dir]
 * @param {boolean} [options.maps=true] also decode the splat / fields maps
 * @returns {Promise<World>}
 */
export function loadWorld( { dir = WORLD_DIR, maps = true } = {} ) {

	return World.load( nodeReader( dir ), { decodeImage: maps ? decodePng : null } );

}
