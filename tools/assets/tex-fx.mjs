#!/usr/bin/env node
// Misc FX textures + LUTs from the three.js repository at tag r187.
//
//   node tools/assets/tex-fx.mjs            download (cached) + publish + write assets-src/textures/_fx.json
//
// 1. downloads the files listed in FILES from https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/<path>
//    into assets-src/textures/_threejs_r187/<path>   (raw mirror, untouched)
// 2. copies the selected ones byte-for-byte to public/assets/textures/fx/<file> (clean file names, no spaces)
// 3. generates licence-clean procedural lens-flare sprites (flare_*.png) with sharp
// 4. writes assets-src/textures/_fx.json (the "fx" array that tex-build.mjs merges into public/assets/textures/index.json)
//
// Downloaded files are data only (images / LUT text); nothing is executed.

import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const TAG = 'r187';
const RAW = `https://raw.githubusercontent.com/mrdoob/three.js/${TAG}/examples/`;
const SRC = resolve( 'assets-src/textures/_threejs_r187' );
const OUT = resolve( 'public/assets/textures/fx' );
const UA = 'asset-fetcher/1.0';

const MIT = 'MIT (three.js repository, no separate licence file next to the asset)';
const repo = ( p ) => `https://github.com/mrdoob/three.js/blob/${TAG}/examples/${p.split( '/' ).map( encodeURIComponent ).join( '/' )}`;

// { src: path below examples/, file: published name (omit = mirror only), id, purpose, license, credit, notes }
const FILES = [
	// ---- water
	{ src: 'textures/waternormals.jpg', file: 'water_normals.jpg', id: 'water_normals', purpose: 'Water-surface normal map (the classic three.js ocean/Water normals, choppy). Scroll two copies at different scale/speed/direction and blend. NOTE: has a faint 1-px discontinuity at the wrap edge (seam ratio 3.8/2.6, visible in a still close-up) - prefer water_normals_a + water_normals_b (seamless) for the calm lake.', license: MIT, credit: 'three.js examples (webgpu_ocean / Water.js)', color: 'data' },
	{ src: 'textures/water/Water_1_M_Normal.jpg', file: 'water_normals_a.jpg', id: 'water_normals_a', purpose: 'Seamlessly tiling water normal map, larger soft ripples (three.js Water2 normalMap0). Pair with water_normals_b for lake ripples.', license: MIT, credit: 'three.js examples (webgpu_water / Water2)', color: 'data' },
	{ src: 'textures/water/Water_2_M_Normal.jpg', file: 'water_normals_b.jpg', id: 'water_normals_b', purpose: 'Seamlessly tiling water normal map, finer ripples (three.js Water2 normalMap1).', license: MIT, credit: 'three.js examples (webgpu_water / Water2)', color: 'data' },
	{ src: 'textures/opengameart/Caustic_Free.jpg', file: 'caustics.jpg', id: 'caustics', purpose: 'Tiling greyscale caustics pattern for the shallow lake edge (project onto the lake bed, scroll two copies).', license: 'Free asset from opengameart.org redistributed in the three.js repository; exact licence not stated in the repo - verify before a commercial release', credit: 'opengameart.org via three.js examples (webgpu_caustics)', color: 'srgb' },
	// ---- particles
	{ src: 'textures/opengameart/smoke1.png', file: 'smoke.png', id: 'smoke', purpose: 'Soft smoke / dust puff sprite with alpha (tyre smoke, gravel dust, exhaust). Use as a camera-facing, soft-particle, alpha-blended sprite; tint via vertex/instance colour.', license: 'Free asset from opengameart.org redistributed in the three.js repository; exact licence not stated in the repo - verify before a commercial release', credit: 'opengameart.org via three.js examples (webgpu_particles)', color: 'srgb' },
	{ src: 'textures/lava/cloud.png' }, // mirrored only: RGBA colour-noise tile of the lava example, not a usable puff sprite
	{ src: 'textures/sprites/spark1.png', file: 'spark.png', id: 'spark', purpose: 'Spark / glint sprite (additive blending): scrape sparks, tiny headlight glints.', license: MIT, credit: 'three.js examples (sprites)', color: 'srgb' },
	{ src: 'textures/sprites/disc.png', file: 'particle_disc.png', id: 'particle_disc', purpose: 'Small hard-edged round particle with alpha (pollen, debris, rain splash points).', license: MIT, credit: 'three.js examples (sprites)', color: 'srgb' },
	{ src: 'textures/sprites/circle.png', file: 'particle_circle.png', id: 'particle_circle', purpose: 'Round particle sprite with alpha.', license: MIT, credit: 'three.js examples (sprites)', color: 'srgb' },
	// ---- lens flares (ROME assets: non-commercial licence!)
	{ src: 'textures/lensflare/LICENSE.txt', file: 'lensflare/LICENSE.txt' },
	{ src: 'textures/lensflare/lensflare0.png', file: 'lensflare/lensflare0.png', id: 'lensflare0', purpose: 'Main sun flare / glow sprite (additive).', license: 'CC BY-NC-SA 3.0 (ROME "3 Dreams of Black" assets, see fx/lensflare/LICENSE.txt) - NON-COMMERCIAL + share-alike + attribution', credit: 'ROME "3 Dreams of Black" (https://rome.mrdoob.com) via three.js examples', color: 'srgb' },
	{ src: 'textures/lensflare/lensflare0_alpha.png', file: 'lensflare/lensflare0_alpha.png', id: 'lensflare0_alpha', purpose: 'Same sun flare with alpha channel (for normal alpha blending).', license: 'CC BY-NC-SA 3.0 (ROME assets, see fx/lensflare/LICENSE.txt) - NON-COMMERCIAL', credit: 'ROME "3 Dreams of Black" via three.js examples', color: 'srgb' },
	{ src: 'textures/lensflare/lensflare1.png', file: 'lensflare/lensflare1.png', id: 'lensflare1', purpose: 'Small soft ghost element.', license: 'CC BY-NC-SA 3.0 (ROME assets, see fx/lensflare/LICENSE.txt) - NON-COMMERCIAL', credit: 'ROME "3 Dreams of Black" via three.js examples', color: 'srgb' },
	{ src: 'textures/lensflare/lensflare2.png', file: 'lensflare/lensflare2.png', id: 'lensflare2', purpose: 'Small ring ghost element.', license: 'CC BY-NC-SA 3.0 (ROME assets, see fx/lensflare/LICENSE.txt) - NON-COMMERCIAL', credit: 'ROME "3 Dreams of Black" via three.js examples', color: 'srgb' },
	{ src: 'textures/lensflare/lensflare3.png', file: 'lensflare/lensflare3.png', id: 'lensflare3', purpose: 'Hexagonal aperture ghost element (the one used by the three.js lens-flare examples).', license: 'CC BY-NC-SA 3.0 (ROME assets, see fx/lensflare/LICENSE.txt) - NON-COMMERCIAL', credit: 'ROME "3 Dreams of Black" via three.js examples', color: 'srgb' },
	{ src: 'textures/lensdirt.png', file: 'lens_dirt.png', id: 'lens_dirt', purpose: 'Lens dirt overlay; multiply with the bloom/flare buffer (three/addons/tsl/display lensDirt / LensflareNode) for sun-facing shots.', license: MIT, credit: 'three.js examples (webgpu_postprocessing_lensflare)', color: 'srgb' },
	// ---- noise
	{ src: 'textures/noises/perlin/rgb-256x256.png', file: 'noise_perlin_rgb_256.png', id: 'noise_perlin_rgb', purpose: 'Tiling RGB perlin noise 256x256 (three independent channels): wind, heat haze, dust erosion, terrain blend breakup.', license: MIT, credit: 'three.js examples; generated with Perlin Noise Maker (kitfox.com)', color: 'data' },
	{ src: 'textures/noises/perlin/128x128.png', file: 'noise_perlin_128.png', id: 'noise_perlin', purpose: 'Tiling greyscale perlin noise 128x128 (cheap dithering / film-grain / flicker source).', license: MIT, credit: 'three.js examples; generated with Perlin Noise Maker (kitfox.com)', color: 'data' },
	{ src: 'textures/noises/voronoi/grayscale-256x256.png', file: 'noise_voronoi_256.png', id: 'noise_voronoi', purpose: 'Tiling greyscale voronoi/cellular noise 256x256 (caustic-like breakup, cracked-surface masks).', license: MIT, credit: 'three.js examples', color: 'data' },
	{ src: 'textures/noise.png', file: 'noise_white.png', id: 'noise_white', purpose: 'High-frequency RGB noise tile (dither / grain / stochastic sampling offsets).', license: MIT, credit: 'three.js examples', color: 'data' },
	// ---- LUTs (all six mirrored; the three picked with tools/assets/tex-lut-preview.mjs are published)
	{ src: 'luts/Presetpro-Cinematic.3dl', file: 'luts/presetpro_cinematic.3dl', id: 'lut_cinematic_neutral', lut: '3dl' },
	{ src: 'luts/Bourbon 64.CUBE', file: 'luts/bourbon_64_warm.cube', id: 'lut_warm_bourbon', lut: 'cube' },
	{ src: 'luts/Remy 24.CUBE', file: 'luts/remy_24.cube', id: 'lut_alpenglow_remy', lut: 'cube' },
	{ src: 'luts/Clayton 33.CUBE' }, // black & white - not published
	{ src: 'luts/Chemical 168.CUBE' }, // green cast - not published
	{ src: 'luts/Cubicle 99.CUBE' }, // heavy blue "Cool" - not published
];

// what each LUT does (measured with tools/assets/tex-lut-preview.mjs on display-referred sRGB input)
const LUT_INFO = {
	lut_cinematic_neutral: {
		purpose: 'Neutral filmic grade (default for all presets): greys stay neutral (50% grey -> #7c7f7e), blacks lifted to ~#1a181b, slightly deeper greens and sky blues. Safe at intensity 1.',
		license: 'Free LUT "Presetpro - Cinematic" (C) 2018 presetpro.com / Tim Martin, from FreePresets.com free cinematic LUTs, redistributed in the three.js repository (examples/luts); original free-asset terms apply - verify before a commercial release',
		credit: 'presetpro.com / FreePresets.com via three.js examples/luts',
	},
	lut_warm_bourbon: {
		purpose: 'Strong warm golden grade (RocketStock "Bourbon 64", TITLE "Warm"): mid greys go warm and brighter (50% grey -> #9f8e84), highlights cream (#fefbef), shadows plum (#1d1222). Golden-hour preset at intensity ~0.35-0.6; too strong at 1.',
		license: 'Free LUT from the RocketStock "35 Free LUTs for Color Grading Videos" pack ((C) 2017 RocketStock), redistributed in the three.js repository (examples/luts); original RocketStock free-asset terms apply - verify before a commercial release',
		credit: 'RocketStock via three.js examples/luts',
	},
	lut_alpenglow_remy: {
		purpose: 'Split-tone grade (RocketStock "Remy 24"): warm pink-cream highlights (75% grey -> #dcd2ba), cool lavender shadows (25% grey -> #4a4857). Dusk / alpenglow preset at intensity ~0.4-0.8.',
		license: 'Free LUT from the RocketStock "35 Free LUTs for Color Grading Videos" pack ((C) 2017 RocketStock), redistributed in the three.js repository (examples/luts); original RocketStock free-asset terms apply - verify before a commercial release',
		credit: 'RocketStock via three.js examples/luts',
	},
};


async function get( url, tries = 4 ) {

	let lastErr;
	for ( let t = 0; t < tries; t ++ ) {

		try {

			const res = await fetch( url, { headers: { 'User-Agent': UA } } );
			if ( ! res.ok ) throw new Error( `HTTP ${res.status} for ${url}` );
			return Buffer.from( await res.arrayBuffer() );

		} catch ( e ) {

			lastErr = e;
			await new Promise( ( r ) => setTimeout( r, 800 * ( t + 1 ) ) );

		}

	}

	throw lastErr;

}

// ---------------------------------------------------------------- 1. mirror
for ( const f of FILES ) {

	const dst = join( SRC, f.src );
	if ( existsSync( dst ) && statSync( dst ).size > 0 ) continue;
	mkdirSync( dirname( dst ), { recursive: true } );
	const buf = await get( RAW + f.src.split( '/' ).map( encodeURIComponent ).join( '/' ) );
	writeFileSync( dst, buf );
	console.log( `downloaded ${f.src} (${buf.length} bytes)` );

}

if ( process.argv.includes( '--mirror-only' ) ) process.exit( 0 );

// ---------------------------------------------------------------- 2. publish
const fx = [];
for ( const f of FILES ) {

	if ( ! f.file ) continue;
	const src = join( SRC, f.src ), dst = join( OUT, f.file );
	mkdirSync( dirname( dst ), { recursive: true } );
	copyFileSync( src, dst );
	if ( ! f.id ) continue;
	const entry = { id: f.id, file: `/assets/textures/fx/${f.file}`, bytes: statSync( dst ).size };
	if ( f.lut ) {

		const text = readFileSync( dst, 'utf8' );
		let size, title = null;
		if ( f.lut === 'cube' ) {

			size = Number( /LUT_3D_SIZE\s+(\d+)/.exec( text )?.[ 1 ] ?? 0 );
			title = /TITLE\s+"([^"]*)"/.exec( text )?.[ 1 ] ?? null;

		} else {

			size = text.split( /\r?\n/ ).map( ( l ) => l.trim() ).find( ( l ) => l && ! l.startsWith( '#' ) ).split( /\s+/ ).length;

		}

		Object.assign( entry, { type: 'lut3d', format: f.lut, loader: f.lut === 'cube' ? 'LUTCubeLoader' : 'LUT3dlLoader', lutSize: size, title, ...LUT_INFO[ f.id ], source: repo( f.src ) } );

	} else {

		const m = await sharp( dst ).metadata();
		Object.assign( entry, { type: 'texture', width: m.width, height: m.height, channels: m.channels, hasAlpha: !! m.hasAlpha, colorSpace: f.color, purpose: f.purpose, license: f.license, credit: f.credit, source: repo( f.src ) } );

	}

	fx.push( entry );

}

// ---------------------------------------------------------------- 3. procedural, licence-clean lens flare elements
async function svgPng( name, size, body ) {

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
	const dst = join( OUT, name );
	await sharp( Buffer.from( svg ) ).png( { compressionLevel: 9 } ).toFile( dst );
	return dst;

}

const stops = ( list ) => list.map( ( [ o, a ] ) => `<stop offset="${o}" stop-color="#fff" stop-opacity="${a}"/>` ).join( '' );
const generated = [
	{
		id: 'flare_glow', file: 'flare_glow.png', size: 256, purpose: 'Procedural soft sun glow (white, alpha = intensity, smooth falloff). Additive; tint with the sun colour.',
		body: `<defs><radialGradient id="g">${stops( [ [ 0, 1 ], [ 0.06, 0.82 ], [ 0.16, 0.42 ], [ 0.32, 0.17 ], [ 0.55, 0.055 ], [ 0.8, 0.012 ], [ 1, 0 ] ] )}</radialGradient></defs><circle cx="128" cy="128" r="128" fill="url(#g)"/>`,
	},
	{
		id: 'flare_ring', file: 'flare_ring.png', size: 256, purpose: 'Procedural thin halo ring ghost (white, alpha = intensity). Additive, low opacity (0.05-0.15).',
		body: `<defs><radialGradient id="g">${stops( [ [ 0, 0 ], [ 0.62, 0.0 ], [ 0.8, 0.10 ], [ 0.9, 0.55 ], [ 0.945, 1 ], [ 0.975, 0.35 ], [ 1, 0 ] ] )}</radialGradient></defs><circle cx="128" cy="128" r="128" fill="url(#g)"/>`,
	},
	{
		id: 'flare_hex', file: 'flare_hex.png', size: 256, purpose: 'Procedural hexagonal aperture ghost (white, alpha = intensity, slightly brighter rim). Additive, low opacity, several sizes/tints along the sun-to-screen-centre axis.',
		body: ( () => {

			const pts = ( r ) => Array.from( { length: 6 }, ( _, i ) => `${( 128 + r * Math.cos( Math.PI / 6 + i * Math.PI / 3 ) ).toFixed( 2 )},${( 128 + r * Math.sin( Math.PI / 6 + i * Math.PI / 3 ) ).toFixed( 2 )}` ).join( ' ' );
			return `<defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter><radialGradient id="g">${stops( [ [ 0, 0.30 ], [ 0.7, 0.42 ], [ 1, 0.62 ] ] )}</radialGradient></defs><g filter="url(#b)"><polygon points="${pts( 112 )}" fill="url(#g)"/><polygon points="${pts( 110 )}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="3"/></g>`;

		} )(),
	},
	{
		id: 'flare_streak', file: 'flare_streak.png', size: 256, purpose: 'Procedural horizontal anamorphic streak (white, alpha = intensity). Additive, stretch along X.',
		body: `<defs><radialGradient id="g" gradientTransform="translate(128 128) scale(1 0.045) translate(-128 -128)" gradientUnits="userSpaceOnUse" cx="128" cy="128" r="128">${stops( [ [ 0, 1 ], [ 0.2, 0.5 ], [ 0.55, 0.12 ], [ 1, 0 ] ] )}</radialGradient></defs><rect width="256" height="256" fill="url(#g)"/>`,
	},
];

for ( const g of generated ) {

	const dst = await svgPng( g.file, g.size, g.body );
	const m = await sharp( dst ).metadata();
	fx.push( { id: g.id, file: `/assets/textures/fx/${g.file}`, bytes: statSync( dst ).size, type: 'texture', width: m.width, height: m.height, channels: m.channels, hasAlpha: !! m.hasAlpha, colorSpace: 'srgb', purpose: g.purpose, license: 'CC0 / project-owned (generated procedurally by tools/assets/tex-fx.mjs, no third-party content)', credit: 'generated', source: 'tools/assets/tex-fx.mjs' } );

}

mkdirSync( resolve( 'assets-src/textures' ), { recursive: true } );
writeFileSync( resolve( 'assets-src/textures/_fx.json' ), JSON.stringify( fx, null, 1 ) );
console.log( `published ${fx.length} fx entries -> ${OUT}` );
