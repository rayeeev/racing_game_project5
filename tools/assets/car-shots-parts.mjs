// Scenario for tools/shot.mjs: isolate every mesh of a car GLB loaded in dev/viewer.html and screenshot it
// (highlighted inside a ghosted car + isolated close-up), so each part can be identified visually.
//
//   node tools/shot.mjs --url "http://127.0.0.1:5173/dev/viewer.html?models=/assets-src/car/ferrari/ferrari.glb&ground=0" \
//        --wait-for "window.__ready === true" --script tools/assets/car-shots-parts.mjs --out-dir <dir> --width 800 --height 450
//
// Optional env: PARTS="name1,name2" (exact mesh-node paths as printed, e.g. "main/body,wheel_fl/tire"), SKIP_WHEELS=1 (only wheel_fl)
export default async function ( { page, shot, sleep, log } ) {

	const list = await page.evaluate( () => {

		const out = [];
		window.__scene.traverse( ( o ) => {

			if ( ! o.isMesh || ! o.geometry || ! o.geometry.attributes.position ) return;
			if ( o.geometry.type === 'PlaneGeometry' ) return;
			const path = [];
			for ( let p = o; p && p.parent && p.name; p = p.parent ) path.unshift( p.name );
			o.userData.__path = path.slice( - 2 ).join( '/' );
			out.push( o.userData.__path );

		} );
		return out;

	} );

	let parts = list;
	if ( process.env.PARTS ) parts = process.env.PARTS.split( ',' );
	else if ( process.env.SKIP_WHEELS ) parts = list.filter( ( p ) => ! /^wheel_(fr|rl|rr)\//.test( p ) );
	log( 'meshes:', list.length, 'shooting:', parts.length );

	await page.evaluate( () => {

		const THREE = window.__THREE;
		window.__hi = new THREE.MeshStandardMaterial( { color: 0xff7a00, roughness: 0.45, metalness: 0.0, side: THREE.DoubleSide } );
		window.__ghost = new THREE.MeshStandardMaterial( { color: 0x8899aa, roughness: 0.8, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide } );
		window.__orig = new Map();
		window.__scene.traverse( ( o ) => { if ( o.isMesh ) { window.__orig.set( o, o.material ); o.castShadow = false; } } );
		window.__isolate = ( path, mode, az, el, distMul ) => {

			let target = null;
			window.__scene.traverse( ( o ) => {

				if ( ! o.isMesh || o.userData.__path === undefined ) return;
				if ( o.userData.__path === path ) { target = o; o.visible = true; o.material = window.__hi; o.renderOrder = 0; } else {

					o.visible = mode === 'ghost';
					o.material = window.__ghost;
					o.renderOrder = 1;

				}

			} );
			if ( ! target ) return null;
			const cam = window.__camera;
			const box = new THREE.Box3();
			if ( mode === 'ghost' ) window.__scene.traverse( ( o ) => { if ( o.isMesh && o.userData.__path !== undefined ) box.expandByObject( o ); } );
			else box.setFromObject( target );
			const c = box.getCenter( new THREE.Vector3() );
			const r = Math.max( box.getSize( new THREE.Vector3() ).length() * 0.5, 0.01 );
			const fov = THREE.MathUtils.degToRad( cam.fov );
			const d = r / Math.sin( Math.min( fov, 2 * Math.atan( Math.tan( fov / 2 ) * cam.aspect ) ) / 2 ) * 1.05 * distMul;
			const a = THREE.MathUtils.degToRad( az ), e = THREE.MathUtils.degToRad( el );
			cam.position.set( c.x + d * Math.cos( e ) * Math.sin( a ), c.y + d * Math.sin( e ), c.z + d * Math.cos( e ) * Math.cos( a ) );
			cam.near = Math.max( d / 200, 0.002 ); cam.far = d * 50 + 50;
			cam.updateProjectionMatrix();
			cam.lookAt( c );
			const tb = new THREE.Box3().setFromObject( target );
			return { min: tb.min.toArray().map( ( x ) => + x.toFixed( 3 ) ), max: tb.max.toArray().map( ( x ) => + x.toFixed( 3 ) ), tris: ( target.geometry.index ? target.geometry.index.count : target.geometry.attributes.position.count ) / 3, mat: window.__orig.get( target ).name };

		};

	} );

	for ( const path of parts ) {

		const safe = path.replace( /[^a-z0-9_]+/gi, '_' );
		const info = await page.evaluate( ( p ) => window.__isolate( p, 'ghost', 140, 22, 0.8 ), path );
		if ( ! info ) { log( 'not found', path ); continue; }
		await sleep( 250 );
		await shot( `${safe}__a` );
		await page.evaluate( ( p ) => window.__isolate( p, 'solo', 140, 22, 1.0 ), path );
		await sleep( 250 );
		await shot( `${safe}__b` );
		await page.evaluate( ( p ) => window.__isolate( p, 'solo', 320, 15, 1.0 ), path );
		await sleep( 250 );
		await shot( `${safe}__c` );
		log( 'part', path, JSON.stringify( info ) );

	}

}
