// Tiny software rasteriser used for texture baking (UV-space re-bakes and orthographic sprite renders).

// Calls cb(px, py, w0, w1, w2) for every pixel whose centre lies inside the 2D triangle (either winding).
// Coordinates are in pixels (pixel centres at +0.5). W/H clip the bounding box.
export function rasterTriangle( x0, y0, x1, y1, x2, y2, W, H, cb ) {

	const area = ( x1 - x0 ) * ( y2 - y0 ) - ( x2 - x0 ) * ( y1 - y0 );
	if ( area === 0 ) return;
	const minX = Math.max( 0, Math.floor( Math.min( x0, x1, x2 ) ) ), maxX = Math.min( W - 1, Math.ceil( Math.max( x0, x1, x2 ) ) );
	const minY = Math.max( 0, Math.floor( Math.min( y0, y1, y2 ) ) ), maxY = Math.min( H - 1, Math.ceil( Math.max( y0, y1, y2 ) ) );
	const inv = 1 / area;
	for ( let py = minY; py <= maxY; py ++ ) {

		const cy = py + 0.5;
		for ( let px = minX; px <= maxX; px ++ ) {

			const cx = px + 0.5;
			const w0 = ( ( x1 - cx ) * ( y2 - cy ) - ( x2 - cx ) * ( y1 - cy ) ) * inv;
			const w1 = ( ( x2 - cx ) * ( y0 - cy ) - ( x0 - cx ) * ( y2 - cy ) ) * inv;
			const w2 = 1 - w0 - w1;
			if ( w0 < 0 || w1 < 0 || w2 < 0 ) continue;
			cb( px, py, w0, w1, w2 );

		}

	}

}

// Orthographic depth-buffered render target with a few float attribute planes.
export class OrthoTarget {

	constructor( W, H, planes ) {

		this.W = W;
		this.H = H;
		this.depth = new Float32Array( W * H ).fill( - Infinity ); // larger = closer to the camera
		this.planes = {};
		for ( const [ name, n ] of Object.entries( planes ) ) this.planes[ name ] = { n, data: new Float32Array( W * H * n ) };
		this.cover = new Uint8Array( W * H );

	}

}
