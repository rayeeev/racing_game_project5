#!/usr/bin/env node
// Inspect audio files: level statistics, loudness, spectral peaks, periodicity (engine pitch), spectrogram PNGs.
//
//   node tools/assets/audio-inspect.mjs [--spec <dir>] [--stop 2000] [--pitch] [--fmin 15 --fmax 700] [--env] <file>...
//
//   --spec <dir>   write <dir>/<basename>.png (linear frequency axis 0..--stop Hz, default full band)
//   --pitch        print spectral peaks, harmonic-comb and autocorrelation estimates of the fundamental
//   --env          print a coarse RMS envelope (dB per 250 ms) to spot silence / level changes
//   --seam         print loop-seam metrics (treats the file as a loop)

import { basename, join } from 'node:path';
import { decode, probe, peak, rms, db, loudness, welch, autocorr, parabolic, spectrogram, envelope, loopSeam, SR } from './audio-lib.mjs';

const argv = process.argv.slice( 2 );
const opts = { fmin: 15, fmax: 700, stop: 0 };
const files = [];
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a === '--pitch' || a === '--env' || a === '--seam' || a === '--log' ) opts[ a.slice( 2 ) ] = true;
	else if ( a.startsWith( '--' ) ) opts[ a.slice( 2 ) ] = argv[ ++ i ];
	else files.push( a );

}

/** Spectral peaks between fmin and fmax, sorted by power. */
export function spectralPeaks( x, sr, fmin, fmax, count = 14, size = 32768 ) {

	const { power, binHz } = welch( x, sr, size, 0.25 );
	const peaks = [];
	const k0 = Math.max( 2, Math.floor( fmin / binHz ) ), k1 = Math.min( power.length - 2, Math.ceil( fmax / binHz ) );
	const logp = Float64Array.from( power, ( v ) => 10 * Math.log10( v + 1e-20 ) );
	for ( let k = k0; k <= k1; k ++ ) {

		if ( logp[ k ] > logp[ k - 1 ] && logp[ k ] >= logp[ k + 1 ] && logp[ k ] > logp[ k - 2 ] && logp[ k ] >= logp[ k + 2 ] ) {

			const p = parabolic( logp, k );
			peaks.push( { hz: p.x * binHz, db: p.y } );

		}

	}

	peaks.sort( ( a, b ) => b.db - a.db );
	return { peaks: peaks.slice( 0, count ), logp, binHz };

}

/** Harmonic comb contrast: mean log-power at k*f minus mean log-power at (k+0.5)*f, harmonics up to fTop. */
export function combScore( logp, binHz, f, fTop = 1800 ) {

	let on = 0, off = 0, n = 0;
	const at = ( hz ) => {

		const k = hz / binHz;
		const i = Math.floor( k );
		if ( i + 1 >= logp.length ) return - 200;
		// max over +-1 bin to tolerate slight inharmonicity / drift
		return Math.max( logp[ Math.max( 0, i - 1 ) ], logp[ i ], logp[ i + 1 ], logp[ Math.min( logp.length - 1, i + 2 ) ] );

	};

	for ( let h = 1; h * f <= fTop; h ++ ) { on += at( h * f ); off += at( ( h + 0.5 ) * f ) ; n ++; }
	return n ? ( on - off ) / n : 0;

}

export function pitchReport( x, sr, fmin, fmax ) {

	const { peaks, logp, binHz } = spectralPeaks( x, sr, fmin, Math.max( fmax * 4, 1500 ) );
	// comb search
	let bestComb = { f: 0, score: - Infinity };
	const combs = [];
	for ( let f = fmin; f <= fmax; f *= 1.002 ) {

		const s = combScore( logp, binHz, f );
		combs.push( { f, s } );
		if ( s > bestComb.score ) bestComb = { f, score: s };

	}

	// autocorrelation on (up to) the first 3 s
	const len = Math.min( x.length - 1, Math.round( 3 * sr ) );
	const maxLag = Math.min( Math.floor( len / 2 ), Math.ceil( sr / fmin ) );
	const r = autocorr( x, 0, len, maxLag );
	const acPeaks = [];
	for ( let lag = Math.floor( sr / fmax ); lag < maxLag - 1; lag ++ ) {

		if ( r[ lag ] > r[ lag - 1 ] && r[ lag ] >= r[ lag + 1 ] && r[ lag ] > 0.2 ) {

			const p = parabolic( r, lag );
			acPeaks.push( { hz: sr / p.x, r: p.y } );

		}

	}

	acPeaks.sort( ( a, b ) => b.r - a.r );
	return { peaks, bestComb, acPeaks: acPeaks.slice( 0, 8 ), logp, binHz };

}

for ( const file of files ) {

	const info = probe( file );
	const { channels } = decode( file, { sr: SR, channels: info.channels >= 2 ? 2 : 1 } );
	const mono = channels.length === 2 ? Float32Array.from( channels[ 0 ], ( v, i ) => 0.5 * ( v + channels[ 1 ][ i ] ) ) : channels[ 0 ];
	const pk = Math.max( ...channels.map( ( c ) => peak( c ) ) );
	const line = [
		basename( file ).padEnd( 34 ),
		`${info.codec} ${info.sampleRate}Hz ${info.channels}ch`,
		`${info.duration.toFixed( 3 )}s`,
		`peak ${db( pk ).toFixed( 1 )}dB`,
		`rms ${db( rms( mono ) ).toFixed( 1 )}dB`,
		`${loudness( channels, SR ).toFixed( 1 )} LUFS`,
	];
	if ( channels.length === 2 ) {

		let sab = 0, saa = 0, sbb = 0;
		for ( let i = 0; i < mono.length; i ++ ) { sab += channels[ 0 ][ i ] * channels[ 1 ][ i ]; saa += channels[ 0 ][ i ] ** 2; sbb += channels[ 1 ][ i ] ** 2; }
		line.push( `LRcorr ${( sab / Math.sqrt( saa * sbb + 1e-30 ) ).toFixed( 2 )}` );

	}

	console.log( line.join( '  ' ) );

	if ( opts.env ) {

		const hopS = Number( opts.envhop || 0.25 );
		const e = envelope( mono, Math.round( hopS * SR ), Math.round( hopS * SR ) );
		console.log( `   env dB/${hopS * 1000}ms: ` + Array.from( e, ( v ) => db( v ).toFixed( 0 ) ).join( ' ' ) );

	}

	if ( opts.seam ) {

		for ( const c of channels ) { const s = loopSeam( c ); console.log( `   seam: jump ${s.jump.toExponential( 2 )}  diffRms ${s.diffRms.toExponential( 2 )}  jump/diffRms ${s.jumpOverRms.toFixed( 2 )}  diffP99.9 ${s.diffP999.toExponential( 2 )}  d2 seam/rms ${s.seamD2OverRms.toFixed( 2 )}` ); }

	}

	if ( opts.pitch ) {

		const rep = pitchReport( mono, SR, Number( opts.fmin ), Number( opts.fmax ) );
		console.log( '   spectral peaks (Hz @ dB): ' + rep.peaks.map( ( p ) => `${p.hz.toFixed( 1 )}@${p.db.toFixed( 0 )}` ).join( '  ' ) );
		console.log( `   best comb spacing: ${rep.bestComb.f.toFixed( 2 )} Hz (contrast ${rep.bestComb.score.toFixed( 1 )} dB)` );
		console.log( '   autocorr peaks (Hz, r): ' + rep.acPeaks.map( ( p ) => `${p.hz.toFixed( 2 )} (${p.r.toFixed( 2 )})` ).join( '  ' ) );

	}

	if ( opts.spec ) {

		const png = join( opts.spec, basename( file ).replace( /\.[^.]+$/, '' ) + ( opts.suffix || '' ) + '.png' );
		spectrogram( file, png, { stop: Number( opts.stop ), fscale: opts.log ? 'log' : 'lin', width: Number( opts.width || 1600 ), height: Number( opts.height || 700 ), limit: Math.ceil( db( pk ) ) - 6, drange: Number( opts.drange || 90 ), ar: Number( opts.ar || 0 ) } );
		console.log( '   spectrogram: ' + png );

	}

}
