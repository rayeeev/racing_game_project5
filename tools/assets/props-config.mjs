// Asset definitions for tools/assets/props-build.mjs  (source: Poly Haven CC0 glTF packages in assets-src/props/<id>/).
//
// asset:   { id, src, author, placement, textureResolution, materials?, materialAlias?, dropMaterials?, paint?, extra?, variants[] }
//   materials[outputName]: { from? (source material whose textures are used), size?, doubleSided?, alphaMap?, alphaMode?, alphaCutoff?,
//                            fill? (false = no island dilation, for tiling textures), emissiveFromBase?, noTextures?, *Factor overrides, meta? }
//   paint[sourceMaterial]:  { base?, orm?, normal? }  async hooks ( { data, size, masks, loadGrey } ) editing the native-resolution RGB pixels
// variant: { name, parts[], xform?, pivot?, lods[], collider, dynamic, mass?, sink?, placement?, extra?, notes? }
//   parts:  { node: 'exact name' | RegExp, matrix? (replaces the node world matrix), post? (applied after the world matrix), exclude?: RegExp[] }
//   pivot:  { x?, y?, z? } in source ("kit") coordinates after xform; defaults: bbox centre x/z, bbox min y
//   lods:   [ { tris, error?, prune?, protect?: [material], exclude?: RegExp[], weights?: { material: factor } }, ... ]
//   extra:  object or ( { toLocal, bounds, pivot } ) => object   merged into the index.json variant entry (toLocal maps kit coords -> variant frame)
import { mat4, dilateMask } from './props-lib.mjs';

export const CATEGORY = 'props';

const T = mat4.translation, RX = mat4.rotationX, RY = mat4.rotationY, RZ = mat4.rotationZ, chain = mat4.chain;
// Simplifier settings found by experiment (tools/assets/props-config-exp.mjs): permissive collapses + strong UV weight keep
// hard-surface props clean; position-only or weak UV weights smear the texture atlas, stronger UV weights wreck thin tubes.
const SIMPLIFY = { normalWeight: 0.2, uvWeight: 1, permissive: true };
const lods = ( l0, l1, o0 = {}, o1 = {} ) => [ { tris: l0, errorAbs: 0.05, ...SIMPLIFY, ...o0 }, { tris: l1, errorAbs: 0.08, prune: true, ...SIMPLIFY, ...o1 } ];

// warm halogen / sodium-ish defaults suggested to the runtime for night / dusk presets
const WARM = '#ffd7a1';
const HALOGEN = '#fff1d6';

export const ASSETS = [

	// ------------------------------------------------------------------------------------------ ROADSIDE
	{
		id: 'concrete_road_barrier', src: 'concrete_road_barrier_2k.gltf', author: 'Amal Kumar', placement: 'roadside', textureResolution: 1024,
		materials: { concrete_road_barrier: { doubleSided: false } },
		variants: [ {
			name: 'barrier', parts: [ { node: 'concrete_road_barrier' } ], lods: lods( 4000, 800 ),
			collider: 'box', dynamic: false, mass: 1400, sink: 0.02,
			extra: { module: { axis: 'x', step: 1.6 } },
			notes: 'Painted (black/white) concrete road block with a symmetric Jersey profile (0.64 m base, 0.16 m top, 0.83 m high), long axis = X. Place in rows with 1.6 m spacing (5 cm gaps) and align to the road surface; static (about 1400 kg).',
		} ],
	},

	{
		id: 'modular_electricity_poles', src: 'modular_electricity_poles_2k.gltf', author: 'James Ray Cock', placement: 'roadside', textureResolution: 1024,
		materials: { modular_electricity_poles: { doubleSided: false }, modular_electricity_poles_pieces: { doubleSided: true } },
		variants: [ 1, 2, 3 ].map( ( n ) => {

			const x = [ - 2.5, - 4.5, - 6.5 ][ n - 1 ];
			const upper = n === 3 ? [ - 0.7, - 0.25, 0.2 ] : [ - 0.45, 0, 0.45 ];
			const lowerZ = n === 3 ? - 0.115 : 0.115;
			const small = /bolt|nail|nut|ring|cap$|fastener/;
			return {
				name: [ 'pole_transformer', 'pole_plain', 'pole_offset' ][ n - 1 ],
				parts: [ { node: new RegExp( `^preset_0${n}_` ) } ],
				pivot: { x, z: 0, y: 0 },
				lods: lods( 9000, 1600, { protect: [ 'modular_electricity_poles' ] }, { exclude: [ small ], weights: { modular_electricity_poles: 2.5 } } ),
				collider: { type: 'cylinder', radius: 0.09, halfHeight: 3, center: [ 0, 3, 0 ] }, dynamic: false, sink: 0.08,
				extra: {
					wireAnchors: {
						upper: upper.map( ( dx ) => [ dx, 5.835, 0.115 ] ),
						lower: [ - 0.2, 0.2 ].map( ( dx ) => [ dx, 4.735, lowerZ ] ),
					},
				},
				notes: [
					'6 m wooden distribution pole, upper 1.2 m cross-arm (3 insulators) + lower 0.7 m cross-arm (2 insulators), transformer can, fuse cut-outs and a guy wire anchored 1.5 m away on -Z.',
					'6 m wooden distribution pole with two clean cross-arms (3 + 2 insulators), no transformer.',
					'6 m wooden distribution pole, upper cross-arm offset to -X, transformer can + fuse cut-out.',
				][ n - 1 ] + ' Cross-arms run along X, conductors therefore along Z: orient local Z along the road. No wires in the model: span catenaries between wireAnchors of consecutive poles (3 upper + 2 lower on every variant).',
			};

		} ),
	},

	{
		id: 'street_lamp_01', src: 'street_lamp_01_2k.gltf', author: 'Josh Dean', placement: 'paddock', textureResolution: 1024,
		dropMaterials: [ 'street_lamp_01_bulb' ],
		// The source lantern has clear BLEND glass (not allowed) - the panes become opaque opal glass instead: the frosted colour
		// (with the grime of the source opacity map) is painted into the pane islands of the shared atlas, and the panes get
		// their own material so they can glow at dusk (emissive texture = base colour, emissive factor 0 by default).
		materials: {
			street_lamp_01: { doubleSided: true },
			street_lamp_01_glass: { from: 'street_lamp_01', emissiveFromBase: true, doubleSided: true, meta: { emissive: true, emissiveColor: WARM } },
		},
		paint: { street_lamp_01: {
			base: async ( { data, size, masks, loadGrey } ) => {

				const glass = dilateMask( masks.get( 'street_lamp_01_glass' ), size, 3 );
				const opacity = await loadGrey( 'extra/street_lamp_01_opacity_2k.png' );
				const frost = [ 214, 210, 198 ];
				for ( let i = 0; i < size * size; i ++ ) {

					if ( ! glass[ i ] ) continue;
					const t = Math.min( 1, Math.max( 0, ( opacity[ i ] / 255 - 0.25 ) / 0.5 ) ); // 0 = clean glass, 1 = grime
					const k = t * t * ( 3 - 2 * t ) * 0.85;
					for ( let c = 0; c < 3; c ++ ) data[ i * 3 + c ] = Math.round( frost[ c ] * ( 1 - k ) + Math.min( 255, data[ i * 3 + c ] * 1.6 ) * k );

				}

			},
			orm: async ( { data, size, masks, loadGrey } ) => {

				const glass = dilateMask( masks.get( 'street_lamp_01_glass' ), size, 3 );
				const opacity = await loadGrey( 'extra/street_lamp_01_opacity_2k.png' );
				for ( let i = 0; i < size * size; i ++ ) {

					if ( ! glass[ i ] ) continue;
					const t = Math.min( 1, Math.max( 0, ( opacity[ i ] / 255 - 0.25 ) / 0.5 ) );
					data[ i * 3 ] = 255; // no baked occlusion on the panes
					data[ i * 3 + 1 ] = Math.round( 255 * ( 0.22 + 0.5 * t ) ); // glossy opal glass, grime is rough
					data[ i * 3 + 2 ] = 0; // dielectric

				}

			},
		} },
		variants: [ {
			name: 'lamp', parts: [ { node: 'street_lamp_01' } ], pivot: { x: 0, z: 0, y: 0 },
			lods: lods( 6000, 1300, { protect: [ 'street_lamp_01_glass' ] }, { protect: [ 'street_lamp_01_glass' ] } ),
			collider: { type: 'cylinder', radius: 0.09, halfHeight: 1.55, center: [ 0, 1.55, 0 ] }, dynamic: false, sink: 0.02,
			extra: { lights: [ { type: 'point', position: [ 0, 3.3, 0 ], color: WARM, range: 14 } ] },
			notes: 'Cast-iron lantern post, 3.87 m. The lantern panes are opaque opal glass with their own material (street_lamp_01_glass, same textures as the post): set its emissive colour/intensity to light the lamp, and add a point light at lights[0].',
		} ],
	},

	{
		id: 'utility_box_02', src: 'utility_box_02_2k.gltf', author: 'James Ray Cock', placement: 'roadside', textureResolution: 1024,
		materials: { utility_box_02: { doubleSided: true } },
		variants: [ {
			name: 'cabinet', parts: [ { node: 'utility_box_02' } ], lods: lods( 5000, 1000 ),
			collider: 'box', dynamic: false, mass: 120, sink: 0.01,
			notes: 'Green electrical distribution cabinet (doors face +Z). Put next to poles / at the paddock entrance.',
		} ],
	},

	{
		id: 'old_tyre', src: 'old_tyre_2k.gltf', author: 'MP', placement: 'roadside', textureResolution: 512,
		materials: { old_tyre: { doubleSided: false } },
		variants: [
			{
				name: 'tyre', parts: [ { node: 'old_tyre' } ], xform: RX( 90 ), lods: lods( 2000, 560 ),
				collider: 'cylinder', dynamic: true, mass: 9,
				notes: 'Single worn car tyre lying flat (0.60 m diameter, 0.165 m wide). Stack 3-5 as separate dynamic bodies for corner protection.',
			},
			{
				name: 'tyre_stack4',
				parts: [ 0, 1, 2, 3 ].map( ( k ) => ( { node: 'old_tyre', matrix: chain( T( [ 0, 0.018, - 0.014, 0.016 ][ k ], 0.0825 + k * 0.163, [ 0, - 0.016, 0.02, 0.006 ][ k ] ), RY( [ 0, 67, 151, 233 ][ k ] ), RX( 90 ) ) } ) ),
				pivot: { x: 0, z: 0 },
				lods: lods( 5200, 1600 ),
				collider: 'cylinder', dynamic: true, mass: 36,
				notes: 'Four tyres pre-stacked into one mesh (0.65 m high) for cheap tyre walls: one rigid body (36 kg) or static. For stacks that can scatter, spawn 4 x "tyre" instead.',
			},
		],
	},

	{
		id: 'covered_car', src: 'covered_car_2k.gltf', author: 'MP', placement: 'roadside', textureResolution: 2048,
		materials: { covered_car: { doubleSided: true } },
		variants: [ {
			name: 'car', parts: [ { node: /^covered_car/ } ], lods: lods( 12592, 2600 ),
			collider: { type: 'box', halfExtents: [ 0.87, 0.62, 2.15 ], center: [ 0, 0.72, 0 ] }, dynamic: false, mass: 1250, sink: 0,
			notes: 'Saloon car under a dusty tarpaulin, length along Z (4.38 m), bonnet towards +Z. Park it in a lay-by or behind the paddock; static obstacle.',
		} ],
	},

	// ------------------------------------------------------------------------------------------ PADDOCK
	{
		id: 'Barrel_01', src: 'Barrel_01_2k.gltf', author: 'Jorge Camacho', placement: 'paddock', textureResolution: 1024,
		materials: { Barrel_01: { doubleSided: false } },
		variants: [ {
			name: 'barrel', parts: [ { node: 'Barrel_01' } ], lods: lods( 2682, 640 ),
			collider: 'cylinder', dynamic: true, mass: 18,
			notes: 'Red 200 l steel drum with hazard decal (empty: 18 kg; use ~200 kg if it should feel full).',
		} ],
	},

	{
		id: 'barrel_03', src: 'barrel_03_2k.gltf', author: 'Serhii Khromov', placement: 'paddock', textureResolution: 1024,
		materials: { barrel_03: { doubleSided: false } },
		variants: [ {
			name: 'barrel', parts: [ { node: 'barrel_03' } ], lods: lods( 1473, 460 ),
			collider: 'cylinder', dynamic: true, mass: 18,
			notes: 'Blue 200 l steel drum (empty: 18 kg). Mix with Barrel_01 for corner markers / paddock clutter.',
		} ],
	},

	{
		// texel density of this kit is 2-3x that of the other props (1180 px/m at 1024), so 512 px maps are plenty
		id: 'flood_lights', src: 'flood_lights_2k.gltf', author: 'James Ray Cock', placement: 'paddock', textureResolution: 512,
		materials: {
			flood_lights: { size: 512, doubleSided: true },
			// source glass is BLEND + transmission -> shipped as opaque dusty glass; emissive texture = base colour so the heads can be lit
			flood_lights_glass: { size: 256, doubleSided: false, metallicFactor: 0, emissiveFromBase: true, meta: { emissive: true, emissiveColor: HALOGEN } },
		},
		variants: [
			{
				name: 'tripod_double', parts: [ { node: /^flood_lights_standing_double_a_/ } ], pivot: { x: - 2, z: 0, y: 0 },
				lods: lods( 6000, 1200 ),
				collider: { type: 'cylinder', radius: 0.3, halfHeight: 0.89, center: [ 0, 0.89, 0 ] }, dynamic: true, mass: 9,
				extra: ( { toLocal } ) => ( { lights: [ [ - 2.2, 1.569, 0.09 ], [ - 1.8, 1.569, 0.09 ] ].map( ( p ) => ( { type: 'spot', position: toLocal( p ), direction: [ 0, - 0.05, 1 ], color: HALOGEN, angleDeg: 100, range: 30 } ) ) } ),
				notes: 'Yellow work-light tripod with two halogen heads (1.79 m), heads face +Z. Glass fronts are material flood_lights_glass (opaque, emissive-ready).',
			},
			{
				name: 'tripod_single', parts: [ { node: /^flood_lights_standing_single_/ } ], pivot: { x: 1, z: 0, y: 0 },
				lods: lods( 4200, 850 ),
				collider: { type: 'cylinder', radius: 0.3, halfHeight: 0.83, center: [ 0, 0.83, 0 ] }, dynamic: true, mass: 7,
				extra: ( { toLocal } ) => ( { lights: [ { type: 'spot', position: toLocal( [ 1, 1.569, 0.09 ] ), direction: [ 0, - 0.05, 1 ], color: HALOGEN, angleDeg: 100, range: 30 } ] } ),
				notes: 'Work-light tripod with one halogen head (1.66 m), head faces +Z.',
			},
			{
				name: 'floor_double', parts: [ { node: /^flood_lights_floor_double_a_/ } ], pivot: { x: - 2, z: 1, y: 0 },
				lods: lods( 3600, 720 ),
				collider: 'box', dynamic: true, mass: 5,
				extra: ( { toLocal } ) => ( { lights: [ [ - 2.2, 0.21, 1.09 ], [ - 1.8, 0.21, 1.09 ] ].map( ( p ) => ( { type: 'spot', position: toLocal( p ), direction: [ 0, 0.12, 1 ], color: HALOGEN, angleDeg: 100, range: 20 } ) ) } ),
				notes: 'Floor-standing twin halogen work light (0.42 m high), heads face +Z.',
			},
		],
	},

	{
		id: 'portable_generator', src: 'portable_generator_2k.gltf', author: 'James Ray Cock', placement: 'paddock', textureResolution: 1024,
		dropMaterials: [ 'portable_generator_glass' ],
		materials: { portable_generator: { doubleSided: true } },
		variants: [ {
			name: 'generator', parts: [ { node: /^portable_generator/ } ], lods: lods( 6000, 1200 ),
			collider: 'box', dynamic: true, mass: 45,
			notes: 'Yellow 2.5 kVA petrol generator in a tube frame (control panel faces +Z). Pair with flood_lights.',
		} ],
	},

	{
		id: 'tool_cart', src: 'tool_cart_2k.gltf', author: 'Savva Zakharov', placement: 'paddock', textureResolution: 1024,
		materials: { tool_cart: { doubleSided: true } },
		variants: [ {
			name: 'cart', parts: [ { node: 'tool_cart' } ], lods: lods( 6000, 1200 ),
			collider: 'box', dynamic: true, mass: 40,
			notes: 'Green steel workshop trolley with two drawers on castors (1.27 x 0.75 x 0.97 m).',
		} ],
	},

	{
		id: 'plastic_crate_02', src: 'plastic_crate_02_2k.gltf', author: 'Fabi_G', placement: 'paddock', textureResolution: 1024,
		materials: { plastic_crate_02: { alphaMap: 'extra/plastic_crate_02_opacity_2k.png', alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: false } },
		variants: [ {
			name: 'crate', parts: [ { node: 'plastic_crate_02' } ], lods: lods( 5840, 1400 ),
			collider: 'box', dynamic: true, mass: 1.8,
			notes: 'Orange stackable plastic crate (0.51 x 0.41 x 0.25 m), ventilation slots are alpha-masked. Stack 2-4 as separate dynamic bodies.',
		} ],
	},

	{
		id: 'metal_trash_can', src: 'metal_trash_can_2k.gltf', author: 'GurJas Studios', placement: 'paddock', textureResolution: 1024,
		materials: { metal_trash_can: { doubleSided: false }, metal_trash_can_rust: { doubleSided: false } },
		variants: [
			{
				name: 'can_closed',
				parts: [ { node: 'metal_trash_can' }, { node: /^metal_trash_can_handle_/ }, { node: 'metal_trash_can_lid', matrix: T( 0.5, 0.9, 0 ) } ],
				pivot: { x: 0.5, z: 0, y: 0 },
				lods: lods( 5000, 1000 ),
				collider: { type: 'cylinder', radius: 0.285, halfHeight: 0.49, center: [ 0, 0.49, 0 ] }, dynamic: true, mass: 8,
				notes: 'Galvanised steel dustbin with the lid on (0.98 m). Paddock, lay-bys, picnic spot.',
			},
			{
				name: 'can_rusty_open',
				parts: [ { node: 'metal_trash_can_rust' }, { node: /^metal_trash_can_rust_handle_/ }, { node: 'metal_trash_can_rust_lid' } ],
				pivot: { x: - 0.5, z: 0, y: 0 },
				lods: lods( 5000, 1000 ),
				collider: { type: 'cylinder', radius: 0.285, halfHeight: 0.453, center: [ 0, 0.453, 0 ] }, dynamic: true, mass: 8,
				notes: 'Rusty dustbin, open, with its lid leaning against the side (lid at -X). The collider covers the bin only.',
			},
		],
	},

	{
		id: 'modular_chainlink_fence', src: 'modular_chainlink_fence_2k.gltf', author: 'James Ray Cock (fence wire material: Amal Kumar)', placement: 'paddock', textureResolution: 1024,
		materials: {
			modular_chainlink_fence_posts: { doubleSided: true },
			// tiling texture (no islands to dilate). alphaCutoff 0.2: the wire covers only 16 % of the texture, so with the usual 0.5 the
			// mip-averaged alpha drops below the cutoff after ~2 mips and the mesh vanishes 8 m away; 0.2 keeps it visible to ~25 m.
			modular_chainlink_fence_wire: { alphaMap: 'extra/modular_chainlink_fence_wire_opacity_2k.png', alphaMode: 'MASK', alphaCutoff: 0.2, doubleSided: true, fill: false, meta: { thinAlpha: true } },
		},
		variants: ( () => {

			const W = 'modular_chainlink_fence_wire';
			const fenceCollider = ( half ) => ( { type: 'box', halfExtents: [ half, 1.262, 0.04 ], center: [ 0, 1.262, 0 ] } );
			return [
				{
					name: 'panel_2m',
					parts: [ { node: 'modular_chainlink_post_middle', post: T( - 2, 0, 1 ) }, { node: 'modular_chainlink_fence_double', post: T( 1, 0, 0 ) } ],
					pivot: { x: 0, y: 0, z: 0 },
					lods: lods( 3000, 560, { protect: [ W ] }, { protect: [ W ] } ),
					collider: fenceCollider( 1 ), dynamic: false,
					extra: { module: { axis: 'x', step: 2, postAt: - 1 } },
					notes: '2 m chain-link module: post at x=-1 plus a 1.91 m mesh panel centred on the pivot (mesh on the +Z face). Chain along X every 2.0 m and close the run with a "post".',
				},
				{
					name: 'panel_1m',
					parts: [ { node: 'modular_chainlink_post_middle', post: T( - 1.5, 0, 1 ) }, { node: 'modular_chainlink_fence', post: T( 2.5, 0, 0 ) } ],
					pivot: { x: 0, y: 0, z: 0 },
					lods: lods( 2600, 500, { protect: [ W ] }, { protect: [ W ] } ),
					collider: fenceCollider( 0.5 ), dynamic: false,
					extra: { module: { axis: 'x', step: 1, postAt: - 0.5 } },
					notes: '1 m chain-link module: post at x=-0.5 plus a 0.93 m mesh panel. Use to adjust run lengths.',
				},
				{
					name: 'gate_2m',
					parts: [
						{ node: 'modular_chainlink_post_middle', post: T( - 2, 0, 1 ) },
						{ node: 'modular_chainlink_fence_door_frame', post: T( - 1, 0, 0 ) },
						{ node: 'modular_chainlink_fence_door_gate', post: T( - 1, 0, 0 ) },
						{ node: 'modular_chainlink_fence_door_latch', post: T( - 1, 0, 0 ) },
					],
					pivot: { x: 0, y: 0, z: 0 },
					lods: lods( 6000, 1100, { protect: [ W ] }, { protect: [ W ] } ),
					collider: fenceCollider( 1 ), dynamic: false,
					extra: { module: { axis: 'x', step: 2, postAt: - 1 } },
					notes: '2 m module with a closed 0.95 m personnel gate (same footprint as panel_2m).',
				},
				{
					name: 'corner',
					parts: [ { node: 'modular_chainlink_fence_corner_outer' } ],
					pivot: { x: - 4, y: 0, z: 0 },
					lods: lods( 4500, 900, { protect: [ W ] }, { protect: [ W ] } ),
					collider: { type: 'box', halfExtents: [ 0.56, 1.262, 0.56 ], center: [ 0.48, 1.262, - 0.48 ] }, dynamic: false,
					notes: 'Braced corner: corner post at the pivot, 1 m of mesh towards +X and 1 m towards -Z with diagonal stays. The next posts belong at (1,0,0) and (0,0,-1).',
				},
				{
					name: 'post',
					parts: [ { node: 'modular_chainlink_post_middle', post: T( - 1, 0, 1 ) } ],
					pivot: { x: 0, y: 0, z: 0 },
					lods: lods( 1300, 260 ),
					collider: { type: 'cylinder', radius: 0.075, halfHeight: 1.262, center: [ 0, 1.262, 0 ] }, dynamic: false,
					notes: 'Single 2.52 m galvanised post with clamps: terminates a run of panel modules.',
				},
			];

		} )(),
	},

	// ------------------------------------------------------------------------------------------ LAKESIDE
	{
		id: 'modular_wooden_pier', src: 'modular_wooden_pier_2k.gltf', author: 'Rico Cilliers', placement: 'lake', textureResolution: 2048,
		materials: {
			modular_wooden_pier_planks: { size: 2048, doubleSided: false },
			modular_wooden_pier_poles: { size: 1024, doubleSided: true },
		},
		variants: ( () => {

			// common vertical datum for the deck sections: kit y = -0.994 (lowest pile tip) -> deck top at 3.66 m above the pivot
			const Y0 = - 0.994;
			// deckY: walking surface; waterlineY: recommended water level (deck 0.9 m above the water); shoreZ: local z where the
			// ramp surface meets that water level (the last metre of the ramp towards -Z belongs inside the bank).
			const pierExtra = ( { toLocal } ) => ( { deckY: toLocal( [ 0, 2.66, 0 ] )[ 1 ], waterlineY: toLocal( [ 0, 1.76, 0 ] )[ 1 ], shoreZ: toLocal( [ 0, 0, - 11.05 ] )[ 2 ] } );
			return [
				{
					name: 'pier_long',
					parts: [ { node: /^modular_wooden_pier_section_0[1-5]$/ } ],
					pivot: { x: 0.03, y: Y0 },
					lods: lods( 15000, 3000 ),
					collider: { type: 'box', halfExtents: [ 1.3, 2.33, 6.2 ], center: [ 0, 2.33, 0 ] }, dynamic: false,
					extra: pierExtra,
					notes: 'Old timber jetty, 12.4 m long along Z, 2.5 m wide: shore ramp at -Z (descends 1.6 m below deck level over 3 m), three deck bays, a 7 m rope gantry and the jetty head at +Z. Place with pivot.y = waterLevel - waterlineY (deck about 0.9 m above the water) and local z = shoreZ on the shoreline, +Z pointing out onto the lake; the shore terrain swallows the last metre of the ramp. Piles reach 3.7 m below the deck. The collider is a simple blocking volume (whole footprint up to the pile tops), not a drivable deck.',
				},
				{
					name: 'pier_short',
					parts: [
						{ node: 'modular_wooden_pier_section_04' }, { node: 'modular_wooden_pier_section_03' },
						{ node: 'modular_wooden_pier_section_01', post: T( 0, 0, - 2.914 ) },
					],
					pivot: { x: 0.03, y: Y0 },
					lods: lods( 9000, 1800 ),
					collider: { type: 'box', halfExtents: [ 1.3, 2.33, 4.75 ], center: [ 0, 2.33, 0 ] }, dynamic: false,
					extra: pierExtra,
					notes: 'Shorter 9.5 m jetty: shore ramp (-Z), one deck bay and the jetty head (+Z). Same vertical datum and placement rule (waterlineY, shoreZ) as pier_long.',
				},
				{
					name: 'mooring_piles',
					parts: [ { node: 'modular_wooden_pier_poles' } ],
					lods: lods( 2460, 500 ),
					collider: 'none', dynamic: false,
					extra: ( { toLocal } ) => ( { waterlineY: toLocal( [ 0, 1.76, 0 ] )[ 1 ] } ),
					notes: 'Three loose mooring piles (3.85 m long) to scatter next to the jetty; pivot.y = waterLevel - waterlineY keeps them consistent with the pier variants.',
				},
			];

		} )(),
	},

	{
		id: 'wooden_picnic_table', src: 'wooden_picnic_table_2k.gltf', author: 'Ulan Cabanilla', placement: 'lake', textureResolution: 1024,
		materialAlias: { wooden_picnic_table_table: 'wooden_picnic_table_top' },
		materials: {
			wooden_picnic_table_top: { from: 'wooden_picnic_table_table', doubleSided: true },
			wooden_picnic_table_bottom: { doubleSided: true },
		},
		variants: [ {
			name: 'table', parts: [ { node: 'wooden_picnic_table' } ], lods: lods( 6000, 1200 ),
			collider: { type: 'box', halfExtents: [ 1.12, 0.373, 1.51 ], center: [ 0, 0.373, 0 ] }, dynamic: false, mass: 90,
			notes: 'Weathered park picnic table with attached benches - a large 10 ft model: 3.0 m long (Z) x 2.24 m wide (X) over the benches, table top at 0.75 m. Needs flat ground (lake shore meadow, lay-by viewpoint).',
		} ],
	},

];
