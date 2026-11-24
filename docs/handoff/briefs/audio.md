# System brief: AUDIO
Module `src/audio/audio.js` → `export async function createAudio( ctx )`, key `audio`. Prefix: `audio`.
Owner files: `src/audio/**`, `dev/audio-*.html`, `tools/audio-*.mjs` (analysis helpers).

## Purpose
Sound is half of the feeling of speed. A high-revving naturally aspirated V8 that responds instantly to the throttle, tyres
that talk before they let go, wind that builds, the thud of a kerb, birdsong when you stop on the ridge.

## Inputs
`ctx.assets.index.audio` (`public/assets/audio/index.json`: sounds with id, group engine / tire / wind / impact / car /
ambience / ui, loop flag, per-loop measured `rpm` and `load` for engine loops, suggested gains, licenses - read the AUDIO
notes to see exactly what exists; categories that could not be sourced must be SYNTHESIZED by you), `frame.car.state`
(rpm, throttle, engineLoad, gear, shifting, revLimiter, speed, wheels[].skid / slip / surface / contact / load / travel,
impacts, airborne), `frame.ghost`, `frame.phase`, `frame.camera`, events ('car:impact', 'car:gear', 'countdown',
'race:lapComplete', 'race:sector', 'phase', 'photo'), settings (masterVolume, engineVolume, effectsVolume, ambienceVolume,
muted + 'settings:change'), `ctx.input.actions` 'any' (resume the AudioContext on the first user gesture - browsers block
audio until then; everything must work when the context starts suspended).

## Design (Web Audio API; one AudioContext; master → compressor / limiter → destination)
- **Engine**: if multi-rpm loops exist: crossfade neighbouring loops by rpm with pitch correction
  (`playbackRate = rpm / loop.rpm`), separate on-load and off-load layers blended by `engineLoad` / throttle; otherwise a
  hybrid: the available loop(s) pitch-shifted over a limited range + synthesized layers. Synthesis for a flat-plane V8:
  firing frequency = rpm / 60 x 4; harmonic stack with the right orders, wave-shaped saturation rising with load, intake
  roar (band-passed noise following rpm) on throttle, exhaust rasp, off-throttle overrun burble, limiter cut stutter at
  the redline, a brief torque-cut gap + bark on up-shifts, rev-match blip on down-shifts, backfire pops on lift-off at high
  rpm. Smooth all parameters (no zipper noise), no clicks on loop boundaries. The result must sound like an engine, not an
  organ: analyse your output (render offline with OfflineAudioContext in a dev page or Node script and inspect
  spectrograms with ffmpeg `showspectrumpic`) and iterate.
- **Tyres**: squeal loop(s) driven by per-wheel `skid` (volume) and slip speed (pitch), different character on asphalt vs
  loose surfaces (gravel crunch / hiss), rolling noise rising with speed and changing with surface, wet-road hiss when
  `ctx.sky.wetness` is high.
- **Wind**: filtered noise / loop rising with speed (roughly v²), buffeting in the open cockpit; reduced in chase camera.
- **Impacts**: one-shots chosen and scaled by impulse and kind (rail scrape vs thud vs soft terrain), suspension
  bottoming-out thump on big compressions / landings.
- **Ambience**: day / night loops (birds, breeze, water near the lake) audible at low speed and standstill, ducked by
  speed; crossfade on 'sky:changed'.
- **Ghost car**: a quiet, spatialized engine tone for the rival when it is near (distance attenuation + Doppler via
  playbackRate), so being caught or catching up is audible.
- **UI**: countdown beeps (3-2-1 low, GO high), sector / lap chimes, medal fanfare (short, synthesized), menu move /
  confirm ticks.
- **States**: menu attract mode → engine and effects at reduced level under a low-pass (cinematic), paused / photo →
  everything fades quickly to silence (ambience stays faint), tab hidden → suspend.
- Camera perspective: cockpit / bonnet → more intake and wind; chase → more exhaust; smooth switch on 'camera:mode'.
- Mute and volume settings respond immediately. No sound may ever clip: keep headroom, limiter on the master.

## API
`{ update( frame ), unlock(), dispose() }`

## Budget
<= 0.3 ms per frame on the main thread; allocation-free update.

## Verification
You cannot listen, so verify by measurement: an offline render harness (`dev/audio-test.html` or a Node script) that feeds
recorded / scripted telemetry (idle, a full-throttle run through the gears to the limiter, lift-off, braking with skid) into
the SAME synthesis graph via OfflineAudioContext, writes WAV files, and produces spectrogram PNGs (ffmpeg) that you LOOK at:
harmonics must track rpm, gear shifts must be visible, no silence gaps, no clipping (peak < -1 dBFS), loudness consistent
(report LUFS via ffmpeg `ebur128`). Also run the real page headless for 20 s with the autopilot and assert zero console
errors and that the AudioContext graph is alive (`audioContext.state`, non-zero analyser output).
