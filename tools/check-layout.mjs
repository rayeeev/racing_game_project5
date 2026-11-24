// Prints the design-rule report of the current circuit (src/sim/layout.js): metrics, violations and the corner table.
//
//   node tools/check-layout.mjs            compact report (exit code 1 when a hard constraint is violated)
//   node tools/check-layout.mjs --points   also lists every control point with its s, road height and terrain height
//   node tools/check-layout.mjs --json     machine-readable result (metrics, violations, corners, estimatedLapTime)

import { performance } from 'node:perf_hooks';
import { formatLapTime, KMH_PER_MS, RAD2DEG } from '../src/core/math.js';
import { LAYOUT, WORLD, baseHeight } from '../src/sim/layout.js';
import { LIMITS, checkLayout } from '../src/sim/layoutCheck.js';
import { Track } from '../src/sim/track.js';

const args = new Set( process.argv.slice( 2 ) );

const buildStart = performance.now();
const track = new Track( LAYOUT );
const buildMs = performance.now() - buildStart;
const checkStart = performance.now();
const result = checkLayout( track, WORLD, baseHeight );
const checkMs = performance.now() - checkStart;
const m = result.metrics;

if ( args.has( '--json' ) ) {

	console.log( JSON.stringify( { ok: result.ok, metrics: m, violations: result.violations, corners: result.corners, estimatedLapTime: result.estimatedLapTime }, null, '\t' ) );
	process.exit( result.ok ? 0 : 1 );

}

const num = ( value, digits = 1 ) => ( Number.isFinite( value ) ? value.toFixed( digits ) : String( value ) );
const kmh = ( speed ) => num( speed * KMH_PER_MS, 0 );
const at = ( s ) => `@ s=${Math.round( s )}`;
const verdict = ( pass ) => ( pass ? 'ok  ' : 'FAIL' );

/** One line of the metrics table: verdict, label, value, limit. */
function row( pass, label, value, limit = '' ) {

	console.log( `  ${pass === null ? '    ' : verdict( pass )}  ${label.padEnd( 30 )} ${String( value ).padEnd( 26 )} ${limit}` );

}

console.log( `${LAYOUT.name} - ${LAYOUT.controlPoints.length} control points - built in ${num( buildMs )} ms, checked in ${num( checkMs )} ms` );
console.log( result.ok ? 'RESULT: OK (all hard constraints met)' : `RESULT: ${result.violations.length} VIOLATION(S)` );
console.log( '' );
row( m.length >= LIMITS.minLength && m.length <= LIMITS.maxLength, 'length', `${m.length} m`, `${LIMITS.minLength} .. ${LIMITS.maxLength}` );
row( m.selfIntersections === 0, 'self-intersections', m.selfIntersections, '0' );
row( m.minSeparation > LIMITS.minSeparation, 'min separation', `${num( m.minSeparation )} m ${m.minSeparation >= 80 ? '(or more)' : `${at( m.minSeparationS )} / ${Math.round( m.minSeparationS2 )}`}`, `> ${LIMITS.minSeparation} (arc > ${LIMITS.separationArc} m)` );
row( m.minRadius >= LIMITS.minRadius, 'min radius', `${num( m.minRadius )} m ${at( m.minRadiusS )}`, `>= ${LIMITS.minRadius}` );
row( m.minRadiusOutsideHairpins >= LIMITS.minRadiusOutsideHairpins, 'min radius outside hairpins', `${num( m.minRadiusOutsideHairpins )} m ${at( m.minRadiusOutsideHairpinsS )}`, `>= ${LIMITS.minRadiusOutsideHairpins} (${m.hairpins} hairpins)` );
row( m.maxGrade <= LIMITS.maxGrade, 'max grade', `${num( m.maxGrade * 100, 2 )} % ${at( m.maxGradeS )}`, `<= ${LIMITS.maxGrade * 100} %` );
row( ! result.violations.some( ( v ) => v.rule === 'crestRadius' ), 'min crest radius', `${num( m.minCrestRadius, 0 )} m ${at( m.minCrestRadiusS )}`, `>= ${LIMITS.minCrestRadius} (${m.sharpCrests} sharper, ${LIMITS.relaxedCrests} allowed)` );
row( m.maxCrestG <= LIMITS.maxCrestG, 'max crest demand', `${num( m.maxCrestG, 2 )} g ${at( m.maxCrestGS )}`, `<= ${LIMITS.maxCrestG} g` );
row( null, 'min sag radius / max sag load', `${num( m.minSagRadius, 0 )} m / +${num( m.maxSagG, 2 )} g` );
row( m.minHeightAboveWater >= LIMITS.minHeightAboveWater, 'min height above water', `${num( m.minHeightAboveWater, 2 )} m ${at( m.minHeightAboveWaterS )}`, `>= ${LIMITS.minHeightAboveWater}` );
row( null, 'road height range', `${num( m.minHeight )} .. ${num( m.maxHeight )} m` );
row( m.minBorderMargin >= LIMITS.minBorderMargin, 'min border margin', `${num( m.minBorderMargin, 0 )} m ${at( m.minBorderMarginS )}`, `>= ${LIMITS.minBorderMargin}` );
row( null, 'max cut / max fill (0, +-12 m)', `${num( m.maxCut )} m ${at( m.maxCutS )} / ${num( m.maxFill )} m ${at( m.maxFillS )}` );
row( ! result.violations.some( ( v ) => v.rule === 'width' || v.rule === 'startWidth' || v.rule === 'hairpinWidth' ), 'width min / max / start', `${num( m.minWidth, 2 )} / ${num( m.maxWidth, 2 )} / ${num( m.minStartWidth, 2 )} m`, `${LIMITS.minWidth} .. ${LIMITS.maxWidth}, start ${LIMITS.startWidth}, hairpins ${LIMITS.hairpinWidth}` );
row( m.maxWidthRate <= LIMITS.maxWidthRate, 'max width change', `${num( m.maxWidthRate * 100, 2 )} cm/m`, `<= ${LIMITS.maxWidthRate * 100}` );
row( null, 'max banking', `${num( m.maxBankDeg, 2 )} deg` );
row( null, 'elevation limiter', `${track.elevationInfo.sweeps} sweeps, residual ${num( track.elevationInfo.residual * 100, 2 )} %`, `max deviation from explicit heights ${num( track.elevationInfo.maxPinError, 2 )} m` );
row( null, 'estimated lap', `${formatLapTime( result.estimatedLapTime )}`, `avg ${kmh( m.averageSpeed )} km/h, top ${kmh( m.topSpeed )}, slowest ${kmh( m.minSpeed )}` );

if ( result.violations.length > 0 ) {

	console.log( '\nVIOLATIONS' );
	for ( const v of result.violations ) {

		console.log( `  ${v.rule.padEnd( 26 )} ${num( v.value, 3 ).padStart( 9 )}  (limit ${v.limit})  ${v.s >= 0 ? at( v.s ).padEnd( 10 ) : ''.padEnd( 10 )} ${v.message}` );

	}

}

console.log( `\nCORNERS (${result.corners.length})   speeds in km/h` );
console.log( '   #   apex s  dir  radius   angle  width   entry   min  exit  hairpin  name' );
result.corners.forEach( ( corner, index ) => {

	// A named corner of the layout belongs to this detected corner when its s lies inside it.
	const named = track.corners.find( ( c ) => ( c.s - corner.start + track.length ) % track.length <= ( corner.end - corner.start + track.length ) % track.length );
	console.log( [
		String( index + 1 ).padStart( 4 ),
		String( Math.round( corner.s ) ).padStart( 8 ),
		corner.direction.padStart( 4 ),
		num( corner.radius, 0 ).padStart( 7 ),
		num( corner.angle, 0 ).padStart( 7 ),
		num( corner.width, 1 ).padStart( 6 ),
		kmh( corner.entrySpeed ).padStart( 7 ),
		kmh( corner.minSpeed ).padStart( 5 ),
		kmh( corner.exitSpeed ).padStart( 5 ),
		( corner.hairpin ? 'yes' : '' ).padStart( 8 ),
		' ' + ( named ? named.name : '' ),
	].join( ' ' ) );

} );

console.log( `\nSECTORS start at s = ${track.sectors.map( ( s ) => Math.round( s ) ).join( ', ' )}   CHECKPOINTS ${track.checkpoints.length} (every ${num( track.length / track.checkpoints.length, 0 )} m)   GRID at s = ${track.gridS}` );

if ( args.has( '--points' ) ) {

	console.log( '\nCONTROL POINTS' );
	console.log( '   #        s        x        z   road y  terrain  grade%  radius  bank  width  name' );
	LAYOUT.controlPoints.forEach( ( point, index ) => {

		const s = track.controlPointS[ index ];
		const frame = track.frameAt( s );
		const radius = Math.abs( frame.curvature ) > 1e-4 ? num( 1 / frame.curvature, 0 ) : 'inf';
		console.log( [
			String( index ).padStart( 4 ),
			num( s, 0 ).padStart( 8 ),
			num( point.x, 0 ).padStart( 8 ),
			num( point.z, 0 ).padStart( 8 ),
			( num( frame.y ) + ( point.y === undefined ? ' ' : '*' ) ).padStart( 9 ),
			num( baseHeight( frame.x, frame.z ) ).padStart( 8 ),
			num( frame.grade * 100, 1 ).padStart( 7 ),
			radius.padStart( 7 ),
			num( frame.bank * RAD2DEG, 1 ).padStart( 5 ),
			num( frame.halfWidth * 2, 1 ).padStart( 6 ),
			' ' + ( point.name ?? '' ),
		].join( ' ' ) );

	} );
	console.log( '  (* = explicit height; radius is signed: positive = left turn)' );

}

process.exit( result.ok ? 0 : 1 );
