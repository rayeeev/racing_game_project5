// "Slab cloud" impostor baker for small plants: every source triangle is assigned to exactly ONE flat card by its
// orientation and position, each card is then rendered orthographically (albedo/alpha/normal/ORM) into a shared atlas.
//   - near-horizontal faces (leaves lying flat, flower discs)  -> horizontal cards, one per height slab (1D k-means on y)
//   - everything else (stems, upright leaves, sides of heads) -> vertical cards: nAz orientations through the plant axis,
//     each split into nOff parallel offset slabs (1D k-means on the distance from the axis plane)
// Because nothing is duplicated the total alpha area equals the visible leaf area (modest overdraw) and the plant keeps
// its volume from every direction, including straight down.
import { Raster, eigSym3, v3 } from './plants-lib.mjs';

function kmeans1d( values, weights, k ) {

	const n = values.length;
	if ( n === 0 ) return { centers: [], assign: new Int32Array( 0 ) };
	const order = [ ...values.keys() ].sort( ( a, b ) => values[ a ] - values[ b ] );
	let tot = 0;
	for ( const w of weights ) tot += w;
	// init at weighted quantiles
	const centers = [];
	let acc = 0, next = 0;
	for ( const i of order ) {

		acc += weights[ i ];
		while ( next < k && acc >= tot * ( next + 0.5 ) / k ) {

			centers.push( values[ i ] );
			next ++;

		}

	}

	while ( centers.length < k ) centers.push( values[ order[ n - 1 ] ] );
	const assign = new Int32Array( n );
	for ( let it = 0; it < 30; it ++ ) {

		let changed = false;
		for ( let i = 0; i < n; i ++ ) {

			let best = 0, bd = Infinity;
			for ( let c = 0; c < k; c ++ ) {

				const d = Math.abs( values[ i ] - centers[ c ] );
				if ( d < bd ) {

					bd = d; best = c;

				}

			}

			if ( assign[ i ] !== best ) {

				assign[ i ] = best; changed = true;

			}

		}

		const sum = new Float64Array( k ), ws = new Float64Array( k );
		for ( let i = 0; i < n; i ++ ) {

			sum[ assign[ i ] ] += values[ i ] * weights[ i ]; ws[ assign[ i ] ] += weights[ i ];

		}

		for ( let c = 0; c < k; c ++ ) if ( ws[ c ] > 0 ) centers[ c ] = sum[ c ] / ws[ c ];
		if ( ! changed && it > 0 ) break;

	}

	return { centers, assign };

}

/**
 * Split a mesh into slab cards.
 * opts: { nAz, nOff, nH, horizCos = 0.74, minY = 0, minAreaFrac = 0.004, axis = [0,0] (x,z of the vertical cards' common axis), azOffset = 0 }
 * Returns cards: [ { kind:'h'|'v', frame:{o,u,v,n}, widthM, heightM, tris:Uint32Array, area } ]  (frame.o = bottom-left corner)
 */
export function slabCards( mesh, opts ) {

	const { nAz, nOff = 1, nH, horizCos = 0.74, minY = 0, minAreaFrac = 0.004, axis = [ 0, 0 ], azOffset = 0, pad = 0.002 } = opts;
	const { pos, idx } = mesh;
	const tc = idx.length / 3;
	const cen = new Float32Array( tc * 3 ), nrm = new Float32Array( tc * 3 ), area = new Float32Array( tc );
	let totalArea = 0;
	for ( let t = 0; t < tc; t ++ ) {

		const a = idx[ t * 3 ] * 3, b = idx[ t * 3 + 1 ] * 3, c = idx[ t * 3 + 2 ] * 3;
		const e1 = [ pos[ b ] - pos[ a ], pos[ b + 1 ] - pos[ a + 1 ], pos[ b + 2 ] - pos[ a + 2 ] ];
		const e2 = [ pos[ c ] - pos[ a ], pos[ c + 1 ] - pos[ a + 1 ], pos[ c + 2 ] - pos[ a + 2 ] ];
		const cr = v3.cross( e1, e2 );
		const l = v3.len( cr );
		area[ t ] = l * 0.5;
		totalArea += area[ t ];
		nrm[ t * 3 ] = cr[ 0 ] / ( l || 1 ); nrm[ t * 3 + 1 ] = cr[ 1 ] / ( l || 1 ); nrm[ t * 3 + 2 ] = cr[ 2 ] / ( l || 1 );
		for ( let k = 0; k < 3; k ++ ) cen[ t * 3 + k ] = ( pos[ a + k ] + pos[ b + k ] + pos[ c + k ] ) / 3;

	}

	const groups = [];   // { kind, key, tris:[], ... }
	// ---- horizontal
	const hT = [], vT = [];
	for ( let t = 0; t < tc; t ++ ) {

		if ( area[ t ] <= 0 ) continue;
		if ( nH > 0 && Math.abs( nrm[ t * 3 + 1 ] ) >= horizCos ) hT.push( t ); else vT.push( t );

	}

	if ( hT.length ) {

		// k-means in 3D (height weighted x2) -> every cluster (a leaf whorl, a flower disc, ...) gets its own tilted plane
		const K = Math.min( nH, hT.length ), YW = 2;
		const P = hT.map( ( t ) => [ cen[ t * 3 ], cen[ t * 3 + 1 ] * YW, cen[ t * 3 + 2 ] ] );
		const centers = [ P[ 0 ].slice() ];
		const dmin = P.map( ( p ) => ( p[ 0 ] - centers[ 0 ][ 0 ] ) ** 2 + ( p[ 1 ] - centers[ 0 ][ 1 ] ) ** 2 + ( p[ 2 ] - centers[ 0 ][ 2 ] ) ** 2 );
		while ( centers.length < K ) {

			// farthest point (area weighted) as the next seed
			let bi = 0, bv = - 1;
			for ( let i = 0; i < P.length; i ++ ) {

				const v = dmin[ i ] * Math.sqrt( area[ hT[ i ] ] );
				if ( v > bv ) {

					bv = v; bi = i;

				}

			}

			const c = P[ bi ].slice();
			centers.push( c );
			for ( let i = 0; i < P.length; i ++ ) dmin[ i ] = Math.min( dmin[ i ], ( P[ i ][ 0 ] - c[ 0 ] ) ** 2 + ( P[ i ][ 1 ] - c[ 1 ] ) ** 2 + ( P[ i ][ 2 ] - c[ 2 ] ) ** 2 );

		}

		const assign = new Int32Array( P.length );
		for ( let it = 0; it < 25; it ++ ) {

			for ( let i = 0; i < P.length; i ++ ) {

				let best = 0, bd = Infinity;
				for ( let c = 0; c < K; c ++ ) {

					const d = ( P[ i ][ 0 ] - centers[ c ][ 0 ] ) ** 2 + ( P[ i ][ 1 ] - centers[ c ][ 1 ] ) ** 2 + ( P[ i ][ 2 ] - centers[ c ][ 2 ] ) ** 2;
					if ( d < bd ) {

						bd = d; best = c;

					}

				}

				assign[ i ] = best;

			}

			const sum = centers.map( () => [ 0, 0, 0, 0 ] );
			for ( let i = 0; i < P.length; i ++ ) {

				const w = area[ hT[ i ] ], q = sum[ assign[ i ] ];
				q[ 0 ] += P[ i ][ 0 ] * w; q[ 1 ] += P[ i ][ 1 ] * w; q[ 2 ] += P[ i ][ 2 ] * w; q[ 3 ] += w;

			}

			for ( let c = 0; c < K; c ++ ) if ( sum[ c ][ 3 ] > 0 ) centers[ c ] = [ sum[ c ][ 0 ] / sum[ c ][ 3 ], sum[ c ][ 1 ] / sum[ c ][ 3 ], sum[ c ][ 2 ] / sum[ c ][ 3 ] ];

		}

		const lists = centers.map( () => [] );
		hT.forEach( ( t, i ) => lists[ assign[ i ] ].push( t ) );
		lists.forEach( ( tris ) => {

			if ( ! tris.length ) return;
			// plane: area-weighted mean position and mean (upward) normal, tilt limited to maxTilt
			const m = [ 0, 0, 0 ], nn = [ 0, 0, 0 ];
			let w = 0;
			for ( const t of tris ) {

				const sgn = nrm[ t * 3 + 1 ] < 0 ? - 1 : 1;
				for ( let k = 0; k < 3; k ++ ) {

					m[ k ] += cen[ t * 3 + k ] * area[ t ]; nn[ k ] += nrm[ t * 3 + k ] * sgn * area[ t ];

				}

				w += area[ t ];

			}

			let n = v3.norm( nn );
			const cx = m[ 0 ] / w - axis[ 0 ], cz = m[ 2 ] / w - axis[ 1 ], cr = Math.hypot( cx, cz );
			if ( ( opts.outTilt ?? 0 ) > 0 && cr > 0.01 ) {

				// lean the cluster away from the plant axis: leaves droop outwards, flowers show their face to a low camera
				n = v3.norm( [ n[ 0 ] + cx / cr * opts.outTilt, n[ 1 ], n[ 2 ] + cz / cr * opts.outTilt ] );

			}

			const maxTilt = opts.maxTilt ?? 0.6;   // rad
			const tilt = Math.acos( Math.min( 1, Math.max( - 1, n[ 1 ] ) ) );
			if ( tilt > maxTilt ) {

				const hl = Math.hypot( n[ 0 ], n[ 2 ] ) || 1;
				n = [ n[ 0 ] / hl * Math.sin( maxTilt ), Math.cos( maxTilt ), n[ 2 ] / hl * Math.sin( maxTilt ) ];

			}

			groups.push( { kind: 'h', n, c: [ m[ 0 ] / w, m[ 1 ] / w, m[ 2 ] / w ], tris } );

		} );

	}

	// ---- vertical: orientation bins, then offset slabs
	const bins = Array.from( { length: nAz }, () => [] );
	for ( const t of vT ) {

		let phi = Math.atan2( nrm[ t * 3 + 2 ], nrm[ t * 3 ] ) - azOffset;   // azimuth of the face normal
		phi = ( ( phi % Math.PI ) + Math.PI ) % Math.PI;                       // sign-agnostic
		bins[ Math.round( phi / ( Math.PI / nAz ) ) % nAz ].push( t );

	}

	bins.forEach( ( tris, i ) => {

		if ( ! tris.length ) return;
		const phi = i * Math.PI / nAz + azOffset;
		const n = [ Math.cos( phi ), 0, Math.sin( phi ) ];
		const d = tris.map( ( t ) => ( cen[ t * 3 ] - axis[ 0 ] ) * n[ 0 ] + ( cen[ t * 3 + 2 ] - axis[ 1 ] ) * n[ 2 ] );
		const km = kmeans1d( d, tris.map( ( t ) => area[ t ] ), Math.min( nOff, tris.length ) );
		const lists = km.centers.map( () => [] );
		tris.forEach( ( t, k ) => lists[ km.assign[ k ] ].push( t ) );
		lists.forEach( ( list, c ) => {

			if ( list.length ) groups.push( { kind: 'v', n, d: km.centers[ c ], tris: list } );

		} );

	} );

	// ---- frames + rects
	const cards = [];
	for ( const g of groups ) {

		let a = 0;
		for ( const t of g.tris ) a += area[ t ];
		if ( a < totalArea * minAreaFrac ) continue;
		let frame, uAxis, vAxis, nAxis, origin;
		if ( g.kind === 'h' ) {

			// in-plane axes: major axis of the footprint inside the (tilted) plane -> tight rectangle
			nAxis = g.n;
			const e0 = v3.norm( v3.cross( Math.abs( nAxis[ 2 ] ) < 0.9 ? [ 0, 0, 1 ] : [ 1, 0, 0 ], nAxis ) );
			const e1 = v3.cross( nAxis, e0 );
			let cxx = 0, cxy = 0, cyy = 0;
			for ( const t of g.tris ) {

				const d = [ cen[ t * 3 ] - g.c[ 0 ], cen[ t * 3 + 1 ] - g.c[ 1 ], cen[ t * 3 + 2 ] - g.c[ 2 ] ];
				const x = v3.dot( d, e0 ), y = v3.dot( d, e1 );
				cxx += x * x * area[ t ]; cxy += x * y * area[ t ]; cyy += y * y * area[ t ];

			}

			const th = 0.5 * Math.atan2( 2 * cxy, cxx - cyy );
			uAxis = v3.norm( v3.add( v3.scale( e0, Math.cos( th ) ), v3.scale( e1, Math.sin( th ) ) ) );
			vAxis = v3.cross( nAxis, uAxis );
			origin = g.c;

		} else {

			nAxis = g.n;
			vAxis = [ 0, 1, 0 ];
			uAxis = v3.cross( vAxis, nAxis );
			origin = [ axis[ 0 ] + nAxis[ 0 ] * g.d, 0, axis[ 1 ] + nAxis[ 2 ] * g.d ];

		}

		// bounds of the assigned triangles in (u,v)
		let u0 = Infinity, u1 = - Infinity, v0 = Infinity, v1 = - Infinity;
		for ( const t of g.tris ) for ( let c = 0; c < 3; c ++ ) {

			const vi = idx[ t * 3 + c ] * 3;
			const px = pos[ vi ] - origin[ 0 ], py = pos[ vi + 1 ] - origin[ 1 ], pz = pos[ vi + 2 ] - origin[ 2 ];
			const uu = px * uAxis[ 0 ] + py * uAxis[ 1 ] + pz * uAxis[ 2 ], vv = px * vAxis[ 0 ] + py * vAxis[ 1 ] + pz * vAxis[ 2 ];
			if ( uu < u0 ) u0 = uu;
			if ( uu > u1 ) u1 = uu;
			if ( vv < v0 ) v0 = vv;
			if ( vv > v1 ) v1 = vv;

		}

		u0 -= pad; u1 += pad; v0 -= pad; v1 += pad;
		if ( g.kind === 'v' && v0 < minY - origin[ 1 ] ) v0 = minY - origin[ 1 ];   // nothing below the ground
		if ( g.kind === 'h' ) {

			// a tilted card must not dip below the ground: lift it
			let low = Infinity;
			for ( const [ a, b ] of [ [ u0, v0 ], [ u1, v0 ], [ u0, v1 ], [ u1, v1 ] ] ) low = Math.min( low, origin[ 1 ] + a * uAxis[ 1 ] + b * vAxis[ 1 ] );
			if ( low < minY + 0.003 ) origin = [ origin[ 0 ], origin[ 1 ] + ( minY + 0.003 - low ), origin[ 2 ] ];

		}

		if ( u1 - u0 < 1e-4 || v1 - v0 < 1e-4 ) continue;
		frame = { o: v3.add( origin, v3.add( v3.scale( uAxis, u0 ), v3.scale( vAxis, v0 ) ) ), u: uAxis, v: vAxis, n: nAxis };
		cards.push( { kind: g.kind, frame, widthM: u1 - u0, heightM: v1 - v0, tris: Uint32Array.from( g.tris ), area: a } );

	}

	return cards;

}

/** Render one card's triangles; returns a resolved raster (see Raster.resolve) cropped to (w,h) = round(size * pxPerM). */
export function renderCard( mesh, card, pxPerM, tex, ss = 4 ) {

	const w = Math.max( 2, Math.round( card.widthM * pxPerM ) ), h = Math.max( 2, Math.round( card.heightM * pxPerM ) );
	const sub = { pos: mesh.pos, nrm: mesh.nrm, uv: mesh.uv, idx: new Uint32Array( card.tris.length * 3 ) };
	for ( let k = 0; k < card.tris.length; k ++ ) {

		const t = card.tris[ k ] * 3;
		sub.idx[ k * 3 ] = mesh.idx[ t ]; sub.idx[ k * 3 + 1 ] = mesh.idx[ t + 1 ]; sub.idx[ k * 3 + 2 ] = mesh.idx[ t + 2 ];

	}

	const r = new Raster( w, h, card.widthM, card.heightM, ss ).draw( sub, card.frame, { tex } ).resolve();
	return r;

}

/** World-space quad of a card with atlas uvs. rect = {x,y,w,h} px in an atlas of size A. normalFn(p, card) -> shading normal. */
export function cardQuad( mb, card, rect, A, normalFn ) {

	const { o, u, v } = card.frame;
	const p00 = o, p10 = v3.add( o, v3.scale( u, card.widthM ) ), p11 = v3.add( p10, v3.scale( v, card.heightM ) ), p01 = v3.add( o, v3.scale( v, card.heightM ) );
	const u0 = rect.x / A, u1 = ( rect.x + rect.w ) / A, vT = rect.y / A, vB = ( rect.y + rect.h ) / A;
	const a = mb.vert( p00, normalFn( p00, card ), [ u0, vB ] );
	const b = mb.vert( p10, normalFn( p10, card ), [ u1, vB ] );
	const c = mb.vert( p11, normalFn( p11, card ), [ u1, vT ] );
	const d = mb.vert( p01, normalFn( p01, card ), [ u0, vT ] );
	mb.quad( a, b, c, d );

}
