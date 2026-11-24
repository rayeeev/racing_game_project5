// Experiment config (simplifier settings comparison) - built into assets-src/props/_exp, never shipped.
//   node tools/assets/props-build.mjs --config ./props-config-exp.mjs --out assets-src/props/_exp --url-prefix /assets-src/props/_exp
export const CATEGORY = 'props';
const settings = {
	C: { normalWeight: 0.2, uvWeight: 1.0, permissive: true },
	F: { normalWeight: 0.2, uvWeight: 2.0, permissive: true },
	G: { normalWeight: 0.2, uvWeight: 4.0, permissive: true },
	H: { normalWeight: 0.5, uvWeight: 2.0, permissive: true },
	I: { normalWeight: 0.2, uvWeight: 1.0, permissive: true, regularize: true },
};
const mk = ( base, parts, l0, l1, extra = {} ) => Object.entries( settings ).map( ( [ k, s ] ) => ( {
	name: `${base}_${k}`, parts, lods: [ { tris: l0, errorAbs: 0.05, ...s }, { tris: l1, errorAbs: 0.08, prune: true, ...s } ], collider: 'box', dynamic: false, ...extra,
} ) );
export const ASSETS = [
	{ id: 'portable_generator', src: 'portable_generator_2k.gltf', author: 'x', placement: 'paddock', textureResolution: 1024, dropMaterials: [ 'portable_generator_glass' ],
		materials: { portable_generator: { doubleSided: true } }, variants: mk( 'gen', [ { node: /^portable_generator/ } ], 6000, 1200 ) },
	{ id: 'tool_cart', src: 'tool_cart_2k.gltf', author: 'x', placement: 'paddock', textureResolution: 1024,
		materials: { tool_cart: { doubleSided: true } }, variants: mk( 'cart', [ { node: 'tool_cart' } ], 6000, 1200 ) },
	{ id: 'modular_wooden_pier', src: 'modular_wooden_pier_2k.gltf', author: 'x', placement: 'lake', textureResolution: 1024,
		materials: { modular_wooden_pier_planks: { doubleSided: true }, modular_wooden_pier_poles: { doubleSided: true } },
		variants: mk( 'sec', [ { node: 'modular_wooden_pier_section_01' } ], 4500, 900 ) },
];
