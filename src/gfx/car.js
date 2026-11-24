// Player car visual: the model with its material recipe, paint choice, wheels (spin, steer, suspension travel), steering
// wheel, lamps, a driver, the contact shadow and (at night) headlights. Driven by frame.car - no physics in here.
// Conventions of the model (public/assets/car/car.json): origin on the ground under the car, nose toward -Z, +Y up.

import * as THREE from 'three/webgpu';
import { applyCarMaterials, createCarMaterials } from './car/materials.js';

/** Display names of the paints (ids are the keys of car.json materials.paints plus the extras below). */
const PAINT_NAMES = { rosso: 'Ember Red', bianco: 'Glacier Pearl', blu: 'Midnight Blue', grigio: 'Graphite', giallo: 'Sunbeam Yellow', verde: 'Forest Green', arancio: 'Golden Bear Orange', argento: 'Ice Silver' };

/** Paints added on top of the ones tuned in the car spec (same parameter set). */
const EXTRA_PAINTS = {
	verde: { label: 'Forest green (metallic)', color: '#0c3a22', flopColor: '#020b06', flop: 0.7, metalness: 0.7, roughness: 0.4, baseSpecular: 1, clearcoat: 1, clearcoatRoughness: 0.035, flake: 0.28, flakeScale: 2600, caliper: '#e3a800' },
	arancio: { label: 'Orange (solid)', color: '#d4500d', flopColor: '#6e1f02', flop: 0.5, metalness: 0, roughness: 0.6, baseSpecular: 0.25, clearcoat: 1, clearcoatRoughness: 0.035, flake: 0, flakeScale: 2600, caliper: '#0b0b0c' },
	argento: { label: 'Silver (metallic)', color: '#aeb6bf', flopColor: '#3d444d', flop: 0.6, metalness: 0.85, roughness: 0.36, baseSpecular: 1, clearcoat: 1, clearcoatRoughness: 0.035, flake: 0.34, flakeScale: 3000, caliper: '#a30d10' },
};

const WHEEL_KEYS = [ 'fl', 'fr', 'rl', 'rr' ]; // same order as VehicleState.wheels
const STEERING_RATIO = 11; // steering-wheel angle per road-wheel angle

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createCar( ctx ) {

	const { assets, scene } = ctx;
	const spec = assets.index.car;
	if ( ! spec ) throw new Error( 'car: public/assets/car/car.json is missing' );
	const recipe = { ...spec.materials, paints: { ...spec.materials.paints, ...EXTRA_PAINTS } };

	const [ gltf, tireTread, tireSidewall, shadowMap ] = await Promise.all( [
		assets.gltf( '/assets/car/' + spec.files.lod0.file ),
		assets.texture( '/assets/car/' + recipe.textures.tireTread.file, { anisotropy: 8 } ),
		assets.texture( '/assets/car/' + recipe.textures.tireSidewall.file, { anisotropy: 8 } ),
		assets.texture( '/assets/car/' + spec.groundShadow.file, { srgb: true, repeat: false } ),
	] );
	for ( const t of [ tireTread, tireSidewall ] ) {

		// glTF-style addressing (no vertical flip), wrapping around the tyre only
		t.flipY = false;
		t.wrapS = THREE.RepeatWrapping;
		t.wrapT = THREE.ClampToEdgeWrapping;
		t.needsUpdate = true;

	}

	const root = new THREE.Group();
	root.name = 'car';
	const model = gltf.scene;
	root.add( model );
	const set = createCarMaterials( recipe, { tireTread, tireSidewall } );
	const missing = applyCarMaterials( model, set );
	if ( missing.length ) console.warn( '[car] materials without a recipe:', missing.join( ', ' ) );

	// ── wheels and steering wheel
	const wheels = WHEEL_KEYS.map( ( key ) => {

		const w = spec.wheels[ key ];
		return { hub: model.getObjectByName( w.node ), spin: model.getObjectByName( w.spinNode ), restY: w.position[ 1 ], steered: w.steered };

	} );
	const steeringWheel = model.getObjectByName( spec.steeringWheel.node );

	// ── driver (the car is open: an empty seat would look wrong)
	root.add( createDriver( spec ) );

	// ── contact shadow under the car (baked for this exact model)
	const shadowMaterial = new THREE.MeshBasicMaterial( { map: shadowMap, blending: THREE.MultiplyBlending, transparent: true, premultipliedAlpha: true, toneMapped: false, depthWrite: false } );
	shadowMaterial.polygonOffset = true;
	shadowMaterial.polygonOffsetFactor = - 2;
	shadowMaterial.polygonOffsetUnits = - 2;
	const contactShadow = new THREE.Mesh( new THREE.PlaneGeometry( spec.groundShadow.size[ 0 ], spec.groundShadow.size[ 1 ] ), shadowMaterial );
	contactShadow.rotation.x = - Math.PI / 2;
	contactShadow.position.y = 0.012;
	contactShadow.renderOrder = 2;
	contactShadow.name = 'contact-shadow';
	root.add( contactShadow );

	// ── headlights. They exist from the start: adding a light later rebuilds every lit shader in the scene (a long stall).
	// At dusk they are the only lights that cast shadows: posts, rails, trees and rocks throw long shadows down the road.
	let headlightMode = 'auto', headlightsOn = false;
	const headlights = [ spec.lamps.headlights.left, spec.lamps.headlights.right ].map( ( p ) => {

		const light = new THREE.SpotLight( 0xfff1dc, 0, 140, 0.5, 0.75, 1.6 );
		light.position.set( p[ 0 ], p[ 1 ], p[ 2 ] + 0.05 );
		light.target.position.set( p[ 0 ] * 1.2, p[ 1 ] - 1.9, p[ 2 ] - 60 ); // dipped beam: the hot spot lands ~20 m ahead
		light.castShadow = true;
		light.shadow.mapSize.set( 1024, 1024 );
		light.shadow.camera.near = 1.4; // starts ahead of the nose, so the car's own bodywork never blocks its lamps
		light.shadow.camera.far = 140;
		light.shadow.bias = - 0.0006;
		light.shadow.normalBias = 0.03;
		light.shadow.radius = 2.5;
		root.add( light, light.target );
		return light;

	} );

	scene.add( root );

	const paints = Object.entries( recipe.paints ).map( ( [ id, p ] ) => ( { id, name: PAINT_NAMES[ id ] ?? p.label, swatch: p.color } ) );
	let paint = '';
	function setPaint( id ) {

		const next = recipe.paints[ id ] ? id : recipe.defaultPaint;
		set.setPaint( next );
		paint = next;

	}

	setPaint( ctx.settings.get( 'paint' ) || recipe.defaultPaint );

	const offHeadlights = ctx.input.actions.on( 'headlights', () => {

		headlightMode = headlightsOn ? 'off' : 'on';

	} );

	const position = new THREE.Vector3(), inverse = new THREE.Quaternion(), local = new THREE.Vector3();
	const lightState = { drl: true, head: false, tail: false, brake: false, reverse: false };
	let lightKey = '';

	/** @param {import('../game/context.js').Frame} frame */
	function update( frame ) {

		const car = frame.car, state = car.state;
		root.position.copy( car.position );
		root.quaternion.copy( car.quaternion );
		if ( ! state ) return;

		// wheel centres come from physics in world space: bring them into the car's own frame (of the same physics step)
		position.fromArray( state.position );
		inverse.fromArray( state.quaternion ).invert();
		const lead = frame.alpha * ( 1 / 120 );
		for ( let i = 0; i < 4; i ++ ) {

			const wheel = wheels[ i ], w = state.wheels[ i ];
			if ( ! wheel.hub ) continue;
			local.fromArray( w.position ).sub( position ).applyQuaternion( inverse );
			wheel.hub.position.y = Number.isFinite( local.y ) ? local.y : wheel.restY;
			if ( wheel.steered ) wheel.hub.rotation.y = w.steer;
			if ( wheel.spin ) wheel.spin.rotation.x = - ( w.spin + w.angularVelocity * lead );

		}

		if ( steeringWheel ) steeringWheel.rotation.z = THREE.MathUtils.clamp( state.steerAngle * STEERING_RATIO, - 2.6, 2.6 );

		// lamps
		headlightsOn = headlightMode === 'on' || ( headlightMode === 'auto' && ctx.sky.night > 0.5 );
		lightState.head = lightState.tail = headlightsOn;
		lightState.brake = state.brake > 0.05;
		lightState.reverse = state.gear === - 1;
		const key = `${headlightsOn}${lightState.brake}${lightState.reverse}`;
		if ( key !== lightKey ) {

			lightKey = key;
			set.setLights( lightState );
			for ( const light of headlights ) light.intensity = headlightsOn ? 1500 : 0;

		}

		contactShadow.visible = state.wheelsOnGround >= 2;

	}

	return {
		/** [{ id, name, swatch }] for the menu. */
		paints,
		get paint() {

			return paint;

		},
		setPaint,
		/** Root object of the car (children are in car-local coordinates). */
		object: root,
		/** Camera anchor points in car-local coordinates (meters; nose toward -Z). */
		getCameraAnchors() {

			const c = spec.cameras;
			return {
				cockpit: { position: c.driverEye.position, lookAt: c.driverEye.lookAt },
				bonnet: { position: c.bonnet.position, lookAt: c.bonnet.lookAt },
				bumper: { position: c.bumper.position, lookAt: c.bumper.lookAt },
				chasePivot: [ 0, 0.75, 0 ],
			};

		},
		/** @param {boolean|'auto'} mode */
		setHeadlights( mode ) {

			headlightMode = mode === 'auto' ? 'auto' : mode ? 'on' : 'off';

		},
		update,
		dispose() {

			offHeadlights();
			scene.remove( root );

		},
	};

}

/** A simple helmeted driver built from primitives, seated on the side where the steering wheel is. */
function createDriver( spec ) {

	const eye = spec.cameras.driverEye.position, wheel = spec.steeringWheel.position;
	const driver = new THREE.Group();
	driver.name = 'driver';
	const suit = new THREE.MeshStandardMaterial( { color: 0x10141c, roughness: 0.85 } );
	const shell = new THREE.MeshPhysicalMaterial( { color: 0xd8dade, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 } );
	const visorMaterial = new THREE.MeshPhysicalMaterial( { color: 0x050607, roughness: 0.08, metalness: 0.6, clearcoat: 1 } );
	const glove = new THREE.MeshStandardMaterial( { color: 0x1c1d20, roughness: 0.7 } );

	const head = [ eye[ 0 ], eye[ 1 ] - 0.015, eye[ 2 ] + 0.075 ];
	const helmet = new THREE.Mesh( new THREE.SphereGeometry( 0.148, 28, 20 ), shell );
	helmet.position.set( head[ 0 ], head[ 1 ], head[ 2 ] );
	helmet.scale.set( 0.94, 1, 1.08 );
	const visor = new THREE.Mesh( new THREE.SphereGeometry( 0.151, 28, 12, Math.PI * 0.72, Math.PI * 0.56, Math.PI * 0.34, Math.PI * 0.24 ), visorMaterial );
	visor.position.copy( helmet.position );
	visor.scale.copy( helmet.scale );
	driver.add( helmet, visor );

	const chest = new THREE.Mesh( new THREE.CapsuleGeometry( 0.165, 0.3, 6, 16 ), suit );
	chest.position.set( head[ 0 ], head[ 1 ] - 0.37, head[ 2 ] + 0.05 );
	chest.rotation.x = - 0.22; // leaning back in the seat
	chest.scale.set( 1.12, 1, 0.8 );
	driver.add( chest );

	// arms: shoulder → hand on the rim at "quarter to three"
	const from = new THREE.Vector3(), to = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	for ( const side of [ - 1, 1 ] ) {

		from.set( head[ 0 ] + side * 0.2, head[ 1 ] - 0.22, head[ 2 ] + 0.02 );
		to.set( wheel[ 0 ] + side * 0.17, wheel[ 1 ] + 0.03, wheel[ 2 ] + 0.03 );
		const length = from.distanceTo( to );
		const arm = new THREE.Mesh( new THREE.CapsuleGeometry( 0.046, length - 0.09, 4, 10 ), suit );
		arm.position.copy( from ).add( to ).multiplyScalar( 0.5 );
		arm.quaternion.setFromUnitVectors( up, to.clone().sub( from ).normalize() );
		const hand = new THREE.Mesh( new THREE.SphereGeometry( 0.05, 12, 10 ), glove );
		hand.position.copy( to );
		driver.add( arm, hand );

	}

	driver.traverse( ( o ) => {

		if ( o.isMesh ) o.castShadow = true;

	} );
	return driver;

}
