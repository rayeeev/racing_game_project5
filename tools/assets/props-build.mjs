#!/usr/bin/env node
// Builds the game-ready prop GLBs + index.json from the raw Poly Haven glTF packages in assets-src/props/.
//
//   node tools/assets/props-build.mjs [--only id1,id2] [--no-index] [--verbose]
//   node tools/assets/props-build.mjs --config ./props-config-exp.mjs --out assets-src/props/_exp --url-prefix /assets-src/props/_exp   (experiments)
//
// Output: public/assets/props/<id>.glb  (variants as "<variant>_LOD0/1" root nodes, identity transforms, pivot bottom-centre)
//         public/assets/props/index.json
// The asset definitions live in tools/assets/props-config.mjs (run from the project root so node_modules resolves).
//
// Per asset:
//   1. geometry: gather source nodes per variant, bake world transforms, merge per material, move the pivot, weld,
//      simplify to the LOD budgets (meshoptimizer, attribute aware)
//   2. textures: decode at native resolution, optional paint hooks, fill the atlas background from the UV islands
//      (push-pull) so mips stay clean, drop empty AO channels, resize, encode (WebP colour/ORM, JPEG 4:4:4 normals)
//   3. write GLB: float32 positions (identity node transforms are a hard convention), int16 normals, uint16 UVs where they
//      fit 0..1 (KHR_mesh_quantization), EXT_meshopt_compression, EXT_texture_webp
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
	mat4, transformMesh, mergeByMaterial, bounds, triCount, weld, compact, simplify, openEdgeStats, surfaceArea,
	sampleAlbedo, toHex, composeAlpha, encodeWebp, encodeJpeg444,
	rasterizeUvMask, dilateMask, fillUncovered, loadNative, resizeRaw,
} from './props-lib.mjs';

const argv = process.argv.slice( 2 );
const opt = { only: '', verbose: false, 'no-index': false, config: './props-config.mjs', out: '', 'url-prefix': '' };
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( a === '--verbose' ) opt.verbose = true;
	else if ( a === '--no-index' ) opt[ 'no-index' ] = true;
	else if ( a.startsWith( '--' ) ) opt[ a.slice( 2 ) ] = argv[ ++ i ];

}

const { ASSETS, CATEGORY } = await import( opt.config.startsWith( '.' ) ? new URL( opt.config, import.meta.url ).href : pathToFileURL( resolve( opt.config ) ).href );
const ROOT = process.cwd();
const SRC = resolve( ROOT, 'assets-src', CATEGORY );
const OUT = opt.out ? resolve( opt.out ) : resolve( ROOT, 'public/assets', CATEGORY );
const URL_PREFIX = opt[ 'url-prefix' ] || `/assets/${CATEGORY}`;
mkdirSync( OUT, { recursive: true } );

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( { 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder } );

const r3 = ( v ) => Math.round( v * 1000 ) / 1000;
const log = ( ...a ) => console.log( ...a );
const short = ( asset, name ) => name.replace( asset.id + '_', '' ).replace( asset.id, 'main' );

// ------------------------------------------------------------------------------------------------ source extraction

function extractPrimitive( prim ) {

	if ( prim.getMode() !== 4 ) throw new Error( 'non-triangle primitive' );
	const pos = prim.getAttribute( 'POSITION' ), nrm = prim.getAttribute( 'NORMAL' ), uv = prim.getAttribute( 'TEXCOORD_0' );
	const n = pos.getCount();
	const toF32 = ( acc, size ) => {

		const out = new Float32Array( n * size );
		if ( ! acc ) return out;
		const el = [];
		for ( let i = 0; i < n; i ++ ) { acc.getElement( i, el ); for ( let k = 0; k < size; k ++ ) out[ i * size + k ] = el[ k ]; }
		return out;

	};

	const idxAcc = prim.getIndices();
	let idx;
	if ( idxAcc ) idx = new Uint32Array( idxAcc.getArray() );
	else { idx = new Uint32Array( n ); for ( let i = 0; i < n; i ++ ) idx[ i ] = i; }
	return { material: prim.getMaterial()?.getName() || 'default', pos: toF32( pos, 3 ), nrm: toF32( nrm, 3 ), uv: toF32( uv, 2 ), idx };

}

/** Reads KHR_texture_transform of the base colour slot (if any) and returns a function (u,v)->[u,v], else null. */
function uvTransformOf( material ) {

	const info = material.getBaseColorTextureInfo();
	const t = info?.getExtension( 'KHR_texture_transform' );
	if ( ! t ) return null;
	const [ ox, oy ] = t.getOffset(), [ sx, sy ] = t.getScale(), rot = t.getRotation();
	const c = Math.cos( rot ), s = Math.sin( rot );
	return ( u, v ) => {

		const x = u * sx, y = v * sy;
		return [ ox + c * x + s * y, oy - s * x + c * y ];

	};

}

/** Collects the geometry of one variant LOD: meshes merged per output material, in kit coordinates. */
function gather( srcDoc, asset, variant, lod, onSourcePrim ) {

	const nodes = srcDoc.getRoot().listNodes();
	const out = [];
	for ( const part of variant.parts ) {

		const test = part.node instanceof RegExp ? ( name ) => part.node.test( name ) : ( name ) => name === part.node;
		const matched = nodes.filter( ( n ) => n.getMesh() && test( n.getName() ) );
		if ( matched.length === 0 ) throw new Error( `${asset.id}/${variant.name}: no node matches ${part.node}` );
		for ( const node of matched ) {

			const name = node.getName();
			if ( lod.exclude && lod.exclude.some( ( re ) => re.test( name ) ) ) continue;
			if ( part.exclude && part.exclude.some( ( re ) => re.test( name ) ) ) continue;
			let m = part.matrix || node.getWorldMatrix();
			if ( part.post ) m = mat4.multiply( part.post, m );
			if ( variant.xform ) m = mat4.multiply( variant.xform, m );
			for ( const prim of node.getMesh().listPrimitives() ) {

				const srcMat = prim.getMaterial();
				const srcName = srcMat?.getName() || 'default';
				if ( ( asset.dropMaterials || [] ).includes( srcName ) ) continue;
				if ( ( part.dropMaterials || [] ).includes( srcName ) ) continue;
				let mesh = extractPrimitive( prim );
				const tf = srcMat ? uvTransformOf( srcMat ) : null;
				if ( tf ) for ( let i = 0; i < mesh.uv.length; i += 2 ) { const [ u, v ] = tf( mesh.uv[ i ], mesh.uv[ i + 1 ] ); mesh.uv[ i ] = u; mesh.uv[ i + 1 ] = v; }
				if ( onSourcePrim ) onSourcePrim( srcName, mesh );
				mesh = transformMesh( mesh, m );
				mesh.material = ( asset.materialAlias || {} )[ srcName ] || srcName;
				out.push( mesh );

			}

		}

	}

	return mergeByMaterial( out );

}

// ------------------------------------------------------------------------------------------------ textures / materials

async function buildMaterial( ctx, name ) {

	const { outDoc, srcDoc, asset, srcMasks, textureCache } = ctx;
	const def = ( asset.materials || {} )[ name ] || {};
	const srcName = def.from || name;
	const src = srcDoc.getRoot().listMaterials().find( ( m ) => m.getName() === srcName );
	if ( ! src ) throw new Error( `${asset.id}: source material ${srcName} not found` );
	const size = def.size || asset.textureResolution || 1024;
	const mat = outDoc.createMaterial( name );
	const info = { name, size, textures: [], image: null, factor: [ 1, 1, 1 ], alphaCutoff: 0, ao: false, doubleSided: def.doubleSided ?? false, alphaMode: 'OPAQUE' };

	const baseFactor = def.baseColorFactor || src.getBaseColorFactor();
	mat.setBaseColorFactor( baseFactor );
	info.factor = baseFactor.slice( 0, 3 );
	mat.setMetallicFactor( def.metallicFactor ?? src.getMetallicFactor() );
	mat.setRoughnessFactor( def.roughnessFactor ?? src.getRoughnessFactor() );
	mat.setEmissiveFactor( def.emissiveFactor || [ 0, 0, 0 ] );
	mat.setDoubleSided( info.doubleSided );
	if ( def.alphaMode === 'MASK' ) {

		mat.setAlphaMode( 'MASK' ); mat.setAlphaCutoff( def.alphaCutoff ?? 0.5 );
		info.alphaCutoff = def.alphaCutoff ?? 0.5; info.alphaMode = 'MASK';

	} else mat.setAlphaMode( 'OPAQUE' );

	if ( def.noTextures ) return { mat, info };

	// every source material that samples the same image contributes to the island mask of that image
	const maskFor = ( uri, res ) => {

		let mask = null;
		for ( const m of srcDoc.getRoot().listMaterials() ) {

			const uris = [ m.getBaseColorTexture(), m.getNormalTexture(), m.getMetallicRoughnessTexture() ].map( ( t ) => t?.getURI() );
			if ( ! uris.includes( uri ) || ! srcMasks.has( m.getName() ) ) continue;
			const sm = srcMasks.get( m.getName() );
			if ( ! mask ) mask = new Uint8Array( sm ); else for ( let i = 0; i < mask.length; i ++ ) mask[ i ] |= sm[ i ];

		}

		if ( ! mask ) return null;
		const mres = Math.round( Math.sqrt( mask.length ) );
		if ( mres === res ) return mask;
		const out = new Uint8Array( res * res ); // nearest resample (only needed when maps differ in resolution)
		for ( let y = 0; y < res; y ++ ) for ( let x = 0; x < res; x ++ ) out[ y * res + x ] = mask[ Math.floor( y * mres / res ) * mres + Math.floor( x * mres / res ) ];
		return out;

	};

	const make = async ( slot, srcTex, kind ) => {

		if ( ! srcTex ) return null;
		const uri = srcTex.getURI() || srcTex.getName();
		const key = [ asset.id, uri, size, kind, def.alphaMap || '', def.fill === false ? 'nofill' : 'fill' ].join( '|' );
		if ( textureCache.has( key ) ) return textureCache.get( key );
		const native = await loadNative( Buffer.from( srcTex.getImage() ) );
		if ( native.width !== native.height ) throw new Error( `${asset.id}: non-square texture ${uri}` );
		const res = native.width;
		const entry = { tex: null, raw: null, bytes: 0, ao: true };

		// optional paint hook (asset.paint[sourceMaterial][kind]) working on the native-resolution pixels
		const hook = ( asset.paint || {} )[ srcName ]?.[ kind ];
		if ( hook ) {

			await hook( {
				data: native.data, size: res, masks: srcMasks,
				loadGrey: async ( rel ) => ( await sharp( join( SRC, asset.id, rel ) ).resize( res, res, { fit: 'fill' } ).toColourspace( 'b-w' ).extractChannel( 0 ).raw().toBuffer() ),
			} );

		}

		const mask = def.fill === false ? null : maskFor( uri, res );
		if ( mask ) {

			if ( kind === 'orm' ) {

				// Poly Haven "arm" maps of assets without an AO bake have an empty (black) R channel: treat as "no AO"
				let sum = 0, n = 0;
				for ( let i = 0; i < mask.length; i ++ ) if ( mask[ i ] ) { sum += native.data[ i * 3 ]; n ++; }
				if ( n > 0 && sum / n < 8 ) { entry.ao = false; for ( let i = 0; i < res * res; i ++ ) native.data[ i * 3 ] = 255; }

			}

			fillUncovered( native.data, dilateMask( mask, res, 2 ), res, 3 );

		}

		const img = await resizeRaw( native, size );
		let buf, mime;
		if ( kind === 'base' ) {

			if ( def.alphaMap ) {

				const alpha = await sharp( join( SRC, asset.id, def.alphaMap ) ).resize( size, size, { kernel: 'lanczos3', fit: 'fill' } ).toColourspace( 'b-w' ).extractChannel( 0 ).raw().toBuffer();
				const rgba = await composeAlpha( img.data, alpha, size, size );
				entry.raw = { data: rgba, width: size, height: size, channels: 4 };
				buf = await encodeWebp( rgba, size, size, 4, def.quality || 90 );

			} else {

				entry.raw = img;
				buf = await encodeWebp( img.data, size, size, 3, def.quality || 90 );

			}

			mime = 'image/webp';

		} else if ( kind === 'normal' ) {

			buf = await encodeJpeg444( img.data, size, size, 90 );
			mime = 'image/jpeg';

		} else {

			buf = await encodeWebp( img.data, size, size, 3, 90 );
			mime = 'image/webp';

		}

		entry.tex = outDoc.createTexture( `${srcName}_${slot}` ).setImage( new Uint8Array( buf ) ).setMimeType( mime );
		entry.bytes = buf.length;
		textureCache.set( key, entry );
		return entry;

	};

	const base = await make( 'baseColor', src.getBaseColorTexture(), 'base' );
	const normal = await make( 'normal', src.getNormalTexture(), 'normal' );
	const orm = await make( 'orm', src.getMetallicRoughnessTexture(), 'orm' );
	const setInfo = ( ti ) => ti && ti.setMagFilter( 9729 ).setMinFilter( 9987 ).setWrapS( 10497 ).setWrapT( 10497 ).setTexCoord( 0 );
	if ( base ) {

		mat.setBaseColorTexture( base.tex ); setInfo( mat.getBaseColorTextureInfo() );
		info.image = base.raw; info.textures.push( [ 'baseColor', base.bytes ] );
		if ( def.emissiveFromBase ) { mat.setEmissiveTexture( base.tex ); setInfo( mat.getEmissiveTextureInfo() ); }

	}

	if ( normal ) { mat.setNormalTexture( normal.tex ); mat.setNormalScale( def.normalScale ?? src.getNormalScale() ); setInfo( mat.getNormalTextureInfo() ); info.textures.push( [ 'normal', normal.bytes ] ); }
	if ( orm ) {

		mat.setMetallicRoughnessTexture( orm.tex ); setInfo( mat.getMetallicRoughnessTextureInfo() );
		if ( orm.ao && def.occlusion !== false ) {

			mat.setOcclusionTexture( orm.tex ); mat.setOcclusionStrength( def.occlusionStrength ?? 1 ); setInfo( mat.getOcclusionTextureInfo() );
			info.ao = true;

		}

		info.textures.push( [ 'orm', orm.bytes ] );

	}

	return { mat, info };

}

// ------------------------------------------------------------------------------------------------ output accessors

function addPrimitive( outDoc, buffer, mesh, material ) {

	const n = mesh.pos.length / 3;
	// positions: float32 in metres, snapped to 1/8192 m (0.12 mm) so the meshopt codec compresses them well
	const pos = new Float32Array( n * 3 );
	for ( let i = 0; i < pos.length; i ++ ) pos[ i ] = Math.round( mesh.pos[ i ] * 8192 ) / 8192;
	const nrm = new Int16Array( n * 3 );
	for ( let i = 0; i < n; i ++ ) {

		const x = mesh.nrm[ i * 3 ], y = mesh.nrm[ i * 3 + 1 ], z = mesh.nrm[ i * 3 + 2 ];
		const l = Math.hypot( x, y, z ) || 1;
		nrm[ i * 3 ] = Math.round( x / l * 32767 ); nrm[ i * 3 + 1 ] = Math.round( y / l * 32767 ); nrm[ i * 3 + 2 ] = Math.round( z / l * 32767 );

	}

	let uMin = Infinity, uMax = - Infinity;
	for ( let i = 0; i < mesh.uv.length; i ++ ) { if ( mesh.uv[ i ] < uMin ) uMin = mesh.uv[ i ]; if ( mesh.uv[ i ] > uMax ) uMax = mesh.uv[ i ]; }
	let uvAcc;
	if ( uMin >= - 1e-4 && uMax <= 1 + 1e-4 ) {

		const uv = new Uint16Array( n * 2 );
		for ( let i = 0; i < uv.length; i ++ ) uv[ i ] = Math.round( Math.min( 1, Math.max( 0, mesh.uv[ i ] ) ) * 65535 );
		uvAcc = outDoc.createAccessor().setType( 'VEC2' ).setArray( uv ).setNormalized( true ).setBuffer( buffer );

	} else {

		// tiling UVs (outside 0..1) stay float
		const uv = new Float32Array( n * 2 );
		for ( let i = 0; i < uv.length; i ++ ) uv[ i ] = Math.round( mesh.uv[ i ] * 16384 ) / 16384;
		uvAcc = outDoc.createAccessor().setType( 'VEC2' ).setArray( uv ).setBuffer( buffer );

	}

	const idx = n <= 65535 ? new Uint16Array( mesh.idx ) : new Uint32Array( mesh.idx );
	return outDoc.createPrimitive()
		.setAttribute( 'POSITION', outDoc.createAccessor().setType( 'VEC3' ).setArray( pos ).setBuffer( buffer ) )
		.setAttribute( 'NORMAL', outDoc.createAccessor().setType( 'VEC3' ).setArray( nrm ).setNormalized( true ).setBuffer( buffer ) )
		.setAttribute( 'TEXCOORD_0', uvAcc )
		.setIndices( outDoc.createAccessor().setType( 'SCALAR' ).setArray( idx ).setBuffer( buffer ) )
		.setMaterial( material );

}

// ------------------------------------------------------------------------------------------------ per-asset build

function simplifyVariantLod( asset, meshes, lod, label ) {

	const protect = new Set( lod.protect || [] );
	const total = triCount( meshes );
	const fixed = meshes.filter( ( m ) => protect.has( m.material ) ).reduce( ( s, m ) => s + m.idx.length / 3, 0 );
	const ratio = lod.tris >= total ? 1 : Math.max( 0, ( lod.tris - fixed ) / Math.max( 1, total - fixed ) );
	const out = [];
	const notes = [];
	for ( const mesh of meshes ) {

		const src = mesh.idx.length / 3;
		if ( protect.has( mesh.material ) || ratio >= 1 ) { out.push( compact( mesh ) ); notes.push( `${short( asset, mesh.material )}: ${src} (kept)` ); continue; }
		const weight = ( lod.weights || {} )[ mesh.material ] ?? 1;
		const target = Math.max( 4, Math.round( src * Math.min( 1, ratio * weight ) ) );
		const res = simplify( mesh, target, {
			error: lod.error ?? 0.05, errorAbs: lod.errorAbs ?? null, prune: lod.prune ?? false, permissive: lod.permissive ?? false,
			normalWeight: lod.normalWeight ?? 0.5, uvWeight: lod.uvWeight ?? 0.5, regularize: lod.regularize ?? false,
		} );
		out.push( res.mesh );
		notes.push( `${short( asset, mesh.material )}: ${src} -> ${res.tris} (target ${target}, err ${( res.error * 1000 ).toFixed( 1 )} mm)` );

	}

	if ( opt.verbose ) log( `      ${label}: ${notes.join( ' | ' )}` );
	return out.filter( ( m ) => m.idx.length > 0 );

}

async function buildAsset( asset ) {

	const srcDoc = await io.read( join( SRC, asset.id, asset.src ) );
	log( `\n${asset.id}` );

	// ---- phase 1: geometry (and the UV coverage of every source material at the native texture resolution)
	const MASK_RES = asset.maskResolution || 2048;
	const srcMasks = new Map();
	const onSourcePrim = ( srcName, mesh ) => {

		if ( ! srcMasks.has( srcName ) ) srcMasks.set( srcName, new Uint8Array( MASK_RES * MASK_RES ) );
		rasterizeUvMask( mesh, MASK_RES, srcMasks.get( srcName ) );

	};

	const geo = [];
	for ( const variant of asset.variants ) {

		const lodDefs = variant.lods;
		const g0 = gather( srcDoc, asset, variant, lodDefs[ 0 ], onSourcePrim );
		const b0 = bounds( g0 );
		const pivot = variant.pivot || {};
		const px = pivot.x ?? b0.center[ 0 ], pz = pivot.z ?? b0.center[ 2 ], py = pivot.y ?? b0.min[ 1 ];
		const toPivot = mat4.translation( - px, - py, - pz );
		const lodMeshes = [];
		for ( let li = 0; li < lodDefs.length; li ++ ) {

			const g = li === 0 ? g0 : gather( srcDoc, asset, variant, lodDefs[ li ], null );
			let meshes = g.map( ( m ) => weld( transformMesh( m, toPivot ) ) );
			const srcTris = triCount( meshes );
			meshes = simplifyVariantLod( asset, meshes, lodDefs[ li ], `${variant.name}_LOD${li}` );
			lodMeshes.push( meshes );
			log( `   ${( variant.name + '_LOD' + li ).padEnd( 28 )} ${String( srcTris ).padStart( 6 )} -> ${String( triCount( meshes ) ).padStart( 5 )} tris, ${meshes.length} prim(s) [${meshes.map( ( m ) => short( asset, m.material ) + ':' + m.idx.length / 3 ).join( ', ' )}]` );

		}

		geo.push( { variant, lodMeshes, toPivot, pivot: [ px, py, pz ] } );

	}

	// ---- phase 2 + 3: materials, document
	const outDoc = new Document();
	outDoc.createExtension( EXTMeshoptCompression ).setRequired( true ).setEncoderOptions( { method: EXTMeshoptCompression.EncoderMethod.QUANTIZE } );
	outDoc.createExtension( KHRMeshQuantization ).setRequired( true );
	outDoc.createExtension( EXTTextureWebP ).setRequired( true );
	outDoc.getRoot().getAsset().generator = 'alpenglow props-build (gltf-transform)';
	outDoc.getRoot().getAsset().copyright = `CC0 - ${asset.author} - https://polyhaven.com/a/${asset.id}`;
	const buffer = outDoc.createBuffer();
	const scene = outDoc.createScene( asset.id );
	outDoc.getRoot().setDefaultScene( scene );

	const ctx = { outDoc, srcDoc, asset, srcMasks, textureCache: new Map() };
	const materials = new Map();
	const getMaterial = async ( name ) => {

		if ( ! materials.has( name ) ) materials.set( name, await buildMaterial( ctx, name ) );
		return materials.get( name );

	};

	const variantsOut = [];
	for ( const { variant, lodMeshes, toPivot, pivot } of geo ) {

		const lodsOut = [];
		for ( let li = 0; li < lodMeshes.length; li ++ ) {

			const node = outDoc.createNode( `${variant.name}_LOD${li}` );
			const mesh = outDoc.createMesh( `${variant.name}_LOD${li}` );
			for ( const m of lodMeshes[ li ] ) mesh.addPrimitive( addPrimitive( outDoc, buffer, m, ( await getMaterial( m.material ) ).mat ) );
			node.setMesh( mesh );
			scene.addChild( node );
			lodsOut.push( { node: node.getName(), triangles: triCount( lodMeshes[ li ] ) } );

		}

		// ---- measurements on LOD0
		const lod0 = lodMeshes[ 0 ];
		const b = bounds( lod0 );
		let radius = 0;
		for ( const m of lod0 ) for ( let i = 0; i < m.pos.length; i += 3 ) radius = Math.max( radius, Math.hypot( m.pos[ i ], m.pos[ i + 2 ] ) );
		const sum = [ 0, 0, 0 ]; let weight = 0;
		for ( const m of lod0 ) {

			const { info } = await getMaterial( m.material );
			if ( info.image ) {

				const s = sampleAlbedo( m, info.image, { factor: info.factor, cutoff: info.alphaCutoff } );
				for ( let k = 0; k < 3; k ++ ) sum[ k ] += s.sum[ k ];
				weight += s.weight;

			} else {

				const w = surfaceArea( m ) * 4000;
				for ( let k = 0; k < 3; k ++ ) sum[ k ] += info.factor[ k ] * w; // factors are linear
				weight += w;

			}

		}

		const avgColor = toHex( sum.map( ( v ) => v / Math.max( 1, weight ) ) );
		if ( opt.verbose ) log( `      ${variant.name}: ${lod0.map( ( m ) => `${short( asset, m.material )} open-edges ${( openEdgeStats( m ).openRatio * 100 ).toFixed( 1 )}%` ).join( ', ' )}` );

		// ---- collider
		let collider = variant.collider || 'box';
		if ( collider === 'box' ) collider = { type: 'box', halfExtents: b.size.map( ( v ) => r3( v / 2 ) ), center: b.center.map( r3 ) };
		else if ( collider === 'cylinder' ) collider = { type: 'cylinder', radius: r3( Math.max( b.size[ 0 ], b.size[ 2 ] ) / 2 ), halfHeight: r3( b.size[ 1 ] / 2 ), center: b.center.map( r3 ) };
		else if ( collider === 'none' ) collider = { type: 'none' };

		// ---- anchors etc. given in kit coordinates are moved into the variant frame
		const toLocal = ( p ) => {

			const m = variant.xform ? mat4.multiply( toPivot, variant.xform ) : toPivot;
			return [ r3( m[ 0 ] * p[ 0 ] + m[ 4 ] * p[ 1 ] + m[ 8 ] * p[ 2 ] + m[ 12 ] ), r3( m[ 1 ] * p[ 0 ] + m[ 5 ] * p[ 1 ] + m[ 9 ] * p[ 2 ] + m[ 13 ] ), r3( m[ 2 ] * p[ 0 ] + m[ 6 ] * p[ 1 ] + m[ 10 ] * p[ 2 ] + m[ 14 ] ) ];

		};

		const extra = typeof variant.extra === 'function' ? variant.extra( { toLocal, bounds: b, pivot } ) : ( variant.extra || {} );

		variantsOut.push( {
			name: variant.name,
			size: b.size.map( r3 ),
			radius: r3( radius ),
			lods: lodsOut,
			avgColor,
			collider,
			dynamic: !! variant.dynamic,
			...( variant.mass !== undefined ? { mass: variant.mass } : {} ),
			placement: variant.placement || asset.placement,
			sink: variant.sink ?? 0,
			...extra,
			notes: variant.notes || '',
		} );
		log( `      ${variant.name}: size ${b.size.map( r3 ).join( ' x ' )}  radius ${r3( radius )}  minY ${r3( b.min[ 1 ] )}  avgColor ${avgColor}` );

	}

	const outPath = join( OUT, `${asset.id}.glb` );
	await io.write( outPath, outDoc );
	const bytes = statSync( outPath ).size;
	const matInfo = [ ...materials.values() ].map( ( m ) => m.info );
	const texBytes = [ ...ctx.textureCache.values() ].reduce( ( s, t ) => s + t.bytes, 0 );
	log( `   -> ${outPath}  ${( bytes / 1024 ).toFixed( 0 )} KB (textures ${( texBytes / 1024 ).toFixed( 0 )} KB; ${matInfo.map( ( i ) => `${short( asset, i.name )}@${i.textures.length ? i.size : 'none'}${i.ao ? '' : ' noAO'}` ).join( ', ' )})` );

	return {
		id: asset.id,
		file: `${URL_PREFIX}/${asset.id}.glb`,
		source: `https://polyhaven.com/a/${asset.id}`,
		author: asset.author,
		license: 'CC0',
		textureResolution: Math.max( 0, ...matInfo.filter( ( i ) => i.textures.length ).map( ( i ) => i.size ) ),
		bytes,
		materials: matInfo.map( ( i ) => ( {
			name: i.name, textureSize: i.textures.length ? i.size : 0, doubleSided: i.doubleSided, ao: i.ao,
			...( i.alphaMode === 'MASK' ? { alphaMode: 'MASK', alphaCutoff: i.alphaCutoff } : {} ),
			...( ( asset.materials || {} )[ i.name ]?.meta || {} ),
		} ) ),
		...( asset.extra || {} ),
		variants: variantsOut,
	};

}

// ------------------------------------------------------------------------------------------------ main

const only = opt.only ? new Set( opt.only.split( ',' ) ) : null;
const built = new Map();
for ( const asset of ASSETS ) {

	if ( only && ! only.has( asset.id ) ) continue;
	built.set( asset.id, await buildAsset( asset ) );

}

if ( ! opt[ 'no-index' ] ) {

	// partial rebuilds (--only) keep the entries of the other assets from the existing index.json
	const indexPath = join( OUT, 'index.json' );
	const previous = new Map();
	if ( existsSync( indexPath ) ) for ( const a of JSON.parse( readFileSync( indexPath, 'utf8' ) ).assets ) previous.set( a.id, a );
	const assets = [];
	for ( const asset of ASSETS ) {

		const entry = built.get( asset.id ) || previous.get( asset.id );
		if ( ! entry || ! existsSync( join( OUT, `${asset.id}.glb` ) ) ) { log( `index: skipping ${asset.id} (not built)` ); continue; }
		assets.push( entry );

	}

	writeFileSync( indexPath, JSON.stringify( { category: CATEGORY, assets }, null, '\t' ) + '\n' );
	log( `\nindex.json: ${assets.length} assets, ${( assets.reduce( ( s, a ) => s + a.bytes, 0 ) / 1e6 ).toFixed( 2 )} MB` );

}
