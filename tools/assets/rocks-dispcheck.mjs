#!/usr/bin/env node
// Correlate height-map gradients with normal-map channels inside the UV mask (to validate rebuilding a broken channel).
//   node tools/assets/rocks-dispcheck.mjs <gltf> <normal> <displacement>
import sharp from 'sharp';
import { makeIO, extractNodeGeometry, rasterizeUvMask } from './rocks-lib.mjs';
const io = await makeIO();
const [ gltf, norFile, dispFile ] = process.argv.slice( 2 );
const doc = await io.read( gltf );
const geos = doc.getRoot().listNodes().filter( ( n ) => n.getMesh() ).map( ( n ) => extractNodeGeometry( n ) );
const SIZE = 4096;
const mask0 = rasterizeUvMask( geos, SIZE, SIZE );
// erode the mask by 6px so island borders do not pollute the statistics
const mask = new Uint8Array( SIZE * SIZE );
const R = 6;
const tmp = new Uint8Array( SIZE * SIZE );
for ( let y = 0; y < SIZE; y ++ ) for ( let x = R; x < SIZE - R; x ++ ) { let a = 1; for ( let d = - R; d <= R; d ++ ) if ( ! mask0[ y * SIZE + x + d ] ) { a = 0; break; } tmp[ y * SIZE + x ] = a; }
for ( let y = R; y < SIZE - R; y ++ ) for ( let x = 0; x < SIZE; x ++ ) { let a = 1; for ( let d = - R; d <= R; d ++ ) if ( ! tmp[ ( y + d ) * SIZE + x ] ) { a = 0; break; } mask[ y * SIZE + x ] = a; }

for ( const sigma of [ 0.8, 1.5, 3, 6 ] ) {

	const nor = ( await sharp( norFile ).blur( sigma ).removeAlpha().toColourspace( 'srgb' ).raw().toBuffer( { resolveWithObject: true } ) ).data;
	const h = ( await sharp( dispFile ).blur( sigma ).extractChannel( 0 ).raw().toBuffer( { resolveWithObject: true } ) ).data;
	const acc = { xu: [ 0, 0, 0, 0, 0 ], yv: [ 0, 0, 0, 0, 0 ], xv: [ 0, 0, 0, 0, 0 ], yu: [ 0, 0, 0, 0, 0 ] };
	let n = 0;
	for ( let y = 1; y < SIZE - 1; y += 2 ) for ( let x = 1; x < SIZE - 1; x += 2 ) {

		const i = y * SIZE + x;
		if ( ! mask[ i ] ) continue;
		const hu = ( h[ i + 1 ] - h[ i - 1 ] ) * 0.5, hv = ( h[ i + SIZE ] - h[ i - SIZE ] ) * 0.5; // d/dcolumn, d/drow
		const nx = nor[ i * 3 ] - 127.5, ny = nor[ i * 3 + 1 ] - 127.5;
		n ++;
		for ( const [ key, a, b ] of [ [ 'xu', nx, hu ], [ 'yv', ny, hv ], [ 'xv', nx, hv ], [ 'yu', ny, hu ] ] ) { const A = acc[ key ]; A[ 0 ] += a; A[ 1 ] += b; A[ 2 ] += a * a; A[ 3 ] += b * b; A[ 4 ] += a * b; }

	}

	const fmt = ( A ) => { const cov = A[ 4 ] / n - A[ 0 ] / n * A[ 1 ] / n, va = A[ 2 ] / n - ( A[ 0 ] / n ) ** 2, vb = A[ 3 ] / n - ( A[ 1 ] / n ) ** 2; return `r=${( cov / Math.sqrt( va * vb ) ).toFixed( 3 )} gain(n per h)=${( cov / vb ).toFixed( 2 )} sd_n=${Math.sqrt( va ).toFixed( 1 )} sd_h=${Math.sqrt( vb ).toFixed( 2 )}`; };
	console.log( `sigma ${sigma}: R~dh/du ${fmt( acc.xu )} | G~dh/dv ${fmt( acc.yv )} | R~dh/dv ${fmt( acc.xv )} | G~dh/du ${fmt( acc.yu )}` );

}
