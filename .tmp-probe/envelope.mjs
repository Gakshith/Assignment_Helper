import { parse } from 'opentype.js/dist/opentype.mjs';
import { readFileSync } from 'node:fs';
const buf = readFileSync('web/public/fonts/reference/Caveat-Regular.ttf');
const f = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const upem = f.unitsPerEm;
let worst = { left: 0, right: 0, up: 0, down: 0 };
let names = { left: '', right: '', up: '', down: '' };
const chars = [];
for (let c = 0x20; c < 0x2200; c++) {
  const ch = String.fromCodePoint(c);
  if (f.hasChar(ch)) chars.push(ch);
}
for (const ch of chars) {
  const g = f.charToGlyph(ch);
  if (g.index === 0) continue;
  const p = g.getPath(0, 0, upem);
  let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
  const see = (x, y) => { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; };
  for (const cmd of p.commands) {
    if (cmd.type === 'Z') continue;
    if (cmd.x1 !== undefined) see(cmd.x1, cmd.y1);
    if (cmd.x2 !== undefined) see(cmd.x2, cmd.y2);
    see(cmd.x, cmd.y);
  }
  if (!isFinite(x1)) continue;
  const adv = g.advanceWidth ?? upem;
  // getPath is y-DOWN, so y-up: yMax = -y1, yMin = -y2
  const up = -y1 / upem, down = y2 / upem;
  const left = -x1 / upem, right = (x2 - adv) / upem;
  if (left > worst.left) { worst.left = left; names.left = ch; }
  if (right > worst.right) { worst.right = right; names.right = ch; }
  if (up > worst.up) { worst.up = up; names.up = ch; }
  if (down > worst.down) { worst.down = down; names.down = ch; }
}
console.log('glyphs scanned', chars.length);
console.log('worst (em, control-point hull):', JSON.stringify(worst), JSON.stringify(names));
