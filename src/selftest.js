// Acceptance tests from spec chapter 10, run against the mock OS. Used by `selftest` in the
// browser shell and by `node tests/run.js`. Attaches to globalThis.Selftest.
(function (G) {
  'use strict';
  const { OS, Asscat, Gen, U } = G;
  const LIB = '/Users/prokop/Pictures/Lib';
  const T0 = Date.parse('2026-11-11T13:00:00Z') * 1e6;

  function env(o = {}) {
    const k = new OS.Kernel({ start: T0 });
    const lib = o.lib || LIB;
    if (!o.noLib) k.mkdir(lib, { p: true });
    const e = {
      k, lib,
      cli(...args) {
        const out = [], err = [];
        const app = new Asscat.App(k, { cwd: e.lib, out: s => out.push(s), err: s => err.push(s) });
        const code = app.run(args);
        const text = out.join('\n'); let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        return { code, json, text, err: err.join('\n') };
      },
      ok(...args) { const r = e.cli(...args); if (r.code !== 0) throw new Error(`asscat-cli ${args.join(' ')} -> exit ${r.code}: ${r.text}`); return r.json; },
      write(rel, data, mtime) { const p = e.lib + '/' + rel; k.mkdir(OS.dirname(p), { p: true }); k.writeFile(p, data, mtime != null ? { mtime } : {}); k.advance(1e9); return p; },
      db() { return Asscat.Db.parse(k.readFile(e.lib + '/.asscat/library.db')); },
      row(rel) { return e.db().paths.get(rel); },
      tick(s = 1) { k.advance(s * 1e9); },
    };
    return e;
  }
  function assert(c, msg) { if (!c) throw new Error(msg); }
  function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(`${msg}: expected ${B}, got ${A}`); }
  const tagsOf = (e, rel) => e.ok('files', rel)[0].tags;
  const resultOf = (plan, path) => plan.rows.find(r => r.path === path);

  const tests = [
    ['1 same content twice', () => {
      const e = env(); e.write('a/x.jpg', 'SAME'); e.write('b/x.jpg', 'SAME');
      e.ok('library', 'open', e.lib);
      const db = e.db(); eq(db.files.size, 1, 'files rows'); eq(db.paths.size, 2, 'paths rows');
    }],
    ['2 move in Finder keeps identity, tags, history', () => {
      const e = env(); e.write('alfa/x.jpg', 'PHOTO-1'); e.ok('library', 'open', e.lib);
      e.ok('tag', 'add', 'klient', 'qila', 'alfa/x.jpg', '--yes');
      const id = e.row('alfa/x.jpg').file_id;
      e.k.mkdir(e.lib + '/c'); e.k.rename(e.lib + '/alfa/x.jpg', e.lib + '/c/y.jpg');
      e.ok('sync');   // renamed too, so no cheap move match: it is re-hashed and lands on the same content row
      eq(e.row('c/y.jpg').file_id, id, 'same file_id');
      eq(tagsOf(e, 'c/y.jpg').klient, ['qila'], 'tags kept');
      assert(e.db().history.some(h => h.file_id === id && h.path === 'alfa/x.jpg'), 'old path in history');
      assert(e.ok('search', 'alfa').some(r => r.file_id === id), 'search finds old folder name (note: spec says "search a", but words < 2 chars are not indexed)');
    }],
    ['3 renamed folder: 200 files, no reads', () => {
      const e = env(); e.k.mkdir(e.lib + '/old/sub', { p: true });
      for (let i = 0; i < 200; i++) e.k.writeFile(`${e.lib}/old/${i % 2 ? 'sub/' : ''}f${i}.jpg`, 'c' + i);
      e.ok('library', 'open', e.lib);
      e.k.rename(e.lib + '/old', e.lib + '/new');
      let reads = 0; e.k.trace = (op, p) => { if (p.startsWith(e.lib + '/') && !p.includes('/.asscat/')) reads++; };
      const s = e.ok('sync'); e.k.trace = null;
      eq([s.moved, s.moved_folders, s.hashed, s.new, s.gone], [200, 1, 0, 0, 0], '[moved, folders, hashed, new, gone]');
      eq(reads, 0, 'file reads during sync');
    }],
    ['4 save over original -> edge + inherited tags (auto / ask / manual)', () => {
      for (const mode of ['auto', 'ask', 'manual']) {
        const e = env(); e.write('x.jpg', 'version-1'); e.ok('library', 'open', e.lib);
        e.ok('setting', 'set', 'edge.same_path', JSON.stringify(mode));
        e.ok('tag', 'add', 'klient', 'qila', 'x.jpg', '--yes');
        const old = e.row('x.jpg').file_id;
        e.write('x.jpg', 'version-2'); e.ok('sync');
        const nw = e.row('x.jpg').file_id; assert(nw !== old, 'new file_id');
        const edges = e.db().edges;
        const t = tagsOf(e, 'x.jpg');
        if (mode === 'manual') { eq(edges.length, 0, 'manual: no edge'); assert(!t.klient, 'manual: no tags'); continue; }
        eq(edges.map(x => [x.from_id, x.to_id, x.origin, x.status]), [[old, nw, 'rule', mode === 'auto' ? 'confirmed' : 'suggested']], mode + ' edge');
        if (mode === 'auto') eq(t.klient[0].value, 'qila', 'inherited'); else assert(!t.klient, 'ask: not inherited');
      }
    }],
    ['5 revert edit A -> B -> A', () => {
      const e = env(); e.write('x.jpg', 'AAAA'); e.ok('library', 'open', e.lib);
      e.ok('tag', 'add', 'k', 'v', 'x.jpg', '--yes');
      const A = e.row('x.jpg').file_id;
      e.write('x.jpg', 'BBBB'); e.ok('sync'); const B = e.row('x.jpg').file_id;
      e.write('x.jpg', 'AAAA'); e.ok('sync');
      eq(e.row('x.jpg').file_id, A, 'path holds A again');
      eq(e.db().edges.map(x => [x.from_id, x.to_id]).sort(), [[A, B], [B, A]].sort(), 'edges');
      eq(tagsOf(e, 'x.jpg').k, ['v'], 'effective tags terminate');
    }],
    ['6 manual edge survives overwriting the original', () => {
      const e = env(); e.write('raw.cr3', 'RAW-1'); e.write('edit.jpg', 'EDIT'); e.ok('library', 'open', e.lib);
      e.ok('edge', 'add', 'raw.cr3', 'edit.jpg');
      const raw1 = e.row('raw.cr3').file_id, ed = e.row('edit.jpg').file_id;
      e.write('raw.cr3', 'RAW-2'); e.ok('sync'); const raw2 = e.row('raw.cr3').file_id;
      const E = e.db().edges;
      assert(E.some(x => x.from_id === raw1 && x.to_id === ed && x.origin === 'user'), 'user edge stays on old version');
      assert(E.some(x => x.from_id === raw1 && x.to_id === raw2 && x.origin === 'rule'), 'rule edge old -> new');
    }],
    ['7 typo: qila / Qila is one value', () => {
      const e = env(); e.write('a.jpg', '1'); e.write('b.jpg', '2'); e.ok('library', 'open', e.lib);
      e.ok('tag', 'add', 'klient', 'qila', 'a.jpg', '--yes'); e.ok('tag', 'add', 'Klient', 'Qila', 'b.jpg', '--yes');
      eq(e.ok('tag', 'values', 'klient'), [{ value: 'qila', files: 2 }], 'values');
    }],
    ['8 two clients and missing value', () => {
      const t = U.parseLocal('2026-08-07 12:00', 60);
      const e = env(); e.write('f1.jpg', 'one', t); e.write('f2.jpg', 'two', t); e.ok('library', 'open', e.lib);
      e.ok('tag', 'add', 'klient', 'qila', 'f1.jpg', '--yes'); e.ok('tag', 'add', 'klient', 'lal', 'f1.jpg', '--yes');
      e.ok('view', 'set', 'v', '{klient}/{rok}');
      let p = e.ok('materialize', 'v');
      eq(resultOf(p, 'f1.jpg').target, 'lal + qila/2026/f1.jpg', 'two clients'); eq(resultOf(p, 'f1.jpg').reason, '2 values: klient', 'reason');
      eq(resultOf(p, 'f2.jpg').target, 'bez klient/2026/f2.jpg', 'no client');
      e.ok('view', 'set', 'v', '{klient}/{rok}', '--none', 'klient=bez klienta');
      p = e.ok('materialize', 'v'); eq(resultOf(p, 'f2.jpg').target, 'bez klienta/2026/f2.jpg', 'none name');
    }],
    ['9 invalid value', () => {
      const e = env(); e.write('f.jpg', 'x'); e.ok('library', 'open', e.lib);
      const pv = e.ok('tag', 'add', 'klient', 'A/B', 'f.jpg'); eq(pv.warning, "value can't be a folder name", 'warning'); eq(pv.applied, false, 'preview only');
      e.ok('tag', 'add', 'klient', 'A/B', 'f.jpg', '--yes'); e.ok('view', 'set', 'v', '{klient}');
      eq(resultOf(e.ok('materialize', 'v'), 'f.jpg').result, 'stay:invalid', 'result');
    }],
    ['10 name conflict', () => {
      const e = env(); e.write('a/IMG_0001.JPG', 'older', T0 - 3600e9); e.write('b/IMG_0001.JPG', 'younger', T0 - 60e9);
      e.ok('library', 'open', e.lib); e.ok('tag', 'add', 'shoot', 'S', 'a/', 'b/', '--yes'); e.ok('view', 'set', 'v', '{shoot}');
      const p = e.ok('materialize', 'v');
      eq([resultOf(p, 'a/IMG_0001.JPG').result, resultOf(p, 'b/IMG_0001.JPG').result], ['stay:conflict', 'stay:conflict'], 'without consent');
      const r = e.ok('materialize', 'v', '--rename-conflicts', '--apply'); eq(r.done, 2, 'done');
      eq(e.k.readFile(e.lib + '/S/IMG_0001.JPG'), 'older', 'older keeps name');
      eq(e.k.readFile(e.lib + '/S/IMG_0001 (1).JPG'), 'younger', 'younger renamed');
    }],
    ['11 duplicate: older path moves', () => {
      const e = env(); e.write('b/x.jpg', 'DUP'); e.ok('library', 'open', e.lib); e.tick(10);
      e.write('a/x.jpg', 'DUP'); e.ok('sync');
      e.ok('tag', 'add', 'klient', 'K', 'b/x.jpg', '--yes'); e.ok('view', 'set', 'v', '{klient}');
      const p = e.ok('materialize', 'v');
      eq([resultOf(p, 'b/x.jpg').result, resultOf(p, 'a/x.jpg').result], ['move', 'stay:duplicate'], 'results');
    }],
    ['12 locked folder + project file warning', () => {
      const e = env(); e.write('Projekty/song.flp', 'flp'); e.write('Projekty/a.wav', 'wav'); e.write('loose.flp', 'flp2'); e.write('p.jpg', 'jpg');
      e.ok('library', 'open', e.lib); e.ok('setting', 'set', 'materialize.locked', '["Projekty"]'); e.ok('view', 'set', 'v', '{druh}');
      const p = e.ok('materialize', 'v');
      eq([resultOf(p, 'Projekty/song.flp').result, resultOf(p, 'Projekty/a.wav').result], ['stay:locked', 'stay:locked'], 'locked');
      eq(p.warnings[0].warning, 'project files present', 'warning'); eq(p.warnings[0].paths, ['loose.flp'], 'only outside locked');
      e.ok('materialize', 'v', '--apply'); assert(e.k.exists(e.lib + '/Projekty/song.flp'), 'nothing moved under Projekty');
    }],
    ['13 crash in the middle + recovery', () => {
      const e = env(); for (let i = 0; i < 10; i++) e.write(`in/f${i}.jpg`, 'c' + i);
      e.ok('library', 'open', e.lib); e.ok('tag', 'add', 'klient', 'K', 'in/', '--yes'); e.ok('view', 'set', 'v', '{klient}');
      const c = e.cli('--crash-after', '4', 'materialize', 'v', '--apply'); eq(c.code, 137, 'killed');
      const info = e.ok('library'); eq(info.recovered, [{ op: 1, done: 4, skipped: 6, failed: 0 }], 'recovered');
      const disk = []; const walk = d => { for (const n of e.k.readdir(d)) { const p = d + '/' + n; if (n === '.asscat') continue; e.k.stat(p).type === 'dir' ? walk(p) : disk.push(p.slice(e.lib.length + 1)); } }; walk(e.lib);
      eq(disk.length, 10, 'no file lost or doubled');
      eq([...e.db().paths.keys()].sort(), disk.sort(), 'paths == disk');
      e.ok('materialize', 'v', '--apply'); eq(e.k.readdir(e.lib + '/K').length, 10, 'rerun finishes');
    }],
    ['14 undo last materialize', () => {
      const e = env(); for (let i = 0; i < 3; i++) e.write(`in/f${i}.jpg`, 'u' + i);
      e.ok('library', 'open', e.lib); e.ok('tag', 'add', 'klient', 'K', 'in/', '--yes'); e.ok('view', 'set', 'v', '{klient}');
      e.ok('materialize', 'v', '--apply');
      e.k.mkdir(e.lib + '/mine'); e.k.rename(e.lib + '/K/f1.jpg', e.lib + '/mine/f1.jpg');      // Finder move
      const u = e.ok('materialize', 'undo', '--apply');
      eq(u.done, 2, 'two back'); eq(u.stays.map(s => s.original), ['in/f1.jpg'], 'reported');
      assert(e.k.exists(e.lib + '/in/f0.jpg') && e.k.exists(e.lib + '/mine/f1.jpg'), 'disk state');
      eq(e.ok('materialize', 'undo').result, 'nothing to undo', 'only once');
    }],
    ['15 case change on case-insensitive disk', () => {
      const e = env(); e.write('IMG.JPG', 'case'); e.ok('library', 'open', e.lib); const id = e.row('IMG.JPG').file_id;
      e.k.rename(e.lib + '/IMG.JPG', e.lib + '/img.jpg');
      eq(e.ok('sync').respelled, 1, 'respelled'); eq(e.row('img.jpg').file_id, id, 'same id'); assert(!e.row('IMG.JPG'), 'old spelling gone');
    }],
    ['16 NFC and NFD folders side by side on a case-sensitive disk', () => {
      const e = env({ noLib: true }); e.k.createDisk({ name: 'CS', fs: 'apfs-cs' }); e.lib = '/Volumes/CS/lib'; e.k.mkdir(e.lib);
      e.write('St\u0159ih/a.jpg', 'nfc'); e.write('St\u0159ih'.normalize('NFD') + '/b.jpg', 'nfd');
      e.ok('library', 'open', e.lib); eq(e.db().paths.size, 2, 'two paths');
      const s = e.ok('sync'); eq([s.unchanged, s.new, s.respelled], [2, 0, 0], 'paired by exact path');
    }],
    ['17 ignored files', () => {
      const e = env(); e.write('Thumbs.db', 'x'); e.write('a.jpg', 'a'); const r = e.ok('library', 'open', e.lib);
      assert(!e.row('Thumbs.db'), 'not in paths'); eq(r.sync.skipped.ignored, ['Thumbs.db'], 'reported as ignored');
    }],
    ['18 FAT and daylight saving time', () => {
      const lib = new Asscat.Library({ k: null }, '/x'); lib.db = { library: { fs_mtime_step_ns: 2e9, fs_mtime_local: 1 } };
      assert(lib.same_mtime(T0, T0 + 3600e9, lib), '1 h shift tolerated'); assert(!lib.same_mtime(T0, T0 + 1800e9 + 5e9, lib), 'other shift not');
      const e = env({ noLib: true }); e.k.createDisk({ name: 'FAT', fs: 'msdos' }); e.lib = '/Volumes/FAT/lib'; e.k.mkdir(e.lib);
      e.write('a.jpg', 'fat-a'); e.write('b.jpg', 'fat-b'); e.ok('library', 'open', e.lib);
      e.k.tzMin = 120;                                   // timezone / DST change: FAT mtimes shift by 1 h
      const s = e.ok('sync'); eq([s.unchanged, s.changed, s.hashed], [2, 0, 0], 'nothing hashed');
    }],
    ['19 deleted database', () => {
      const e = env(); e.write('a.jpg', 'a'); e.ok('library', 'open', e.lib); e.k.unlink(e.lib + '/.asscat/library.db');
      const r = e.cli('library', 'open', e.lib); eq(r.code, 1, 'exit'); assert(/missing or damaged/.test(r.json.error), 'message');
      assert(!e.k.exists(e.lib + '/.asscat/library.db'), 'nothing created');
      eq(e.ok('library', 'open', e.lib, '--start-over').created, true, 'start over');
    }],
    ['20 lock held by another process', () => {
      const e = env(); e.ok('library', 'open', e.lib);
      const other = new Asscat.App(e.k, { err() {} }); other.pid = e.k.spawn('asscat-cli', { host: 'MacBook-Studio' });
      new Asscat.Library(other, e.lib).open();
      const r = e.cli('library'); eq(r.code, 1, 'exit');
      assert(/^the library is in use by asscat on MacBook-Studio since \d{4}-\d\d-\d\d \d\d:\d\d \(pid \d+\)$/.test(r.json.error), r.json.error);
      e.k.exit(other.pid); e.ok('library');
    }],
    ['21 search', () => {
      const e = env(); e.write('2009/Chorvatsko - Makarska/Den 3 pláž/IMG_1.jpg', 'beach'); e.write('Rodina/Babička.jpg', 'gran'); e.ok('library', 'open', e.lib);
      eq(e.ok('search', 'makarska', 'plaz')[0].paths, ['2009/Chorvatsko - Makarska/Den 3 pláž/IMG_1.jpg'], 'makarska plaz');
      eq(e.ok('search', 'babicka')[0].paths, ['Rodina/Babička.jpg'], 'babicka');
    }],
    ['22 import and shoots', () => {
      const e = env(); e.ok('library', 'open', e.lib);
      e.k.createDisk({ name: 'CARD', fs: 'exfat' }); Gen.card(e.k, '/Volumes/CARD');
      const imp = e.ok('import', 'CARD'); eq([imp.imported, imp.filtered_out], [10, 1], '[imported, filtered_out]');
      const prop = e.ok('shoots'); eq(prop.shoots.map(s => s.files.length), [6, 4], 'two shoots');
      prop.shoots[0].name = 'Svatba Novákovi'; prop.shoots[0].klient = 'Qila';
      e.k.writeFile('/tmp/proposal.json', JSON.stringify(prop));
      e.ok('shoots', 'apply', '/tmp/proposal.json', '--yes');
      const t = tagsOf(e, prop.shoots[0].files[0]); eq([t.shoot, t.klient], [['Svatba Novákovi'], ['Qila']], 'tags');
      eq(e.ok('check', 'CARD').in_library.length, 10, 'card now fully in library');
    }],
  ];

  function run(log = () => {}, only) {
    let pass = 0, fail = 0; const failures = [];
    for (const [name, fn] of tests) {
      if (only && !name.startsWith(only + ' ')) continue;
      try { fn(); pass++; log(`  ok   ${name}`); } catch (err) { fail++; failures.push([name, err]); log(`  FAIL ${name}\n       ${err.message}`); }
    }
    log(`${pass} passed, ${fail} failed`);
    return { pass, fail, failures };
  }
  G.Selftest = { run, tests, env };
})(typeof window !== 'undefined' ? window : globalThis);
