// Road furniture placement, derived from the track and the terrain. Pure and deterministic (Node + browser), because
// rendering and physics must agree: the road system draws what this returns and registers the rail colliders from it.

import { clamp } from '../core/math.js';

/** Dimensions in meters. */
export const RAIL = Object.freeze( {
	offset: 0.85, // lateral distance of the rail face beyond the pavement edge
	beamHeight: 0.56, // centre of the W-beam above the road edge
	beamDepth: 0.31, // height of the beam profile
	postSpacing: 4,
	postSpacingTight: 2, // in corners tighter than 60 m radius
	postTop: 0.7,
	drop: 2.2, // a fall of this much within `reach` of the pavement edge calls for a rail
	reach: 11,
	waterReach: 16, // ... as does water this close
	minRun: 28, // shorter rails are removed
	maxGap: 22, // shorter gaps between rails are closed
} );

const STEP = 2; // sampling interval along the track

/**
 * @typedef {Object} RailRun
 * @property {number} side      +1 = left of the driving direction, -1 = right
 * @property {number} sStart    meters (may be greater than sEnd when the run wraps across the line: then sEnd += track.length)
 * @property {number} sEnd
 * @property {Float32Array} points   [x, y, z, ...] along the rail at road-edge height, every 2 m
 * @property {Float32Array} posts    [x, y, z, yaw, ...] post positions (y = road-edge height)
 */

/**
 * @param {import('./track.js').Track} track
 * @param {import('./world.js').World} world
 * @returns {{ rails: RailRun[], delineators: Float32Array, railColliders: Object[] }}
 *   delineators: [x, y, z, yaw, side, ...] marker posts where there is no rail;
 *   railColliders: obstacle descriptors for Simulation.addObstacles (see src/sim/session.js)
 */
export function computeRoadside( track, world ) {

	const count = Math.round( track.length / STEP );
	const ds = track.length / count;
	const frame = {}, rails = [], railColliders = [];
	const delineators = [];
	const needs = [ new Uint8Array( count ), new Uint8Array( count ) ]; // [ left, right ]

	// where does a car leaving the road fall, or reach the water?
	for ( let i = 0; i < count; i ++ ) {

		track.frameAt( i * ds, frame );
		for ( let k = 0; k < 2; k ++ ) {

			const side = k === 0 ? 1 : - 1;
			const edge = side * frame.halfWidth;
			const edgeY = frame.y + edge * frame.ly;
			const hx = frame.lx, hz = frame.lz, len = Math.hypot( hx, hz ) || 1;
			let lowest = Infinity, water = false;
			for ( let r = 3; r <= RAIL.waterReach; r += 2 ) {

				const x = frame.x + ( edge + side * r ) * hx / len, z = frame.z + ( edge + side * r ) * hz / len;
				const h = world.heightAt( x, z );
				if ( r <= RAIL.reach ) lowest = Math.min( lowest, h );
				if ( h < world.waterLevel + 0.4 ) water = true;

			}

			if ( edgeY - lowest > RAIL.drop || water ) needs[ k ][ i ] = 1;

		}

	}

	for ( let k = 0; k < 2; k ++ ) {

		const side = k === 0 ? 1 : - 1, flags = needs[ k ];
		// close short gaps, then drop short runs (both on the closed loop)
		const gap = Math.round( RAIL.maxGap / ds ), run = Math.round( RAIL.minRun / ds );
		fill( flags, 0, gap, 1 );
		fill( flags, 1, run, 0 );

		// collect runs; start scanning at a gap so that a run crossing the line stays in one piece
		let first = flags.indexOf( 0 );
		if ( first < 0 ) first = 0; // rail all the way round
		let i = 0;
		while ( i < count ) {

			if ( ! flags[ ( first + i ) % count ] ) {

				i ++;
				continue;

			}

			let j = i;
			while ( j < count && flags[ ( first + j ) % count ] ) j ++;
			const sStart = ( first + i ) * ds, sEnd = ( first + j - 1 ) * ds;
			rails.push( buildRun( track, side, sStart, sEnd, railColliders ) );
			i = j;

		}

		// marker posts on the stretches without a rail
		for ( let s = 0; s < track.length - 10; s += 25 ) {

			const index = Math.round( s / ds ) % count;
			if ( flags[ index ] ) continue;
			const bend = Math.abs( track.curvatureAt( s ) );
			if ( bend < 1 / 400 && Math.round( s / 25 ) % 2 === 1 ) continue; // every 50 m on straights
			track.frameAt( s, frame );
			const d = side * ( frame.halfWidth + 1.1 );
			delineators.push( frame.x + d * frame.lx, frame.y + side * frame.halfWidth * frame.ly - 0.08, frame.z + d * frame.lz, Math.atan2( - frame.tx, - frame.tz ), side );

		}

	}

	return { rails, delineators: new Float32Array( delineators ), railColliders };

}

/** In a circular 0 / 1 array, overwrites every run of `value` shorter than `shorter` with `replacement`. */
function fill( flags, value, shorter, replacement ) {

	const n = flags.length;
	const start = flags.indexOf( value === 0 ? 1 : 0 );
	if ( start < 0 ) return;
	let i = 0;
	while ( i < n ) {

		if ( flags[ ( start + i ) % n ] !== value ) {

			i ++;
			continue;

		}

		let j = i;
		while ( j < n && flags[ ( start + j ) % n ] === value ) j ++;
		if ( j - i < shorter ) for ( let k = i; k < j; k ++ ) flags[ ( start + k ) % n ] = replacement;
		i = j;

	}

}

function buildRun( track, side, sStart, sEnd, colliders ) {

	const frame = {};
	const samples = Math.max( 2, Math.round( ( sEnd - sStart ) / STEP ) + 1 );
	const points = new Float32Array( samples * 3 );
	for ( let i = 0; i < samples; i ++ ) {

		const s = sStart + ( sEnd - sStart ) * i / ( samples - 1 );
		track.frameAt( s, frame );
		const d = side * ( frame.halfWidth + RAIL.offset );
		points[ i * 3 ] = frame.x + d * frame.lx;
		points[ i * 3 + 1 ] = frame.y + side * frame.halfWidth * frame.ly; // road-edge height
		points[ i * 3 + 2 ] = frame.z + d * frame.lz;

	}

	const posts = [];
	let s = sStart;
	while ( s <= sEnd + 1e-6 ) {

		track.frameAt( s, frame );
		const d = side * ( frame.halfWidth + RAIL.offset + 0.09 );
		posts.push( frame.x + d * frame.lx, frame.y + side * frame.halfWidth * frame.ly, frame.z + d * frame.lz, Math.atan2( - frame.tx, - frame.tz ) );
		s += Math.abs( frame.curvature ) > 1 / 60 ? RAIL.postSpacingTight : RAIL.postSpacing;

	}

	// one box collider per 4 m of rail
	for ( let i = 0; i + 2 < samples; i += 2 ) {

		const a = i * 3, b = Math.min( samples - 1, i + 2 ) * 3;
		const dx = points[ b ] - points[ a ], dy = points[ b + 1 ] - points[ a + 1 ], dz = points[ b + 2 ] - points[ a + 2 ];
		const length = Math.hypot( dx, dy, dz );
		const yaw = Math.atan2( - dx, - dz ), pitch = Math.asin( clamp( dy / length, - 1, 1 ) );
		// quaternion = yaw about +Y, then pitch about the local X axis
		const cy = Math.cos( yaw / 2 ), sy = Math.sin( yaw / 2 ), cp = Math.cos( pitch / 2 ), sp = Math.sin( pitch / 2 );
		colliders.push( {
			type: 'box', kind: 'rail',
			position: [ ( points[ a ] + points[ b ] ) / 2, ( points[ a + 1 ] + points[ b + 1 ] ) / 2 + RAIL.beamHeight * 0.62, ( points[ a + 2 ] + points[ b + 2 ] ) / 2 ],
			quaternion: [ cy * sp, sy * cp, - sy * sp, cy * cp ],
			halfExtents: [ 0.06, RAIL.beamHeight * 0.62, length / 2 + 0.05 ],
		} );

	}

	return { side, sStart, sEnd, points, posts: new Float32Array( posts ) };

}
