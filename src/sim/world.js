// The baked world at runtime (Node + browser): height grids, physics surface grid, biome / field maps and the Track.
// Files are produced by tools/bake-world.mjs into public/assets/world/ (see world.json for the list).
//
//   height.bin        Float32 little-endian, n * n, row-major (index = iz * n + ix), meters
//   outer_height.bin  Float32 little-endian, outerN * outerN, the far visual-only ring (48 m cells)
//   surface.bin       Uint8, n * n, Surface ids of the TERRAIN (never ASPHALT: the road collider decides that)
//   splat0.png        RGBA 4 m map: grass_meadow, grass_dry, forest_floor, dirt        (the eight weights sum to 255)
//   splat1.png        RGBA 4 m map: gravel, rock_cliff, rock_ground, shore
//   fields.png        RGBA 4 m map: forest density, meadow / flower density, wetness, distance to the pavement edge (0..64 m → 0..255)
// Grid convention: world x = minX + ix * cell, z = minZ + iz * cell (vertex-centred samples).

import { clamp } from '../core/math.js';
import { Surface } from './constants.js';
import { LAYOUT } from './layout.js';
import { Track } from './track.js';

/**
 * A reader for the browser: fetches files relative to baseUrl.
 * @param {string} baseUrl e.g. '/assets/world/'
 * @returns {(path: string) => Promise<ArrayBuffer>}
 */
export function fetchReader( baseUrl ) {

	const base = ( globalThis.location ? new URL( baseUrl, globalThis.location.href ).href : baseUrl ).replace( /\/?$/, '/' );
	return async ( path ) => {

		const res = await fetch( base + path );
		if ( ! res.ok ) throw new Error( `World file ${path}: HTTP ${res.status}` );
		return res.arrayBuffer();

	};

}

function bilinear( grid, n, fx, fz ) {

	const ix = Math.min( n - 2, Math.max( 0, Math.floor( fx ) ) ), iz = Math.min( n - 2, Math.max( 0, Math.floor( fz ) ) );
	const tx = clamp( fx - ix, 0, 1 ), tz = clamp( fz - iz, 0, 1 );
	const a = iz * n + ix;
	return ( grid[ a ] * ( 1 - tx ) + grid[ a + 1 ] * tx ) * ( 1 - tz ) + ( grid[ a + n ] * ( 1 - tx ) + grid[ a + n + 1 ] * tx ) * tz;

}

export class World {

	/**
	 * @param {(path: string) => Promise<ArrayBuffer>} read   fetchReader( url ) in the browser, nodeReader( dir ) in Node
	 * @param {Object} [options]
	 * @param {(buffer: ArrayBuffer) => Promise<{ data: Uint8Array, width: number, height: number }>} [options.decodeImage]
	 *        PNG decoder (src/core/png.js); without it the splat / fields maps are not loaded (they are optional)
	 * @returns {Promise<World>}
	 */
	static async load( read, { decodeImage = null } = {} ) {

		const meta = JSON.parse( new TextDecoder().decode( await read( 'world.json' ) ) );
		const world = new World( meta );
		const [ height, outer, surface ] = await Promise.all( [ read( meta.files.height ), read( meta.files.outerHeight ), read( meta.files.surface ) ] );
		world.heights = new Float32Array( height );
		world.outer.heights = new Float32Array( outer );
		world.surface = new Uint8Array( surface );
		if ( world.heights.length !== world.n * world.n ) throw new Error( 'World: height.bin does not match world.json' );
		if ( Math.abs( world.track.length - meta.track.length ) > 0.5 ) throw new Error( 'World: the baked data belongs to a different circuit - run node tools/bake-world.mjs' );

		if ( decodeImage ) {

			const [ splat0, splat1, fields ] = await Promise.all( [ meta.files.splat0, meta.files.splat1, meta.files.fields ].map( async ( file ) => decodeImage( await read( file ) ) ) );
			world.splat0 = splat0;
			world.splat1 = splat1;
			world.fields = fields;

		}

		return world;

	}

	/** @param {Object} meta parsed world.json */
	constructor( meta ) {

		/** Parsed world.json. */
		this.meta = meta;
		/** Samples per side, cell size and origin of the inner (playable) grid. */
		this.n = meta.n;
		this.cell = meta.cell;
		this.minX = meta.minX;
		this.minZ = meta.minZ;
		this.size = meta.size;
		this.waterLevel = meta.waterLevel;
		/** @type {Float32Array} n * n terrain heights */
		this.heights = null;
		/** @type {Uint8Array} n * n terrain Surface ids */
		this.surface = null;
		/** The far ring: { n, cell, minX, minZ, size, heights }. */
		this.outer = { n: meta.outer.n, cell: meta.outer.cell, minX: meta.outer.minX, minZ: meta.outer.minZ, size: meta.outer.size, heights: null };
		/** Decoded 4 m maps ({ data: Uint8Array RGBA, width, height }) or null when not loaded. */
		this.splat0 = null;
		this.splat1 = null;
		this.fields = null;
		/** @type {Track} */
		this.track = new Track( LAYOUT );
		this._proj = {};
		this._frame = {};

	}

	/** True if (x, z) lies inside the playable square, at least `margin` meters from its border. */
	inBounds( x, z, margin = 0 ) {

		return x >= this.minX + margin && x <= this.minX + this.size - margin && z >= this.minZ + margin && z <= this.minZ + this.size - margin;

	}

	/** Terrain height in meters (bilinear). Outside the playable square the far ring is used. */
	heightAt( x, z ) {

		if ( this.inBounds( x, z ) ) return bilinear( this.heights, this.n, ( x - this.minX ) / this.cell, ( z - this.minZ ) / this.cell );
		const o = this.outer;
		return bilinear( o.heights, o.n, ( x - o.minX ) / o.cell, ( z - o.minZ ) / o.cell );

	}

	/**
	 * Unit terrain normal.
	 * @param {number[]} [out] [x, y, z]
	 */
	normalAt( x, z, out = [ 0, 1, 0 ] ) {

		const e = this.inBounds( x, z, this.cell ) ? this.cell : this.outer.cell;
		const dx = this.heightAt( x - e, z ) - this.heightAt( x + e, z );
		const dz = this.heightAt( x, z - e ) - this.heightAt( x, z + e );
		const len = Math.hypot( dx, 2 * e, dz );
		out[ 0 ] = dx / len;
		out[ 1 ] = 2 * e / len;
		out[ 2 ] = dz / len;
		return out;

	}

	/** Terrain slope angle in radians (0 = level). */
	slopeAt( x, z ) {

		const e = this.inBounds( x, z, this.cell ) ? this.cell : this.outer.cell;
		return Math.atan( Math.hypot( this.heightAt( x + e, z ) - this.heightAt( x - e, z ), this.heightAt( x, z + e ) - this.heightAt( x, z - e ) ) / ( 2 * e ) );

	}

	/** Surface id of the terrain at (x, z) (nearest cell; never ASPHALT). */
	surfaceAt( x, z ) {

		const ix = clamp( Math.round( ( x - this.minX ) / this.cell ), 0, this.n - 1 );
		const iz = clamp( Math.round( ( z - this.minZ ) / this.cell ), 0, this.n - 1 );
		return this.surface[ iz * this.n + ix ];

	}

	/**
	 * The drivable surface under (x, z): the road (ASPHALT) when inside the pavement, otherwise the terrain.
	 * @param {number} x
	 * @param {number} z
	 * @param {number} [hintS] previous s of the same object (fast, continuous)
	 * @param {{ y: number, surface: number, onRoad: boolean, s: number, d: number }} [out]
	 */
	groundAt( x, z, hintS = undefined, out = {} ) {

		const p = this.track.project( x, z, hintS, this._proj );
		out.s = p.s;
		out.d = p.d;
		out.onRoad = p.onRoad;
		if ( p.onRoad ) {

			const f = this.track.frameAt( p.s, this._frame );
			out.y = f.y + p.d * f.ly;
			out.surface = Surface.ASPHALT;

		} else {

			out.y = this.heightAt( x, z );
			out.surface = this.surfaceAt( x, z );

		}

		return out;

	}

	_mapTexel( map, x, z ) {

		const ix = clamp( Math.round( ( x - this.minX ) / this.size * ( map.width - 1 ) ), 0, map.width - 1 );
		const iz = clamp( Math.round( ( z - this.minZ ) / this.size * ( map.height - 1 ) ), 0, map.height - 1 );
		return ( iz * map.width + ix ) * 4;

	}

	/**
	 * Vegetation fields at (x, z) (nearest 4 m texel). Requires the maps (decodeImage passed to load).
	 * @param {{ forest: number, meadow: number, wetness: number, roadDistance: number }} [out]
	 *        forest / meadow / wetness in 0..1, roadDistance = meters beyond the pavement edge (0 on the road, capped at 64)
	 */
	fieldsAt( x, z, out = {} ) {

		const f = this.fields;
		if ( ! f ) throw new Error( 'World.fieldsAt: the fields map is not loaded (pass decodeImage to World.load)' );
		const k = this._mapTexel( f, x, z );
		out.forest = f.data[ k ] / 255;
		out.meadow = f.data[ k + 1 ] / 255;
		out.wetness = f.data[ k + 2 ] / 255;
		out.roadDistance = f.data[ k + 3 ] / 255 * 64;
		return out;

	}

	/**
	 * Biome weights at (x, z) (nearest 4 m texel), each 0..1, summing to 1. Order: grass_meadow, grass_dry, forest_floor,
	 * dirt, gravel, rock_cliff, rock_ground, shore.
	 * @param {number[]} [out] 8 numbers
	 */
	biomeAt( x, z, out = [ 0, 0, 0, 0, 0, 0, 0, 0 ] ) {

		if ( ! this.splat0 ) throw new Error( 'World.biomeAt: the splat maps are not loaded (pass decodeImage to World.load)' );
		const k = this._mapTexel( this.splat0, x, z );
		for ( let i = 0; i < 4; i ++ ) {

			out[ i ] = this.splat0.data[ k + i ] / 255;
			out[ 4 + i ] = this.splat1.data[ k + i ] / 255;

		}

		return out;

	}

}
