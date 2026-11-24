// Shared audio helpers for the Alpenglow audio pipeline (Node ESM, no dependencies besides ffmpeg/ffprobe on PATH).
// All signal processing happens on Float32Array / Float64Array buffers in memory.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SR = 44100;

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

/** Decode any audio file to float PCM. Returns { sr, channels: Float32Array[], length }. */
export function decode( file, { sr = SR, channels = 1, start = null, duration = null, af = null, pan = null } = {} ) {

	const args = [ '-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0' ];
	const filters = [];
	if ( pan ) filters.push( pan ); // e.g. 'pan=mono|c0=c0' to take the left channel only
	if ( start !== null || duration !== null ) {

		const s = start || 0;
		filters.push( duration !== null ? `atrim=start=${s}:end=${s + duration}` : `atrim=start=${s}` );
		filters.push( 'asetpts=PTS-STARTPTS' );

	}

	if ( af ) filters.push( af );
	filters.push( `aresample=${sr}:filter_size=64:cutoff=0.97` );
	args.push( '-af', filters.join( ',' ), '-ac', String( channels ), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1' );
	const r = spawnSync( 'ffmpeg', args, { maxBuffer: 2 ** 31 - 1 } );
	if ( r.status !== 0 ) throw new Error( `ffmpeg decode failed for ${file}: ${r.stderr}` );
	const buf = r.stdout;
	const all = new Float32Array( buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength - ( buf.byteLength % 4 ) ) );
	const n = Math.floor( all.length / channels );
	const out = [];
	for ( let c = 0; c < channels; c ++ ) {

		const ch = new Float32Array( n );
		for ( let i = 0; i < n; i ++ ) ch[ i ] = all[ i * channels + c ];
		out.push( ch );

	}

	return { sr, channels: out, length: n };

}

/** ffprobe summary of a file. */
export function probe( file ) {

	const r = spawnSync( 'ffprobe', [ '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,duration,bit_rate:format=duration,size,bit_rate', '-of', 'json', file ], { encoding: 'utf8' } );
	if ( r.status !== 0 ) throw new Error( 'ffprobe failed: ' + r.stderr );
	const j = JSON.parse( r.stdout );
	const s = j.streams[ 0 ];
	return {
		codec: s.codec_name,
		sampleRate: Number( s.sample_rate ),
		channels: s.channels,
		bits: s.bits_per_sample,
		duration: Number( s.duration || j.format.duration ),
		size: Number( j.format.size ),
		bitRate: Number( j.format.bit_rate ),
	};

}

let ditherSeed = 0x1234567;
function rnd() { // deterministic xorshift so that rebuilds are byte-identical

	ditherSeed ^= ditherSeed << 13; ditherSeed >>>= 0;
	ditherSeed ^= ditherSeed >>> 17;
	ditherSeed ^= ditherSeed << 5; ditherSeed >>>= 0;
	return ditherSeed / 4294967296;

}

/** Write 16-bit PCM WAV. `channels` = array of Float32Array/Float64Array of equal length. TPDF dither (deterministic). */
export function writeWav( file, channels, sr = SR, { dither = true } = {} ) {

	ditherSeed = 0x1234567;
	const nch = channels.length;
	const n = channels[ 0 ].length;
	const data = Buffer.alloc( 44 + n * nch * 2 );
	data.write( 'RIFF', 0 );
	data.writeUInt32LE( 36 + n * nch * 2, 4 );
	data.write( 'WAVE', 8 );
	data.write( 'fmt ', 12 );
	data.writeUInt32LE( 16, 16 );
	data.writeUInt16LE( 1, 20 );
	data.writeUInt16LE( nch, 22 );
	data.writeUInt32LE( sr, 24 );
	data.writeUInt32LE( sr * nch * 2, 28 );
	data.writeUInt16LE( nch * 2, 32 );
	data.writeUInt16LE( 16, 34 );
	data.write( 'data', 36 );
	data.writeUInt32LE( n * nch * 2, 40 );
	let clipped = 0;
	let o = 44;
	for ( let i = 0; i < n; i ++ ) {

		for ( let c = 0; c < nch; c ++ ) {

			let v = channels[ c ][ i ] * 32767;
			if ( dither ) v += rnd() - rnd();
			v = Math.round( v );
			if ( v > 32767 ) { v = 32767; clipped ++; } else if ( v < - 32768 ) { v = - 32768; clipped ++; }
			data.writeInt16LE( v, o );
			o += 2;

		}

	}

	mkdirSync( dirname( file ), { recursive: true } );
	writeFileSync( file, data );
	return { clipped };

}

/** Read back a 16-bit PCM WAV written by writeWav (used by verification so that we test the real bytes on disk). */
export function readWav16( buf ) {

	if ( buf.toString( 'ascii', 0, 4 ) !== 'RIFF' || buf.toString( 'ascii', 8, 12 ) !== 'WAVE' ) throw new Error( 'not a wav' );
	let p = 12;
	let fmt = null;
	while ( p + 8 <= buf.length ) {

		const id = buf.toString( 'ascii', p, p + 4 );
		const size = buf.readUInt32LE( p + 4 );
		if ( id === 'fmt ' ) fmt = { format: buf.readUInt16LE( p + 8 ), nch: buf.readUInt16LE( p + 10 ), sr: buf.readUInt32LE( p + 12 ), bits: buf.readUInt16LE( p + 22 ) };
		if ( id === 'data' ) {

			if ( ! fmt || fmt.format !== 1 || fmt.bits !== 16 ) throw new Error( 'unsupported wav format' );
			const n = Math.floor( size / ( 2 * fmt.nch ) );
			const channels = [];
			for ( let c = 0; c < fmt.nch; c ++ ) channels.push( new Float32Array( n ) );
			for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < fmt.nch; c ++ ) channels[ c ][ i ] = buf.readInt16LE( p + 8 + ( i * fmt.nch + c ) * 2 ) / 32768;
			return { sr: fmt.sr, channels, length: n, bits: fmt.bits };

		}

		p += 8 + size + ( size & 1 );

	}

	throw new Error( 'no data chunk' );

}

// ---------------------------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------------------------

export const db = ( x ) => 20 * Math.log10( Math.max( x, 1e-12 ) );
export const fromDb = ( d ) => Math.pow( 10, d / 20 );

export function peak( x, from = 0, to = x.length ) {

	let p = 0;
	for ( let i = from; i < to; i ++ ) { const a = Math.abs( x[ i ] ); if ( a > p ) p = a; }
	return p;

}

export function rms( x, from = 0, to = x.length ) {

	let s = 0;
	for ( let i = from; i < to; i ++ ) s += x[ i ] * x[ i ];
	return Math.sqrt( s / Math.max( 1, to - from ) );

}

export function mean( x ) {

	let s = 0;
	for ( let i = 0; i < x.length; i ++ ) s += x[ i ];
	return s / x.length;

}

export function removeDc( x ) {

	const m = mean( x );
	const y = new Float32Array( x.length );
	for ( let i = 0; i < x.length; i ++ ) y[ i ] = x[ i ] - m;
	return y;

}

export function gain( x, g ) {

	const y = new Float32Array( x.length );
	for ( let i = 0; i < x.length; i ++ ) y[ i ] = x[ i ] * g;
	return y;

}

export function mix( list ) { // list of [signal, gain]

	const n = Math.max( ...list.map( ( [ s ] ) => s.length ) );
	const y = new Float32Array( n );
	for ( const [ s, g ] of list ) for ( let i = 0; i < s.length; i ++ ) y[ i ] += s[ i ] * g;
	return y;

}

// ---------------------------------------------------------------------------------------------
// Biquads / filters (RBJ cookbook), zero-phase option
// ---------------------------------------------------------------------------------------------

export function biquadCoefs( type, f0, sr, Q = Math.SQRT1_2, gainDb = 0 ) {

	const w0 = 2 * Math.PI * f0 / sr;
	const cw = Math.cos( w0 ), sw = Math.sin( w0 );
	const alpha = sw / ( 2 * Q );
	const A = Math.pow( 10, gainDb / 40 );
	let b0, b1, b2, a0, a1, a2;
	if ( type === 'lowpass' ) { b0 = ( 1 - cw ) / 2; b1 = 1 - cw; b2 = ( 1 - cw ) / 2; a0 = 1 + alpha; a1 = - 2 * cw; a2 = 1 - alpha; }
	else if ( type === 'highpass' ) { b0 = ( 1 + cw ) / 2; b1 = - ( 1 + cw ); b2 = ( 1 + cw ) / 2; a0 = 1 + alpha; a1 = - 2 * cw; a2 = 1 - alpha; }
	else if ( type === 'bandpass' ) { b0 = alpha; b1 = 0; b2 = - alpha; a0 = 1 + alpha; a1 = - 2 * cw; a2 = 1 - alpha; }
	else if ( type === 'notch' ) { b0 = 1; b1 = - 2 * cw; b2 = 1; a0 = 1 + alpha; a1 = - 2 * cw; a2 = 1 - alpha; }
	else if ( type === 'peaking' ) { b0 = 1 + alpha * A; b1 = - 2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = - 2 * cw; a2 = 1 - alpha / A; }
	else if ( type === 'lowshelf' ) {

		const s = 2 * Math.sqrt( A ) * alpha;
		b0 = A * ( ( A + 1 ) - ( A - 1 ) * cw + s ); b1 = 2 * A * ( ( A - 1 ) - ( A + 1 ) * cw ); b2 = A * ( ( A + 1 ) - ( A - 1 ) * cw - s );
		a0 = ( A + 1 ) + ( A - 1 ) * cw + s; a1 = - 2 * ( ( A - 1 ) + ( A + 1 ) * cw ); a2 = ( A + 1 ) + ( A - 1 ) * cw - s;

	} else if ( type === 'highshelf' ) {

		const s = 2 * Math.sqrt( A ) * alpha;
		b0 = A * ( ( A + 1 ) + ( A - 1 ) * cw + s ); b1 = - 2 * A * ( ( A - 1 ) + ( A + 1 ) * cw ); b2 = A * ( ( A + 1 ) + ( A - 1 ) * cw - s );
		a0 = ( A + 1 ) - ( A - 1 ) * cw + s; a1 = 2 * ( ( A - 1 ) - ( A + 1 ) * cw ); a2 = ( A + 1 ) - ( A - 1 ) * cw - s;

	} else throw new Error( 'unknown biquad type ' + type );
	return [ b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0 ];

}

export function biquad( x, c ) {

	const [ b0, b1, b2, a1, a2 ] = c;
	const y = new Float64Array( x.length );
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	for ( let i = 0; i < x.length; i ++ ) {

		const xi = x[ i ];
		const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1; x1 = xi; y2 = y1; y1 = yi;
		y[ i ] = yi;

	}

	return y;

}

/** Zero-phase (forward-backward) filtering; squares the magnitude response. Edge handling by reflection padding. */
export function filtfilt( x, c, pad = 4096 ) {

	const n = x.length;
	pad = Math.min( pad, n - 1 );
	const ext = new Float64Array( n + 2 * pad );
	for ( let i = 0; i < pad; i ++ ) ext[ i ] = 2 * x[ 0 ] - x[ pad - i ];
	for ( let i = 0; i < n; i ++ ) ext[ pad + i ] = x[ i ];
	for ( let i = 0; i < pad; i ++ ) ext[ pad + n + i ] = 2 * x[ n - 1 ] - x[ n - 2 - i ];
	let y = biquad( ext, c );
	y.reverse();
	y = biquad( y, c );
	y.reverse();
	const out = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) out[ i ] = y[ pad + i ];
	return out;

}

/** Apply a chain of filters given as [type, f0, Q, gainDb] (causal, in order). */
export function filterChain( x, sr, chain, zeroPhase = false ) {

	let y = x;
	for ( const [ type, f0, Q, g ] of chain ) {

		const c = biquadCoefs( type, f0, sr, Q ?? Math.SQRT1_2, g ?? 0 );
		y = zeroPhase ? filtfilt( y, c ) : Float32Array.from( biquad( y, c ) );

	}

	return y;

}

// ---------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4 K-weighting + EBU R128 gating), any sample rate
// ---------------------------------------------------------------------------------------------

function kWeight( x, sr ) {

	// Coefficient derivation as in libebur128 (matches the ITU table exactly at 48 kHz).
	let f0 = 1681.974450955533;
	const G = 3.999843853973347;
	let Q = 0.7071752369554196;
	let K = Math.tan( Math.PI * f0 / sr );
	const Vh = Math.pow( 10, G / 20 );
	const Vb = Math.pow( Vh, 0.4996667741545416 );
	let a0 = 1 + K / Q + K * K;
	const shelf = [ ( Vh + Vb * K / Q + K * K ) / a0, 2 * ( K * K - Vh ) / a0, ( Vh - Vb * K / Q + K * K ) / a0, 2 * ( K * K - 1 ) / a0, ( 1 - K / Q + K * K ) / a0 ];
	f0 = 38.13547087602444;
	Q = 0.5003270373238773;
	K = Math.tan( Math.PI * f0 / sr );
	a0 = 1 + K / Q + K * K;
	const hp = [ 1, - 2, 1, 2 * ( K * K - 1 ) / a0, ( 1 - K / Q + K * K ) / a0 ];
	return biquad( biquad( x, shelf ), hp );

}

/**
 * Integrated loudness in LUFS. `channels`: array of channel buffers (mono or stereo, unity channel weights).
 * `periodic`: treat the signal as a loop (tiles it so that blocks wrap around and short loops get enough blocks).
 */
export function loudness( channels, sr = SR, { periodic = false } = {} ) {

	const block = Math.round( 0.4 * sr );
	const hop = Math.round( 0.1 * sr );
	let chans = channels;
	if ( periodic ) {

		const n = channels[ 0 ].length;
		const reps = Math.max( 3, Math.ceil( ( 4 * sr ) / n ) + 2 );
		chans = channels.map( ( ch ) => {

			const t = new Float32Array( n * reps );
			for ( let r = 0; r < reps; r ++ ) t.set( ch, r * n );
			return t;

		} );

	}

	const weighted = chans.map( ( ch ) => kWeight( ch, sr ) );
	const n = weighted[ 0 ].length;
	// skip the first repetition when periodic (filter warm-up)
	const startAt = periodic ? channels[ 0 ].length : 0;
	const z = [];
	for ( let s = startAt; s + block <= n; s += hop ) {

		let sum = 0;
		for ( const w of weighted ) {

			let e = 0;
			for ( let i = s; i < s + block; i ++ ) e += w[ i ] * w[ i ];
			sum += e / block;

		}

		z.push( sum );

	}

	if ( z.length === 0 ) {

		// shorter than one block: ungated
		let sum = 0;
		for ( const w of weighted ) { let e = 0; for ( let i = 0; i < n; i ++ ) e += w[ i ] * w[ i ]; sum += e / n; }
		return - 0.691 + 10 * Math.log10( Math.max( sum, 1e-12 ) );

	}

	const l = ( v ) => - 0.691 + 10 * Math.log10( Math.max( v, 1e-12 ) );
	const abs = z.filter( ( v ) => l( v ) > - 70 );
	if ( abs.length === 0 ) return - 70;
	const rel = l( abs.reduce( ( a, b ) => a + b, 0 ) / abs.length ) - 10;
	const gated = abs.filter( ( v ) => l( v ) > rel );
	return l( gated.reduce( ( a, b ) => a + b, 0 ) / gated.length );

}

// ---------------------------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------------------------

/** In-place radix-2 complex FFT (re, im: Float64Array, length power of two). */
export function fft( re, im ) {

	const n = re.length;
	for ( let i = 1, j = 0; i < n; i ++ ) {

		let bit = n >> 1;
		for ( ; j & bit; bit >>= 1 ) j ^= bit;
		j ^= bit;
		if ( i < j ) { let t = re[ i ]; re[ i ] = re[ j ]; re[ j ] = t; t = im[ i ]; im[ i ] = im[ j ]; im[ j ] = t; }

	}

	for ( let len = 2; len <= n; len <<= 1 ) {

		const ang = - 2 * Math.PI / len;
		const wr = Math.cos( ang ), wi = Math.sin( ang );
		for ( let i = 0; i < n; i += len ) {

			let cr = 1, ci = 0;
			for ( let k = 0; k < len / 2; k ++ ) {

				const ur = re[ i + k ], ui = im[ i + k ];
				const vr = re[ i + k + len / 2 ] * cr - im[ i + k + len / 2 ] * ci;
				const vi = re[ i + k + len / 2 ] * ci + im[ i + k + len / 2 ] * cr;
				re[ i + k ] = ur + vr; im[ i + k ] = ui + vi;
				re[ i + k + len / 2 ] = ur - vr; im[ i + k + len / 2 ] = ui - vi;
				const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;

			}

		}

	}

}

export function nextPow2( n ) { let p = 1; while ( p < n ) p <<= 1; return p; }

/** Magnitude spectrum of a Hann-windowed frame (zero-padded to `size`). Returns Float64Array(size/2+1) of linear magnitudes. */
export function magSpectrum( x, start, len, size = nextPow2( len ) ) {

	const re = new Float64Array( size ), im = new Float64Array( size );
	let wsum = 0;
	for ( let i = 0; i < len; i ++ ) {

		const w = 0.5 - 0.5 * Math.cos( 2 * Math.PI * ( i + 0.5 ) / len );
		wsum += w;
		const j = start + i;
		re[ i ] = ( j >= 0 && j < x.length ? x[ j ] : 0 ) * w;

	}

	fft( re, im );
	const m = new Float64Array( size / 2 + 1 );
	for ( let k = 0; k <= size / 2; k ++ ) m[ k ] = 2 * Math.hypot( re[ k ], im[ k ] ) / wsum;
	return m;

}

/** Welch-averaged power spectrum over the whole signal. Returns { freqs(k), power: Float64Array, binHz }. */
export function welch( x, sr, size = 16384, hopFrac = 0.5 ) {

	const hop = Math.max( 1, Math.round( size * hopFrac ) );
	const acc = new Float64Array( size / 2 + 1 );
	let frames = 0;
	if ( x.length < size ) {

		const m = magSpectrum( x, 0, x.length, size );
		for ( let k = 0; k < acc.length; k ++ ) acc[ k ] = m[ k ] * m[ k ];
		frames = 1;

	} else {

		for ( let s = 0; s + size <= x.length; s += hop ) {

			const m = magSpectrum( x, s, size, size );
			for ( let k = 0; k < acc.length; k ++ ) acc[ k ] += m[ k ] * m[ k ];
			frames ++;

		}

	}

	for ( let k = 0; k < acc.length; k ++ ) acc[ k ] /= frames;
	return { power: acc, binHz: sr / size, frames };

}

// ---------------------------------------------------------------------------------------------
// Autocorrelation (FFT based, normalized) and periodicity helpers
// ---------------------------------------------------------------------------------------------

/** Normalized autocorrelation r[lag] for lag in [0, maxLag], computed on x[start..start+len). */
export function autocorr( x, start, len, maxLag ) {

	const size = nextPow2( len + maxLag + 1 );
	const re = new Float64Array( size ), im = new Float64Array( size );
	let m = 0;
	for ( let i = 0; i < len; i ++ ) m += x[ start + i ];
	m /= len;
	for ( let i = 0; i < len; i ++ ) re[ i ] = x[ start + i ] - m;
	fft( re, im );
	for ( let k = 0; k < size; k ++ ) { re[ k ] = re[ k ] * re[ k ] + im[ k ] * im[ k ]; im[ k ] = 0; }
	fft( re, im ); // forward again == inverse up to scale/reversal for a real even input
	const r = new Float64Array( maxLag + 1 );
	// unbiased-ish normalization by overlapping energy
	const r0 = re[ 0 ];
	for ( let lag = 0; lag <= maxLag; lag ++ ) r[ lag ] = ( re[ lag ] / r0 ) * ( len / ( len - lag ) );
	return r;

}

/** Parabolic interpolation of a peak at integer index i of array a. Returns { x, y }. */
export function parabolic( a, i ) {

	if ( i <= 0 || i >= a.length - 1 ) return { x: i, y: a[ i ] };
	const y0 = a[ i - 1 ], y1 = a[ i ], y2 = a[ i + 1 ];
	const d = y0 - 2 * y1 + y2;
	if ( d === 0 ) return { x: i, y: y1 };
	const dx = 0.5 * ( y0 - y2 ) / d;
	return { x: i + dx, y: y1 - 0.25 * ( y0 - y2 ) * dx };

}

// ---------------------------------------------------------------------------------------------
// Resampling (windowed sinc) at arbitrary, possibly time-varying positions
// ---------------------------------------------------------------------------------------------

/**
 * Sample x at fractional positions pos[i] (in input samples) with a Kaiser-windowed sinc.
 * `ratio[i]` (optional) = local output/input speed (>1 means reading faster => lowpass to avoid aliasing).
 */
export function sincResample( x, pos, ratio = null, halfWidth = 32 ) {

	const out = new Float32Array( pos.length );
	const beta = 9.0;
	const i0 = ( v ) => { // modified Bessel function of the first kind, order 0

		let s = 1, t = 1;
		for ( let k = 1; k < 30; k ++ ) { t *= ( v / ( 2 * k ) ) * ( v / ( 2 * k ) ); s += t; if ( t < 1e-12 * s ) break; }
		return s;

	};

	const i0b = i0( beta );
	for ( let i = 0; i < pos.length; i ++ ) {

		const p = pos[ i ];
		const speed = ratio ? Math.max( 1, ratio[ i ] ) : 1;
		const cutoff = 1 / speed; // relative to input Nyquist
		const hw = Math.ceil( halfWidth * speed );
		const c = Math.floor( p );
		let acc = 0, wsum = 0;
		for ( let k = c - hw + 1; k <= c + hw; k ++ ) {

			if ( k < 0 || k >= x.length ) continue;
			const d = p - k;
			const u = d / hw;
			if ( u <= - 1 || u >= 1 ) continue;
			const win = i0( beta * Math.sqrt( 1 - u * u ) ) / i0b;
			const a = Math.PI * d * cutoff;
			const s = Math.abs( a ) < 1e-9 ? 1 : Math.sin( a ) / a;
			const w = s * win * cutoff;
			acc += x[ k ] * w;
			wsum += w;

		}

		out[ i ] = wsum !== 0 ? acc / wsum * 1 : 0;

	}

	return out;

}

// ---------------------------------------------------------------------------------------------
// Seamless loops
// ---------------------------------------------------------------------------------------------

/**
 * Build a seamless loop of `len` samples from x starting at `start`, crossfading the `xf` samples that follow the
 * loop end (x[start+len .. start+len+xf)) into the loop start. The crossfade law keeps the expected power constant
 * for the measured correlation r between the two overlapped pieces (r=0 -> equal power sin/cos, r=1 -> linear).
 * Returns { loop: Float32Array(len), corr }.
 */
export function makeLoop( x, start, len, xf ) {

	if ( start + len + xf > x.length ) throw new Error( `makeLoop: need ${start + len + xf} samples, have ${x.length}` );
	const out = new Float32Array( len );
	for ( let i = 0; i < len; i ++ ) out[ i ] = x[ start + i ];
	let sab = 0, saa = 0, sbb = 0;
	for ( let i = 0; i < xf; i ++ ) { const a = x[ start + i ], b = x[ start + len + i ]; sab += a * b; saa += a * a; sbb += b * b; }
	const corr = sab / Math.sqrt( saa * sbb + 1e-30 );
	const r = Math.max( 0, Math.min( 1, corr ) );
	for ( let i = 0; i < xf; i ++ ) {

		const t = ( i + 0.5 ) / xf;
		let gin = Math.sin( 0.5 * Math.PI * t ), gout = Math.cos( 0.5 * Math.PI * t );
		const norm = Math.sqrt( gin * gin + gout * gout + 2 * r * gin * gout );
		gin /= norm; gout /= norm;
		out[ i ] = x[ start + i ] * gin + x[ start + len + i ] * gout;

	}

	return { loop: out, corr };

}

/**
 * Seamless loop for a PITCH-LOCKED periodic signal (engine): `len` must be a multiple of the cycle length `cyc`.
 * The signal is split into its cycle-periodic part (synchronous average over +-K neighbouring cycles) and the residual
 * (noise, cycle-to-cycle variation). The periodic parts of loop tail and loop head are in phase, so they are crossfaded
 * linearly (constant amplitude); the residuals are uncorrelated, so they are crossfaded with equal power.
 * This avoids the level bump/dip that a single crossfade law produces on mixed tonal + noisy material.
 */
export function makeLoopPeriodic( x, start, len, xf, cyc, K = 2 ) {

	if ( start + len + xf > x.length ) throw new Error( `makeLoopPeriodic: need ${start + len + xf} samples, have ${x.length}` );
	const out = new Float32Array( len );
	for ( let i = 0; i < len; i ++ ) out[ i ] = x[ start + i ];
	const periodic = ( idx ) => {

		let s = 0, n = 0;
		for ( let k = - K; k <= K; k ++ ) {

			const j = idx + k * cyc;
			if ( j >= 0 && j < x.length ) { s += x[ j ]; n ++; }

		}

		return s / n;

	};

	let sab = 0, saa = 0, sbb = 0;
	for ( let i = 0; i < xf; i ++ ) {

		const a = x[ start + i ], b = x[ start + len + i ];
		const pa = periodic( start + i ), pb = periodic( start + len + i );
		sab += pa * pb; saa += pa * pa; sbb += pb * pb;
		const t = ( i + 0.5 ) / xf;
		const gin = Math.sin( 0.5 * Math.PI * t ), gout = Math.cos( 0.5 * Math.PI * t );
		out[ i ] = pa * t + pb * ( 1 - t ) + ( a - pa ) * gin + ( b - pb ) * gout;

	}

	return { loop: out, corr: sab / Math.sqrt( saa * sbb + 1e-30 ) };

}

/**
 * Find a loop length close to `targetLen` such that the audio right after the loop end matches the loop start as well
 * as possible (maximum normalized cross-correlation over a window of `win` samples). Searches +-`search` samples.
 */
export function bestLoopLength( x, start, targetLen, search, win ) {

	let best = { len: targetLen, corr: - Infinity };
	let saa = 0;
	for ( let i = 0; i < win; i ++ ) saa += x[ start + i ] * x[ start + i ];
	for ( let len = targetLen - search; len <= targetLen + search; len ++ ) {

		if ( len < win || start + len + win > x.length ) continue;
		let sab = 0, sbb = 0;
		for ( let i = 0; i < win; i ++ ) { const b = x[ start + len + i ]; sab += x[ start + i ] * b; sbb += b * b; }
		const c = sab / Math.sqrt( saa * sbb + 1e-30 );
		if ( c > best.corr ) best = { len, corr: c };

	}

	return best;

}

/**
 * Loop-point quality metrics for a loop buffer (one channel):
 *  jump      = |x[0] - x[n-1]|  (the step the player makes when wrapping)
 *  diffRms   = RMS of sample-to-sample differences inside the loop
 *  diffP999  = 99.9th percentile of |sample-to-sample difference| inside the loop
 *  slopeJump = |(x[1]-x[0]) - (x[0]-x[n-1])| second difference across the seam, vs. its RMS inside the loop
 * A seam is inaudible when jump is within the normal range of in-loop differences (ratio <~ 3 of diffRms and < diffP999).
 */
export function loopSeam( x ) {

	const n = x.length;
	const diffs = new Float64Array( n - 1 );
	let s = 0;
	for ( let i = 1; i < n; i ++ ) { const d = x[ i ] - x[ i - 1 ]; diffs[ i - 1 ] = Math.abs( d ); s += d * d; }
	const diffRms = Math.sqrt( s / ( n - 1 ) );
	const sorted = Float64Array.from( diffs ).sort();
	const diffP999 = sorted[ Math.floor( 0.999 * ( n - 2 ) ) ];
	const diffMax = sorted[ n - 2 ];
	const jump = Math.abs( x[ 0 ] - x[ n - 1 ] );
	let s2 = 0;
	for ( let i = 2; i < n; i ++ ) { const d2 = x[ i ] - 2 * x[ i - 1 ] + x[ i - 2 ]; s2 += d2 * d2; }
	const d2Rms = Math.sqrt( s2 / ( n - 2 ) );
	const seamD2a = Math.abs( x[ 0 ] - 2 * x[ n - 1 ] + x[ n - 2 ] );
	const seamD2b = Math.abs( x[ 1 ] - 2 * x[ 0 ] + x[ n - 1 ] );
	return { jump, diffRms, diffP999, diffMax, jumpOverRms: jump / ( diffRms + 1e-12 ), d2Rms, seamD2: Math.max( seamD2a, seamD2b ), seamD2OverRms: Math.max( seamD2a, seamD2b ) / ( d2Rms + 1e-12 ) };

}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** Short raised-cosine fade in/out (for one-shots). */
export function fade( x, fadeIn, fadeOut ) {

	const y = Float32Array.from( x );
	for ( let i = 0; i < Math.min( fadeIn, y.length ); i ++ ) y[ i ] *= 0.5 - 0.5 * Math.cos( Math.PI * ( i + 0.5 ) / fadeIn );
	for ( let i = 0; i < Math.min( fadeOut, y.length ); i ++ ) y[ y.length - 1 - i ] *= 0.5 - 0.5 * Math.cos( Math.PI * ( i + 0.5 ) / fadeOut );
	return y;

}

/** Envelope (RMS over windows of `win` samples, hop `hop`). */
export function envelope( x, win, hop ) {

	const out = [];
	for ( let s = 0; s + win <= x.length; s += hop ) out.push( rms( x, s, s + win ) );
	return Float64Array.from( out );

}

/** Render a spectrogram PNG with ffmpeg showspectrumpic. */
export function spectrogram( file, png, { width = 1600, height = 700, stop = 0, start = 0, fscale = 'lin', drange = 90, limit = 0, mono = true, ar = 0 } = {} ) {

	mkdirSync( dirname( png ), { recursive: true } );
	let f = `showspectrumpic=s=${width}x${height}:mode=combined:color=magma:scale=log:fscale=${fscale}:win_func=hann:legend=1:drange=${drange}:limit=${limit}`;
	if ( stop ) f += `:start=${start}:stop=${stop}`;
	// `ar`: resample first so that the whole picture height covers 0..ar/2 Hz (much finer frequency resolution
	// for low-frequency harmonic content than the `stop` zoom, which only crops the default FFT).
	if ( ar ) f = `aresample=${ar},` + f;
	if ( mono ) f = 'aformat=channel_layouts=mono,' + f;
	const r = spawnSync( 'ffmpeg', [ '-v', 'error', '-nostdin', '-y', '-i', file, '-lavfi', f, '-frames:v', '1', png ], { encoding: 'utf8' } );
	if ( r.status !== 0 ) throw new Error( 'spectrogram failed: ' + r.stderr );
	return png;

}
