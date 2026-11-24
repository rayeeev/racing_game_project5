// Car material recipe: builds the node materials described by public/assets/car/car.json ("materials") - layered car
// paint with flop and metallic flake, glass, tyres with tread / sidewall normal maps, two-tone rims, lamps driven by
// emissive uniforms. Lifted from the asset look-dev page (dev/preview-car.html), where it was tuned against HDRIs.
//
//   const set = createCarMaterials( carSpec.materials, { tireTread, tireSidewall } );
//   applyCarMaterials( carRoot, set );          // matches by glTF material name; returns the names it could not map
//   set.setPaint( 'rosso' );  set.setLights( { drl, head, tail, brake, reverse, fog, indl, indr } );

import * as THREE from 'three/webgpu';
import {
	uniform, float, vec2, vec3, mix, smoothstep, step, select, floor, fract, abs, max, dot, pow, sqrt, length, normalize, atan, mod,
	uv, texture, normalMap, positionLocal, normalLocal, normalView, normalViewGeometry, positionViewDirection, transformNormalToView,
	vertexColor, mx_cell_noise_float, mx_noise_float, mx_noise_vec3, fwidth,
} from 'three/tsl';

export function createCarMaterials( recipe, textures ) {

	const R = recipe.byMaterial;
	const col = ( hex ) => new THREE.Color( hex ); // sRGB hex -> linear working space

	// ---- shared nodes ----
	const aoBaked = vertexColor().r; // baked sky visibility (COLOR_0)
	const ao = ( k, floor = 0 ) => mix( float( 1 ), mix( float( floor ), float( 1 ), aoBaked ), float( k ) );
	const pixel = length( fwidth( positionLocal ) ).mul( 0.7 ); // approx. size of one pixel on the surface (m)
	const resolved = ( featureSize, lo = 0.6, hi = 2.2 ) => smoothstep( lo, hi, float( featureSize ).div( pixel ) ); // 1 when the feature spans > hi pixels
	// object-space 2D coordinates on the plane perpendicular to the dominant normal axis (cheap "triplanar")
	const nAbs = normalLocal.abs();
	const xDom = nAbs.x.greaterThan( nAbs.y ).and( nAbs.x.greaterThan( nAbs.z ) );
	const yDom = nAbs.y.greaterThan( nAbs.z );
	const planar = select( xDom, positionLocal.zy, select( yDom, positionLocal.xz, positionLocal.xy ) );
	const lift = ( t ) => select( xDom, vec3( 0, t.y, t.x ), select( yDom, vec3( t.x, 0, t.y ), vec3( t.x, t.y, 0 ) ) ); // planar 2D vector -> object space
	const bumpNormal = ( offsetLocal ) => transformNormalToView( normalize( normalLocal.add( offsetLocal ) ) );

	const u = {}; // uniforms the game drives at runtime
	const materials = {};

	// ---- lights: one intensity uniform per function ----
	const L = recipe.lights;
	for ( const key of [ 'headlight', 'drl', 'tail', 'brakeHigh', 'reverse', 'fogRear', 'indicatorLeft', 'indicatorRight' ] ) u[ key ] = uniform( 0 );
	const lightMat = ( name, key, def ) => {

		const m = def.class === 'MeshPhysicalNodeMaterial' ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
		m.name = name;
		m.color = col( def.color ); m.metalness = def.metalness; m.roughness = def.roughness;
		if ( def.clearcoat ) { m.clearcoat = def.clearcoat; m.clearcoatRoughness = 0.03; }
		m.emissiveNode = vec3( col( L[ key ].color ) ).mul( u[ key ] );
		m.aoNode = ao( def.ao );
		return m;

	};

	// ---- 1. body paint -------------------------------------------------------------------------------------------------
	{

		const def = R.Body_Color;
		const m = new THREE.MeshPhysicalNodeMaterial();
		m.name = 'Body_Color';
		u.paintColor = uniform( new THREE.Color() ); u.paintFlop = uniform( new THREE.Color() ); u.paintFlopAmount = uniform( 0 );
		u.paintMetalness = uniform( 0 ); u.paintRoughness = uniform( 0.5 ); u.paintClearcoat = uniform( 1 ); u.paintClearcoatRoughness = uniform( 0.03 );
		u.paintFlake = uniform( 0 ); u.paintFlakeScale = uniform( 2600 ); u.paintBaseSpecular = uniform( 1 );
		const facing = dot( normalViewGeometry, positionViewDirection ).saturate();
		m.colorNode = mix( u.paintColor, u.paintFlop, pow( facing.oneMinus(), 2.2 ).mul( u.paintFlopAmount ) );
		// metallic flakes: a random direction per 3D cell in object space tilts the BASE normal only
		const fp = positionLocal.mul( u.paintFlakeScale );
		const rnd = vec3( mx_cell_noise_float( fp ), mx_cell_noise_float( fp.add( vec3( 17.3, 5.1, 9.7 ) ) ), mx_cell_noise_float( fp.add( vec3( 3.9, 23.5, 11.1 ) ) ) ).sub( 0.5 ).mul( 2 );
		const cellsPerPixel = pixel.mul( u.paintFlakeScale ).max( 1 ); // > 1: flakes are sub-pixel -> amplitude falls off like a mip chain would
		const flakeAmp = u.paintFlake.div( cellsPerPixel );
		m.normalNode = bumpNormal( rnd.mul( flakeAmp ) );
		m.clearcoatNormalNode = normalViewGeometry; // the lacquer stays perfectly smooth
		m.metalnessNode = u.paintMetalness;
		m.roughnessNode = u.paintRoughness.add( u.paintFlake.sub( flakeAmp ).mul( 0.22 ) ); // unresolved sparkle widens the base lobe instead
		m.specularIntensityNode = u.paintBaseSpecular; // solid colours: the pigment layer has (almost) no interface of its own under the lacquer
		m.clearcoatNode = u.paintClearcoat;
		m.clearcoatRoughnessNode = u.paintClearcoatRoughness;
		m.aoNode = ao( def.ao );
		materials.Body_Color = m;

	}

	// ---- 2. glass family: reflections are ADDED on top of an attenuated background ---------------------------------------
	const glass = ( name ) => {

		const def = R[ name ];
		const m = new THREE.MeshPhysicalNodeMaterial();
		m.name = name;
		m.color = col( def.tint ); m.metalness = 0; m.roughness = def.roughness; m.ior = def.ior;
		m.transparent = true; m.depthWrite = false;
		m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
		const facing = dot( normalView, positionViewDirection ).abs();
		const fresnel = float( 0.04 ).add( float( 0.96 ).mul( pow( facing.oneMinus(), 5 ) ) );
		m.opacityNode = float( 1 ).sub( float( def.transmission ).mul( fresnel.oneMinus() ) ); // = 1 - T (1 - F)
		if ( def.emissiveFrom ) m.emissiveNode = vec3( col( L[ def.emissiveFrom ].color ) ).mul( u[ def.emissiveFrom ] ).mul( def.emissiveScale );
		return m;

	};
	materials.Glass_Gray = glass( 'Glass_Gray' );
	materials.Lamp_Glass = glass( 'Lamp_Glass' );
	materials.Taillight_Lens = glass( 'Taillight_Lens' );

	// ---- 3. plain standard materials ------------------------------------------------------------------------------------
	const standard = ( name ) => {

		const def = R[ name ];
		const m = new THREE.MeshStandardNodeMaterial();
		m.name = name;
		m.color = col( def.color ); m.metalness = def.metalness; m.roughness = def.roughness;
		m.aoNode = ao( def.ao, def.aoFloor );
		return m;

	};
	for ( const name of [ 'Trim_Black', 'metal_chrome', 'Mirror', 'Headlight_Housing', 'Leather_red', 'metal_gray', 'Display_Glass', 'Gauge_Face' ] ) materials[ name ] = standard( name );

	// ---- 4. lights ------------------------------------------------------------------------------------------------------
	materials.Projector_Glass = lightMat( 'Projector_Glass', 'headlight', R.Projector_Glass );
	materials.Turn_Signal_LED = lightMat( 'Turn_Signal_LED', 'drl', R.Turn_Signal_LED );
	materials.Light_Brake_High = lightMat( 'Light_Brake_High', 'brakeHigh', R.Light_Brake_High );
	materials.Light_Reverse = lightMat( 'Light_Reverse', 'reverse', R.Light_Reverse );
	materials.Light_Fog_Rear = lightMat( 'Light_Fog_Rear', 'fogRear', R.Light_Fog_Rear );
	materials.Taillight_Glass = lightMat( 'Taillight_Glass', 'tail', R.Taillight_Glass );
	// the indicator material is instanced per side (looked up by MESH name, see applyCarMaterials)
	materials[ 'Light_Indicator@light_indicator_l' ] = lightMat( 'Light_Indicator', 'indicatorLeft', R.Light_Indicator );
	materials[ 'Light_Indicator@light_indicator_r' ] = lightMat( 'Light_Indicator', 'indicatorRight', R.Light_Indicator );
	materials.Light_Indicator = materials[ 'Light_Indicator@light_indicator_l' ];

	// ---- 5. fine-grain surfaces (leather, soft plastics, carpet, alcantara): noise-perturbed normal, fades when sub-pixel --
	const grain = ( name ) => {

		const def = R[ name ];
		const m = def.class === 'MeshPhysicalNodeMaterial' ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
		m.name = name;
		m.color = col( def.color ); m.metalness = def.metalness; m.roughness = def.roughness;
		if ( def.sheen ) { m.sheen = def.sheen; m.sheenRoughness = def.sheenRoughness; m.sheenColor = col( def.sheenColor ); }
		const n = mx_noise_vec3( positionLocal.mul( def.grainScale ) );
		m.normalNode = bumpNormal( n.mul( float( def.grain ).mul( resolved( 1.5 / def.grainScale ) ) ) );
		m.aoNode = ao( def.ao, def.aoFloor );
		return m;

	};
	for ( const name of [ 'Interior_dark', 'Leather', 'Carpet', 'Seat_Fabric' ] ) materials[ name ] = grain( name );

	// ---- 6. carbon fibre: 2x2 twill, rounded tows, lacquered ---------------------------------------------------------------
	{

		const def = R.Carbon_Fiber;
		const m = new THREE.MeshPhysicalNodeMaterial();
		m.name = 'Carbon_Fiber';
		const c = planar.div( def.tow );
		const cell = floor( c ), f = fract( c );
		const warp = step( mod( cell.x.add( cell.y ), 4 ), 1.5 ); // 1 = the tow running along +v is on top
		const vis = resolved( def.tow, 0.7, 2.5 );
		const tilt = mix( vec2( 0, f.y.sub( 0.5 ).mul( 2 ) ), vec2( f.x.sub( 0.5 ).mul( 2 ), 0 ), warp ).mul( float( def.tilt ).mul( vis ) );
		m.colorNode = mix( vec3( col( def.colorA ) ).add( col( def.colorB ) ).mul( 0.5 ), mix( col( def.colorB ), col( def.colorA ), warp ), vis );
		m.normalNode = bumpNormal( lift( tilt ) );
		m.clearcoatNormalNode = normalViewGeometry;
		m.metalness = def.metalness; m.roughness = def.roughness; m.clearcoat = def.clearcoat; m.clearcoatRoughness = def.clearcoatRoughness;
		m.aoNode = ao( def.ao, def.aoFloor );
		materials.Carbon_Fiber = m;

	}

	// ---- 7. grille panels: diamond mesh on flat panels ---------------------------------------------------------------------
	{

		const def = R.Grille_Mesh;
		const m = new THREE.MeshStandardNodeMaterial();
		m.name = 'Grille_Mesh';
		const c = vec2( planar.x.add( planar.y ), planar.x.sub( planar.y ) ).div( def.cell * Math.SQRT2 ); // 45 deg lattice
		const f = abs( fract( c ).sub( 0.5 ) ).mul( 2 ); // 0 centre of a hole .. 1 on a wire
		const wire = smoothstep( 1 - def.wire * 1.4, 1 - def.wire * 0.6, max( f.x, f.y ) );
		const vis = resolved( def.cell, 0.6, 2.0 );
		const w = mix( float( def.wire * 1.6 ).saturate(), wire, vis ); // average coverage when the mesh is sub-pixel
		m.colorNode = mix( col( def.holeColor ), col( def.wireColor ), w );
		m.metalnessNode = w.mul( def.metalness );
		m.roughnessNode = mix( float( 1 ), float( def.roughness ), w );
		m.aoNode = ao( def.ao );
		materials.Grille_Mesh = m;

	}

	// ---- 8. exhaust tips: polished outside, sooty inside (driven by the baked AO) -------------------------------------------
	{

		const def = R.Exhaust_Tip;
		const m = new THREE.MeshStandardNodeMaterial();
		m.name = 'Exhaust_Tip';
		const clean = smoothstep( 0.18, 0.5, aoBaked );
		m.colorNode = mix( col( def.sootColor ), col( def.color ), clean );
		m.roughnessNode = mix( float( def.sootRoughness ), float( def.roughness ), clean );
		m.metalnessNode = clean.mul( def.metalness );
		m.aoNode = ao( def.ao );
		materials.Exhaust_Tip = m;

	}

	// ---- 9. tyres: tread tile + sidewall strip, selected by UV.y -----------------------------------------------------------
	{

		const def = R.Tires;
		const m = new THREE.MeshStandardNodeMaterial();
		m.name = 'Tires';
		const t = uv();
		const side = step( t.y, 0.25 ).add( step( 0.75, t.y ) ).saturate(); // 1 on both sidewalls
		const vS = select( t.y.lessThan( 0.5 ), t.y.mul( 4 ), t.y.oneMinus().mul( 4 ) ).saturate(); // bead 0 .. shoulder 1
		const sw = texture( textures.tireSidewall, vec2( t.x, vS ) );
		const tr = texture( textures.tireTread, vec2( t.x.mul( recipe.textures.tireTread.repeatsAround ), t.y.sub( 0.25 ).mul( 2 ) ) );
		m.normalNode = normalMap( mix( tr.rgb, sw.rgb, side ), mix( float( def.normalScaleTread ), float( def.normalScaleSidewall ), side ) );
		const cavity = mix( tr.a, float( 1 ), side ); // groove floors are darker
		const raised = sw.a.sub( 0.5 ).mul( 2 ).saturate().mul( side ); // lettering / ribs
		m.colorNode = vec3( col( def.color ) ).mul( mix( float( def.grooveDarkening ), float( 1 ), cavity ) );
		m.roughnessNode = mix( float( def.roughnessTread ), float( def.roughnessSidewall ), side ).sub( raised.mul( 0.12 ) );
		m.metalness = 0;
		m.aoNode = ao( def.ao );
		materials.Tires = m;

	}

	// ---- 10. rims: painted/lacquered alloy; UV.x = machined face mask, UV.y = centre cap mask -------------------------------
	{

		const def = R.Rim;
		const m = new THREE.MeshPhysicalNodeMaterial();
		m.name = 'Rim';
		u.rimFaceMix = uniform( def.faceMix );
		const mask = uv();
		const face = mask.x.mul( u.rimFaceMix ), cap = mask.y;
		m.colorNode = mix( mix( col( def.color ), col( def.faceColor ), face ), col( def.capColor ), cap );
		m.roughnessNode = mix( mix( float( def.roughness ), float( def.faceRoughness ), face ), float( def.capRoughness ), cap );
		m.metalnessNode = mix( float( def.metalness ), float( def.capMetalness ), cap );
		m.clearcoat = def.clearcoat; m.clearcoatRoughness = def.clearcoatRoughness;
		m.aoNode = ao( def.ao );
		materials.Rim = m;

	}

	// ---- 11. brake discs: cross-drilled + brushed, procedural in wheel-local polar coordinates ------------------------------
	{

		const def = R.Brake_Disc;
		const m = new THREE.MeshStandardNodeMaterial();
		m.name = 'Brake_Disc';
		const p = positionLocal;
		const r = length( p.yz ), ang = atan( p.z, p.y );
		const rOut = uv().x; // constant per disc (written by the build)
		const band = smoothstep( rOut.sub( 0.068 ), rOut.sub( 0.062 ), r ).mul( smoothstep( rOut.sub( 0.004 ), rOut.sub( 0.009 ), r ) );
		const flat = smoothstep( 0.9, 0.98, normalLocal.x.abs() );
		const a = ang.div( Math.PI * 2 ).mul( def.holes );
		let hole = float( 0 );
		for ( let k = 0; k < 4; k ++ ) {

			const da = fract( a.add( k * 0.27 ) ).sub( 0.5 ).mul( Math.PI * 2 / def.holes ).mul( r );
			const dr = r.sub( rOut.sub( 0.015 + k * 0.0135 ) );
			hole = max( hole, smoothstep( 0.0036, 0.0027, sqrt( da.mul( da ).add( dr.mul( dr ) ) ) ) );

		}

		hole = hole.mul( band ).mul( flat ).mul( resolved( 0.006, 0.5, 1.5 ) );
		const brushed = mx_noise_float( vec3( r.mul( 1500 ), 0.5, 0.5 ) ).mul( band ).mul( flat );
		m.colorNode = mix( vec3( col( def.color ) ).mul( mix( float( 0.55 ), float( 1 ), band ) ).mul( brushed.mul( 0.25 ).add( 1 ) ), col( def.holeColor ), hole );
		m.roughnessNode = mix( float( def.roughness ).add( brushed.mul( 0.12 ) ), float( 1 ), hole );
		m.metalnessNode = mix( float( def.metalness ), float( 0 ), hole );
		m.aoNode = ao( def.ao );
		materials.Brake_Disc = m;

	}

	// ---- 12. brake calipers: glossy paint, colour comes with the paint preset ----------------------------------------------
	{

		const def = R.Brake_Caliper;
		const m = new THREE.MeshPhysicalNodeMaterial();
		m.name = 'Brake_Caliper';
		u.caliperColor = uniform( new THREE.Color( '#e3a800' ) );
		m.colorNode = u.caliperColor;
		m.metalness = def.metalness; m.roughness = def.roughness; m.clearcoat = def.clearcoat; m.clearcoatRoughness = def.clearcoatRoughness;
		m.aoNode = ao( def.ao );
		materials.Brake_Caliper = m;

	}

	// ---- runtime API ---------------------------------------------------------------------------------------------------
	function setPaint( name ) {

		const p = recipe.paints[ name ];
		if ( ! p ) throw new Error( 'unknown paint ' + name );
		u.paintColor.value.set( p.color ); u.paintFlop.value.set( p.flopColor ); u.paintFlopAmount.value = p.flop;
		u.paintMetalness.value = p.metalness; u.paintRoughness.value = p.roughness;
		u.paintClearcoat.value = p.clearcoat; u.paintClearcoatRoughness.value = p.clearcoatRoughness;
		u.paintFlake.value = p.flake; u.paintFlakeScale.value = p.flakeScale; u.paintBaseSpecular.value = p.baseSpecular ?? 1;
		u.caliperColor.value.set( p.caliper );

	}

	// state: { drl, head, tail, brake, reverse, fog, indl, indr } booleans / 0..1
	function setLights( s ) {

		u.drl.value = ( s.drl ? 1 : 0 ) * L.drl.on;
		u.headlight.value = ( s.head ? 1 : 0 ) * L.headlight.on;
		u.tail.value = s.brake ? L.tail.brake : ( s.tail || s.head ? L.tail.tail : 0 );
		u.brakeHigh.value = s.brake ? L.brakeHigh.on : 0;
		u.reverse.value = s.reverse ? L.reverse.on : 0;
		u.fogRear.value = s.fog ? L.fogRear.on : 0;
		u.indicatorLeft.value = s.indl ? L.indicatorLeft.on : 0;
		u.indicatorRight.value = s.indr ? L.indicatorRight.on : 0;

	}

	setPaint( recipe.defaultPaint );
	setLights( {} );
	return { materials, uniforms: u, setPaint, setLights };

}

// Replace the materials of a loaded car (LOD0 or LOD1) by the recipe materials, matched by glTF material name.
export function applyCarMaterials( root, set ) {

	const missing = new Set();
	root.traverse( ( o ) => {

		if ( ! o.isMesh ) return;
		const name = o.material.name;
		const m = set.materials[ `${name}@${o.name}` ] || set.materials[ name ];
		if ( ! m ) { missing.add( name ); return; }
		o.material = m;
		o.castShadow = ! m.transparent;
		o.receiveShadow = ! m.transparent;

	} );
	return [ ...missing ];

}
