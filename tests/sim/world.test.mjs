// Checks of the baked world (public/assets/world). Run `node tools/bake-world.mjs` first; skipped when the bake is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeRng, randRange } from '../../src/core/rng.js';
import { Surface } from '../../src/sim/constants.js';
import { buildRoadRibbon, offsetPolyline } from '../../src/sim/roadGeometry.js';
import { ROAD_BED } from '../../src/sim/terrainGen.js';
import { WORLD_DIR, loadWorld } from '../../src/sim/world.node.js';

const baked = existsSync( path.join( WORLD_DIR, 'world.json' ) );
const skip = baked ? false : 'world not baked - run node tools/bake-world.mjs';
const world = baked ? await loadWorld() : null;

test( 'grids are complete and finite', { skip }, () => {

	assert.equal( world.heights.length, world.n * world.n );
	assert.equal( world.surface.length, world.n * world.n );
	assert.equal( world.outer.heights.length, world.outer.n * world.outer.n );
	for ( const grid of [ world.heights, world.outer.heights ] ) for ( let i = 0; i < grid.length; i ++ ) if ( ! Number.isFinite( grid[ i ] ) ) assert.fail( `non-finite height at ${i}` );
	for ( let i = 0; i < world.surface.length; i ++ ) if ( world.surface[ i ] === Surface.ASPHALT || world.surface[ i ] > Surface.WATER ) assert.fail( `bad surface id ${world.surface[ i ]} at ${i}` );
	for ( const map of [ world.splat0, world.splat1, world.fields ] ) assert.equal( map.data.length, map.width * map.height * 4 );
	for ( let k = 0; k < world.splat0.data.length; k += 4 ) {

		let sum = 0;
		for ( let i = 0; i < 4; i ++ ) sum += world.splat0.data[ k + i ] + world.splat1.data[ k + i ];
		if ( sum !== 255 ) assert.fail( `biome weights sum to ${sum} at texel ${k / 4}` );

	}

} );

test( 'the terrain lies just below the pavement everywhere and never pokes through', { skip }, () => {

	const track = world.track, rng = makeRng( 4 ), p = [ 0, 0, 0 ];
	let worstAbove = - Infinity, worstBelow = Infinity;
	for ( let k = 0; k < 20000; k ++ ) {

		const s = rng() * track.length;
		const half = track.halfWidthAt( s );
		track.pointAt( s, randRange( rng, - half, half ), p );
		const gap = world.heightAt( p[ 0 ], p[ 2 ] ) - p[ 1 ];
		worstAbove = Math.max( worstAbove, gap );
		worstBelow = Math.min( worstBelow, gap );

	}

	assert.ok( worstAbove <= - 0.02, `terrain reaches ${worstAbove.toFixed( 3 )} m relative to the road surface` );
	assert.ok( worstBelow >= - 0.75, `terrain is ${( - worstBelow ).toFixed( 2 )} m below the road somewhere` );

} );

test( 'the shoulder starts close to the road edge height and the terrain near the road is not a cliff', { skip }, () => {

	const track = world.track, rng = makeRng( 5 ), p = [ 0, 0, 0 ], q = [ 0, 0, 0 ];
	let worstStep = 0, steep = 0;
	const samples = 6000;
	for ( let k = 0; k < samples; k ++ ) {

		const s = rng() * track.length, side = rng() < 0.5 ? - 1 : 1;
		const half = track.halfWidthAt( s );
		track.pointAt( s, side * half, p );
		track.pointAt( s, side * ( half + ROAD_BED.shoulder * 0.7 ), q );
		worstStep = Math.max( worstStep, Math.abs( world.heightAt( q[ 0 ], q[ 2 ] ) - p[ 1 ] ) );
		// cut / fill slopes further out stay climbable for the eye: mostly under ~50 degrees
		track.pointAt( s, side * ( half + 12 ), q );
		if ( world.slopeAt( q[ 0 ], q[ 2 ] ) > 52 * Math.PI / 180 ) steep ++;

	}

	assert.ok( worstStep < 0.45, `shoulder is ${worstStep.toFixed( 2 )} m off the road edge height` );
	assert.ok( steep / samples < 0.02, `${( 100 * steep / samples ).toFixed( 1 )} % of the roadside is steeper than 52 degrees` );

} );

test( 'lake, bounds and the far ring', { skip }, () => {

	assert.ok( world.heightAt( 20, 480 ) < world.waterLevel - 20 ); // middle of the lake
	assert.equal( world.surfaceAt( 20, 480 ), Surface.WATER );
	assert.ok( world.inBounds( 0, 0 ) && ! world.inBounds( 4000, 0 ) );
	// the far ring agrees with the inner grid along the border of the playable square
	const rng = makeRng( 6 );
	const lo = world.minX, hi = world.minX + world.size;
	let worst = 0;
	for ( let k = 0; k < 400; k ++ ) {

		const t = randRange( rng, lo + 60, hi - 60 );
		for ( const [ x, z ] of [ [ t, lo ], [ t, hi ], [ lo, t ], [ hi, t ] ] ) {

			const inner = world.heightAt( x, z );
			const o = world.outer;
			const fx = ( x - o.minX ) / o.cell, fz = ( z - o.minZ ) / o.cell;
			const ix = Math.floor( fx ), iz = Math.floor( fz ), tx = fx - ix, tz = fz - iz, a = iz * o.n + ix;
			const outer = ( o.heights[ a ] * ( 1 - tx ) + o.heights[ a + 1 ] * tx ) * ( 1 - tz ) + ( o.heights[ a + o.n ] * ( 1 - tx ) + o.heights[ a + o.n + 1 ] * tx ) * tz;
			worst = Math.max( worst, Math.abs( inner - outer ) );

		}

	}

	assert.ok( worst < 14, `inner and outer grids differ by ${worst.toFixed( 1 )} m at the border` ); // 48 m cells cannot follow 2 m detail exactly
	// high alpine horizon in every direction
	let peak = 0;
	for ( const h of world.outer.heights ) peak = Math.max( peak, h );
	assert.ok( peak > 1500 && peak < 3200, `far peaks reach ${peak.toFixed( 0 )} m` );

} );

test( 'groundAt, fields and biomes are consistent with the road', { skip }, () => {

	const track = world.track, p = [ 0, 0, 0 ], out = {}, f = {}, b = [];
	for ( let s = 5; s < track.length; s += 37 ) {

		track.pointAt( s, 1.5, p );
		world.groundAt( p[ 0 ], p[ 2 ], s, out );
		assert.ok( out.onRoad && out.surface === Surface.ASPHALT );
		assert.ok( Math.abs( out.y - p[ 1 ] ) < 0.02 );
		world.fieldsAt( p[ 0 ], p[ 2 ], f );
		assert.ok( f.forest === 0, `forest on the road at s = ${s}` );
		assert.ok( f.roadDistance < 3 );
		// 6 m beyond the edge: off the road, on terrain, no trees yet
		track.pointAt( s, track.halfWidthAt( s ) + 6, p );
		world.groundAt( p[ 0 ], p[ 2 ], s, out );
		assert.ok( ! out.onRoad && out.surface !== Surface.ASPHALT );
		world.biomeAt( p[ 0 ], p[ 2 ], b );
		assert.ok( Math.abs( b.reduce( ( x, y ) => x + y, 0 ) - 1 ) < 1e-6 );

	}

	// the shoulder is gravel for physics
	let gravel = 0, count = 0;
	for ( let s = 5; s < track.length; s += 11 ) {

		track.pointAt( s, track.halfWidthAt( s ) + 1.1, p );
		if ( world.surfaceAt( p[ 0 ], p[ 2 ] ) === Surface.GRAVEL ) gravel ++;
		count ++;

	}

	assert.ok( gravel / count > 0.8, `only ${( 100 * gravel / count ).toFixed( 0 )} % of the shoulder is gravel` );

} );

test( 'road ribbon: closed, on the track surface, wound upward', { skip }, () => {

	const track = world.track;
	const ribbon = buildRoadRibbon( track );
	const { positions, indices, rows, cols } = ribbon;
	assert.equal( positions.length, rows * cols * 3 );
	// seam row coincides with row 0
	for ( let c = 0; c < cols * 3; c ++ ) assert.ok( Math.abs( positions[ c ] - positions[ ( rows - 1 ) * cols * 3 + c ] ) < 1e-4 );
	// every triangle faces up
	for ( let i = 0; i < indices.length; i += 3 ) {

		const a = indices[ i ] * 3, b = indices[ i + 1 ] * 3, c = indices[ i + 2 ] * 3;
		const ux = positions[ b ] - positions[ a ], uz = positions[ b + 2 ] - positions[ a + 2 ];
		const vx = positions[ c ] - positions[ a ], vz = positions[ c + 2 ] - positions[ a + 2 ];
		if ( uz * vx - ux * vz <= 0 ) assert.fail( `triangle ${i / 3} faces down` );

	}

	// spacing never exceeds 2 m and tightens in the hairpins
	let maxGap = 0, minGap = Infinity;
	for ( let r = 1; r < rows; r ++ ) {

		const gap = ribbon.sAtRow[ r ] - ribbon.sAtRow[ r - 1 ];
		maxGap = Math.max( maxGap, gap );
		minGap = Math.min( minGap, gap );

	}

	assert.ok( maxGap <= 2.3 && minGap < 1.9 );
	const line = offsetPolyline( track, 3, 5 );
	const proj = track.project( line[ 30 ], line[ 32 ] );
	assert.ok( Math.abs( proj.d - 3 ) < 0.05 );

} );
