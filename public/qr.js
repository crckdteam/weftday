// Draws a QR code (the square a phone camera can read) with no outside libraries.
// Byte mode, lowest error correction, sizes 1 to 20 (up to about 850 characters).

// Per size: [error-correction bytes per block, blocks in group 1, data bytes each, blocks in group 2, data bytes each]
const BLOCKS = [null, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
  [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69], [20, 4, 81, 0, 0],
  [24, 2, 92, 2, 93], [26, 4, 107, 0, 0], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99],
  [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function errorBytes(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
    gen = next;
  }
  const rem = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f);
  }
  return rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

// Returns a square grid of true (dark) / false (light).
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  const room = v => { const [, b1, d1, b2, d2] = BLOCKS[v]; return b1 * d1 + b2 * d2; };
  const MAX = BLOCKS.length - 1;
  while (ver <= MAX && bytes.length > room(ver) - (ver < 10 ? 2 : 3)) ver++;
  if (ver > MAX) throw new Error('Too long for a QR code');
  const [ecLen, b1, d1, b2, d2] = BLOCKS[ver], dataLen = room(ver);

  // data bytes: mode, length, text, padding
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  // split into blocks, add error correction, interleave
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2, d = data.slice(at, at + len);
    at += len;
    blocks.push({ d, e: errorBytes(d, ecLen) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

  // fixed patterns
  const size = 17 + 4 * ver;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = !!dark; fn[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
  const al = ALIGN[ver], last = al.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = mask => {
    const d = (1 << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412, bit = i => (f >> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3), dark = (v >> i) & 1;
      set(a, b, dark); set(b, a, dark);
    }
  }

  // data, in the standard zig-zag from the bottom right
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && k < out.length * 8) { m[y][x] = ((out[k >> 3] >> (7 - (k & 7))) & 1) === 1; k++; }
    }
  }

  // pick the mask pattern that leaves the fewest long runs and solid squares
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, y) => row.map((v, x) => (fn[y][x] ? v : v !== MASKS[mask](x, y))));
    let score = 0;
    for (let y = 0; y < size; y++) for (let x = 0, runR = 0, runC = 0; x < size; x++) {
      runR = x && g[y][x] === g[y][x - 1] ? runR + 1 : 1; if (runR === 5) score += 3; else if (runR > 5) score++;
      runC = x && g[x][y] === g[x - 1][y] ? runC + 1 : 1; if (runC === 5) score += 3; else if (runC > 5) score++;
      if (x && y && g[y][x] === g[y][x - 1] && g[y][x] === g[y - 1][x] && g[y][x] === g[y - 1][x - 1]) score += 3;
    }
    if (!best || score < best.score) best = { score, mask, g };
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y][x] = best.g[y][x];
  drawFormat(best.mask);
  return m;
}

// The same code as a picture (SVG), always black on white so cameras can read it in dark mode too.
export function qrSvg(text) {
  const m = qrMatrix(text), n = m.length + 8;
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Setup code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
