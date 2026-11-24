// Procedural brake caliper for the car build (the source model has brake discs but no calipers).
// Built in WHEEL-LOCAL space: origin = wheel centre, +X = car right, y = r cos(theta), z = r sin(theta).
// "o" below is the outboard coordinate: o = sideSign * x.
import { fixWinding, mergeGeos } from './car-lib.mjs';

function earClip( poly ) {

	// poly: [[x,y]...] counter-clockwise, returns triangle index list
	const n = poly.length;
	const idx = poly.map( ( _, i ) => i );
	const tris = [];
	const cross = ( a, b, c ) => ( b[ 0 ] - a[ 0 ] ) * ( c[ 1 ] - a[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] );
	const inside = ( p, a, b, c ) => cross( a, b, p ) >= - 1e-12 && cross( b, c, p ) >= - 1e-12 && cross( c, a, p ) >= - 1e-12;
	let guard = 0;
	while ( idx.length > 3 && guard ++ < n * n ) {

		let clipped = false;
		for ( let i = 0; i < idx.length; i ++ ) {

			const ia = idx[ ( i + idx.length - 1 ) % idx.length ], ib = idx[ i ], ic = idx[ ( i + 1 ) % idx.length ];
			const a = poly[ ia ], b = poly[ ib ], c = poly[ ic ];
			if ( cross( a, b, c ) <= 1e-12 ) continue; // reflex
			let ok = true;
			for ( const j of idx ) { if ( j === ia || j === ib || j === ic ) continue; if ( inside( poly[ j ], a, b, c ) ) { ok = false; break; } }
			if ( ! ok ) continue;
			tris.push( ia, ib, ic );
			idx.splice( i, 1 );
			clipped = true;
			break;

		}

		if ( ! clipped ) break;

	}

	if ( idx.length === 3 ) tris.push( idx[ 0 ], idx[ 1 ], idx[ 2 ] );
	return tris;

}

export function buildCaliper( { sideSign, discOuterR, discXMin, discXMax, front, rim } ) {

	const s = sideSign;
	const od0 = Math.min( s * discXMin, s * discXMax ), od1 = Math.max( s * discXMin, s * discXMax ); // inboard / outboard disc faces
	// clearance to the back of the spokes and to the inside of the barrel, measured on the rim mesh
	let spokeBack = Infinity, barrelR = Infinity;
	const P = rim.positions;
	for ( let i = 0; i < P.length; i += 3 ) {

		const o = s * P[ i ], r = Math.hypot( P[ i + 1 ], P[ i + 2 ] );
		if ( r > discOuterR - 0.08 && r < discOuterR + 0.004 && o > od1 + 0.012 ) spokeBack = Math.min( spokeBack, o );
		if ( r > discOuterR + 0.006 && o > od0 - 0.05 && o < od1 + 0.06 ) barrelR = Math.min( barrelR, r );

	}

	const g = 0.003; // pad gap
	const oOut = Math.min( od1 + ( front ? 0.056 : 0.048 ), spokeBack - 0.012 );
	const oIn = od0 - ( front ? 0.046 : 0.040 );
	const rTop = Math.min( discOuterR + 0.020, barrelR - 0.004 );
	const rIn = discOuterR - ( front ? 0.078 : 0.066 );
	const theta0 = ( front ? 1 : - 1 ) * ( 90 - 8 ) * Math.PI / 180; // front: behind the axle, rear: ahead of the axle, 8 deg above horizontal
	const half = ( front ? 44 : 34 ) * Math.PI / 180;
	const steps = front ? 22 : 18;
	const c = 0.007; // chamfer

	// cross-section (o, r), counter-clockwise when looking with o to the right and r up
	const section = ( t ) => {

		// end taper: lower radial height and thinner outboard half towards the ends -> rounded "kidney" silhouette
		const k = Math.max( 0, ( Math.abs( t ) - 0.72 ) / 0.28 );
		const e = k * k;
		const ri = rIn + ( discOuterR - 0.022 - rIn ) * e;
		const oo = oOut - ( oOut - ( od1 + g + 0.018 ) ) * 0.55 * e;
		const oi = oIn + ( ( od0 - g - 0.014 ) - oIn ) * 0.55 * e;
		return [
			[ od1 + g, ri ], [ oo - c, ri ], [ oo, ri + c ], [ oo, rTop - c * 1.4 ], [ oo - c * 1.4, rTop ],
			[ oi + c * 1.4, rTop ], [ oi, rTop - c * 1.4 ], [ oi, ri + c ], [ oi + c, ri ], [ od0 - g, ri ],
			[ od0 - g, discOuterR + g ], [ od1 + g, discOuterR + g ],
		];

	};

	const m = 12;
	const P3 = [], N3 = [], I3 = [];
	const pt = ( o, r, th ) => [ s * o, r * Math.cos( th ), r * Math.sin( th ) ];
	// side strips: one flat strip per section edge (hard edges between strips)
	const rings = [];
	for ( let j = 0; j <= steps; j ++ ) { const t = - 1 + 2 * j / steps; rings.push( { th: theta0 + t * half, sec: section( t ) } ); }
	for ( let e = 0; e < m; e ++ ) {

		const base = P3.length / 3;
		for ( let j = 0; j <= steps; j ++ ) {

			const { th, sec } = rings[ j ];
			const a = sec[ e ], b = sec[ ( e + 1 ) % m ];
			P3.push( ...pt( a[ 0 ], a[ 1 ], th ), ...pt( b[ 0 ], b[ 1 ], th ) );
			N3.push( 0, 0, 0, 0, 0, 0 );

		}

		for ( let j = 0; j < steps; j ++ ) { const a = base + j * 2, b = a + 1, d = a + 2, cc = a + 3; I3.push( a, b, cc, a, cc, d ); }

	}

	// end caps
	for ( const j of [ 0, steps ] ) {

		const { th, sec } = rings[ j ];
		const base = P3.length / 3;
		for ( const q of sec ) { P3.push( ...pt( q[ 0 ], q[ 1 ], th ) ); N3.push( 0, 0, 0 ); }
		const tris = earClip( sec );
		for ( let i = 0; i < tris.length; i += 3 ) { if ( j === 0 ) I3.push( base + tris[ i ], base + tris[ i + 1 ], base + tris[ i + 2 ] ); else I3.push( base + tris[ i ], base + tris[ i + 2 ], base + tris[ i + 1 ] ); }

	}

	// piston bosses on the outboard face
	const nP = front ? 3 : 2;
	const rP = ( rIn + c + rTop - c * 1.4 ) / 2 - 0.002, bossR = front ? 0.0185 : 0.0175, bossH = 0.0045;
	for ( let p = 0; p < nP; p ++ ) {

		const th = theta0 + ( nP === 1 ? 0 : ( p / ( nP - 1 ) - 0.5 ) * 2 * half * ( front ? 0.56 : 0.5 ) );
		const cy = rP * Math.cos( th ), cz = rP * Math.sin( th );
		const base = P3.length / 3;
		const seg = 20;
		// side
		for ( let i = 0; i <= seg; i ++ ) {

			const a = i / seg * Math.PI * 2, dy = Math.cos( a ), dz = Math.sin( a );
			P3.push( s * ( oOut - 0.001 ), cy + dy * bossR, cz + dz * bossR, s * ( oOut + bossH ), cy + dy * ( bossR - 0.0015 ), cz + dz * ( bossR - 0.0015 ) );
			N3.push( 0, dy, dz, s * 0.35, dy * 0.94, dz * 0.94 );

		}

		for ( let i = 0; i < seg; i ++ ) { const a = base + i * 2; I3.push( a, a + 1, a + 3, a, a + 3, a + 2 ); }
		// cap
		const cb = P3.length / 3;
		P3.push( s * ( oOut + bossH ), cy, cz ); N3.push( s, 0, 0 );
		for ( let i = 0; i <= seg; i ++ ) { const a = i / seg * Math.PI * 2; P3.push( s * ( oOut + bossH ), cy + Math.cos( a ) * ( bossR - 0.0015 ), cz + Math.sin( a ) * ( bossR - 0.0015 ) ); N3.push( s, 0, 0 ); }
		for ( let i = 0; i < seg; i ++ ) I3.push( cb, cb + 1 + i, cb + 2 + i );

	}

	const geo = { positions: Float32Array.from( P3 ), normals: Float32Array.from( N3 ), uvs: null, ao: null, indices: Uint32Array.from( I3 ) };
	// flat/strip normals from geometry: accumulate area-weighted face normals per vertex (vertices are not shared between strips)
	const Pp = geo.positions, Nn = geo.normals, Ii = geo.indices;
	const hasN = new Uint8Array( Pp.length / 3 );
	for ( let i = 0; i < Nn.length; i += 3 ) if ( Nn[ i ] !== 0 || Nn[ i + 1 ] !== 0 || Nn[ i + 2 ] !== 0 ) hasN[ i / 3 ] = 1;
	// orient triangles outwards first: the centroid of the caliper body is inside, use it to orient every triangle
	let cx = 0, cy = 0, cz = 0;
	for ( let i = 0; i < Pp.length; i += 3 ) { cx += Pp[ i ]; cy += Pp[ i + 1 ]; cz += Pp[ i + 2 ]; }
	const nV = Pp.length / 3; cx /= nV; cy /= nV; cz /= nV;
	const acc = new Float32Array( Nn.length );
	for ( let t = 0; t < Ii.length; t += 3 ) {

		const a = Ii[ t ] * 3, b = Ii[ t + 1 ] * 3, d = Ii[ t + 2 ] * 3;
		const ux = Pp[ b ] - Pp[ a ], uy = Pp[ b + 1 ] - Pp[ a + 1 ], uz = Pp[ b + 2 ] - Pp[ a + 2 ];
		const vx = Pp[ d ] - Pp[ a ], vy = Pp[ d + 1 ] - Pp[ a + 1 ], vz = Pp[ d + 2 ] - Pp[ a + 2 ];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		for ( const q of [ a, b, d ] ) { acc[ q ] += gx; acc[ q + 1 ] += gy; acc[ q + 2 ] += gz; }

	}

	// the slot faces (around the disc) point towards the body centroid legitimately, so orientation is decided per strip by
	// comparing with the analytic 2D outward normal instead: recompute per strip
	let vi = 0;
	for ( let e = 0; e < m; e ++ ) {

		for ( let j = 0; j <= steps; j ++ ) {

			const { th, sec } = rings[ j ];
			const a = sec[ e ], b = sec[ ( e + 1 ) % m ];
			let no = b[ 1 ] - a[ 1 ], nr = - ( b[ 0 ] - a[ 0 ] ); // outward normal of a CCW polygon edge
			const l = Math.hypot( no, nr ) || 1; no /= l; nr /= l;
			const ref = [ s * no, nr * Math.cos( th ), nr * Math.sin( th ) ];
			for ( let k = 0; k < 2; k ++ ) {

				const q = vi * 3;
				let x = acc[ q ], y = acc[ q + 1 ], z = acc[ q + 2 ];
				let ll = Math.hypot( x, y, z );
				if ( ll < 1e-12 ) { x = ref[ 0 ]; y = ref[ 1 ]; z = ref[ 2 ]; ll = 1; }
				x /= ll; y /= ll; z /= ll;
				if ( x * ref[ 0 ] + y * ref[ 1 ] + z * ref[ 2 ] < 0 ) { x = - x; y = - y; z = - z; }
				Nn[ q ] = x; Nn[ q + 1 ] = y; Nn[ q + 2 ] = z;
				vi ++;

			}

		}

	}

	// caps: tangential normals
	for ( const j of [ 0, steps ] ) {

		const th = rings[ j ].th, sgn = j === 0 ? - 1 : 1;
		for ( let k = 0; k < m; k ++ ) { const q = vi * 3; Nn[ q ] = 0; Nn[ q + 1 ] = - Math.sin( th ) * sgn; Nn[ q + 2 ] = Math.cos( th ) * sgn; vi ++; }

	}

	// bosses already have normals; normalise
	for ( let i = vi * 3; i < Nn.length; i += 3 ) { const l = Math.hypot( Nn[ i ], Nn[ i + 1 ], Nn[ i + 2 ] ) || 1; Nn[ i ] /= l; Nn[ i + 1 ] /= l; Nn[ i + 2 ] /= l; }
	// make every triangle's winding agree with its vertex normals
	for ( let t = 0; t < Ii.length; t += 3 ) {

		const a = Ii[ t ] * 3, b = Ii[ t + 1 ] * 3, d = Ii[ t + 2 ] * 3;
		const ux = Pp[ b ] - Pp[ a ], uy = Pp[ b + 1 ] - Pp[ a + 1 ], uz = Pp[ b + 2 ] - Pp[ a + 2 ];
		const vx = Pp[ d ] - Pp[ a ], vy = Pp[ d + 1 ] - Pp[ a + 1 ], vz = Pp[ d + 2 ] - Pp[ a + 2 ];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		const dot = gx * ( Nn[ a ] + Nn[ b ] + Nn[ d ] ) + gy * ( Nn[ a + 1 ] + Nn[ b + 1 ] + Nn[ d + 1 ] ) + gz * ( Nn[ a + 2 ] + Nn[ b + 2 ] + Nn[ d + 2 ] );
		if ( dot < 0 ) { const tmp = Ii[ t + 1 ]; Ii[ t + 1 ] = Ii[ t + 2 ]; Ii[ t + 2 ] = tmp; }

	}

	return {
		geo,
		info: {
			thetaCentreDeg: theta0 * 180 / Math.PI, halfSpanDeg: half * 180 / Math.PI, outboard: [ oIn, oOut ], radial: [ rIn, rTop ],
			spokeBack, barrelR, pistons: nP, direction: front ? 'behind the axle (+Z)' : 'ahead of the axle (-Z)',
		},
	};

}
