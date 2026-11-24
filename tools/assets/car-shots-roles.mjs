// Scenario for tools/shot.mjs: false-colour selected nodes of a car GLB (loaded in dev/viewer.html) to identify what each
// source mesh is. Everything not listed in the active set is rendered neutral grey.
//
//   node tools/shot.mjs --url "http://127.0.0.1:5173/dev/viewer.html?models=<glb>&ground=0" --wait-for "window.__ready === true" \
//        --script tools/assets/car-shots-roles.mjs --out-dir <dir> --width 1600 --height 900
//
// env SETS=A,B,C (default all)   VIEWS=front,rear,... (default all)   HIDE=name1,name2 (hide these nodes)
const SETS = {
	A: { lights_red: 0xff0000, brakes: 0x00ff00, leds: 0x0040ff, lights: 0xffff00, glass: 0x00ffff, yellow_trim: 0xff00ff },
	B: { chrome: 0xff0000, metal: 0x00ff00, plastic_gray: 0x0040ff, grills: 0xffff00, wipers: 0x00ffff, interior_dark: 0xff00ff },
	C: { leather: 0xff0000, trim: 0x00ff00, interior_light: 0x0040ff, interior_dark: 0xffff00, carbon_fibre_trim: 0xff00ff, carpet: 0x00ffff, 'carbon fibre': 0xff8000, blue: 0xffffff },
	D: { body: 0xff0000, interior_light: 0x0040ff, interior_dark: 0xffff00, plastic_gray: 0x00ff00, metal: 0xff00ff, chrome: 0x00ffff },
};

// camera positions are in MODEL space (model origin = car centre on the ground); the viewer shifts the model, we compensate.
const VIEWS = {
	front: { pos: [ - 2.6, 1.3, - 4.6 ], target: [ 0, 0.55, - 1.2 ] },
	frontclose: { pos: [ - 1.5, 0.9, - 3.4 ], target: [ - 0.5, 0.55, - 1.9 ] },
	rear: { pos: [ 2.6, 1.4, 4.6 ], target: [ 0, 0.6, 1.3 ] },
	rearclose: { pos: [ 1.2, 1.0, 3.6 ], target: [ 0.4, 0.75, 2.0 ] },
	side: { pos: [ - 6.0, 0.9, 0 ], target: [ 0, 0.55, 0 ] },
	top: { pos: [ 0.001, 6.5, 0.2 ], target: [ 0, 0.5, 0.2 ] },
	interior: { pos: [ 0.25, 1.75, 1.0 ], target: [ - 0.2, 0.7, - 0.6 ] },
	cockpit: { pos: [ - 0.36, 1.08, 0.25 ], target: [ - 0.33, 0.85, - 1.0 ], fov: 70 },
	engine: { pos: [ 0.9, 2.1, 2.6 ], target: [ 0, 0.8, 1.2 ] },
	under: { pos: [ 2.5, - 1.6, 3.5 ], target: [ 0, 0.3, 0 ] },
};

export default async function ( { page, shot, sleep, log } ) {

	// CUSTOM_SETS='{"X":{"node":"#ff0000"}}'  CUSTOM_VIEWS='{"name":{"pos":[x,y,z],"target":[x,y,z],"fov":40}}' add/override entries
	if ( process.env.CUSTOM_SETS ) for ( const [ k, v ] of Object.entries( JSON.parse( process.env.CUSTOM_SETS ) ) ) SETS[ k ] = Object.fromEntries( Object.entries( v ).map( ( [ n, c ] ) => [ n, typeof c === 'string' ? parseInt( c.replace( '#', '' ), 16 ) : c ] ) );
	if ( process.env.CUSTOM_VIEWS ) Object.assign( VIEWS, JSON.parse( process.env.CUSTOM_VIEWS ) );
	const sets = ( process.env.SETS || Object.keys( SETS ).join( ',' ) ).split( ',' );
	const views = ( process.env.VIEWS || Object.keys( VIEWS ).join( ',' ) ).split( ',' );
	const hide = ( process.env.HIDE || '' ).split( ',' ).filter( Boolean );

	await page.evaluate( () => {

		const THREE = window.__THREE;
		const scene = window.__scene;
		// find the model root offset applied by the viewer
		let root = null;
		scene.traverse( ( o ) => { if ( ! root && o.isMesh && o.geometry.type !== 'PlaneGeometry' ) { root = o; while ( root.parent && root.parent.parent && root.parent.parent !== scene ) root = root.parent; } } );
		window.__offset = root.position.clone();
		window.__grey = new THREE.MeshStandardMaterial( { color: 0x6a6a6a, roughness: 0.7, metalness: 0, side: THREE.DoubleSide } );
		window.__mats = new Map();
		window.__applySet = ( set, hide ) => {

			scene.traverse( ( o ) => {

				if ( ! o.isMesh || o.geometry.type === 'PlaneGeometry' ) return;
				const base = o.name.replace( /_\d+$/, '' );
				const key = set[ o.name ] !== undefined ? o.name : ( set[ base ] !== undefined ? base : ( set[ o.name.replace( /_/g, ' ' ) ] !== undefined ? o.name.replace( /_/g, ' ' ) : null ) );
				o.visible = ! hide.includes( o.name ) && ! hide.includes( base );
				if ( key === null ) { o.material = window.__grey; return; }
				const c = set[ key ];
				if ( ! window.__mats.has( c ) ) window.__mats.set( c, new THREE.MeshStandardMaterial( { color: c, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, emissive: c, emissiveIntensity: 0.25 } ) );
				o.material = window.__mats.get( c );

			} );

		};

		window.__view = ( v ) => {

			const cam = window.__camera, off = window.__offset;
			cam.fov = v.fov || 40;
			cam.position.set( v.pos[ 0 ] + off.x, v.pos[ 1 ] + off.y, v.pos[ 2 ] + off.z );
			cam.near = 0.02; cam.far = 200;
			cam.updateProjectionMatrix();
			cam.lookAt( v.target[ 0 ] + off.x, v.target[ 1 ] + off.y, v.target[ 2 ] + off.z );

		};

	} );

	for ( const s of sets ) {

		await page.evaluate( ( [ set, hide ] ) => window.__applySet( set, hide ), [ SETS[ s ], hide ] );
		for ( const v of views ) {

			await page.evaluate( ( view ) => window.__view( view ), VIEWS[ v ] );
			await sleep( 300 );
			await shot( `roles_${s}_${v}` );

		}

		log( 'set', s, JSON.stringify( Object.fromEntries( Object.entries( SETS[ s ] ).map( ( [ k, c ] ) => [ k, '#' + c.toString( 16 ).padStart( 6, '0' ) ] ) ) ) );

	}

}
