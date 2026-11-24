#!/usr/bin/env node
// Rigorous check that a texture belongs to the mesh UV layout: a matching texture is continuous ACROSS UV SEAMS in 3D,
// i.e. the texel values on both UV sides of every seam edge correlate strongly. A texture baked for another layout gives ~0.
//   node tools/assets/rocks-seamcheck.mjs <gltf> <texture> [<gltf> <texture> ...]
import sharp from 'sharp';
import { makeIO, extractNodeGeometry } from './rocks-lib.mjs';
const io = await makeIO();
const args = process.argv.slice( 2 );
const SIZE = 1024;
const cache = new Map();

function seamSamples( geos ) {

	const samples = []; // [u0, v0, u1, v1]
	for ( const { position, uv, index } of geos ) {

		const n = position.length / 3;
		const posMap = new Map(), posId = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) {

			const k = position[ i * 3 ] + ',' + position[ i * 3 + 1 ] + ',' + position[ i * 3 + 2 ];
			let id = posMap.get( k ); if ( id === undefined ) { id = posMap.size; posMap.set( k, id ); } posId[ i ] = id;

		}

		const edges = new Map();
		for ( let t = 0; t < index.length; t += 3 ) for ( let e = 0; e < 3; e ++ ) {

			const a = index[ t + e ], b = index[ t + ( e + 1 ) % 3 ], c = index[ t + ( e + 2 ) % 3 ];
			const pa = posId[ a ], pb = posId[ b ];
			if ( pa === pb ) continue;
			const key = pa < pb ? pa * 4294967296 + pb : pb * 4294967296 + pa;
			let list = edges.get( key ); if ( ! list ) { list = []; edges.set( key, list ); }
			list.push( pa < pb ? [ a, b, c ] : [ b, a, c ] );

		}

		for ( const list of edges.values() ) {

			if ( list.length !== 2 ) continue;
			const [ a0, b0, c0 ] = list[ 0 ], [ a1, b1, c1 ] = list[ 1 ];
			const same = uv[ a0 * 2 ] === uv[ a1 * 2 ] && uv[ a0 * 2 + 1 ] === uv[ a1 * 2 + 1 ] && uv[ b0 * 2 ] === uv[ b1 * 2 ] && uv[ b0 * 2 + 1 ] === uv[ b1 * 2 + 1 ];
			if ( same ) continue;
			const w = 0.2; // move 20% towards the opposite vertex (inside the triangle)
			const s = ( a, b, c ) => [ ( uv[ a * 2 ] + uv[ b * 2 ] ) * 0.5 * ( 1 - w ) + uv[ c * 2 ] * w, ( uv[ a * 2 + 1 ] + uv[ b * 2 + 1 ] ) * 0.5 * ( 1 - w ) + uv[ c * 2 + 1 ] * w ];
			samples.push( [ ...s( a0, b0, c0 ), ...s( a1, b1, c1 ) ] );

		}

	}

	return samples;

}

for ( let k = 0; k < args.length; k += 2 ) {

	let samples = cache.get( args[ k ] );
	if ( ! samples ) {

		const doc = await io.read( args[ k ] );
		samples = seamSamples( doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) ) );
		cache.set( args[ k ], samples );

	}

	const { data, info } = await sharp( args[ k + 1 ] ).resize( SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' } ).blur( 1.2 ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } );
	const ch = info.channels;
	const at = ( u, v, c ) => data[ ( Math.min( SIZE - 1, Math.max( 0, Math.floor( v * SIZE ) ) ) * SIZE + Math.min( SIZE - 1, Math.max( 0, Math.floor( u * SIZE ) ) ) ) * ch + c ];
	const res = [];
	for ( let c = 0; c < ch; c ++ ) {

		let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
		const n = samples.length;
		for ( const [ u0, v0, u1, v1 ] of samples ) {

			const x = at( u0, v0, c ), y = at( u1, v1, c );
			sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;

		}

		const cov = sxy / n - sx / n * sy / n, vx = sxx / n - ( sx / n ) ** 2, vy = syy / n - ( sy / n ) ** 2;
		res.push( `${'RGB'[ c ]} r=${( cov / Math.sqrt( Math.max( vx * vy, 1e-9 ) ) ).toFixed( 2 )} (sd ${Math.sqrt( vx ).toFixed( 0 )})` );

	}

	console.log( args[ k + 1 ].split( '/' ).pop().padEnd( 42 ), `seamEdges ${String( samples.length ).padStart( 6 )}`, res.join( ' | ' ) );

}
