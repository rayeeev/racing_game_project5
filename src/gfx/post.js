// Post-processing: owns the final image. The Game calls post.render( frame ) instead of renderer.render().
//
// Chain (scene-linear until the automatic output transform at the end):
//   scene pass (colour, depth, normal, velocity) → ambient occlusion (high / ultra) → highlight clamp → temporal
//   anti-aliasing → bloom → grade (contrast around mid grey, saturation, per-preset white balance) → vignette
//   → tone mapping + sRGB (done by the RenderPipeline).
// Measured on this project (Apple M4 Pro): TRAA ~0.7 ms, GTAO + TRAA ~1.5 ms, bloom ~0.3 ms; SSGI (+12.9 ms) and
// full-resolution SSR (+5.7 ms) do not fit a 60 fps budget and are not used.

import * as THREE from 'three/webgpu';
import { float, luminance, mix, mrt, normalView, output, packNormalToRGB, pass, sample, screenUV, smoothstep, uniform, unpackRGBToNormal, vec3, vec4, velocity } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

const QUALITY = {
	low: { ao: false, aoScale: 0.5, bloom: true },
	medium: { ao: false, aoScale: 0.5, bloom: true },
	high: { ao: true, aoScale: 0.5, bloom: true },
	ultra: { ao: true, aoScale: 1, bloom: true },
};

/** Look per sky preset: contrast pivoting on 18 % grey, saturation, and a white-balance tint (linear RGB gain). */
const GRADES = {
	golden: { contrast: 1.2, saturation: 1.16, tint: [ 1.035, 1.0, 0.95 ], bloom: 0.2 },
	noon: { contrast: 1.16, saturation: 1.1, tint: [ 1.0, 1.0, 1.0 ], bloom: 0.14 },
	overcast: { contrast: 1.2, saturation: 0.98, tint: [ 0.975, 1.0, 1.03 ], bloom: 0.12 },
	dusk: { contrast: 1.14, saturation: 1.08, tint: [ 0.97, 0.99, 1.05 ], bloom: 0.3 },
};

const HIGHLIGHT_CLAMP = 48; // scene-linear radiance above this (the sun disc is ~68 000) only produces fireflies

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createPost( ctx ) {

	const { renderer, scene, camera } = ctx;
	const quality = QUALITY[ ctx.quality.tier ] ?? QUALITY.high;

	const contrast = uniform( 1.18 ), saturation = uniform( 1.1 ), tint = uniform( new THREE.Vector3( 1, 1, 1 ) ), vignette = uniform( 0.22 );
	const bloomStrength = uniform( 0.18 );

	const pipeline = new THREE.RenderPipeline( renderer );
	const scenePass = pass( scene, camera );
	scenePass.setMRT( mrt( { output, velocity, normal: packNormalToRGB( normalView ) } ) );
	const color = scenePass.getTextureNode( 'output' );
	const depth = scenePass.getTextureNode( 'depth' );
	const motion = scenePass.getTextureNode( 'velocity' );

	let lit = color.rgb;
	let aoPass = null;
	if ( quality.ao ) {

		const normal = sample( ( uv ) => unpackRGBToNormal( scenePass.getTextureNode( 'normal' ).sample( uv ) ) );
		aoPass = ao( depth, normal, camera );
		aoPass.resolutionScale = quality.aoScale;
		aoPass.radius.value = 1.1; // meters: grounds the car and roadside objects, darkens under trees
		aoPass.thickness.value = 1.4;
		aoPass.distanceExponent.value = 1.6;
		aoPass.samples.value = 12;
		// occlusion belongs to ambient light; over the whole image it is applied at reduced strength
		lit = lit.mul( mix( float( 1 ), aoPass.getTextureNode().r, 0.72 ) );

	}

	const clamped = vec4( lit.min( vec3( HIGHLIGHT_CLAMP ) ), color.a );
	const stable = traa( clamped, depth, motion, camera );
	const glow = quality.bloom ? bloom( stable, 1, 0.55, 1.15 ) : null;
	let image = glow ? stable.rgb.add( glow.rgb.mul( bloomStrength ) ) : stable.rgb;

	// grade in scene-linear light: white balance, contrast about mid grey, saturation
	image = image.mul( tint );
	const grey = luminance( image ).max( 0.00001 );
	const curved = grey.div( 0.18 ).pow( contrast ).mul( 0.18 );
	image = image.mul( curved.div( grey ) );
	image = mix( vec3( curved ), image, saturation );

	// lens: gentle darkening toward the corners
	const fromCentre = screenUV.sub( 0.5 ).mul( 2 );
	image = image.mul( float( 1 ).sub( vignette.mul( smoothstep( 0.55, 1.5, fromCentre.length() ) ) ) );

	pipeline.outputNode = vec4( image, 1 );

	function applyGrade( id ) {

		const grade = GRADES[ id ] ?? GRADES.golden;
		contrast.value = grade.contrast;
		saturation.value = grade.saturation;
		tint.value.fromArray( grade.tint );
		bloomStrength.value = grade.bloom;

	}

	applyGrade( ctx.sky.id );
	const offSky = ctx.events.on( 'sky:changed', ( sky ) => applyGrade( sky.id ) );

	return {
		/** Renders the frame. */
		render() {

			pipeline.render();

		},
		/** Builds the scene's render pipelines for the targets this chain really draws into (the canvas is not one). */
		compile() {

			// what PassNode.setup() does on the first render - it has not run yet, and without it the depth buffer (and
			// every pipeline keyed on its format) is created for the wrong format
			const target = scenePass.renderTarget;
			target.texture.type = renderer.getOutputBufferType();
			if ( renderer.reversedDepthBuffer === true && target.depthTexture ) target.depthTexture.type = THREE.FloatType;
			return scenePass.compileAsync( renderer );

		},
		resize() {},
		/** What is active (for diagnostics). */
		info() {

			return { ao: Boolean( aoPass ), bloom: Boolean( glow ), antialiasing: 'traa' };

		},
		dispose() {

			offSky();
			pipeline.dispose?.();

		},
	};

}
