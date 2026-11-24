// Bark atlas + trunk construction for the conifers.
//
// Atlas layout (2048 x 2048, glTF uv origin top-left):
//   (0,0)       1024^2   photo-scanned trunk base "a"   } the scans are re-baked: where the source material blends
//   (1024,0)    1024^2   photo-scanned trunk base "b"   } from scan to tiling bark (vertex colour mask "Col" in the
//   (0,1024)    1024^2   photo-scanned trunk base "c"   } .blend) the tiling bark is written into the scan texture
//   (1032,1032) 384x768  tiling bark for trunks (1 circumference x 2 circumferences), wrapped gutter
//   (1424,1032) 256x512  branch bark (bark stretched along the branch like the source material does)
//   (1688,1032) 352x472  bark region used by the dead-branch meshes (their original unwrap)
//
// The source trunk material is a Mix Shader:  mix( scan(uv), bark(triplanar object coords), Col ).  A single-UV glTF
// material cannot do that, so the upper trunk is rebuilt as a tube with cylindrical UVs into the tiling bark region
// (UV seams every period -> all UVs stay inside 0..1), and exactly the same cylindrical bark is baked into the scan
// texture where Col > 0, which makes the junction seamless.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadDump, SRC, v3, DSU, srgbToLinear, linearToSrgb } from './trees-lib.mjs';
import { MeshBuilder, emitTube, simplifyMesh, compactMesh, ringsFromTube } from './trees-geom.mjs';
import { loadImage, newImage, crop, resize, blit, sampleBilinear, dilate } from './trees-img.mjs';
import { rasterTriangle } from './trees-raster.mjs';

const A = 2048;
const REG = {
	scan: { a: { x: 0, y: 0, w: 1024, h: 1024 }, b: { x: 1024, y: 0, w: 1024, h: 1024 }, c: { x: 0, y: 1024, w: 1024, h: 1024 } },
	tile: { x: 1032, y: 1032, w: 384, h: 768 },
	branch: { x: 1424, y: 1032, w: 256, h: 512 },
	dead: { x: 1688, y: 1032, w: 352, h: 472 },
};
const DEAD_SRC = { u0: 0.15, u1: 0.6, v0: 0.2, v1: 0.8 }; // Blender uv window of the bark texture used by dead branches
const BRANCH_BAND = 0.2; // Blender v' window [0, 0.2] of the bark texture (v' = 0.1 * branch v)
const PURE_BARK = 0.999; // mask value from which a trunk polygon counts as pure tiling bark
export const TRUNK_PERIOD = 1.25; // metres of trunk height per bark tile repeat (source: 1 / 0.7 = 1.43 m)

function texPath( sp, name, kind ) {

	const maps = sp.barkMaps( name );
	let p = join( SRC, sp.barkSrc, maps[ kind ] );
	if ( ! existsSync( p ) ) p = p.replace( '/textures/', '/extra/' );
	return p;

}

// trunk centre line (x, z) and radius as functions of y, from 0.1 m vertex slices. Robust against the scanned twig
// stubs that stick out of the trunk (median centre / median radius, then a trimmed mean).
function trunkProfile( d ) {

	const bins = new Map();
	for ( let v = 0; v < d.nv; v ++ ) {

		const b = Math.round( d.position[ v * 3 + 1 ] / 0.1 );
		let e = bins.get( b );
		if ( ! e ) bins.set( b, e = [] );
		e.push( v );

	}

	const median = ( a ) => {

		const s = Float64Array.from( a ).sort();
		return s[ s.length >> 1 ];

	};

	const keys = [ ...bins.keys() ].sort( ( a, b ) => a - b ).filter( ( k ) => k * 0.1 >= 0.95 );
	const pts = keys.map( ( k ) => {

		const ids = bins.get( k );
		let cx = median( ids.map( ( v ) => d.position[ v * 3 ] ) ), cz = median( ids.map( ( v ) => d.position[ v * 3 + 2 ] ) );
		let r = median( ids.map( ( v ) => Math.hypot( d.position[ v * 3 ] - cx, d.position[ v * 3 + 2 ] - cz ) ) );
		for ( let it = 0; it < 3; it ++ ) {

			let sx = 0, sz = 0, n = 0;
			for ( const v of ids ) {

				const dist = Math.hypot( d.position[ v * 3 ] - cx, d.position[ v * 3 + 2 ] - cz );
				if ( Math.abs( dist - r ) > 0.3 * r ) continue;
				sx += d.position[ v * 3 ];
				sz += d.position[ v * 3 + 2 ];
				n ++;

			}

			if ( n < 6 ) break;
			// the centroid of surface samples is only the centre when they are spread evenly around the trunk; use the
			// mid point of the trimmed bounding circle instead (min/max per axis)
			let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
			for ( const v of ids ) {

				const dist = Math.hypot( d.position[ v * 3 ] - cx, d.position[ v * 3 + 2 ] - cz );
				if ( Math.abs( dist - r ) > 0.3 * r ) continue;
				x0 = Math.min( x0, d.position[ v * 3 ] );
				x1 = Math.max( x1, d.position[ v * 3 ] );
				z0 = Math.min( z0, d.position[ v * 3 + 2 ] );
				z1 = Math.max( z1, d.position[ v * 3 + 2 ] );

			}

			cx = ( x0 + x1 ) / 2;
			cz = ( z0 + z1 ) / 2;
			r = median( ids.map( ( v ) => Math.hypot( d.position[ v * 3 ] - cx, d.position[ v * 3 + 2 ] - cz ) ) );

		}

		return [ k * 0.1, cx, cz, r ];

	} );
	return ( y ) => {

		if ( y <= pts[ 0 ][ 0 ] ) return [ pts[ 0 ][ 1 ], pts[ 0 ][ 2 ], pts[ 0 ][ 3 ] ];
		for ( let i = 1; i < pts.length; i ++ ) if ( y <= pts[ i ][ 0 ] ) {

			const t = ( y - pts[ i - 1 ][ 0 ] ) / ( pts[ i ][ 0 ] - pts[ i - 1 ][ 0 ] );
			return [ 1, 2, 3 ].map( ( q ) => pts[ i - 1 ][ q ] + ( pts[ i ][ q ] - pts[ i - 1 ][ q ] ) * t );

		}

		const l = pts[ pts.length - 1 ];
		return [ l[ 1 ], l[ 2 ], l[ 3 ] ];

	};

}

const axisFunction = trunkProfile;

// cylindrical bark coordinates of a point on the trunk: u in [0,1) (seam towards +X, increasing clockwise seen from
// above so the texture is not mirrored from outside), v = ( height - y0 ) / period
function cylUV( p, axis, y0 = 0 ) {

	const [ cx, cz ] = axis( p[ 1 ] );
	const th = Math.atan2( p[ 2 ] - cz, p[ 0 ] - cx );
	let u = - th / ( 2 * Math.PI );
	u -= Math.floor( u );
	return [ u, ( p[ 1 ] - y0 ) / TRUNK_PERIOD, th ];

}

// Phase of the bark tile along a scanned trunk: chosen so that the zone of dense "pure bark" polygons just below the
// generated tube lies inside one tile period (no UV seam has to be cut through the scanned geometry there).
function trunkPhase( d ) {

	let yPure = Infinity;
	for ( let c = 0; c < d.nc; c ++ ) if ( d.color[ c * 4 ] >= PURE_BARK ) yPure = Math.min( yPure, d.position[ d.cornerVert[ c ] * 3 + 1 ] );
	return yPure - 0.35;

}

export async function buildBarkAtlas( sp, log ) {

	const base = newImage( A, A, 3, [ 90, 80, 70 ] );
	const normal = newImage( A, A, 3, [ 128, 128, 255 ] );
	const orm = newImage( A, A, 3, [ 255, 230, 0 ] );

	// ---- tiling bark source
	const bDiff = await loadImage( texPath( sp, 'bark', 'diff' ), 3 );
	const bNor = await loadImage( texPath( sp, 'bark', 'nor' ), 3 );
	const bArm = await loadImage( texPath( sp, 'bark', 'arm' ), 3 );
	const S = bDiff.w;

	// trunk tile: whole (periodic) bark texture -> 384 x 768
	const tile = { diff: await resize( bDiff, REG.tile.w, REG.tile.h ), nor: await resize( bNor, REG.tile.w, REG.tile.h ), arm: await resize( bArm, REG.tile.w, REG.tile.h ) };
	const G = 8;
	for ( const [ img, src ] of [ [ base, tile.diff ], [ normal, tile.nor ], [ orm, tile.arm ] ] ) {

		for ( let y = - G; y < REG.tile.h + G; y ++ ) for ( let x = - G; x < REG.tile.w + G; x ++ ) {

			const sx = ( ( x % REG.tile.w ) + REG.tile.w ) % REG.tile.w, sy = ( ( y % REG.tile.h ) + REG.tile.h ) % REG.tile.h;
			const o = ( ( REG.tile.y + y ) * A + REG.tile.x + x ) * 3, s = ( sy * REG.tile.w + sx ) * 3;
			img.data[ o ] = src.data[ s ];
			img.data[ o + 1 ] = src.data[ s + 1 ];
			img.data[ o + 2 ] = src.data[ s + 2 ];

		}

	}

	// branch bark: band v' in [0, BRANCH_BAND] (Blender v, i.e. the bottom rows of the image), full width -> 256 x 512,
	// wrapped horizontally, clamped vertically
	{

		const rows = Math.round( BRANCH_BAND * S );
		for ( const [ img, src ] of [ [ base, bDiff ], [ normal, bNor ], [ orm, bArm ] ] ) {

			const band = await resize( crop( src, 0, S - rows, S, rows ), REG.branch.w, REG.branch.h );
			for ( let y = - G; y < REG.branch.h + G; y ++ ) for ( let x = - G; x < REG.branch.w + G; x ++ ) {

				const sx = ( ( x % REG.branch.w ) + REG.branch.w ) % REG.branch.w, sy = Math.min( REG.branch.h - 1, Math.max( 0, y ) );
				const o = ( ( REG.branch.y + y ) * A + REG.branch.x + x ) * 3, s = ( sy * REG.branch.w + sx ) * 3;
				img.data[ o ] = band.data[ s ];
				img.data[ o + 1 ] = band.data[ s + 1 ];
				img.data[ o + 2 ] = band.data[ s + 2 ];

			}

		}

	}

	// dead branches: window of the bark texture (their unwrap), clamped padding
	{

		const x0 = Math.round( DEAD_SRC.u0 * S ), x1 = Math.round( DEAD_SRC.u1 * S ), y0 = Math.round( ( 1 - DEAD_SRC.v1 ) * S ), y1 = Math.round( ( 1 - DEAD_SRC.v0 ) * S );
		for ( const [ img, src ] of [ [ base, bDiff ], [ normal, bNor ], [ orm, bArm ] ] ) {

			const win = await resize( crop( src, x0, y0, x1 - x0, y1 - y0 ), REG.dead.w, REG.dead.h );
			for ( let y = - G; y < REG.dead.h + G; y ++ ) for ( let x = - G; x < REG.dead.w + G; x ++ ) {

				const sx = Math.min( REG.dead.w - 1, Math.max( 0, x ) ), sy = Math.min( REG.dead.h - 1, Math.max( 0, y ) );
				const o = ( ( REG.dead.y + y ) * A + REG.dead.x + x ) * 3, s = ( sy * REG.dead.w + sx ) * 3;
				img.data[ o ] = win.data[ s ];
				img.data[ o + 1 ] = win.data[ s + 1 ];
				img.data[ o + 2 ] = win.data[ s + 2 ];

			}

		}

	}

	// ---- scans, with the tiling bark baked in where the source blends to bark
	const tallGroup = sp.groups.find( ( g ) => g.trunk );
	// a mid-resolution copy of the bark for the bake (prefiltered to roughly the scan texel density)
	const bake = { diff: await resize( bDiff, 512, 1024 ), nor: await resize( bNor, 512, 1024 ), arm: await resize( bArm, 512, 1024 ) };
	const avg = [ 0, 0, 0 ];
	for ( let i = 0; i < tile.diff.w * tile.diff.h; i ++ ) for ( let k = 0; k < 3; k ++ ) avg[ k ] += srgbToLinear( tile.diff.data[ i * 3 + k ] / 255 ) / ( tile.diff.w * tile.diff.h );
	for ( const key of [ 'a', 'b', 'c' ] ) {

		if ( ! tallGroup ) break;
		const d = loadDump( tallGroup.src, tallGroup.trunk( key ) );
		const sDiff = await loadImage( texPath( sp, 'trunk_' + key, 'diff' ), 3 );
		const sNor = await loadImage( texPath( sp, 'trunk_' + key, 'nor' ), 3 );
		const sArm = await loadImage( texPath( sp, 'trunk_' + key, 'arm' ), 3 );
		const W = sDiff.w, H = sDiff.h;
		const axis = axisFunction( d );
		const y0 = trunkPhase( d );
		const covered = new Uint8Array( W * H );
		let changed = 0;
		const tmp = [ 0, 0, 0 ], tmpN = [ 0, 0, 0 ], tmpA = [ 0, 0, 0 ];
		for ( let p = 0; p < d.np; p ++ ) {

			const s = d.polyStart[ p ], n = d.polyCount[ p ];
			// polygons that are 100 % bark in the source (mask = 1 on every corner) never show the scan texture; their
			// UVs are arbitrary (they overlap other charts), so they must not be baked. They are rebuilt as a tube.
			let minCol = 1;
			for ( let c = 0; c < n; c ++ ) minCol = Math.min( minCol, d.color[ ( s + c ) * 4 ] );
			if ( minCol >= PURE_BARK ) continue;
			for ( let k = 1; k < n - 1; k ++ ) {

				const c0 = s, c1 = s + k, c2 = s + k + 1;
				const cs = [ c0, c1, c2 ];
				const P = cs.map( ( c ) => {

					const v = d.cornerVert[ c ];
					return [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ];

				} );
				const UV = cs.map( ( c ) => [ d.uv[ c * 2 ], d.uv[ c * 2 + 1 ] ] );
				const col = cs.map( ( c ) => d.color[ c * 4 ] );
				const X = UV.map( ( u ) => u[ 0 ] * W ), Y = UV.map( ( u ) => ( 1 - u[ 1 ] ) * H );
				const blend = Math.max( col[ 0 ], col[ 1 ], col[ 2 ] ) > 0.002;
				// tangent frame of the scan chart on this triangle (Blender uv: v up -> matches GL normal maps)
				let Ts = null, Bs = null, N = null;
				if ( blend ) {

					const e1 = v3.sub( P[ 1 ], P[ 0 ] ), e2 = v3.sub( P[ 2 ], P[ 0 ] );
					const du1 = UV[ 1 ][ 0 ] - UV[ 0 ][ 0 ], dv1 = UV[ 1 ][ 1 ] - UV[ 0 ][ 1 ], du2 = UV[ 2 ][ 0 ] - UV[ 0 ][ 0 ], dv2 = UV[ 2 ][ 1 ] - UV[ 0 ][ 1 ];
					const det = du1 * dv2 - du2 * dv1;
					N = v3.norm( v3.cross( e1, e2 ) );
					if ( Math.abs( det ) > 1e-14 ) {

						Ts = v3.norm( v3.scale( v3.sub( v3.scale( e1, dv2 ), v3.scale( e2, dv1 ) ), 1 / det ) );
						Bs = v3.norm( v3.scale( v3.sub( v3.scale( e2, du1 ), v3.scale( e1, du2 ) ), 1 / det ) );

					}

				}

				rasterTriangle( X[ 0 ], Y[ 0 ], X[ 1 ], Y[ 1 ], X[ 2 ], Y[ 2 ], W, H, ( px, py, w0, w1, w2 ) => {

					const o = py * W + px;
					covered[ o ] = 1;
					if ( ! blend || ! Ts ) return;
					const c = w0 * col[ 0 ] + w1 * col[ 1 ] + w2 * col[ 2 ];
					if ( c <= 0.002 ) return;
					const pos = [ w0 * P[ 0 ][ 0 ] + w1 * P[ 1 ][ 0 ] + w2 * P[ 2 ][ 0 ], w0 * P[ 0 ][ 1 ] + w1 * P[ 1 ][ 1 ] + w2 * P[ 2 ][ 1 ], w0 * P[ 0 ][ 2 ] + w1 * P[ 1 ][ 2 ] + w2 * P[ 2 ][ 2 ] ];
					const [ cu, cv, th ] = cylUV( pos, axis, y0 );
					const bx = cu * bake.diff.w, by = ( 1 - ( cv - Math.floor( cv ) ) ) * bake.diff.h;
					sampleBilinear( bake.diff, bx, by, tmp, true );
					sampleBilinear( bake.nor, bx, by, tmpN, true );
					sampleBilinear( bake.arm, bx, by, tmpA, true );
					for ( let q = 0; q < 3; q ++ ) {

						const a = srgbToLinear( sDiff.data[ o * 3 + q ] / 255 ), b = srgbToLinear( tmp[ q ] / 255 );
						sDiff.data[ o * 3 + q ] = Math.round( 255 * linearToSrgb( a + ( b - a ) * c ) );
						sArm.data[ o * 3 + q ] = Math.round( sArm.data[ o * 3 + q ] + ( tmpA[ q ] - sArm.data[ o * 3 + q ] ) * c );

					}

					// bark normal: cylinder tangent frame -> object space -> scan chart tangent frame
					const Tc = [ Math.sin( th ), 0, - Math.cos( th ) ], Bc = [ 0, 1, 0 ];
					const nb = [ tmpN[ 0 ] / 127.5 - 1, tmpN[ 1 ] / 127.5 - 1, tmpN[ 2 ] / 127.5 - 1 ];
					const n3 = [ Tc[ 0 ] * nb[ 0 ] + Bc[ 0 ] * nb[ 1 ] + N[ 0 ] * nb[ 2 ], Tc[ 1 ] * nb[ 0 ] + Bc[ 1 ] * nb[ 1 ] + N[ 1 ] * nb[ 2 ], Tc[ 2 ] * nb[ 0 ] + Bc[ 2 ] * nb[ 1 ] + N[ 2 ] * nb[ 2 ] ];
					const nsBark = [ v3.dot( n3, Ts ), v3.dot( n3, Bs ), Math.max( 0.05, v3.dot( n3, N ) ) ];
					const ns = [ sNor.data[ o * 3 ] / 127.5 - 1, sNor.data[ o * 3 + 1 ] / 127.5 - 1, sNor.data[ o * 3 + 2 ] / 127.5 - 1 ];
					const out = v3.norm( [ ns[ 0 ] + ( nsBark[ 0 ] - ns[ 0 ] ) * c, ns[ 1 ] + ( nsBark[ 1 ] - ns[ 1 ] ) * c, ns[ 2 ] + ( nsBark[ 2 ] - ns[ 2 ] ) * c ] );
					for ( let q = 0; q < 3; q ++ ) sNor.data[ o * 3 + q ] = Math.round( ( out[ q ] + 1 ) * 127.5 );
					changed ++;

				} );

			}

		}

		// re-pad the charts so the re-baked texels (not the old scan colours) bleed across the chart borders
		for ( const img of [ sDiff, sNor, sArm ] ) dilate( img, covered, 6 );
		const R = REG.scan[ key ];
		blit( base, await resize( sDiff, R.w, R.h ), R.x, R.y );
		blit( normal, await resize( sNor, R.w, R.h ), R.x, R.y );
		blit( orm, await resize( sArm, R.w, R.h ), R.x, R.y );
		log( `bark atlas: scan ${key} re-baked (${changed} texels blended to bark)` );

	}

	// ---- helpers bound to the atlas ----------------------------------------------------------------------------
	const tileUV = ( u, local ) => [ ( REG.tile.x + u * REG.tile.w ) / A, ( REG.tile.y + ( 1 - local ) * REG.tile.h ) / A ];
	const branchUV = ( u, srcV ) => [ ( REG.branch.x + u * REG.branch.w ) / A, ( REG.branch.y + ( 1 - Math.max( 0, Math.min( 1, srcV * 0.1 / BRANCH_BAND ) ) ) * REG.branch.h ) / A ];
	const deadUV = ( u, v ) => [ ( REG.dead.x + ( u - DEAD_SRC.u0 ) / ( DEAD_SRC.u1 - DEAD_SRC.u0 ) * REG.dead.w ) / A, ( REG.dead.y + ( ( 1 - v ) - ( 1 - DEAD_SRC.v1 ) ) / ( DEAD_SRC.v1 - DEAD_SRC.v0 ) * REG.dead.h ) / A ];
	const scanUV = ( key, u, v ) => [ ( REG.scan[ key ].x + u * REG.scan[ key ].w ) / A, ( REG.scan[ key ].y + ( 1 - v ) * REG.scan[ key ].h ) / A ];

	// Tube with the tiling bark. rings: bottom -> top, [{ c, r, vt? }] ; vt = tile coordinate (defaults to y / period).
	// UV seams are inserted wherever vt crosses an integer so that every UV stays inside the tile region.
	function emitTiledTube( mb, ringsIn, sidesOf, period, aoFn, capTop = false ) {

		const rings = ringsIn.map( ( r ) => ( { ...r, vt: r.vt ?? r.c[ 1 ] / period } ) );
		const sides = typeof sidesOf === 'function' ? sidesOf : () => sidesOf;
		const out = [];
		const mk = ( r, local ) => {

			const a = aoFn ? aoFn( r.c ) : 1;
			return { c: r.c, r: r.r, sides: sides( r ), local, col: [ a, a, a ] };

		};

		let m = Math.floor( rings[ 0 ].vt + 1e-9 );
		out.push( mk( rings[ 0 ], rings[ 0 ].vt - m ) );
		for ( let i = 1; i < rings.length; i ++ ) {

			const a = rings[ i - 1 ], b = rings[ i ];
			while ( b.vt > m + 1 + 1e-9 ) {

				const t = ( m + 1 - a.vt ) / ( b.vt - a.vt );
				const mid = { c: v3.lerp( a.c, b.c, t ), r: a.r + ( b.r - a.r ) * t };
				const top = mk( mid, 1 );
				top.noBridge = true;
				out.push( top );
				out.push( mk( mid, 0 ) );
				m ++;

			}

			out.push( mk( b, b.vt - m ) );

		}

		emitTubeBreaks( mb, out, ( u, ring ) => tileUV( u, ring.local ), capTop );

	}

	function emitBranchTube( mb, rings, sides, aoFn ) {

		const list = rings.map( ( r ) => {

			const a = aoFn ? aoFn( r.c ) : 1;
			return { c: r.c, r: r.r, sides, srcV: r.srcV, col: [ a, a, a ] };

		} );
		emitTube( mb, list, ( u, ring ) => branchUV( u, ring.srcV ), { capEnd: false } );

	}

	// dead-branch geometry of a tree dump as an indexed mesh
	function deadMesh( tree, matIndex, move ) {

		const pos = [], nor = [], uv = [], idx = [];
		const map = new Map();
		const vert = ( c ) => {

			const v = tree.cornerVert[ c ];
			const key = v + '/' + tree.uv[ c * 2 ].toFixed( 5 ) + '/' + tree.uv[ c * 2 + 1 ].toFixed( 5 );
			let i = map.get( key );
			if ( i === undefined ) {

				i = pos.length / 3;
				const p = move( [ tree.position[ v * 3 ], tree.position[ v * 3 + 1 ], tree.position[ v * 3 + 2 ] ] );
				pos.push( p[ 0 ], p[ 1 ], p[ 2 ] );
				nor.push( tree.normal[ c * 3 ], tree.normal[ c * 3 + 1 ], tree.normal[ c * 3 + 2 ] );
				const t = deadUV( tree.uv[ c * 2 ], tree.uv[ c * 2 + 1 ] );
				uv.push( t[ 0 ], t[ 1 ] );
				map.set( key, i );

			}

			return i;

		};

		for ( let p = 0; p < tree.np; p ++ ) {

			if ( tree.polyMat[ p ] !== matIndex ) continue;
			const s = tree.polyStart[ p ], n = tree.polyCount[ p ];
			for ( let k = 1; k < n - 1; k ++ ) idx.push( vert( s ), vert( s + k ), vert( s + k + 1 ) );

		}

		return { pos: new Float32Array( pos ), nor: new Float32Array( nor ), uv: new Float32Array( uv ), idx: new Uint32Array( idx ) };

	}

	return { base, normal, orm, avgLinear: avg, regions: REG, tileUV, branchUV, deadUV, scanUV, emitTiledTube, emitBranchTube, deadMesh };

}

// emitTube variant that honours ring.noBridge (UV seam: the next ring is a duplicate with different UVs)
function emitTubeBreaks( mb, rings, uvOf, capTop ) {

	let start = 0;
	let frame = [ 1, 0, 0 ];
	for ( let i = 0; i < rings.length; i ++ ) {

		if ( rings[ i ].noBridge || i === rings.length - 1 ) {

			const seg = rings.slice( start, i + 1 );
			if ( seg.length >= 2 ) emitTube( mb, seg, uvOf, { capEnd: capTop && i === rings.length - 1, startFrame: frame } );
			start = i + 1;

		}

	}

}

// ---------------------------------------------------------------------------------------------------------------
// Photo-scanned trunk (tall trees): dense scanned base + regular 12-gon tube above it.
// ---------------------------------------------------------------------------------------------------------------
export function buildScanTrunk( d, bark, key ) {

	const getPos = ( v ) => [ d.position[ v * 3 ], d.position[ v * 3 + 1 ], d.position[ v * 3 + 2 ] ];
	// adjacency + boundary edges
	const adjacency = Array.from( { length: d.nv }, () => [] );
	const edgeCount = new Map();
	for ( let p = 0; p < d.np; p ++ ) {

		const s = d.polyStart[ p ], n = d.polyCount[ p ];
		for ( let c = 0; c < n; c ++ ) {

			const a = d.cornerVert[ s + c ], b = d.cornerVert[ s + ( c + 1 ) % n ];
			adjacency[ a ].push( b );
			adjacency[ b ].push( a );
			const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
			edgeCount.set( k, ( edgeCount.get( k ) || 0 ) + 1 );

		}

	}

	const onBoundary = new Uint8Array( d.nv );
	for ( const [ k, n ] of edgeCount ) if ( n === 1 ) {

		onBoundary[ Math.floor( k / 4294967296 ) ] = 1;
		onBoundary[ k % 4294967296 ] = 1;

	}

	// BFS levels from the top of the tube
	let top = 0;
	for ( let v = 1; v < d.nv; v ++ ) if ( d.position[ v * 3 + 1 ] > d.position[ top * 3 + 1 ] ) top = v;
	const topY = d.position[ top * 3 + 1 ];
	const level = new Int32Array( d.nv ).fill( - 1 );
	let frontier = [];
	for ( let v = 0; v < d.nv; v ++ ) if ( d.position[ v * 3 + 1 ] > topY - 0.03 ) {

		level[ v ] = 0;
		frontier.push( v );

	}

	const levels = [ frontier ];
	while ( frontier.length ) {

		const next = [];
		for ( const v of frontier ) for ( const n of adjacency[ v ] ) if ( level[ n ] < 0 ) {

			level[ n ] = levels.length;
			next.push( n );

		}

		if ( next.length ) levels.push( next );
		frontier = next;

	}

	const ringSize = levels[ 1 ].length;
	let J = 1;
	while ( J + 1 < levels.length && levels[ J + 1 ].length === ringSize ) J ++;
	// levels[1..J] are regular tube rings (top -> bottom); level J is the junction with the scanned base
	const ringOf = ( ids ) => {

		const c = [ 0, 0, 0 ];
		for ( const v of ids ) for ( let k = 0; k < 3; k ++ ) c[ k ] += d.position[ v * 3 + k ] / ids.length;
		let r = 0;
		for ( const v of ids ) r += v3.len( v3.sub( getPos( v ), c ) ) / ids.length;
		return { c, r };

	};

	const tubeRings = [];
	for ( let l = J; l >= ( levels[ 0 ].length === ringSize ? 0 : 1 ); l -- ) tubeRings.push( ringOf( levels[ l ] ) );
	const junction = tubeRings[ 0 ];
	const apex = levels[ 0 ].length === ringSize ? null : ringOf( levels[ 0 ] ).c;

	// scanned base = every polygon below the junction.
	//   mask < 1 on some corner : shows the scan texture -> scan UVs (the bark blend is baked into that texture)
	//   mask = 1 everywhere     : pure tiling bark, its scan UVs are meaningless -> cylindrical tile UVs, triangles
	//                             that cross the u seam (direction +X from the trunk axis) are split there
	const pos = [], nor = [], uv = [], idx = [], lock = [];
	const map = new Map();
	const push = ( P, N, T ) => {

		pos.push( P[ 0 ], P[ 1 ], P[ 2 ] );
		nor.push( N[ 0 ], N[ 1 ], N[ 2 ] );
		uv.push( T[ 0 ], T[ 1 ] );
		lock.push( 0 );
		return pos.length / 3 - 1;

	};

	const vert = ( c ) => {

		const v = d.cornerVert[ c ];
		const k = v + '/' + d.uv[ c * 2 ].toFixed( 5 ) + '/' + d.uv[ c * 2 + 1 ].toFixed( 5 );
		let i = map.get( k );
		if ( i === undefined ) {

			i = push( getPos( v ), [ d.normal[ c * 3 ], d.normal[ c * 3 + 1 ], d.normal[ c * 3 + 2 ] ], bark.scanUV( key, d.uv[ c * 2 ], d.uv[ c * 2 + 1 ] ) );
			map.set( k, i );

		}

		return i;

	};

	const axisSlice = axisFunction( d );
	const y0 = trunkPhase( d );
	// tile-mapped vertices: keyed by source vertex + which side of the u seam they are used on
	const tileVert = ( v, c, side, P = null, N = null ) => {

		const k = 't' + v + '/' + side;
		let i = P ? undefined : map.get( k );
		if ( i === undefined ) {

			const p = P || getPos( v );
			const [ cu, cv ] = cylUV( p, axisSlice, y0 );
			const u = side === 'lo' ? ( cu > 0.5 ? 0 : cu ) : side === 'hi' ? ( cu < 0.5 ? 1 : cu ) : cu;
			i = push( p, N || [ d.normal[ c * 3 ], d.normal[ c * 3 + 1 ], d.normal[ c * 3 + 2 ] ], bark.tileUV( u, Math.max( 0, Math.min( 1, cv ) ) ) );
			if ( ! P ) map.set( k, i );

		}

		return i;

	};

	let yLow = Infinity, dropped = 0, pureTris = 0;
	for ( let p = 0; p < d.np; p ++ ) {

		const s = d.polyStart[ p ], n = d.polyCount[ p ];
		let dense = true, minCol = 1;
		for ( let c = 0; c < n; c ++ ) {

			if ( level[ d.cornerVert[ s + c ] ] < J ) dense = false;
			minCol = Math.min( minCol, d.color[ ( s + c ) * 4 ] );

		}

		if ( ! dense ) continue;
		if ( minCol < PURE_BARK ) {

			for ( let k = 1; k < n - 1; k ++ ) idx.push( vert( s ), vert( s + k ), vert( s + k + 1 ) );
			continue;

		}

		dropped ++;
		for ( let k = 1; k < n - 1; k ++ ) {

			const cs = [ s, s + k, s + k + 1 ];
			const vs = cs.map( ( c ) => d.cornerVert[ c ] );
			const P = vs.map( getPos );
			for ( const q of P ) yLow = Math.min( yLow, q[ 1 ] );
			const U = P.map( ( q ) => cylUV( q, axisSlice, y0 )[ 0 ] );
			pureTris ++;
			if ( Math.max( ...U ) - Math.min( ...U ) < 0.5 ) {

				idx.push( tileVert( vs[ 0 ], cs[ 0 ], 'any' ), tileVert( vs[ 1 ], cs[ 1 ], 'any' ), tileVert( vs[ 2 ], cs[ 2 ], 'any' ) );
				continue;

			}

			// the triangle straddles the seam: "lo" corners have u just above 0, "hi" corners just below 1
			const side = U.map( ( u ) => ( u < 0.5 ? 'lo' : 'hi' ) );
			const sgn = P.map( ( q ) => q[ 2 ] - axisSlice( q[ 1 ] )[ 1 ] ); // distance from the seam half plane
			const cut = ( i, j ) => {

				const t = sgn[ i ] / ( sgn[ i ] - sgn[ j ] || 1e-12 );
				const tt = Math.max( 0, Math.min( 1, t ) );
				const Pm = v3.lerp( P[ i ], P[ j ], tt );
				const Nm = v3.norm( v3.lerp( [ d.normal[ cs[ i ] * 3 ], d.normal[ cs[ i ] * 3 + 1 ], d.normal[ cs[ i ] * 3 + 2 ] ], [ d.normal[ cs[ j ] * 3 ], d.normal[ cs[ j ] * 3 + 1 ], d.normal[ cs[ j ] * 3 + 2 ] ], tt ) );
				return { lo: tileVert( - 1, 0, 'lo', Pm, Nm ), hi: tileVert( - 1, 0, 'hi', Pm, Nm ) };

			};

			// rotate so that corner 0 is the one alone on its side
			let r = 0;
			if ( side[ 1 ] !== side[ 0 ] && side[ 1 ] !== side[ 2 ] ) r = 1;
			else if ( side[ 2 ] !== side[ 0 ] && side[ 2 ] !== side[ 1 ] ) r = 2;
			const i0 = r, i1 = ( r + 1 ) % 3, i2 = ( r + 2 ) % 3;
			const sa = side[ i0 ], sb = side[ i1 ];
			const m01 = cut( i0, i1 ), m02 = cut( i0, i2 );
			const A0 = tileVert( vs[ i0 ], cs[ i0 ], sa ), B1 = tileVert( vs[ i1 ], cs[ i1 ], sb ), B2 = tileVert( vs[ i2 ], cs[ i2 ], sb );
			idx.push( A0, m01[ sa ], m02[ sa ] );
			idx.push( m01[ sb ], B1, B2, m01[ sb ], B2, m02[ sb ] );

		}

	}

	// the tube starts a few centimetres below the junction, slightly thinner, hidden inside the scanned mesh
	const synth = [ { c: [ junction.c[ 0 ], junction.c[ 1 ] - 0.05, junction.c[ 2 ] ], r: junction.r * 0.96 } ];

	const scanMesh = { pos: new Float32Array( pos ), nor: new Float32Array( nor ), uv: new Float32Array( uv ), idx: new Uint32Array( idx ), lock: Uint8Array.from( lock ) };

	// ground line = mean height of the outer boundary of the scanned ground patch; axis = trunk centre at 1 m
	let gy = 0, gn = 0, patchR = 0;
	const axisF = axisFunction( d );
	for ( let v = 0; v < d.nv; v ++ ) if ( onBoundary[ v ] && level[ v ] > J ) {

		gy += d.position[ v * 3 + 1 ];
		gn ++;

	}

	const ground = gn ? gy / gn : 0;
	const axis = axisF( ground + 1.0 ).slice( 0, 2 );
	for ( let i = 0; i < pos.length; i += 3 ) patchR = Math.max( patchR, Math.hypot( pos[ i ] - axis[ 0 ], pos[ i + 2 ] - axis[ 1 ] ) );
	// trunk radius at 1 m above the ground line
	const trunkRadius = axisF( ground + 1.0 )[ 2 ];

	function emit( wood, move, aoAt ) {

		const targets = [ 3200, 520, 110 ];
		const sidesOf = [
			( r ) => ( r.r > 0.085 ? 10 : r.r > 0.05 ? 8 : 6 ),
			( r ) => ( r.r > 0.06 ? 6 : 5 ),
			() => 4,
		];
		const ringTol = [ 0.006, 0.02, 0.05 ], ringMax = [ 30, 10, 5 ];
		for ( let l = 0; l < 3; l ++ ) {

			const mb = wood[ l ];
			// scanned base
			const { idx: sidx } = simplifyMesh( scanMesh, targets[ l ], { error: l === 0 ? 0.02 : 0.2, uvWeight: l === 0 ? 1.5 : 0.6, normalWeight: 0.4 } );
			const c = compactMesh( scanMesh, sidx );
			const base = mb.vertexCount;
			for ( let i = 0; i < c.pos.length / 3; i ++ ) {

				const p = move( [ c.pos[ i * 3 ], c.pos[ i * 3 + 1 ], c.pos[ i * 3 + 2 ] ] );
				const a = aoAt( p, 0.7 );
				mb.addVertex( p, v3.norm( [ c.nor[ i * 3 ], c.nor[ i * 3 + 1 ], c.nor[ i * 3 + 2 ] ] ), [ c.uv[ i * 2 ], c.uv[ i * 2 + 1 ] ], [ a, a, a ] );

			}

			for ( let i = 0; i < c.idx.length; i += 3 ) mb.addTri( base + c.idx[ i ], base + c.idx[ i + 1 ], base + c.idx[ i + 2 ] );
			// upper tube: starts a little below the junction, slightly thinner, hidden inside the scanned mesh
			const sel = decimateRingsLocal( [ ...synth, ...tubeRings ], ringMax[ l ], ringTol[ l ] );
			const list = sel.map( ( r ) => ( { c: move( r.c ), r: r.r, vt: ( r.c[ 1 ] - y0 ) / TRUNK_PERIOD } ) );
			if ( apex ) list.push( { c: move( apex ), r: Math.max( 0.004, sel[ sel.length - 1 ].r * 0.3 ), vt: ( apex[ 1 ] - y0 ) / TRUNK_PERIOD } );
			bark.emitTiledTube( mb, list, sidesOf[ l ], TRUNK_PERIOD, ( p ) => aoAt( p, 0.7 ), true );

		}

		return { trunkRadius, groundPatchRadius: patchR };

	}

	return { axis, ground, emit, trunkRadius, tubeRings, junction, droppedPureBark: pureTris, yLow, scanTriangles: idx.length / 3 };

}

function decimateRingsLocal( rings, maxRings, tol ) {

	if ( rings.length <= 2 ) return rings.slice();
	const keep = new Set( [ 0, rings.length - 1 ] );
	const errOf = ( a, b, i ) => {

		const A0 = rings[ a ].c, B0 = rings[ b ].c, P = rings[ i ].c;
		const ab = v3.sub( B0, A0 );
		const t = Math.max( 0, Math.min( 1, v3.dot( v3.sub( P, A0 ), ab ) / Math.max( v3.dot( ab, ab ), 1e-12 ) ) );
		const q = v3.add( A0, v3.scale( ab, t ) );
		return v3.len( v3.sub( P, q ) ) + Math.abs( rings[ i ].r - ( rings[ a ].r + ( rings[ b ].r - rings[ a ].r ) * t ) );

	};

	for ( ;; ) {

		const ks = [ ...keep ].sort( ( x, y ) => x - y );
		if ( ks.length >= maxRings ) break;
		let worst = - 1, worstErr = tol;
		for ( let s = 0; s < ks.length - 1; s ++ ) for ( let i = ks[ s ] + 1; i < ks[ s + 1 ]; i ++ ) {

			const e = errOf( ks[ s ], ks[ s + 1 ], i );
			if ( e > worstErr ) {

				worstErr = e;
				worst = i;

			}

		}

		if ( worst < 0 ) break;
		keep.add( worst );

	}

	return [ ...keep ].sort( ( x, y ) => x - y ).map( ( i ) => rings[ i ] );

}
