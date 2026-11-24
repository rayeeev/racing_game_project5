// column / row mean profiles near the tile border (first/last 6 px vs interior) for normal x/y, roughness, albedo luminance
import { raw } from './tex-lib.mjs';
const dir = process.argv[2];
for (const [name, file, ch, conv] of [['normal.x(deg)', 'normal.jpg', 0, v => (v / 127.5 - 1) * 57.3], ['normal.y(deg)', 'normal.jpg', 1, v => (v / 127.5 - 1) * 57.3], ['rough(8bit)', 'arm.jpg', 1, v => v], ['ao(8bit)', 'arm.jpg', 0, v => v], ['albedoG(8bit)', 'albedo.jpg', 1, v => v]]) {
  const { data, width: W } = await raw(`${dir}/${file}`);
  const col = new Float64Array(W), row = new Float64Array(W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const v = conv(data[(y * W + x) * 3 + ch]); col[x] += v / W; row[y] += v / W; }
  const mean = col.reduce((a, b) => a + b, 0) / W;
  const f = (a, idx) => idx.map(i => (a[i] - mean).toFixed(2)).join(' ');
  const L = [0, 1, 2, 3, 5, 8, 16], Rr = [W - 17, W - 9, W - 6, W - 4, W - 3, W - 2, W - 1];
  console.log(name.padEnd(14), 'mean', mean.toFixed(2), '| col first:', f(col, L), '| col last:', f(col, Rr), '| row first:', f(row, L), '| row last:', f(row, Rr));
}
