#!/usr/bin/env node
// Macro (low-frequency) tilt of normal maps: mean normal per cell of an 8x8 grid, reported in degrees.
// A flat, tileable surface should have ~0 everywhere; tile-sized 'pillowing' shows up as a visible checkerboard under
// grazing sun (N.L changes by ~30% per 2 degrees at a 6 degree sun).   node tools/assets/tex-lowfreq.mjs <normal.jpg> ...

import sharp from 'sharp';

const G = 8;
for (const f of process.argv.slice(2)) {
  const { data, info } = await sharp(f).resize(256, 256, { kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, c = W / G;
  const mx = new Float64Array(G * G), my = new Float64Array(G * G);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, k = Math.floor(y / c) * G + Math.floor(x / c);
    mx[k] += (data[i] / 127.5 - 1) / (c * c); my[k] += (data[i + 1] / 127.5 - 1) / (c * c);
  }
  const st = (a) => { const m = a.reduce((p, q) => p + q, 0) / a.length; const sd = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); return { m, sd, min: Math.min(...a), max: Math.max(...a) }; };
  const sx = st(mx), sy = st(my), d = 180 / Math.PI;
  // column profile of nx (mean over rows) and row profile of ny: shows sawtooth/pillow shape
  const colX = Array.from({ length: G }, (_, x) => { let s = 0; for (let y = 0; y < G; y++) s += mx[y * G + x]; return ((s / G - sx.m) * d).toFixed(1); });
  const rowY = Array.from({ length: G }, (_, y) => { let s = 0; for (let x = 0; x < G; x++) s += my[y * G + x]; return ((s / G - sy.m) * d).toFixed(1); });
  console.log(f.split('/').slice(-2).join('/').padEnd(34), `bias(deg) x ${(sx.m * d).toFixed(2)} y ${(sy.m * d).toFixed(2)} | cell sd x ${(sx.sd * d).toFixed(2)} y ${(sy.sd * d).toFixed(2)} | range x ${((sx.max - sx.min) * d).toFixed(1)} y ${((sy.max - sy.min) * d).toFixed(1)} | colX [${colX.join(' ')}] rowY [${rowY.join(' ')}]`);
}
