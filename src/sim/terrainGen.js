// Terrain generation for the bake (tools/bake-world.mjs): turns the macro landscape of src/sim/layout.js and the road
// into height grids, biome maps and the physics surface grid. Pure and deterministic; no Node APIs.
//
// Pipeline: natural terrain (macro shape + detail noise) → droplet erosion (kept away from the road) → conform to the
// road (lowered bed under the pavement, shoulders, cut / fill slopes) → biome weights, fields, surface ids → far ring.

import { clamp, lerp, smoothstep } from '../core/math.js';
import { makeRng } from '../core/rng.js';
import { Surface } from './constants.js';
import { WORLD, baseHeight } from './layout.js';
import { createNoise2D, fbm, ridged } from './noise.js';

/** Geometry of the road bed in the terrain (meters). */
export const ROAD_BED = Object.freeze( {
	drop: 0.30, // the terrain lies this far below the pavement
	lip: 0.06, // ... and this far below the road edge where the shoulder starts
	innerMargin: 1.2, // the bed starts rising toward the edge this far inside the pavement edge
	outerMargin: 0.3, // ... and reaches shoulder level this far outside it
	shoulder: 2.2, // width of the gravel shoulder beyond the pavement edge
	shoulderFall: 0.04, // cross fall of the shoulder
	corridor: 72, // the road reshapes the terrain up to this distance from the centreline
	influence: 152, // distances to the road are known up to here (detail and erosion fade in over this range)
} );

const MAP_STEP = 2; // biome / field maps have one texel per MAP_STEP height cells (4 m)

/**
 * @typedef {Object} GeneratedWorld
 * @property {number} n                  samples per side of the inner grid
 * @property {Float32Array} heights      n * n, row-major (index = iz * n + ix)
 * @property {Uint8Array} surface        n * n Surface ids
 * @property {number} mapSize            texels per side of the 4 m maps
 * @property {Uint8Array} splat0         RGBA: grass_meadow, grass_dry, forest_floor, dirt
 * @property {Uint8Array} splat1         RGBA: gravel, rock_cliff, rock_ground, shore
 * @property {Uint8Array} fields         RGBA: forest density, meadow / flower density, wetness, distance to pavement edge (0 .. 64 m)
 * @property {number} outerN
 * @property {Float32Array} outerHeights outerN * outerN
 * @property {Object} stats
 */

/**
 * @param {import('./track.js').Track} track
 * @param {(stage: string) => void} [onStage]  progress callback
 * @returns {GeneratedWorld}
 */
export function generateWorld( track, onStage = () => {} ) {

	const { size, cell, minX, minZ, waterLevel, seed } = WORLD;
	const n = Math.round( size / cell ) + 1;
	const total = n * n;
	const detailNoise = createNoise2D( seed + 11 );
	const rockNoise = createNoise2D( seed + 12 );
	const forestNoise = createNoise2D( seed + 13 );
	const patchNoise = createNoise2D( seed + 14 );

	// ── 1. road corridor: nearest centreline sample for every cell near the road
	onStage( 'corridor' );
	const nearest = new Int32Array( total ).fill( - 1 );
	const nearest2 = new Float32Array( total ).fill( Infinity );
	const reach = Math.ceil( ROAD_BED.influence / cell );
	const reach2 = ROAD_BED.influence * ROAD_BED.influence;
	for ( let i = 0; i < track.count; i ++ ) {

		const px = track.xs[ i ], pz = track.zs[ i ];
		const cx = Math.round( ( px - minX ) / cell ), cz = Math.round( ( pz - minZ ) / cell );
		for ( let iz = Math.max( 0, cz - reach ); iz <= Math.min( n - 1, cz + reach ); iz ++ ) {

			const dz = minZ + iz * cell - pz;
			for ( let ix = Math.max( 0, cx - reach ); ix <= Math.min( n - 1, cx + reach ); ix ++ ) {

				const dx = minX + ix * cell - px;
				const d2 = dx * dx + dz * dz;
				if ( d2 > reach2 ) continue; // a disc, so the known distance has no square corners
				const k = iz * n + ix;
				if ( d2 < nearest2[ k ] ) {

					nearest2[ k ] = d2;
					nearest[ k ] = i;

				}

			}

		}

	}

	// ── 2. natural terrain: macro shape + detail (smoother close to the road and toward the border)
	onStage( 'natural terrain' );
	const heights = new Float32Array( total );
	const borderFade = ( x, z ) => smoothstep( 0, 160, Math.min( x - minX, minX + size - x, z - minZ, minZ + size - z ) );
	for ( let iz = 0; iz < n; iz ++ ) {

		const z = minZ + iz * cell;
		for ( let ix = 0; ix < n; ix ++ ) {

			const x = minX + ix * cell;
			const k = iz * n + ix;
			const base = baseHeight( x, z );
			if ( base < waterLevel - 0.5 ) {

				heights[ k ] = base + 0.25 * detailNoise( x / 9, z / 9 );
				continue;

			}

			const e = 12;
			const slope = Math.hypot( baseHeight( x + e, z ) - base, baseHeight( x, z + e ) - base ) / e;
			const rough = 0.35 + 2.4 * smoothstep( 0.18, 0.75, slope );
			const nearRoad = smoothstep( 20, 145, Math.sqrt( nearest2[ k ] ) );
			const detail = 3.2 * fbm( detailNoise, x / 130, z / 130, 3, 2.1, 0.5 ) * rough
				+ 2.6 * ( ridged( rockNoise, x / 60, z / 60, 3, 2, 0.5 ) - 0.45 ) * smoothstep( 0.3, 0.8, slope )
				+ 0.22 * fbm( detailNoise, x / 11 + 5.2, z / 11 - 3.3, 2, 2, 0.5 );
			const shore = smoothstep( waterLevel, waterLevel + 3, base );
			heights[ k ] = base + detail * ( 0.2 + 0.8 * nearRoad ) * borderFade( x, z ) * shore;

		}

	}

	// ── 3. erosion on a 4 m grid, applied away from the road
	onStage( 'erosion' );
	const m = ( n - 1 ) / MAP_STEP + 1;
	const eroded = new Float32Array( m * m );
	for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) eroded[ j * m + i ] = heights[ ( j * MAP_STEP ) * n + i * MAP_STEP ];
	const original = eroded.slice();
	const flow = erode( eroded, m, cell * MAP_STEP, waterLevel, seed + 21 );
	for ( let iz = 0; iz < n; iz ++ ) {

		const fz = iz / MAP_STEP, j0 = Math.min( m - 2, Math.floor( fz ) ), tz = fz - j0;
		const z = minZ + iz * cell;
		for ( let ix = 0; ix < n; ix ++ ) {

			const fx = ix / MAP_STEP, i0 = Math.min( m - 2, Math.floor( fx ) ), tx = fx - i0;
			const a = j0 * m + i0;
			const delta = lerp(
				lerp( eroded[ a ] - original[ a ], eroded[ a + 1 ] - original[ a + 1 ], tx ),
				lerp( eroded[ a + m ] - original[ a + m ], eroded[ a + m + 1 ] - original[ a + m + 1 ], tx ), tz );
			const k = iz * n + ix;
			const mask = smoothstep( 28, 110, Math.sqrt( nearest2[ k ] ) ) * borderFade( minX + ix * cell, z ) * smoothstep( waterLevel + 1.5, waterLevel + 7, heights[ k ] );
			heights[ k ] += clamp( delta, - 9, 6 ) * mask;

		}

	}

	// ── 4. conform to the road
	onStage( 'road bed' );
	const natural = heights.slice();
	const edgeDistance = new Float32Array( total ).fill( 255 ); // meters beyond the pavement edge (negative on the pavement)
	const cutFill = new Float32Array( total ); // natural - road level where the road reshaped the ground (>0 cut, <0 fill)
	const proj = {}, frame = {};
	let maxCut = 0, maxFill = 0;
	for ( let k = 0; k < total; k ++ ) {

		if ( nearest[ k ] < 0 || nearest2[ k ] > ( ROAD_BED.corridor + 8 ) ** 2 ) continue;
		const ix = k % n, iz = ( k - ix ) / n;
		const x = minX + ix * cell, z = minZ + iz * cell;
		track.project( x, z, nearest[ k ], proj );
		track.frameAt( proj.s, frame );
		const half = proj.halfWidth;
		const a = Math.abs( proj.d );
		const side = proj.d < 0 ? - 1 : 1;
		edgeDistance[ k ] = Math.min( 255, a - half );
		if ( a > ROAD_BED.corridor ) continue;

		const roadY = frame.y + proj.d * frame.ly; // the (extended) road surface plane
		const edgeY = frame.y + side * half * frame.ly;
		const inner = half - ROAD_BED.innerMargin, outer = half + ROAD_BED.outerMargin;
		let target;
		if ( a <= inner ) target = roadY - ROAD_BED.drop;
		else if ( a <= outer ) target = roadY - lerp( ROAD_BED.drop, ROAD_BED.lip, ( a - inner ) / ( outer - inner ) );
		else target = edgeY - ROAD_BED.lip - ROAD_BED.shoulderFall * Math.min( a - half, 12 );

		const shoulderEnd = half + ROAD_BED.shoulder;
		if ( a <= shoulderEnd ) {

			heights[ k ] = target;
			cutFill[ k ] = natural[ k ] - target;
			continue;

		}

		// cut / fill slope: the taller the step, the wider the blend (and never beyond half the gap to the next leg)
		const delta = natural[ k ] - target;
		const width = clamp( 1.9 * Math.abs( delta ), 7, 19 );
		const w = smoothstep( shoulderEnd, shoulderEnd + width, a );
		heights[ k ] = lerp( target, natural[ k ], w );
		cutFill[ k ] = delta * ( 1 - w );
		if ( w < 0.5 ) {

			maxCut = Math.max( maxCut, delta );
			maxFill = Math.max( maxFill, - delta );

		}

	}

	// ── 5. slope (from the final heights), then the 4 m maps
	onStage( 'biomes' );
	const flowMax = percentile( flow, 0.995 ) || 1;
	const splat0 = new Uint8Array( m * m * 4 ), splat1 = new Uint8Array( m * m * 4 ), fields = new Uint8Array( m * m * 4 );
	const surface = new Uint8Array( total ).fill( Surface.GRASS );
	const coverage = new Float64Array( 8 );
	const weights = new Float64Array( 8 );
	const slopeAt = ( ix, iz ) => {

		const x0 = Math.max( 0, ix - 1 ), x1 = Math.min( n - 1, ix + 1 ), z0 = Math.max( 0, iz - 1 ), z1 = Math.min( n - 1, iz + 1 );
		return Math.hypot( ( heights[ iz * n + x1 ] - heights[ iz * n + x0 ] ) / ( ( x1 - x0 ) * cell ), ( heights[ z1 * n + ix ] - heights[ z0 * n + ix ] ) / ( ( z1 - z0 ) * cell ) );

	};

	const biomeAt = ( ix, iz, out ) => {

		const k = iz * n + ix;
		const x = minX + ix * cell, z = minZ + iz * cell;
		const h = heights[ k ] - waterLevel;
		const slope = slopeAt( ix, iz ); // rise over run
		const edge = edgeDistance[ k ];
		const cut = cutFill[ k ];
		const wet = clamp( Math.log1p( 6 * flow[ Math.min( m - 1, iz >> 1 ) * m + Math.min( m - 1, ix >> 1 ) ] / flowMax ) / Math.log( 7 ), 0, 1 );
		const patch = fbm( patchNoise, x / 95, z / 95, 3, 2, 0.5 );
		const fine = fbm( patchNoise, x / 17 + 9.1, z / 17 - 4.4, 2, 2, 0.5 );

		const shore = 1 - smoothstep( 0.5, 2.1 + 0.6 * fine, h );
		const cliff = smoothstep( 0.62, 0.9, slope + 0.07 * fine );
		const rocky = smoothstep( 0.42, 0.66, slope + 0.1 * patch ) * ( 1 - cliff ) + smoothstep( 300, 460, h + 60 * patch ) * 0.8;
		const shoulder = 1 - smoothstep( ROAD_BED.shoulder - 0.6, ROAD_BED.shoulder + 1.2, edge );
		const scree = smoothstep( 0.34, 0.5, slope ) * ( 1 - smoothstep( 0.6, 0.75, slope ) ) * smoothstep( 0.05, 0.45, patch + 0.3 );
		const cutSlope = smoothstep( 1.2, 4, cut ) * smoothstep( 0.35, 0.6, slope );
		const fillSlope = smoothstep( 1.0, 3.5, - cut );
		const verge = ( 1 - smoothstep( ROAD_BED.shoulder + 1, ROAD_BED.shoulder + 5.5, edge ) ) * ( 1 - shoulder );

		// forest: clumps on moderate slopes below the tree line, never near the road, on the shore or on bare rock
		const region = 0.12 * smoothstep( 40, - 200, z ) + 0.16 * smoothstep( 420, 640, x ) * smoothstep( 330, 100, z ) - 0.1 * smoothstep( 60, 0, h );
		const clump = fbm( forestNoise, x / 300, z / 300, 4, 2, 0.52 ) + region;
		let forest = smoothstep( - 0.02, 0.2, clump ) * ( 1 - smoothstep( 0.5, 0.72, slope ) ) * ( 1 - smoothstep( 300, 380, h + 40 * patch ) )
			* smoothstep( 9, 20, edge ) * smoothstep( 2.5, 6, h ) * ( 1 - fillSlope ) * ( 1 - cutSlope );
		forest = clamp( forest, 0, 1 );

		const dry = clamp( smoothstep( 0.26, 0.46, slope ) * 0.7 + smoothstep( 0.1, 0.45, - patch ) * 0.55 + smoothstep( 150, 300, h ) * 0.5 - 0.5 * wet, 0, 1 );

		// layer weights before normalisation
		const gravel = Math.max( shoulder, scree * 0.9, cutSlope * 0.5 );
		const rockCliff = Math.max( cliff, cutSlope * 0.75 );
		const dirt = Math.max( verge * 0.55, fillSlope * 0.6, forest * 0.25 * smoothstep( 0.1, 0.5, fine ) );
		const hard = clamp( Math.max( gravel, rockCliff, rocky, shore ), 0, 1 );
		const soft = 1 - hard;
		out[ 0 ] = soft * ( 1 - forest ) * ( 1 - dry ) * ( 1 - dirt ); // grass_meadow
		out[ 1 ] = soft * ( 1 - forest ) * dry * ( 1 - dirt ); // grass_dry
		out[ 2 ] = soft * forest * ( 1 - dirt ); // forest_floor
		out[ 3 ] = soft * dirt; // dirt
		out[ 4 ] = gravel * ( 1 - shore ); // gravel
		out[ 5 ] = rockCliff * ( 1 - shore ) * ( 1 - shoulder ); // rock_cliff
		out[ 6 ] = rocky * ( 1 - shore ) * ( 1 - shoulder ); // rock_ground
		out[ 7 ] = shore; // shore
		let sum = 0;
		for ( let i = 0; i < 8; i ++ ) sum += out[ i ];
		for ( let i = 0; i < 8; i ++ ) out[ i ] /= sum || 1;

		out.forest = forest;
		out.meadow = clamp( ( out[ 0 ] + 0.4 * out[ 1 ] ) * smoothstep( - 0.25, 0.35, fbm( patchNoise, x / 55 - 20, z / 55 + 13, 2, 2, 0.5 ) ) * smoothstep( 3, 8, edge ), 0, 1 );
		out.wet = clamp( Math.max( wet, 1 - smoothstep( 0.3, 3, h ) ), 0, 1 );
		out.edge = edge;
		return out;

	};

	const quantise = ( src, dst, at ) => {

		// largest-remainder rounding so that the four + four weights always add up to exactly 255
		let used = 0, big = 0;
		for ( let i = 0; i < 8; i ++ ) {

			const v = Math.floor( src[ i ] * 255 );
			dst[ i ] = v;
			used += v;
			if ( src[ i ] > src[ big ] ) big = i;

		}

		dst[ big ] += 255 - used;
		for ( let i = 0; i < 4; i ++ ) {

			splat0[ at + i ] = dst[ i ];
			splat1[ at + i ] = dst[ 4 + i ];

		}

	};

	const bytes = new Uint8Array( 8 );
	for ( let j = 0; j < m; j ++ ) {

		for ( let i = 0; i < m; i ++ ) {

			const b = biomeAt( i * MAP_STEP, j * MAP_STEP, weights );
			const at = ( j * m + i ) * 4;
			quantise( b, bytes, at );
			for ( let c = 0; c < 8; c ++ ) coverage[ c ] += b[ c ];
			fields[ at ] = Math.round( b.forest * 255 );
			fields[ at + 1 ] = Math.round( b.meadow * 255 );
			fields[ at + 2 ] = Math.round( b.wet * 255 );
			fields[ at + 3 ] = Math.round( clamp( b.edge / 64, 0, 1 ) * 255 );

		}

	}

	// ── 6. physics surface grid at full resolution
	onStage( 'surfaces' );
	for ( let iz = 0; iz < n; iz ++ ) {

		for ( let ix = 0; ix < n; ix ++ ) {

			const k = iz * n + ix;
			if ( heights[ k ] < waterLevel - 0.05 ) {

				surface[ k ] = Surface.WATER;
				continue;

			}

			const b = biomeAt( ix, iz, weights );
			let best = 0;
			for ( let i = 1; i < 8; i ++ ) if ( b[ i ] > b[ best ] ) best = i;
			surface[ k ] = [ Surface.GRASS, Surface.GRASS, Surface.DIRT, Surface.DIRT, Surface.GRAVEL, Surface.ROCK, Surface.ROCK, Surface.SAND ][ best ];

		}

	}

	// ── 7. the far ring (visual only); agrees with the inner grid at the border because detail fades out there
	onStage( 'far ring' );
	const outerN = Math.round( WORLD.outerSize / WORLD.outerCell ) + 1;
	const outerMin = - WORLD.outerSize / 2;
	const outerHeights = new Float32Array( outerN * outerN );
	for ( let iz = 0; iz < outerN; iz ++ ) {

		const z = outerMin + iz * WORLD.outerCell;
		for ( let ix = 0; ix < outerN; ix ++ ) {

			const x = outerMin + ix * WORLD.outerCell;
			const beyond = Math.max( Math.abs( x - ( minX + size / 2 ) ), Math.abs( z - ( minZ + size / 2 ) ) ) - size / 2;
			const grow = smoothstep( 0, 900, beyond );
			const base = baseHeight( x, z );
			const sharp = ( ridged( rockNoise, x / 1500, z / 1500, 4, 2.05, 0.5 ) - 0.5 ) * 210 + fbm( detailNoise, x / 520, z / 520, 3, 2, 0.5 ) * 60;
			outerHeights[ iz * outerN + ix ] = base + sharp * grow * smoothstep( 60, 500, base );

		}

	}

	let min = Infinity, max = - Infinity;
	for ( let k = 0; k < total; k ++ ) {

		if ( heights[ k ] < min ) min = heights[ k ];
		if ( heights[ k ] > max ) max = heights[ k ];

	}

	const names = [ 'grass_meadow', 'grass_dry', 'forest_floor', 'dirt', 'gravel', 'rock_cliff', 'rock_ground', 'shore' ];
	const biomeCoverage = {};
	names.forEach( ( name, i ) => {

		biomeCoverage[ name ] = Math.round( coverage[ i ] / ( m * m ) * 1000 ) / 10;

	} );

	return {
		n, heights, surface, mapSize: m, splat0, splat1, fields, outerN, outerHeights,
		stats: { minHeight: min, maxHeight: max, maxCut, maxFill, biomeCoverage },
	};

}

/** Value below which the given fraction of the samples lies (approximate, via a sample of the array). */
function percentile( array, fraction ) {

	const sample = [];
	const stride = Math.max( 1, Math.floor( array.length / 40000 ) );
	for ( let i = 0; i < array.length; i += stride ) sample.push( array[ i ] );
	sample.sort( ( a, b ) => a - b );
	return sample[ Math.min( sample.length - 1, Math.floor( sample.length * fraction ) ) ];

}

/**
 * Hydraulic erosion by simulated water droplets. Modifies `map` (m * m heights in meters) in place and returns how often
 * each cell was visited (a cheap flow-accumulation map used for wetness).
 */
function erode( map, m, cellSize, waterLevel, seed ) {

	const rng = makeRng( seed );
	const flow = new Float32Array( m * m );
	const droplets = Math.round( m * m * 0.42 );
	const inertia = 0.06, capacityFactor = 5, minCapacity = 0.012, erodeSpeed = 0.28, depositSpeed = 0.3, evaporate = 0.018, gravity = 4, lifetime = 56;
	const scale = 1 / cellSize; // work in cell units so that slopes are dimensionless

	// erosion brush (radius 3 cells)
	const radius = 3;
	const brush = [];
	let brushSum = 0;
	for ( let dy = - radius; dy <= radius; dy ++ ) for ( let dx = - radius; dx <= radius; dx ++ ) {

		const w = Math.max( 0, 1 - Math.hypot( dx, dy ) / radius );
		if ( w > 0 ) {

			brush.push( dx, dy, w );
			brushSum += w;

		}

	}

	for ( let it = 0; it < droplets; it ++ ) {

		let px = rng() * ( m - 3 ) + 1, py = rng() * ( m - 3 ) + 1;
		let dirX = 0, dirY = 0, speed = 1, water = 1, sediment = 0;
		for ( let life = 0; life < lifetime; life ++ ) {

			const nx = Math.floor( px ), ny = Math.floor( py );
			const u = px - nx, v = py - ny;
			const a = ny * m + nx;
			const h00 = map[ a ] * scale, h10 = map[ a + 1 ] * scale, h01 = map[ a + m ] * scale, h11 = map[ a + m + 1 ] * scale;
			const gx = ( h10 - h00 ) * ( 1 - v ) + ( h11 - h01 ) * v;
			const gy = ( h01 - h00 ) * ( 1 - u ) + ( h11 - h10 ) * u;
			const height = h00 * ( 1 - u ) * ( 1 - v ) + h10 * u * ( 1 - v ) + h01 * ( 1 - u ) * v + h11 * u * v;
			if ( height / scale < waterLevel ) break; // reached the lake

			dirX = dirX * inertia - gx * ( 1 - inertia );
			dirY = dirY * inertia - gy * ( 1 - inertia );
			const len = Math.hypot( dirX, dirY );
			if ( len < 1e-9 ) break;
			dirX /= len;
			dirY /= len;
			px += dirX;
			py += dirY;
			if ( px < 1 || px >= m - 2 || py < 1 || py >= m - 2 ) break;
			flow[ a ] += water;

			const mx = Math.floor( px ), my = Math.floor( py );
			const s = px - mx, t = py - my;
			const b = my * m + mx;
			const newHeight = ( map[ b ] * ( 1 - s ) * ( 1 - t ) + map[ b + 1 ] * s * ( 1 - t ) + map[ b + m ] * ( 1 - s ) * t + map[ b + m + 1 ] * s * t ) * scale;
			const dh = newHeight - height;

			const capacity = Math.max( - dh * speed * water * capacityFactor, minCapacity );
			if ( sediment > capacity || dh > 0 ) {

				// deposit: fill the pit when moving uphill, otherwise drop the surplus
				const amount = dh > 0 ? Math.min( dh, sediment ) : ( sediment - capacity ) * depositSpeed;
				sediment -= amount;
				const d = amount / scale;
				map[ a ] += d * ( 1 - u ) * ( 1 - v );
				map[ a + 1 ] += d * u * ( 1 - v );
				map[ a + m ] += d * ( 1 - u ) * v;
				map[ a + m + 1 ] += d * u * v;

			} else {

				const amount = Math.min( ( capacity - sediment ) * erodeSpeed, - dh );
				for ( let q = 0; q < brush.length; q += 3 ) {

					const ex = nx + brush[ q ], ey = ny + brush[ q + 1 ];
					if ( ex < 0 || ex >= m || ey < 0 || ey >= m ) continue;
					map[ ey * m + ex ] -= amount * brush[ q + 2 ] / brushSum / scale;

				}

				sediment += amount;

			}

			speed = Math.sqrt( Math.max( 0, speed * speed - dh * gravity ) );
			water *= 1 - evaporate;

		}

	}

	return flow;

}
