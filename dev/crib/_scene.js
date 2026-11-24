// "Moderately heavy" benchmark scene shared by the crib test pages.
// Defaults: 400 torus knots (6144 tris each) + 20000 instanced trees (208 tris each) = ~6.7 M triangles per geometry pass,
// 368 draw calls per pass (or 22 with instancedKnots), one 2048^2 directional shadow, PMREM environment.
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { checkerTexture, noiseNormalTexture, noiseTexture } from './_common.js';

export function buildBenchScene( renderer, { knots = 400, trees = 20000, shadowSize = 2048, emissives = 16, instancedKnots = false } = {} ) {

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.3, 600 );
	camera.position.set( 0, 6.5, 30 );
	camera.lookAt( 0, 1.5, 0 );

	const pmrem = new THREE.PMREMGenerator( renderer );
	scene.environment = pmrem.fromScene( new RoomEnvironment(), 0.04 ).texture;
	pmrem.dispose();
	scene.environmentIntensity = 0.6;
	scene.background = new THREE.Color( 0x9db4cc );

	const sun = new THREE.DirectionalLight( 0xffe6c4, 3.5 );
	sun.position.set( 30, 45, 20 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( shadowSize, shadowSize );
	Object.assign( sun.shadow.camera, { left: - 60, right: 60, top: 60, bottom: - 60, near: 1, far: 150 } );
	sun.shadow.bias = - 0.0004;
	sun.shadow.normalBias = 0.05;
	scene.add( sun );

	// ground
	const albedo = checkerTexture( 512, 8, '#8d8a80', '#77756c' );
	albedo.repeat.set( 40, 40 );
	albedo.anisotropy = 8;
	const nrm = noiseNormalTexture( 256, 5 );
	nrm.repeat.set( 60, 60 );
	nrm.anisotropy = 8;
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 400, 400 ), new THREE.MeshStandardMaterial( { map: albedo, normalMap: nrm, roughness: 0.85 } ) );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = true;
	scene.add( ground );

	// glossy metal patch (for SSR)
	const patch = new THREE.Mesh( new THREE.PlaneGeometry( 16, 10 ), new THREE.MeshStandardMaterial( { color: 0x8899aa, metalness: 1, roughness: 0.15 } ) );
	patch.rotation.x = - Math.PI / 2;
	patch.position.set( 0, 0.02, 14 );
	patch.receiveShadow = true;
	scene.add( patch );

	// torus knots: 6144 triangles each
	const knotGeo = new THREE.TorusKnotGeometry( 0.8, 0.28, 128, 24 );
	const rough = noiseTexture( 128, 16, 3 );
	const knotMats = [];
	for ( let i = 0; i < 6; i ++ ) {

		knotMats.push( new THREE.MeshStandardMaterial( {
			color: new THREE.Color().setHSL( i / 6, 0.55, 0.45 ), roughness: 0.25 + 0.12 * i, metalness: i % 2 ? 0.9 : 0.0,
			roughnessMap: i % 3 === 0 ? rough : null, normalMap: i % 2 === 0 ? nrm : null,
		} ) );

	}

	const knotList = [];
	const cols = Math.ceil( Math.sqrt( knots * 2 ) );
	const place = ( o, i ) => {

		const cx = ( i % cols ) - cols / 2, cz = Math.floor( i / cols );
		o.position.set( cx * 3.2 + ( cz % 2 ) * 1.6, 1.4 + ( i % 3 ) * 0.6, 8 - cz * 3.4 );
		o.rotation.set( i * 0.37, i * 0.91, 0 );

	};

	let knotInstances = null;

	if ( instancedKnots ) {

		// one draw call: keeps the CPU cost negligible so that frame time is GPU bound
		const mat = new THREE.MeshStandardMaterial( { roughness: 0.45, metalness: 0.2, roughnessMap: rough, normalMap: nrm } );
		knotInstances = new THREE.InstancedMesh( knotGeo, mat, knots );
		const o = new THREE.Object3D(), c = new THREE.Color();
		for ( let i = 0; i < knots; i ++ ) {

			place( o, i );
			o.updateMatrix();
			knotInstances.setMatrixAt( i, o.matrix );
			knotInstances.setColorAt( i, c.setHSL( ( i % 6 ) / 6, 0.55, 0.45 ) );

		}

		knotInstances.castShadow = knotInstances.receiveShadow = true;
		knotInstances.computeBoundingSphere();
		scene.add( knotInstances );

	} else {

		for ( let i = 0; i < knots; i ++ ) {

			const m = new THREE.Mesh( knotGeo, knotMats[ i % knotMats.length ] );
			place( m, i );
			m.castShadow = m.receiveShadow = true;
			scene.add( m );
			knotList.push( m );

		}

	}

	// instanced "trees" (cone canopy + trunk): 192 triangles per tree
	const canopyGeo = new THREE.ConeGeometry( 1.1, 3.2, 24, 4 ); // 24*4*2 - 24 + 24 = 192
	canopyGeo.translate( 0, 2.6, 0 );
	const canopy = new THREE.InstancedMesh( canopyGeo, new THREE.MeshStandardMaterial( { color: 0x2f5a2a, roughness: 0.9 } ), trees );
	const trunkGeo = new THREE.CylinderGeometry( 0.14, 0.2, 1.2, 8, 1 );
	trunkGeo.translate( 0, 0.6, 0 );
	const trunk = new THREE.InstancedMesh( trunkGeo, new THREE.MeshStandardMaterial( { color: 0x5a4632, roughness: 1 } ), trees );
	const dummy = new THREE.Object3D();
	let seed = 12345;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < trees; i ++ ) {

		const a = rnd() * Math.PI * 2, r = 46 + rnd() * 140;
		dummy.position.set( Math.cos( a ) * r, 0, Math.sin( a ) * r );
		dummy.rotation.y = rnd() * 6.28;
		dummy.scale.setScalar( 0.8 + rnd() * 1.2 );
		dummy.updateMatrix();
		canopy.setMatrixAt( i, dummy.matrix );
		trunk.setMatrixAt( i, dummy.matrix );

	}

	canopy.castShadow = canopy.receiveShadow = true;
	trunk.castShadow = trunk.receiveShadow = true;
	canopy.computeBoundingSphere();
	trunk.computeBoundingSphere();
	scene.add( canopy, trunk );

	// emissive spheres (bloom sources)
	const emGeo = new THREE.SphereGeometry( 0.25, 24, 12 );
	for ( let i = 0; i < emissives; i ++ ) {

		const e = new THREE.Mesh( emGeo, new THREE.MeshStandardMaterial( { color: 0x000000, emissive: new THREE.Color().setHSL( i / emissives, 0.9, 0.5 ), emissiveIntensity: 12 } ) );
		e.position.set( ( i - emissives / 2 ) * 2.2, 4.2 + ( i % 2 ), 6 - ( i % 4 ) * 4 );
		scene.add( e );

	}

	return { scene, camera, sun, ground, patch, knots: knotList, knotInstances, canopy, trunk };

}
