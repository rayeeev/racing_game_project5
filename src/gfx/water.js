// Water system: the alpine lake. One flat surface at the water level; everything else is shading:
// wind-driven ripples from two scrolling normal maps, depth-based colour and clarity computed from the terrain height
// texture (no depth-buffer tricks, so it is stable with temporal anti-aliasing), a soft shoreline, sky reflection from
// the environment and the sun's glitter path from the scene light.

import * as THREE from 'three/webgpu';
import { cameraPosition, float, mix, normalMap, positionWorld, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { uTime, uWetness, uWindDirection, uWindStrength } from './shared.js';

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createWater( ctx ) {

	const { world, worldTex, scene, assets } = ctx;
	const fx = assets.index.textures?.fx ?? [];
	const file = ( id ) => fx.find( ( f ) => f.id === id )?.file;
	const [ ripplesA, ripplesB ] = await Promise.all( [ assets.texture( file( 'water_normals_a' ) ), assets.texture( file( 'water_normals_b' ) ) ] );

	// extent of everything below the water line (plus a margin for the shore blend)
	const { n, cell, minX, minZ, heights, waterLevel } = world;
	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( let iz = 0; iz < n; iz += 4 ) for ( let ix = 0; ix < n; ix += 4 ) {

		if ( heights[ iz * n + ix ] > waterLevel + 0.3 ) continue;
		const x = minX + ix * cell, z = minZ + iz * cell;
		if ( x < x0 ) x0 = x;
		if ( x > x1 ) x1 = x;
		if ( z < z0 ) z0 = z;
		if ( z > z1 ) z1 = z;

	}

	if ( ! Number.isFinite( x0 ) ) return { update() {}, dispose() {} }; // a world without water

	const margin = 24;
	const geometry = new THREE.PlaneGeometry( x1 - x0 + 2 * margin, z1 - z0 + 2 * margin );
	geometry.rotateX( - Math.PI / 2 );
	const material = new THREE.MeshPhysicalNodeMaterial();
	material.metalness = 0;
	material.transparent = true;
	material.depthWrite = false;

	const xz = positionWorld.xz;
	const depth = float( waterLevel ).sub( worldTex.heightAt( xz ) ).max( 0 );
	const distance = positionWorld.sub( cameraPosition ).length();

	// ripples: two layers drifting with the wind at different speeds and scales; calmer far away (no shimmer)
	const drift = uWindDirection.mul( uTime );
	const strength = uWindStrength.mul( 0.55 ).add( 0.12 );
	const a = texture( ripplesA, xz.div( 14 ).add( drift.mul( 0.022 ) ) ).rgb;
	const b = texture( ripplesB, xz.div( 5.3 ).sub( drift.mul( 0.035 ) ).add( vec2( 0.31, 0.17 ) ) ).rgb;
	const c = texture( ripplesA, xz.div( 71 ).add( drift.mul( 0.008 ) ).add( vec2( 0.5, 0.2 ) ) ).rgb;
	const ripple = a.add( b ).add( c.mul( 0.7 ) ).div( 2.7 );
	const calm = smoothstep( 500, 60, distance ).mul( 0.75 ).add( 0.25 );
	material.normalNode = normalMap( ripple, vec2( strength.mul( calm ) ) );

	// colour: clear shallows over the pebble bed, deep blue-green further out
	const murk = depth.mul( - 0.22 ).exp().oneMinus(); // 0 at the shore .. 1 in deep water
	const shallow = vec3( 0.055, 0.115, 0.1 ), deep = vec3( 0.006, 0.026, 0.034 );
	material.colorNode = vec4( mix( shallow, deep, murk ).mul( mix( float( 1 ), float( 0.7 ), uWetness ) ), 1 );
	material.roughnessNode = mix( float( 0.045 ), float( 0.16 ), uWetness.mul( 0.5 ).add( uWindStrength.mul( 0.25 ) ) );
	// the bed shows through near the shore; the edge itself fades out so there is no hard polygon line
	material.opacityNode = smoothstep( 0.0, 0.22, depth ).mul( mix( float( 0.62 ), float( 0.985 ), murk ) );
	material.specularIntensityNode = float( 1 );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.position.set( ( x0 + x1 ) / 2, waterLevel, ( z0 + z1 ) / 2 );
	mesh.name = 'lake';
	mesh.receiveShadow = true;
	mesh.renderOrder = 1;
	scene.add( mesh );
	console.info( `[water] lake ${Math.round( x1 - x0 )} x ${Math.round( z1 - z0 )} m` );

	return {
		update() {},
		dispose() {

			scene.remove( mesh );
			geometry.dispose();
			material.dispose();

		},
	};

}
