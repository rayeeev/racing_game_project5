#!/usr/bin/env node
// Build the ENGINE loop set into public/assets/audio/engine/.
//
//   node tools/assets/audio-build-engine.mjs            (stand-alone: prints a report, writes engine/*.wav)
//   import { buildEngine } from './audio-build-engine.mjs'   (used by audio-build.mjs -> index.json)
//
// Source: "The Dyno Sessions: 190E" (CC0) - Mercedes-Benz 190E 2.3-16, inline-4, on a load-holding dynamometer.
// Two close microphones are blended: Audix D6 one foot behind the exhaust outlet ("exhaust") and DPA 4062 in the
// engine bay ("bay"). Every loop is PITCH-LOCKED: the recording is time-warped so that the firing frequency is exactly
// constant (one firing period = an integer number of samples), then an integer number of 720-degree engine cycles is
// cut and its tail is crossfaded into its head. So `rpm` in the index is exact and loops are phase-coherent.
//
//   steady   : real constant-rpm holds (full load 2556 / 6213 rpm, zero load 1069 / 2423 / 6300 rpm)
//   sweep    : cut out of the loaded downward sweep (dyno pulling the engine down at open throttle); the window spans
//              +-w around the target rpm and is warped to the target, so formants move by at most +-w inside the loop.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, writeWav, SR, peak, rms, db, fromDb, loudness, removeDc, filterChain, loopSeam, makeLoopPeriodic } from './audio-lib.mjs';
import { trackFiring, trackToSamples, smooth, positionsFromTrack, pitchLock, warp, strongestLine, orderLevels } from './audio-engine-lib.mjs';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const SRC = join( ROOT, 'assets-src', 'audio' );
const OUT = join( ROOT, 'public', 'assets', 'audio' );

const DYNO = 'fs-chippy569-dyno190e';
const FERRARI = 'fs-pritzproductions-ferrari360';
const fs = ( dir, id ) => join( SRC, dir, `fs${id}.ogg` );

const TARGET_LUFS = - 18;
const PEAK_CEILING = fromDb( - 1.0 );

// --- mix: natural recorded levels, exhaust mic 3 dB down; HF taming (the dyno cell fans + mic presence peaks make the
// raw recordings much brighter than a car heard on the road)
const MIX = {
	on: {
		exhaust: { gainDb: - 3, chain: [ [ 'highpass', 22, 0.707 ], [ 'highshelf', 3200, 0.707, - 5 ] ] },
		bay: { gainDb: 0, chain: [ [ 'highpass', 30, 0.707 ], [ 'lowpass', 4500, 0.6 ] ] },
		master: [ [ 'highshelf', 3500, 0.707, - 7 ] ],
	},
	off: {
		exhaust: { gainDb: - 3, chain: [ [ 'highpass', 22, 0.707 ], [ 'lowpass', 3000, 0.6 ] ] },
		bay: { gainDb: 0, chain: [ [ 'highpass', 30, 0.707 ], [ 'lowpass', 2600, 0.6 ] ] },
		master: [ [ 'highshelf', 3500, 0.707, - 4 ] ],
	},
	idle: { exhaust: { gainDb: 0, chain: [ [ 'highpass', 18, 0.707 ], [ 'lowpass', 1300, 0.707 ], [ 'lowpass', 1300, 0.707 ] ] }, master: [] },
	v8idle: { bay: { gainDb: 0, chain: [ [ 'highpass', 25, 0.707 ] ] }, master: [] },
};

// Loaded downward sweeps: rough (time s, rpm) anchors, only used as a prior for the tracker.
const SWEEP = {
	exhaust: { file: fs( DYNO, 162504 ), anchors: [ [ 0.15, 7050 ], [ 1.1, 6030 ], [ 2.15, 5030 ], [ 3.4, 4010 ], [ 4.8, 3020 ], [ 5.57, 2500 ], [ 6.42, 2000 ], [ 7.5, 1400 ] ], tMax: 7.55 },
	bay: { file: fs( DYNO, 162502 ), anchors: [ [ 0.05, 6917 ], [ 0.6, 5990 ], [ 1.16, 4980 ], [ 1.86, 3980 ], [ 2.55, 3060 ], [ 3.0, 2500 ], [ 3.46, 1985 ], [ 4.09, 1400 ] ], tMax: 4.15 },
};

const RECIPES = [
	// id, load, kind, layers
	{ id: 'engine_idle', load: 'off', mix: 'idle', kind: 'steady', range: [ 28, 45 ], files: { exhaust: fs( DYNO, 162515 ) }, maxSeconds: 3.2, gainDb: - 9,
		notes: 'idle in neutral (zero load), exhaust mic only, low-passed at 1.3 kHz to remove dyno-cell fan noise' },
	{ id: 'engine_idle_v8', load: 'off', mix: 'v8idle', kind: 'steady', range: [ 60, 85 ], files: { bay: fs( FERRARI, 241083 ) }, trim: [ 22.85, 24.85 ], cylinders: 8, maxSeconds: 2.0, gainDb: - 8,
		notes: 'REAL V8: Ferrari 360 Spider (3.6 l flat-plane V8) idling, stereo recorder directly above the engine (downmixed). Different car than the rest of the set - see techNotes' },
	{ id: 'engine_off_2400', load: 'off', mix: 'off', kind: 'steady', range: [ 60, 110 ], files: { exhaust: fs( DYNO, 162518 ), bay: fs( DYNO, 162519 ) }, maxSeconds: 2.6, gainDb: - 9,
		notes: 'steady hold in neutral (zero load)' },
	{ id: 'engine_off_6300', load: 'off', mix: 'off', kind: 'steady', range: [ 150, 260 ], files: { exhaust: fs( DYNO, 162521 ), bay: fs( DYNO, 162522 ) }, maxSeconds: 1.5, gainDb: - 6,
		notes: 'steady hold in neutral (zero load)' },
	{ id: 'engine_on_1800', load: 'on', mix: 'on', kind: 'sweep', rpm: 1800, w: { exhaust: 0.13 }, layers: [ 'exhaust' ], gainDb: - 5,
		notes: 'cut from the loaded downward sweep (exhaust mic only: the engine-bay mic is below the fan noise at this rpm)' },
	{ id: 'engine_on_2550', load: 'on', mix: 'on', kind: 'steady', range: [ 60, 110 ], files: { exhaust: fs( DYNO, 162509 ), bay: fs( DYNO, 162510 ) }, maxSeconds: 2.6, gainDb: - 4,
		notes: 'steady hold at full load' },
	{ id: 'engine_on_3300', load: 'on', mix: 'on', kind: 'sweep', rpm: 3300, w: { exhaust: 0.10, bay: 0.16 }, layers: [ 'exhaust', 'bay' ], gainDb: - 3,
		notes: 'cut from the loaded downward sweeps' },
	{ id: 'engine_on_4200', load: 'on', mix: 'on', kind: 'sweep', rpm: 4200, w: { exhaust: 0.10, bay: 0.16 }, layers: [ 'exhaust', 'bay' ], gainDb: - 2,
		notes: 'cut from the loaded downward sweeps' },
	{ id: 'engine_on_5200', load: 'on', mix: 'on', kind: 'sweep', rpm: 5200, w: { exhaust: 0.10, bay: 0.16 }, layers: [ 'exhaust', 'bay' ], gainDb: - 1,
		notes: 'cut from the loaded downward sweeps' },
	{ id: 'engine_on_6200', load: 'on', mix: 'on', kind: 'steady', range: [ 150, 260 ], files: { exhaust: fs( DYNO, 162512 ), bay: fs( DYNO, 162513 ) }, maxSeconds: 1.3, gainDb: 0,
		notes: 'steady hold at full load' },
];

const cache = new Map();
function load( file, opts = {} ) {

	const key = file + JSON.stringify( opts );
	if ( ! cache.has( key ) ) cache.set( key, removeDc( decode( file, { sr: SR, channels: 1, ...opts } ).channels[ 0 ] ) );
	return cache.get( key );

}

const trackCache = new Map();
function sweepTrack( layer ) {

	if ( trackCache.has( layer ) ) return trackCache.get( layer );
	const { file, anchors } = SWEEP[ layer ];
	const x = load( file );
	const prior = ( t ) => {

		if ( t <= anchors[ 0 ][ 0 ] ) return anchors[ 0 ][ 1 ] / 30;
		for ( let i = 0; i < anchors.length - 1; i ++ ) if ( t <= anchors[ i + 1 ][ 0 ] ) {

			const a = ( t - anchors[ i ][ 0 ] ) / ( anchors[ i + 1 ][ 0 ] - anchors[ i ][ 0 ] );
			return ( anchors[ i ][ 1 ] + a * ( anchors[ i + 1 ][ 1 ] - anchors[ i ][ 1 ] ) ) / 30;

		}

		return anchors[ anchors.length - 1 ][ 1 ] / 30;

	};

	const tr = trackFiring( x, SR, { fmin: 25, fmax: 260, prior, priorWeight: 0.08 } );
	const fS = smooth( trackToSamples( tr.times, tr.f, x.length, SR ), 4096 );
	const res = { x, fS };
	trackCache.set( layer, res );
	return res;

}

/** Pitch-lock a steady hold. Returns { fT, P, layers: {name: y}, lock } - all layers share the warp of the first. */
function lockSteady( recipe ) {

	const names = Object.keys( recipe.files );
	const trim = recipe.trim ? { start: recipe.trim[ 0 ], duration: recipe.trim[ 1 ] - recipe.trim[ 0 ] } : {};
	const ref = load( recipe.files[ names[ 0 ] ], trim );
	const f0 = strongestLine( ref, SR, recipe.range[ 0 ], recipe.range[ 1 ] );
	const P = Math.round( SR / f0 );
	const fT = SR / P;
	const n = Math.floor( ( ref.length - 1 ) * f0 / fT );
	const pos0 = Float64Array.from( { length: n }, ( _, k ) => k * fT / f0 );
	const lock = pitchLock( ref, SR, pos0, fT, { iterations: 6 } );
	const layers = { [ names[ 0 ] ]: lock.y };
	for ( const name of names.slice( 1 ) ) layers[ name ] = warp( load( recipe.files[ name ], trim ), lock.pos );
	return { fT, P, f0, layers, info: { [ names[ 0 ] ]: { residual: lock.residual, drift: lock.drift, seconds: lock.y.length / SR } }, usable: null };

}

/** Pitch-lock a window of a sweep around recipe.rpm. Returns the locked window (with margins) per layer. */
function lockSweep( recipe ) {

	const P = Math.round( SR / ( recipe.rpm / 30 ) );
	const fT = SR / P;
	const layers = {}, info = {}, usable = {};
	for ( const name of recipe.layers ) {

		const { x, fS } = sweepTrack( name );
		const w = recipe.w[ name ];
		const lo = fT / ( 1 + w ), hi = fT * ( 1 + w );
		const iMax = Math.min( x.length, Math.round( SWEEP[ name ].tMax * SR ) );
		// longest run inside the band (gaps < 50 ms are bridged)
		let best = [ 0, 0 ], start = - 1, last = - 1;
		for ( let i = 0; i <= iMax; i ++ ) {

			const inside = i < iMax && fS[ i ] >= lo && fS[ i ] <= hi;
			if ( inside ) { if ( start < 0 ) start = i; last = i; }
			if ( start >= 0 && ( i === iMax || ( ! inside && i - last > 0.05 * SR ) ) ) {

				if ( last - start > best[ 1 ] - best[ 0 ] ) best = [ start, last ];
				start = - 1;

			}

		}

		const ext = Math.round( 0.2 * SR );
		const i0 = Math.max( 0, best[ 0 ] - ext ), i1 = Math.min( iMax, best[ 1 ] + ext );
		const pos0 = positionsFromTrack( fS, SR, fT, i0, i1 );
		const lock = pitchLock( x, SR, pos0, fT, { iterations: 6 } );
		// output index range that corresponds to the +-w window (inside the extended, locked region)
		let k0 = 0, k1 = lock.pos.length - 1;
		while ( k0 < lock.pos.length && lock.pos[ k0 ] < best[ 0 ] ) k0 ++;
		while ( k1 > 0 && lock.pos[ k1 ] > best[ 1 ] ) k1 --;
		layers[ name ] = lock.y;
		usable[ name ] = [ k0, k1 ];
		info[ name ] = { residual: lock.residual, drift: lock.drift, window: [ best[ 0 ] / SR, best[ 1 ] / SR ], seconds: ( k1 - k0 ) / SR, srcRpm: [ fS[ best[ 0 ] ] * 30, fS[ best[ 1 ] ] * 30 ] };

	}

	return { fT, P, layers, info, usable };

}

/** Remove the linear level trend (in dB) of y over [a, b) - sweeps get quieter/louder across the window. */
function flattenTrend( y, a, b, P ) {

	const block = 4 * P;
	const xs = [], ys = [];
	for ( let s = a; s + block <= b; s += block ) { xs.push( s + block / 2 ); ys.push( db( rms( y, s, s + block ) ) ); }
	if ( xs.length < 3 ) return { y, slopeDb: 0 };
	const mx = xs.reduce( ( p, c ) => p + c, 0 ) / xs.length, my = ys.reduce( ( p, c ) => p + c, 0 ) / ys.length;
	let sxy = 0, sxx = 0;
	for ( let i = 0; i < xs.length; i ++ ) { sxy += ( xs[ i ] - mx ) * ( ys[ i ] - my ); sxx += ( xs[ i ] - mx ) ** 2; }
	const slope = sxy / sxx; // dB per sample
	const out = new Float32Array( y.length );
	for ( let i = 0; i < y.length; i ++ ) {

		const corr = Math.max( - 6, Math.min( 6, - slope * ( i - mx ) ) );
		out[ i ] = y[ i ] * fromDb( corr );

	}

	return { y: out, slopeDb: slope * ( b - a ) };

}

/** Filter a loop so that it stays seamless (filter state wraps around). */
function filterLoop( loop, chain ) {

	if ( ! chain || chain.length === 0 ) return loop;
	const n = loop.length;
	const reps = Math.max( 3, Math.ceil( SR / n ) + 2 );
	const t = new Float32Array( n * reps );
	for ( let r = 0; r < reps; r ++ ) t.set( loop, r * n );
	const f = filterChain( t, SR, chain );
	return f.slice( n * ( reps - 1 ) );

}

function buildOne( recipe ) {

	const locked = recipe.kind === 'steady' ? lockSteady( recipe ) : lockSweep( recipe );
	const { P, fT } = locked;
	const cylinders = recipe.cylinders || 4;
	const cyc = cylinders * P; // one 720-degree engine cycle = `cylinders` firing periods
	const names = Object.keys( locked.layers );
	const report = { id: recipe.id, fT, rpm: fT * 60 / ( ( recipe.cylinders || 4 ) / 2 ), layers: {} };
	// --- per layer: usable range, loop length in cycles
	const plan = {};
	for ( const name of names ) {

		const y = locked.layers[ name ];
		let a, b;
		if ( locked.usable && locked.usable[ name ] ) [ a, b ] = locked.usable[ name ];
		else { const m = Math.round( 0.12 * SR ); a = m; b = y.length - m; }
		plan[ name ] = { y, a, b };

	}

	// loop length: reference layer first (exhaust), others must divide it
	const order = names;
	const maxLen = Math.round( ( recipe.maxSeconds || 1.6 ) * SR );
	const lens = {};
	for ( const name of order ) {

		const { a, b } = plan[ name ];
		const avail = b - a;
		// crossfade = 22 % of the loop (>= 2 cycles), loop + crossfade must fit
		let nCyc = Math.floor( Math.min( maxLen, avail / 1.22 ) / cyc );
		if ( nCyc < 2 ) nCyc = Math.floor( ( avail - 2 * cyc ) / cyc );
		lens[ name ] = nCyc;

	}

	// a shorter layer is tiled an integer number of times inside the reference loop: pick the combination that
	// keeps the most material of both
	const nRef = lens[ order[ 0 ] ];
	for ( const name of order.slice( 1 ) ) {

		if ( lens[ name ] >= nRef ) { lens[ name ] = nRef; continue; }
		let best = null;
		for ( let reps = 1; reps <= 4; reps ++ ) {

			const nb = Math.min( lens[ name ], Math.floor( nRef / reps ) );
			if ( nb < 2 ) continue;
			const score = Math.min( nb / lens[ name ], 1 ) * ( nb * reps / nRef );
			if ( ! best || score > best.score ) best = { reps, nb, score };

		}

		lens[ name ] = best.nb;
		lens[ order[ 0 ] ] = best.nb * best.reps;

	}

	const L = lens[ order[ 0 ] ] * cyc;
	const mixCfg = MIX[ recipe.mix ];
	const mixed = new Float32Array( L );
	for ( const name of order ) {

		let { y, a, b } = plan[ name ];
		let slopeDb = 0;
		if ( recipe.kind === 'sweep' ) { const f = flattenTrend( y, a, b, P ); y = f.y; slopeDb = f.slopeDb; }
		const len = lens[ name ] * cyc;
		const xf = Math.min( b - a - len, Math.max( 2 * cyc, Math.round( 0.22 * len ) ) );
		const start = a + Math.floor( ( b - a - len - xf ) / 2 );
		const { loop, corr } = makeLoopPeriodic( y, start, len, xf, cyc, 2 );
		const cfg = mixCfg[ name ];
		const filtered = filterLoop( loop, cfg.chain );
		const g = fromDb( cfg.gainDb );
		for ( let i = 0; i < L; i ++ ) mixed[ i ] += filtered[ i % len ] * g;
		report.layers[ name ] = { ...( locked.info[ name ] || {} ), cycles: lens[ name ], loopSeconds: len / SR, crossfadeSeconds: xf / SR, crossfadeCorr: corr, trendDb: slopeDb, layerRmsDb: db( rms( filtered ) * g ) };

	}

	// --- master EQ (seamless) and normalisation
	if ( mixCfg.master && mixCfg.master.length ) mixed.set( filterLoop( mixed, mixCfg.master ) );
	const lufs0 = loudness( [ mixed ], SR, { periodic: true } );
	let g = fromDb( TARGET_LUFS - lufs0 );
	const pk = peak( mixed );
	let limited = false;
	if ( pk * g > PEAK_CEILING ) { g = PEAK_CEILING / pk; limited = true; }
	const out = new Float32Array( L );
	for ( let i = 0; i < L; i ++ ) out[ i ] = mixed[ i ] * g;
	const file = join( OUT, 'engine', recipe.id + '.wav' );
	writeWav( file, [ out ], SR );
	const seam = loopSeam( out );
	Object.assign( report, {
		file, samples: L, seconds: L / SR, lufs: loudness( [ out ], SR, { periodic: true } ), peakDb: db( peak( out ) ), limited,
		seam: { jumpOverRms: seam.jumpOverRms, d2: seam.seamD2OverRms },
		orders: orderLevels( Float32Array.from( { length: L * 4 }, ( _, i ) => out[ i % L ] ), SR, fT, [ 0.5, 1, 1.5, 2, 3, 4 ] ).map( ( v ) => Math.round( v ) ),
	} );
	return { report, entry: {
		id: recipe.id,
		file: `/assets/audio/engine/${recipe.id}.wav`,
		group: 'engine',
		loop: true,
		duration: Number( ( L / SR ).toFixed( 4 ) ),
		channels: 1,
		sampleRate: SR,
		rpm: Math.round( fT * 60 / ( cylinders / 2 ) ),
		load: recipe.load,
		baseFrequencyHz: Number( fT.toFixed( 3 ) ),
		cylinders,
		engineCycles: lens[ order[ 0 ] ],
		derivation: recipe.kind,
		gainDb: recipe.gainDb,
		lufs: Number( report.lufs.toFixed( 1 ) ),
		peakDb: Number( report.peakDb.toFixed( 1 ) ),
		notes: recipe.notes,
		sourceIds: recipe.kind === 'steady' ? Object.values( recipe.files ) : recipe.layers.map( ( l ) => SWEEP[ l ].file ),
	} };

}

export function buildEngine( { log = console.log } = {} ) {

	const entries = [], reports = [];
	for ( const recipe of RECIPES ) {

		const { report, entry } = buildOne( recipe );
		entries.push( entry );
		reports.push( report );
		const lay = Object.entries( report.layers ).map( ( [ n, l ] ) => `${n}: ${l.cycles}cyc ${l.loopSeconds.toFixed( 2 )}s xf ${l.crossfadeSeconds.toFixed( 2 )}s corr ${l.crossfadeCorr.toFixed( 2 )} lock ${l.residual !== undefined ? l.residual.toFixed( 3 ) + '/' + l.drift.toFixed( 2 ) : 'shared'}rad${l.window ? ` win ${l.window[ 0 ].toFixed( 2 )}-${l.window[ 1 ].toFixed( 2 )}s src ${l.srcRpm.map( ( v ) => v.toFixed( 0 ) ).join( '>' )}rpm trend ${l.trendDb.toFixed( 1 )}dB` : ''} rms ${l.layerRmsDb.toFixed( 1 )}` ).join( ' | ' );
		log( `${report.id.padEnd( 16 )} ${report.rpm.toFixed( 0 ).padStart( 5 )} rpm  f=${report.fT.toFixed( 2 )}Hz  ${report.seconds.toFixed( 3 )}s  ${report.lufs.toFixed( 1 )} LUFS  peak ${report.peakDb.toFixed( 1 )}${report.limited ? ' (peak-limited)' : ''}  seam ${report.seam.jumpOverRms.toFixed( 2 )}/${report.seam.d2.toFixed( 2 )}  orders[.5,1,1.5,2,3,4] ${report.orders.join( ' ' )}\n      ${lay}` );

	}

	return { entries, reports };

}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) buildEngine();
