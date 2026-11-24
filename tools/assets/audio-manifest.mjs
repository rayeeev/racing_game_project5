// Audio sources for Alpenglow. Every entry is downloaded by audio-fetch.mjs into assets-src/audio/<source-id>/ ;
// the license stated on the source page is re-checked at download time and stored in assets-src/audio/_meta/.
//
// kind 'freesound': ids = freesound sound ids (each page must state CC0 or CC-BY, otherwise the fetch fails).
// kind 'bsb'      : ids = bigsoundbank.com sound numbers (4 digits; each page must state "CC0 (public domain)").
// kind 'kenney'   : a kenney.nl asset pack (zip); the asset page and the License.txt inside the zip must state CC0;
//                   only the listed entries are extracted.

export const SOURCES = {

	// ---------------------------------------------------------------------------------------------------- ENGINE
	// "The Dyno Sessions: 190E" - Mercedes-Benz 190E 2.3-16 (inline-4) recorded on a dynamometer by David Nichols
	// (Track Time Audio), Kickstarter-funded, CC0. Steady holds at full / zero load, loaded sweeps, start-ups.
	// Mics: Audix D6 one foot behind the exhaust outlet, DPA 4062 in the engine bay, Rode NT1a 30 ft away.
	'fs-chippy569-dyno190e': {
		kind: 'freesound',
		ids: [
			162499, // Acceleration Sweep - 4062
			162501, // 17_ShortSweep_D6 (acceleration sweep)
			162502, // 18_MedSweep_4062 (loaded sweep down + hold)
			162504, // 17_MedSweep_D6   (loaded sweep down)
			162506, 162507, // 19_500  D6 / 4062  (full load, actually ~2580 rpm)
			162509, 162510, // 19_2500 D6 / 4062  (full load)
			162512, 162513, // 20_6500 D6 / 4062  (full load)
			162515, 162516, // 21_500  D6 / 4062  (zero load = idle)
			162518, 162519, // 21_2500 D6 / 4062  (zero load)
			162521, 162522, // 21_6500 D6 / 4062  (zero load)
			162525, 162526, // 23_StartBig D6 / 4062
			162528, 162523, // 23_StartISmall D6 / 4062
		],
	},

	// Ferrari 360 Spider (3.6 l flat-plane V8), stationary: start, idle, revs. Zoom H6 directly above the engine.
	'fs-pritzproductions-ferrari360': { kind: 'freesound', ids: [ 241083 ] },

	// Ferrari 360 (engine bay + exhaust), 96 kHz, "Automobiles" pack.
	'fs-victormalloy-automobiles': { kind: 'freesound', ids: [ 113186, 113187, 113188, 113190 ] },

	// ------------------------------------------------------------------------------------------------------ TIRES
	'fs-audible-edge-tire-squeal': { kind: 'freesound', ids: [ 71739 ] }, // Chrysler LHS tire squeal 04 (sustained)
	'fs-petruchio-tires-no-engine': { kind: 'freesound', ids: [ 188507 ] }, // car coasting, engine off: tyre/road noise
	'fs-seth-m-gravel-road': { kind: 'freesound', ids: [ 341069 ] }, // SUV on a gravel driveway
	'fs-alexftw123-wheelspin-gravel': { kind: 'freesound', ids: [ 152657 ] }, // wheel spinning on gravel
	'fs-kyles-skid-gravel': { kind: 'freesound', ids: [ 637161 ] }, // short brake skid on gravel
	'fs-squareal-car-interior': { kind: 'freesound', ids: [ 237374 ] }, // VW Tiguan interior, road rumble

	// ------------------------------------------------------------------------------------------------------- WIND
	'fs-klangfabrik-roaring-wind': { kind: 'freesound', ids: [ 117773 ] },

	// ---------------------------------------------------------------------------------------------------- IMPACTS
	'kenney-impact-sounds': {
		kind: 'kenney', slug: 'impact-sounds',
		entries: [ 'Audio/impactMetal_light_000.ogg', 'Audio/impactMetal_light_003.ogg', 'Audio/impactMetal_medium_000.ogg', 'Audio/impactMetal_heavy_001.ogg',
			'Audio/impactPlate_heavy_000.ogg', 'Audio/impactPlate_heavy_001.ogg', 'Audio/impactPunch_heavy_000.ogg', 'Audio/impactPunch_heavy_001.ogg', 'License.txt' ],
	},
	'fs-dslrguide-metal-hit': { kind: 'freesound', ids: [ 321482 ] }, // axe on a metal wheelbarrow
	'fs-squareal-car-crash': { kind: 'freesound', ids: [ 237375 ] }, // layered crash (filing cabinet, glass, grit)
	'fs-magnuswaker-car-crash': { kind: 'freesound', ids: [ 592388 ] }, // steel side panels + glass
	'fs-belanhud-metal-drag': { kind: 'freesound', ids: [ 543625 ] }, // metal dragged across metal

	// --------------------------------------------------------------------------------------------------- CAR MISC
	'fs-greatsoundstube-gear-select': { kind: 'freesound', ids: [ 629324 ] },
	'fs-craigsmith-backfires': { kind: 'freesound', ids: [ 675723 ] },

	// --------------------------------------------------------------------------------------------------- AMBIENCE
	'fs-tonmeister88-mountain-meadow': { kind: 'freesound', ids: [ 454841 ] }, // Swiss mountain meadow, birds, insects, distant cowbells
	'fs-vrymaa-night-crickets': { kind: 'freesound', ids: [ 734642 ] }, // crickets at night in the mountains, river in the valley
	'fs-kvgarlic-lake-waves': { kind: 'freesound', ids: [ 326097 ] }, // gentle waves lapping on a rocky lake shore
	'bsb-mountain-evening': { kind: 'bsb', ids: [ '3203' ] }, // "Mountain, Evening #1": cows, bells, river, insects
	'bsb-forest': { kind: 'bsb', ids: [ '2749' ] }, // "Forest #4": birds, wind

};
