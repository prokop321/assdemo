// Shared helpers: hashing, unicode, time formatting. Classic script, attaches to globalThis.U.
(function (G) {
  'use strict';
  const enc = new TextEncoder();

  // --- SHA-256 (synchronous). Stand-in for BLAKE3 in this demo. ---
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(input) {
    const msg = typeof input === 'string' ? enc.encode(input) : input;
    const l = msg.length, bitLen = l * 8;
    const n = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(n);
    buf.set(msg); buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(n - 8, Math.floor(bitLen / 0x100000000)); dv.setUint32(n - 4, bitLen >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  const utf8 = s => enc.encode(s);
  const utf8Len = s => enc.encode(s).length;
  const nfc = s => s.normalize('NFC');
  const lower = s => s.toLowerCase();               // full Unicode lowercase
  const stripDiacritics = s => s.normalize('NFD').replace(/\p{Mn}/gu, '');
  const words = s => stripDiacritics(lower(nfc(s))).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);

  // --- time ---
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // local parts for a UTC ns timestamp and an offset in minutes
  function localParts(ns, tzMin) {
    const d = new Date(Math.floor(ns / 1e6) + tzMin * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  function fmtLocal(ns, tzMin, withSec = true) {
    if (ns == null) return '-';
    const p = localParts(ns, tzMin);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}${withSec ? ':' + pad(p.s) : ''}`;
  }
  function tzString(tzMin) {
    const sign = tzMin < 0 ? '-' : '+'; const a = Math.abs(tzMin);
    return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  function isoLocal(ns, tzMin) {
    const p = localParts(ns, tzMin);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${tzString(tzMin)}`;
  }
  // parse "2026-08-07 14:30[:05]" (local) -> utc ns
  function parseLocal(str, tzMin) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(str.trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - tzMin * 60000;
    return ms * 1e6;
  }
  // "90s" "5m" "2h" "1d" "-1h" -> ns
  function parseDuration(str) {
    const m = /^([+-]?\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(str).trim());
    if (!m) return null;
    const mult = { ms: 1e6, s: 1e9, m: 60e9, h: 3600e9, d: 86400e9 }[m[2] || 's'];
    return Number(m[1]) * mult;
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  // deterministic PRNG for generated content
  function rng(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (const c of String(seed)) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  }
  function ext(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1) : ''; }
  function stem(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; }

  G.U = { sha256, utf8, utf8Len, nfc, lower, stripDiacritics, words, localParts, fmtLocal, isoLocal, tzString, parseLocal, parseDuration, fmtSize, rng, pad, ext, stem };
})(typeof window !== 'undefined' ? window : globalThis);
