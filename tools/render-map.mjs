// Debug renderer of the circuit and its landscape (Node + sharp). Writes PNGs for visual iteration on the layout.
//
//   node tools/render-map.mjs <outDir> [--zoom=centerX,centerZ,span] [--only=map,wide,elevation,dynamics]
//
//   map.png        2048 x 2048 top-down map of the playable square: hill-shaded baseHeight with hypsometric tint and
//                  contour lines every 20 m, the lake, the road at true width, start line, direction arrows, s-markers
//                  every 250 m, corner names, control points with their index
//   map-wide.png   the far ring (WORLD.outerSize) with the playable square outlined, contours every 100 m
//   elevation.png  height profile y(s) coloured by grade, terrain under the route (cut / fill), grade, vertical load
//   dynamics.png   curvature, estimated speed, width and banking along the lap
//   map-zoom.png   (with --zoom) a close-up, same style as map.png; span is the edge length of the square in meters
//
// The map is drawn north-up in the sense of the game's axes: +X to the right, +Z down (a car at yaw 0 drives up).
// Every drawing function is exported so that other tools can add their own overlays.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { clamp, KMH_PER_MS, RAD2DEG } from '../src/core/math.js';
import { GRAVITY } from '../src/sim/constants.js';
import { LAYOUT, WORLD, baseHeight } from '../src/sim/layout.js';
import { LIMITS, checkLayout } from '../src/sim/layoutCheck.js';
import { Track } from '../src/sim/track.js';

const FONT = 'font-family="Helvetica, Arial, sans-serif"';

/**
 * A square top-down view: maps world (x, z) to pixels.
 * @typedef {Object} MapView
 * @property {number} minX     world x of the left image edge
 * @property {number} minZ     world z of the top image edge
 * @property {number} span     edge length of the viewed square in meters
 * @property {number} pixels   edge length of the image in pixels
 * @property {number} scale    pixels per meter
 * @property {(x: number) => number} px  world x -> pixel x
 * @property {(z: number) => number} py  world z -> pixel y
 */

/**
 * Creates a square top-down view.
 * @param {{centerX?: number, centerZ?: number, span: number, pixels?: number}} options
 * @returns {MapView}
 */
export function createView( { centerX = 0, centerZ = 0, span, pixels = 2048 } ) {

	const minX = centerX - span / 2, minZ = centerZ - span / 2, scale = pixels / span;
	return { minX, minZ, span, pixels, scale, px: ( x ) => ( x - minX ) * scale, py: ( z ) => ( z - minZ ) * scale };

}

/** Hypsometric colour stops: [height above the water in meters, r, g, b]. */
const TINT_STOPS = [
	[ 0, 196, 190, 150 ],
	[ 6, 150, 178, 110 ],
	[ 40, 112, 156, 92 ],
	[ 110, 142, 160, 96 ],
	[ 220, 176, 166, 112 ],
	[ 420, 158, 136, 108 ],
	[ 750, 150, 144, 138 ],
	[ 1150, 206, 206, 208 ],
	[ 1700, 250, 250, 252 ],
];

/** Writes the hypsometric tint for a height above the water into `rgb`. */
function tintAt( height, rgb ) {

	let k = 1;
	while ( k < TINT_STOPS.length - 1 && TINT_STOPS[ k ][ 0 ] < height ) k ++;
	const a = TINT_STOPS[ k - 1 ], b = TINT_STOPS[ k ];
	const t = clamp( ( height - a[ 0 ] ) / ( b[ 0 ] - a[ 0 ] ), 0, 1 );
	rgb[ 0 ] = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t;
	rgb[ 1 ] = a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t;
	rgb[ 2 ] = a[ 3 ] + ( b[ 3 ] - a[ 3 ] ) * t;

}

/**
 * Renders a height function as a hill-shaded, hypsometrically tinted relief with contour lines and water.
 * The height function is sampled on a coarser grid and interpolated, so the cost is resolution^2 evaluations.
 * @param {MapView} view
 * @param {(x: number, z: number) => number} heightFn
 * @param {object} [options]
 * @param {number} [options.resolution] height samples per image edge (default: half the pixel size)
 * @param {number} [options.waterLevel=0] everything below is drawn as water
 * @param {number} [options.contourInterval=20] meters between contour lines (0 = none)
 * @param {number} [options.majorEvery=5] every n-th contour is drawn stronger
 * @param {number} [options.exaggeration=2] vertical exaggeration of the shading
 * @returns {Buffer} raw RGBA pixels (view.pixels x view.pixels)
 */
export function shadeTerrain( view, heightFn, { resolution = view.pixels >> 1, waterLevel = 0, contourInterval = 20, majorEvery = 5, exaggeration = 2 } = {} ) {

	const pixels = view.pixels, nodes = resolution + 1, cell = view.span / resolution;
	const heights = new Float32Array( nodes * nodes );
	for ( let iz = 0; iz < nodes; iz ++ ) {

		for ( let ix = 0; ix < nodes; ix ++ ) heights[ iz * nodes + ix ] = heightFn( view.minX + ix * cell, view.minZ + iz * cell );

	}

	// Height gradient per node (central differences), interpolated per pixel for smooth shading.
	const slopeX = new Float32Array( nodes * nodes ), slopeZ = new Float32Array( nodes * nodes );
	for ( let iz = 0; iz < nodes; iz ++ ) {

		for ( let ix = 0; ix < nodes; ix ++ ) {

			const x0 = Math.max( ix - 1, 0 ), x1 = Math.min( ix + 1, nodes - 1 ), z0 = Math.max( iz - 1, 0 ), z1 = Math.min( iz + 1, nodes - 1 );
			slopeX[ iz * nodes + ix ] = ( heights[ iz * nodes + x1 ] - heights[ iz * nodes + x0 ] ) / ( ( x1 - x0 ) * cell );
			slopeZ[ iz * nodes + ix ] = ( heights[ z1 * nodes + ix ] - heights[ z0 * nodes + ix ] ) / ( ( z1 - z0 ) * cell );

		}

	}

	// Per-pixel height first (the contour test needs the neighbours), then colour.
	const pixelHeights = new Float32Array( pixels * pixels );
	const shades = new Float32Array( pixels * pixels );
	const lightLength = Math.hypot( 1, 1.3, 1 );
	const lightX = - 1 / lightLength, lightY = 1.3 / lightLength, lightZ = - 1 / lightLength; // from the upper left
	const perPixel = resolution / pixels;
	for ( let py = 0; py < pixels; py ++ ) {

		const gz = Math.min( ( py + 0.5 ) * perPixel, resolution - 1e-4 ), iz = Math.floor( gz ), fz = gz - iz;
		for ( let px = 0; px < pixels; px ++ ) {

			const gx = Math.min( ( px + 0.5 ) * perPixel, resolution - 1e-4 ), ix = Math.floor( gx ), fx = gx - ix;
			const a = iz * nodes + ix, b = a + 1, c = a + nodes, d = c + 1;
			const w00 = ( 1 - fx ) * ( 1 - fz ), w10 = fx * ( 1 - fz ), w01 = ( 1 - fx ) * fz, w11 = fx * fz;
			pixelHeights[ py * pixels + px ] = heights[ a ] * w00 + heights[ b ] * w10 + heights[ c ] * w01 + heights[ d ] * w11;
			const sx = ( slopeX[ a ] * w00 + slopeX[ b ] * w10 + slopeX[ c ] * w01 + slopeX[ d ] * w11 ) * exaggeration;
			const sz = ( slopeZ[ a ] * w00 + slopeZ[ b ] * w10 + slopeZ[ c ] * w01 + slopeZ[ d ] * w11 ) * exaggeration;
			// Surface normal = normalize( -sx, 1, -sz ); Lambert term relative to flat ground.
			shades[ py * pixels + px ] = ( - sx * lightX + lightY - sz * lightZ ) / ( Math.sqrt( sx * sx + 1 + sz * sz ) * lightY );

		}

	}

	const out = Buffer.alloc( pixels * pixels * 4 );
	const rgb = [ 0, 0, 0 ];
	for ( let py = 0; py < pixels; py ++ ) {

		for ( let px = 0; px < pixels; px ++ ) {

			const index = py * pixels + px;
			const height = pixelHeights[ index ] - waterLevel;
			if ( height < 0 ) {

				const depth = clamp( - height / 40, 0, 1 );
				rgb[ 0 ] = 96 - 56 * depth;
				rgb[ 1 ] = 158 - 60 * depth;
				rgb[ 2 ] = 200 - 50 * depth;

			} else {

				tintAt( height, rgb );
				const shade = clamp( 0.52 + 0.48 * shades[ index ], 0.5, 1.22 );
				rgb[ 0 ] *= shade;
				rgb[ 1 ] *= shade;
				rgb[ 2 ] *= shade;
				if ( contourInterval > 0 ) {

					const level = Math.floor( height / contourInterval );
					const right = px + 1 < pixels ? Math.floor( ( pixelHeights[ index + 1 ] - waterLevel ) / contourInterval ) : level;
					const below = py + 1 < pixels ? Math.floor( ( pixelHeights[ index + pixels ] - waterLevel ) / contourInterval ) : level;
					if ( right !== level || below !== level ) {

						const crossed = Math.max( level, right, below );
						const strength = crossed % majorEvery === 0 ? 0.62 : 0.34;
						rgb[ 0 ] *= 1 - strength;
						rgb[ 1 ] *= 1 - strength;
						rgb[ 2 ] *= 1 - strength;

					}

				}

			}

			const o = index * 4;
			out[ o ] = Math.min( 255, rgb[ 0 ] );
			out[ o + 1 ] = Math.min( 255, rgb[ 1 ] );
			out[ o + 2 ] = Math.min( 255, rgb[ 2 ] );
			out[ o + 3 ] = 255;

		}

	}

	return out;

}

/** Escapes text for use inside SVG markup. */
function escapeXml( text ) {

	return String( text ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );

}

/** SVG text with a light halo so that it stays readable on the relief. */
function label( x, y, text, { size = 15, fill = '#111', anchor = 'middle', weight = 'normal', halo = '#ffffffd0' } = {} ) {

	const common = `x="${x.toFixed( 1 )}" y="${y.toFixed( 1 )}" ${FONT} font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"`;
	const escaped = escapeXml( text );
	return `<text ${common} stroke="${halo}" stroke-width="${( size / 4 ).toFixed( 1 )}" stroke-linejoin="round" fill="none">${escaped}</text><text ${common} fill="${fill}">${escaped}</text>`;

}

/**
 * SVG fragment of the road and its annotations for a top-down view.
 * @param {MapView} view
 * @param {Track} track
 * @param {object} [options]
 * @param {boolean} [options.controlPoints=true] draw the control points with their index (and name)
 * @param {boolean} [options.corners=true] draw the named corners of the layout
 * @param {number} [options.markerEvery=250] distance between s-markers in meters (0 = none)
 * @param {number} [options.arrowEvery=250] distance between direction arrows in meters (0 = none)
 * @param {number} [options.minRoadPixels=1.6] the ribbon is widened to at least this many pixels (wide views)
 * @param {number} [options.fontSize=15] base label size in pixels
 * @returns {string} SVG elements (no <svg> wrapper)
 */
export function trackSvg( view, track, { controlPoints = true, corners = true, markerEvery = 250, arrowEvery = 250, minRoadPixels = 1.6, fontSize = 15 } = {} ) {

	const parts = [];
	const point = [ 0, 0, 0 ];
	const at = ( s, d ) => {

		track.pointAt( s, d, point );
		return `${view.px( point[ 0 ] ).toFixed( 1 )},${view.py( point[ 2 ] ).toFixed( 1 )}`;

	};

	// Ribbon at true width (left edge forwards, right edge backwards), widened if it would vanish.
	const step = Math.max( 1, Math.round( 1.5 / view.scale ) );
	const widen = Math.max( 1, minRoadPixels / ( 2 * track.halfWidthAt( 0 ) * view.scale ) );
	const left = [], right = [];
	for ( let s = 0; s < track.length; s += step ) {

		const half = track.halfWidthAt( s ) * widen;
		left.push( at( s, half ) );
		right.push( at( s, - half ) );

	}

	left.push( left[ 0 ] );
	right.push( right[ 0 ] );
	parts.push( `<path d="M${left.join( 'L' )}ZM${right.reverse().join( 'L' )}Z" fill="#2e2e33" fill-rule="evenodd" stroke="#f4f4f0" stroke-width="${clamp( view.scale * 0.6, 0.5, 1.5 ).toFixed( 2 )}" stroke-linejoin="round"/>` );

	// Direction arrows on the road.
	if ( arrowEvery > 0 ) {

		const size = clamp( 7 * view.scale, 8, 18 ) / view.scale;
		for ( let s = arrowEvery / 2; s < track.length; s += arrowEvery ) {

			parts.push( `<polygon points="${at( s + size, 0 )} ${at( s - size, size * 0.62 )} ${at( s - size * 0.4, 0 )} ${at( s - size, - size * 0.62 )}" fill="#ffd23c" stroke="#3a2a00" stroke-width="0.8"/>` );

		}

	}

	// s-markers on the right-hand side of the road.
	if ( markerEvery > 0 ) {

		for ( let s = markerEvery; s < track.length - markerEvery / 2; s += markerEvery ) {

			const half = track.halfWidthAt( s );
			const offset = half + 16 / view.scale;
			parts.push( `<polyline points="${at( s, half )} ${at( s, - half - 5 / view.scale )}" stroke="#fff" stroke-width="1.6" fill="none"/>` );
			track.pointAt( s, - offset, point );
			parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.35, String( s ), { size: fontSize * 0.85, fill: '#20303c' } ) );

		}

	}

	// Start / finish line and the rolling-start grid position.
	const startHalf = track.halfWidthAt( 0 ) + 6 / view.scale;
	parts.push( `<polyline points="${at( 0, startHalf )} ${at( 0, - startHalf )}" stroke="#e0202a" stroke-width="4" fill="none"/>` );
	parts.push( `<polyline points="${at( 0, startHalf )} ${at( 0, - startHalf )}" stroke="#fff" stroke-width="4" stroke-dasharray="4 4" fill="none"/>` );
	track.pointAt( 0, - startHalf - 20 / view.scale, point );
	parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.35, 'START s=0', { size: fontSize, fill: '#b01018', weight: 'bold' } ) );
	const gridHalf = track.halfWidthAt( track.gridS );
	parts.push( `<polyline points="${at( track.gridS, gridHalf )} ${at( track.gridS, - gridHalf )}" stroke="#30c0ff" stroke-width="3" fill="none"/>` );
	track.pointAt( track.gridS, - gridHalf - 14 / view.scale, point );
	parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.35, 'grid', { size: fontSize * 0.85, fill: '#085a80' } ) );

	// Sector boundaries.
	for ( let k = 1; k < track.sectors.length; k ++ ) {

		const s = track.sectors[ k ], half = track.halfWidthAt( s ) + 8 / view.scale;
		parts.push( `<polyline points="${at( s, half )} ${at( s, - half )}" stroke="#c040ff" stroke-width="3" fill="none"/>` );
		track.pointAt( s, half + 14 / view.scale, point );
		parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.35, `S${k + 1}`, { size: fontSize * 0.9, fill: '#7010a8', weight: 'bold' } ) );

	}

	// Control points on the left-hand side: dot on the point, index next to it.
	if ( controlPoints ) {

		track.layout.controlPoints.forEach( ( cp, index ) => {

			const x = view.px( cp.x * track.scale ), y = view.py( cp.z * track.scale );
			parts.push( `<circle cx="${x.toFixed( 1 )}" cy="${y.toFixed( 1 )}" r="${Math.max( 2.2, fontSize * 0.2 ).toFixed( 1 )}" fill="#ff3ea5" stroke="#fff" stroke-width="0.8"/>` );
			const s = track.controlPointS[ index ];
			track.pointAt( s, track.halfWidthAt( s ) + 13 / view.scale, point );
			const text = cp.name ? `${index} ${cp.name}` : String( index );
			parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.3, text, { size: fontSize * 0.8, fill: '#a0005a' } ) );

		} );

	}

	// Named corners, further out on the left-hand side.
	if ( corners ) {

		for ( const corner of track.corners ) {

			track.pointAt( corner.s, track.halfWidthAt( corner.s ) + 42 / view.scale, point );
			parts.push( label( view.px( point[ 0 ] ), view.py( point[ 2 ] ) + fontSize * 0.4, corner.name, { size: fontSize * 1.15, fill: '#101418', weight: 'bold' } ) );

		}

	}

	return parts.join( '\n' );

}

/**
 * SVG fragment with a scale bar and a title in the lower-left corner of a map.
 * @param {MapView} view
 * @param {string} title
 * @returns {string}
 */
export function legendSvg( view, title ) {

	const nice = [ 50, 100, 200, 500, 1000, 2000, 5000 ];
	const meters = nice.find( ( m ) => m * view.scale >= 110 ) ?? 5000;
	const x = 28, y = view.pixels - 34, w = meters * view.scale;
	return `<rect x="${x - 10}" y="${y - 44}" width="${Math.max( w + 20, 20 + title.length * 8.6 )}" height="66" fill="#ffffffc8" rx="5"/>`
		+ `<rect x="${x}" y="${y}" width="${w}" height="7" fill="#111"/><rect x="${x + w / 2}" y="${y + 1.5}" width="${w / 2 - 1.5}" height="4" fill="#fff"/>`
		+ `<text x="${x}" y="${y - 6}" ${FONT} font-size="14" fill="#111">${meters} m</text>`
		+ `<text x="${x}" y="${y - 25}" ${FONT} font-size="15" font-weight="bold" fill="#111">${escapeXml( title )}</text>`;

}

/**
 * Composites SVG fragments over a raw RGBA raster and writes a PNG.
 * @param {string} file output path
 * @param {number} width
 * @param {number} height
 * @param {Buffer | null} raster raw RGBA pixels, or null for a white background
 * @param {string[]} fragments SVG elements drawn in order
 * @returns {Promise<void>}
 */
export async function writeImage( file, width, height, raster, fragments ) {

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${fragments.join( '\n' )}</svg>`;
	const base = raster
		? sharp( raster, { raw: { width, height, channels: 4 } } )
		: sharp( { create: { width, height, channels: 4, background: '#ffffff' } } );
	await base.composite( [ { input: Buffer.from( svg ) } ] ).png( { compressionLevel: 4 } ).toFile( file );

}

/**
 * Renders a top-down map (relief + road + annotations) to a PNG.
 * @param {string} file output path
 * @param {object} options
 * @param {MapView} options.view
 * @param {Track} options.track
 * @param {(x: number, z: number) => number} options.heightFn
 * @param {typeof WORLD} options.world
 * @param {string} options.title
 * @param {object} [options.terrain] options for shadeTerrain
 * @param {object} [options.road] options for trackSvg
 * @param {string[]} [options.overlays] extra SVG fragments drawn on top
 * @returns {Promise<void>}
 */
export async function renderMap( file, { view, track, heightFn, world, title, terrain = {}, road = {}, overlays = [] } ) {

	const raster = shadeTerrain( view, heightFn, { waterLevel: world.waterLevel, ...terrain } );
	const border = `<rect x="${view.px( world.minX ).toFixed( 1 )}" y="${view.py( world.minZ ).toFixed( 1 )}" width="${( world.size * view.scale ).toFixed( 1 )}" height="${( world.size * view.scale ).toFixed( 1 )}" fill="none" stroke="#d01020" stroke-width="2" stroke-dasharray="10 6"/>`;
	const inset = LIMITS.minBorderMargin;
	const keepIn = `<rect x="${view.px( world.minX + inset ).toFixed( 1 )}" y="${view.py( world.minZ + inset ).toFixed( 1 )}" width="${( ( world.size - 2 * inset ) * view.scale ).toFixed( 1 )}" height="${( ( world.size - 2 * inset ) * view.scale ).toFixed( 1 )}" fill="none" stroke="#d01020" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="3 5"/>`;
	await writeImage( file, view.pixels, view.pixels, raster, [ border, keepIn, trackSvg( view, track, road ), ...overlays, legendSvg( view, title ) ] );

}

/**
 * One stacked panel of a lap chart.
 * @typedef {Object} ChartPanel
 * @property {string} title              shown in the upper-left corner of the panel
 * @property {number} weight             relative height of the panel
 * @property {number} yMin               value at the bottom
 * @property {number} yMax               value at the top
 * @property {number} yStep              distance between horizontal grid lines / axis labels
 * @property {{values: ArrayLike<number>, color: string, width?: number, colorAt?: (i: number) => string}[]} [series]
 *           lines with one value per track sample; colorAt colours the line per sample
 * @property {{upper: ArrayLike<number>, lower: ArrayLike<number>, color: string}[]} [areas] filled bands between two curves
 * @property {{y: number, color: string, label?: string, dash?: string}[]} [lines] horizontal reference lines
 * @property {{s: number, y: number, text: string, color?: string}[]} [notes] labels placed at (s, y)
 */

/**
 * Draws stacked line charts over the lap distance as an SVG fragment list (use with writeImage).
 * @param {object} spec
 * @param {number} spec.width image width in pixels
 * @param {number} spec.height image height in pixels
 * @param {number} spec.length lap length in meters (x axis: 0 .. length, one sample per meter)
 * @param {string} spec.title headline
 * @param {ChartPanel[]} spec.panels
 * @param {{s: number, text?: string, color: string, dash?: string}[]} [spec.markers] vertical lines through all panels
 * @returns {string[]} SVG fragments
 */
export function lapChartSvg( { width, height, length, title, panels, markers = [] } ) {

	const marginLeft = 64, marginRight = 24, marginTop = 46, marginBottom = 34, gap = 30;
	const plotWidth = width - marginLeft - marginRight;
	const totalWeight = panels.reduce( ( sum, panel ) => sum + panel.weight, 0 );
	const usable = height - marginTop - marginBottom - gap * ( panels.length - 1 );
	const sx = ( s ) => marginLeft + ( s / length ) * plotWidth;
	const out = [ `<text x="${marginLeft}" y="26" ${FONT} font-size="19" font-weight="bold" fill="#111">${escapeXml( title )}</text>` ];
	let top = marginTop;
	for ( const panel of panels ) {

		const panelHeight = usable * panel.weight / totalWeight;
		const bottom = top + panelHeight;
		const sy = ( v ) => bottom - ( clamp( v, panel.yMin, panel.yMax ) - panel.yMin ) / ( panel.yMax - panel.yMin ) * panelHeight;
		out.push( `<rect x="${marginLeft}" y="${top.toFixed( 1 )}" width="${plotWidth}" height="${panelHeight.toFixed( 1 )}" fill="#fbfbf8" stroke="#888" stroke-width="1"/>` );
		for ( let v = Math.ceil( panel.yMin / panel.yStep ) * panel.yStep; v <= panel.yMax + 1e-9; v += panel.yStep ) {

			const y = sy( v ).toFixed( 1 );
			out.push( `<line x1="${marginLeft}" x2="${marginLeft + plotWidth}" y1="${y}" y2="${y}" stroke="${Math.abs( v ) < 1e-9 ? '#777' : '#ddd'}" stroke-width="1"/>` );
			out.push( `<text x="${marginLeft - 7}" y="${( + y + 4 ).toFixed( 1 )}" ${FONT} font-size="12" text-anchor="end" fill="#333">${+ v.toFixed( 4 )}</text>` );

		}

		for ( let s = 0; s <= length; s += 250 ) {

			out.push( `<line x1="${sx( s ).toFixed( 1 )}" x2="${sx( s ).toFixed( 1 )}" y1="${top.toFixed( 1 )}" y2="${bottom.toFixed( 1 )}" stroke="#e4e4e4" stroke-width="1"/>` );

		}

		for ( const marker of markers ) {

			out.push( `<line x1="${sx( marker.s ).toFixed( 1 )}" x2="${sx( marker.s ).toFixed( 1 )}" y1="${top.toFixed( 1 )}" y2="${bottom.toFixed( 1 )}" stroke="${marker.color}" stroke-width="1" ${marker.dash ? `stroke-dasharray="${marker.dash}"` : ''}/>` );

		}

		for ( const area of panel.areas ?? [] ) {

			const forward = [], backward = [];
			for ( let i = 0; i <= length; i += 2 ) {

				const k = i % length;
				forward.push( `${sx( i ).toFixed( 1 )},${sy( area.upper[ k ] ).toFixed( 1 )}` );
				backward.push( `${sx( i ).toFixed( 1 )},${sy( area.lower[ k ] ).toFixed( 1 )}` );

			}

			out.push( `<polygon points="${forward.join( ' ' )} ${backward.reverse().join( ' ' )}" fill="${area.color}"/>` );

		}

		for ( const line of panel.lines ?? [] ) {

			const y = sy( line.y ).toFixed( 1 );
			out.push( `<line x1="${marginLeft}" x2="${marginLeft + plotWidth}" y1="${y}" y2="${y}" stroke="${line.color}" stroke-width="1.3" stroke-dasharray="${line.dash ?? '7 4'}"/>` );
			if ( line.label ) out.push( `<text x="${marginLeft + plotWidth - 5}" y="${( + y - 4 ).toFixed( 1 )}" ${FONT} font-size="12" text-anchor="end" fill="${line.color}">${escapeXml( line.label )}</text>` );

		}

		for ( const series of panel.series ?? [] ) {

			// Consecutive samples of the same colour are joined into one polyline.
			let points = [], colour = null;
			const flush = () => {

				if ( points.length > 1 ) out.push( `<polyline points="${points.join( ' ' )}" fill="none" stroke="${colour}" stroke-width="${series.width ?? 1.6}" stroke-linejoin="round"/>` );

			};

			for ( let i = 0; i <= length; i ++ ) {

				const k = i % length;
				const next = series.colorAt ? series.colorAt( k ) : series.color;
				const xy = `${sx( i ).toFixed( 1 )},${sy( series.values[ k ] ).toFixed( 1 )}`;
				if ( next !== colour ) {

					points.push( xy );
					flush();
					points = [];
					colour = next;

				}

				points.push( xy );

			}

			flush();

		}

		for ( const note of panel.notes ?? [] ) out.push( label( sx( note.s ), sy( note.y ), note.text, { size: 12, fill: note.color ?? '#111' } ) );
		for ( const marker of markers ) {

			if ( marker.text && panel === panels[ 0 ] ) out.push( `<text x="${( sx( marker.s ) + 3 ).toFixed( 1 )}" y="${( top + 12 ).toFixed( 1 )}" ${FONT} font-size="11" fill="${marker.color}">${escapeXml( marker.text )}</text>` );

		}

		out.push( `<text x="${marginLeft + 8}" y="${( bottom - 8 ).toFixed( 1 )}" ${FONT} font-size="13" font-weight="bold" fill="#222">${escapeXml( panel.title )}</text>` );
		top = bottom + gap;

	}

	const axisY = height - marginBottom + 16;
	for ( let s = 0; s <= length; s += 250 ) out.push( `<text x="${sx( s ).toFixed( 1 )}" y="${axisY}" ${FONT} font-size="12" text-anchor="middle" fill="#333">${s}</text>` );
	out.push( `<text x="${marginLeft + plotWidth}" y="${axisY + 14}" ${FONT} font-size="12" text-anchor="end" fill="#333">s (m)</text>` );
	return out;

}

/** Vertical marker lines shared by the lap charts: control points, sectors, named corners. */
function lapMarkers( track ) {

	const markers = [];
	track.layout.controlPoints.forEach( ( cp, index ) => markers.push( { s: track.controlPointS[ index ], text: String( index ), color: '#e46ab0', dash: '2 4' } ) );
	for ( let k = 1; k < track.sectors.length; k ++ ) markers.push( { s: track.sectors[ k ], text: `S${k + 1}`, color: '#9030d0' } );
	return markers;

}

/** Colour of the road line for a grade (by steepness, towards the 11 % limit). */
function gradeColor( grade ) {

	const g = Math.abs( grade );
	return g > LIMITS.maxGrade ? '#d000d0' : g > 0.08 ? '#d62020' : g > 0.05 ? '#e88a10' : g > 0.02 ? '#9aa81a' : '#1f8a3a';

}

/**
 * Renders the elevation chart: height profile coloured by grade over the terrain under the route (cut / fill), the
 * grade and the vertical load at the estimated speed.
 * @param {string} file output path
 * @param {Track} track
 * @param {(x: number, z: number) => number} heightFn
 * @param {typeof WORLD} world
 * @param {ReturnType<typeof checkLayout>} check result of checkLayout( track, world, heightFn )
 * @returns {Promise<void>}
 */
export async function renderElevationChart( file, track, heightFn, world, check ) {

	const count = track.count;
	const ground = new Float32Array( count ), cutTop = new Float32Array( count ), fillBottom = new Float32Array( count ), floor = new Float32Array( count );
	const gradePercent = new Float32Array( count ), load = new Float32Array( count );
	let low = Infinity, high = - Infinity;
	for ( let i = 0; i < count; i ++ ) {

		ground[ i ] = heightFn( track.xs[ i ], track.zs[ i ] );
		cutTop[ i ] = Math.max( ground[ i ], track.ys[ i ] );
		fillBottom[ i ] = Math.min( ground[ i ], track.ys[ i ] );
		low = Math.min( low, fillBottom[ i ] );
		high = Math.max( high, cutTop[ i ] );
		gradePercent[ i ] = track.grades[ i ] * 100;
		const bend = track.ys[ ( i + count - 1 ) % count ] - 2 * track.ys[ i ] + track.ys[ ( i + 1 ) % count ];
		load[ i ] = bend * check.speedProfile[ i ] ** 2 / GRAVITY;

	}

	const step = high - low > 160 ? 50 : high - low > 60 ? 20 : 10;
	const yMin = Math.floor( Math.min( low, world.waterLevel ) / step ) * step, yMax = Math.ceil( ( high + 1 ) / step ) * step;
	floor.fill( yMin );
	const m = check.metrics;
	const fragments = lapChartSvg( {
		width: 2048, height: 1120, length: track.length,
		title: `${track.layout.name} - elevation   (road ${m.minHeight.toFixed( 1 )} .. ${m.maxHeight.toFixed( 1 )} m, max grade ${( m.maxGrade * 100 ).toFixed( 1 )} %, min crest radius ${m.minCrestRadius.toFixed( 0 )} m, max cut ${m.maxCut.toFixed( 1 )} m, max fill ${m.maxFill.toFixed( 1 )} m)`,
		markers: lapMarkers( track ),
		panels: [
			{
				title: 'height (m): road coloured by grade (green < 2 %, olive < 5 %, orange < 8 %, red < 11 %, magenta beyond) - grey terrain under the centreline - brown = cut, blue = fill',
				weight: 5, yMin, yMax, yStep: step,
				areas: [
					{ upper: ground, lower: floor, color: '#d9d6cc' },
					{ upper: cutTop, lower: track.ys, color: '#b0643c99' },
					{ upper: track.ys, lower: fillBottom, color: '#3c78c899' },
				],
				lines: [ { y: world.waterLevel, color: '#2060c0', label: 'water level' } ],
				series: [ { values: ground, color: '#77736a', width: 1 }, { values: track.ys, color: '#000', width: 2.4, colorAt: ( i ) => gradeColor( track.grades[ i ] ) } ],
				notes: track.corners.map( ( corner ) => ( { s: corner.s, y: track.heightAt( corner.s ) + ( yMax - yMin ) * 0.06, text: corner.name } ) ),
			},
			{
				title: 'grade (%)', weight: 2, yMin: - 14, yMax: 14, yStep: 5,
				lines: [ { y: LIMITS.maxGrade * 100, color: '#d62020', label: 'limit' }, { y: - LIMITS.maxGrade * 100, color: '#d62020' } ],
				series: [ { values: gradePercent, color: '#333' } ],
			},
			{
				title: 'vertical load change at the estimated speed (g): negative = light over a crest, positive = compression in a dip', weight: 2, yMin: - 1.2, yMax: 2, yStep: 0.5,
				lines: [ { y: - LIMITS.maxCrestG, color: '#d62020', label: 'crest limit' } ],
				series: [ { values: load, color: '#333' } ],
			},
		],
	} );
	await writeImage( file, 2048, 1120, null, fragments );

}

/**
 * Renders the driving-dynamics chart: curvature, estimated speed, width and banking along the lap.
 * @param {string} file output path
 * @param {Track} track
 * @param {ReturnType<typeof checkLayout>} check result of checkLayout
 * @returns {Promise<void>}
 */
export async function renderDynamicsChart( file, track, check ) {

	const count = track.count;
	const speedKmh = new Float32Array( count ), widths = new Float32Array( count ), bankDeg = new Float32Array( count );
	let tightest = 0;
	for ( let i = 0; i < count; i ++ ) {

		speedKmh[ i ] = check.speedProfile[ i ] * KMH_PER_MS;
		widths[ i ] = 2 * track.halfWidths[ i ];
		bankDeg[ i ] = track.banks[ i ] * RAD2DEG;
		tightest = Math.max( tightest, Math.abs( track.curvatures[ i ] ) );

	}

	const range = tightest > 0.04 ? 0.07 : tightest > 0.02 ? 0.04 : 0.02;
	const fragments = lapChartSvg( {
		width: 2048, height: 1120, length: track.length,
		title: `${track.layout.name} - curvature and estimated speed   (lap ${check.estimatedLapTime.toFixed( 1 )} s, avg ${( check.metrics.averageSpeed * KMH_PER_MS ).toFixed( 0 )} km/h, min radius ${check.metrics.minRadius.toFixed( 1 )} m, ${check.corners.length} corners, ${check.metrics.hairpins} hairpins)`,
		markers: lapMarkers( track ),
		panels: [
			{
				title: 'curvature (1/m): positive = left turn', weight: 4, yMin: - range, yMax: range, yStep: range / 4,
				lines: [
					{ y: 1 / LIMITS.minRadiusOutsideHairpins, color: '#e88a10', label: 'R 30 m (limit outside hairpins)' }, { y: - 1 / LIMITS.minRadiusOutsideHairpins, color: '#e88a10' },
					{ y: 1 / LIMITS.minRadius, color: '#d62020', label: 'R 16 m (limit)' }, { y: - 1 / LIMITS.minRadius, color: '#d62020' },
				].filter( ( line ) => Math.abs( line.y ) <= range ),
				series: [ { values: track.curvatures, color: '#1a3f8a' } ],
				notes: check.corners.map( ( corner, index ) => ( { s: corner.s, y: ( corner.direction === 'L' ? 1 : - 1 ) * Math.min( 1 / corner.radius + range * 0.07, range * 0.93 ), text: `${index + 1}: R${corner.radius.toFixed( 0 )}`, color: corner.hairpin ? '#b01018' : '#111' } ) ),
			},
			{
				title: 'estimated speed (km/h): 12 m/s2 lateral, 6 m/s2 acceleration, 11 m/s2 braking', weight: 4, yMin: 0, yMax: 340, yStep: 50,
				series: [ { values: speedKmh, color: '#0a7a4a', width: 2 } ],
				notes: check.corners.map( ( corner ) => ( { s: corner.s, y: corner.minSpeed * KMH_PER_MS - 16, text: ( corner.minSpeed * KMH_PER_MS ).toFixed( 0 ) } ) ),
			},
			{ title: 'paved width (m)', weight: 1.4, yMin: 8, yMax: 12, yStep: 1, series: [ { values: widths, color: '#333' } ] },
			{
				title: 'banking (deg): positive = left edge lower', weight: 1.6, yMin: - 7, yMax: 7, yStep: 3,
				series: [ { values: bankDeg, color: '#7a3a9a' } ],
			},
		],
	} );
	await writeImage( file, 2048, 1120, null, fragments );

}

/** Command line entry point. */
async function main() {

	const args = process.argv.slice( 2 );
	const outDir = args.find( ( arg ) => ! arg.startsWith( '--' ) );
	if ( ! outDir ) {

		console.error( 'usage: node tools/render-map.mjs <outDir> [--zoom=centerX,centerZ,span] [--only=map,wide,elevation,dynamics]' );
		process.exit( 2 );

	}

	const option = ( name ) => args.find( ( arg ) => arg.startsWith( `--${name}=` ) )?.split( '=' )[ 1 ];
	const zoom = option( 'zoom' )?.split( ',' ).map( Number );
	const only = option( 'only' )?.split( ',' );
	const wanted = ( name ) => ! only || only.includes( name );
	await mkdir( outDir, { recursive: true } );

	const start = performance.now();
	const track = new Track( LAYOUT );
	const check = checkLayout( track, WORLD, baseHeight );
	const jobs = [];
	const timed = ( name, promise ) => jobs.push( promise.then( () => console.log( `  ${path.join( outDir, name )}` ) ) );
	if ( wanted( 'map' ) ) {

		timed( 'map.png', renderMap( path.join( outDir, 'map.png' ), {
			view: createView( { span: WORLD.size, pixels: 2048 } ), track, heightFn: baseHeight, world: WORLD,
			title: `${LAYOUT.name} - ${track.length} m`,
		} ) );

	}

	if ( wanted( 'wide' ) ) {

		timed( 'map-wide.png', renderMap( path.join( outDir, 'map-wide.png' ), {
			view: createView( { span: WORLD.outerSize, pixels: 1536 } ), track, heightFn: baseHeight, world: WORLD,
			title: `${LAYOUT.name} - far ring ${WORLD.outerSize / 1000} km`,
			terrain: { contourInterval: 100, exaggeration: 1.2 },
			road: { controlPoints: false, corners: false, markerEvery: 0, arrowEvery: 0 },
		} ) );

	}

	if ( wanted( 'elevation' ) ) timed( 'elevation.png', renderElevationChart( path.join( outDir, 'elevation.png' ), track, baseHeight, WORLD, check ) );
	if ( wanted( 'dynamics' ) ) timed( 'dynamics.png', renderDynamicsChart( path.join( outDir, 'dynamics.png' ), track, check ) );
	if ( zoom ) {

		timed( 'map-zoom.png', renderMap( path.join( outDir, 'map-zoom.png' ), {
			view: createView( { centerX: zoom[ 0 ], centerZ: zoom[ 1 ], span: zoom[ 2 ], pixels: 1536 } ), track, heightFn: baseHeight, world: WORLD,
			title: `${LAYOUT.name} - zoom at ${zoom[ 0 ]}, ${zoom[ 1 ]}`,
			terrain: { contourInterval: zoom[ 2 ] < 900 ? 5 : 10, resolution: 768 },
			road: { markerEvery: zoom[ 2 ] < 900 ? 50 : 100, arrowEvery: zoom[ 2 ] < 900 ? 50 : 100, fontSize: 17 },
		} ) );

	}

	await Promise.all( jobs );
	console.log( `${check.ok ? 'layout OK' : `layout has ${check.violations.length} violation(s) - run node tools/check-layout.mjs`} - rendered in ${( ( performance.now() - start ) / 1000 ).toFixed( 2 )} s` );

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) await main();
