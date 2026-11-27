// png-squeeze-01 entry: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Strategy (all Node stdlib, deterministic, fixed work caps — no clock reads):
//   1. Decode the stored input PNG (unfiltered rows, stored zlib blocks).
//   2. Analyse the image: unique colours (<=256 -> palette), grey, opaque,
//      single transparent key (tRNS instead of an alpha channel).
//   3. For every candidate form (palette by count, palette by luminance,
//      channel form; the channel form is skipped for non-grey palette
//      images, where a palette is always smaller) and every filter choice
//      (fixed 0..4, minsum, pairs, brute-force per-row with a 32 KiB
//      dictionary context), filter and screen with zlib level 6. All five
//      filters are computed once per row and shared across the choices.
//   4. Re-encode the winning filtered stream with our own optimal-parsing
//      deflate encoder (zopfli-style: hash-chain match finding with a
//      carried match, optimal-parse DP over 3 passes, length-limited
//      Huffman codes, dynamic blocks), and keep whichever of it and zlib
//      level 9 is smaller.
//   5. Write IHDR / PLTE? / tRNS? / IDAT / IEND, CRC-correct, bit depth 8.
//
// Reads /input/<id>/image.png, writes /output/<id>/image.png (env overrides
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR for local runs).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG codec
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++)
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error(`filter type ${ft}`);
  }
  return samples;
}
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!header) throw new Error('no IHDR');
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colourType];
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = unfilter(raw, header.width, header.height, bpp);
  const n = header.width * header.height;
  const rgba = new Uint8Array(n * 4);
  if (header.colourType === 6) rgba.set(samples);
  else if (header.colourType === 2) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2]; rgba[d + 3] = 255;
    }
  } else if (header.colourType === 0) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[i]; rgba[d + 3] = 255;
    }
  } else if (header.colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1];
    }
  } else {
    const lut = new Uint8Array((palette.length / 3) * 4);
    for (let e = 0; e < palette.length / 3; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width: header.width, height: header.height, rgba };
}

// ---------------------------------------------------------------- analysis
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms; // a palette is always smaller than channels here
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------- filters
// Filter one row by all five types at once into `out` (5 rows of stride),
// and accumulate each filter's signed sum and distinct-pair count (the two
// screening costs) in the same pass.
function filterRowAll(cur, prev, bpp, out, sums, pairs, seen, stampBase) {
  const n = cur.length;
  const o0 = out[0], o1 = out[1], o2 = out[2], o3 = out[3], o4 = out[4];
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0;
  let q0 = 0, q1 = 0, q2 = 0, q3 = 0, q4 = 0;
  const st0 = stampBase, st1 = stampBase + 1, st2 = stampBase + 2, st3 = stampBase + 3, st4 = stampBase + 4;
  for (let i = 0; i < n; i++) {
    const v = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    const f0 = v, f1 = (v - a) & 0xff, f2 = (v - b) & 0xff, f3 = (v - ((a + b) >> 1)) & 0xff, f4 = (v - paeth(a, b, c)) & 0xff;
    o0[i] = f0; o1[i] = f1; o2[i] = f2; o3[i] = f3; o4[i] = f4;
    s0 += f0 < 128 ? f0 : 256 - f0;
    s1 += f1 < 128 ? f1 : 256 - f1;
    s2 += f2 < 128 ? f2 : 256 - f2;
    s3 += f3 < 128 ? f3 : 256 - f3;
    s4 += f4 < 128 ? f4 : 256 - f4;
    if (i > 0) {
      if (seen[(p0 << 8) | f0] !== st0) { seen[(p0 << 8) | f0] = st0; q0++; }
      if (seen[(p1 << 8) | f1] !== st1) { seen[(p1 << 8) | f1] = st1; q1++; }
      if (seen[(p2 << 8) | f2] !== st2) { seen[(p2 << 8) | f2] = st2; q2++; }
      if (seen[(p3 << 8) | f3] !== st3) { seen[(p3 << 8) | f3] = st3; q3++; }
      if (seen[(p4 << 8) | f4] !== st4) { seen[(p4 << 8) | f4] = st4; q4++; }
    }
    p0 = f0; p1 = f1; p2 = f2; p3 = f3; p4 = f4;
  }
  sums[0] = s0; sums[1] = s1; sums[2] = s2; sums[3] = s3; sums[4] = s4;
  pairs[0] = q0; pairs[1] = q1; pairs[2] = q2; pairs[3] = q3; pairs[4] = q4;
}
const BRUTE_CONTEXT = 32768;
const SCREEN = { level: 6, memLevel: 8 };
const FINAL = { level: 9, memLevel: 9 };
// Screen one form's filter choices: the five filters are computed once per
// row and shared; each choice's filtered data is weighed by zlib level 6.
// Returns the best {choice, data, bytes} (bytes include PLTE/tRNS chunks).
function screenForm(form, width, height) {
  const stride = width * form.bpp;
  const size = height * (stride + 1);
  const chunks = chunkBytes(form);
  const raws = [];
  for (let k = 0; k < 8; k++) raws.push(new Uint8Array(size));
  const all = [];
  for (let t = 0; t < 5; t++) all.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  const sums = new Float64Array(5);
  const pairs = new Float64Array(5);
  let stampBase = 0;
  for (let y = 0; y < height; y++) {
    const cur = form.samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : form.samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    filterRowAll(cur, prev, form.bpp, all, sums, pairs, seen, stampBase);
    stampBase += 5;
    // fixed choices 0..4
    for (let t = 0; t < 5; t++) {
      raws[t][at] = t;
      raws[t].set(all[t], at + 1);
    }
    // minsum (choice 5)
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) if (sums[t] < best) { best = sums[t]; type = t; }
    raws[5][at] = type;
    raws[5].set(all[type], at + 1);
    // pairs (choice 6)
    type = 0; best = Infinity;
    for (let t = 0; t < 5; t++) if (pairs[t] < best) { best = pairs[t]; type = t; }
    raws[6][at] = type;
    raws[6].set(all[type], at + 1);
    // brute (choice 7): the filter whose level-4 deflate, after the
    // previous 32 KiB of raw data as dictionary, is smallest.
    const before = raws[7].subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    type = 0; best = Infinity;
    for (let t = 0; t < 5; t++) {
      const trial = new Uint8Array(stride + 1);
      trial[0] = t;
      trial.set(all[t], 1);
      const cost = deflateSync(trial, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raws[7][at] = type;
    raws[7].set(all[type], at + 1);
  }
  let bestChoice = null;
  for (let k = 0; k < 8; k++) {
    const z = deflateSync(raws[k], SCREEN);
    const bytes = z.length + chunks;
    if (bestChoice === null || bytes < bestChoice.bytes) bestChoice = { choice: k, data: raws[k], bytes };
  }
  return bestChoice;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------- optimal deflate
// Optimal-parsing deflate (zopfli-style, bounded work, deterministic).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const BOUNDARIES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const CAND = [];
for (let L = 0; L <= 258; L++) {
  const c = [];
  for (const b of BOUNDARIES) if (b <= L) c.push(b);
  if (L >= 3 && (c.length === 0 || c[c.length - 1] !== L)) c.push(L);
  CAND[L] = c;
}
function lenSymbol(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return 257 + lo;
}
function distSymbol(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}
const FIXED_LIT = new Float64Array(288);
for (let s = 0; s < 288; s++) FIXED_LIT[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
// Huffman code lengths: heap tree, clamp to maxBits, then repair the Kraft
// sum to exactly 1 (lengthen the least frequent, then shorten the most
// frequent) so the decoder accepts the code.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lens;
  if (syms.length === 1) { lens[syms[0]] = 1; return lens; }
  const nf = [], nl = [], nr = [], ns = [];
  for (const s of syms) { nf.push(freq[s]); nl.push(-1); nr.push(-1); ns.push(s); }
  const heap = syms.map((_, i) => i);
  const less = (a, b) => nf[a] < nf[b] || (nf[a] === nf[b] && a < b);
  const siftDown = (j) => {
    for (;;) {
      const l = j * 2 + 1, r = l + 1; let m = j;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === j) break;
      const t = heap[j]; heap[j] = heap[m]; heap[m] = t; j = m;
    }
  };
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(i);
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) { heap[0] = last; siftDown(0); }
    return top;
  };
  const push = (node) => {
    heap.push(node);
    let j = heap.length - 1;
    while (j > 0) { const p = (j - 1) >> 1; if (!less(heap[j], heap[p])) break; const t = heap[j]; heap[j] = heap[p]; heap[p] = t; j = p; }
  };
  while (heap.length > 1) {
    const a = pop(), b = pop();
    const id = nf.length;
    nf.push(nf[a] + nf[b]); nl.push(a); nr.push(b); ns.push(-1);
    push(id);
  }
  const root = heap[0];
  const stack = [[root, 0]];
  let maxLen = 0;
  while (stack.length) {
    const [node, d] = stack.pop();
    if (ns[node] >= 0) { lens[ns[node]] = d; if (d > maxLen) maxLen = d; }
    else { stack.push([nl[node], d + 1]); stack.push([nr[node], d + 1]); }
  }
  if (maxLen <= maxBits) return lens;
  for (let s = 0; s < n; s++) if (lens[s] > maxBits) lens[s] = maxBits;
  const K = 1 << maxBits;
  let kraft = 0;
  for (let s = 0; s < n; s++) if (lens[s] > 0) kraft += 1 << (maxBits - lens[s]);
  if (kraft > K) {
    const order = syms.slice().sort((a, b) => freq[a] - freq[b] || a - b);
    let oi = 0;
    while (kraft > K) {
      let s = -1;
      for (let k = 0; k < order.length; k++) {
        const cand = order[(oi + k) % order.length];
        if (lens[cand] < maxBits) { s = cand; oi = (oi + k + 1) % order.length; break; }
      }
      if (s < 0) break;
      kraft -= 1 << (maxBits - lens[s] - 1);
      lens[s]++;
    }
  }
  if (kraft < K) {
    const order = syms.slice().sort((a, b) => freq[b] - freq[a] || a - b);
    let slack = K - kraft;
    while (slack > 0) {
      let s = -1, step = 0;
      for (const cand of order) {
        if (lens[cand] <= 1) continue;
        const st = 1 << (maxBits - lens[cand]);
        if (st <= slack && st > step) { s = cand; step = st; }
      }
      if (s < 0) break;
      lens[s]--;
      slack -= step;
    }
  }
  return lens;
}
function canonicalCodes(lens) {
  let maxLen = 0;
  for (const l of lens) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lens) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
  const codes = new Array(lens.length).fill(0);
  for (let s = 0; s < lens.length; s++) { const l = lens[s]; if (l > 0) codes[s] = nextCode[l]++; }
  return codes;
}
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}
class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.nbits = 0; }
  write(value, count) {
    // On entry nbits <= 7, so value<<nbits stays within 32 bits (count <= 15).
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) { this.buf[this.pos++] = this.acc & 0xff; this.acc >>>= 8; this.nbits -= 8; }
  }
  writeCode(code, len) { this.write(reverseBits(code, len), len); }
  flush() { if (this.nbits > 0) { this.buf[this.pos++] = this.acc & 0xff; this.acc = 0; this.nbits = 0; } }
  bytes() { return this.buf.subarray(0, this.pos); }
}
function rleCodeLengths(L) {
  const tokens = [];
  let i = 0;
  const total = L.length;
  while (i < total) {
    const len = L[i];
    if (len === 0) {
      let run = 0;
      while (i + run < total && L[i + run] === 0) run++;
      while (run >= 11) { const nn = Math.min(run, 138); tokens.push([18, nn - 11]); i += nn; run -= nn; }
      if (run >= 3) { tokens.push([17, run - 3]); i += run; run = 0; }
      while (run > 0) { tokens.push([0, 0]); i++; run--; }
    } else {
      tokens.push([len, 0]); i++;
      let run = 0;
      while (i + run < total && L[i + run] === len) run++;
      while (run >= 3) { const nn = Math.min(run, 6); tokens.push([16, nn - 3]); i += nn; run -= nn; }
      while (run > 0) { tokens.push([len, 0]); i++; run--; }
    }
  }
  return tokens;
}
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Optimal-parsing deflate of `raw` (Uint8Array) -> a zlib stream.
// Blocks of 256 KiB; hash-chain match finding (chain 512) with a carried
// match extended to its true length; 3 optimal-parse DP passes.
function optimalDeflate(raw) {
  const BLOCK = 262144;
  const CHAIN = 512;
  const RECENT_LIMIT = 4;
  const PASSES = 3;
  const n = raw.length;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const HASH_MASK = 32767;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n);
  const mLen = new Uint16Array(n);
  const mDist = new Int32Array(n);
  const mLen2 = new Uint16Array(n);
  const mDist2 = new Int32Array(n);
  const hashAt = (i) => ((((raw[i] << 16) ^ (raw[i + 1] << 8) ^ raw[i + 2]) * 0x9E3779B1) >>> 17) & HASH_MASK;
  const bw = new BitWriter(n + 65536);
  const lenCost = new Float64Array(259);
  const distCostFull = new Float64Array(32769);

  for (let bs = 0; bs < n; bs += BLOCK) {
    const be = Math.min(n, bs + BLOCK);
    const m = be - bs;
    // ---- match finding for this block ----
    let carryLen = 0, carryDist = 0;
    for (let i = bs; i < be; i++) {
      let bestLen = 0, bestDist = 0, recentLen = 0, recentDist = 0;
      const maxLen = Math.min(258, be - i);
      if (carryLen >= 3 && carryDist <= 32768 && carryLen <= maxLen) {
        const c = i - carryDist;
        let L = carryLen;
        while (L < maxLen && raw[i + L] === raw[c + L]) L++;
        bestLen = L; bestDist = carryDist;
      }
      if (i + 2 < n && maxLen >= 3) {
        const h = hashAt(i);
        let cand = head[h];
        let chain = 0;
        const limit = bestLen >= 32 ? RECENT_LIMIT : CHAIN;
        while (cand >= 0 && chain < limit) {
          chain++;
          const dist = i - cand;
          if (dist > 32768) break;
          let len = 0;
          const isFirst = chain === 1;
          if (raw[i] === raw[cand] && raw[i + 1] === raw[cand + 1] && raw[i + 2] === raw[cand + 2] &&
              (isFirst || !(bestLen >= 3 && bestLen < maxLen && raw[i + bestLen] !== raw[cand + bestLen]))) {
            len = 3;
            while (len + 4 <= maxLen) {
              if (dv.getUint32(i + len, true) !== dv.getUint32(cand + len, true)) break;
              len += 4;
            }
            while (len < maxLen && raw[i + len] === raw[cand + len]) len++;
          }
          if (isFirst) { recentLen = len; recentDist = dist; }
          if (len > bestLen) {
            bestLen = len; bestDist = dist;
            if (len >= maxLen) break;
          }
          // Nice match: a long match at a short distance is good enough;
          // stop walking the chain (the main time saver on flat data).
          if (len >= 128 && dist <= 16384) break;
          cand = prev[cand];
        }
        prev[i] = head[h]; head[h] = i;
      } else if (i + 2 < n) {
        const h = hashAt(i);
        prev[i] = head[h]; head[h] = i;
      }
      mLen[i] = bestLen; mDist[i] = bestDist;
      mLen2[i] = recentLen; mDist2[i] = recentDist;
      if (bestLen >= 4) { carryLen = bestLen - 1; carryDist = bestDist; }
      else { carryLen = 0; carryDist = 0; }
    }
    // ---- DP passes ----
    const cost = new Float64Array(m + 1);
    const choiceLen = new Uint16Array(m);
    const choiceDist = new Int32Array(m);
    let litCost = FIXED_LIT;
    let distCost = new Float64Array(30).fill(5);
    let tokens = null, litLens = null, distLens = null;
    for (let p = 0; p < PASSES; p++) {
      for (let len = 3; len <= 258; len++) {
        const s = lenSymbol(len);
        lenCost[len] = (litCost[s] === 0 ? 1e9 : litCost[s]) + LEN_EXTRA[s - 257];
      }
      for (let d = 1; d <= 32768; d++) {
        const s = distSymbol(d);
        distCostFull[d] = (distCost[s] === 0 ? 1e9 : distCost[s]) + DIST_EXTRA[s];
      }
      cost[m] = 0;
      for (let i = m - 1; i >= 0; i--) {
        const gi = bs + i;
        const lc = litCost[raw[gi]];
        let best = (lc === 0 ? 1e9 : lc) + cost[i + 1];
        let bl = 0, bd = 0;
        const L = mLen[gi];
        if (L >= 3) {
          const D = mDist[gi];
          const dc = distCostFull[D];
          const cands = CAND[L];
          for (let k = 0; k < cands.length; k++) {
            const len = cands[k];
            const c = lenCost[len] + dc + cost[i + len];
            if (c < best) { best = c; bl = len; bd = D; }
          }
        }
        const L2 = mLen2[gi];
        if (L2 >= 3) {
          const D2 = mDist2[gi];
          if (D2 !== mDist[gi]) {
            const dc2 = distCostFull[D2];
            const cands2 = CAND[L2];
            for (let k = 0; k < cands2.length; k++) {
              const len = cands2[k];
              const c = lenCost[len] + dc2 + cost[i + len];
              if (c < best) { best = c; bl = len; bd = D2; }
            }
          }
        }
        cost[i] = best; choiceLen[i] = bl; choiceDist[i] = bd;
      }
      tokens = [];
      const litFreq = new Int32Array(288);
      const distFreq = new Int32Array(30);
      let i = 0;
      while (i < m) {
        const len = choiceLen[i];
        if (len === 0) {
          const sym = raw[bs + i];
          tokens.push(sym);
          litFreq[sym]++;
          i++;
        } else {
          const dist = choiceDist[i];
          const ls = lenSymbol(len);
          const ds = distSymbol(dist);
          tokens.push((len << 16) | dist);
          litFreq[ls]++;
          distFreq[ds]++;
          i += len;
        }
      }
      litFreq[256]++;
      litLens = huffmanLengths(litFreq, 15);
      distLens = huffmanLengths(distFreq, 15);
      litCost = new Float64Array(288);
      for (let s = 0; s < 288; s++) litCost[s] = litLens[s];
      distCost = new Float64Array(30);
      for (let s = 0; s < 30; s++) distCost[s] = distLens[s];
    }
    // ---- encode this block with the last tokens + lengths ----
    const litCodes = canonicalCodes(litLens);
    const distCodes = canonicalCodes(distLens);
    let hlit = 257, hdist = 1;
    for (let s = 286; s >= 257; s--) if (litLens[s] > 0) { hlit = s + 1; break; }
    for (let s = 29; s >= 0; s--) if (distLens[s] > 0) { hdist = s + 1; break; }
    let distLensEff = distLens, distCodesEff = distCodes;
    if (hdist === 1 && distLens[0] === 0) {
      distLensEff = Uint8Array.from(distLens); distLensEff[0] = 1;
      distCodesEff = canonicalCodes(distLensEff);
    }
    const allLens = new Uint8Array(hlit + hdist);
    allLens.set(litLens.subarray(0, hlit), 0);
    allLens.set(distLensEff.subarray(0, hdist), hlit);
    const clTokens = rleCodeLengths(allLens);
    const clFreq = new Int32Array(19);
    for (const [sym] of clTokens) clFreq[sym]++;
    const clLens = huffmanLengths(clFreq, 7);
    const clCodes = canonicalCodes(clLens);
    let hclen = 4;
    for (let k = 18; k >= 4; k--) if (clLens[CL_ORDER[k]] > 0) { hclen = k + 1; break; }
    const isFinal = be === n ? 1 : 0;
    bw.write(isFinal, 1);
    bw.write(2, 2);
    bw.write(hlit - 257, 5);
    bw.write(hdist - 1, 5);
    bw.write(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) bw.write(clLens[CL_ORDER[k]], 3);
    for (const [sym, extra] of clTokens) {
      bw.writeCode(clCodes[sym], clLens[sym]);
      if (sym === 16) bw.write(extra, 2);
      else if (sym === 17) bw.write(extra, 3);
      else if (sym === 18) bw.write(extra, 7);
    }
    for (let t = 0; t < tokens.length; t++) {
      const v = tokens[t];
      if (v < 256) {
        bw.writeCode(litCodes[v], litLens[v]);
      } else {
        const len = v >>> 16;
        const dist = v & 0xffff;
        const ls = lenSymbol(len);
        const ds = distSymbol(dist);
        bw.writeCode(litCodes[ls], litLens[ls]);
        bw.write(len - LEN_BASE[ls - 257], LEN_EXTRA[ls - 257]);
        bw.writeCode(distCodesEff[ds], distLensEff[ds]);
        bw.write(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
      }
    }
    bw.writeCode(litCodes[256], litLens[256]);
  }
  bw.flush();
  const deflate = bw.bytes();
  const out = new Uint8Array(2 + deflate.length + 4);
  out[0] = 0x78; out[1] = 0xDA;
  out.set(deflate, 2);
  new DataView(out.buffer).setUint32(2 + deflate.length, adler32(raw));
  return out;
}

// ---------------------------------------------------------------- compress
function compress(rgba, width, height) {
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    const win = screenForm(form, width, height);
    const z9 = deflateSync(win.data, FINAL);
    const bytes9 = z9.length + chunkBytes(form);
    if (best === null || bytes9 < best.bytes) best = { form, data: win.data, zlib: z9, bytes: bytes9 };
  }
  // Optimal-parsing deflate of the winner; keep whichever is smaller.
  const opt = optimalDeflate(best.data);
  const idat = opt.length + chunkBytes(best.form) < best.bytes
    ? new Uint8Array(opt.buffer, opt.byteOffset, opt.length)
    : new Uint8Array(best.zlib.buffer, best.zlib.byteOffset, best.zlib.length);
  return pngOfForm(width, height, best.form, idat);
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compress(image.rgba, image.width, image.height));
}
