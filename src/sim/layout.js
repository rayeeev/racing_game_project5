// The circuit and its landscape as DATA: world extents, the macro terrain function and the road layout.
// Everything else (src/sim/track.js, the terrain bake, the road mesh, the AI driver ...) derives from this module.
//
// Iterate with:   node tools/check-layout.mjs        (metrics, violations, corner table)
//                 node tools/render-map.mjs <outDir>  (map, wide map, elevation profile, curvature / speed plots)

import { smoothstep } from '../core/math.js';
import { createNoise2D, fbm, ridged } from './noise.js';

/**
 * World extents. The playable square (terrain collision, road, props) is centred on the origin; the outer ring is
 * visual-only scenery.
 * @property {number} size        edge length of the playable square in meters
 * @property {number} cell        height / surface grid cell size of the playable square in meters
 * @property {number} minX        world x of grid column 0
 * @property {number} minZ        world z of grid row 0
 * @property {number} waterLevel  y of the lake surface
 * @property {number} seed        master seed of every procedural element of the world
 * @property {number} outerSize   edge length of the far, visual-only terrain in meters
 * @property {number} outerCell   grid cell size of the far terrain in meters
 */
export const WORLD = Object.freeze( {
	size: 3072,
	cell: 2,
	minX: - 1536,
	minZ: - 1536,
	waterLevel: 0,
	seed: 20261117,
	outerSize: 24576,
	outerCell: 48,
} );

const warpNoise = createNoise2D( WORLD.seed );
const hillNoise = createNoise2D( WORLD.seed + 1 );
const ridgeNoise = createNoise2D( WORLD.seed + 2 );
const massNoise = createNoise2D( WORLD.seed + 3 );

/** Smooth ramp: 0 for u << 0, u for u >> 0, rounded over about k meters (a "soft plus"). */
function ramp( u, k ) {

	const v = u / k;
	return v > 30 ? u : k * Math.log1p( Math.exp( v ) );

}

// Lake: a rounded-rectangle basin whose long north shore runs beside the start / finish straight.
const LAKE = { x: 20, z: 478, a: 475, b: 285, power: 2.6, depth: 36 };
// Height of the valley floor (the meadow bench that carries the lakeside road) above the water.
const BENCH = 4.6;

/**
 * Macro terrain height in meters at any world position (also far outside the playable square).
 * Deterministic and smooth at the ~10 m scale; fine detail and erosion are added by the terrain bake.
 *
 * The valley, as the road sees it:
 *   - a lake in the valley floor, a level meadow bench around it;
 *   - NORTH of the lake the mountain flank: a gentle apron, a steep face (where the switchbacks climb), then a shelf at
 *     about +120 m (the ridge road), and behind it the wall of the massif rising to 600 m and more;
 *   - in the EAST the same height is lost over a longer, gentler south-facing slope (the fast descent);
 *   - rolling foothills west, south and east of the valley floor, and a ring of high alpine peaks far outside.
 * @param {number} x world x in meters
 * @param {number} z world z in meters (north is -z)
 * @returns {number} terrain height in meters (the lake surface is at WORLD.waterLevel)
 */
export function baseHeight( x, z ) {

	// ── lake basin (organic outline through a gentle domain warp)
	const wx = x + 38 * warpNoise( x / 520 + 3.1, z / 520 - 8.7 ) - LAKE.x;
	const wz = z + 38 * warpNoise( x / 520 - 14.2, z / 520 + 5.3 ) - LAKE.z;
	const q = Math.pow( Math.pow( Math.abs( wx ) / LAKE.a, LAKE.power ) + Math.pow( Math.abs( wz ) / LAKE.b, LAKE.power ), 1 / LAKE.power ); // 1 on the shore

	// ── the north flank. East of x ~ 500 its foot swings south and the face becomes one long, gentler slope.
	// The whole flank meanders: its foot line, face and shelf are displaced by a slow warp (nothing in nature is ruled).
	const bend = 46 * warpNoise( x / 760 + 40.3, z / 1300 + 9.1 ) + 16 * warpNoise( x / 290 - 3.3, z / 420 + 17.9 );
	const zf = z + bend;
	const east = smoothstep( 400, 700, x + 0.6 * bend );
	const tWest = 70 - zf; // meters north of the western foot line
	const tEast = 345 - zf;
	const west = 0.08 * ramp( tWest, 25 ) + 0.14 * ramp( tWest - 150, 30 ) - 0.2 * ramp( tWest - 560, 40 );
	const eastSlope = 0.116 * ramp( tEast, 40 ) - 0.096 * ramp( tEast - 835, 50 );
	// A low swell on the shelf under the ridge road (its top is the blind crest).
	const swell = 6 * Math.exp( - ( ( ( x + 30 ) / 170 ) ** 2 ) ) * smoothstep( - 430, - 520, zf ) * smoothstep( - 760, - 640, zf );
	// The massif behind the shelf.
	const massif = 0.52 * ramp( - 760 - zf, 120 ) - 0.5 * ramp( - 1700 - zf, 160 );
	const flank = west + ( eastSlope - west ) * east + swell + massif * ( 0.85 + 0.3 * massNoise( x / 1500, 0.37 ) );

	// ── foothills around the rest of the valley floor
	const outside = Math.hypot( Math.max( Math.abs( x + 0.8 * bend ) - 960, 0 ), Math.max( z + bend - 830, 0 ) );
	const hillMask = smoothstep( 0, 620, outside );
	const foothills = ( 62 + 46 * fbm( hillNoise, x / 780, z / 780, 3, 2, 0.5 ) ) * hillMask;

	// ── the far ring of alpine peaks (visual only)
	const r = Math.hypot( x, z );
	const far = smoothstep( 1750, 5600, r );
	const peaks = ( 760 + 380 * massNoise( x / 6100 + 7.7, z / 6100 - 2.9 ) + 500 * ridged( ridgeNoise, x / 5600, z / 5600, 2, 2, 0.42 ) ) * far;

	// ── gentle undulation everywhere, stronger away from the valley floor
	const roll = fbm( hillNoise, x / 420 + 31.4, z / 420 - 12.9, 2, 2, 0.5 ) * ( 1.6 + 2.4 * smoothstep( 80, 400, tWest ) + 14 * hillMask + 60 * far );

	const land = BENCH * smoothstep( 1, 1.055, q ) + flank + foothills + peaks + roll * smoothstep( 1, 1.2, q );
	if ( q >= 1 ) return WORLD.waterLevel + land;
	// lake bed: shelving shore, then the deep basin
	const inside = 1 - q;
	return WORLD.waterLevel - LAKE.depth * smoothstep( 0, 0.5, inside ) * ( 0.75 + 0.25 * smoothstep( 0.2, 0.9, inside ) ) - 0.6 * smoothstep( 0, 0.03, inside );

}

/**
 * The road layout.
 *
 * controlPoints ... the closed centreline passes (almost exactly) through these points in order; the order is the
 *                   driving direction and control point 0 is the start / finish line (s = 0). Per point:
 *                     x, z ........ world position in meters
 *                     y ........... optional explicit road height in meters (otherwise the road follows the terrain)
 *                     width ....... optional paved width in meters at this point (otherwise defaultWidth)
 *                     bank ........ optional banking override in rad at this point (positive = left edge lower)
 *                     crestRadius . optional local override of elevation.minCrestRadius and maxCrestG (for one deliberate crest)
 *                     name ........ optional label shown on the debug map
 * defaultWidth .... paved width in meters where no control point overrides it
 * smoothing ....... standard deviation in meters of the Gaussian that rounds the horizontal curve (continuous curvature)
 * gridOffset ...... the rolling start spawns this many meters before the line
 * checkpointSpacing approximate distance between lap-validation checkpoints in meters
 * sectors ......... lap fractions where the three sectors start
 * corners ......... named corners: { name, s } with s in meters, or { name, cp, offset? } relative to a control point
 * elevation ....... how the height profile y(s) is derived:
 *                     smoothing ........ Gaussian standard deviation in meters applied to the terrain height under the route
 *                     offset ........... the road sits this many meters above the smoothed terrain
 *                     terrainFollow .... 1 = follow the smoothed terrain between explicit heights, 0 = interpolate explicit heights only
 *                     minHeight ........ minimum road height above WORLD.waterLevel in meters
 *                     maxGrade ......... limit of |dy/ds|
 *                     minCrestRadius ... minimum vertical radius over crests in meters
 *                     maxCrestG ........ crests are also flattened until v^2 / R stays below this many g at the estimated speed
 *                     minSagRadius ..... minimum vertical radius through dips in meters
 *                     maxSagG .......... dips are also flattened until v^2 / R stays below this many g at the estimated speed
 *                     finalSmoothing ... Gaussian standard deviation in meters of the last smoothing pass over the limited profile
 *                     crestSpan ........ length in meters around a control point over which its crestRadius override applies
 *                     relaxedCrestG .... ... where v^2 / R may reach this many g instead of maxCrestG (the car goes light but stays down)
 * banking ......... bank = maxDeg * tanh( gain * curvature / maxDeg ) (gain in rad per 1/m), smoothed over `smoothing` meters
 */
export const LAYOUT = Object.freeze( {
	name: 'Alpenglow',
	closed: true,
	controlPoints: [
		// lakeside straight, driven westward (lake on the left)
		{ x: 150, z: 170, width: 11, name: 'Start' },
		{ x: - 90, z: 166, width: 11 },
		{ x: - 320, z: 170, width: 11 },
		// kink and the right-hander that leaves the lake
		{ x: - 455, z: 156, name: 'Lakeside Kink' },
		{ x: - 548, z: 112 },
		{ x: - 590, z: 40, name: 'Farewell' },
		// up the apron, then left onto the face
		{ x: - 596, z: - 35 },
		{ x: - 622, z: - 98 },
		{ x: - 690, z: - 130 },
		// hairpin 1 (right)
		{ x: - 740, z: - 139, width: 10, bank: - 0.03 },
		{ x: - 755, z: - 145, width: 10, bank: - 0.03 },
		{ x: - 761, z: - 160, width: 10, bank: - 0.03, name: 'First Light' },
		{ x: - 755, z: - 175, width: 10, bank: - 0.03 },
		{ x: - 740, z: - 181, width: 10, bank: - 0.03 },
		{ x: - 565, z: - 240 },
		// hairpin 2 (left)
		{ x: - 380, z: - 314, width: 10, bank: 0.03 },
		{ x: - 365, z: - 320, width: 10, bank: 0.03 },
		{ x: - 359, z: - 335, width: 10, bank: 0.03, name: 'Eagle\'s Turn' },
		{ x: - 365, z: - 350, width: 10, bank: 0.03 },
		{ x: - 380, z: - 356, width: 10, bank: 0.03 },
		{ x: - 545, z: - 418 },
		// hairpin 3 (right) onto the shelf
		{ x: - 712, z: - 476, width: 10, bank: - 0.03 },
		{ x: - 727, z: - 482, width: 10, bank: - 0.03 },
		{ x: - 733, z: - 497, width: 10, bank: - 0.03, name: 'Skyhook' },
		{ x: - 727, z: - 512, width: 10, bank: - 0.03 },
		{ x: - 712, z: - 518, width: 10, bank: - 0.03 },
		// the ridge: a fast flowing half, the blind crest, then a tighter chicane before the descent
		{ x: - 560, z: - 548 },
		{ x: - 380, z: - 528 },
		{ x: - 200, z: - 557 },
		{ x: - 20, z: - 535, crestRadius: 160, name: 'The Crest' },
		{ x: 130, z: - 519 },
		{ x: 255, z: - 556, name: 'Chamois' },
		{ x: 380, z: - 521 },
		{ x: 505, z: - 548 },
		// the descent: long sweepers down the east slope
		{ x: 690, z: - 470 },
		{ x: 850, z: - 335, name: 'Larch Sweep' },
		{ x: 845, z: - 225 },
		{ x: 705, z: - 120 },
		{ x: 580, z: - 30, name: 'The Dip' },
		{ x: 545, z: 60 },
		{ x: 610, z: 140 },
		{ x: 730, z: 200 },
		// the last hairpin, the boulder esses and back onto the straight
		{ x: 808, z: 252, width: 10 },
		{ x: 822, z: 292, width: 10, name: 'Lakehead' },
		{ x: 790, z: 326, width: 10 },
		{ x: 690, z: 322 },
		{ x: 585, z: 262, name: 'Boulder Esses' },
		{ x: 492, z: 204 },
		{ x: 400, z: 174, width: 11, name: 'Home' },
	],
	defaultWidth: 9,
	smoothing: 4,
	gridOffset: 120,
	checkpointSpacing: 150,
	sectors: [ 0, 0.36, 0.62 ],
	corners: [
		{ name: 'Lakeside Kink', cp: 3 },
		{ name: 'Farewell', cp: 5 },
		{ name: 'First Light', cp: 11 },
		{ name: 'Eagle\'s Turn', cp: 17 },
		{ name: 'Skyhook', cp: 23 },
		{ name: 'The Crest', cp: 29 },
		{ name: 'Chamois', cp: 31 },
		{ name: 'Larch Sweep', cp: 35 },
		{ name: 'The Dip', cp: 38 },
		{ name: 'Lakehead', cp: 43 },
		{ name: 'Boulder Esses', cp: 46 },
		{ name: 'Home', cp: 48 },
	],
	elevation: {
		smoothing: 45,
		offset: 0.4,
		terrainFollow: 1,
		minHeight: 3.5,
		maxGrade: 0.1,
		minCrestRadius: 350,
		maxCrestG: 0.7,
		minSagRadius: 220,
		maxSagG: 1.5,
		crestSpan: 120,
		relaxedCrestG: 0.8,
		finalSmoothing: 5,
	},
	banking: { gain: 6, maxDeg: 6, smoothing: 10 },
} );
