// Draws the app icon as PNG files (needed for the iPhone home screen). Run: node planner/tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Shapes on a 64x64 canvas: [x, y, width, height, corner radius, colour]. The background fills the square.
const shapes = [
  [0, 0, 64, 64, 0, [0x2f, 0x6f, 0xed]],
  [13, 16, 38, 36, 6, [0xff, 0xff, 0xff]],
  [13, 16, 38, 10, 5, [0xcf, 0xe0, 0xff]],
  [19, 31, 20, 5, 2.5, [0x2f, 0x6f, 0xed]],
  [19, 40, 26, 5, 2.5, [0xf0, 0xb4, 0x29]],
];
const inside = (px, py, [x, y, w, h, r]) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r), cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

for (const size of [180, 192, 512]) {
  const SS = 3, raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) * 64 / size, py = (y + (sy + 0.5) / SS) * 64 / size;
        let col = shapes[0][5];
        for (const s of shapes) if (inside(px, py, s)) col = s[5];
        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = acc[0] / (SS * SS); raw[o + 1] = acc[1] / (SS * SS); raw[o + 2] = acc[2] / (SS * SS);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path.join(out, `icon-${size}.png`), png);
  console.log(`icon-${size}.png`, png.length, 'bytes');
}
