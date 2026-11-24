// Environment system: sky, image-based lighting, the sun and its cascaded shadows, fog / aerial perspective, exposure,
// wind, and the wet / night state of the world. Owns ctx.sky and the lighting uniforms of ./shared.js.
//
// Energy model (see public/assets/sky/presets.json → conventions): env.hdr is the sky WITHOUT the sun disc and lights the
// scene as environment; the DirectionalLight puts the sun's energy back (intensity * colour = the removed irradiance), so
// direct light casts shadows and is not counted twice. sky.hdr (with the sun) is only the visible background.

import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, dot, float, fog, max, mix, normalize, positionWorld, pow, select } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { resolveUrl } from '../core/assets.js';
import {
	uAmbientColor, uFogColor, uFogDensity, uFogHeightFalloff, uFogSunColor, uNight, uSunColor, uSunDirection, uWetness,
	uWindDirection, uWindStrength,
} from './shared.js';

const QUALITY = {
	low: { cascades: 2, shadowMap: 1024, shadowDistance: 130, sky: 'sky2k' },
	medium: { cascades: 3, shadowMap: 2048, shadowDistance: 220, sky: 'sky2k' },
	high: { cascades: 4, shadowMap: 2048, shadowDistance: 320, sky: 'sky' },
	ultra: { cascades: 4, shadowMap: 4096, shadowDistance: 420, sky: 'sky' },
};

/** Weather that goes with each sky preset. */
const CONDITIONS = {
	golden: { wetness: 0, night: 0, wind: 0.22 },
	noon: { wetness: 0, night: 0, wind: 0.34 },
	overcast: { wetness: 1, night: 0, wind: 0.5 },
	dusk: { wetness: 0, night: 1, wind: 0.16 },
};

/** Extinction at lake level in 1/m for the presets' qualitative fog hints. */
const FOG_DENSITY = { clear: 0.000055, hazy: 0.00011, misty: 0.00034 };
const FOG_HEIGHT_FALLOFF = 0.0021; // 1/m: the haze thins out with altitude
const SUN_DISTANCE = 1500; // m, the light sits this far from the camera along the sun direction

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createEnvironment( ctx ) {

	const { scene, renderer, camera } = ctx;
	const quality = QUALITY[ ctx.quality.tier ] ?? QUALITY.high;
	const index = ctx.assets.index.sky;
	const list = Array.isArray( index ) ? index : ( index?.presets ?? [] );
	if ( list.length === 0 ) throw new Error( 'environment: no sky presets (public/assets/sky/presets.json)' );
	const loader = new HDRLoader();

	// ── sun
	const sun = new THREE.DirectionalLight( 0xffffff, 0 );
	sun.name = 'sun';
	sun.castShadow = true;
	sun.shadow.mapSize.set( quality.shadowMap, quality.shadowMap );
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far = SUN_DISTANCE * 2.4;
	sun.shadow.bias = - 0.00035;
	sun.shadow.normalBias = 0.045;
	const csm = new CSMShadowNode( sun, { cascades: quality.cascades, maxFar: quality.shadowDistance, mode: 'practical', lightMargin: 420 } );
	csm.fade = true;
	sun.shadow.shadowNode = csm;
	scene.add( sun, sun.target );

	// ── fog: exponential height fog, integrated along the view ray, tinted toward the sun
	const ray = positionWorld.sub( cameraPosition );
	const fogFactor = Fn( () => {

		const distance = ray.length();
		const k = uFogHeightFalloff;
		const kd = k.mul( ray.y );
		const safe = select( kd.abs().lessThan( 1e-4 ), float( 1e-4 ), kd );
		// optical depth = density( camera height ) * distance * ( 1 - e^-kd ) / kd
		const depth = uFogDensity.mul( k.mul( cameraPosition.y ).negate().exp() ).mul( distance ).mul( safe.negate().exp().oneMinus().div( safe ) );
		return depth.negate().exp().oneMinus();

	} )();
	const towardSun = pow( max( dot( normalize( ray ), uSunDirection ), 0 ), 5 );
	scene.fogNode = fog( mix( uFogColor, uFogSunColor, towardSun ), fogFactor );

	const system = {
		/** Presets for the menu. */
		presets: list.map( ( p ) => ( { id: p.id, name: p.name, thumb: p.files?.thumb ?? p.meta?.files?.thumb, wet: ( CONDITIONS[ p.id ]?.wetness ?? 0 ) > 0.5, night: ( CONDITIONS[ p.id ]?.night ?? 0 ) > 0.5 } ) ),
		/** Id of the active preset. */
		current: '',
		sun,
		csm,
		setPreset,
		update,
		resize,
		dispose,
	};

	let skyTexture = null, envTexture = null, loading = 0, baseWind = 0.25, hasSun = false;

	/**
	 * Switches the sky preset: textures, light, fog, exposure, weather. Resolves when the new sky is in place.
	 * @param {string} id
	 */
	async function setPreset( id ) {

		const preset = list.find( ( p ) => p.id === id ) ?? list[ 0 ];
		const meta = preset.meta, files = preset.files ?? meta.files;
		const token = ++ loading;
		const [ sky, env ] = await Promise.all( [
			loader.loadAsync( resolveUrl( files[ quality.sky ] ?? files.sky ) ),
			loader.loadAsync( resolveUrl( files.env ) ),
		] );
		if ( token !== loading ) {

			// a newer request overtook this one
			sky.dispose();
			env.dispose();
			return;

		}

		sky.mapping = env.mapping = THREE.EquirectangularReflectionMapping;
		scene.background = sky;
		scene.environment = env;
		scene.backgroundIntensity = 1;
		scene.environmentIntensity = meta.ambientIntensity ?? 1;
		skyTexture?.dispose();
		envTexture?.dispose();
		skyTexture = sky;
		envTexture = env;

		renderer.toneMappingExposure = renderer.toneMapping === THREE.ACESFilmicToneMapping ? meta.exposure.aces : meta.exposure.agx;

		// state shared with everyone
		const condition = CONDITIONS[ preset.id ] ?? CONDITIONS.golden;
		const state = ctx.sky;
		hasSun = Boolean( meta.hasSun ) && meta.sunIntensity > 0;
		state.id = preset.id;
		state.meta = meta;
		state.hasSun = hasSun;
		state.wetness = condition.wetness;
		state.night = condition.night;
		state.sunDirection.fromArray( meta.sunDirection ).normalize();
		state.sunColor.setRGB( meta.sunColor[ 0 ], meta.sunColor[ 1 ], meta.sunColor[ 2 ] ).multiplyScalar( hasSun ? meta.sunIntensity : 0 );

		sun.color.setRGB( meta.sunColor[ 0 ], meta.sunColor[ 1 ], meta.sunColor[ 2 ] );
		sun.intensity = hasSun ? meta.sunIntensity : 0;
		sun.castShadow = hasSun;

		uSunDirection.value.copy( state.sunDirection );
		uSunColor.value.copy( state.sunColor );
		const ambient = meta.skyIrradiance ?? meta.averageColor ?? [ 0.5, 0.6, 0.7 ];
		uAmbientColor.value.setRGB( ambient[ 0 ] / Math.PI, ambient[ 1 ] / Math.PI, ambient[ 2 ] / Math.PI );
		uWetness.value = state.wetness;
		uNight.value = state.night;

		const haze = meta.fog?.color ?? meta.horizonColor;
		const sunHaze = meta.sunsideHazeColor ?? haze;
		uFogColor.value.setRGB( haze[ 0 ], haze[ 1 ], haze[ 2 ] );
		// toward the sun the haze glows, but far less than the sky right at the disc
		uFogSunColor.value.setRGB( haze[ 0 ] + 0.3 * ( sunHaze[ 0 ] - haze[ 0 ] ), haze[ 1 ] + 0.3 * ( sunHaze[ 1 ] - haze[ 1 ] ), haze[ 2 ] + 0.3 * ( sunHaze[ 2 ] - haze[ 2 ] ) );
		uFogDensity.value = FOG_DENSITY[ meta.fog?.density ] ?? FOG_DENSITY.hazy;
		uFogHeightFalloff.value = FOG_HEIGHT_FALLOFF;
		baseWind = condition.wind;

		system.current = preset.id;
		ctx.events.emit( 'sky:changed', state );

	}

	/** @param {import('../game/context.js').Frame} frame */
	function update( frame ) {

		// the sun follows the camera so the cascades always cover the view
		sun.target.position.copy( camera.position );
		sun.position.copy( camera.position ).addScaledVector( ctx.sky.sunDirection, SUN_DISTANCE );
		sun.target.updateMatrixWorld();

		// slow gusts and a gently wandering direction
		const t = frame.time;
		uWindStrength.value = baseWind * ( 1 + 0.34 * Math.sin( t * 0.31 ) + 0.2 * Math.sin( t * 0.83 + 1.3 ) + 0.1 * Math.sin( t * 2.1 + 0.4 ) );
		const heading = 0.64 + 0.22 * Math.sin( t * 0.05 ) + 0.07 * Math.sin( t * 0.37 );
		uWindDirection.value.set( Math.cos( heading ), Math.sin( heading ) );

	}

	function resize() {

		if ( csm.camera ) csm.updateFrustums();

	}

	function dispose() {

		scene.remove( sun, sun.target );
		scene.fogNode = null;
		skyTexture?.dispose();
		envTexture?.dispose();
		csm.dispose?.();

	}

	await setPreset( 'dusk' ); // the one and only time of day
	return system;

}
