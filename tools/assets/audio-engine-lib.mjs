// Engine-sound specific DSP: firing-frequency tracking and "pitch locking" (time-warping a recording so that the
// firing frequency becomes exactly constant), used to cut perfectly periodic loops out of steady holds AND out of
// slow rpm sweeps.
//
// Terminology: firing frequency f = rpm / 60 * cylinders / 2. For the 4-cylinder source engine f = rpm / 30,
// i.e. the 2nd engine order. A full 4-stroke cycle (720 deg) lasts 4 firing periods on a 4-cylinder.

import { magSpectrum, biquadCoefs, filtfilt, sincResample, parabolic } from './audio-lib.mjs';

/**
 * Coarse firing-frequency track by dynamic programming over an STFT.
 * Returns { times (s, frame centres), f (Hz) } with one value per frame.
 *   fmin/fmax   search band for the firing line
 *   prior(t)    optional function giving an expected frequency (Hz) at time t (adds a soft penalty)
 */
export function trackFiring( x, sr, { fmin = 25, fmax = 260, win = 4096, hop = 512, pad = 4, jumpPenalty = 0.6, second = 0.5, half = 0, prior = null, priorWeight = 0.05 } = {} ) {

	const size = win * pad;
	const binHz = sr / size;
	const nFrames = Math.max( 1, Math.floor( ( x.length - win ) / hop ) + 1 );
	const k0 = Math.floor( fmin / binHz ), k1 = Math.ceil( fmax / binHz );
	const nk = k1 - k0 + 1;
	const sal = [];
	for ( let t = 0; t < nFrames; t ++ ) {

		const m = magSpectrum( x, t * hop, win, size );
		const s = new Float64Array( nk );
		const dbAt = ( k ) => 20 * Math.log10( ( k < m.length ? m[ Math.round( k ) ] : 0 ) + 1e-9 );
		for ( let i = 0; i < nk; i ++ ) {

			const k = k0 + i;
			s[ i ] = dbAt( k ) + second * dbAt( 2 * k ) + half * dbAt( k / 2 );
			if ( prior ) {

				const fp = prior( ( t * hop + win / 2 ) / sr );
				if ( fp ) s[ i ] -= priorWeight * Math.abs( 1200 * Math.log2( ( k * binHz ) / fp ) );

			}

		}

		sal.push( s );

	}

	// Viterbi: transition cost proportional to the jump in bins (limited window for speed)
	const maxJump = Math.ceil( 12 / binHz ); // Hz per frame
	let prev = Float64Array.from( sal[ 0 ] );
	const back = [];
	for ( let t = 1; t < nFrames; t ++ ) {

		const cur = new Float64Array( nk );
		const bp = new Int32Array( nk );
		for ( let i = 0; i < nk; i ++ ) {

			let best = - Infinity, bi = i;
			const lo = Math.max( 0, i - maxJump ), hi = Math.min( nk - 1, i + maxJump );
			for ( let j = lo; j <= hi; j ++ ) {

				const v = prev[ j ] - jumpPenalty * Math.abs( i - j ) * binHz;
				if ( v > best ) { best = v; bi = j; }

			}

			cur[ i ] = best + sal[ t ][ i ];
			bp[ i ] = bi;

		}

		back.push( bp );
		prev = cur;

	}

	let bi = 0;
	for ( let i = 1; i < nk; i ++ ) if ( prev[ i ] > prev[ bi ] ) bi = i;
	const path = new Int32Array( nFrames );
	path[ nFrames - 1 ] = bi;
	for ( let t = nFrames - 1; t > 0; t -- ) path[ t - 1 ] = back[ t - 1 ][ path[ t ] ];
	const times = new Float64Array( nFrames ), f = new Float64Array( nFrames );
	for ( let t = 0; t < nFrames; t ++ ) {

		times[ t ] = ( t * hop + win / 2 ) / sr;
		// refine on the raw magnitude of the fundamental line only
		const m = magSpectrum( x, t * hop, win, size );
		const k = k0 + path[ t ];
		let kb = k;
		for ( let d = - 2; d <= 2; d ++ ) if ( m[ k + d ] > m[ kb ] ) kb = k + d;
		const lg = [ Math.log( m[ kb - 1 ] + 1e-12 ), Math.log( m[ kb ] + 1e-12 ), Math.log( m[ kb + 1 ] + 1e-12 ) ];
		const p = parabolic( lg, 1 );
		f[ t ] = ( kb - 1 + p.x ) * binHz;

	}

	return { times, f };

}

/** Linear interpolation of a frame-rate track to every sample. Constant extrapolation at the ends. */
export function trackToSamples( times, f, n, sr ) {

	const out = new Float64Array( n );
	let j = 0;
	for ( let i = 0; i < n; i ++ ) {

		const t = i / sr;
		while ( j < times.length - 2 && times[ j + 1 ] < t ) j ++;
		if ( t <= times[ 0 ] ) out[ i ] = f[ 0 ];
		else if ( t >= times[ times.length - 1 ] ) out[ i ] = f[ f.length - 1 ];
		else {

			const a = ( t - times[ j ] ) / ( times[ j + 1 ] - times[ j ] );
			out[ i ] = f[ j ] + ( f[ j + 1 ] - f[ j ] ) * Math.min( 1, Math.max( 0, a ) );

		}

	}

	return out;

}

/** Moving-average smoothing of a per-sample track (zero-phase). */
export function smooth( a, win ) {

	const n = a.length;
	const out = new Float64Array( n );
	const h = Math.floor( win / 2 );
	const cs = new Float64Array( n + 1 );
	for ( let i = 0; i < n; i ++ ) cs[ i + 1 ] = cs[ i ] + a[ i ];
	for ( let i = 0; i < n; i ++ ) {

		const lo = Math.max( 0, i - h ), hi = Math.min( n, i + h + 1 );
		out[ i ] = ( cs[ hi ] - cs[ lo ] ) / ( hi - lo );

	}

	return out;

}

/**
 * Read positions that turn the input into a constant-frequency signal:
 * pos[k] = input sample index at which the accumulated firing phase equals c0 + k * fTarget / sr.
 * `fSamples` is the per-sample firing frequency; the window [i0, i1) of the input is used.
 */
export function positionsFromTrack( fSamples, sr, fTarget, i0, i1 ) {

	const pos = [];
	let c = 0; // cycles accumulated since i0
	let k = 0;
	const step = fTarget / sr;
	for ( let i = i0; i < i1 - 1; i ++ ) {

		const dc = 0.5 * ( fSamples[ i ] + fSamples[ i + 1 ] ) / sr;
		while ( k * step <= c + dc ) {

			const frac = ( k * step - c ) / dc;
			pos.push( i + frac );
			k ++;

		}

		c += dc;

	}

	return Float64Array.from( pos );

}

function interp( a, x ) {

	if ( x <= 0 ) return a[ 0 ] + ( a[ 1 ] - a[ 0 ] ) * x;
	const n = a.length;
	if ( x >= n - 1 ) return a[ n - 1 ] + ( a[ n - 1 ] - a[ n - 2 ] ) * ( x - ( n - 1 ) );
	const i = Math.floor( x );
	return a[ i ] + ( a[ i + 1 ] - a[ i ] ) * ( x - i );

}

/** Warp: sample x at pos[] with band-limited interpolation. */
export function warp( x, pos ) {

	const ratio = new Float64Array( pos.length );
	for ( let k = 0; k < pos.length; k ++ ) ratio[ k ] = k + 1 < pos.length ? pos[ k + 1 ] - pos[ k ] : pos[ k ] - pos[ k - 1 ];
	return sincResample( x, pos, ratio, 24 );

}

/**
 * Residual phase (radians, unwrapped, per sample) of the component near `f` in y, by complex demodulation with a
 * zero-phase low-pass of cutoff `bw` Hz. Also returns the demodulated amplitude.
 */
export function demodPhase( y, sr, f, bw ) {

	const n = y.length;
	const re = new Float64Array( n ), im = new Float64Array( n );
	const w = 2 * Math.PI * f / sr;
	for ( let k = 0; k < n; k ++ ) { re[ k ] = y[ k ] * Math.cos( w * k ); im[ k ] = - y[ k ] * Math.sin( w * k ); }
	const c = biquadCoefs( 'lowpass', bw, sr, Math.SQRT1_2 );
	const pad = Math.min( n - 1, Math.round( 3 * sr / bw ) );
	const r2 = filtfilt( filtfilt( re, c, pad ), c, pad ), i2 = filtfilt( filtfilt( im, c, pad ), c, pad );
	const phase = new Float64Array( n ), amp = new Float64Array( n );
	let prev = 0, off = 0;
	for ( let k = 0; k < n; k ++ ) {

		const p = Math.atan2( i2[ k ], r2[ k ] );
		if ( k > 0 ) { const d = p - prev; if ( d > Math.PI ) off -= 2 * Math.PI; else if ( d < - Math.PI ) off += 2 * Math.PI; }
		prev = p;
		phase[ k ] = p + off;
		amp[ k ] = 2 * Math.hypot( r2[ k ], i2[ k ] );

	}

	return { phase, amp };

}

/**
 * Pitch-lock: iteratively refine read positions so that the firing component of the warped signal has exactly
 * constant frequency fTarget. Returns { y, pos, residual (rad RMS of the last iteration), drift (peak-peak rad), amp }.
 */
export function pitchLock( x, sr, pos0, fTarget, { iterations = 4, bwRel = 0.1, margin = 0 } = {} ) {

	let pos = Float64Array.from( pos0 );
	let y = warp( x, pos );
	let residual = Infinity, drift = Infinity, amp = null;
	for ( let it = 0; it < iterations; it ++ ) {

		const d = demodPhase( y, sr, fTarget, Math.max( 2, bwRel * fTarget ) );
		amp = d.amp;
		const n = y.length;
		const a = Math.min( Math.floor( n / 4 ), margin || Math.round( 1.5 * sr / ( bwRel * fTarget ) ) );
		// reference: mean phase over the trusted interior
		let m = 0;
		for ( let k = a; k < n - a; k ++ ) m += d.phase[ k ];
		m /= Math.max( 1, n - 2 * a );
		let s = 0, lo = Infinity, hi = - Infinity;
		const psi = new Float64Array( n );
		for ( let k = 0; k < n; k ++ ) {

			const kk = Math.min( n - a - 1, Math.max( a, k ) ); // hold the edge values (filter edge effects)
			psi[ k ] = d.phase[ kk ] - m;
			if ( k >= a && k < n - a ) { s += psi[ k ] * psi[ k ]; lo = Math.min( lo, psi[ k ] ); hi = Math.max( hi, psi[ k ] ); }

		}

		residual = Math.sqrt( s / Math.max( 1, n - 2 * a ) );
		drift = hi - lo;
		if ( it === iterations - 1 ) break;
		const next = new Float64Array( n );
		const scale = sr / ( 2 * Math.PI * fTarget );
		for ( let k = 0; k < n; k ++ ) next[ k ] = interp( pos, k - psi[ k ] * scale );
		// keep strictly increasing
		for ( let k = 1; k < n; k ++ ) if ( next[ k ] <= next[ k - 1 ] ) next[ k ] = next[ k - 1 ] + 1e-3;
		pos = next;
		y = warp( x, pos );

	}

	return { y, pos, residual, drift, amp };

}

/** Mean frequency (Hz) of the strongest spectral line between fmin and fmax (whole-signal Welch estimate). */
export function strongestLine( x, sr, fmin, fmax, size = 65536 ) {

	const len = Math.min( x.length, size );
	let best = { hz: 0, mag: 0 };
	const hops = Math.max( 1, Math.floor( ( x.length - len ) / ( len / 2 ) ) + 1 );
	const acc = new Float64Array( size / 2 + 1 );
	for ( let h = 0; h < hops; h ++ ) {

		const m = magSpectrum( x, Math.round( h * len / 2 ), len, size );
		for ( let k = 0; k < acc.length; k ++ ) acc[ k ] += m[ k ] * m[ k ];

	}

	const binHz = sr / size;
	for ( let k = Math.max( 2, Math.floor( fmin / binHz ) ); k <= Math.ceil( fmax / binHz ); k ++ ) {

		if ( acc[ k ] > best.mag && acc[ k ] >= acc[ k - 1 ] && acc[ k ] >= acc[ k + 1 ] ) {

			const lg = [ Math.log( acc[ k - 1 ] + 1e-30 ), Math.log( acc[ k ] + 1e-30 ), Math.log( acc[ k + 1 ] + 1e-30 ) ];
			best = { hz: ( k - 1 + parabolic( lg, 1 ).x ) * binHz, mag: acc[ k ] };

		}

	}

	return best.hz;

}

/**
 * Level of each engine order in a pitch-locked signal: returns dB (re full scale sine) of the lines at
 * mult * fTarget for the given multipliers, using a long FFT.
 */
export function orderLevels( y, sr, f, mults ) {

	const size = 1 << 17;
	const len = Math.min( y.length, size );
	const m = magSpectrum( y, 0, len, size );
	const binHz = sr / size;
	return mults.map( ( mu ) => {

		const k = Math.round( mu * f / binHz );
		let v = 0;
		for ( let d = - 3; d <= 3; d ++ ) v = Math.max( v, m[ k + d ] || 0 );
		return 20 * Math.log10( v + 1e-12 );

	} );

}
