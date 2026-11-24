// Asset list + processing parameters for the rocks pipeline (tools/assets/rocks-build.mjs).
// All sources are Poly Haven CC0 models downloaded with tools/assets/rocks-fetch.mjs into assets-src/rocks/<id>/.

const SRC = 'assets-src/rocks';

/** Common albedo grading target (OKLab) - "weathered alpine grey granite / gneiss". See rocks-tex.mjs gradeRock(). */
export const GRADE_TARGET = {
	L: 0.535, // mean OKLab lightness of rock texels (~ sRGB 110, linear luminance ~0.15)
	lightnessPull: 0.7, // 0 = keep the source brightness, 1 = force every asset to exactly L
	chroma: 0.0175, // mean rock chroma (warm-neutral grey)
	hue: 78, // mean rock hue in degrees (slightly yellowish warm grey)
	maxHueShift: 30,
	maxChromaGain: 1,
	greenResidual: 1.0, // chroma offsets towards green (moss, lichen) relative to the rock tint are kept
	redResidual: 0.5, // offsets towards red / pink (iron stains, pink feldspar) are halved
};

/** LOD triangle budgets per class (LOD0, LOD1, LOD2). */
export const LOD_BUDGETS = {
	boulder: [ 12000, 3000, 600 ],
	medium: [ 4000, 1000, 250 ],
	small: [ 1500, 300 ],
	cliff: [ 40000, 10000, 2000 ],
	setpiece: [ 60000, 12000, 2500 ],
};

const tex = ( id, res, kind ) => `${SRC}/${id}/textures/${id}_${kind}_${res}.jpg`;

export const ASSETS = [
	// ------------------------------------------------------------ large boulders (2k)
	{
		id: 'rock_moss_set_01', class: 'boulder', author: 'Kless Gyzen', textureSize: 2048,
		gltf: `${SRC}/rock_moss_set_01/rock_moss_set_01_4k.gltf`,
		maps: {
			baseColor: tex( 'rock_moss_set_01', '4k', 'diff' ), normal: tex( 'rock_moss_set_01', '4k', 'nor_gl' ),
			// the published "arm" map of this asset belongs to another UV layout (AO channel does not match) -> use the separate AO + roughness maps
			ao: `${SRC}/rock_moss_set_01__maps/rock_moss_set_01_ao_4k.jpg`, rough: tex( 'rock_moss_set_01', '4k', 'rough' ),
		},
		notes: 'Mossy boulder, closed mesh. Authored half-buried: sink = burial depth of the source scene (reads as an embedded outcrop about 0.7-1.1 m high); use the lower end of sinkRange for a free-standing boulder.',
		variants: [
			{ name: 'rock_moss_set_01_a', node: 'rock_moss_set_01_rock01', sinkRange: [ 0.2, 0.66 ] },
			{ name: 'rock_moss_set_01_b', node: 'rock_moss_set_01_rock02', sinkRange: [ 0.15, 0.47 ] },
			{ name: 'rock_moss_set_01_c', node: 'rock_moss_set_01_rock03', sinkRange: [ 0.15, 0.41 ] },
			{ name: 'rock_moss_set_01_d', node: 'rock_moss_set_01_rock04', sinkRange: [ 0.2, 0.66 ] },
			{ name: 'rock_moss_set_01_e', node: 'rock_moss_set_01_rock05', sinkRange: [ 0.15, 0.57 ] },
			{ name: 'rock_moss_set_01_f', node: 'rock_moss_set_01_rock06', sinkRange: [ 0.15, 0.53 ] },
		],
	},
	{
		id: 'rock_moss_set_02', class: 'boulder', author: 'Kless Gyzen', textureSize: 2048,
		gltf: `${SRC}/rock_moss_set_02/rock_moss_set_02_4k.gltf`,
		maps: {
			baseColor: tex( 'rock_moss_set_02', '4k', 'diff' ), normal: tex( 'rock_moss_set_02', '4k', 'nor_gl' ),
			arm: `${SRC}/rock_moss_set_02__maps/rock_moss_set_02_arm_4k.jpg`,
			// the published normal map lacks the height-derived detail in its green channel (G/R detail ratio ~0.3):
			// rebuild it from the displacement map with the gain measured on the intact red channel
			normalFixFromHeight: { height: `${SRC}/rock_moss_set_02__disp_png/rock_moss_set_02_disp_4k.png`, gain: 18 },
		},
		notes: 'Lichen-mottled grey rock, closed mesh. Normal map green channel rebuilt from the height map (defect of the published map).',
		variants: [
			{ name: 'rock_moss_set_02_a', node: 'rock_moss_set_02_rock07' },
			{ name: 'rock_moss_set_02_b', node: 'rock_moss_set_02_rock08' },
			{ name: 'rock_moss_set_02_c', node: 'rock_moss_set_02_rock09' },
			{ name: 'rock_moss_set_02_d', node: 'rock_moss_set_02_rock10' },
			{ name: 'rock_moss_set_02_e', node: 'rock_moss_set_02_rock11' },
			{ name: 'rock_moss_set_02_f', node: 'rock_moss_set_02_rock12' },
			{ name: 'rock_moss_set_02_g', node: 'rock_moss_set_02_rock13' },
		],
	},
	{
		id: 'namaqualand_boulder_04', class: 'boulder', author: 'Jenelle van Heerden', textureSize: 2048,
		gltf: `${SRC}/namaqualand_boulder_04/namaqualand_boulder_04_4k.gltf`,
		maps: { baseColor: tex( 'namaqualand_boulder_04', '4k', 'diff' ), normal: tex( 'namaqualand_boulder_04', '4k', 'nor_gl' ), arm: tex( 'namaqualand_boulder_04', '4k', 'arm' ) },
		notes: 'Granite boulder with pale lichen, closed mesh (flat cut underside).',
		variants: [ { name: 'namaqualand_boulder_04', node: 'boulder_04', sink: 0.15 } ],
	},
	{
		id: 'boulder_01', class: 'boulder', author: 'Rico Cilliers', textureSize: 2048, scale: 2,
		gltf: `${SRC}/boulder_01/boulder_01_4k.gltf`,
		maps: { baseColor: tex( 'boulder_01', '4k', 'diff' ), normal: tex( 'boulder_01', '4k', 'nor_gl' ), arm: tex( 'boulder_01', '4k', 'arm' ) },
		notes: 'Frost-shattered craggy boulder, closed mesh. Scaled x2 from the 1.8 m scan; overhangs on two sides, so bury it deeper than the others.',
		variants: [ { name: 'boulder_01', node: 'boulder_01', sink: 0.3 } ],
	},
	// ------------------------------------------------------------ medium rocks (1k)
	{
		id: 'namaqualand_boulder_05', class: 'medium', author: 'Jenelle van Heerden, Dario Barresi', textureSize: 1024,
		gltf: `${SRC}/namaqualand_boulder_05/namaqualand_boulder_05_2k.gltf`,
		maps: {
			baseColor: tex( 'namaqualand_boulder_05', '2k', 'diff' ), normal: tex( 'namaqualand_boulder_05', '2k', 'nor_gl' ),
			// the published AO (also inside the arm map) belongs to another UV layout -> no AO; roughness channel is fine
			ao: null, rough: { path: tex( 'namaqualand_boulder_05', '2k', 'arm' ), channel: 1 },
		},
		notes: 'Flat slab, closed mesh. No baked AO (the published AO map does not match the UV layout); occlusion channel is 1.',
		variants: [ { name: 'namaqualand_boulder_05', node: 'namaqualand_boulder_05' } ],
	},
	{
		id: 'namaqualand_boulder_06', class: 'medium', author: 'Greg Zaal, Jenelle van Heerden', textureSize: 1024,
		gltf: `${SRC}/namaqualand_boulder_06/namaqualand_boulder_06_2k.gltf`,
		maps: { baseColor: tex( 'namaqualand_boulder_06', '2k', 'diff' ), normal: tex( 'namaqualand_boulder_06', '2k', 'nor_gl' ), arm: tex( 'namaqualand_boulder_06', '2k', 'arm' ) },
		notes: 'Blocky rock, closed mesh.',
		variants: [ { name: 'namaqualand_boulder_06', node: 'namaqualand_boulder_06' } ],
	},
	{
		id: 'namaqualand_boulders_01', class: 'medium', author: 'Greg Zaal, Jenelle van Heerden', textureSize: 1024,
		gltf: `${SRC}/namaqualand_boulders_01/namaqualand_boulders_01_2k.gltf`,
		maps: { baseColor: tex( 'namaqualand_boulders_01', '2k', 'diff' ), normal: tex( 'namaqualand_boulders_01', '2k', 'nor_gl' ), arm: tex( 'namaqualand_boulders_01', '2k', 'arm' ) },
		notes: 'Rock about 0.55 m long, closed mesh.',
		variants: [
			{ name: 'namaqualand_boulders_01_a', node: 'namaqualand_rocks_01_a' },
			{ name: 'namaqualand_boulders_01_b', node: 'namaqualand_rocks_01_b' },
		],
	},
	// ------------------------------------------------------------ small stones (1k)
	{
		id: 'namaqualand_rocks_01', class: 'small', author: 'Greg Zaal, Jenelle van Heerden', textureSize: 1024,
		gltf: `${SRC}/namaqualand_rocks_01/namaqualand_rocks_01_2k.gltf`,
		maps: { baseColor: tex( 'namaqualand_rocks_01', '2k', 'diff' ), normal: tex( 'namaqualand_rocks_01', '2k', 'nor_gl' ), arm: tex( 'namaqualand_rocks_01', '2k', 'arm' ) },
		notes: 'Fist-to-head sized stone (0.2 m) for scree / road-side rubble; can be instanced at scale 1-3.',
		variants: [
			{ name: 'namaqualand_rocks_01_a', node: 'namaqualand_rocks_02_a' },
			{ name: 'namaqualand_rocks_01_b', node: 'namaqualand_rocks_02_b' },
			{ name: 'namaqualand_rocks_01_c', node: 'namaqualand_rocks_02_c' },
			{ name: 'namaqualand_rocks_01_d', node: 'namaqualand_rocks_02_d' },
		],
	},
	{
		id: 'namaqualand_stones_01', class: 'small', author: 'Greg Zaal, Jenelle van Heerden', textureSize: 1024,
		gltf: `${SRC}/namaqualand_stones_01/namaqualand_stones_01_2k.gltf`,
		maps: { baseColor: tex( 'namaqualand_stones_01', '2k', 'diff' ), normal: tex( 'namaqualand_stones_01', '2k', 'nor_gl' ), arm: tex( 'namaqualand_stones_01', '2k', 'arm' ) },
		notes: 'Small stone (0.08-0.15 m) for scree / gravel accents; can be instanced at scale 1-4.',
		variants: [
			{ name: 'namaqualand_stones_01_a', node: 'namaqualand_stones_01_a' },
			{ name: 'namaqualand_stones_01_b', node: 'namaqualand_stones_01_b' },
			{ name: 'namaqualand_stones_01_c', node: 'namaqualand_stones_01_c' },
			{ name: 'namaqualand_stones_01_d', node: 'namaqualand_stones_01_d' },
			{ name: 'namaqualand_stones_01_e', node: 'namaqualand_stones_01_e' },
		],
	},
	// ------------------------------------------------------------ cliffs / rock faces (2k)
	{
		id: 'namaqualand_cliff_02', class: 'cliff', author: 'Dario Barresi, Rico Cilliers', textureSize: 2048, openMesh: true, orient: 'faceZ',
		gltf: `${SRC}/namaqualand_cliff_02/namaqualand_cliff_02_4k.gltf`,
		maps: { baseColor: tex( 'namaqualand_cliff_02', '4k', 'diff' ), normal: tex( 'namaqualand_cliff_02', '4k', 'nor_gl' ), arm: tex( 'namaqualand_cliff_02', '4k', 'arm' ) },
		notes: 'Jointed granite outcrop, OPEN shell: front = +Z, long axis = X, top is modelled; the back (-Z) and underside are open and must sit inside terrain. Visible from azimuths within about 75 deg of +Z and from above. The bottom edge is within 0.5 m of the base over the central ~12 m and climbs to 2.7 m (x = -10) / 4.0 m (x = +10) at the ends (see baseProfile): let the terrain rise at both ends or cover them with boulders.',
		variants: [ { name: 'namaqualand_cliff_02', node: 'drone_rock_02_LOD0', sink: 0.5 } ],
	},
	{
		id: 'rock_face_01', class: 'cliff', author: 'Dario Barresi', textureSize: 2048, openMesh: true, orient: 'faceZ', scale: 2,
		grade: { greenResidual: 0.6 }, // the fresh rock of this scan is green-grey; keep that tint subtle next to the granite
		gltf: `${SRC}/rock_face_01/rock_face_01_4k.gltf`,
		maps: { baseColor: tex( 'rock_face_01', '4k', 'diff' ), normal: tex( 'rock_face_01', '4k', 'nor_gl' ), arm: tex( 'rock_face_01', '4k', 'arm' ) },
		notes: 'Bedded rock face with a mossy overhanging ledge on top, OPEN shell: front = +Z, the face leans back (see faceSlopeDeg) so the top is ~7 m behind the base; back (-Z) is open and must sit inside the slope. Scaled x2 from the scan. Can be pitched forward up to ~25 deg for a steeper road cut.',
		variants: [ { name: 'rock_face_01', node: 'rock_face_01', sink: 0.4 } ],
	},
	// ------------------------------------------------------------ large set piece (2k)
	{
		id: 'mountainside', class: 'setpiece', author: 'Dario Barresi, Rico Cilliers', textureSize: 2048, openMesh: true, orient: 'faceZ',
		gltf: `${SRC}/mountainside/mountainside_4k.gltf`,
		maps: { baseColor: tex( 'mountainside', '4k', 'diff' ), normal: tex( 'mountainside', '4k', 'nor_gl' ), arm: tex( 'mountainside', '4k', 'arm' ) },
		notes: 'Large scaly (slate-like) mountain wall, OPEN shell: front = +Z, back (-Z) is open and must sit inside the mountain. In plan it is a shallow V (centre closest to the viewer). Tolerates uniform scale up to ~1.8 when further than ~15 m from the camera.',
		variants: [ { name: 'mountainside', node: 'mountainside', sink: 0.3 } ],
	},
];
