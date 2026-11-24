// Terrain system: the ground from under the wheels to the horizon.
//
// Geometry: the playable square is cut into 128 m chunks drawn as instances of five shared grid meshes (2 m .. 32 m cells);
// vertices are displaced in the vertex stage from the baked height texture, so every LOD samples exact grid heights and
// matches the physics heightfield. Skirts hide the cracks between LODs. The far ring is one static mesh.
// Shading: eight photoscanned layers in two array textures, weighted by the baked biome maps with height-based blending;
// two texture scales against tiling; lighting normals come per pixel from a baked normal texture, never from the mesh.

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, cameraPosition, float, max, mix, mx_noise_float, normalWorld, normalize, positionLocal, positionWorld, smoothstep,
	texture, transformNormalToView, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { resolveUrl } from '../core/assets.js';
import { uWetness } from './shared.js';

const QUALITY = {
	low: { layerSize: 512, lodScale: 0.6, anisotropy: 4, castShadow: false },
	medium: { layerSize: 512, lodScale: 0.8, anisotropy: 8, castShadow: true },
	high: { layerSize: 1024, lodScale: 1, anisotropy: 16, castShadow: true },
	ultra: { layerSize: 2048, lodScale: 1.35, anisotropy: 16, castShadow: true },
};

/** Layer order = channel order of splat0 (r, g, b, a) followed by splat1 (r, g, b, a). */
const LAYERS = [ 'grass_meadow', 'grass_dry', 'forest_floor', 'dirt', 'gravel', 'rock_cliff', 'rock_ground', 'shore' ];
const CLIFF = 5;
const CHUNK_CELLS = 64; // height cells per chunk side (128 m)
const LOD_STEPS = [ 1, 2, 4, 8, 16 ]; // height cells per mesh cell
const LOD_DISTANCE = [ 200, 430, 860, 1700 ]; // switch distances in meters (scaled by quality)
const FAR_TEXTURE_SCALE = 0.131; // the second, coarse texture scale (about 7.6 x larger, not a multiple of the fine one)

/** Loads an image and returns its RGBA bytes at size x size (top row first). */
async function loadPixels( url, size ) {

	const res = await fetch( resolveUrl( url ) );
	if ( ! res.ok ) throw new Error( `terrain: ${url} → HTTP ${res.status}` );
	const bitmap = await createImageBitmap( await res.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: 'high', colorSpaceConversion: 'none' } );
	const canvas = new OffscreenCanvas( size, size );
	const context = canvas.getContext( '2d', { willReadFrequently: true } );
	context.drawImage( bitmap, 0, 0 );
	bitmap.close();
	return context.getImageData( 0, 0, size, size ).data;

}

function arrayTexture( data, size, layers, { srgb, anisotropy } ) {

	const tex = new THREE.DataArrayTexture( data, size, size, layers );
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.UnsignedByteType;
	tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	tex.anisotropy = anisotropy;
	tex.needsUpdate = true;
	return tex;

}

/** A unit grid (x, z in 0..1) of cells x cells quads plus a skirt ring; attribute `skirt` is 1 on the dropped vertices. */
function gridGeometry( cells ) {

	const side = cells + 1;
	const ring = 4 * side;
	const positions = new Float32Array( ( side * side + ring ) * 3 );
	const skirt = new Float32Array( side * side + ring );
	let v = 0;
	for ( let j = 0; j < side; j ++ ) for ( let i = 0; i < side; i ++ ) {

		positions[ v * 3 ] = i / cells;
		positions[ v * 3 + 2 ] = j / cells;
		v ++;

	}

	const indices = [];
	for ( let j = 0; j < cells; j ++ ) for ( let i = 0; i < cells; i ++ ) {

		const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
		indices.push( a, c, b, b, c, d );

	}

	// skirt: duplicate each border vertex, then stitch quads between the border and its dropped copy
	const border = [];
	for ( let i = 0; i < side; i ++ ) border.push( i ); // z = 0
	for ( let j = 0; j < side; j ++ ) border.push( j * side + cells ); // x = 1
	for ( let i = cells; i >= 0; i -- ) border.push( cells * side + i ); // z = 1
	for ( let j = cells; j >= 0; j -- ) border.push( j * side ); // x = 0
	const first = v;
	for ( const source of border ) {

		positions[ v * 3 ] = positions[ source * 3 ];
		positions[ v * 3 + 2 ] = positions[ source * 3 + 2 ];
		skirt[ v ] = 1;
		v ++;

	}

	for ( let k = 0; k < border.length - 1; k ++ ) {

		const a = border[ k ], b = border[ k + 1 ], c = first + k, d = first + k + 1;
		if ( a === b ) continue; // corner repeated between two sides
		indices.push( a, b, c, b, d, c );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'skirt', new THREE.BufferAttribute( skirt, 1 ) );
	geometry.setIndex( indices );
	return geometry;

}

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createTerrain( ctx ) {

	const { world, worldTex, scene, camera } = ctx;
	const quality = QUALITY[ ctx.quality.tier ] ?? QUALITY.high;
	const sets = LAYERS.map( ( id ) => {

		const set = ctx.assets.index.textures?.sets?.find( ( s ) => s.id === id );
		if ( ! set ) throw new Error( `terrain: texture set "${id}" is missing from the texture index` );
		return set;

	} );

	// ── layer array textures: A = albedo rgb + height, B = normal xy + roughness + ambient occlusion
	const size = quality.layerSize, texels = size * size * 4;
	const dataA = new Uint8Array( texels * LAYERS.length ), dataB = new Uint8Array( texels * LAYERS.length );
	await Promise.all( sets.map( async ( set, layer ) => {

		const [ albedo, normal, arm, height ] = await Promise.all( [ set.maps.albedo, set.maps.normal, set.maps.arm, set.maps.height ].map( ( url ) => loadPixels( url, size ) ) );
		const a = layer * texels;
		for ( let p = 0; p < texels; p += 4 ) {

			dataA[ a + p ] = albedo[ p ];
			dataA[ a + p + 1 ] = albedo[ p + 1 ];
			dataA[ a + p + 2 ] = albedo[ p + 2 ];
			dataA[ a + p + 3 ] = height[ p ];
			dataB[ a + p ] = normal[ p ];
			dataB[ a + p + 1 ] = normal[ p + 1 ];
			dataB[ a + p + 2 ] = arm[ p + 1 ]; // roughness
			dataB[ a + p + 3 ] = arm[ p ]; // ambient occlusion

		}

	} ) );
	const layersA = arrayTexture( dataA, size, LAYERS.length, { srgb: true, anisotropy: quality.anisotropy } );
	const layersB = arrayTexture( dataB, size, LAYERS.length, { srgb: false, anisotropy: quality.anisotropy } );

	// ── macro normal texture (2 m grid): rg = world normal x, z
	const n = world.n, cell = world.cell, heights = world.heights;
	const normalData = new Uint8Array( n * n * 4 );
	for ( let iz = 0; iz < n; iz ++ ) {

		const z0 = Math.max( 0, iz - 1 ), z1 = Math.min( n - 1, iz + 1 );
		for ( let ix = 0; ix < n; ix ++ ) {

			const x0 = Math.max( 0, ix - 1 ), x1 = Math.min( n - 1, ix + 1 );
			const dx = ( heights[ iz * n + x0 ] - heights[ iz * n + x1 ] ) / ( ( x1 - x0 ) * cell );
			const dz = ( heights[ z0 * n + ix ] - heights[ z1 * n + ix ] ) / ( ( z1 - z0 ) * cell );
			const inv = 1 / Math.hypot( dx, 1, dz );
			const k = ( iz * n + ix ) * 4;
			normalData[ k ] = Math.round( ( dx * inv * 0.5 + 0.5 ) * 255 );
			normalData[ k + 1 ] = Math.round( ( dz * inv * 0.5 + 0.5 ) * 255 );
			normalData[ k + 2 ] = Math.round( inv * 255 );
			normalData[ k + 3 ] = 255;

		}

	}

	const normalTexture = new THREE.DataTexture( normalData, n, n, THREE.RGBAFormat, THREE.UnsignedByteType );
	normalTexture.magFilter = normalTexture.minFilter = THREE.LinearFilter;
	normalTexture.needsUpdate = true;

	// ── material
	const material = new THREE.MeshStandardNodeMaterial();
	material.side = THREE.DoubleSide; // skirts are seen from either side
	material.metalness = 0;

	// vertex stage: the instance transform has already placed the unit grid in world space
	const skirtDrop = uniform( 6 );
	material.positionNode = Fn( () => {

		const p = positionLocal;
		return vec3( p.x, worldTex.heightAt( p.xz ).sub( attribute( 'skirt', 'float' ).mul( skirtDrop ) ), p.z );

	} )();

	// (a plain function, not Fn: it returns several nodes; TSL shares repeated sub-expressions on its own)
	const shading = () => {

		const xz = positionWorld.xz;
		const distance = positionWorld.sub( cameraPosition ).length();
		const s0 = worldTex.splat0At( xz ), s1 = worldTex.splat1At( xz );
		const fields = worldTex.fieldsAt( xz );
		const weights = [ s0.x, s0.y, s0.z, s0.w, s1.x, s1.y, s1.z, s1.w ];

		// macro normal (world space) from the baked texture
		const packed = texture( normalTexture, worldTex.gridUV( xz, n ) ).xy.mul( 2 ).sub( 1 );
		const macro = normalize( vec3( packed.x, packed.dot( packed ).oneMinus().max( 0.0001 ).sqrt(), packed.y ) );

		const farBlend = smoothstep( 18, 120, distance ).mul( 0.8 );
		const samples = LAYERS.map( ( id, i ) => {

			const set = sets[ i ];
			const uv = xz.div( set.tileSizeMeters );
			let near = texture( layersA, uv ).depth( i );
			let far = texture( layersA, uv.mul( FAR_TEXTURE_SCALE ) ).depth( i ).rgb;
			if ( i === CLIFF ) {

				// steep faces: project the rock along the two horizontal axes as well, so it does not smear down the cliff
				const wy = macro.y.mul( macro.y ), wx = macro.x.mul( macro.x ), wz = macro.z.mul( macro.z );
				const side = vec2( positionWorld.z, positionWorld.y ).div( set.tileSizeMeters ), front = vec2( positionWorld.x, positionWorld.y ).div( set.tileSizeMeters );
				near = near.mul( wy ).add( texture( layersA, side ).depth( i ).mul( wx ) ).add( texture( layersA, front ).depth( i ).mul( wz ) );
				far = far.mul( wy ).add( texture( layersA, side.mul( FAR_TEXTURE_SCALE * 2 ) ).depth( i ).rgb.mul( wx.add( wz ) ) );

			}

			const tint = set.recommended?.albedoTint ?? [ 1, 1, 1 ];
			return {
				color: mix( near.rgb, far, farBlend ).mul( vec3( tint[ 0 ], tint[ 1 ], tint[ 2 ] ) ),
				height: near.a,
				detail: texture( layersB, uv ).depth( i ),
				aoIntensity: set.recommended?.aoIntensity ?? 1,
			};

		} );

		// height blending: a layer wins where its own relief is high, which gives crisp, natural borders
		const levels = samples.map( ( s, i ) => weights[ i ].add( s.height.mul( weights[ i ].mul( 4 ).min( 1 ) ).mul( 0.55 ) ) );
		let top = levels[ 0 ];
		for ( let i = 1; i < levels.length; i ++ ) top = max( top, levels[ i ] );
		const floor = top.sub( 0.22 );
		let total = float( 0 ), color = vec3( 0 ), bump = vec2( 0 ), roughness = float( 0 ), ao = float( 0 );
		samples.forEach( ( s, i ) => {

			const b = levels[ i ].sub( floor ).max( 0 );
			total = total.add( b );
			color = color.add( s.color.mul( b ) );
			bump = bump.add( s.detail.xy.mul( 2 ).sub( 1 ).mul( b ) );
			roughness = roughness.add( s.detail.z.mul( b ) );
			ao = ao.add( mix( float( 1 ), s.detail.w, s.aoIntensity ).mul( b ) );

		} );
		const inv = total.max( 0.0001 ).reciprocal();
		color = color.mul( inv );
		bump = bump.mul( inv );
		roughness = roughness.mul( inv );
		ao = ao.mul( inv );

		// large-scale variation: patches of lighter / darker, lusher where water collects
		const patches = mx_noise_float( vec3( xz.mul( 0.0105 ), 0.3 ) ).mul( 0.6 ).add( mx_noise_float( vec3( xz.mul( 0.047 ), 4.1 ) ).mul( 0.4 ) );
		const soft = s0.x.add( s0.y ).add( s0.z );
		color = color.mul( patches.mul( 0.2 ).add( 1 ) ).mul( mix( float( 1 ), float( 0.86 ), fields.z.mul( soft ) ) );

		// far away the texture detail gives way to the averaged ground colour (no sparkle, no visible tiling)
		const tintColor = worldTex.groundTintAt( xz ).mul( patches.mul( 0.14 ).add( 1 ) );
		color = mix( color, tintColor, smoothstep( 260, 1000, distance ).mul( 0.85 ) );

		// wet ground is darker and shinier
		color = color.mul( mix( float( 1 ), float( 0.68 ), uWetness ) );
		roughness = roughness.mul( mix( float( 1 ), float( 0.55 ), uWetness ) );

		// detail normal on top of the macro normal (texture u = +x, texture "up" = -z), fading with distance
		const strength = smoothstep( 420, 60, distance ).mul( 0.9 );
		const normal = normalize( vec3( macro.x.add( bump.x.mul( strength ) ), macro.y, macro.z.sub( bump.y.mul( strength ) ) ) );
		return { color, normal, roughness, ao };

	};

	const shaded = shading();
	material.colorNode = vec4( shaded.color, 1 );
	material.normalNode = transformNormalToView( shaded.normal );
	material.roughnessNode = shaded.roughness;
	material.aoNode = shaded.ao;

	// ── chunks
	const chunksPerSide = ( n - 1 ) / CHUNK_CELLS;
	const chunkSize = CHUNK_CELLS * cell;
	const chunks = [];
	for ( let cz = 0; cz < chunksPerSide; cz ++ ) for ( let cx = 0; cx < chunksPerSide; cx ++ ) {

		let lo = Infinity, hi = - Infinity;
		for ( let j = 0; j <= CHUNK_CELLS; j += 2 ) for ( let i = 0; i <= CHUNK_CELLS; i += 2 ) {

			const h = heights[ ( cz * CHUNK_CELLS + j ) * n + cx * CHUNK_CELLS + i ];
			if ( h < lo ) lo = h;
			if ( h > hi ) hi = h;

		}

		const x = world.minX + cx * chunkSize, z = world.minZ + cz * chunkSize;
		chunks.push( { x, z, box: new THREE.Box3( new THREE.Vector3( x, lo - 8, z ), new THREE.Vector3( x + chunkSize, hi + 2, z + chunkSize ) ) } );

	}

	const group = new THREE.Group();
	group.name = 'terrain';
	const lods = LOD_STEPS.map( ( step, level ) => {

		const mesh = new THREE.InstancedMesh( gridGeometry( CHUNK_CELLS / step ), material, chunks.length );
		mesh.name = `terrain-lod${level}`;
		mesh.frustumCulled = false; // culled per chunk below
		mesh.receiveShadow = true;
		mesh.castShadow = false; // the ground only receives: lit at headlight height it shadowed itself in stair steps
		mesh.count = 0;
		mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		group.add( mesh );
		return mesh;

	} );
	scene.add( group );

	// ── far ring (static mesh; pushed down under the playable square so the two never fight)
	const outer = world.outer;
	const outerPositions = new Float32Array( outer.n * outer.n * 3 );
	const innerMax = world.minX + world.size;
	for ( let iz = 0; iz < outer.n; iz ++ ) for ( let ix = 0; ix < outer.n; ix ++ ) {

		const x = outer.minX + ix * outer.cell, z = outer.minZ + iz * outer.cell;
		const k = ( iz * outer.n + ix ) * 3;
		const inside = Math.min( x - world.minX, innerMax - x, z - world.minZ, world.minZ + world.size - z ); // > 0 inside the playable square
		outerPositions[ k ] = x;
		outerPositions[ k + 1 ] = outer.heights[ iz * outer.n + ix ] - ( inside > 0 ? Math.min( 60, 4 + inside * 0.6 ) : 0 );
		outerPositions[ k + 2 ] = z;

	}

	const outerIndex = new Uint32Array( ( outer.n - 1 ) * ( outer.n - 1 ) * 6 );
	let o = 0;
	for ( let iz = 0; iz < outer.n - 1; iz ++ ) for ( let ix = 0; ix < outer.n - 1; ix ++ ) {

		const a = iz * outer.n + ix, b = a + 1, c = a + outer.n, d = c + 1;
		outerIndex[ o ++ ] = a; outerIndex[ o ++ ] = c; outerIndex[ o ++ ] = b;
		outerIndex[ o ++ ] = b; outerIndex[ o ++ ] = c; outerIndex[ o ++ ] = d;

	}

	const outerGeometry = new THREE.BufferGeometry();
	outerGeometry.setAttribute( 'position', new THREE.BufferAttribute( outerPositions, 3 ) );
	outerGeometry.setIndex( new THREE.BufferAttribute( outerIndex, 1 ) );
	outerGeometry.computeVertexNormals();

	const outerMaterial = new THREE.MeshStandardNodeMaterial();
	outerMaterial.metalness = 0;
	outerMaterial.roughness = 0.95;
	// Distant slopes, read through kilometres of haze: forest low down, alpine meadow, rock on the steep faces, snow up high.
	// The 48 m mesh is far too smooth on its own, so both colour and lighting normal get several octaves of variation.
	const farXZ = positionWorld.xz, farY = positionWorld.y;
	const broad = mx_noise_float( vec3( farXZ.mul( 0.0034 ), 1.7 ) );
	const medium = mx_noise_float( vec3( farXZ.mul( 0.017 ), 5.3 ) );
	const fine = mx_noise_float( vec3( farXZ.mul( 0.071 ), 9.9 ) );
	const farNormal = normalize( normalWorld.add( vec3(
		mx_noise_float( vec3( farXZ.mul( 0.012 ), 21.0 ) ).mul( 0.34 ).add( mx_noise_float( vec3( farXZ.mul( 0.055 ), 33.0 ) ).mul( 0.2 ) ),
		0,
		mx_noise_float( vec3( farXZ.mul( 0.012 ), 47.0 ) ).mul( 0.34 ).add( mx_noise_float( vec3( farXZ.mul( 0.055 ), 59.0 ) ).mul( 0.2 ) ) ) ) );
	const farSlope = farNormal.y.oneMinus();
	outerMaterial.normalNode = transformNormalToView( farNormal );
	outerMaterial.colorNode = Fn( () => {

		const forest = vec3( 0.02, 0.036, 0.019 ), meadow = vec3( 0.07, 0.098, 0.036 ), rock = vec3( 0.115, 0.108, 0.1 ), snow = vec3( 0.8, 0.83, 0.88 );
		const treeLine = smoothstep( 560, 940, farY.add( broad.mul( 210 ) ).add( medium.mul( 70 ) ) );
		let c = mix( forest.mul( medium.mul( 0.35 ).add( 1 ) ), meadow, treeLine );
		const bare = smoothstep( 0.17, 0.4, farSlope.add( medium.mul( 0.07 ) ) ).max( smoothstep( 1250, 1650, farY.add( broad.mul( 150 ) ) ) );
		c = mix( c, rock.mul( fine.mul( 0.3 ).add( medium.mul( 0.25 ) ).add( 1 ) ), bare );
		const snowCover = smoothstep( 1700, 2150, farY.add( broad.mul( 240 ) ).add( medium.mul( 90 ) ) ).mul( smoothstep( 0.6, 0.28, farSlope ) );
		c = mix( c, snow, snowCover );
		return vec4( c.mul( mix( float( 1 ), float( 0.72 ), uWetness ) ), 1 );

	} )();
	const outerMesh = new THREE.Mesh( outerGeometry, outerMaterial );
	outerMesh.name = 'terrain-far';
	outerMesh.receiveShadow = false;
	scene.add( outerMesh );

	// ── per-frame chunk selection
	const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4(), matrix = new THREE.Matrix4(), closest = new THREE.Vector3();
	const counts = new Int32Array( LOD_STEPS.length );
	const always = LOD_DISTANCE[ 1 ] * quality.lodScale; // nearby chunks are drawn even outside the view: they cast shadows into it

	function update() {

		viewProjection.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		frustum.setFromProjectionMatrix( viewProjection, camera.coordinateSystem, camera.reversedDepth );
		counts.fill( 0 );
		for ( let i = 0; i < chunks.length; i ++ ) {

			const chunk = chunks[ i ];
			const distance = chunk.box.clampPoint( camera.position, closest ).distanceTo( camera.position );
			if ( distance > always && ! frustum.intersectsBox( chunk.box ) ) continue;
			let level = 0;
			while ( level < LOD_DISTANCE.length && distance > LOD_DISTANCE[ level ] * quality.lodScale ) level ++;
			matrix.makeScale( chunkSize, 1, chunkSize ).setPosition( chunk.x, 0, chunk.z );
			lods[ level ].setMatrixAt( counts[ level ] ++, matrix );

		}

		for ( let level = 0; level < lods.length; level ++ ) {

			lods[ level ].count = counts[ level ];
			lods[ level ].instanceMatrix.needsUpdate = true;

		}

	}

	update();
	console.info( `[terrain] ${chunks.length} chunks, layer textures ${size}px, far ring ${outer.n}x${outer.n}` );

	return {
		update,
		/** Macro normal texture of the playable square (rg = world normal x / z, 2 m texels), for other systems. */
		normalTexture,
		dispose() {

			scene.remove( group, outerMesh );
			for ( const mesh of lods ) mesh.geometry.dispose();
			outerGeometry.dispose();
			material.dispose();
			outerMaterial.dispose();
			layersA.dispose();
			layersB.dispose();
			normalTexture.dispose();

		},
	};

}
