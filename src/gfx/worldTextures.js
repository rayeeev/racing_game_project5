// GPU textures and TSL lookup helpers for the baked world maps. Created once by the Game (ctx.worldTex) BEFORE any system,
// so terrain, road, water, scatter, grass and effects can all sample the same data without depending on each other.
//
// All textures are DataTextures built from the raw baked arrays, so they share ONE addressing convention:
//   row-major with z as the row (index = iz * n + ix), texel (ix, iz) ↔ world ( minX + ix * cell, minZ + iz * cell ),
//   u ↔ x, v ↔ z, no vertical flip.
// Every "...At( xz )" helper takes a vec2 node holding WORLD ( x, z ) in meters and can be used in the vertex or fragment stage.
//
//   heightAt( xz )      float   terrain height in meters (exact bilinear of the 2 m grid; matches World.heightAt on the CPU)
//   normalAt( xz )      vec3    unit terrain normal (world space, from central differences)
//   splat0At( xz )      vec4    biome weights 0..1: ( grass_meadow, grass_dry, forest_floor, dirt )
//   splat1At( xz )      vec4    biome weights 0..1: ( gravel, rock_cliff, rock_ground, shore )
//   fieldsAt( xz )      vec4    ( forest density, meadow / flower density, wetness, distance to the pavement edge / 64 m ) each 0..1
//   maskAt( xz )        float   vegetation mask 0..1: 1 = ground cover may grow, 0 = cleared (stamped by systems at init)
//   groundTintAt( xz )  vec3    approximate terrain albedo (linear RGB) - for tinting grass, dust and distant impostors
//
// CPU side: stampCircle / stampBox clear areas of the vegetation mask (road furniture, paddock, big rocks, tree trunks),
// maskValue( x, z ) reads it back (0..1). Stamps made after boot are uploaded automatically on the next frame.

import * as THREE from 'three/webgpu';
import { Fn, texture, textureLoad, vec2, vec3, float, ivec2, floor, mix, clamp, normalize } from 'three/tsl';

const SPLAT0_LAYERS = [ 'grass_meadow', 'grass_dry', 'forest_floor', 'dirt' ];
const SPLAT1_LAYERS = [ 'gravel', 'rock_cliff', 'rock_ground', 'shore' ];
const FALLBACK_LAYER_COLORS = {
	grass_meadow: [ 0.09, 0.13, 0.035 ],
	grass_dry: [ 0.21, 0.19, 0.08 ],
	forest_floor: [ 0.085, 0.06, 0.035 ],
	dirt: [ 0.16, 0.115, 0.075 ],
	gravel: [ 0.25, 0.24, 0.22 ],
	rock_cliff: [ 0.2, 0.2, 0.2 ],
	rock_ground: [ 0.22, 0.21, 0.19 ],
	shore: [ 0.26, 0.24, 0.2 ],
};

function linearToSrgb8( v ) {

	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow( v, 1 / 2.4 ) - 0.055;
	return Math.max( 0, Math.min( 255, Math.round( c * 255 ) ) );

}

function dataTexture( data, width, height, { format = THREE.RGBAFormat, type = THREE.UnsignedByteType, linear = true, srgb = false, name = '' } = {} ) {

	const tex = new THREE.DataTexture( data, width, height, format, type );
	tex.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
	tex.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	tex.flipY = false;
	tex.name = name;
	tex.needsUpdate = true;
	return tex;

}

/**
 * @typedef {ReturnType<typeof createWorldTextures>} WorldTextures
 */

/**
 * @param {import('../sim/world.js').World} world   loaded with decoded splat / fields maps
 * @param {import('../core/assets.js').Assets} [assets]   used for the average layer colours of the ground tint
 */
export function createWorldTextures( world, assets = null ) {

	const { n, cell, minX, minZ, size } = world;

	// ── heights (R32F, exact values; sampled with a manual bilinear because 32-bit float textures are not filterable everywhere)
	const heightTexture = dataTexture( world.heights, n, n, { format: THREE.RedFormat, type: THREE.FloatType, linear: false, name: 'world.height' } );

	// ── baked 8-bit maps
	const maps = {};
	for ( const key of [ 'splat0', 'splat1', 'fields' ] ) {

		const map = world[ key ];
		if ( map && map.data ) {

			maps[ key ] = { ...map, texture: dataTexture( map.data, map.width, map.height, { name: 'world.' + key } ) };

		} else {

			// neutral fallback so materials still compile when a map is missing: all grass / no forest
			const px = key === 'splat0' ? [ 255, 0, 0, 0 ] : key === 'splat1' ? [ 0, 0, 0, 0 ] : [ 0, 128, 0, 255 ];
			maps[ key ] = { width: 1, height: 1, data: new Uint8Array( px ), texture: dataTexture( new Uint8Array( px ), 1, 1, { name: 'world.' + key } ) };
			console.warn( `[worldTextures] baked map "${key}" is not available - using a neutral fallback` );

		}

	}

	// ── vegetation mask (R8, same vertex-centred grid as the heights)
	const maskData = new Uint8Array( n * n ).fill( 255 );
	const mask = dataTexture( maskData, n, n, { format: THREE.RedFormat, name: 'world.mask' } );

	// ── ground tint: splat-weighted average of the terrain layers' mean albedo
	const tintW = maps.splat0.width, tintH = maps.splat0.height;
	const tintData = new Uint8Array( tintW * tintH * 4 );
	{

		const sets = assets?.index?.textures?.sets ?? [];
		// mean albedo of a layer as it is meant to be shaded: the scan's average times the recommended tint of the index
		const colorOf = ( id ) => {

			const set = sets.find( ( s ) => s.id === id );
			if ( ! set?.avgColorLinear ) return FALLBACK_LAYER_COLORS[ id ];
			const tint = set.recommended?.albedoTint ?? [ 1, 1, 1 ];
			return set.avgColorLinear.map( ( v, i ) => v * tint[ i ] );

		};
		const c0 = SPLAT0_LAYERS.map( colorOf ), c1 = SPLAT1_LAYERS.map( colorOf );
		const s0 = maps.splat0.data, s1 = maps.splat1.data;
		const sameSize = maps.splat1.width === tintW && maps.splat1.height === tintH;
		for ( let i = 0, count = tintW * tintH; i < count; i ++ ) {

			let r = 0, g = 0, b = 0, w = 0;
			for ( let k = 0; k < 4; k ++ ) {

				const w0 = s0[ i * 4 + k ];
				const w1 = sameSize ? s1[ i * 4 + k ] : 0;
				r += w0 * c0[ k ][ 0 ] + w1 * c1[ k ][ 0 ];
				g += w0 * c0[ k ][ 1 ] + w1 * c1[ k ][ 1 ];
				b += w0 * c0[ k ][ 2 ] + w1 * c1[ k ][ 2 ];
				w += w0 + w1;

			}

			w = w || 1;
			tintData[ i * 4 ] = linearToSrgb8( r / w );
			tintData[ i * 4 + 1 ] = linearToSrgb8( g / w );
			tintData[ i * 4 + 2 ] = linearToSrgb8( b / w );
			tintData[ i * 4 + 3 ] = 255;

		}

	}

	const groundTint = dataTexture( tintData, tintW, tintH, { srgb: true, name: 'world.groundTint' } );

	// ── TSL helpers
	const origin = vec2( minX, minZ );

	/** uv of a vertex-centred grid with `count` samples per side covering the inner world square. */
	const gridUV = ( xz, count ) => xz.sub( origin ).div( size ).mul( ( count - 1 ) / count ).add( 0.5 / count );

	const heightAt = Fn( ( [ xz ] ) => {

		const g = clamp( xz.sub( origin ).div( cell ), 0, n - 1.0001 );
		const base = floor( g );
		const f = g.sub( base );
		const i = ivec2( base );
		const h00 = textureLoad( heightTexture, i ).r;
		const h10 = textureLoad( heightTexture, i.add( ivec2( 1, 0 ) ) ).r;
		const h01 = textureLoad( heightTexture, i.add( ivec2( 0, 1 ) ) ).r;
		const h11 = textureLoad( heightTexture, i.add( ivec2( 1, 1 ) ) ).r;
		return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );

	} );

	const normalAt = Fn( ( [ xz ] ) => {

		const e = float( cell );
		const hl = heightAt( xz.sub( vec2( e, 0 ) ) );
		const hr = heightAt( xz.add( vec2( e, 0 ) ) );
		const hd = heightAt( xz.sub( vec2( 0, e ) ) );
		const hu = heightAt( xz.add( vec2( 0, e ) ) );
		return normalize( vec3( hl.sub( hr ), e.mul( 2 ), hd.sub( hu ) ) );

	} );

	const splat0At = ( xz ) => texture( maps.splat0.texture, gridUV( xz, maps.splat0.width ) );
	const splat1At = ( xz ) => texture( maps.splat1.texture, gridUV( xz, maps.splat1.width ) );
	const fieldsAt = ( xz ) => texture( maps.fields.texture, gridUV( xz, maps.fields.width ) );
	const maskAt = ( xz ) => texture( mask, gridUV( xz, n ) ).r;
	const groundTintAt = ( xz ) => texture( groundTint, gridUV( xz, tintW ) ).rgb;

	// ── CPU-side mask editing
	let maskDirty = false;

	function stamp( x0, z0, x1, z1, coverage, value ) {

		const ix0 = Math.max( 0, Math.floor( ( x0 - minX ) / cell ) ), ix1 = Math.min( n - 1, Math.ceil( ( x1 - minX ) / cell ) );
		const iz0 = Math.max( 0, Math.floor( ( z0 - minZ ) / cell ) ), iz1 = Math.min( n - 1, Math.ceil( ( z1 - minZ ) / cell ) );
		const target = Math.round( value * 255 );
		for ( let iz = iz0; iz <= iz1; iz ++ ) {

			for ( let ix = ix0; ix <= ix1; ix ++ ) {

				const c = coverage( minX + ix * cell, minZ + iz * cell );
				if ( c <= 0 ) continue;
				const i = iz * n + ix;
				const blended = maskData[ i ] + ( target - maskData[ i ] ) * Math.min( 1, c );
				maskData[ i ] = Math.min( maskData[ i ], Math.round( blended ) );

			}

		}

		maskDirty = true;

	}

	return {
		minX, minZ, size, cell, n,
		heightTexture,
		splat0: maps.splat0.texture,
		splat1: maps.splat1.texture,
		fields: maps.fields.texture,
		mask,
		groundTint,
		/** Raw RGBA bytes of the ground tint (sRGB); a system that bakes a better tint may overwrite it and call refreshGroundTint(). */
		groundTintData: tintData,
		groundTintSize: [ tintW, tintH ],

		heightAt,
		normalAt,
		splat0At,
		splat1At,
		fieldsAt,
		maskAt,
		groundTintAt,
		gridUV,

		/**
		 * Clears vegetation inside a circle (value 0) or sets another mask value 0..1. `feather` (m) softens the edge.
		 */
		stampCircle( x, z, radius, value = 0, feather = 1 ) {

			const outer = radius + feather;
			stamp( x - outer, z - outer, x + outer, z + outer, ( px, pz ) => {

				const d = Math.hypot( px - x, pz - z );
				return feather > 0 ? ( outer - d ) / feather : ( d <= radius ? 1 : 0 );

			}, value );

		},

		/**
		 * Clears vegetation inside an oriented rectangle centred at (x, z). halfX / halfZ are the half extents along the
		 * rectangle's local x / z axes; yaw rotates it about +Y (same convention as the car heading).
		 */
		stampBox( x, z, halfX, halfZ, yaw = 0, value = 0, feather = 1 ) {

			const cos = Math.cos( yaw ), sin = Math.sin( yaw );
			const reach = Math.hypot( halfX, halfZ ) + feather;
			stamp( x - reach, z - reach, x + reach, z + reach, ( px, pz ) => {

				const dx = px - x, dz = pz - z;
				const lx = Math.abs( dx * cos - dz * sin );
				const lz = Math.abs( dx * sin + dz * cos );
				const outside = Math.max( lx - halfX, lz - halfZ );
				return feather > 0 ? ( feather - outside ) / feather : ( outside <= 0 ? 1 : 0 );

			}, value );

		},

		/** Reads the vegetation mask on the CPU (0..1, nearest texel). */
		maskValue( x, z ) {

			const ix = Math.max( 0, Math.min( n - 1, Math.round( ( x - minX ) / cell ) ) );
			const iz = Math.max( 0, Math.min( n - 1, Math.round( ( z - minZ ) / cell ) ) );
			return maskData[ iz * n + ix ] / 255;

		},

		refreshGroundTint() {

			groundTint.needsUpdate = true;

		},

		/** Uploads pending mask edits (called by the Game once per frame). */
		flush() {

			if ( maskDirty ) {

				mask.needsUpdate = true;
				maskDirty = false;

			}

		},
	};

}
