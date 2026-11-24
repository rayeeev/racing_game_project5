// Ghost car: the rival lap ( frame.ghost ) drawn as a translucent, Fresnel-edged shell of the low-detail car.
// Tinted by its label (medal colours, blue for the player's own best). Never blocks the view: it fades out close to the
// camera, casts no shadow and has no collider.

import * as THREE from 'three/webgpu';
import { cameraPosition, float, normalView, positionViewDirection, positionWorld, smoothstep, uniform, vec4 } from 'three/tsl';

const TINTS = { GOLD: 0xf5c542, SILVER: 0xcfd6de, BRONZE: 0xcf8b53, BEST: 0x5cc8ff };
const WHEEL_KEYS = [ 'fl', 'fr', 'rl', 'rr' ];

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createGhostCar( ctx ) {

	const spec = ctx.assets.index.car;
	if ( ! spec ) throw new Error( 'ghostCar: public/assets/car/car.json is missing' );
	const gltf = await ctx.assets.gltf( '/assets/car/' + spec.files.lod1.file );
	const root = gltf.scene.clone( true );
	root.name = 'ghost-car';

	const tint = uniform( new THREE.Color( TINTS.GOLD ) );
	const material = new THREE.MeshBasicNodeMaterial();
	material.transparent = true;
	material.depthWrite = false;
	material.side = THREE.FrontSide;
	// bright rim, faint body; gone within a few meters of the camera
	const rim = float( 1 ).sub( normalView.dot( positionViewDirection ).abs() ).pow( 2.2 );
	const near = smoothstep( 4.5, 11, positionWorld.sub( cameraPosition ).length() );
	material.colorNode = vec4( tint.mul( rim.mul( 1.6 ).add( 0.35 ) ), rim.mul( 0.75 ).add( 0.16 ).mul( near ) );

	root.traverse( ( o ) => {

		if ( ! o.isMesh ) return;
		o.material = material;
		o.castShadow = o.receiveShadow = false;
		o.renderOrder = 3;

	} );

	const wheels = WHEEL_KEYS.map( ( key ) => {

		const w = spec.wheels[ key ];
		return { hub: root.getObjectByName( w.node ), spin: root.getObjectByName( w.spinNode ), steered: w.steered };

	} );

	root.visible = false;
	ctx.scene.add( root );
	let label = '';

	return {
		/** @param {import('../game/context.js').Frame} frame */
		update( frame ) {

			const ghost = frame.ghost;
			root.visible = ghost !== null && frame.phase !== 'menu';
			if ( ! root.visible ) return;
			root.position.copy( ghost.position );
			root.quaternion.copy( ghost.quaternion );
			for ( const wheel of wheels ) {

				if ( wheel.steered && wheel.hub ) wheel.hub.rotation.y = ghost.steer;
				if ( wheel.spin ) wheel.spin.rotation.x = - ghost.wheelSpin;

			}

			if ( ghost.label !== label ) {

				label = ghost.label;
				tint.value.set( TINTS[ label ] ?? TINTS.BEST );

			}

		},
		dispose() {

			ctx.scene.remove( root );
			material.dispose();

		},
	};

}
