// Road system: the paved surface with painted markings, gravel shoulder aprons, guard rails, marker posts and the
// start / finish gantry. The pavement mesh is the same ribbon the physics collider uses (src/sim/roadGeometry.js).

import * as THREE from 'three/webgpu';
import {
	attribute, float, fract, max, mix, mod, mx_noise_float, normalMap, positionWorld, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { buildRoadRibbon } from '../sim/roadGeometry.js';
import { RAIL, computeRoadside } from '../sim/roadside.js';
import { uNight, uWetness } from './shared.js';

const EDGE_LINE = [ 0.42, 0.27 ]; // edge line: from / to this far inside the pavement edge (m)
const CENTRE_HALF = 0.065; // half width of the centre line (m)
const DASH = [ 12, 3 ]; // centre line: period and painted length (m)
const APRON = { inset: 0.18, width: 1.55, drop: 0.2 }; // shoulder apron strip (m)

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createRoad( ctx ) {

	const { track, world, scene, assets } = ctx;
	const [ main, worn, gravel ] = await Promise.all( [ assets.pbr( 'asphalt_main' ), assets.pbr( 'asphalt_worn' ), assets.pbr( 'gravel' ) ] );
	const group = new THREE.Group();
	group.name = 'road';

	// ───────────────────────────── pavement ─────────────────────────────
	const ribbon = buildRoadRibbon( track );
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( ribbon.positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( ribbon.normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( ribbon.uvs, 2 ) );
	const halfWidths = new Float32Array( ribbon.rows * ribbon.cols );
	for ( let r = 0; r < ribbon.rows; r ++ ) halfWidths.fill( ribbon.halfWidthAtRow[ r ], r * ribbon.cols, ( r + 1 ) * ribbon.cols );
	geometry.setAttribute( 'roadHalf', new THREE.BufferAttribute( halfWidths, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( ribbon.indices, 1 ) );

	const asphalt = new THREE.MeshPhysicalNodeMaterial();
	asphalt.metalness = 0;
	{

		const half = attribute( 'roadHalf', 'float' );
		const s = uv().y; // meters along the lap
		const across = uv().x.sub( 0.5 ).mul( 2 ).mul( half ); // meters from the centreline, positive = right
		const fromCentre = across.abs();
		const road = vec2( across, s );
		const xz = positionWorld.xz;

		// two asphalts: fresh dark surface with older, paler, cracked patches
		const patch = smoothstep( 0.0, 0.5, mx_noise_float( vec3( xz.mul( 0.031 ), 2.0 ) ).add( mx_noise_float( vec3( xz.mul( 0.19 ), 7.0 ) ).mul( 0.3 ) ) ).mul( 0.62 );
		const uvMain = road.div( main.tileSize ), uvWorn = road.div( worn.tileSize );
		const broad = mx_noise_float( vec3( xz.mul( 0.012 ), 11.0 ) ).mul( 0.12 ).add( 1 );
		let albedo = mix( texture( main.albedo, uvMain ).rgb.mul( 1.15 ), texture( worn.albedo, uvWorn ).rgb.mul( 0.8 ), patch ).mul( broad );
		const armMain = texture( main.arm, uvMain ), armWorn = texture( worn.arm, uvWorn );
		let roughness = mix( armMain.g, armWorn.g, patch );
		const ao = mix( armMain.r, armWorn.r, patch );
		const bump = mix( texture( main.normal, uvMain ), texture( worn.normal, uvWorn ), patch );

		// the two wheel paths of each lane are polished darker
		const lane = fromCentre.sub( half.mul( 0.5 ) ).abs();
		const polished = smoothstep( 1.25, 0.55, lane.sub( 0.8 ).abs() ).mul( 0.1 );
		albedo = albedo.mul( polished.oneMinus() );
		roughness = roughness.sub( polished.mul( 0.5 ) );

		// paint: edge lines, dashed centre line, worn by traffic and weather
		const soft = 0.018;
		const edgeFrom = half.sub( EDGE_LINE[ 0 ] ), edgeTo = half.sub( EDGE_LINE[ 1 ] );
		const edgeLine = smoothstep( edgeFrom.sub( soft ), edgeFrom.add( soft ), fromCentre ).mul( smoothstep( edgeTo.add( soft ), edgeTo.sub( soft ), fromCentre ) );
		const phase = fract( s.div( DASH[ 0 ] ) ).mul( DASH[ 0 ] );
		const dash = smoothstep( 0.0, 0.05, phase ).mul( smoothstep( DASH[ 1 ], DASH[ 1 ] - 0.05, phase ) );
		const centreLine = smoothstep( CENTRE_HALF + soft, CENTRE_HALF - soft, fromCentre ).mul( dash );
		const wear = smoothstep( - 0.5, 0.15, mx_noise_float( vec3( road.mul( vec2( 2.3, 0.6 ) ), 3.0 ) ).add( mx_noise_float( vec3( road.mul( 9.0 ), 5.0 ) ).mul( 0.45 ) ) );
		let paint = max( edgeLine, centreLine ).mul( wear ).mul( 0.92 );
		let paintColor = vec3( 0.66, 0.66, 0.63 );

		// start / finish: a chequered band across the road at s = 0
		const band = step( s, 1.5 ).add( step( track.length - 0.0001, s ) ).min( 1 ).mul( step( fromCentre, half.sub( 0.2 ) ) );
		const cell = mod( across.div( 0.5 ).floor().add( s.div( 0.5 ).floor() ), 2 );
		paint = mix( paint, float( 0.95 ), band );
		paintColor = mix( paintColor, mix( vec3( 0.035 ), vec3( 0.72 ), cell ), band );

		albedo = mix( albedo, paintColor, paint );
		roughness = mix( roughness, float( 0.58 ), paint );

		// wet: darker, a thin water film, standing water in the low spots of the surface
		const puddle = uWetness.mul( smoothstep( 0.05, 0.42, mx_noise_float( vec3( xz.mul( 0.11 ), 13.0 ) ).add( polished.mul( 2.2 ) ).sub( 0.1 ) ) );
		albedo = albedo.mul( mix( float( 1 ), float( 0.5 ), uWetness ) );
		roughness = mix( roughness, float( 0.2 ), uWetness.mul( 0.75 ) );
		roughness = mix( roughness, float( 0.03 ), puddle );

		asphalt.colorNode = vec4( albedo, 1 );
		asphalt.roughnessNode = roughness.clamp( 0.03, 1 );
		asphalt.aoNode = mix( ao, float( 1 ), paint.mul( 0.6 ) );
		asphalt.normalNode = normalMap( bump, vec2( mix( float( 1.0 ), float( 0.25 ), paint ).mul( puddle.oneMinus() ) ) );
		asphalt.clearcoatNode = uWetness.mul( 0.55 ).add( puddle.mul( 0.45 ) );
		asphalt.clearcoatRoughnessNode = mix( float( 0.25 ), float( 0.03 ), puddle );

	}

	const pavement = new THREE.Mesh( geometry, asphalt );
	pavement.name = 'pavement';
	pavement.receiveShadow = true;
	group.add( pavement );

	// ───────────────────────────── shoulder aprons ─────────────────────────────
	{

		const rows = ribbon.rows;
		const positions = new Float32Array( rows * 4 * 3 ), blend = new Float32Array( rows * 4 );
		const frame = {};
		for ( let r = 0; r < rows; r ++ ) {

			track.frameAt( ribbon.sAtRow[ r ] % track.length, frame );
			for ( let k = 0; k < 2; k ++ ) {

				const side = k === 0 ? 1 : - 1;
				const edgeY = frame.y + side * frame.halfWidth * frame.ly;
				for ( let e = 0; e < 2; e ++ ) {

					const d = side * ( frame.halfWidth + ( e === 0 ? - APRON.inset : APRON.width - APRON.inset ) );
					const v = r * 4 + k * 2 + e;
					positions[ v * 3 ] = frame.x + d * frame.lx;
					positions[ v * 3 + 1 ] = e === 0 ? frame.y + d * frame.ly - 0.012 : edgeY - APRON.drop;
					positions[ v * 3 + 2 ] = frame.z + d * frame.lz;
					blend[ v ] = e;

				}

			}

		}

		const indices = [];
		for ( let r = 0; r < rows - 1; r ++ ) {

			const a = r * 4, b = a + 4;
			indices.push( a, a + 1, b, a + 1, b + 1, b ); // left strip (outer edge is further left)
			indices.push( a + 2, b + 2, a + 3, a + 3, b + 2, b + 3 ); // right strip

		}

		const apronGeometry = new THREE.BufferGeometry();
		apronGeometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		apronGeometry.setAttribute( 'apron', new THREE.BufferAttribute( blend, 1 ) );
		apronGeometry.setIndex( indices );
		apronGeometry.computeVertexNormals();

		const material = new THREE.MeshStandardNodeMaterial();
		material.metalness = 0;
		material.side = THREE.DoubleSide;
		const xz = positionWorld.xz;
		const guv = xz.div( gravel.tileSize );
		const t = attribute( 'apron', 'float' );
		// broken asphalt edge: crumbs of dark asphalt reach irregularly into the gravel
		const edge = smoothstep( 0.1, 0.42, t.add( mx_noise_float( vec3( xz.mul( 1.9 ), 1.0 ) ).mul( 0.16 ) ).add( mx_noise_float( vec3( xz.mul( 0.3 ), 6.0 ) ).mul( 0.1 ) ) );
		const stone = texture( gravel.albedo, guv ).rgb;
		const arm = texture( gravel.arm, guv );
		material.colorNode = vec4( mix( stone.mul( 0.34 ), stone, edge ).mul( mix( float( 1 ), float( 0.66 ), uWetness ) ), 1 );
		material.roughnessNode = arm.g.mul( mix( float( 1 ), float( 0.55 ), uWetness ) );
		material.aoNode = arm.r;
		const aprons = new THREE.Mesh( apronGeometry, material );
		aprons.name = 'aprons';
		aprons.receiveShadow = true;
		group.add( aprons );

	}

	// ───────────────────────────── guard rails, posts, marker posts ─────────────────────────────
	const roadside = computeRoadside( track, world );
	ctx.addObstacles( roadside.railColliders );
	const steel = new THREE.MeshStandardNodeMaterial();
	steel.side = THREE.DoubleSide;
	steel.metalness = 0.86;
	{

		const streaks = mx_noise_float( vec3( positionWorld.xz.mul( 0.8 ), positionWorld.y.mul( 9 ) ) );
		steel.colorNode = vec4( vec3( 0.52, 0.54, 0.55 ).mul( streaks.mul( 0.1 ).add( 0.95 ) ), 1 );
		steel.roughnessNode = streaks.mul( 0.1 ).add( 0.44 ).sub( uWetness.mul( 0.15 ) );

	}

	{

		// W-beam cross-section: ( height above the beam centre, protrusion toward the road )
		const profile = [ [ - 0.155, 0.02 ], [ - 0.105, 0.075 ], [ - 0.04, 0.0 ], [ 0.04, 0.0 ], [ 0.105, 0.075 ], [ 0.155, 0.02 ] ];
		const positions = [], indices = [];
		let postCount = 0;
		for ( const run of roadside.rails ) {

			const count = run.points.length / 3, base = positions.length / 3;
			for ( let i = 0; i < count; i ++ ) {

				const a = Math.max( 0, i - 1 ) * 3, b = Math.min( count - 1, i + 1 ) * 3, p = i * 3;
				let dx = run.points[ b ] - run.points[ a ], dz = run.points[ b + 2 ] - run.points[ a + 2 ];
				const len = Math.hypot( dx, dz ) || 1;
				dx /= len;
				dz /= len;
				// toward the road: left rails ( side +1 ) face right of the driving direction, and vice versa
				const nx = - dz * run.side, nz = dx * run.side;
				// ends dive into the ground over the last 6 m (a simple terminal)
				const dive = Math.min( 1, Math.min( i, count - 1 - i ) * 2 / 6 );
				for ( const [ h, out ] of profile ) positions.push( run.points[ p ] + nx * out, run.points[ p + 1 ] + ( RAIL.beamHeight + h ) * dive - 0.2 * ( 1 - dive ), run.points[ p + 2 ] + nz * out );

			}

			for ( let i = 0; i < count - 1; i ++ ) for ( let k = 0; k < profile.length - 1; k ++ ) {

				const a = base + i * profile.length + k, b = a + 1, c = a + profile.length, d = c + 1;
				indices.push( a, c, b, b, c, d );

			}

			postCount += run.posts.length / 4;

		}

		const railGeometry = new THREE.BufferGeometry();
		railGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
		railGeometry.setIndex( indices );
		railGeometry.computeVertexNormals();
		const rails = new THREE.Mesh( railGeometry, steel );
		rails.name = 'guard-rails';
		rails.castShadow = rails.receiveShadow = true;
		group.add( rails );

		const posts = new THREE.InstancedMesh( new THREE.BoxGeometry( 0.1, 1.25, 0.14 ), steel, postCount );
		posts.name = 'rail-posts';
		const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3( 0, 1, 0 ), one = new THREE.Vector3( 1, 1, 1 ), at = new THREE.Vector3();
		let index = 0;
		for ( const run of roadside.rails ) {

			for ( let i = 0; i < run.posts.length; i += 4 ) {

				at.set( run.posts[ i ], run.posts[ i + 1 ] + RAIL.postTop - 0.625, run.posts[ i + 2 ] );
				posts.setMatrixAt( index ++, matrix.compose( at, q.setFromAxisAngle( up, run.posts[ i + 3 ] ), one ) );

			}

		}

		posts.castShadow = posts.receiveShadow = true;
		posts.computeBoundingSphere();
		group.add( posts );

		// marker posts: white with a dark band and a reflector that glows at night
		const d = roadside.delineators, markerCount = d.length / 5;
		const white = new THREE.MeshStandardNodeMaterial();
		white.metalness = 0;
		white.roughness = 0.6;
		const height = attribute( 'position', 'vec3' ).y; // -0.55 .. 0.55 in the box
		const reflector = smoothstep( 0.22, 0.24, height ).mul( smoothstep( 0.4, 0.38, height ) );
		white.colorNode = vec4( mix( mix( vec3( 0.78 ), vec3( 0.03 ), smoothstep( 0.16, 0.18, height ).mul( smoothstep( 0.46, 0.44, height ) ) ), vec3( 0.75, 0.42, 0.08 ), reflector ), 1 );
		white.emissiveNode = vec3( 1.0, 0.5, 0.1 ).mul( reflector ).mul( uNight.mul( 2.5 ).add( 0.02 ) );
		const markers = new THREE.InstancedMesh( new THREE.BoxGeometry( 0.12, 1.1, 0.045 ), white, markerCount );
		markers.name = 'marker-posts';
		for ( let i = 0; i < markerCount; i ++ ) {

			at.set( d[ i * 5 ], d[ i * 5 + 1 ] + 0.45, d[ i * 5 + 2 ] );
			markers.setMatrixAt( i, matrix.compose( at, q.setFromAxisAngle( up, d[ i * 5 + 3 ] + Math.PI / 2 ), one ) );

		}

		markers.castShadow = true;
		markers.computeBoundingSphere();
		group.add( markers );

	}

	// ───────────────────────────── start / finish gantry ─────────────────────────────
	const lights = [];
	const lightState = uniform( 0 ); // 0..3 red lamps on, 4 = green
	{

		const frame = track.frameAt( 0, {} );
		const yaw = Math.atan2( - frame.tx, - frame.tz );
		const span = frame.halfWidth + 1.7;
		const gantry = new THREE.Group();
		gantry.position.set( frame.x, frame.y, frame.z );
		gantry.rotation.y = yaw;
		const dark = new THREE.MeshStandardMaterial( { color: 0x23262b, metalness: 0.7, roughness: 0.45 } );
		for ( const side of [ - 1, 1 ] ) {

			const column = new THREE.Mesh( new THREE.BoxGeometry( 0.34, 6.6, 0.34 ), dark );
			column.position.set( side * span, 3.1, 0 );
			gantry.add( column );

		}

		for ( const y of [ 5.55, 6.3 ] ) {

			const beam = new THREE.Mesh( new THREE.BoxGeometry( span * 2 + 0.34, 0.16, 0.2 ), dark );
			beam.position.set( 0, y, 0 );
			gantry.add( beam );

		}

		// banner (drawn here: original lettering, no logos)
		const canvas = document.createElement( 'canvas' );
		canvas.width = 2048;
		canvas.height = 128;
		const g = canvas.getContext( '2d' );
		g.fillStyle = '#12161c';
		g.fillRect( 0, 0, 2048, 128 );
		g.fillStyle = '#ff8a4c';
		g.fillRect( 0, 0, 2048, 10 );
		g.fillRect( 0, 118, 2048, 10 );
		g.fillStyle = '#f2f4f7';
		g.font = '300 76px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.letterSpacing = '20px';
		g.fillText( 'CS 61B · PROJECT 5', 1024, 66 );
		g.font = '600 26px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif';
		g.letterSpacing = '8px';
		g.fillStyle = '#ffd9b8';
		g.fillText( 'START', 250, 66 );
		g.fillText( 'FINISH', 1798, 66 );
		const bannerTexture = new THREE.CanvasTexture( canvas );
		bannerTexture.colorSpace = THREE.SRGBColorSpace;
		bannerTexture.anisotropy = 8;
		const banner = new THREE.Mesh( new THREE.PlaneGeometry( span * 2 - 0.2, 0.6 ), new THREE.MeshStandardMaterial( { map: bannerTexture, roughness: 0.7, side: THREE.DoubleSide } ) );
		banner.position.set( 0, 5.92, 0 );
		gantry.add( banner );

		// five start lamps facing the grid (the cars approach from local +Z)
		const lampGeometry = new THREE.CircleGeometry( 0.13, 20 );
		for ( let i = 0; i < 5; i ++ ) {

			const material = new THREE.MeshStandardNodeMaterial();
			material.colorNode = vec4( 0.02, 0.02, 0.02, 1 );
			material.roughness = 0.3;
			const red = step( i + 0.5, lightState.mul( 5 / 3 ) ).mul( step( lightState, 3.5 ) ); // 1, 2, 3 light 2, 4, 5 lamps (rounded up)
			const green = step( 3.5, lightState );
			material.emissiveNode = vec3( 9, 0.25, 0.1 ).mul( red ).add( vec3( 0.2, 8, 0.6 ).mul( green ) );
			const lamp = new THREE.Mesh( lampGeometry, material );
			lamp.position.set( ( i - 2 ) * 0.42, 5.25, 0.12 );
			gantry.add( lamp );
			lights.push( lamp );

		}

		const housing = new THREE.Mesh( new THREE.BoxGeometry( 2.3, 0.4, 0.14 ), dark );
		housing.position.set( 0, 5.25, 0.04 );
		gantry.add( housing );

		gantry.traverse( ( o ) => {

			if ( o.isMesh ) o.castShadow = o.receiveShadow = true;

		} );
		gantry.name = 'gantry';
		group.add( gantry );
		const left = track.pointAt( 0, span ), right = track.pointAt( 0, - span );
		const half = yaw / 2;
		ctx.addObstacles( [ left, right ].map( ( p ) => ( { type: 'box', kind: 'other', position: [ p[ 0 ], p[ 1 ] + 3.1, p[ 2 ] ], quaternion: [ 0, Math.sin( half ), 0, Math.cos( half ) ], halfExtents: [ 0.17, 3.3, 0.17 ] } ) ) );

	}

	scene.add( group );

	/**
	 * Start lights: 0..3 = that many red stages on, 'green', or 'off'.
	 * @param {number|string} state
	 */
	function setStartLights( state ) {

		lightState.value = state === 'green' ? 4 : state === 'off' ? 0 : Number( state ) || 0;

	}

	let greenTimer = 0;
	const offCountdown = ctx.events.on( 'countdown', ( { n } ) => {

		// 3 → one stage, 2 → two, 1 → all red, 0 → green for a moment
		if ( n === 0 ) {

			setStartLights( 'green' );
			greenTimer = 2.5;

		} else setStartLights( 4 - n );

	} );

	console.info( `[road] ${ribbon.rows} ribbon rows, ${roadside.rails.length} rail runs, ${roadside.delineators.length / 5} marker posts` );

	return {
		roadside,
		setStartLights,
		update( frame ) {

			if ( greenTimer > 0 ) {

				greenTimer -= frame.dt;
				if ( greenTimer <= 0 ) setStartLights( 'off' );

			}

		},
		dispose() {

			offCountdown();
			scene.remove( group );
			group.traverse( ( o ) => {

				o.geometry?.dispose?.();

			} );

		},
	};

}
