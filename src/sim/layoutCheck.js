// Design-rule check of a circuit: measures a built Track against the hard constraints of the game and estimates how
// it drives (corner list, speed profile, lap time). Pure functions of their arguments: no globals, no I/O.
//
// Report with:  node tools/check-layout.mjs

import { GRAVITY } from './constants.js';
import { loopDelta, mod, RAD2DEG } from '../core/math.js';
import { SPEED_MODEL, estimateSpeedProfile } from './track.js';

export { SPEED_MODEL, estimateSpeedProfile };

/**
 * The hard constraints. Lengths in meters, speeds in m/s.
 * @property {number} minLength / maxLength ....... allowed centreline length
 * @property {number} separationArc ............... two centreline points farther apart than this along the road ...
 * @property {number} minSeparation ............... ... must be more than this far apart in plan view
 * @property {number} minRadius ................... minimum horizontal radius anywhere (inside hairpins)
 * @property {number} minRadiusOutsideHairpins .... minimum horizontal radius everywhere else
 * @property {number} hairpinAngle ................ a corner turning at least this many degrees counts as a hairpin
 * @property {number} maxGrade .................... limit of |dy/ds|
 * @property {number} minCrestRadius .............. minimum vertical radius over crests ...
 * @property {number} relaxedCrests ............... ... except on this many deliberate crests
 * @property {number} maxCrestG ................... limit of v^2 / R over any crest at the estimated speed, in g
 * @property {number} minHeightAboveWater ......... both road edges must stay this far above the water level
 * @property {number} minBorderMargin ............. distance the road edges keep from the border of the playable square
 * @property {number} minWidth / maxWidth ......... allowed paved width
 * @property {number} startWidth .................. paved width from the grid position to the start line
 * @property {number} hairpinWidth ................ paved width at the apex of a hairpin
 * @property {number} widthTolerance .............. tolerance of the three width rules above
 * @property {number} maxWidthRate ................ limit of |d width / ds| (smooth transitions)
 */
export const LIMITS = Object.freeze( {
	minLength: 4600,
	maxLength: 5400,
	separationArc: 120,
	minSeparation: 38,
	minRadius: 16,
	minRadiusOutsideHairpins: 30,
	hairpinAngle: 120,
	maxGrade: 0.11,
	minCrestRadius: 300,
	relaxedCrests: 1,
	maxCrestG: 0.85,
	minHeightAboveWater: 2.5,
	minBorderMargin: 350,
	minWidth: 9,
	maxWidth: 11,
	startWidth: 11,
	hairpinWidth: 10,
	widthTolerance: 0.1,
	maxWidthRate: 0.05,
} );

const CORNER_CURVATURE = 1 / 300; // 1/m; the road counts as a corner where it turns tighter than this
const CORNER_MERGE_GAP = 20; // m; same-direction corner pieces closer than this are one corner
const CORNER_MIN_ANGLE = 4; // degrees; shorter wiggles are not listed
const CREST_MERGE_GAP = 40; // m; crest samples closer than this belong to the same crest
const SEPARATION_CELL = 80; // m; minSeparation is measured exactly up to this distance
const EDGE_OFFSET = 12; // m; lateral offset at which cut and fill are measured besides the centreline

/**
 * A corner found in the curvature profile.
 * @typedef {Object} DetectedCorner
 * @property {number} s           s of the apex (tightest point)
 * @property {number} start       s where the corner begins
 * @property {number} end         s where the corner ends
 * @property {number} radius      minimum radius in meters
 * @property {string} direction   'L' or 'R'
 * @property {number} angle       total heading change in degrees (positive)
 * @property {boolean} hairpin    turns at least LIMITS.hairpinAngle degrees
 * @property {number} entrySpeed  highest estimated speed on the approach (since the previous apex) in m/s
 * @property {number} minSpeed    lowest estimated speed in the corner in m/s
 * @property {number} exitSpeed   estimated speed where the corner ends in m/s
 * @property {number} width       paved width at the apex in meters
 */

/**
 * Finds the corners of a track from its curvature.
 * @param {import('./track.js').Track} track
 * @param {Float32Array} speedProfile estimateSpeedProfile( track )
 * @param {typeof LIMITS} [limits]
 * @returns {DetectedCorner[]} in driving order from s = 0
 */
export function detectCorners( track, speedProfile, limits = LIMITS ) {

	const count = track.count, curvatures = track.curvatures;
	const side = ( i ) => ( curvatures[ i ] > CORNER_CURVATURE ? 1 : curvatures[ i ] < - CORNER_CURVATURE ? - 1 : 0 );
	// Start scanning on a straight so that no corner is split by the seam.
	let origin = 0;
	while ( origin < count && side( origin ) !== 0 ) origin ++;
	if ( origin === count ) origin = 0;

	const runs = [];
	let current = null;
	for ( let step = 0; step < count; step ++ ) {

		const i = ( origin + step ) % count;
		const sign = side( i );
		if ( current && sign !== current.sign ) {

			runs.push( current );
			current = null;

		}

		if ( sign !== 0 ) {

			if ( ! current ) current = { sign, first: origin + step, last: origin + step };
			current.last = origin + step;

		}

	}

	if ( current ) runs.push( current );

	// Merge pieces of the same direction that are separated by a short straighter bit.
	const merged = [];
	for ( const run of runs ) {

		const previous = merged[ merged.length - 1 ];
		if ( previous && previous.sign === run.sign && run.first - previous.last <= CORNER_MERGE_GAP ) previous.last = run.last;
		else merged.push( { ...run } );

	}

	const corners = [];
	for ( const run of merged ) {

		let angle = 0, apex = run.first, tightest = 0, minSpeed = Infinity;
		for ( let p = run.first; p <= run.last; p ++ ) {

			const i = p % count;
			angle += curvatures[ i ] * track.spacing;
			if ( Math.abs( curvatures[ i ] ) > tightest ) {

				tightest = Math.abs( curvatures[ i ] );
				apex = p;

			}

			minSpeed = Math.min( minSpeed, speedProfile[ i ] );

		}

		const degrees = Math.abs( angle ) * RAD2DEG;
		if ( degrees < CORNER_MIN_ANGLE ) continue;
		corners.push( {
			s: apex % count,
			start: run.first % count,
			end: run.last % count,
			radius: 1 / tightest,
			direction: run.sign > 0 ? 'L' : 'R',
			angle: degrees,
			hairpin: degrees >= limits.hairpinAngle,
			entrySpeed: 0,
			minSpeed,
			exitSpeed: speedProfile[ run.last % count ],
			width: 2 * track.halfWidths[ apex % count ],
		} );

	}

	corners.sort( ( a, b ) => a.s - b.s );
	for ( let c = 0; c < corners.length; c ++ ) {

		const corner = corners[ c ];
		const previousApex = corners.length > 1 ? corners[ ( c + corners.length - 1 ) % corners.length ].s : corner.s + 1;
		const span = mod( corner.s - previousApex, count ) || count;
		let fastest = 0;
		for ( let o = 0; o <= span; o ++ ) fastest = Math.max( fastest, speedProfile[ mod( corner.s - o, count ) ] );
		corner.entrySpeed = fastest;

	}

	return corners;

}

/**
 * Closest approach of two different parts of the centreline, and the number of places where it crosses itself.
 * @param {import('./track.js').Track} track
 * @param {number} separationArc only pairs farther apart than this along the road are measured
 * @returns {{minSeparation: number, sA: number, sB: number, selfIntersections: number, crossingS: number}}
 *          minSeparation is capped at 80 m (the search radius)
 */
function measureSeparation( track, separationArc ) {

	const count = track.count, xs = track.xs, zs = track.zs;
	const cells = new Map();
	const keyOf = ( cx, cz ) => cx * 100003 + cz;
	for ( let i = 0; i < count; i ++ ) {

		const key = keyOf( Math.floor( xs[ i ] / SEPARATION_CELL ), Math.floor( zs[ i ] / SEPARATION_CELL ) );
		let list = cells.get( key );
		if ( ! list ) cells.set( key, ( list = [] ) );
		list.push( i );

	}

	let best2 = SEPARATION_CELL * SEPARATION_CELL, sA = - 1, sB = - 1, selfIntersections = 0, crossingS = - 1;
	for ( let i = 0; i < count; i ++ ) {

		const cx = Math.floor( xs[ i ] / SEPARATION_CELL ), cz = Math.floor( zs[ i ] / SEPARATION_CELL );
		const i1 = ( i + 1 ) % count;
		for ( let ox = - 1; ox <= 1; ox ++ ) {

			for ( let oz = - 1; oz <= 1; oz ++ ) {

				const list = cells.get( keyOf( cx + ox, cz + oz ) );
				if ( ! list ) continue;
				for ( const j of list ) {

					if ( j <= i ) continue;
					const arc = Math.abs( loopDelta( i, j, count ) ) * track.spacing;
					const d2 = ( xs[ i ] - xs[ j ] ) ** 2 + ( zs[ i ] - zs[ j ] ) ** 2;
					if ( arc > separationArc && d2 < best2 ) {

						best2 = d2;
						sA = i;
						sB = j;

					}

					if ( arc >= 2 && d2 < 4 && segmentsCross( xs, zs, i, i1, j, ( j + 1 ) % count ) ) {

						selfIntersections ++;
						crossingS = i;

					}

				}

			}

		}

	}

	return { minSeparation: Math.sqrt( best2 ), sA, sB, selfIntersections, crossingS };

}

/** True when the plan-view segments a0-a1 and b0-b1 properly intersect. */
function segmentsCross( xs, zs, a0, a1, b0, b1 ) {

	const orient = ( p, q, r ) => ( xs[ q ] - xs[ p ] ) * ( zs[ r ] - zs[ p ] ) - ( zs[ q ] - zs[ p ] ) * ( xs[ r ] - xs[ p ] );
	const o1 = orient( a0, a1, b0 ), o2 = orient( a0, a1, b1 ), o3 = orient( b0, b1, a0 ), o4 = orient( b0, b1, a1 );
	return ( o1 > 0 ) !== ( o2 > 0 ) && ( o3 > 0 ) !== ( o4 > 0 );

}

/**
 * A broken design rule.
 * @typedef {Object} Violation
 * @property {string} rule     rule id ('length', 'separation', 'minRadius', 'grade', 'crestRadius' ...)
 * @property {number} value    measured value
 * @property {number} limit    the limit it breaks
 * @property {number} s        where on the lap (meters), or -1 when the rule is not local
 * @property {string} message  human-readable description
 */

/**
 * Checks a track against the hard constraints and estimates how it drives.
 * @param {import('./track.js').Track} track the built track
 * @param {{size: number, minX: number, minZ: number, waterLevel: number}} world WORLD from src/sim/layout.js
 * @param {(x: number, z: number) => number} baseHeight macro terrain function (for cut / fill)
 * @param {typeof LIMITS} [limits] override of the constraint values
 * @returns {{ok: boolean, metrics: Object<string, number>, violations: Violation[], corners: DetectedCorner[],
 *            speedProfile: Float32Array, estimatedLapTime: number}}
 *          metrics: length, minRadius, minRadiusS, minRadiusOutsideHairpins, minRadiusOutsideHairpinsS, hairpins,
 *          maxGrade, maxGradeS, minCrestRadius, minCrestRadiusS, sharpCrests, maxCrestG, maxCrestGS, minSagRadius,
 *          maxSagG, minSeparation (capped at 80), minSeparationS, minSeparationS2, selfIntersections,
 *          minHeightAboveWater, minHeightAboveWaterS, minHeight, maxHeight, minBorderMargin, minBorderMarginS, maxCut,
 *          maxCutS, maxFill, maxFillS, minWidth, maxWidth, minStartWidth, maxWidthRate, maxBankDeg, topSpeed, minSpeed,
 *          averageSpeed (speeds in m/s, lengths in meters, "...S" = where on the lap)
 */
export function checkLayout( track, world, baseHeight, limits = LIMITS ) {

	const count = track.count, ds = track.spacing;
	const violations = [];
	const violate = ( rule, value, limit, s, message ) => violations.push( { rule, value, limit, s, message } );

	const speedProfile = estimateSpeedProfile( track );
	const corners = detectCorners( track, speedProfile, limits );
	const metrics = { length: track.length };

	if ( ! track.closed ) violate( 'closed', 0, 1, - 1, 'the layout is not a closed loop' );
	if ( track.length < limits.minLength ) violate( 'length', track.length, limits.minLength, - 1, 'the lap is too short' );
	if ( track.length > limits.maxLength ) violate( 'length', track.length, limits.maxLength, - 1, 'the lap is too long' );

	// Horizontal radius: hairpins may go down to minRadius, everything else to minRadiusOutsideHairpins.
	const inHairpin = new Uint8Array( count );
	let hairpins = 0;
	for ( const corner of corners ) {

		if ( ! corner.hairpin ) continue;
		hairpins ++;
		const span = mod( corner.end - corner.start, count );
		for ( let o = 0; o <= span; o ++ ) inHairpin[ ( corner.start + o ) % count ] = 1;

	}

	let tightest = 0, tightestS = 0, tightestOutside = 0, tightestOutsideS = 0;
	for ( let i = 0; i < count; i ++ ) {

		const k = Math.abs( track.curvatures[ i ] );
		if ( k > tightest ) {

			tightest = k;
			tightestS = i;

		}

		if ( ! inHairpin[ i ] && k > tightestOutside ) {

			tightestOutside = k;
			tightestOutsideS = i;

		}

	}

	metrics.minRadius = 1 / tightest;
	metrics.minRadiusS = tightestS;
	metrics.minRadiusOutsideHairpins = 1 / tightestOutside;
	metrics.minRadiusOutsideHairpinsS = tightestOutsideS;
	metrics.hairpins = hairpins;
	if ( metrics.minRadius < limits.minRadius ) violate( 'minRadius', metrics.minRadius, limits.minRadius, tightestS, 'corner radius too tight' );
	if ( metrics.minRadiusOutsideHairpins < limits.minRadiusOutsideHairpins ) violate( 'minRadiusOutsideHairpins', metrics.minRadiusOutsideHairpins, limits.minRadiusOutsideHairpins, tightestOutsideS, 'corner radius too tight for a corner that is not a hairpin' );

	// Grade and vertical curvature (second difference of the height profile).
	let maxGrade = 0, maxGradeS = 0, sharpestCrest = 0, sharpestCrestS = 0, sharpestSag = 0, maxCrestG = 0, maxCrestGS = 0, maxSagG = 0;
	let minHeight = Infinity, maxHeight = - Infinity;
	const sharpCrestSamples = [];
	for ( let i = 0; i < count; i ++ ) {

		const prev = ( i + count - 1 ) % count, next = ( i + 1 ) % count;
		const grade = Math.abs( track.ys[ next ] - track.ys[ i ] ) / ds;
		if ( grade > maxGrade ) {

			maxGrade = grade;
			maxGradeS = i;

		}

		const bend = ( track.ys[ prev ] - 2 * track.ys[ i ] + track.ys[ next ] ) / ( ds * ds );
		const v2 = speedProfile[ i ] * speedProfile[ i ];
		if ( bend < 0 ) {

			if ( - bend > sharpestCrest ) {

				sharpestCrest = - bend;
				sharpestCrestS = i;

			}

			if ( - bend * v2 / GRAVITY > maxCrestG ) {

				maxCrestG = - bend * v2 / GRAVITY;
				maxCrestGS = i;

			}

			if ( - bend > 1 / limits.minCrestRadius ) sharpCrestSamples.push( i );

		} else {

			sharpestSag = Math.max( sharpestSag, bend );
			maxSagG = Math.max( maxSagG, bend * v2 / GRAVITY );

		}

		minHeight = Math.min( minHeight, track.ys[ i ] );
		maxHeight = Math.max( maxHeight, track.ys[ i ] );

	}

	// Group the too-sharp crest samples into crests; the sharpest `relaxedCrests` of them are allowed.
	const crests = [];
	for ( const i of sharpCrestSamples ) {

		const last = crests[ crests.length - 1 ];
		const bend = - ( track.ys[ ( i + count - 1 ) % count ] - 2 * track.ys[ i ] + track.ys[ ( i + 1 ) % count ] ) / ( ds * ds );
		if ( last && i - last.end <= CREST_MERGE_GAP ) {

			last.end = i;
			if ( bend > last.bend ) {

				last.bend = bend;
				last.s = i;

			}

		} else {

			crests.push( { start: i, end: i, s: i, bend } );

		}

	}

	if ( crests.length > 1 && crests[ 0 ].start + count - crests[ crests.length - 1 ].end <= CREST_MERGE_GAP ) {

		// The first and the last group are the same crest, split by the seam.
		const tail = crests.pop();
		if ( tail.bend > crests[ 0 ].bend ) {

			crests[ 0 ].bend = tail.bend;
			crests[ 0 ].s = tail.s;

		}

		crests[ 0 ].start = tail.start;

	}

	crests.sort( ( a, b ) => b.bend - a.bend );
	for ( const crest of crests.slice( limits.relaxedCrests ) ) violate( 'crestRadius', 1 / crest.bend, limits.minCrestRadius, crest.s, `crest too sharp (only ${limits.relaxedCrests} crest may be sharper than the limit)` );
	metrics.maxGrade = maxGrade;
	metrics.maxGradeS = maxGradeS;
	metrics.minCrestRadius = sharpestCrest > 0 ? 1 / sharpestCrest : Infinity;
	metrics.minCrestRadiusS = sharpestCrestS;
	metrics.sharpCrests = crests.length;
	metrics.maxCrestG = maxCrestG;
	metrics.maxCrestGS = maxCrestGS;
	metrics.minSagRadius = sharpestSag > 0 ? 1 / sharpestSag : Infinity;
	metrics.maxSagG = maxSagG;
	metrics.minHeight = minHeight;
	metrics.maxHeight = maxHeight;
	if ( maxGrade > limits.maxGrade ) violate( 'grade', maxGrade, limits.maxGrade, maxGradeS, 'road too steep' );
	if ( maxCrestG > limits.maxCrestG ) violate( 'crestG', maxCrestG, limits.maxCrestG, maxCrestGS, 'the car would leave the ground over this crest at the estimated speed' );

	// Separation between different parts of the road, self-intersection.
	const separation = measureSeparation( track, limits.separationArc );
	metrics.minSeparation = separation.minSeparation;
	metrics.minSeparationS = separation.sA;
	metrics.minSeparationS2 = separation.sB;
	metrics.selfIntersections = separation.selfIntersections;
	if ( separation.selfIntersections > 0 ) violate( 'selfIntersection', separation.selfIntersections, 0, separation.crossingS, 'the centreline crosses itself' );
	if ( separation.minSeparation <= limits.minSeparation ) violate( 'separation', separation.minSeparation, limits.minSeparation, separation.sA, `two parts of the road are too close (the other one is at s = ${separation.sB})` );

	// Water clearance and border margin at both road edges; cut and fill against the macro terrain.
	const maxX = world.minX + world.size, maxZ = world.minZ + world.size;
	let minAboveWater = Infinity, minAboveWaterS = 0, minMargin = Infinity, minMarginS = 0, maxCut = - Infinity, maxCutS = 0, maxFill = - Infinity, maxFillS = 0;
	for ( let i = 0; i < count; i ++ ) {

		const x = track.xs[ i ], y = track.ys[ i ], z = track.zs[ i ], half = track.halfWidths[ i ];
		const lx = track.lefts[ i * 3 ], ly = track.lefts[ i * 3 + 1 ], lz = track.lefts[ i * 3 + 2 ];
		const lowestEdge = y - Math.abs( ly ) * half - world.waterLevel;
		if ( lowestEdge < minAboveWater ) {

			minAboveWater = lowestEdge;
			minAboveWaterS = i;

		}

		for ( let side = - 1; side <= 1; side += 2 ) {

			const ex = x + side * half * lx, ez = z + side * half * lz;
			const margin = Math.min( ex - world.minX, maxX - ex, ez - world.minZ, maxZ - ez );
			if ( margin < minMargin ) {

				minMargin = margin;
				minMarginS = i;

			}

		}

		for ( let side = - 1; side <= 1; side ++ ) {

			const d = side * EDGE_OFFSET;
			const cut = baseHeight( x + d * lx, z + d * lz ) - ( y + d * ly );
			if ( cut > maxCut ) {

				maxCut = cut;
				maxCutS = i;

			}

			if ( - cut > maxFill ) {

				maxFill = - cut;
				maxFillS = i;

			}

		}

	}

	metrics.minHeightAboveWater = minAboveWater;
	metrics.minHeightAboveWaterS = minAboveWaterS;
	metrics.minBorderMargin = minMargin;
	metrics.minBorderMarginS = minMarginS;
	metrics.maxCut = Math.max( 0, maxCut );
	metrics.maxCutS = maxCutS;
	metrics.maxFill = Math.max( 0, maxFill );
	metrics.maxFillS = maxFillS;
	if ( minAboveWater < limits.minHeightAboveWater ) violate( 'heightAboveWater', minAboveWater, limits.minHeightAboveWater, minAboveWaterS, 'road too close to the water level' );
	if ( minMargin < limits.minBorderMargin ) violate( 'borderMargin', minMargin, limits.minBorderMargin, minMarginS, 'road too close to the border of the playable square' );

	// Width rules.
	let minWidth = Infinity, minWidthS = 0, maxWidth = 0, maxWidthS = 0, maxWidthRate = 0, maxWidthRateS = 0, maxBank = 0;
	for ( let i = 0; i < count; i ++ ) {

		const width = 2 * track.halfWidths[ i ];
		if ( width < minWidth ) {

			minWidth = width;
			minWidthS = i;

		}

		if ( width > maxWidth ) {

			maxWidth = width;
			maxWidthS = i;

		}

		const rate = Math.abs( 2 * track.halfWidths[ ( i + 1 ) % count ] - width ) / ds;
		if ( rate > maxWidthRate ) {

			maxWidthRate = rate;
			maxWidthRateS = i;

		}

		maxBank = Math.max( maxBank, Math.abs( track.banks[ i ] ) );

	}

	let minStartWidth = Infinity, minStartWidthS = 0;
	for ( let o = 0; o <= track.length - track.gridS; o ++ ) {

		const i = mod( Math.round( track.gridS ) + o, count );
		if ( 2 * track.halfWidths[ i ] < minStartWidth ) {

			minStartWidth = 2 * track.halfWidths[ i ];
			minStartWidthS = i;

		}

	}

	metrics.minWidth = minWidth;
	metrics.maxWidth = maxWidth;
	metrics.minStartWidth = minStartWidth;
	metrics.maxWidthRate = maxWidthRate;
	metrics.maxBankDeg = maxBank * RAD2DEG;
	const tolerance = limits.widthTolerance;
	if ( minWidth < limits.minWidth - tolerance ) violate( 'width', minWidth, limits.minWidth, minWidthS, 'paved width too narrow' );
	if ( maxWidth > limits.maxWidth + tolerance ) violate( 'width', maxWidth, limits.maxWidth, maxWidthS, 'paved width too wide' );
	if ( minStartWidth < limits.startWidth - tolerance ) violate( 'startWidth', minStartWidth, limits.startWidth, minStartWidthS, 'the start straight (grid position to the line) must have the full start width' );
	if ( maxWidthRate > limits.maxWidthRate ) violate( 'widthTransition', maxWidthRate, limits.maxWidthRate, maxWidthRateS, 'paved width changes too abruptly' );
	for ( const corner of corners ) {

		if ( corner.hairpin && corner.width < limits.hairpinWidth - tolerance ) violate( 'hairpinWidth', corner.width, limits.hairpinWidth, corner.s, 'hairpin apex narrower than the hairpin width' );

	}

	// Speed statistics.
	let time = 0, topSpeed = 0, minSpeed = Infinity;
	for ( let i = 0; i < count; i ++ ) {

		time += 2 * ds / ( speedProfile[ i ] + speedProfile[ ( i + 1 ) % count ] );
		topSpeed = Math.max( topSpeed, speedProfile[ i ] );
		minSpeed = Math.min( minSpeed, speedProfile[ i ] );

	}

	metrics.topSpeed = topSpeed;
	metrics.minSpeed = minSpeed;
	metrics.averageSpeed = track.length / time;

	return { ok: violations.length === 0, metrics, violations, corners, speedProfile, estimatedLapTime: time };

}
