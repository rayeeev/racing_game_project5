// Deterministic placement of trees and rocks from the baked world maps. Pure (Node + browser): the same seed and world
// always give the same forest, so physics colliders and visuals agree on every machine.

import { hash01 } from '../core/rng.js';

const CELL = 48; // meters: instances are grouped into square cells for culling and LOD selection

/**
 * @typedef {Object} ScatterSet
 * @property {number} count
 * @property {Float32Array} x
 * @property {Float32Array} y        ground height minus the variant's sink
 * @property {Float32Array} z
 * @property {Float32Array} yaw
 * @property {Float32Array} scale
 * @property {Uint8Array} variant    index into the variant list that was passed in
 * @property {number} cellSize
 * @property {number} cellsPerSide
 * @property {Uint32Array} cellStart cellsPerSide^2 * variants + 1 offsets: instances are sorted by ( cell, variant )
 */

function finish( list, world, variantCount ) {

	const cellsPerSide = Math.ceil( world.size / CELL );
	const key = ( i ) => ( Math.min( cellsPerSide - 1, Math.floor( ( list.z[ i ] - world.minZ ) / CELL ) ) * cellsPerSide + Math.min( cellsPerSide - 1, Math.floor( ( list.x[ i ] - world.minX ) / CELL ) ) ) * variantCount + list.variant[ i ];
	const order = Array.from( { length: list.x.length }, ( _, i ) => i ).sort( ( a, b ) => key( a ) - key( b ) || a - b );
	const n = order.length;
	const out = { count: n, x: new Float32Array( n ), y: new Float32Array( n ), z: new Float32Array( n ), yaw: new Float32Array( n ), scale: new Float32Array( n ), variant: new Uint8Array( n ), cellSize: CELL, cellsPerSide, cellStart: new Uint32Array( cellsPerSide * cellsPerSide * variantCount + 1 ) };
	const counts = new Uint32Array( cellsPerSide * cellsPerSide * variantCount );
	order.forEach( ( from, to ) => {

		out.x[ to ] = list.x[ from ];
		out.y[ to ] = list.y[ from ];
		out.z[ to ] = list.z[ from ];
		out.yaw[ to ] = list.yaw[ from ];
		out.scale[ to ] = list.scale[ from ];
		out.variant[ to ] = list.variant[ from ];
		counts[ key( from ) ] ++;

	} );
	for ( let i = 0; i < counts.length; i ++ ) out.cellStart[ i + 1 ] = out.cellStart[ i ] + counts[ i ];
	return out;

}

/**
 * Trees: follow the baked forest density; tall trees in the interior, young ones toward the edges; nothing near the road.
 * @param {import('./world.js').World} world   loaded WITH its maps (fieldsAt must work)
 * @param {{ class: string, sink?: number }[]} variants  'tall' | 'young' per variant
 * @param {Object} [options]
 * @param {number} [options.density=1]   0..1 thins the forest (quality tiers)
 * @param {(x: number, z: number) => boolean} [options.allowed]  extra veto (cleared zones)
 * @returns {ScatterSet}
 */
export function placeTrees( world, variants, { density = 1, allowed = null } = {} ) {

	const spacing = 7.6;
	const seed = world.meta.seed ?? 1;
	const tall = variants.map( ( v, i ) => ( v.class === 'tall' ? i : - 1 ) ).filter( ( i ) => i >= 0 );
	const young = variants.map( ( v, i ) => ( v.class !== 'tall' ? i : - 1 ) ).filter( ( i ) => i >= 0 );
	const list = { x: [], y: [], z: [], yaw: [], scale: [], variant: [] };
	const f = {};
	const cells = Math.floor( world.size / spacing );
	for ( let j = 2; j < cells - 2; j ++ ) {

		for ( let i = 2; i < cells - 2; i ++ ) {

			const x = world.minX + ( i + 0.15 + 0.7 * hash01( i, j, seed ) ) * spacing;
			const z = world.minZ + ( j + 0.15 + 0.7 * hash01( i, j, seed + 1 ) ) * spacing;
			world.fieldsAt( x, z, f );
			if ( f.forest < 0.06 ) continue;
			if ( hash01( i, j, seed + 2 ) > Math.pow( f.forest, 1.15 ) * 0.92 * density ) continue;
			// interior → tall trees, edges → young ones
			const preferTall = f.forest > 0.5 + 0.42 * hash01( i, j, seed + 3 );
			const pool = preferTall && tall.length ? tall : ( young.length ? young : tall );
			const variant = pool[ Math.floor( hash01( i, j, seed + 4 ) * pool.length ) % pool.length ];
			const isTall = variants[ variant ].class === 'tall';
			if ( f.roadDistance < ( isTall ? 7.5 : 5.5 ) ) continue; // keep the run-off fair
			const ground = world.heightAt( x, z );
			if ( ground < world.waterLevel + 1.6 ) continue;
			if ( allowed && ! allowed( x, z ) ) continue;
			list.x.push( x );
			list.z.push( z );
			list.y.push( ground - ( variants[ variant ].sink ?? 0 ) );
			list.yaw.push( hash01( i, j, seed + 5 ) * Math.PI * 2 );
			list.scale.push( 0.82 + 0.42 * hash01( i, j, seed + 6 ) );
			list.variant.push( variant );

		}

	}

	return finish( list, world, variants.length );

}

/**
 * Rocks: boulders and stones where the biome maps say rock or scree, plus the occasional erratic boulder in a meadow.
 * @param {import('./world.js').World} world
 * @param {{ size: number[], sink?: number }[]} variants
 * @param {Object} [options]
 * @param {number} [options.density=1]
 * @param {(x: number, z: number) => boolean} [options.allowed]
 * @returns {ScatterSet}
 */
export function placeRocks( world, variants, { density = 1, allowed = null } = {} ) {

	const spacing = 9.5;
	const seed = ( world.meta.seed ?? 1 ) + 100;
	const large = variants.map( ( v, i ) => ( Math.max( v.size[ 0 ], v.size[ 2 ] ) >= 1.5 ? i : - 1 ) ).filter( ( i ) => i >= 0 );
	const small = variants.map( ( v, i ) => ( Math.max( v.size[ 0 ], v.size[ 2 ] ) < 1.5 ? i : - 1 ) ).filter( ( i ) => i >= 0 );
	const list = { x: [], y: [], z: [], yaw: [], scale: [], variant: [] };
	const f = {}, b = [];
	const cells = Math.floor( world.size / spacing );
	for ( let j = 2; j < cells - 2; j ++ ) {

		for ( let i = 2; i < cells - 2; i ++ ) {

			const x = world.minX + ( i + hash01( i, j, seed ) ) * spacing;
			const z = world.minZ + ( j + hash01( i, j, seed + 1 ) ) * spacing;
			world.fieldsAt( x, z, f );
			if ( f.roadDistance < 3.6 ) continue;
			world.biomeAt( x, z, b );
			const rocky = b[ 5 ] * 0.9 + b[ 6 ] + b[ 4 ] * 0.45;
			const chance = ( rocky * 0.55 + 0.012 * ( 1 - f.forest ) ) * density;
			if ( hash01( i, j, seed + 2 ) > chance ) continue;
			const ground = world.heightAt( x, z );
			if ( ground < world.waterLevel + 0.4 || world.slopeAt( x, z ) > 0.95 ) continue;
			if ( allowed && ! allowed( x, z ) ) continue;
			const pool = hash01( i, j, seed + 3 ) < 0.45 && large.length ? large : ( small.length ? small : large );
			const variant = pool[ Math.floor( hash01( i, j, seed + 4 ) * pool.length ) % pool.length ];
			const scale = 0.75 + 0.7 * hash01( i, j, seed + 6 );
			list.x.push( x );
			list.z.push( z );
			list.y.push( ground - ( variants[ variant ].sink ?? 0 ) * scale - 0.05 );
			list.yaw.push( hash01( i, j, seed + 5 ) * Math.PI * 2 );
			list.scale.push( scale );
			list.variant.push( variant );

		}

	}

	return finish( list, world, variants.length );

}
