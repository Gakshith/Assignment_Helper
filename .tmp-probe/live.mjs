import { parse } from 'opentype.js/dist/opentype.mjs';
import { readFileSync } from 'node:fs';
const buf = readFileSync('web/public/fonts/reference/Caveat-Regular.ttf');
const f = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const src = readFileSync('web/src/render/glyphs/substitute.ts', 'utf8');
const rows = [...src.matchAll(/\['\\u([0-9a-f]{4})', '\\u([0-9a-f]{4})'\], \/\/ (.*)/g)];
console.log('rows', rows.length);
for (const [, a, b, c] of rows) {
  const from = String.fromCodePoint(parseInt(a, 16));
  const to = String.fromCodePoint(parseInt(b, 16));
  const hasFrom = f.hasChar(from) && f.charToGlyph(from).index !== 0;
  const hasTo = f.hasChar(to) && f.charToGlyph(to).index !== 0;
  console.log((hasFrom ? 'INERT' : 'LIVE ') + '  U+' + a.toUpperCase() + ' -> U+' + b.toUpperCase() + (hasTo ? '' : '  !!TARGET MISSING!!') + '   ' + c);
}
