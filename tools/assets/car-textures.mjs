#!/usr/bin/env node
// Generate the (original, procedural) tyre textures used by the car material recipe.
//   node tools/assets/car-textures.mjs [--out public/assets/car]
// Outputs
//   tire_tread_n.png     256x512  RGB = tangent-space normal (OpenGL, +Y up), A = cavity (1 = tread surface, 0 = groove floor)
//                        tiles along U (around the tyre, TREAD_REPEATS times), V spans the tread from the outboard to the inboard shoulder
//   tire_sidewall_n.png  2048x256 RGB = normal, A = height (0.5 = base). U = once around the tyre, V = bead (0) -> shoulder (1)
// Both are authored for TextureLoader defaults (flipY = true): image top row = V 1.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice( 2 );
const OUT = argv.includes( '--out' ) ? argv[ argv.indexOf( '--out' ) + 1 ] : 'public/assets/car';
mkdirSync( OUT, { recursive: true } );

const smooth = ( a, b, x ) => { const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) ); return t * t * ( 3 - 2 * t ); };

// height (float, mm) + size in mm -> RGBA normal map. rows run top (v = 1) to bottom (v = 0).
function toNormalMap( h, w, hgt, mmPerPxX, mmPerPxY, strength, alphaFn, wrapX = true ) {

	const out = Buffer.alloc( w * hgt * 4 );
	for ( let y = 0; y < hgt; y ++ ) {

		const y0 = Math.max( 0, y - 1 ), y1 = Math.min( hgt - 1, y + 1 );
		for ( let x = 0; x < w; x ++ ) {

			const x0 = wrapX ? ( x + w - 1 ) % w : Math.max( 0, x - 1 ), x1 = wrapX ? ( x + 1 ) % w : Math.min( w - 1, x + 1 );
			const dhdx = ( h[ y * w + x1 ] - h[ y * w + x0 ] ) / ( 2 * mmPerPxX );
			const dhdv = - ( h[ y1 * w + x ] - h[ y0 * w + x ] ) / ( ( y1 - y0 ) * mmPerPxY ); // v points up = towards row 0
			let nx = - dhdx * strength, ny = - dhdv * strength, nz = 1;
			const l = Math.hypot( nx, ny, nz );
			nx /= l; ny /= l; nz /= l;
			const o = ( y * w + x ) * 4;
			out[ o ] = Math.round( ( nx * 0.5 + 0.5 ) * 255 );
			out[ o + 1 ] = Math.round( ( ny * 0.5 + 0.5 ) * 255 );
			out[ o + 2 ] = Math.round( ( nz * 0.5 + 0.5 ) * 255 );
			out[ o + 3 ] = Math.round( Math.min( 1, Math.max( 0, alphaFn( h[ y * w + x ] ) ) ) * 255 );

		}

	}

	return out;

}

// ---------------------------------------------------------------------------------------------------------------------
// tread tile: one pitch (about 35 mm of circumference) x full tread width (about 0.21-0.23 m)
// ---------------------------------------------------------------------------------------------------------------------
{

	const W = 256, H = 512;
	const PITCH_MM = 35, WIDTH_MM = 215;
	const h = new Float32Array( W * H ); // mm, 0 = tread surface, negative = groove
	const groove = ( d, halfWidth, depth, edge = 0.6 ) => - depth * ( 1 - smooth( halfWidth - edge, halfWidth + edge, Math.abs( d ) ) );
	for ( let y = 0; y < H; y ++ ) {

		const t = 1 - ( y + 0.5 ) / H; // row 0 = v 1 = inboard edge; t = 0 at the outboard edge
		const xmm = t * WIDTH_MM;
		for ( let x = 0; x < W; x ++ ) {

			const u = ( x + 0.5 ) / W;
			let v = 0;
			// four circumferential grooves
			for ( const [ c, hw ] of [ [ 0.23, 4.6 ], [ 0.404, 5.0 ], [ 0.596, 5.0 ], [ 0.77, 4.2 ] ] ) v = Math.min( v, groove( xmm - c * WIDTH_MM, hw, 6.5 ) );
			// outboard shoulder: one slanted lateral groove per pitch (does not reach the first circumferential groove)
			if ( t < 0.21 ) {

				const ph = ( ( u - 0.5 - ( t - 0.1 ) * 1.1 ) % 1 + 1.5 ) % 1 - 0.5; // slanted
				const fade = smooth( 0.205, 0.17, t );
				v = Math.min( v, groove( ph * PITCH_MM, 1.9, 4.5 * fade, 0.5 ) );

			}

			// inboard shoulder: two finer lateral grooves per pitch
			if ( t > 0.79 ) {

				const ph = ( ( u * 2 + ( t - 0.9 ) * 1.4 ) % 1 + 1.5 ) % 1 - 0.5;
				const fade = smooth( 0.795, 0.83, t );
				v = Math.min( v, groove( ph * PITCH_MM / 2, 1.4, 4.0 * fade, 0.5 ) );

			}

			// intermediate ribs: thin angled sipes that stop short of the grooves
			for ( const [ a, b, dir ] of [ [ 0.262, 0.372, 1 ], [ 0.628, 0.742, - 1 ] ] ) {

				if ( t > a && t < b ) {

					const m = ( t - a ) / ( b - a );
					const ph = ( ( u - 0.25 - dir * ( m - 0.5 ) * 0.55 ) % 1 + 1.5 ) % 1 - 0.5;
					const fade = smooth( 0.0, 0.12, m ) * smooth( 1.0, 0.62, m );
					v = Math.min( v, groove( ph * PITCH_MM, 0.75, 3.0 * fade, 0.45 ) );

				}

			}

			h[ y * W + x ] = v;

		}

	}

	const buf = toNormalMap( h, W, H, PITCH_MM / W, WIDTH_MM / H, 0.55, ( v ) => 1 + v / 6.5 );
	await sharp( buf, { raw: { width: W, height: H, channels: 4 } } ).png( { compressionLevel: 9 } ).toFile( join( OUT, 'tire_tread_n.png' ) );
	console.log( 'wrote', join( OUT, 'tire_tread_n.png' ), W, 'x', H );

}

// ---------------------------------------------------------------------------------------------------------------------
// sidewall strip: lettering + rim protector + grooves. Drawn at isotropic resolution, then squeezed along U.
// ---------------------------------------------------------------------------------------------------------------------
{

	const W = 2048, H = 256, SQ = 3.5, WI = W * SQ; // isotropic canvas 7168 x 256
	const LEN_MM = 70; // bead -> shoulder
	const text = ( x, y, size, str, spacing = 0, weight = 700 ) => `<text x="${x}" y="${y}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="${weight}" font-size="${size}" letter-spacing="${spacing}" text-anchor="middle" fill="#ffffff">${str}</text>`;
	let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WI}" height="${H}"><rect width="100%" height="100%" fill="#000"/>`;
	// big brand lettering at two opposite positions, smaller model lettering in between (image top = shoulder side)
	for ( const cx of [ WI * 0.125, WI * 0.625 ] ) svg += text( cx, 162, 92, 'ALPENGLOW', 16, 800 );
	for ( const cx of [ WI * 0.375, WI * 0.875 ] ) svg += text( cx, 150, 54, 'PASSO SPORT', 10, 700 ) + text( cx, 196, 26, 'ZR 20  ·  RADIAL  ·  TUBELESS', 5, 500 );
	// small wear-indicator triangles near the shoulder
	for ( let i = 0; i < 6; i ++ ) { const cx = WI * ( i + 0.5 ) / 6 + ( i % 2 ? 90 : - 90 ); svg += `<path d="M ${cx - 9} 36 L ${cx + 9} 36 L ${cx} 22 Z" fill="#fff"/>`; }
	svg += '</svg>';
	const lettering = await sharp( Buffer.from( svg ) ).resize( W, H, { fit: 'fill', kernel: 'lanczos3' } ).blur( 0.8 ).greyscale().raw().toBuffer();
	const h = new Float32Array( W * H ); // mm
	for ( let y = 0; y < H; y ++ ) {

		const v = 1 - ( y + 0.5 ) / H; // 0 = bead, 1 = shoulder
		let base = 0;
		base += 1.1 * Math.exp( - Math.pow( ( v - 0.14 ) / 0.055, 2 ) ); // rim protector rib
		base -= 0.5 * Math.exp( - Math.pow( ( v - 0.285 ) / 0.012, 2 ) ); // groove above the protector
		base -= 0.45 * Math.exp( - Math.pow( ( v - 0.80 ) / 0.010, 2 ) ); // decorative grooves near the shoulder
		base -= 0.45 * Math.exp( - Math.pow( ( v - 0.955 ) / 0.010, 2 ) );
		for ( let x = 0; x < W; x ++ ) h[ y * W + x ] = base + 0.75 * lettering[ y * W + x ] / 255;

	}

	const mmX = 1998 / W, mmY = LEN_MM / H;
	const buf = toNormalMap( h, W, H, mmX, mmY, 1.6, ( v ) => 0.5 + v * 0.35 );
	await sharp( buf, { raw: { width: W, height: H, channels: 4 } } ).png( { compressionLevel: 9 } ).toFile( join( OUT, 'tire_sidewall_n.png' ) );
	console.log( 'wrote', join( OUT, 'tire_sidewall_n.png' ), W, 'x', H );

}
