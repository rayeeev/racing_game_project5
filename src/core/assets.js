// Asset access with caching and progress reporting. Browser only (uses three loaders + fetch).
//
// Asset index files (written by the asset pipeline) are loaded once by loadIndexes() and exposed as assets.index:
//   index.textures  /assets/textures/index.json   { sets: [ { id, tileSizeMeters, avgColorLinear, maps: { albedo, normal, arm, height } ... } ], fx: [ ... ] }
//   index.rocks     /assets/rocks/index.json      { assets: [ { id, file, variants: [ { name, size, radius, lods: [ { node, triangles } ], collider ... } ] } ] }
//   index.trees     /assets/trees/index.json      (same shape + height, crownRadius, trunkRadius, impostor ...)
//   index.plants    /assets/plants/index.json     (same shape + colorRoot, colorTip ...)
//   index.props     /assets/props/index.json      (same shape + dynamic, mass, placement ...)
//   index.audio     /assets/audio/index.json      { sounds: [ { id, file, group, loop, rpm ... } ] }
//   index.sky       /assets/sky/presets.json      [ { id, name, files, meta ... } ]
//   index.car       /assets/car/car.json          structural spec + material recipe of the player car
//   index.ghosts    /assets/world/ghosts.json     baked rival laps { dry: { bronze, silver, gold }, wet: { ... } }

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const BASE = ( import.meta.env?.BASE_URL ?? '/' ).replace( /\/$/, '' );

/** Maps a site-absolute asset path ("/assets/...") to a URL that works under the deployed base path. */
export function resolveUrl( url ) {

	return url.startsWith( '/' ) ? BASE + url : url;

}

const INDEX_FILES = {
	textures: '/assets/textures/index.json',
	rocks: '/assets/rocks/index.json',
	trees: '/assets/trees/index.json',
	plants: '/assets/plants/index.json',
	props: '/assets/props/index.json',
	audio: '/assets/audio/index.json',
	sky: '/assets/sky/presets.json',
	car: '/assets/car/car.json',
	ghosts: '/assets/world/ghosts.json',
};

export class Assets {

	/**
	 * @param {Object} [options]
	 * @param {number} [options.maxAnisotropy=8] default anisotropy for repeating textures
	 */
	constructor( { maxAnisotropy = 8 } = {} ) {

		/** Parsed index files by category (see the header comment). Missing categories are null. */
		this.index = {};
		this.maxAnisotropy = maxAnisotropy;

		/** Progress callback: ( { done, total, label } ) => void */
		this.onProgress = null;

		this._cache = new Map();
		this._done = 0;
		this._total = 0;

		const draco = new DRACOLoader().setDecoderPath( resolveUrl( '/libs/draco/gltf/' ) );
		this._gltfLoader = new GLTFLoader().setDRACOLoader( draco ).setMeshoptDecoder( MeshoptDecoder );
		this._textureLoader = new THREE.TextureLoader();
		this._hdrLoader = new HDRLoader();

	}

	/** Number of requests finished / started so far. */
	get progress() {

		return { done: this._done, total: this._total };

	}

	_track( key, label, factory ) {

		let promise = this._cache.get( key );
		if ( promise ) return promise;

		this._total ++;
		this._report( label );
		promise = factory().then(
			( value ) => {

				this._done ++;
				this._report( label );
				return value;

			},
			( err ) => {

				this._done ++;
				this._report( label );
				this._cache.delete( key );
				throw new Error( `Failed to load ${label}: ${err?.message ?? err}` );

			}
		);
		this._cache.set( key, promise );
		return promise;

	}

	_report( label ) {

		if ( this.onProgress ) this.onProgress( { done: this._done, total: this._total, label } );

	}

	/** Loads the asset index files. Missing ones become null (a warning is logged) so subsets of the game still boot. */
	async loadIndexes( categories = Object.keys( INDEX_FILES ) ) {

		await Promise.all( categories.map( async ( name ) => {

			try {

				this.index[ name ] = await this.json( INDEX_FILES[ name ] );

			} catch ( err ) {

				console.warn( `[assets] index "${name}" not available (${err.message})` );
				this.index[ name ] = null;

			}

		} ) );
		return this.index;

	}

	/** @returns {Promise<any>} parsed JSON */
	json( url ) {

		return this._track( 'json:' + url, url, async () => {

			const res = await fetch( resolveUrl( url ) );
			if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
			return res.json();

		} );

	}

	/** @returns {Promise<ArrayBuffer>} */
	arrayBuffer( url ) {

		return this._track( 'bin:' + url, url, async () => {

			const res = await fetch( resolveUrl( url ) );
			if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
			return res.arrayBuffer();

		} );

	}

	/**
	 * Loads a glTF / GLB (Draco and meshopt supported). The SAME gltf object is returned to every caller:
	 * clone scenes / share geometries + materials deliberately.
	 * @returns {Promise<{ scene: THREE.Group, scenes: THREE.Group[], animations: THREE.AnimationClip[] }>}
	 */
	gltf( url ) {

		return this._track( 'gltf:' + url, url, () => this._gltfLoader.loadAsync( resolveUrl( url ) ) );

	}

	/**
	 * Loads an image texture.
	 * @param {string} url
	 * @param {Object} [options]
	 * @param {boolean} [options.srgb=false]    true for colour (albedo / emissive) maps, false for data maps (normal, ARM, masks)
	 * @param {boolean} [options.repeat=true]   RepeatWrapping (true) or ClampToEdgeWrapping (false)
	 * @param {number} [options.anisotropy]     defaults to assets.maxAnisotropy for repeating textures, 1 otherwise
	 * @param {boolean} [options.flipY=true]
	 * @returns {Promise<THREE.Texture>}  the same texture object for identical (url, srgb, repeat)
	 */
	texture( url, { srgb = false, repeat = true, anisotropy, flipY = true } = {} ) {

		const key = `tex:${url}|${srgb ? 's' : 'l'}${repeat ? 'r' : 'c'}${flipY ? 'f' : 'n'}`;
		return this._track( key, url, async () => {

			const tex = await this._textureLoader.loadAsync( resolveUrl( url ) );
			tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
			tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
			tex.anisotropy = anisotropy ?? ( repeat ? this.maxAnisotropy : 1 );
			tex.flipY = flipY;
			tex.name = url;
			tex.needsUpdate = true;
			return tex;

		} );

	}

	/**
	 * Loads an equirectangular Radiance .hdr as a float texture with EquirectangularReflectionMapping.
	 * @returns {Promise<THREE.DataTexture>}
	 */
	hdr( url ) {

		return this._track( 'hdr:' + url, url, async () => {

			const tex = await this._hdrLoader.loadAsync( resolveUrl( url ) );
			tex.mapping = THREE.EquirectangularReflectionMapping;
			tex.name = url;
			return tex;

		} );

	}

	/**
	 * Loads a PBR texture set from the textures index by id.
	 * @param {string} id   e.g. 'asphalt_main'
	 * @param {Object} [options]
	 * @param {boolean} [options.height=false]  also load the height map
	 * @returns {Promise<{ id: string, albedo: THREE.Texture, normal: THREE.Texture, arm: THREE.Texture, height: THREE.Texture|null, tileSize: number, meta: Object }>}
	 */
	async pbr( id, { height = false } = {} ) {

		const meta = this.index.textures?.sets?.find( ( s ) => s.id === id );
		if ( ! meta ) throw new Error( `[assets] unknown texture set "${id}"` );
		const [ albedo, normal, arm, heightTex ] = await Promise.all( [
			this.texture( meta.maps.albedo, { srgb: true } ),
			this.texture( meta.maps.normal ),
			this.texture( meta.maps.arm ),
			height && meta.maps.height ? this.texture( meta.maps.height ) : null,
		] );
		return { id, albedo, normal, arm, height: heightTex, tileSize: meta.tileSizeMeters ?? 2, meta };

	}

	/**
	 * Fetches and decodes an audio file.
	 * @param {string} url
	 * @param {BaseAudioContext} audioContext
	 * @returns {Promise<AudioBuffer>}
	 */
	audio( url, audioContext ) {

		return this._track( 'audio:' + url, url, async () => {

			const res = await fetch( resolveUrl( url ) );
			if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
			return audioContext.decodeAudioData( await res.arrayBuffer() );

		} );

	}

	/** Finds an entry of a model index (rocks / trees / plants / props) by asset id. */
	asset( category, id ) {

		return this.index[ category ]?.assets?.find( ( a ) => a.id === id ) ?? null;

	}

}
