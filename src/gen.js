// Mock content generators: photo series, memory cards. Attaches to globalThis.Gen.
(function (G) {
  'use strict';
  const U = G.U, { join } = G.OS;

  // deterministic fake file body; size grows with `kb`
  function body(kind, seed, kb = 1) {
    const r = U.rng(seed);
    let s = `${kind.toUpperCase()} mock content seed=${seed}\n`;
    const target = Math.max(64, Math.floor(kb * 1024 * (0.6 + r() * 0.8)));
    while (s.length < target) s += Math.floor(r() * 1e16).toString(36);
    return s.slice(0, target);
  }

  // n photos IMG_0001.JPG... into dir with mtimes start + i*every (+ jitter)
  function photos(k, dir, n, o = {}) {
    const start = o.start ?? k.t - 86400e9, every = o.every ?? 60e9;
    const prefix = o.prefix ?? 'IMG_', ext = o.ext ?? 'JPG', first = o.first ?? 1;
    k.mkdir(dir, { p: true });
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = `${prefix}${String(first + i).padStart(4, '0')}.${ext}`;
      const p = join(dir, name);
      k.writeFile(p, body(ext, `${o.seed ?? dir}:${name}`, o.kb ?? 2), { mtime: start + i * every, btime: start + i * every });
      out.push(p);
    }
    return out;
  }

  // a camera card: two shoots a couple of days apart, plus a sidecar that the filter skips
  function card(k, mount, o = {}) {
    const n1 = o.n1 ?? 6, n2 = o.n2 ?? 4;
    const base = o.start ?? (k.t - 5 * 86400e9);
    photos(k, join(mount, 'DCIM/100MSDCF'), n1, { prefix: 'DSC0', start: base, every: 90e9, seed: mount + 'a' });
    photos(k, join(mount, 'DCIM/100MSDCF'), n2, { prefix: 'DSC0', first: n1 + 1, start: base + 2 * 86400e9, every: 120e9, seed: mount + 'b' });
    k.mkdir(join(mount, 'PRIVATE/M4ROOT'), { p: true });
    k.writeFile(join(mount, 'PRIVATE/M4ROOT/MEDIAPRO.XML'), '<xml>card index</xml>');
    k.writeFile(join(mount, '.Spotlight-V100'), 'x');
  }

  G.Gen = { body, photos, card };
})(typeof window !== 'undefined' ? window : globalThis);
