export const meta = {
  name: 'alpenglow-car-finish',
  description: 'Finish the car asset task after the original agent was interrupted: apply the pending badge-plate fix, complete look-dev verification, final screenshots and report',
  phases: [
    { title: 'Finish car', detail: 'take over from the interrupted car engineer using the files on disk' },
  ],
}

const ROOT = '/Users/rayeeev/Desktop/Coding/Playground/Game'
const SP = '/private/tmp/claude-501/-Users-rayeeev-Desktop-Coding-Playground-Game/c7fa453a-8723-4335-bdc3-fea318946bcc/scratchpad'
const SCRIPT = '/Users/rayeeev/.claude/projects/-Users-rayeeev-Desktop-Coding-Playground-Game/c7fa453a-8723-4335-bdc3-fea318946bcc/workflows/scripts/alpenglow-assets-wf_f2563215-c93.js'

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
    indexFile: { type: 'string' },
    screenshots: { type: 'array', items: { type: 'string' } },
    techNotes: { type: 'string', description: 'Complete usage notes for downstream engineers' },
    issues: { type: 'array', items: { type: 'string' } },
    totalBytes: { type: 'number' },
  },
  required: ['summary', 'assets', 'techNotes', 'issues'],
}

const PROMPT = `You are taking over the CAR asset task of "Alpenglow" (a realistic browser driving game: Three.js r187 WebGPURenderer + TSL, plain JavaScript) from an engineer who was interrupted near the end of the work. Finish it to a high standard.

WORKING STYLE: iterate with real feedback (builds, numbers, screenshots you actually look at with the Read tool). Keep each reasoning step short; do not deliberate at length before acting.

1. READ YOUR BINDING INSTRUCTIONS FIRST. The file ${SCRIPT} is a JavaScript workflow script that defines two template strings: CTX (the common context, tools, hard rules and verification method for all asset engineers - read ALL of it) and T_CAR (the car task with its deliverables 1-6). Inside those strings \${ROOT} means ${ROOT} and \${SP} means ${SP}. Everything in CTX and T_CAR applies to you (your prefix is "car"; your directories are the ones listed in T_CAR).

2. STATE OF THE WORK (checked on disk minutes ago):
 - public/assets/car/: car.glb (365,882 triangles, 47 meshes, Draco), car_lod1.glb (34,482 triangles, 16 meshes), car.json (52 KB spec: license - CC BY 4.0, confirmed by the predecessor from an archived source page -, axes, size, wheels with spin nodes, steering wheel, lamps, exhaust tips, mirrors, cameras, physics suggestions, roles, ground shadow, the materials recipe with paints, hierarchy), car_ground_ao.png, tire_tread_n.png, tire_sidewall_n.png.
 - The pipeline the predecessor wrote (read these files - they ARE the state of the art of this task): tools/assets/car-build.mjs (builds both GLBs from assets-src/car/ferrari/ferrari.glb: merging, role splitting, removal of real-brand badge meshes, vertex AO baking ...), tools/assets/car-spec.mjs (measures the GLBs and writes car.json), tools/assets/car-recipe.mjs (the material recipe that ends up in car.json "materials"), tools/assets/car-textures.mjs (procedural tyre normal maps), car-lib.mjs, car-caliper.mjs, car-inspect.mjs, car-components.mjs, car-montage.mjs, car-shots-parts.mjs / car-shots-roles.mjs / car-shots-preview.mjs (screenshot scenarios for tools/shot.mjs), and dev/preview-car.html (the look-dev page that applies the recipe under real HDRIs).
 - A chronological one-line-per-action log of everything the predecessor did: ${SP}/notes/car-predecessor-log.md . Scratch files: ${SP}/car/ (p1, p2, p3 = successive preview render sets; car.build.json; ao-cache-64.json).
 - The predecessor's LAST command (saved verbatim in ${SP}/declined-car-cmd.txt) was executed a few minutes ago with this outcome:
     (a) the recipe tweaks in tools/assets/car-recipe.mjs were APPLIED (brighter interior / tyre / rim values, aoFloor 0.12 → 0.3);
     (b) the sunrel sign fix in dev/preview-car.html was APPLIED;
     (c) the edit of tools/assets/car-build.mjs FAILED on an anchor mismatch and was NOT applied. Its intent: when badges are dropped, keep the plate of the nose badge as a body-coloured blank so that no hole / dark recess is left in the bonnet, give the nose badge frame the body colour, and re-role the sun-visor labels as interior plastic. (The line it looked for - if ( near( c, - 0.004, 0.586, - 2.095, 0.02 ) ) return 'nose badge frame'; - has ONE leading tab in the file, the command expected two.) Apply the INTENT correctly; do not blindly replay the text.
     (d) the build, the spec and the preview renders were then re-run with the OLD build script. The newest renders are ${SP}/car/p3/*.png (front34, head, interior2, cockpit, side, top, engine, fender, sidescript, dash). In front34 the car already looks convincing (glossy red clear-coat paint with sky reflections, detailed interior, alloy rims with yellow calipers), but a small dark slot is visible on the nose where the badge plate was removed.
   The exact build / spec / render command lines are at the end of ${SP}/declined-car-cmd.txt .

3. WHAT REMAINS (in this order):
 a. Look at the p3 renders to learn the current state. Apply the badge-plate fix, rebuild, re-render, look again. The car must carry NO real-brand badge, emblem, logo or script anywhere (nose, tail, wheel centre caps, steering wheel boss, side skirts / fenders, engine cover, dashboard, seats, brake calipers) and must show no holes or dark recesses where they were removed. Inspect every such location in close-up renders.
 b. Finish the look: judge the preview renders against real car photography and fix whatever looks wrong (paint, glass, lamps on and off, tyres, rims, calipers, interior, panel gaps, AO) under BOTH HDRIs of the preview page (day and sunset) and for at least 4 paints. Check car_lod1.glb from 10-30 m (it is used for the ghost car and for shadow casting) and confirm it has the same node structure for wheels.
 c. Verify every deliverable of T_CAR 1-6 against the files. For the ALTERNATIVES item: check the predecessor's log; if there is no evidence it was done, do the time-boxed check now and record the conclusion. Make sure car.json is complete and consistent with the FINAL GLBs (re-run car-spec after the last build) and independently sanity-check several measured numbers (forward axis, wheel centres, wheel radius, wheelbase, tracks) by loading the GLB.
 d. Save the final review screenshots to ${SP}/review/car/ : exterior 3/4 front, 3/4 rear, side, top, interior, the cockpit view from the driver's eye, a wheel close-up, LOD1, 4 paints, day + sunset.
 e. Return the structured report. "techNotes" must be complete enough that the engineer who writes the in-game car system never has to re-investigate: node / mesh / material names, the material recipe and how car.json encodes it, animation conventions for wheel spin / steering / suspension travel, the lamp meshes and their off / on states, camera anchors, the ground shadow, the physics suggestions, and the license with the exact required attribution text.
`

phase('Finish car')
const car = await agent(PROMPT, { label: 'assets:car-finish', phase: 'Finish car', schema: RESULT, effort: 'high' })
return { car }
