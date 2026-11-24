# System brief: UI - menus, HUD, notifications
Module `src/ui/ui.js` → `export async function createUI( ctx )`, key `ui`. Prefix: `ui`.
Owner files: `src/ui/**` (ui.js, styles.css, components), `public/assets/fonts/` (downloaded fonts), `dev/ui-*.html`.

## Purpose
The whole DOM layer on top of the canvas (`ctx.uiRoot`, which has `pointer-events: none` - enable pointer events only on
your interactive elements). It must look like the interface of a premium racing game: restrained, typographic, legible at
speed, consistent. Import your stylesheet from JS (`import './styles.css'`).

## Inputs
`frame.hud` (HudState - everything the HUD shows; read `src/game/context.js`), `frame.phase`, `ctx.game` (GameApi:
startSession, restartSession, quitToMenu, pause, resume, resetCar, setSky, setPaint, setGhostMode, setCameraMode,
setPhotoMode), `ctx.settings` (get / set + 'settings:change'), `ctx.records`, `ctx.events` (phase, countdown, race:*,
car:*, sky:changed, notify, photo, camera:mode), `ctx.input.actions` ('menu' { dir }, 'hud', 'any'),
`ctx.systems.environment?.presets` (id, name, thumb, wet, night), `ctx.systems.car?.paints` (id, name, swatch),
`ctx.systems.cameraRig?.modes`, `ctx.track` (polyline, sectors, corners for the minimap), `ctx.assets.index.ghosts` (medal
times), `src/core/math.js` (`formatLapTime`, `formatDelta`).

## Screens
1. **Main menu** (phase 'menu'; the game runs an attract-mode drive behind it - keep the centre of the screen clear): title
   "ALPENGLOW" + "Mountain time attack"; primary action START; selections with live preview: time of day (four cards with
   the preset thumbnails; selecting calls `ctx.game.setSky`), paint (swatches → `setPaint`), rival ghost (off / my best /
   bronze / silver / gold, with their lap times), records panel (best lap per condition, medals earned); SETTINGS
   (graphics quality (note: applies after reload - offer a reload button), render scale, motion blur, camera shake, FOV,
   racing line guide off / braking zones / full, gearbox auto / manual, ABS, traction control, stability control, steering
   assist, units, minimap, input display, volumes - the keys and value types are exactly those of `DEFAULT_SETTINGS` in
   `src/core/settings.js`); CONTROLS (keyboard + gamepad diagram from the bindings in `src/core/input.js`); CREDITS (from
   `/assets/credits.json` if present: asset authors and licenses - render whatever is there).
2. **Countdown**: start lights / 3-2-1-GO driven by the 'countdown' event; brief control hint.
3. **HUD** (phase 'drive'): 
   - speed + gear + tachometer as one compact cluster (arc or bar tach with a redline zone, shift indication near the
     limiter, units from settings), TC / ABS indicator lamps;
   - timing block: current lap time (large, tabular digits), last, session best, record, lap counter, three sector
     segments coloured by comparison (faster than best = green, record-best = purple, slower = amber);
   - live delta against the active ghost (`hud.delta`): numeric ±0.000 with a centre-origin bar, green when ahead, red when
     behind, smoothly animated;
   - medal targets for the current conditions with the earned medal highlighted;
   - minimap (canvas): the track outline rotated or north-up, sector marks, start line, the car arrow, the ghost dot;
   - pedal / steering input display (optional per settings);
   - transient messages: lap complete card (time, delta to record, NEW RECORD, medal earned - a moment of celebration),
     sector splits, WRONG WAY, OFF TRACK / lap invalid, "R - reset to track" hint when the Game asks, generic 'notify' toasts;
   - `Tab` (action 'hud') cycles full / minimal / hidden.
4. **Pause** (phase 'paused'): resume, restart, settings, photo mode, quit to menu.
5. **Photo mode** (phase 'photo'): everything hidden except a small hint bar (controls from the camera rig brief: WASD move,
   drag look, Q/E height, wheel FOV, [ ] roll, F focus, H hide hints, Enter saves a PNG of the canvas, Esc exits).
6. Loading is handled by the boot splash in index.html - do not duplicate it.

## Rules
- Fully operable by mouse, by keyboard and by gamepad (input action 'menu' with dir up / down / left / right / confirm /
  back; visible focus state). Buttons are real `<button>` elements; text selection disabled on HUD; no layout shift when
  digits change (tabular numerals).
- Responsive from 1280x720 to 4K and ultrawide; safe margins; scales with viewport height.
- Legible over bright sky and dark forest alike (subtle scrims / shadows, no heavy boxes); respects
  `prefers-reduced-motion`.
- Typography: one condensed display face for numbers / headings + one text face, open-licensed (OFL / Apache), downloaded
  into `public/assets/fonts/` (e.g. from the google/fonts GitHub repository via raw.githubusercontent.com; record name,
  author, license and source URL in your report) and loaded with @font-face (`font-display: swap`). No external requests at
  runtime.
- Performance: the HUD updates every frame - write DOM only when a displayed value changes; canvas minimap redraw is
  cheap; <= 0.3 ms per frame.
- No real-world brand names. Original copy, concise.

## API
`{ update( frame ), setHudMode( mode ), dispose() }`

## Verification
`/dev/sys.html?systems=ui&sim=1&phase=menu` (and with `systems=all` when the other systems exist): screenshots of every
screen and state at 1600x900 and 2560x1080 and 1280x720: main menu, each sub-panel, countdown, HUD while driving
(`phase=drive&autopilot=1&wait=20`), lap-complete card (use `__game.setTimeScale` / teleport near the line to trigger),
wrong way, pause, photo mode. Drive the menus through simulated key events in a `--script` scenario to prove keyboard
navigation works. Look at every shot with a designer's eye: alignment, spacing, contrast, hierarchy.
