// Geometry of the paved road derived from a Track. Pure (Node + browser).
// buildRoadRibbon() feeds BOTH the physics collider and the render mesh, so wheels touch exactly what is drawn.

/**
 * Stations along the track: every `step` meters, denser where the road bends (horizontally or vertically) so that the
 * chord error of the polyline stays below `maxChordError`.
 * @returns {number[]} increasing s values in [0, length); the ribbon closes back to the first one
 */
function stations( track, step, maxChordError ) {

	const out = [];
	let s = 0;
	while ( s < track.length - 1e-6 ) {

		out.push( s );
		const i = Math.min( track.count - 1, Math.floor( s ) );
		const j = ( i + 1 ) % track.count;
		const bendH = Math.abs( track.curvatures[ i ] );
		const bendV = Math.abs( track.grades[ j ] - track.grades[ i ] ) / track.spacing;
		const bend = Math.max( bendH, bendV, 1e-6 );
		// chord error of an arc of radius R over length L is L^2 / (8 R)
		const limit = Math.sqrt( 8 * maxChordError / bend );
		s += Math.max( 0.5, Math.min( step, limit ) );

	}

	// avoid a sliver before the seam
	if ( out.length > 1 && track.length - out[ out.length - 1 ] < 0.25 ) out.pop();
	return out;

}

/**
 * The paved surface as an indexed triangle mesh, exactly on P(s, d).
 * @param {import('./track.js').Track} track
 * @param {Object} [options]
 * @param {number} [options.step=2]            maximum spacing along the road in meters
 * @param {number} [options.lateral=6]         subdivisions across the road
 * @param {number} [options.maxChordError=0.02] meters
 * @param {number} [options.extra=0]           extends the ribbon this many meters beyond both pavement edges
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array, rows: number, cols: number, sAtRow: Float32Array, halfWidthAtRow: Float32Array, curvatureAtRow: Float32Array }}
 *   uvs: u = 0 at the LEFT edge .. 1 at the right edge, v = s in meters. The last row repeats row 0 with v = track.length.
 */
export function buildRoadRibbon( track, { step = 2, lateral = 6, maxChordError = 0.02, extra = 0 } = {} ) {

	const sList = stations( track, step, maxChordError );
	const rows = sList.length + 1; // the seam row is duplicated so v can run 0 .. length
	const cols = lateral + 1;
	const positions = new Float32Array( rows * cols * 3 );
	const normals = new Float32Array( rows * cols * 3 );
	const uvs = new Float32Array( rows * cols * 2 );
	const sAtRow = new Float32Array( rows );
	const halfWidthAtRow = new Float32Array( rows );
	const curvatureAtRow = new Float32Array( rows );
	const frame = {};

	for ( let r = 0; r < rows; r ++ ) {

		const seam = r === rows - 1;
		const s = seam ? 0 : sList[ r ];
		track.frameAt( s, frame );
		const half = frame.halfWidth + extra;
		sAtRow[ r ] = seam ? track.length : s;
		halfWidthAtRow[ r ] = frame.halfWidth;
		curvatureAtRow[ r ] = frame.curvature;
		for ( let c = 0; c < cols; c ++ ) {

			const u = c / lateral;
			const d = half * ( 1 - 2 * u ); // left edge first
			const k = ( r * cols + c ) * 3;
			positions[ k ] = frame.x + d * frame.lx;
			positions[ k + 1 ] = frame.y + d * frame.ly;
			positions[ k + 2 ] = frame.z + d * frame.lz;
			normals[ k ] = frame.ux;
			normals[ k + 1 ] = frame.uy;
			normals[ k + 2 ] = frame.uz;
			uvs[ ( r * cols + c ) * 2 ] = u;
			uvs[ ( r * cols + c ) * 2 + 1 ] = sAtRow[ r ];

		}

	}

	const indices = new Uint32Array( ( rows - 1 ) * lateral * 6 );
	let p = 0;
	for ( let r = 0; r < rows - 1; r ++ ) {

		for ( let c = 0; c < lateral; c ++ ) {

			const a = r * cols + c, b = a + 1, e = a + cols, f = e + 1;
			// counter-clockwise seen from above (normal up): a = left-back, b = right-back, e = left-front
			indices[ p ++ ] = a; indices[ p ++ ] = b; indices[ p ++ ] = e;
			indices[ p ++ ] = b; indices[ p ++ ] = f; indices[ p ++ ] = e;

		}

	}

	return { positions, normals, uvs, indices, rows, cols, sAtRow, halfWidthAtRow, curvatureAtRow };

}

/**
 * Points of a line running parallel to the centreline at lateral offset d (positive = left), on the road surface plane.
 * @param {import('./track.js').Track} track
 * @param {number|((s: number, halfWidth: number) => number)} d  constant offset or a function of s (e.g. edge + 0.6)
 * @param {number} [step=2]
 * @param {number} [sStart=0]
 * @param {number} [sEnd=track.length]   may exceed track.length to wrap past the line
 * @returns {Float32Array} [x, y, z, ...] one point every `step` meters from sStart to sEnd inclusive
 */
export function offsetPolyline( track, d, step = 2, sStart = 0, sEnd = track.length ) {

	const count = Math.max( 2, Math.round( ( sEnd - sStart ) / step ) + 1 );
	const out = new Float32Array( count * 3 );
	const frame = {};
	for ( let i = 0; i < count; i ++ ) {

		const s = sStart + ( sEnd - sStart ) * i / ( count - 1 );
		track.frameAt( s, frame );
		const offset = typeof d === 'function' ? d( s, frame.halfWidth ) : d;
		out[ i * 3 ] = frame.x + offset * frame.lx;
		out[ i * 3 + 1 ] = frame.y + offset * frame.ly;
		out[ i * 3 + 2 ] = frame.z + offset * frame.lz;

	}

	return out;

}

/** Both pavement edges as polylines: { left, right } (see offsetPolyline). */
export function pavementEdges( track, step = 2 ) {

	return {
		left: offsetPolyline( track, ( s, half ) => half, step ),
		right: offsetPolyline( track, ( s, half ) => - half, step ),
	};

}
