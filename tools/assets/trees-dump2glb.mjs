#!/usr/bin/env node
// Convert dumped Blender objects into a quick preview GLB (un-optimised) for the dev viewer.
//   node tools/assets/trees-dump2glb.mjs <id> <out.glb> <object> [<object> ...] [--spread 1.5] [--tex 1024]
// Objects are laid out along +X (spread = gap factor). Textures of the source set are attached per material
// (diffuse + separate alpha map merged to RGBA, normal, arm) so the result looks like the source asset.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { loadDump, SRC } from './trees-lib.mjs';

const args = process.argv.slice( 2 );
const opt = ( k, d ) => {

	const i = args.indexOf( '--' + k );
	if ( i < 0 ) return d;
	const v = args[ i + 1 ];
	args.splice( i, 2 );
	return v;

};

const spread = Number( opt( 'spread', 1.3 ) );
const texSize = Number( opt( 'tex', 1024 ) );
const [ id, outFile, ...objects ] = args;

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene( 'Scene' );
const matCache = new Map();

function findTex( matName, kind ) {

	// material "fir_tree_01_twig" -> textures/fir_tree_01_twig_<kind>_2k.jpg ; alpha lives in extra/*_alpha_2k.png
	const dirs = [ join( SRC, id, 'textures' ), join( SRC, id, 'extra' ) ];
	const stems = [ matName ];
	// material aliases used by the Poly Haven tree files
	if ( /dead_branches$|branches_dead$/.test( matName ) ) stems.push( matName.replace( /dead_branches$/, 'bark' ).replace( /branches_dead$/, 'branches' ) );
	if ( /trunk_c$/.test( matName ) ) stems.push( matName );
	for ( const stem of stems ) for ( const dir of dirs ) {

		if ( ! existsSync( dir ) ) continue;
		for ( const f of readdirSync( dir ) ) if ( f.startsWith( stem + '_' + kind + '_2k' ) ) return join( dir, f );

	}

	return null;

}

async function material( name ) {

	if ( matCache.has( name ) ) return matCache.get( name );
	const mat = doc.createMaterial( name ).setRoughnessFactor( 1 ).setMetallicFactor( 0 ).setDoubleSided( true );
	const diff = name && findTex( name, 'diff' );
	if ( diff ) {

		const alpha = findTex( name, 'alpha' );
		// (sharp applies its operations in a fixed internal order, so build RGBA from explicit raw buffers)
		const rgb = await sharp( diff ).resize( texSize, texSize ).removeAlpha().raw().toBuffer();
		let img = sharp( rgb, { raw: { width: texSize, height: texSize, channels: 3 } } );
		if ( alpha ) {

			const a = await sharp( alpha ).resize( texSize, texSize ).greyscale().raw().toBuffer();
			const rgba = Buffer.alloc( texSize * texSize * 4 );
			for ( let i = 0; i < texSize * texSize; i ++ ) {

				rgba[ i * 4 ] = rgb[ i * 3 ];
				rgba[ i * 4 + 1 ] = rgb[ i * 3 + 1 ];
				rgba[ i * 4 + 2 ] = rgb[ i * 3 + 2 ];
				rgba[ i * 4 + 3 ] = a[ i ];

			}

			img = sharp( rgba, { raw: { width: texSize, height: texSize, channels: 4 } } );
			mat.setAlphaMode( 'MASK' ).setAlphaCutoff( 0.4 );

		}

		const tex = doc.createTexture( name + '_base' ).setMimeType( 'image/png' ).setImage( await img.png().toBuffer() );
		mat.setBaseColorTexture( tex );
		const nor = findTex( name, 'nor_gl' );
		if ( nor ) mat.setNormalTexture( doc.createTexture( name + '_nor' ).setMimeType( 'image/jpeg' ).setImage( await sharp( nor ).resize( texSize, texSize ).jpeg( { quality: 90 } ).toBuffer() ) );
		const arm = findTex( name, 'arm' );
		if ( arm ) {

			const t = doc.createTexture( name + '_arm' ).setMimeType( 'image/jpeg' ).setImage( await sharp( arm ).resize( texSize, texSize ).jpeg( { quality: 90 } ).toBuffer() );
			mat.setMetallicRoughnessTexture( t ).setOcclusionTexture( t );

		}

	} else {

		mat.setBaseColorFactor( [ 0.5, 0.5, 0.5, 1 ] );

	}

	matCache.set( name, mat );
	return mat;

}

let cursor = 0;
for ( const objName of objects ) {

	const d = loadDump( id, objName );
	const min = [ 1e9, 1e9, 1e9 ], max = [ - 1e9, - 1e9, - 1e9 ];
	for ( let i = 0; i < d.nv; i ++ ) for ( let k = 0; k < 3; k ++ ) {

		min[ k ] = Math.min( min[ k ], d.position[ i * 3 + k ] );
		max[ k ] = Math.max( max[ k ], d.position[ i * 3 + k ] );

	}

	const mesh = doc.createMesh( objName );
	const nMat = Math.max( 1, d.meta.materials.length );
	for ( let m = 0; m < nMat; m ++ ) {

		const pos = [], nor = [], uv = [];
		for ( let p = 0; p < d.np; p ++ ) {

			if ( d.polyMat[ p ] !== m ) continue;
			const s = d.polyStart[ p ], n = d.polyCount[ p ];
			for ( let k = 1; k < n - 1; k ++ ) for ( const c of [ s, s + k, s + k + 1 ] ) {

				const v = d.cornerVert[ c ];
				pos.push( d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] );
				nor.push( d.normal[ c * 3 ], d.normal[ c * 3 + 1 ], d.normal[ c * 3 + 2 ] );
				if ( d.uv ) uv.push( d.uv[ c * 2 ], 1 - d.uv[ c * 2 + 1 ] );

			}

		}

		if ( pos.length === 0 ) continue;
		const prim = doc.createPrimitive()
			.setAttribute( 'POSITION', doc.createAccessor().setType( 'VEC3' ).setArray( new Float32Array( pos ) ).setBuffer( buffer ) )
			.setAttribute( 'NORMAL', doc.createAccessor().setType( 'VEC3' ).setArray( new Float32Array( nor ) ).setBuffer( buffer ) )
			.setMaterial( await material( d.meta.materials[ m ] || 'none' ) );
		if ( d.uv ) prim.setAttribute( 'TEXCOORD_0', doc.createAccessor().setType( 'VEC2' ).setArray( new Float32Array( uv ) ).setBuffer( buffer ) );
		mesh.addPrimitive( prim );

	}

	const node = doc.createNode( objName ).setMesh( mesh ).setTranslation( [ cursor - min[ 0 ], 0, 0 ] );
	scene.addChild( node );
	cursor += ( max[ 0 ] - min[ 0 ] ) * spread + 0.02;
	console.log( `${objName}: bbox [${min.map( ( x ) => x.toFixed( 3 ) )}] .. [${max.map( ( x ) => x.toFixed( 3 ) )}] tris=${d.meta.triangles}` );

}

mkdirSync( dirname( outFile ), { recursive: true } );
await new NodeIO().write( outFile, doc );
console.log( 'wrote', outFile );
