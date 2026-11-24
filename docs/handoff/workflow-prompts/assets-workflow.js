export const meta = {
  name: 'alpenglow-assets',
  description: 'Download, optimize and visually verify game assets (car, skies, textures, rocks, trees + impostors, plants, props, audio) and build a verified three.js r187 API reference',
  phases: [
    { title: 'Acquire', detail: 'one agent per asset category: download, process, verify with screenshots' },
    { title: 'Impostors', detail: 'bake tree impostor atlases + reference TSL impostor material' },
  ],
}

const ROOT = '/Users/rayeeev/Desktop/Coding/Playground/Game'
const SP = '/private/tmp/claude-501/-Users-rayeeev-Desktop-Coding-Playground-Game/c7fa453a-8723-4335-bdc3-fea318946bcc/scratchpad'

const CTX = `You are one of ~9 agents working IN PARALLEL on the asset pipeline of "Alpenglow", a realistic 3D mountain-pass time-attack DRIVING GAME for the browser.

TECH STACK: plain JavaScript ES modules (no TypeScript), Three.js r187 (npm three@0.187.0) with WebGPURenderer + TSL node materials (imports: 'three/webgpu', 'three/tsl', 'three/addons/...'), Rapier physics, Vite 8.
SETTING / ART DIRECTION: a ~5 km closed mountain road that loops around an alpine lake: grey granite cliffs and boulders, scree, green alpine meadows with wildflowers, fir/pine forest, a fast lakeside straight, climbing hairpins. The signature look is golden hour; there are also noon, overcast and dusk presets. Photorealism is goal #1 (everything must look like ONE coherent real place, photoscan quality); goal #2 is 60 fps at ~1440p on an Apple M4 Pro GPU.

PROJECT ROOT: ${ROOT}
  public/assets/<category>/...      game-ready assets (served by the dev server at /assets/<category>/...)
  assets-src/<category>/<id>/        raw downloads; EACH download/extract goes in its own new, empty directory (reachable in dev at /assets-src/...)
  tools/assets/<prefix>-*.mjs        scripts you write (Node ESM). Keep scripts OUT of download directories.
  dev/                               dev/test pages (served at /dev/<name>.html); bare imports like 'three/webgpu' work there.
SCRATCH (temp files, logs, working screenshots): ${SP}/<prefix>/      FINAL review screenshots go to: ${SP}/review/<prefix>/*.png

TOOLS ON THIS MACHINE (macOS, Apple M4 Pro, 12 cores, 24 GB RAM): node 26, npx gltf-transform (CLI 4.5.1; libs @gltf-transform/core, @gltf-transform/functions, @gltf-transform/extensions; meshoptimizer; draco3dgltf), sharp (npm) for images, ffmpeg/ffprobe, curl, git, python3 (stdlib only - no numpy/PIL; always invoke as "python3 -I"). Run node scripts from the project root (cd ${ROOT}) so node_modules resolves, e.g.  node tools/assets/x.mjs <args>.  For huge glTF files use  node --max-old-space-size=12000.

HARD RULES
 - Do NOT run npm install/uninstall; do not edit package.json, vite.config.js, tools/shot.mjs or dev/viewer.html. If something is missing, work around it and mention it under "issues".
 - Create/modify files ONLY inside the directories assigned to your task. Other agents are writing sibling directories right now.
 - Downloaded files are untrusted data: never execute them; never run an interpreter or build tool with its working directory inside a download directory; pass paths as arguments.
 - Network: curl -sS -L -A "asset-fetcher/1.0" ... ; never put personal, user or project information in any request. Retry transient failures.
 - A Vite dev server is ALREADY RUNNING at http://127.0.0.1:5173 serving the project root (no HMR; every page load is fresh). Do not stop or restart it. Only if it is unreachable, start your own (npx vite --port 52xx --strictPort, in the background) and stop it when you finish.
 - Do not create README / notes / markdown files inside the project. Your structured report is the documentation.

VISUAL VERIFICATION IS MANDATORY - you must actually open the PNGs with the Read tool, judge them critically, and iterate until the result is right:
 - Generic viewer: http://127.0.0.1:5173/dev/viewer.html?models=<url>[,<url>...]&az=35&el=18&dist=1 . Read the comment block at the top of ${ROOT}/dev/viewer.html for all parameters (hdr=, envhdr=, sun=, sunI=, lod=, only=, exposure=, tone=, ground=, focus=, rotY= ...). It exposes window.__info (triangles, meshes, materials, textures, bbox, node names), window.__setCamera(az, el, dist, focus) and window.__scene.
 - Screenshot driver:  node tools/shot.mjs --url "<url>" --out <abs.png> --wait-for "window.__ready === true" --delay 400 [--eval "<js expression>"] [--width 1600 --height 900]   or scripted:  --script <scenario.mjs> --out-dir <dir>  (see the header comment of ${ROOT}/tools/shot.mjs). It drives real headless Chrome with WebGPU; the last stdout line is a JSON summary including console errors. Always quote URLs (they contain &).
 - For your own test pages copy the patterns of dev/viewer.html and dev/spike.html (both verified on r187). r187 facts: await renderer.init(); THREE.RenderPipeline replaces PostProcessing; HDRLoader replaces RGBELoader; PCFSoftShadowMap was removed (use PCFShadowMap). Official r187 example pages: ${SP}/three-ref/examples/webgpu_*.html . The installed library source is the ground truth: ${ROOT}/node_modules/three/ (src/, examples/jsm/, build/three.webgpu.js). Your memory of the three.js API may be stale: check the source when unsure.
 - For HDRI-lit previews before the sky assets exist: download a 1k/2k Poly Haven puresky HDRI into assets-src/<your category>/_hdri/ (e.g. kloofendal_48d_partly_cloudy_puresky) and pass hdr=/assets-src/<category>/_hdri/<file>.hdr to the viewer.

POLY HAVEN (all assets CC0): catalog JSON is cached at ${SP}/ph/models.json, ${SP}/ph/textures.json, ${SP}/ph/hdris.json (object keyed by asset id -> {name, categories, tags, authors, polycount, dimensions (mm), max_resolution, lods, ...}). Files per asset: https://api.polyhaven.com/files/<id> (JSON tree: format -> resolution -> {url, size, include:{relative path -> {url,size}}}; inspect it, the structure differs per asset type). Info: https://api.polyhaven.com/info/<id>. Thumbnails: https://cdn.polyhaven.com/asset_img/thumbs/<id>.png?width=512 (download into your scratch dir and LOOK at them before choosing). Credit page: https://polyhaven.com/a/<id>.

GPU MEMORY BUDGET: textures are uploaded uncompressed (about 5.6 MB per 1024x1024 map incl. mips, 22 MB per 2048x2048). Stay within the resolutions given in your task.

REPORT: return the structured result. "techNotes" must contain everything a downstream engineer needs to USE your assets correctly without re-investigating (exact file paths, node/material names, measurements, conventions, gotchas, recommended parameters). "issues" lists anything unresolved, compromised or suspicious. Be precise and honest: never claim something was verified unless you looked at the screenshot or measured it.

=====================================================================
`

const MODEL_CONV = `
MODEL CONVENTIONS (mandatory for scatter/prop models so that one runtime loader can handle every category):
 - One GLB per asset: public/assets/<category>/<id>.glb . Units = meters, Y up.
 - A file may contain several VARIANTS (e.g. 3 different rocks, 4 different trees). Each variant has LOD nodes named "<variant>_LOD0", "<variant>_LOD1", "<variant>_LOD2" (LOD0 = most detailed). Every LOD node is a direct child of the scene root with an IDENTITY transform; geometry is baked so the pivot is at the bottom-centre of the variant (x,z centred on the trunk/base, min y = 0). If an object should be sunk into the ground, give "sink" (meters) in index.json instead of moving geometry. One mesh primitive per material per LOD node (merge primitives that share a material).
 - All LODs of a variant (ideally all variants of an asset) share the SAME glTF material(s) and textures, so the runtime shares GPU textures.
 - Materials: glTF metallic-roughness PBR: baseColor (sRGB), normal map (OpenGL convention), occlusion/roughness/metallic packed in one ORM texture. Foliage: alphaMode MASK (alphaCutoff 0.4-0.5), doubleSided true. No BLEND transparency.
 - Textures embedded in the GLB as WebP (quality ~90) or JPEG at the resolution budget of your task.
 - Geometry compression: EXT_meshopt_compression (+ KHR_mesh_quantization) preferred; the game loader supports meshopt and Draco. Keep UV0 and normals; tangents optional.
 - Write public/assets/<category>/index.json:
   { "category": "<category>", "assets": [ { "id", "file": "/assets/<category>/<id>.glb", "source": "https://polyhaven.com/a/<id>", "author", "license": "CC0", "textureResolution": 1024, "bytes": <file size>,
       "variants": [ { "name", "size": [x,y,z], "radius": <max horizontal distance from pivot>, "lods": [ { "node": "<variant>_LOD0", "triangles": N }, ... ], "avgColor": "#rrggbb" (average visible albedo, sRGB), "collider": { ... as specified in your task ... }, "sink": 0, "notes": "" } ] } ] }
 - gltf-transform v4 hints (verify against the installed version; npx gltf-transform --help): scripting API: import { NodeIO } from '@gltf-transform/core'; import { ALL_EXTENSIONS } from '@gltf-transform/extensions'; import { weld, simplify, dedup, prune, flatten, join, textureCompress, meshopt, quantize, reorder, transformMesh, getBounds } from '@gltf-transform/functions'; import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer'; import sharp from 'sharp'; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder }); simplify({ simplifier: MeshoptSimplifier, ratio, error }) needs welded geometry; textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }).
 - Poly Haven glTF downloads are a .gltf + .bin + textures/ set (download every file listed under "include", preserving relative paths, into assets-src/<category>/<id>/).
`

const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What was delivered, in 3-8 sentences' },
    assets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          license: { type: 'string' },
          author: { type: 'string' },
          source: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['id', 'files', 'license', 'source'],
      },
    },
    indexFile: { type: 'string', description: 'Path of the index/manifest json you wrote, if any' },
    screenshots: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the final review screenshots' },
    techNotes: { type: 'string', description: 'Complete usage notes for downstream engineers' },
    issues: { type: 'array', items: { type: 'string' } },
    totalBytes: { type: 'number', description: 'Total size of delivered files under public/assets/<category>' },
  },
  required: ['summary', 'assets', 'techNotes', 'issues'],
}

const T_CAR = `TASK: CAR - deliver the game-ready player car model plus an exact structural spec.
Your prefix: car.  Your directories: public/assets/car/ , assets-src/car/ , tools/assets/car-*.mjs , dev/preview-car*.html , ${SP}/car/ , ${SP}/review/car/

Already downloaded (from the three.js r187 repo, examples/models/gltf/): assets-src/car/ferrari/ferrari.glb (Draco-compressed; 358,788 triangles, 51 meshes, bbox 2.257 x 1.236 x 4.534 m; nodes include wheel_fl / wheel_fr / wheel_rl / wheel_rr (each with rim/tire/brake/centre/nuts meshes), steering_wheel, body, glass, lights, lights_red, leds, interior meshes; materials e.g. Body_Color, Glass_Gray, Tires, metal_chrome, Carbon_Fiber, Taillight_Glass, Projector_Glass, Turn_Signal_LED, Leather ...) and ferrari_ao.png (baked ground-shadow texture). It is an open-top sports car with a full interior. Wheel diameter is about 0.716 m. The official usage example is ${SP}/three-ref/examples/webgl_materials_car.html (read it).

Do this:
1. LICENSE: establish the exact license and required attribution of this model (the example page credits it; try to confirm on the linked source page). Record it precisely.
2. ALTERNATIVES (time-boxed, about 15% of your effort): check whether a clearly better option exists that is downloadable by direct URL under CC0/CC-BY: photoreal in a real-time PBR renderer, separate wheel nodes (4 that spin, 2 that steer), sensible triangle count (<= 600k). Look at Khronos glTF-Sample-Assets (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models, e.g. CarConcept) and anything else you can find. A car without real-brand badges is preferred if quality is equal. If nothing is clearly better, stay with ferrari.glb. Whatever you choose, deliver everything below for the chosen model and say why.
3. Build public/assets/car/car.glb for runtime: keep every node the game must animate or address separately (4 wheel groups, steering wheel, brake-light / headlight / indicator meshes, body-paint mesh, glass), keep material names, merge other static meshes that share a material to reduce draw calls, keep full visual quality (it is the hero object: do not decimate the exterior). Draco or meshopt compression are both fine. Also build public/assets/car/car_lod1.glb: a <= 35k-triangle version with the same node names/structure (wheels still separate, interior may be dropped or heavily reduced) for the ghost/rival car and for cheap shadow/reflection passes. Verify both visually from several angles (exterior 3/4 front, 3/4 rear, side, interior, wheel close-up).
4. Write public/assets/car/car.json - the structural spec that physics, camera, FX and rendering code will rely on. MEASURE, do not guess (load the GLB in Node with @gltf-transform/core, or in the browser via the viewer's window.__scene with --eval). Include: units; up axis; FORWARD axis (which way the nose points); overall size; y of the ground plane (tire bottoms); for each wheel: node name, centre position, radius, width, which local axis is the axle, whether the node origin is at the wheel centre; wheelbase; front/rear track; steering wheel node, its position and its rotation axis (column axis); roles -> mesh/material names (bodyPaint, glass, rims, tires, brakeDiscs/calipers, headlightLens, tailLights = the mesh/material to make emissive when braking, reverse/indicator lights if any, interior, badges); headlight positions (left/right) and facing direction; exhaust tip positions; driver eye position for a cockpit camera (say which side the steering wheel is on); bonnet-camera position; suggested physics chassis box half-extents and centre (covering the body but NOT the lower half of the wheels); estimated centre of mass.
5. MATERIAL RECIPE: the glTF materials in this file are plain; the game must upgrade them. In dev/preview-car.html build the real look with three r187 WebGPURenderer (import * as THREE from 'three/webgpu'): multi-layer car paint (MeshPhysicalMaterial / MeshPhysicalNodeMaterial with clearcoat; optional subtle metallic flake via TSL), glass, rubber, rims, brake discs, emissive lights (off and on states), interior. Light it with real HDRIs (download two Poly Haven 2k puresky HDRIs into assets-src/car/_hdri/: one partly cloudy day, one sunset) plus a directional light with shadows, tone mapping on. Render and LOOK at screenshots for at least 4 paint colors (deep red, pearl white, midnight blue, graphite or yellow) and iterate until it looks like a real car photograph, not a toy. Put the final recipe (exact material parameters per role, keyed by mesh/material name) in car.json under "materials" and describe it in techNotes.
6. Copy the ground AO/shadow texture to public/assets/car/ and document in car.json how the example places it (plane size, offset, blending, render order).
`

const T_SKY = `TASK: SKY - four time-of-day presets with physically consistent lighting data.
Your prefix: sky.  Your directories: public/assets/sky/ , assets-src/sky/ , tools/assets/sky-*.mjs , dev/preview-sky*.html , ${SP}/sky/ , ${SP}/review/sky/

Choose from Poly Haven "puresky" HDRIs (sky only, no landscape - ideal because the game renders its own terrain). The 59 ids: aristea_wreck_puresky, autumn_field_puresky, belfast_sunset_puresky, citrus_orchard_puresky, citrus_orchard_road_puresky, drackenstein_quarry_puresky, drakensberg_solitary_mountain_puresky, evening_road_01_puresky, farm_field_puresky, hilly_terrain_01_puresky, industrial_sunset_02_puresky, industrial_sunset_puresky, kloofendal_28d_misty_puresky, kloofendal_38d_partly_cloudy_puresky, kloofendal_43d_clear_puresky, kloofendal_48d_partly_cloudy_puresky, kloofendal_misty_morning_puresky, kloofendal_overcast_puresky, kloppenheim_01_puresky, kloppenheim_02_puresky, kloppenheim_03_puresky, kloppenheim_05_puresky, kloppenheim_06_puresky, kloppenheim_07_puresky, lonely_road_afternoon_puresky, mpumalanga_veld_puresky, mud_road_puresky, overcast_soil_puresky, pizzo_pernice_puresky, quarry_01_puresky, quarry_04_puresky, qwantani_afternoon_puresky, qwantani_dawn_puresky, qwantani_dusk_1_puresky, qwantani_dusk_2_puresky, qwantani_late_afternoon_puresky, qwantani_mid_morning_puresky, qwantani_moon_noon_puresky, qwantani_moonrise_puresky, qwantani_morning_puresky, qwantani_night_puresky, qwantani_noon_puresky, qwantani_puresky, qwantani_sunrise_puresky, qwantani_sunset_puresky, rocky_ridge_puresky, rosendal_park_sunset_puresky, rustig_koppie_puresky, scythian_tombs_puresky, snow_field_2_puresky, snow_field_puresky, sunflowers_puresky, syferfontein_0d_clear_puresky, syferfontein_18d_clear_puresky, syferfontein_1d_clear_puresky, syferfontein_6d_clear_puresky, table_mountain_1_puresky, table_mountain_2_puresky, wasteland_clouds_puresky. Look at thumbnails before choosing.

Presets (directory names): 
 - "golden"   : golden hour - warm low sun (elevation roughly 6-18 degrees) with attractive clouds catching warm light. THE signature look of the game; pick the most beautiful one.
 - "noon"     : bright clear or lightly clouded day, high sun, crisp shadows.
 - "overcast" : fully overcast, soft shadowless light (used with a wet road).
 - "dusk"     : after sunset / blue hour or moonlit night for headlight driving. The sky must still be visible and attractive (not black).

For each preset deliver public/assets/sky/<preset>/ :
 a) sky.hdr   - the background image: the 4k equirect HDR (Radiance RGBE) as downloaded (unmodified pixels).
 b) env.hdr   - 1024x512 lighting environment with the SUN DISC REMOVED: pixels of the solar disc / saturated core are replaced by values consistent with the surrounding sky so that image-based lighting contains only sky + cloud light. (The game adds the sun back as a shadow-casting DirectionalLight - otherwise the sun energy would be counted twice and shadows would be washed out.) Flat (non-RLE) RGBE scanlines are valid and are accepted by three's HDRLoader. For overcast/dusk where no sun disc is visible, env.hdr is just the downsampled sky.
 c) meta.json - measured lighting data:
     "sunDirection": unit vector pointing FROM the scene TOWARD the sun (or moon, or the brightest sky region for overcast/dusk) in three.js world space, valid when the equirect texture is used as  texture.mapping = THREE.EquirectangularReflectionMapping; scene.background = texture  with NO rotation. You MUST verify this convention empirically (do not trust a formula from memory): render with the viewer (hdr=... and sun=x,y,z, e.g. with models=/assets-src/car/ferrari/ferrari.glb or simple objects) and confirm in screenshots that the visible sun sits exactly in the sunDirection (looking toward the sun: shadows fall toward the camera; looking from the side: shadows point away from the sun).
     "sunElevationDeg", "sunAzimuthDeg" (define the azimuth convention in techNotes),
     "sunColor": linear RGB normalized so max component = 1, "sunIntensity": the three.js DirectionalLight.intensity to use with that color. Physically: intensity*color = sum over removed sun pixels of (radiance * solid angle) = the irradiance on a surface facing the sun, in the HDR's own units (three.js lights are physically based: a DirectionalLight of intensity E on a white Lambert surface facing it gives radiance E/pi, the same as environment irradiance E). VERIFY empirically in dev/preview-sky.html: a white matte sphere + ground plane lit by (original sky.hdr as environment, no light) versus (env.hdr as environment + your DirectionalLight) must match in average brightness on the sun-facing side within about 10%; fix the numbers until they do. 
     "zenithColor", "horizonColor" (average over all azimuths, linear RGB), "horizonColors": 8 values by azimuth sector (linear RGB, for direction-dependent fog), "sunsideHazeColor", "groundColor" (lower hemisphere average), "averageLuminance",
     "exposure": recommended renderer.toneMappingExposure for a natural, well-exposed image with ACES and with AgX tone mapping (give both; verify by rendering a scene with an 18% grey card / the car and looking at it),
     "ambientIntensity": recommended scene.environmentIntensity (normally 1),
     "fog": suggested fog color (linear RGB) + a qualitative density hint ("clear" | "hazy" | "misty"),
     "shadowSoftness" hint (sharp for clear sun, very soft for overcast), "hasSun": boolean, "source": polyhaven url, "author".
 d) thumb.jpg - 512x256 tone-mapped preview for the menu UI.
Also write public/assets/sky/presets.json: an array of the four presets with id, display name, file paths and the full meta inline.
Notes: Poly Haven HDRIs are unclipped (sun pixels can be tens of thousands). Parse RGBE in Node yourself or use three's HDRLoader ( new HDRLoader().parse(arrayBuffer) works without a DOM - check the source). Budget: <= 120 MB total for public/assets/sky (if needed use 4k for golden + noon and 2k for the other two; say what you chose).
Verification screenshots (to ${SP}/review/sky/): for each preset - (1) the sky looking toward the sun with objects casting shadows, (2) side view, (3) the white-sphere energy comparison, (4) a beauty shot with the car model on a grey ground at the recommended exposure. Look at each one; the result must be a believable, well-exposed outdoor image.
`

const T_TEX = `TASK: TEXTURES - PBR terrain/road/material texture sets + misc FX textures.
Your prefix: tex.  Your directories: public/assets/textures/ , assets-src/textures/ , tools/assets/tex-*.mjs , dev/preview-tex*.html , ${SP}/tex/ , ${SP}/review/tex/

Part 1 - PBR sets from Poly Haven textures (catalog: ${SP}/ph/textures.json; search names/tags/categories, then LOOK at thumbnails; everything must read as one coherent alpine place and match grey photoscanned granite). Needed layers (directory name -> intent):
  grass_meadow   - natural green alpine meadow grass (not a lawn, not dry)
  grass_dry      - sparse / dry grass with soil showing through (transition layer)
  forest_floor   - conifer forest floor: needles, twigs, duff
  dirt           - brown soil / dried mud (road cuts, shoulders)
  gravel         - grey roadside gravel / fine scree
  rock_cliff     - grey granite/limestone cliff face (will be projected triplanar on steep slopes)
  rock_ground    - rocky ground / broken rock with some lichen (high ground)
  shore          - pebbles / wet coarse sand for the lake edge
  snow           - snow for distant peaks
  asphalt_main   - dark, good-condition road asphalt (fine aggregate, no painted lines)
  asphalt_worn   - older patched / cracked asphalt for variety
  concrete       - weathered concrete (barriers, kerbs, bridge)
  metal_galvanized - galvanized / zinc-coated steel for guard rails
  wood_weathered - grey weathered wood (posts, pier)
For each set deliver public/assets/textures/<name>/ : albedo.jpg (sRGB), normal.jpg (OpenGL convention = Poly Haven "nor_gl"), arm.jpg (R=AO, G=roughness, B=metalness = Poly Haven "arm"), height.jpg (displacement, 8-bit greyscale, 1024). Resolution 2048 for terrain and asphalt layers, 1024 for concrete/metal/wood/snow. Use the JPGs Poly Haven provides (do not recompress unless resizing; when resizing use sharp with high quality).
Write public/assets/textures/index.json: { "sets": [ { "id": <name>, "source": polyhaven url, "polyhavenId", "author", "license": "CC0", "resolution", "tileSizeMeters": real-world size of one texture repeat (from the catalog "dimensions", mm -> m), "avgColorLinear": [r,g,b], "avgColorSRGB": "#rrggbb", "avgRoughness", "maps": { "albedo", "normal", "arm", "height" } (url paths starting with /assets/textures/) } ], "fx": [...] }.
Checks: every set must tile seamlessly (render a 3x3 tiled contact sheet with sharp and look at it); albedo must not contain strong baked directional shadows; colors of grass_meadow / grass_dry / dirt / gravel / rock must sit together naturally (render one comparison sheet with all albedo swatches side by side and look at it; swap outliers).
Then build dev/preview-tex.html (three r187 WebGPURenderer): each set on a 4x4 m tilted plane + sphere using correct tiling from tileSizeMeters, lit by a Poly Haven HDRI (download a 2k puresky HDRI into assets-src/textures/_hdri/) + directional light; take screenshots (a grid of all sets, plus close-ups of asphalt_main at a grazing angle like a low chase camera, and grass_meadow + rock_cliff). Look at them and replace any set that looks fake, blurry, too colourful or out of place.

Part 2 - misc FX textures from the three.js repo at tag r187 (list directories via https://api.github.com/repos/mrdoob/three.js/contents/examples/textures?ref=r187 ; download via https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/textures/...): a tiling water normal map (waternormals.jpg and/or textures/water/*), smoke / dust particle sprites, spark sprite, lens-flare sprites (textures/lensflare/*), a noise texture if present, and 2-3 film-like 3D LUTs from examples/luts/ (cube/3dl; pick neutral-filmic / warm ones suitable for golden-hour grading). Save under public/assets/textures/fx/ and list them in index.json "fx" with id, file, purpose, license/credit (check for README/LICENSE files next to them; the repo itself is MIT).
`

const T_ROCKS = `TASK: ROCKS - photoscanned boulders, rocks and cliff pieces with LODs and colliders.
Your prefix: rocks.  Your directories: public/assets/rocks/ , assets-src/rocks/ , tools/assets/rocks-*.mjs , dev/preview-rocks*.html , ${SP}/rocks/ , ${SP}/review/rocks/
${MODEL_CONV}
Candidates in the Poly Haven "rocks" category: boulder_01, rock_moss_set_01, rock_moss_set_02, rock_07, rock_09, rock_face_01, rock_face_02, stone_01, mountainside, namaqualand_boulder_02..06, namaqualand_boulders_01, namaqualand_cliff_01/02, namaqualand_rocks_01, namaqualand_stones_01, coast_rocks_01/02/03/05, coast_land_rocks_02/03/04, coastal_cliff_01/02/04, sand_rocks_small_01. Look at thumbnails; choose pieces that read as ALPINE grey granite/limestone (some moss/lichen is welcome); avoid red desert or obviously marine looks unless they pass as mountain rock.
Deliver 8-10 assets covering:
  - 3-4 large boulders (2-6 m): LOD0 <= 12k tris, LOD1 <= 3k, LOD2 <= 600; 2k textures.
  - 2-3 medium rocks (0.4-1.5 m): LOD0 <= 4k, LOD1 <= 1k, LOD2 <= 250; 1k textures.
  - 1-2 sets of small stones / rubble (each stone a variant, or small clusters as variants): LOD0 <= 1.5k, LOD1 <= 300; 1k textures.
  - 2 cliff / rock-face pieces to dress road cuts and the mountain wall (5-20 m): LOD0 <= 40k, LOD1 <= 10k, LOD2 <= 2k; 2k textures. Say which side is the "back" (not meant to be seen) and the natural orientation.
  - "mountainside" only if it is usable as a large set piece within <= 60k tris LOD0.
Multi-rock source files: split into separate variants, each re-centred to its own bottom-centre.
Simplification: photoscans rely on their normal maps - keep UVs intact (simplify with locked/respected UV seams and a small error bound; compare LOD0 vs LOD1 vs LOD2 silhouettes and shading in screenshots; no visible holes or torn seams).
Collider per variant in index.json: large + medium rocks and cliffs: { "type": "hull", "points": [[x,y,z], ...] } - a convex hull of <= 24 points fitted to the variant (in the variant's local space), or several hulls ("type": "hulls", "hulls": [[...],[...]]) for concave cliff pieces; small stones: { "type": "none" }.
Also report per variant how deep it should typically be buried ("sink") to look embedded in terrain.
Verify with screenshots: every variant at LOD0 and LOD2 (use the viewer with lod= and only= params), HDRI + sun, 2 angles; plus one group shot of all variants in a row with a 1.8 m reference box for scale. Check colour coherence across the set and report avgColor so the terrain shader can match.
`

const T_TREES = `TASK: TREES - conifers and other trees for an alpine forest, with LODs.
Your prefix: trees.  Your directories: public/assets/trees/ , assets-src/trees/ , tools/assets/trees-*.mjs , dev/preview-trees*.html , ${SP}/trees/ , ${SP}/review/trees/
${MODEL_CONV}
Candidates: the Poly Haven "pine_forest" collection and "trees" category: fir_tree_01 (7.8 MILLION polygons at source LOD0 - it has LODs and the file holds several trees), fir_sapling, fir_sapling_medium, pine_tree_01, pine_sapling_medium, pine_sapling_small, tree_small_02, island_tree_01/02/03, jacaranda_tree (probably not alpine), dead_tree_trunk, dead_tree_trunk_02, tree_stump_01, tree_stump_02. Inspect https://api.polyhaven.com/files/<id> for LOD files and resolutions, look at thumbnails, then deliver:
  - tall conifers (the forest canopy, 12-30 m): at least 4 distinct variants.
  - young conifers / saplings (1.5-8 m): at least 3 variants.
  - 1-2 broadleaf small trees or big bushes for variety, only if they fit an alpine look.
  - dead trunk / snag / stump: 2-3 variants.
Triangle budgets per variant: tall conifer LOD0 <= 45k, LOD1 <= 9k, LOD2 <= 1.5k; sapling LOD0 <= 12k, LOD1 <= 2.5k, LOD2 <= 400; stump/trunk LOD0 <= 5k, LOD1 <= 1k, LOD2 <= 200. Textures: 2k for a bark atlas + needle/branch atlas shared by all variants of a species, otherwise 1k.
Foliage LOD technique: do NOT rely on generic mesh decimation for needle/leaf cards (it shreds them). Prefer the source's own LOD meshes when provided; otherwise reduce by removing a fraction of the branch/needle cards and scaling the remaining ones up to preserve silhouette and density, and decimate only the solid trunk/branches. Compare silhouettes against LOD0 at the distances each LOD will be used (LOD1 about 40-120 m, LOD2 about 120-300 m; beyond that the game switches to billboard impostors which ANOTHER agent bakes after you from your LOD0 meshes).
Split multi-tree files into separate variants, each re-centred on its own trunk base.
Per variant report in index.json (extra fields): "height", "crownRadius", "trunkRadius" (at 1 m height; used for a physics cylinder), "foliageMaterials": [names] (need wind sway + alpha test), "barkMaterials": [names], "avgFoliageColor", "collider": { "type": "cylinder", "radius", "height" } for trees thicker than 0.12 m, else { "type": "none" }.
Verify with screenshots: each variant at LOD0/1/2 from 2 angles on neutral ground with HDRI light + sun shadows; then build dev/preview-trees.html, a "forest edge" test with about 150 mixed instances on both sides of a 9 m wide road-like gap, camera 1.2 m high looking along the gap (use InstancedMesh per LOD node or simple clones), and judge realism critically (needle colour, density, alpha edges, bark). Report fps (requestAnimationFrame timing) and total triangles of that test.
`

const T_IMPOSTOR = `TASK: TREE IMPOSTORS - bake billboard impostor atlases for every tree variant listed in public/assets/trees/index.json (just produced by another agent; its report is appended below) and deliver a reference TSL impostor material.
Your prefix: imp.  Your directories: public/assets/trees/ (add files; update index.json), tools/assets/imp-*.mjs , dev/bake-impostor.html , dev/preview-impostor.html , src/gfx/lib/impostorMaterial.js , ${SP}/imp/ , ${SP}/review/imp/

Atlas spec (per variant; skip stumps/logs lower than 1.5 m - they simply disappear at distance):
  - 8 views around the Y axis; view k has the camera at azimuth k*45 degrees, where azimuth 0 = camera on the +Z side looking toward -Z, and increasing azimuth moves the camera toward +X (counter-clockwise seen from above). Orthographic camera, elevated 8 degrees above horizontal, aimed at the tree centre. The world-space frame is the same for all 8 views: width = 2 * max horizontal radius, height = tree height (so one billboard size fits all views).
  - Layout: 4 x 2 grid (row 0 = views 0-3 left to right, row 1 = views 4-7); cell 256x512 for tall trees (atlas 1024x1024), 128x256 cells (512x512 atlas) for trees under 6 m. State the UV origin convention you used (which corner view 0 is in, as seen by three.js with flipY defaults for a WebP loaded by TextureLoader).
  - <variant>_imp_albedo.webp : RGB = UNLIT base colour (base colour texture x material colour; no lighting, no tone mapping; sRGB encoded), A = coverage. Dilate RGB outward into transparent texels (>= 8 px) so mip-mapping does not produce dark halos; alpha unchanged.
  - <variant>_imp_normal.webp : RGB = OBJECT-space unit normal of the visible surface, encoded n*0.5+0.5, in the tree's local frame (not view space); A = a cheap baked ambient-occlusion / self-shadow term if you can produce a good one (e.g. depth-based or hemisphere-lit render), else 255.
  Bake from the LOD0 meshes with a dev page (dev/bake-impostor.html, three r187 WebGPURenderer rendering to RenderTargets, read back with renderer.readRenderTargetPixelsAsync or via canvas) driven by tools/shot.mjs --script (page.evaluate returns base64 data; the Node side writes files with sharp). Mind sRGB vs linear when reading back, and supersample (render at 2x and downsample) for clean alpha edges.
Then implement src/gfx/lib/impostorMaterial.js (plain JS ES module, depends only on three):  export function createImpostorMaterial({ albedoMap, normalMap, grid = [4, 2], alphaTest, ... })  returning a NodeMaterial for an InstancedMesh of quads that (a) is a Y-axis-locked camera-facing billboard (computed in the vertex stage from the instance position), (b) per instance picks the atlas view from the camera azimuth relative to the instance's Y rotation, (c) cross-fades the two nearest views with a stable screen-space dither (alpha test / discard only, no alpha blending, so it works with temporal anti-aliasing and depth), (d) is lit like a real mesh by the scene's DirectionalLight + environment using the decoded object-space normal rotated by the instance rotation (a MeshStandardNodeMaterial with a custom normalNode is fine), with roughness ~0.9, (e) supports per-instance scale and tint. Document at the top of the file the instance attributes it expects and the geometry to use. Make sure it also works when the instance count is large (50k).
And dev/preview-impostor.html: side-by-side comparison of real LOD2 meshes vs impostors for the same trees at 150 m, 300 m and 600 m under the same HDRI + sun, from two sun directions. Compare average colours of matching screenshot crops (sharp) and tune until impostors match the real trees in brightness and hue within a few percent and no halos / seams / popping lines are visible. Screenshots are mandatory; look at them.
Finally update public/assets/trees/index.json: add per variant "impostor": { "albedo": url, "normal": url, "views": 8, "grid": [4,2], "elevationDeg": 8, "width", "height", "uvConvention": "..." }.
`

const T_PLANTS = `TASK: GROUND COVER - grass, meadow plants, shrubs, ferns and forest-floor debris as ultra-light instancing-ready models.
Your prefix: plants.  Your directories: public/assets/plants/ , assets-src/plants/ , tools/assets/plants-*.mjs , dev/preview-plants*.html , ${SP}/plants/ , ${SP}/review/plants/
${MODEL_CONV}
These get GPU-instanced by the tens of thousands near the camera (grass/flowers within ~60 m, shrubs/ferns within ~150 m), so triangle budgets are strict and alpha overdraw must stay modest.
Candidates on Poly Haven (choose what gives a believable ALPINE meadow + conifer forest floor; judge by thumbnails): grass_medium_01, grass_medium_02, grass_bermuda_01, fern_02, moss_01, dandelion_01, celandine_01, periwinkle_plant, nettle_plant, weed_plant_02, shrub_01, shrub_02, shrub_03, shrub_04, shrub_sorrel_01, wild_rooibos_bush, searsia_burchellii, searsia_lucida, bark_debris_01, dry_branches_medium_01, pine_roots, root_cluster_01, root_cluster_02, flower_* (South-African flowers: only if they pass as alpine wildflowers). Tree stumps belong to another agent - skip them.
Deliver (triangle budgets per variant):
  - grass: 4-5 clump variants (short meadow grass, taller tufts, a dry tuft): LOD0 <= 150 tris, LOD1 <= 40. If the source is dense real geometry, build clumps by selecting subsets of blades/cards (generic decimation destroys thin blades); alpha cards are fine. One shared atlas across the grass variants if feasible.
  - wildflowers: 3-4 variants (yellow, white, purple/blue): LOD0 <= 220 tris, LOD1 <= 50.
  - fern + low forest plants: 2-3 variants: LOD0 <= 600, LOD1 <= 120.
  - shrubs / bushes (0.5-2 m): 3-4 variants: LOD0 <= 2500, LOD1 <= 500, LOD2 <= 80.
  - debris (fallen branches, bark, roots): 2-3 variants: LOD0 <= 800, LOD1 <= 150.
  Textures: 1024 per asset (512 for tiny things); MASK alpha, double sided.
Per variant report in index.json (extra fields): "height", "colorRoot" and "colorTip" (average albedo near the base / near the top, sRGB hex - used to blend grass into the terrain colour), "windAmplitude" suggestion (m), and "collider": { "type": "none" }.
Verify: each variant alone (viewer) AND dev/preview-plants.html: an instanced field test - about 20k random instances of the grass + flower variants (random Y rotation, scale 0.8-1.3) on a 60 x 60 m plane coloured like meadow soil/grass, a few shrubs and ferns, HDRI + sun with shadows, camera 1.2 m high like a chase camera plus one top-down-ish shot. LOOK at the screenshots: it must read as a natural alpine meadow, not as repeated plastic clumps (fix density, colour variation, alpha edges, shading/normals - e.g. bent normals pointing up for grass cards if lighting looks harsh). Report fps and triangles of the test.
`

const T_PROPS = `TASK: PROPS - roadside, paddock and lakeside props.
Your prefix: props.  Your directories: public/assets/props/ , assets-src/props/ , tools/assets/props-*.mjs , dev/preview-props*.html , ${SP}/props/ , ${SP}/review/props/
${MODEL_CONV}
Search the cached catalog (${SP}/ph/models.json: names, categories, tags) and look at thumbnails for realistic props that fit (a) a mountain road, (b) a small race paddock / start-finish area, (c) a lakeside. Known candidates: concrete_road_barrier, concrete_road_barrier_02, street_lamp_01, street_lamp_02, modular_electricity_poles (poles + wires along the road), modular_wooden_pier (lake), old_tyre (tyre stacks at corners), Barrel_01, Barrel_02, barrel_03, flood_lights + portable_generator (night start area), covered_car (parked in a lay-by), utility_box_01/02, metal_trash_can, plastic_crate_03, hand_truck, tool_cart, modular_chainlink_fence; also search tags/names for: road, traffic, cone, sign, fence, bench, picnic, crate, pallet, boat, canoe, hut, cabin, shed, tent, flag, pole, lamp, bridge, gate, barrier, container, table, chair.
Pick the 12-16 props that add the most realism to those three places. Budgets: LOD0 <= 6k tris for small props, <= 15k for large ones (pier, pole sets, covered car); LOD1 about 20% of LOD0; no LOD2 needed. Textures 1024 (2048 only for large hero props). Modular kits: export each useful module as its own variant.
Per variant report in index.json: "collider": { "type": "box", "halfExtents": [x,y,z], "center": [x,y,z] } or { "type": "cylinder", "radius", "halfHeight", "center" } or { "type": "none" }, plus "dynamic": true/false (true for things a car can knock over: cones, tyres, barrels, crates - with a realistic "mass" in kg) and "placement" hint (e.g. "roadside", "paddock", "lake").
Verify with screenshots: each prop from 2 angles, plus a group shot on asphalt-grey ground with HDRI + sun and a 1.8 m reference box for scale. Check that scales are real-world correct (a road barrier is ~0.8 m high, a barrel ~0.9 m).
`

const T_AUDIO = `TASK: AUDIO - find, license-check, download and prepare sound assets.
Your prefix: audio.  Your directories: public/assets/audio/ , assets-src/audio/<source-id>/ , tools/assets/audio-*.mjs , ${SP}/audio/ , ${SP}/review/audio/

Needed sounds, by priority:
 1. ENGINE (most important). The car is a naturally aspirated, high-revving V8 sports car (redline about 9000 rpm). Ideal: steady-state loops recorded at several RPMs (4-6 steps from idle ~1000 to 8000+), ideally separate on-throttle and off-throttle sets, onboard or exhaust perspective, all from the same car. If no multi-RPM set exists under a clean license, get the best 2-3 steady loops available (idle, mid, high) from any sporty petrol engine.
 2. TIRES: sustained tire squeal/screech on asphalt (loop), tire rolling / road noise (loop), gravel or dirt rolling (loop), skid on gravel.
 3. WIND: steady wind / air-rush loop (scaled with speed).
 4. IMPACTS: 3-5 car impact one-shots (light scrape/tap, medium thud, heavy crash) and a metal scrape loop (grinding along a guard rail).
 5. CAR MISC: gear-shift click/clunk, 2-3 exhaust backfire pops, an engine start-up (for the race start).
 6. AMBIENCE: alpine / forest daytime loop (birds, light wind), night loop (crickets or wind), optional lake water lapping.
 7. UI (optional - can be synthesized): countdown beep, go beep, checkpoint chime, menu click.
LICENSE REQUIREMENT: CC0 / public domain strongly preferred; CC-BY acceptable (record the exact attribution text). No NC or ND licenses; no "royalty-free, all rights reserved" libraries unless the license clearly permits redistribution inside a game project (quote the clause). Every delivered file needs a verifiable source URL and license. If a category cannot be sourced cleanly, leave it out and say so (the game will synthesize it) - never include audio with unclear licensing.
WHERE TO LOOK (verify each claim on the actual page): bigsoundbank.com (CC0), opengameart.org (CC0 / CC-BY entries have direct file links), Wikimedia Commons audio (CC0 / PD / CC-BY, direct links on upload.wikimedia.org), freesound.org CC0 sounds (originals need a login - check what is retrievable), Kenney.nl audio packs (CC0), and clearly licensed audio in open-source racing games on GitHub (check per-file license notes: stuntrally, speed-dreams, supertuxkart, vdrift, torcs, trigger-rally ...). Use ToolSearch to load WebSearch or a web-fetch tool if available; otherwise use curl.
PROCESSING (ffmpeg): WAV PCM 16-bit 44.1 kHz; MONO for engine / tire / wind / impact / car sounds (the game mixes them itself), stereo allowed for ambience. Trim silence; normalize one-shots to about -3 dBFS peak and loops to a consistent loudness (about -18 LUFS); make loops SEAMLESS: pick a steady 2-6 s segment and crossfade its end into its start (equal-power), then verify there is no click by checking sample continuity across the loop point. Long ambience may be OGG Vorbis (q5) instead of WAV. Total payload <= 40 MB.
For each engine loop MEASURE the fundamental firing frequency (write a small Node autocorrelation or FFT script) and derive the approximate RPM (state your cylinder-count assumption: firing frequency = rpm/60 * cylinders/2). The game will pitch-shift and crossfade loops by RPM, so a correct "rpm" per loop matters.
Deliver public/assets/audio/<group>/<name>.wav|ogg and public/assets/audio/index.json: { "sounds": [ { "id", "file" (url path starting with /assets/audio/), "group": "engine|tire|wind|impact|car|ambience|ui", "loop": bool, "duration", "channels", "sampleRate", "rpm"?, "load"?: "on"|"off", "baseFrequencyHz"?, "gainDb" (suggested playback gain), "license", "author", "source", "attribution" } ] }.
VERIFY: ffprobe every output; for loops compute the sample discontinuity at the loop point; render spectrogram PNGs (ffmpeg showspectrumpic) for the engine and tire loops into ${SP}/review/audio/ and LOOK at them to confirm steady harmonic content, no silence, no clipping.
`

const T_CRIB = `TASK: API REFERENCE - produce a VERIFIED quick reference for three.js r187 WebGPURenderer + TSL exactly as installed in ${ROOT}/node_modules/three, for engineers who know classic three.js (WebGLRenderer, ShaderMaterial, EffectComposer) very well but whose knowledge of the r187 WebGPU/TSL API may be stale or wrong.
Your prefix: crib.  Your directories: dev/crib/ (test pages), ${SP}/crib/ (scratch), and the output file ${SP}/notes/three-r187-crib.md . Do not write anywhere else in the project.

Method: every statement and snippet must be taken from / validated against the installed source (node_modules/three/src, node_modules/three/examples/jsm, node_modules/three/build/three.webgpu.js) and the official r187 example pages (${SP}/three-ref/examples/webgpu_*.html). The important snippets must be RUN: create small test pages under dev/crib/*.html, load them with tools/shot.mjs and confirm ZERO console errors and warnings (a deprecation warning means the snippet is wrong: find the new name) and look at the screenshot. Docs for orientation: ${SP}/three-ref/docs/pages/TSL.html.md , ${SP}/three-ref/tsl/content/Guide.md , ${SP}/three-ref/docs/pages/RenderPipeline.html.md , ${SP}/three-ref/docs/pages/WebGPURenderer.html.md.
Already verified: await renderer.init(); THREE.RenderPipeline (PostProcessing is the deprecated name); pass(scene, camera).setMRT(mrt({ output, velocity, normal: packNormalToRGB(normalView) })); traa(color, depth, velocity, camera); ao(depth, normal, camera); bloom(node, strength, radius, threshold); directionToColor/colorToDirection were renamed packNormalToRGB/unpackRGBToNormal; PCFSoftShadowMap removed; HDRLoader replaces RGBELoader. A working page is dev/spike.html.

Write the reference as dense, code-first Markdown (target 600-1000 lines; no filler). Tag every item [RUN] (you executed it in a test page with no errors/warnings) or [SRC] (confirmed by reading installed source or an official example; cite the file). Nothing unverified is allowed. Cover at least:
 1. Renderer: constructor options, init, animation loop, pixel ratio / resize, tone mapping + exposure + output colour space when a RenderPipeline is used (where tone mapping is applied; renderOutput / outputColorTransform; how to do custom colour grading before or after tone mapping), shadowMap settings and the shadow types that exist, renderer.info fields (draw calls, triangles) and GPU timing queries, compileAsync / pre-compiling materials to avoid hitches, checking the active backend (WebGPU vs WebGL2 fallback), forceWebGL, device-lost handling.
 2. Loading: GLTFLoader with DRACOLoader + MeshoptDecoder + KTX2Loader under WebGPURenderer; HDRLoader; TextureLoader colour spaces, anisotropy, wrap modes; environment lighting in WebGPURenderer (scene.environment with an equirect HDR texture, PMREM handling, scene.environmentIntensity / environmentRotation, scene.background / backgroundIntensity / backgroundBlurriness / backgroundRotation, scene.backgroundNode / environmentNode, using different textures for background vs lighting).
 3. Node materials: MeshStandardNodeMaterial / MeshPhysicalNodeMaterial slots (colorNode, normalNode, roughnessNode, metalnessNode, aoNode, emissiveNode, opacityNode, alphaTest / alphaTestNode, maskNode, positionNode, clearcoat*, sheen, iridescence, transmission, shadow-related slots such as castShadowNode / receivedShadowNode / shadowPositionNode), how classic materials (MeshStandardMaterial, MeshPhysicalMaterial) behave under WebGPURenderer (onBeforeCompile is not available), uniform() and updating values, uniformArray, texture() sampling with custom UVs / LOD bias / grad, triplanarTexture(s), normalMap() / bumpMap() exact signatures and how to blend two tangent-space normal maps, positionWorld / positionLocal / positionView / normalWorld / normalView / normalLocal / cameraPosition / modelWorldMatrix, attribute(), varying() / vertexStage(), Fn() with If / Loop / Switch, common math (mix, smoothstep, step, saturate, remap ...), noise helpers that exist (mx_noise_float, mx_fractal_noise_*, hash ...), the names of the time nodes in r187, screenUV / viewportUV / screenCoordinate, depth access (viewportDepthTexture, linearDepth, viewportLinearDepth, viewportSharedTexture) for soft particles / water depth fade / refraction, frontFacing, Discard, how to debug a node (toInspector, renderer.debug.getShaderAsync or equivalent).
 4. Instancing and scale: InstancedMesh (instanceMatrix, instanceColor, count) with node materials, per-instance custom attributes (instancedBufferAttribute / instancedDynamicBufferAttribute / instancedArray / instanceIndex), efficient partial buffer updates (addUpdateRange, needsUpdate), frustum culling behaviour of InstancedMesh, BatchedMesh status, LOD object, billboards and sprites in TSL (SpriteNodeMaterial, billboarding helpers), GPU particles with compute (instancedArray + Fn().compute(count) + renderer.compute / computeAsync), SoftParticles helper.
 5. Lights and shadows: DirectionalLight shadows under WebGPURenderer (mapSize, bias, normalBias, radius, blurSamples, intensity), CSMShadowNode exact usage (webgpu_shadowmap_csm.html: constructor options, light.shadow.shadowNode = csm, what to call on resize / fov change, fade), TileShadowNode, alpha-tested shadow casting for foliage, material.shadowSide, SpotLight headlights (shadows, cookie map), SSSNode (screen-space shadows) usage, light probes / LightProbeGrid if practical.
 6. Fog and atmosphere: scene.fog (Fog / FogExp2) support, scene.fogNode with fog() / rangeFogFactor / densityFogFactor, custom height fog and view-direction-dependent fog colour (webgpu_fog_height.html, webgpu_custom_fog*.html, webgpu_postprocessing_fog.html), SkyMesh parameters, volumetric lighting options (webgpu_volume_lighting*.html), GodraysNode.
 7. Post-processing: complete RenderPipeline recipes with exact imports and signatures taken from the official examples: MRT setup (output, normal, velocity, emissive, metalness/roughness ...), GTAO (resolutionScale, radius, thickness, samples, how to composite and denoise), SSGI (webgpu_postprocessing_ssgi.html: parameters, how AO + GI are composited, cost), SSR (webgpu_postprocessing_ssr.html: required MRT channels, parameters, blur), TRAA and TAAU (temporal upscaling: how to render the scene pass at reduced resolution and upscale; FSR1Node), bloom, motionBlur, DepthOfFieldNode, lens flare, FilmNode / grain, chromatic aberration, how to write a vignette in TSL, Lut3DNode (+ LUTCubeLoader / LUT3dlLoader), SharpenNode, SMAA / FXAA, how to change resolution scale at runtime, how to switch effects on/off at runtime (when is pipeline.needsUpdate or a rebuild required), rendering a second camera into a RenderTarget and reading pixels back (readRenderTargetPixelsAsync), getting a screenshot of the canvas.
 8. Water: WaterMesh / Water2Mesh usage (webgpu_ocean.html, webgpu_water.html, webgpu_backdrop_water.html), the reflector() TSL node (planar reflection: resolution, cost, limitations).
 9. Misc: Timer vs Clock, audio classes (unchanged?), Line2 / fat lines under WebGPU for debug drawing, known pitfalls you ran into.
Each section: minimal correct code followed by 1-3 lines of gotchas. Where cheap, MEASURE cost on a 1600x900 canvas with a moderately heavy scene (for example frame time with and without GTAO / SSGI / SSR / TRAA / bloom using requestAnimationFrame timing over 120 frames) and include the numbers (Apple M4 Pro).
In your structured report: "assets" may be an empty array; put the path of the crib in "indexFile" and the 30 most important gotchas in "techNotes".
`

const tasks = [
  { key: 'car', prompt: T_CAR },
  { key: 'sky', prompt: T_SKY },
  { key: 'textures', prompt: T_TEX },
  { key: 'rocks', prompt: T_ROCKS },
  { key: 'plants', prompt: T_PLANTS },
  { key: 'props', prompt: T_PROPS },
  { key: 'audio', prompt: T_AUDIO },
  { key: 'crib', prompt: T_CRIB },
]

phase('Acquire')

const single = tasks.map((t) => () =>
  agent(CTX + t.prompt, { label: `assets:${t.key}`, phase: 'Acquire', schema: RESULT })
    .then((r) => ({ key: t.key, result: r }))
)

const treesChain = async () => {
  const trees = await agent(CTX + T_TREES, { label: 'assets:trees', phase: 'Acquire', schema: RESULT })
  if (!trees) return { key: 'trees', result: null, impostors: null }
  log('trees done - baking impostors')
  const imp = await agent(
    CTX + T_IMPOSTOR + '\n\n--- REPORT OF THE TREES AGENT ---\n' + JSON.stringify(trees, null, 1),
    { label: 'assets:impostors', phase: 'Impostors', schema: RESULT }
  )
  return { key: 'trees', result: trees, impostors: imp }
}

const all = await parallel([...single, treesChain])
const out = {}
for (const r of all) {
  if (!r) continue
  out[r.key] = r.result
  if (r.impostors !== undefined) out.impostors = r.impostors
}
const missing = tasks.map((t) => t.key).concat(['trees']).filter((k) => !out[k])
if (missing.length) log('MISSING results for: ' + missing.join(', '))
return out
