// asscat-cli: the demo app from the spec, running on the mock kernel (src/os.js).
// The "SQLite database" is an in-memory set of tables persisted as JSON in <root>/.asscat/library.db;
// every commit() rewrites that file, so anything not committed is lost when the process dies.
(function (G) {
  'use strict';
  const U = G.U, OS = G.OS;
  const { normPath, dirname, basename, join } = OS;

  class AppError extends Error { constructor(msg, exit = 1) { super(msg); this.exit = exit; } }
  class UsageError extends AppError { constructor(msg) { super(msg, 2); } }
  class Crash extends Error { constructor(msg) { super(msg); this.crash = true; } }

  const HASH_ALGO = 'sha256 (demo stand-in for blake3)';
  const PARTIAL_ALGO = 'sha256-dk:asscat 2026-11-05 partial content hash v1;n=5;len=65536';
  const USER_VERSION = 1;
  const MAX_LEVEL_BYTES = 255, MAX_PATH_CHARS = 222;
  const HISTORY_MAX = 16, BACKUPS_KEEP = 7, JOURNAL_BATCH = 500, HASH_COMMIT = 100;
  const DEFAULT_SETTINGS = {
    'edge.same_path': 'auto',
    'import.after': 'manual',
    'scan.ignore': ['Thumbs.db', 'desktop.ini', 'Icon\r'],
    'materialize.locked': [],
  };
  const SETTING_CHECK = {
    'edge.same_path': v => ['auto', 'ask', 'manual'].includes(v),
    'import.after': v => ['manual', 'auto'].includes(v),
    'scan.ignore': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'materialize.locked': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  };
  const KIND = {
    foto: 'jpg jpeg heic heif png tif tiff dng cr2 cr3 nef arw raf orf rw2'.split(' '),
    video: 'mp4 mov m4v mts m2ts avi mxf braw r3d'.split(' '),
    zvuk: 'wav mp3 aac m4a flac aif aiff'.split(' '),
  };
  const PROJECT_EXT = 'flp als logicx ptx prproj drp aep fcpbundle lrcat cocatalog'.split(' ');
  const COMPUTED = ['rok', 'mesic', 'datum', 'pripona', 'druh'];
  const WINDOWS_SYSTEM = ['$recycle.bin', 'system volume information'];
  const FS_STEP = { msdos: 2e9, exfat: 1e7, smbfs: 1e9, apfs: 1, hfs: 1e9 };
  const DEFAULT_FILTER = { include_ext: [...KIND.foto, ...KIND.video, ...KIND.zvuk] };

  const nfcLower = s => U.lower(U.nfc(s));
  const norm_key = k => nfcLower(k.trim());
  const norm_value = v => nfcLower(v.trim());
  function bad_folder_name(v) {
    return /[\/\\:*?"<>|]/.test(v) || v.startsWith('.') || v.endsWith(' ') || v.endsWith('.') || U.utf8Len(v) > MAX_LEVEL_BYTES || v === '';
  }
  function druh(ext) { const e = ext.toLowerCase(); for (const k of Object.keys(KIND)) if (KIND[k].includes(e)) return k; return 'ostatni'; }
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const ancestors = p => { const parts = p.split('/'); const out = []; for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/')); return out; };
  const under = (p, folder) => folder === '' || p.startsWith(folder + '/');

  // ---------------------------------------------------------------- database
  class Db {
    constructor(j) {
      this.user_version = j.user_version;
      this.library = j.tables.library[0] || null;
      this.seq = j.seq;
      this.files = new Map(j.tables.files.map(r => [r.id, r]));
      this.byHash = new Map(j.tables.files.map(r => [r.hash, r.id]));
      this.paths = new Map(j.tables.paths.map(r => [r.path, r]));
      this.history = j.tables.path_history;
      this.tags = j.tables.tags;
      this.edges = j.tables.edges;
      this.keywords = new Map();
      for (const r of j.tables.keywords) { if (!this.keywords.has(r.file_id)) this.keywords.set(r.file_id, new Map()); this.keywords.get(r.file_id).set(r.word, r.weight); }
      this.settings = Object.fromEntries(j.tables.settings.map(r => [r.key, r.value]));
      this.views = new Map(j.tables.views.map(r => [r.name, r]));
      this.ops = j.tables.ops; this.op_steps = j.tables.op_steps;
    }
    static empty() {
      return new Db({ user_version: USER_VERSION, seq: { files: 0, ops: 0 }, tables: { library: [], files: [], paths: [], path_history: [], tags: [], edges: [], keywords: [], settings: [], views: [], ops: [], op_steps: [] } });
    }
    static parse(text) {
      const j = JSON.parse(text);
      if (!j || j.format !== 'asscat-demo-sqlite' || !j.tables) throw new Error('not an asscat database');
      return new Db(j);
    }
    dump() {
      const kw = [];
      for (const [fid, m] of this.keywords) for (const [word, weight] of m) kw.push({ word, file_id: fid, weight });
      return JSON.stringify({
        format: 'asscat-demo-sqlite', user_version: this.user_version, seq: this.seq,
        tables: {
          library: this.library ? [this.library] : [], files: [...this.files.values()], paths: [...this.paths.values()],
          path_history: this.history, tags: this.tags, edges: this.edges, keywords: kw,
          settings: Object.entries(this.settings).map(([key, value]) => ({ key, value })),
          views: [...this.views.values()], ops: this.ops, op_steps: this.op_steps,
        },
      });
    }
    table(name) {
      const t = JSON.parse(this.dump()).tables;
      if (!(name in t)) throw new UsageError(`unknown table ${name}; tables: ${Object.keys(t).join(', ')}`);
      return t[name];
    }
  }

  // ---------------------------------------------------------------- library
  class Library {
    constructor(app, root) {
      this.app = app; this.k = app.k; this.root = normPath(root);
      this.dir = join(this.root, '.asscat'); this.dbPath = join(this.dir, 'library.db');
      this.lockPath = join(this.dir, 'lock');
    }
    abs(rel) { return rel ? join(this.root, rel) : this.root; }
    err(s) { this.app.err(s); }
    commit() { this.k.writeFile(this.dbPath, this.db.dump()); }
    setting(key) { return key in this.db.settings ? JSON.parse(this.db.settings[key]) : JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key])); }
    nowS() { return this.k.nowS(); }
    path_key(p) { const k = U.nfc(p); return this.db.library.fs_case_sensitive ? k : U.lower(k); }

    // 4.1
    open(opts = {}) {
      const k = this.k;
      if (!k.exists(this.root) || k.stat(this.root).type !== 'dir') throw new AppError(`library folder not found: ${this.root}`);
      const dbExists = k.exists(this.dbPath);
      const mayCreate = opts.startOver || opts.unknownFolder;
      const missingMsg = 'library database is missing or damaged; run "library open <folder> --start-over" to create a new empty one (tags and history are lost)';
      if (!dbExists && !mayCreate) throw new AppError(missingMsg);
      k.mkdir(this.dir, { p: true });
      this.lock();
      let db = null, created = false;
      if (dbExists && !opts.startOver) {
        try { db = Db.parse(k.readFile(this.dbPath)); } catch (e) { throw new AppError(missingMsg); }
        if (db.user_version > USER_VERSION) throw new AppError('library database is newer than this program; upgrade asscat');
      } else {
        if (dbExists) {                                     // --start-over: keep the old file aside, never delete it
          const aside = `${this.dbPath}.old-${U.fmtLocal(k.now(), k.tzMin).replace(/[ :]/g, '-')}`;
          k.rename(this.dbPath, aside); this.err(`old database kept as ${aside}`);
        }
        db = Db.empty(); created = true;
        const r = U.rng(String(k.now()) + this.root);
        db.library = {
          id: 1, uuid: Array.from({ length: 16 }, () => Math.floor(r() * 256).toString(16).padStart(2, '0')).join(''),
          name: basename(this.root) || this.root, created_at: this.nowS(), hash_algo: HASH_ALGO, partial_algo: PARTIAL_ALGO,
          fs_type: null, fs_case_sensitive: 0, fs_mtime_step_ns: 1, fs_mtime_local: 0, fs_seen_at: null,
        };
      }
      this.db = db; this.created = created;
      if (created) this.commit();
      this.detect_fs();
      this.daily_backup();
      this.recover_ops();
      this.lastSync = this.sync('fast');
      return this;
    }
    // 4.8
    lock() {
      const k = this.k;
      if (!k.exists(this.lockPath)) k.writeFile(this.lockPath, '');
      if (!k.flock(this.lockPath, this.app.pid)) {
        let h = null;
        try { h = JSON.parse(k.readFile(this.lockPath)); } catch { /* unreadable */ }
        if (h && h.host && h.pid && h.since) {
          const since = h.since.replace('T', ' ').slice(0, 16);
          throw new AppError(`the library is in use by asscat on ${h.host} since ${since} (pid ${h.pid})`);
        }
        throw new AppError('the library is in use by another asscat process');
      }
      const proc = k.procs.get(this.app.pid);
      k.writeFile(this.lockPath, JSON.stringify({ host: proc ? proc.host : k.hostname, pid: this.app.pid, since: U.isoLocal(k.now(), k.tzMin) }));
    }
    // 4.3
    detect_fs() {
      const k = this.k, lib = this.db.library;
      const fs_type = k.statfs(this.root).f_fstypename;
      const probe = join(this.dir, 'CaseProbe');
      k.writeFile(probe, 'probe');
      const cs = !k.exists(join(this.dir, 'caseprobe'));
      k.unlink(probe);
      const changed = !!lib.fs_case_sensitive !== cs;
      Object.assign(lib, { fs_type, fs_case_sensitive: cs ? 1 : 0, fs_mtime_step_ns: FS_STEP[fs_type] ?? 1e9, fs_mtime_local: ['msdos', 'exfat'].includes(fs_type) ? 1 : 0, fs_seen_at: this.nowS() });
      if (changed) for (const r of this.db.paths.values()) r.path_key = this.path_key(r.path);
      this.commit();
    }
    // 4.9
    backup(name) {
      const k = this.k, dir = join(this.dir, 'backups');
      k.mkdir(dir, { p: true });
      this.commit();
      k.writeFile(join(dir, name), k.readFile(this.dbPath));
      const all = k.readdir(dir).filter(n => /^library-.*\.db$/.test(n)).sort().reverse();
      for (const old of all.slice(BACKUPS_KEEP)) k.unlink(join(dir, old));
    }
    daily_backup() {
      const p = U.localParts(this.k.now(), this.k.tzMin);
      const name = `library-${p.y}-${U.pad(p.mo)}-${U.pad(p.d)}.db`;
      const dir = join(this.dir, 'backups');
      if (this.k.exists(join(dir, name))) return;
      this.backup(name);
    }
    // 4.4
    same_mtime(a, b) {
      const lib = this.db.library;
      if (a == null || b == null) return a == b;
      const d = Math.abs(a - b);
      if (d <= lib.fs_mtime_step_ns) return true;
      if (!lib.fs_mtime_local) return false;
      const STEP = 15 * 60e9, MAX = 26 * 3600e9;
      if (d > MAX + lib.fs_mtime_step_ns) return false;
      const r = d % STEP;
      return r <= lib.fs_mtime_step_ns || STEP - r <= lib.fs_mtime_step_ns;
    }

    // ---------- scanning & hashing ----------
    scan_dir(ignore) {
      const k = this.k, out = { files: [], hidden: [], links: [], ignored: [], errors: [] };
      const ign = new Set(ignore.map(nfcLower));
      const walk = (rel) => {
        let names;
        try { names = k.readdir(this.abs(rel)); } catch (e) { out.errors.push({ path: rel, error: e.message }); return; }
        for (const name of names) {
          const p = rel ? rel + '/' + name : name;
          if (/[\uD800-\uDFFF]/.test(name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) { out.errors.push({ path: p, error: 'name is not valid UTF-8' }); continue; }
          if (name.startsWith('.')) { if (p !== '.asscat') out.hidden.push(p); continue; }
          if (WINDOWS_SYSTEM.includes(name.toLowerCase())) { out.hidden.push(p); continue; }
          if (ign.has(nfcLower(name))) { out.ignored.push(p); continue; }
          const st = k.stat(this.abs(p));
          if (st.type === 'link') { out.links.push(p); continue; }
          if (st.type === 'dir') { walk(p); continue; }
          out.files.push({ path: p, name, size: st.size, mtime_ns: st.mtime_ns, ctime_ns: st.ctime_ns, atime_ns: st.atime_ns, btime_ns: st.btime_ns });
        }
      };
      walk('');
      return out;
    }
    remove_leftover_parts() {
      const k = this.k; let n = 0;
      const walk = (abs) => {
        for (const name of k.readdir(abs)) {
          const p = join(abs, name);
          if (name === '.asscat') continue;
          const st = k.stat(p);
          if (st.type === 'dir') walk(p);
          else if (name.endsWith('.asscat-part')) { k.unlink(p); n++; }
        }
      };
      walk(this.root);
      if (n) this.err(`removed ${n} leftover part file(s) from an interrupted import`);
    }
    hash_partial(rel) { return Library.hashPartialAbs(this.k, this.abs(rel)); }
    static hashPartialAbs(k, abs) {
      const size = k.stat(abs).size, LEN = 65536, N = 5;
      const ranges = size <= N * LEN ? [[0, size]] : Array.from({ length: N }, (_, i) => [Math.floor(i * (size - LEN) / (N - 1)), LEN]);
      const parts = k.readRanges(abs, ranges);
      const head = U.utf8(`${PARTIAL_ALGO}|${size}|`);
      const all = new Uint8Array(head.length + parts.reduce((a, p) => a + p.length, 0));
      all.set(head); let o = head.length; for (const p of parts) { all.set(p, o); o += p.length; }
      return U.sha256(all);
    }
    static hashFullAbs(k, abs) { return U.sha256(k.readFile(abs)); }
    // partial + full; null when the file changed under us
    hash_unchanged(row) {
      const abs = this.abs(row.path);
      const st = this.k.stat(abs);
      if (st.size !== row.size || !this.same_mtime(st.mtime_ns, row.mtime_ns)) return null;
      const partial = Library.hashPartialAbs(this.k, abs);
      const full = Library.hashFullAbs(this.k, abs);
      const st2 = this.k.stat(abs);
      if (st2.size !== st.size || st2.mtime_ns !== st.mtime_ns) return null;
      return { partial, full };
    }
    // 4.5
    sync(mode = 'fast') {
      const now = this.nowS(), db = this.db;
      const report = { mode, listed: 0, new: 0, unchanged: 0, changed: 0, respelled: 0, moved: 0, moved_folders: 0, moved_pending: 0, gone: 0, hashed: 0, errors: [], skipped: {} };
      this.remove_leftover_parts();
      const scan = this.scan_dir(this.setting('scan.ignore'));
      const listed = scan.files; report.listed = listed.length;
      report.skipped = { hidden: scan.hidden, links: scan.links, ignored: scan.ignored };
      report.errors.push(...scan.errors);
      const rows = db.paths;
      const marks = new Map(); const used = new Set();
      const mark = (e, kind, r) => { marks.set(e.path, { kind, r }); if (r) used.add(r.path); };
      const touched = new Set();

      // 1. exact path
      for (const e of listed) {
        const r = rows.get(e.path); if (!r) continue;
        mark(e, r.size === e.size && this.same_mtime(r.mtime_ns, e.mtime_ns) ? 'unchanged' : 'changed', r);
      }
      // 2. other spelling of the same path
      const byKey = new Map();
      for (const r of rows.values()) if (!used.has(r.path)) { const kk = this.path_key(r.path); if (!byKey.has(kk)) byKey.set(kk, []); byKey.get(kk).push(r); }
      for (const e of listed) {
        if (marks.has(e.path)) continue;
        const cands = (byKey.get(this.path_key(e.path)) || []).filter(r => !used.has(r.path));
        if (cands.length === 1 && cands[0].size === e.size && this.same_mtime(cands[0].mtime_ns, e.mtime_ns)) mark(e, 'respelled', cands[0]);
      }
      // 3. whole-folder move (no reading)
      {
        const gone = [...rows.values()].filter(r => !used.has(r.path));
        const fresh = listed.filter(e => !marks.has(e.path));
        const tops = (all, subset) => {
          const total = new Map(), part = new Map();
          for (const x of all) for (const f of ancestors(x.path)) total.set(f, (total.get(f) || 0) + 1);
          for (const x of subset) for (const f of ancestors(x.path)) part.set(f, (part.get(f) || 0) + 1);
          const q = new Set([...part.keys()].filter(f => part.get(f) === total.get(f)));
          return [...q].filter(f => !q.has(dirname('/' + f).slice(1)) || !f.includes('/'));
        };
        const sig = (F, items) => {
          const lines = items.filter(x => under(x.path, F)).map(x => `${x.path.slice(F.length + 1)}\t${x.size}\t${x.mtime_ns}`).sort(cmpStr);
          return lines.length >= 2 ? U.sha256(lines.join('\n')) : null;
        };
        const goneTops = tops([...rows.values()], gone), freshTops = tops(listed, fresh);
        const goneSig = new Map(), freshSig = new Map();
        for (const F of goneTops) { const s = sig(F, gone); if (s) { if (!goneSig.has(s)) goneSig.set(s, []); goneSig.get(s).push(F); } }
        for (const F of freshTops) { const s = sig(F, fresh); if (s) { if (!freshSig.has(s)) freshSig.set(s, []); freshSig.get(s).push(F); } }
        for (const [s, Gs] of goneSig) {
          const Ns = freshSig.get(s);
          if (Gs.length !== 1 || !Ns || Ns.length !== 1) continue;
          const Gf = Gs[0], N = Ns[0];
          for (const e of fresh) if (under(e.path, N)) {
            const r = rows.get(Gf + '/' + e.path.slice(N.length + 1));
            if (r && !used.has(r.path)) mark(e, r.file_id == null ? 'moved_pending' : 'moved_folder', r);
          }
          report.moved_folders++;
        }
      }
      // 4. single-file move
      {
        const byTriple = new Map(), dup = new Set();
        for (const r of rows.values()) if (!used.has(r.path)) {
          const key = `${basename('/' + r.path)}\u0000${r.size}\u0000${r.mtime_ns}`;
          if (byTriple.has(key)) dup.add(key); else byTriple.set(key, r);
        }
        for (const d of dup) byTriple.delete(d);
        for (const e of listed) {
          if (marks.has(e.path)) continue;
          const key = `${e.name}\u0000${e.size}\u0000${e.mtime_ns}`;
          const r = byTriple.get(key); if (!r || used.has(r.path)) continue;
          if (r.file_id == null) { mark(e, 'moved_pending', r); continue; }
          let ph; try { ph = this.hash_partial(e.path); } catch (err) { continue; }
          if (ph === db.files.get(r.file_id).partial_hash) mark(e, 'moved', r);
        }
      }
      // 5. write (one transaction)
      const newRow = (e, extra) => ({
        path: e.path, path_key: this.path_key(e.path), file_id: null, size: e.size, mtime_ns: e.mtime_ns, ctime_ns: e.ctime_ns,
        atime_ns: e.atime_ns, btime_ns: e.btime_ns, first_seen: now, last_full_check: null, changed_from: null, prev_path: null, read_error: null, ...extra,
      });
      const times = (r, e) => { r.ctime_ns = e.ctime_ns; r.atime_ns = e.atime_ns; r.btime_ns = e.btime_ns; };
      for (const e of listed) {
        const m = marks.get(e.path);
        if (!m) { rows.set(e.path, newRow(e)); report.new++; continue; }
        const r = m.r;
        switch (m.kind) {
          case 'unchanged': times(r, e); report.unchanged++; break;
          case 'respelled':
            rows.delete(r.path); r.path = e.path; r.path_key = this.path_key(e.path); times(r, e); rows.set(e.path, r);
            if (r.file_id) touched.add(r.file_id); report.respelled++; break;
          case 'changed':
            Object.assign(r, { size: e.size, mtime_ns: e.mtime_ns, changed_from: r.file_id ?? r.changed_from, file_id: null, last_full_check: null });
            times(r, e); report.changed++; break;
          case 'moved': case 'moved_folder':
            rows.delete(r.path);
            rows.set(e.path, newRow(e, { file_id: r.file_id }));
            this.add_history(r.file_id, r.path, now); touched.add(r.file_id);
            report.moved++; break;
          case 'moved_pending':
            rows.delete(r.path);
            rows.set(e.path, newRow(e, { prev_path: r.prev_path ?? r.path, changed_from: r.changed_from }));
            report.moved_pending++; break;
        }
      }
      const listedSet = new Set(listed.map(e => e.path));
      for (const r of [...rows.values()]) {
        if (used.has(r.path) || listedSet.has(r.path)) continue;
        rows.delete(r.path); report.gone++;
        if (r.file_id) { this.add_history(r.file_id, r.path, now); touched.add(r.file_id); }
      }
      this.commit();

      // 6. hashing
      const todo = [...rows.values()].filter(r => mode === 'full' || r.file_id == null).sort((a, b) => cmpStr(a.path, b.path));
      let sinceCommit = 0;
      for (const row of todo) {
        let h = null;
        try { h = this.hash_unchanged(row); if (h == null) row.read_error = 'changed while hashing'; }
        catch (e) { row.read_error = e.message; report.errors.push({ path: row.path, error: e.message }); }
        if (h == null) continue;
        let id = db.byHash.get(h.full);
        if (!id) {
          id = ++db.seq.files;
          db.files.set(id, { id, hash: h.full, partial_hash: h.partial, size: row.size, first_seen: now, last_seen: now, format: null, meta_parser: null, meta: null });
          db.byHash.set(h.full, id);
        }
        if (mode === 'full' && row.file_id && row.file_id !== id) { row.changed_from = row.file_id; report.changed++; }
        if (row.file_id && row.file_id !== id) touched.add(row.file_id);
        row.file_id = id; row.last_full_check = now; row.read_error = null;
        if (row.prev_path) { this.add_history(id, row.prev_path, now); row.prev_path = null; }
        if (row.changed_from && row.changed_from !== id) { this.same_path_edge(row.changed_from, id); touched.add(row.changed_from); }
        row.changed_from = null;
        touched.add(id); report.hashed++;
        if (++sinceCommit >= HASH_COMMIT) { this.commit(); sinceCommit = 0; }
      }
      // 7. cleanup
      for (const r of rows.values()) if (r.file_id) db.files.get(r.file_id).last_seen = now;
      this.trim_history();
      this.rebuild_keywords([...touched]);
      this.commit();
      return report;
    }
    activePaths(fid) { const out = []; for (const r of this.db.paths.values()) if (r.file_id === fid) out.push(r.path); return out.sort(cmpStr); }
    add_history(file_id, path, at) {
      const h = this.db.history;
      const i = h.findIndex(x => x.file_id === file_id && x.path === path);
      if (i >= 0) h[i].left_at = at; else h.push({ file_id, path, left_at: at });
      const active = new Set(this.activePaths(file_id));
      this.db.history = h.filter(x => !(x.file_id === file_id && active.has(x.path)));
    }
    trim_history() {
      const by = new Map();
      for (const x of this.db.history) { if (!by.has(x.file_id)) by.set(x.file_id, []); by.get(x.file_id).push(x); }
      const keep = [];
      for (const list of by.values()) keep.push(...list.sort((a, b) => b.left_at - a.left_at).slice(0, HISTORY_MAX));
      this.db.history = keep;
    }
    // 4.6
    same_path_edge(old_id, new_id) {
      const mode = this.setting('edge.same_path');
      if (mode === 'manual') return;
      if (this.db.edges.some(e => e.from_id === old_id && e.to_id === new_id)) return;
      this.db.edges.push({ from_id: old_id, to_id: new_id, origin: 'rule', status: mode === 'auto' ? 'confirmed' : 'suggested', score: null, method: 'same-path@1', bridged: 0, created_at: this.nowS() });
    }

    // ---------- 3.9 interface for import/check ----------
    files_with_size(size) {
      const out = [];
      for (const r of this.db.paths.values()) {
        if (!r.file_id) continue;
        const f = this.db.files.get(r.file_id);
        if (f.size === size) out.push({ rel_path: r.path, mtime_ns: r.mtime_ns ?? 0, partial_hash: f.partial_hash, full_hash: f.hash });
      }
      return out;
    }
    files_under(folder) { return [...this.db.paths.values()].filter(r => under(r.path, folder)).map(r => [r.path, r.mtime_ns]); }

    // ---------- 5 tags & search ----------
    ownTags(fid) { return this.db.tags.filter(t => t.file_id === fid); }
    effective_tags(fid) {
      const out = new Map();
      const add = (t, from) => {
        if (!out.has(t.key)) out.set(t.key, new Map());
        const m = out.get(t.key);
        if (!m.has(t.value_key)) m.set(t.value_key, { value: t.value, from });
      };
      for (const t of this.ownTags(fid)) add(t, fid);
      const seen = new Set([fid]), queue = [fid];
      while (queue.length) {
        const cur = queue.shift();
        for (const e of this.db.edges) {
          if (e.to_id !== cur || e.status !== 'confirmed' || seen.has(e.from_id)) continue;
          seen.add(e.from_id); queue.push(e.from_id);
          for (const t of this.ownTags(e.from_id)) add(t, e.from_id);
        }
      }
      return out;
    }
    tagsJson(fid) {
      const o = {};
      for (const [k, m] of this.effective_tags(fid)) o[k] = [...m.values()].map(v => v.from === fid ? v.value : { value: v.value, inherited_from: { file_id: v.from, path: this.activePaths(v.from)[0] ?? this.db.history.find(h => h.file_id === v.from)?.path ?? '(earlier version, no longer on disk)' } });
      return o;
    }
    rebuild_keywords(ids) {
      for (const fid of ids) {
        const f = this.db.files.get(fid); if (!f) continue;
        this.db.keywords.delete(fid);
        if (f.size === 0) continue;
        const m = new Map();
        const put = (w, wt) => { if (!(m.get(w) >= wt)) m.set(w, wt); };
        const addPath = (path, factor) => {
          const parts = path.split('/'), folders = parts.slice(0, -1), file = parts[parts.length - 1];
          folders.forEach((fo, i) => U.words(fo).forEach(w => put(w, (1 + i) * factor)));
          U.words(U.stem(file)).forEach(w => put(w, (folders.length + 2) * factor));
          U.words(U.ext(file)).forEach(w => put(w, 1 * factor));
        };
        for (const p of this.activePaths(fid)) addPath(p, 1.0);
        for (const h of this.db.history) if (h.file_id === fid) addPath(h.path, 0.5);
        for (const t of this.ownTags(fid)) for (const w of U.words(t.value)) put(w, 4.0);
        if (m.size) this.db.keywords.set(fid, m);
      }
    }
    search(query) {
      const q = U.words(query); if (!q.length) return [];
      let ids = null; const cand = {};
      for (const w of q) {
        cand[w] = new Map();
        for (const [fid, m] of this.db.keywords) for (const [word, wt] of m) if (word.startsWith(w)) cand[w].set(fid, Math.max(cand[w].get(fid) || 0, wt));
        const s = new Set(cand[w].keys());
        ids = ids ? new Set([...ids].filter(x => s.has(x))) : s;
      }
      const nowNs = this.k.now();
      const res = [...ids].map(id => {
        let score = q.reduce((a, w) => a + cand[w].get(id), 0);
        const bonus = [...this.db.paths.values()].some(r => r.file_id === id && r.atime_ns != null && r.last_full_check != null &&
          r.atime_ns > (r.last_full_check + 60) * 1e9 && r.atime_ns > nowNs - 30 * 86400e9);
        if (bonus) score += 0.5;
        const paths = this.activePaths(id);
        return { file_id: id, paths, tags: this.tagsJson(id), score };
      });
      res.sort((a, b) => b.score - a.score || (Math.min(...a.paths.map(p => p.length), 1e9) - Math.min(...b.paths.map(p => p.length), 1e9)));
      return res;
    }

    // 5.2 selector -> {ids, pending, missing}
    resolve(sel, cwd) {
      const ids = new Set(), pending = [], missing = [];
      const addRow = r => { if (r.file_id) ids.add(r.file_id); else pending.push(r.path); };
      for (const s of sel.paths) {
        const base = (cwd === this.root || cwd.startsWith(this.root + '/')) ? cwd : this.root;
        const abs = normPath(s, base);
        if (abs !== this.root && !abs.startsWith(this.root + '/')) { missing.push(s); continue; }
        const rel = abs === this.root ? '' : abs.slice(this.root.length + 1);
        const exact = this.db.paths.get(rel);
        if (exact && !s.endsWith('/')) { addRow(exact); continue; }
        const key = this.path_key(rel);
        const inFolder = [...this.db.paths.values()].filter(r => rel === '' || r.path_key.startsWith(key + '/'));
        if (inFolder.length) { inFolder.forEach(addRow); continue; }
        const byKey = [...this.db.paths.values()].filter(r => r.path_key === key);
        if (byKey.length) { byKey.forEach(addRow); continue; }
        missing.push(s);
      }
      if (sel.search != null) for (const r of this.search(sel.search)) ids.add(r.file_id);
      if (sel.view != null) {
        const v = this.getView(sel.view);
        const folder = (sel.folder || '').replace(/\/+$/, '');
        for (const it of this.viewItems(v)) if (!it.error && (it.folder === folder || it.folder.startsWith(folder + '/') || folder === '')) ids.add(it.row.file_id);
      }
      if (missing.length) throw new AppError(`not in library: ${missing.join(', ')}`);
      return { ids: [...ids].sort((a, b) => a - b), pending };
    }
    tag_add(sel, key, value, apply) {
      const k = norm_key(key); if (!k) throw new AppError('empty tag key');
      const vt = value.trim(); if (!vt) throw new AppError('empty tag value');
      const existing = this.db.tags.find(t => t.key === k && t.value_key === norm_value(vt));
      const v = existing ? existing.value : vt;
      const { ids, pending } = sel;
      const already = ids.filter(id => this.db.tags.some(t => t.file_id === id && t.key === k && t.value_key === norm_value(v))).length;
      const preview = { key: k, value: v, files: ids.length, paths: ids.reduce((a, id) => a + this.activePaths(id).length, 0), already, pending_hash: pending,
        warning: bad_folder_name(v) ? "value can't be a folder name" : null, applied: !!apply };
      if (existing && existing.value !== vt) preview.note = `existing spelling "${existing.value}" is used`;
      if (!apply) return preview;
      for (const id of ids) if (!this.db.tags.some(t => t.file_id === id && t.key === k && t.value_key === norm_value(v)))
        this.db.tags.push({ file_id: id, key: k, value: v, value_key: norm_value(v) });
      this.rebuild_keywords(ids); this.commit();
      return preview;
    }
    tag_remove(sel, key, value, apply) {
      const k = norm_key(key), vk = norm_value(value);
      const own = [], inheritedOnly = [];
      for (const id of sel.ids) {
        if (this.db.tags.some(t => t.file_id === id && t.key === k && t.value_key === vk)) own.push(id);
        else if (this.effective_tags(id).get(k)?.has(vk)) inheritedOnly.push(id);
      }
      const preview = { key: k, value: value.trim(), files: own.length, inherited_only: inheritedOnly.length, pending_hash: sel.pending, applied: !!apply };
      if (inheritedOnly.length) preview.hint = 'inherited tags can only be removed from the original (see "files" for inherited_from)';
      if (!apply) return preview;
      const s = new Set(own);
      this.db.tags = this.db.tags.filter(t => !(s.has(t.file_id) && t.key === k && t.value_key === vk));
      this.rebuild_keywords(own); this.commit();
      return preview;
    }
    tag_rename_value(key, oldV, newV, apply) {
      const k = norm_key(key), ok = norm_value(oldV), nk = norm_value(newV);
      if (!newV.trim()) throw new AppError('empty tag value');
      const rows = this.db.tags.filter(t => t.key === k && t.value_key === ok);
      if (!rows.length) throw new AppError(`no file has ${k}=${oldV}`);
      const existing = this.db.tags.find(t => t.key === k && t.value_key === nk && t.value_key !== ok);
      const v = existing ? existing.value : newV.trim();
      const merged = rows.filter(r => this.db.tags.some(t => t !== r && t.file_id === r.file_id && t.key === k && t.value_key === nk)).length;
      const preview = { key: k, from: rows[0].value, to: v, files: rows.length, merged_into_existing: existing ? true : false, merged_files: merged,
        warning: bad_folder_name(v) ? "value can't be a folder name" : null, applied: !!apply };
      if (!apply) return preview;
      for (const r of rows) {
        if (this.db.tags.some(t => t !== r && t.file_id === r.file_id && t.key === k && t.value_key === nk)) r._del = true;
        else { r.value = v; r.value_key = nk; }
      }
      this.db.tags = this.db.tags.filter(t => !t._del);
      this.rebuild_keywords([...new Set(rows.map(r => r.file_id))]); this.commit();
      return preview;
    }
    tag_rename_key(oldK, newK, apply) {
      const o = norm_key(oldK), n = norm_key(newK);
      if (!n) throw new AppError('empty tag key');
      if (o === n) throw new AppError('keys are the same after normalisation');
      const rows = this.db.tags.filter(t => t.key === o);
      if (!rows.length) throw new AppError(`no tag with key ${o}`);
      const dup = r => this.db.tags.some(t => t.file_id === r.file_id && t.key === n && t.value_key === r.value_key);
      const preview = { from: o, to: n, tags: rows.length, files: new Set(rows.map(r => r.file_id)).size, merged_with_existing_key: this.db.tags.some(t => t.key === n), duplicates_dropped: rows.filter(dup).length, applied: !!apply };
      if (!apply) return preview;
      for (const r of rows) { if (dup(r)) r._del = true; else r.key = n; }
      this.db.tags = this.db.tags.filter(t => !t._del);
      this.commit();
      return preview;
    }
    tag_values(key) {
      const k = norm_key(key), m = new Map();
      for (const t of this.db.tags) if (t.key === k) { if (!m.has(t.value_key)) m.set(t.value_key, { value: t.value, files: 0 }); m.get(t.value_key).files++; }
      return [...m.values()].sort((a, b) => b.files - a.files || cmpStr(a.value, b.value));
    }

    // ---------- 6 views ----------
    static validateTemplate(tpl) {
      if (!tpl || !tpl.trim()) throw new AppError('template is empty');
      const levels = tpl.split('/');
      const keys = [];
      levels.forEach((lvl, i) => {
        if (lvl === '' ) throw new AppError('template has an empty level');
        if (lvl === '..' || lvl.includes('..')) throw new AppError('template must not contain ".."');
        if (lvl.startsWith('.')) throw new AppError(`level "${lvl}" starts with a dot`);
        if (i === 0 && ['_inbox', '.asscat'].includes(nfcLower(lvl))) throw new AppError(`first level must not be ${lvl}`);
        const m = /^\{([^{}]+)\}$/.exec(lvl);
        if (m) { const k = norm_key(m[1]); if (!k) throw new AppError('empty placeholder'); keys.push(k); return; }
        if (/[{}]/.test(lvl)) throw new AppError(`level "${lvl}" must be exactly one {key} or fixed text without braces`);
        if (bad_folder_name(lvl)) throw new AppError(`level "${lvl}" is not a valid folder name`);
      });
      return levels.map(l => { const m = /^\{([^{}]+)\}$/.exec(l); return m ? '{' + norm_key(m[1]) + '}' : l; }).join('/');
    }
    getView(name) { const v = this.db.views.get(name); if (!v) throw new AppError(`no view named ${name}`); return v; }
    computed(k, row) {
      if (!COMPUTED.includes(k)) return null;
      const name = basename('/' + row.path);
      if (k === 'pripona') return [U.ext(name) ? U.ext(name).toLowerCase() : 'bez pripony'];
      if (k === 'druh') return [druh(U.ext(name))];
      if (row.mtime_ns == null) return [];
      const p = U.localParts(row.mtime_ns, this.k.tzMin);
      if (k === 'rok') return [String(p.y)];
      if (k === 'mesic') return [U.pad(p.mo)];
      return [`${p.y}-${U.pad(p.mo)}-${U.pad(p.d)}`];
    }
    passFilter(view, eff, row) {
      for (const c of JSON.parse(view.filter)) {
        const comp = this.computed(c.key, row);
        if (comp) { if (!comp.some(v => norm_value(v) === norm_value(c.value))) return false; }
        else if (!eff.get(c.key)?.has(norm_value(c.value))) return false;
      }
      return true;
    }
    // 6.3 -> {folder, reasons} | {error}
    target_folder(view, row, eff) {
      const none = JSON.parse(view.none_names); const levels = []; const reasons = [];
      for (const lvl of view.template.split('/')) {
        const m = /^\{(.+)\}$/.exec(lvl);
        if (!m) { levels.push(lvl); continue; }
        const k = m[1];
        let vals = this.computed(k, row) ?? [...(eff.get(k)?.values() || [])].map(x => x.value);
        const seen = new Set(); vals = vals.filter(v => { const kk = norm_value(v); if (seen.has(kk)) return false; seen.add(kk); return true; });
        vals.sort((a, b) => cmpStr(U.lower(a), U.lower(b)) || cmpStr(a, b));
        if (vals.length > 1) reasons.push(`${vals.length} values: ${k}`);
        const name = vals.length ? vals.join(' + ') : (none[k] ?? `bez ${k}`);
        if (bad_folder_name(name)) return { error: `invalid folder name "${name}"`, reasons };
        levels.push(name);
      }
      return { folder: levels.join('/'), reasons };
    }
    viewItems(view) {
      const out = [];
      for (const row of [...this.db.paths.values()].sort((a, b) => cmpStr(a.path, b.path))) {
        if (!row.file_id) continue;
        const eff = this.effective_tags(row.file_id);
        if (!this.passFilter(view, eff, row)) continue;
        const t = this.target_folder(view, row, eff);
        out.push({ row, eff, folder: t.folder, error: t.error, reasons: t.reasons });
      }
      return out;
    }
    lockedFolders() { return this.setting('materialize.locked').map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean); }
    isLocked(path) { const k = this.path_key(path); return this.lockedFolders().some(l => { const lk = this.path_key(l); return k === lk || k.startsWith(lk + '/'); }); }

    // ---------- 7 materialize ----------
    preview(view, opts = {}) {
      const tkey = p => nfcLower(p);
      const rows = []; const res = new Map();               // row.path -> result object
      const set = (row, o) => { const r = { path: row.path, target: o.target ?? null, result: o.result }; if (o.reason) r.reason = o.reason; res.set(row.path, r); rows.push(r); return r; };
      const cands = [];
      for (const row of [...this.db.paths.values()].sort((a, b) => cmpStr(a.path, b.path))) {
        if (!row.file_id) {
          if (this.passFilter(view, new Map(), row)) set(row, { result: 'stay:pending', reason: 'waiting for full hash' });
          continue;
        }
        const eff = this.effective_tags(row.file_id);
        if (!this.passFilter(view, eff, row)) continue;
        if (this.isLocked(row.path)) { set(row, { result: 'stay:locked', reason: 'under a locked folder' }); continue; }
        const t = this.target_folder(view, row, eff);
        if (t.error) { set(row, { result: 'stay:invalid', reason: t.error }); continue; }
        const target = t.folder + '/' + basename('/' + row.path);
        if (target.length > MAX_PATH_CHARS) { set(row, { result: 'stay:invalid', target, reason: 'path too long' }); continue; }
        const o = set(row, { result: target === row.path ? 'stay:in_place' : 'move', target, reason: t.reasons.join('; ') || undefined });
        cands.push({ row, o, key: tkey(target) });
      }
      // 7.2 duplicates
      const byFile = new Map();
      for (const c of cands) { const g = `${c.row.file_id}\u0000${c.key}`; if (!byFile.has(g)) byFile.set(g, []); byFile.get(g).push(c); }
      for (const g of byFile.values()) if (g.length > 1) {
        g.sort((a, b) => (a.o.result === 'stay:in_place' ? -1 : 0) - (b.o.result === 'stay:in_place' ? -1 : 0) || a.row.first_seen - b.row.first_seen || cmpStr(a.row.path, b.row.path));
        for (const c of g.slice(1)) { c.o.result = 'stay:duplicate'; c.o.reason = `same content moves from ${g[0].row.path}`; }
      }
      // 7.3 conflicts
      const live = cands.filter(c => c.o.result === 'move' || c.o.result === 'stay:in_place');
      const movers = new Set(live.filter(c => c.o.result === 'move').map(c => tkey(c.row.path)));
      const pathKeys = new Map(); for (const r of this.db.paths.values()) pathKeys.set(tkey(r.path), r.path);
      const occupiedByStayer = (key, target, selfPath) => {
        if (key === tkey(selfPath)) return false;           // only spelling changes
        if (pathKeys.has(key)) return !movers.has(key);
        return this.k.exists(this.abs(target));             // unindexed file or a folder on disk
      };
      const byTarget = new Map();
      for (const c of live) { if (!byTarget.has(c.key)) byTarget.set(c.key, []); byTarget.get(c.key).push(c); }
      const claimed = new Set();
      const toRename = [];
      for (const [key, g] of byTarget) {
        const files = new Set(g.map(c => c.row.file_id));
        const stayer = g.find(c => c.o.result === 'stay:in_place');
        if (files.size === 1) {
          const c = g[0];
          if (c.o.result === 'move' && occupiedByStayer(key, c.o.target, c.row.path)) { c.o.result = 'stay:conflict'; c.o.reason = 'target is occupied on disk'; }
          else claimed.add(key);
          continue;
        }
        let winner = stayer;
        if (!winner && opts.renameConflicts) {
          winner = [...g].sort((a, b) => (a.row.mtime_ns ?? 0) - (b.row.mtime_ns ?? 0) || cmpStr(a.row.path, b.row.path))[0];
          if (occupiedByStayer(key, winner.o.target, winner.row.path)) { winner.o.result = 'stay:conflict'; winner.o.reason = 'target is occupied on disk'; }
        }
        if (winner && winner.o.result !== 'stay:conflict') claimed.add(key);
        for (const c of g) {
          if (c === winner) continue;
          if (c.o.result === 'stay:in_place') continue;
          if (opts.renameConflicts) toRename.push(c);
          else { c.o.result = 'stay:conflict'; c.o.reason = `${files.size} different files want ${c.o.target}`; }
        }
      }
      for (const c of toRename) {
        const folder = dirname('/' + c.o.target).slice(1), name = basename('/' + c.o.target);
        const st = U.stem(name), ex = U.ext(name);
        for (let n = 1; ; n++) {
          const nn = `${st} (${n})${ex ? '.' + ex : ''}`, t = folder + '/' + nn, key = tkey(t);
          if (claimed.has(key) || occupiedByStayer(key, t, c.row.path) || pathKeys.has(key)) continue;
          if (U.utf8Len(nn) > MAX_LEVEL_BYTES || t.length > MAX_PATH_CHARS) { c.o.result = 'stay:invalid'; c.o.reason = 'renamed name exceeds limits'; break; }
          c.o.result = 'rename'; c.o.target = t; c.o.reason = `name conflict, renamed`; claimed.add(key); break;
        }
      }
      const summary = {};
      for (const r of rows) summary[r.result] = (summary[r.result] || 0) + 1;
      const warnings = [];
      const proj = [...this.db.paths.values()].filter(r => PROJECT_EXT.includes(U.ext(basename('/' + r.path)).toLowerCase()) && !this.isLocked(r.path));
      if (proj.length) warnings.push({ warning: 'project files present', hint: 'project files reference media by path; lock their folders with materialize.locked', paths: proj.map(r => r.path) });
      return { view: view.name, template: view.template, summary, warnings, rows };
    }
    // order steps so a target is free before it is used (A->B after B->C)
    orderSteps(steps) {
      const tkey = p => nfcLower(p);
      const occ = new Set([...this.db.paths.keys()].map(tkey));
      const out = []; let rest = steps.slice();
      while (rest.length) {
        const ready = rest.filter(s => !occ.has(tkey(s.to)) || tkey(s.to) === tkey(s.from));
        if (!ready.length) { out.push(...rest); break; }
        for (const s of ready) { occ.delete(tkey(s.from)); occ.add(tkey(s.to)); out.push(s); }
        rest = rest.filter(s => !ready.includes(s));
      }
      return out;
    }
    applySteps(kind, viewName, steps, opts = {}) {
      const db = this.db, k = this.k, now = this.nowS();
      const op = { id: ++db.seq.ops, kind, view: viewName, state: 'running', created_at: now, finished_at: null };
      db.ops.push(op);
      const ordered = this.orderSteps(steps);
      const recs = ordered.map((s, i) => ({ op_id: op.id, seq: i + 1, from_path: s.from, to_path: s.to, file_id: s.file_id, state: 'planned', error: null }));
      for (let i = 0; i < recs.length; i += JOURNAL_BATCH) { db.op_steps.push(...recs.slice(i, i + JOURNAL_BATCH)); this.commit(); }
      if (!recs.length) this.commit();
      let renamed = 0;
      for (let i = 0; i < recs.length; i += JOURNAL_BATCH) {
        const batch = recs.slice(i, i + JOURNAL_BATCH);
        for (const s of batch) {
          try {
            k.mkdir(dirname(this.abs(s.to_path)), { p: true });
            k.rename(this.abs(s.from_path), this.abs(s.to_path), { noReplace: true });   // rename_new: never overwrites
            s.state = 'done'; renamed++;
            if (opts.crashAfter != null && renamed >= opts.crashAfter) throw new Crash(`simulated crash after ${renamed} rename(s)`);
          } catch (e) { if (e.crash) throw e; s.state = 'failed'; s.error = e.message; }
        }
        for (const s of batch) if (s.state === 'done') this.applyPathMove(s.from_path, s.to_path, s.file_id, now);
        this.commit();
        this.err(`${kind}: ${Math.min(i + JOURNAL_BATCH, recs.length)}/${recs.length} steps`);
      }
      const skip = new Set(['', '.asscat', '_inbox']);
      for (const s of recs) if (s.state === 'done') {
        let d = dirname('/' + s.from_path).slice(1);
        while (d && !skip.has(d) && !this.isLocked(d)) {
          const abs = this.abs(d);
          if (!k.exists(abs) || k.readdir(abs).length) break;
          k.rmdir(abs); d = dirname('/' + d).slice(1);
        }
      }
      op.state = 'done'; op.finished_at = this.nowS(); this.commit();
      const res = { op_id: op.id, kind, done: recs.filter(s => s.state === 'done').length, failed: recs.filter(s => s.state === 'failed').map(s => ({ from: s.from_path, to: s.to_path, error: s.error })) };
      res.sync = this.sync('fast');
      return res;
    }
    applyPathMove(from, to, fid, now) {
      const r = this.db.paths.get(from);
      if (!r) return;
      this.db.paths.delete(from);
      r.path = to; r.path_key = this.path_key(to);
      this.db.paths.set(to, r);
      this.add_history(fid, from, now);
      this.rebuild_keywords([fid]);
    }
    materialize(view, opts) {
      const plan = this.preview(view, opts);
      if (!opts.apply) return plan;
      const p = U.localParts(this.k.now(), this.k.tzMin);
      this.backup(`library-${p.y}-${U.pad(p.mo)}-${U.pad(p.d)}-${U.pad(p.h)}${U.pad(p.mi)}${U.pad(p.s)}.db`);
      const steps = plan.rows.filter(r => r.result === 'move' || r.result === 'rename').map(r => ({ from: r.path, to: r.target, file_id: this.db.paths.get(r.path).file_id }));
      const out = this.applySteps('materialize', view.name, steps, opts);
      return { view: view.name, summary: plan.summary, warnings: plan.warnings, ...out };
    }
    // 7.5
    undo_last(apply) {
      const last = [...this.db.ops].reverse().find(o => o.kind === 'materialize');
      if (!last || last.state !== 'done') return { result: 'nothing to undo' };
      const plan = [], stays = [];
      const steps = this.db.op_steps.filter(s => s.op_id === last.id && s.state === 'done').sort((a, b) => b.seq - a.seq);
      for (const s of steps) {
        const now_row = this.db.paths.get(s.to_path);
        if (now_row && now_row.file_id === s.file_id && !this.k.exists(this.abs(s.from_path))) plan.push({ from: s.to_path, to: s.from_path, file_id: s.file_id });
        else stays.push({ path: s.to_path, original: s.from_path, result: 'moved or changed since, stays' });
      }
      const out = { undo_op: last.id, view: last.view, back: plan.length, stays };
      if (!apply) return { ...out, plan: plan.map(p => ({ from: p.from, to: p.to })) };
      const res = this.applySteps('undo', last.view, plan);
      last.state = 'undone'; this.commit();
      return { ...out, ...res };
    }
    // 7.6
    recover_ops() {
      for (const op of this.db.ops.filter(o => o.state === 'running')) {
        const c = { done: 0, skipped: 0, failed: 0 }; const now = this.nowS();
        for (const s of this.db.op_steps.filter(x => x.op_id === op.id && x.state === 'planned')) {
          const f = this.k.exists(this.abs(s.from_path)), t = this.k.exists(this.abs(s.to_path));
          if (!f && t) { s.state = 'done'; this.applyPathMove(s.from_path, s.to_path, s.file_id, now); c.done++; }
          else if (f && !t) { s.state = 'skipped'; c.skipped++; }
          else { s.state = 'failed'; s.error = 'both or neither exist'; c.failed++; }
        }
        op.state = 'done'; op.finished_at = now;
        this.commit();
        this.err(`recovered interrupted ${op.kind} #${op.id}: ${c.done} done, ${c.skipped} skipped (not started), ${c.failed} failed; run it again to finish`);
        this.recovered = (this.recovered || []).concat([{ op: op.id, ...c }]);
      }
    }
  }

  // ---------------------------------------------------------------- argument parsing
  function parseArgs(argv, spec = {}) {
    const flags = new Set(spec.flags || []), opts = new Set(spec.opts || []), multi = new Set(spec.multi || []);
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('--') && a.length > 2) {
        let [name, val] = a.slice(2).split(/=(.*)/s);
        if (flags.has(name)) { out[name] = true; continue; }
        if (opts.has(name) || multi.has(name)) {
          if (val === undefined) { val = argv[++i]; if (val === undefined) throw new UsageError(`--${name} needs a value`); }
          if (multi.has(name)) (out[name] = out[name] || []).push(val); else out[name] = val;
          continue;
        }
        throw new UsageError(`unknown option --${name}`);
      }
      out._.push(a);
    }
    return out;
  }
  const kv = (s, what) => { const i = s.indexOf('='); if (i <= 0) throw new UsageError(`${what} must be key=value: ${s}`); return [s.slice(0, i), s.slice(i + 1)]; };

  // ---------------------------------------------------------------- CLI
  const HELP = `asscat-cli [--config <file>] <command>     (changes need --apply / --yes, otherwise preview)
  library                                   show configured library
  library open <folder> [--start-over]      choose + open library
  library forget <folder>
  sync [fast|full]                          scan the library
  volumes | check <volume> | import <volume>
  filter | filter set <json>                import filter (import_filter.json)
  shoots [resolution] [min_files]           propose shoots for _inbox (prints JSON)
  shoots apply <proposal.json> [--yes]
  files <selector…>
  tag add|remove <key> <value> <selector…> [--yes]
  tag rename-value <key> <old> <new> [--yes] | tag rename-key <old> <new> [--yes]
  tag values <key>
  search <query…>
  edge add|confirm|reject <original> <edit> | edge list <path>
  setting get <key> | setting set <key> <json>
  view set <name> <template> [--filter k=v]… [--none k=name]…
  view list | view activate <name> | view delete <name> | view show <name> [<virtual folder>]
  materialize <view> [--rename-conflicts] [--apply]
  materialize undo [--apply]
  db [table]                                (demo only) dump a database table
selector: paths (relative to the library root or the current folder; "dir/" = everything below),
          --search "<query>", --view <name> --folder "<virtual folder>"`;

  class App {
    constructor(k, { cwd = '/', out = () => {}, err = () => {}, configPath, host } = {}) {
      this.k = k; this.cwd = cwd; this.out = out; this.err = err;
      this.configPath = configPath || '/Users/prokop/.config/asscat/config.json';
      this.host = host;
    }
    readConfig() {
      try { return JSON.parse(this.k.readFile(this.configPath)); } catch { return { library: null, libraries: [] }; }
    }
    writeConfig(c) { this.k.mkdir(dirname(this.configPath), { p: true }); this.k.writeFile(this.configPath, JSON.stringify(c, null, 2)); }
    filterPath() { return join(dirname(this.configPath), 'import_filter.json'); }
    readFilter() { try { return JSON.parse(this.k.readFile(this.filterPath())); } catch { return DEFAULT_FILTER; } }
    openConfigured(opts = {}) {
      const c = this.readConfig();
      if (!c.library) throw new AppError('no library configured; run "library open <folder>"');
      return new Library(this, c.library).open(opts);
    }
    // returns exit code; JSON result on stdout
    run(argv, opts = {}) {
      this.pid = this.k.spawn('asscat-cli', { host: this.host });
      this.debug = opts;
      try {
        const g = [];
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--config') { this.configPath = normPath(argv[++i] || '', this.cwd); continue; }
          if (argv[i] === '--crash-after') { this.crashAfter = Number(argv[++i]); continue; }
          g.push(argv[i]);
        }
        const res = this.dispatch(g);
        if (res !== undefined) this.out(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
        return 0;
      } catch (e) {
        if (e.crash) { this.err(`asscat-cli: process killed (${e.message})`); return 137; }
        if (e instanceof AppError) { this.out(JSON.stringify({ error: e.message })); return e.exit; }
        if (e instanceof OS.OSError) { this.out(JSON.stringify({ error: e.message })); return 1; }
        this.out(JSON.stringify({ error: 'internal: ' + e.message })); this.err(e.stack || ''); return 1;
      } finally {
        this.k.exit(this.pid);
      }
    }
    dispatch(a) {
      const [cmd, ...rest] = a;
      switch (cmd) {
        case undefined: case 'help': case '--help': return HELP;
        case 'library': return this.cmdLibrary(rest);
        case 'sync': { const lib = this.openConfigured(); const m = rest[0] || 'fast'; if (!['fast', 'full'].includes(m)) throw new UsageError('sync [fast|full]'); return m === 'fast' ? lib.lastSync : { fast_on_open: lib.lastSync, full: lib.sync('full') }; }
        case 'volumes': return this.k.disks().filter(d => d.removable && d.mountedAt).map(d => ({ name: d.name, path: d.mountedAt, fs: d.fs, has_dcim: this.k.exists(join(d.mountedAt, 'DCIM')) }));
        case 'check': return this.cmdCheck(rest, false);
        case 'import': return this.cmdCheck(rest, true);
        case 'filter': {
          if (rest[0] === 'set') { let f; try { f = JSON.parse(rest.slice(1).join(' ')); } catch { throw new UsageError('filter set <json>, e.g. {"include_ext":["jpg","cr3"]}'); } this.k.writeFile(this.filterPath(), JSON.stringify(f, null, 2)); return f; }
          return this.readFilter();
        }
        case 'shoots': return this.cmdShoots(rest);
        case 'files': { const lib = this.openConfigured(); const p = parseArgs(rest, { opts: ['search', 'view', 'folder'] }); return this.cmdFiles(lib, p); }
        case 'tag': return this.cmdTag(rest);
        case 'search': { const lib = this.openConfigured(); if (!rest.length) throw new UsageError('search <query…>'); return lib.search(rest.join(' ')); }
        case 'edge': return this.cmdEdge(rest);
        case 'setting': return this.cmdSetting(rest);
        case 'view': return this.cmdView(rest);
        case 'materialize': return this.cmdMaterialize(rest);
        case 'db': { const lib = this.openConfigured(); if (!rest[0]) return Object.fromEntries(['files', 'paths', 'path_history', 'tags', 'edges', 'keywords', 'settings', 'views', 'ops', 'op_steps'].map(t => [t, lib.db.table(t).length])); return rest[0] === 'library' ? lib.db.library : lib.db.table(rest[0]); }
        default: throw new UsageError(`unknown command ${cmd}; try "asscat-cli help"`);
      }
    }
    cmdLibrary(rest) {
      const c = this.readConfig();
      if (rest[0] === 'open') {
        const p = parseArgs(rest.slice(1), { flags: ['start-over'] });
        if (!p._[0]) throw new UsageError('library open <folder> [--start-over]');
        const root = normPath(p._[0], this.cwd);
        const known = (c.libraries || []).includes(root) || c.library === root;
        const lib = new Library(this, root).open({ startOver: !!p['start-over'], unknownFolder: !known });
        c.library = root; c.libraries = [...new Set([...(c.libraries || []), root])];
        this.writeConfig(c);
        return { library: root, created: lib.created, name: lib.db.library.name, uuid: lib.db.library.uuid, sync: lib.lastSync };
      }
      if (rest[0] === 'forget') {
        const root = normPath(rest[1] || '', this.cwd);
        c.libraries = (c.libraries || []).filter(x => x !== root); if (c.library === root) c.library = null;
        this.writeConfig(c); return { forgotten: root };
      }
      if (rest.length) throw new UsageError('library | library open <folder> | library forget <folder>');
      if (!c.library) return { library: null, hint: 'run "library open <folder>"' };
      const lib = this.openConfigured();
      const L = lib.db.library;
      return { library: lib.root, name: L.name, uuid: L.uuid, fs: { type: L.fs_type, case_sensitive: !!L.fs_case_sensitive, mtime_step_ns: L.fs_mtime_step_ns, mtime_local: !!L.fs_mtime_local },
        files: lib.db.files.size, active_paths: lib.db.paths.size, tags: lib.db.tags.length, edges: lib.db.edges.length, views: [...lib.db.views.keys()],
        active_view: [...lib.db.views.values()].find(v => v.active)?.name ?? null, recovered: lib.recovered };
    }
    volumePath(arg) {
      if (!arg) throw new UsageError('give a volume name or path (see "volumes")');
      const d = this.k.disks().find(x => x.name === arg && x.mountedAt);
      return d ? d.mountedAt : normPath(arg, this.cwd);
    }
    // existing card check/import (spec ch. 2: unchanged behaviour)
    cmdCheck(rest, doImport) {
      const lib = this.openConfigured();
      const src = this.volumePath(rest[0]);
      if (!this.k.exists(src)) throw new AppError(`volume not found: ${src}`);
      if (src === lib.root || src.startsWith(lib.root + '/') || lib.root.startsWith(src + '/')) throw new AppError('source is inside the library (or contains it)');
      const filt = this.readFilter(); const inc = new Set((filt.include_ext || []).map(x => x.toLowerCase()));
      const files = [];
      const walk = rel => {
        for (const name of this.k.readdir(join(src, rel))) {
          const p = rel ? rel + '/' + name : name;
          if (name.startsWith('.')) continue;
          const st = this.k.stat(join(src, p));
          if (st.type === 'dir') walk(p); else if (st.type === 'file') files.push({ path: p, name, size: st.size, mtime_ns: st.mtime_ns });
        }
      };
      walk('');
      const report = { source: src, total: files.length, new: [], in_library: [], filtered_out: [] };
      for (const f of files) {
        if (inc.size && !inc.has(U.ext(f.name).toLowerCase())) { report.filtered_out.push(f.path); continue; }
        const cands = lib.files_with_size(f.size);
        let hit = null;
        if (cands.length) {
          const ph = Library.hashPartialAbs(this.k, join(src, f.path));
          const pc = cands.filter(c => c.partial_hash === ph);
          if (pc.length) { const fh = Library.hashFullAbs(this.k, join(src, f.path)); hit = pc.find(c => c.full_hash === fh); }
        }
        if (hit) report.in_library.push({ path: f.path, library_path: hit.rel_path }); else report.new.push(f.path);
      }
      if (!doImport) return { ...report, new_count: report.new.length };
      const p = U.localParts(this.k.now(), this.k.tzMin);
      const destRel = `_inbox/${basename(src)} ${p.y}-${U.pad(p.mo)}-${U.pad(p.d)}`;
      this.k.mkdir(lib.abs(destRel), { p: true });
      const copied = [], failed = [];
      for (const rel of report.new) {
        const s = join(src, rel), name = basename('/' + rel);
        let target = join(lib.abs(destRel), name);
        for (let n = 1; this.k.exists(target); n++) target = join(lib.abs(destRel), `${U.stem(name)} (${n})${U.ext(name) ? '.' + U.ext(name) : ''}`);
        const part = join(dirname(target), '.' + basename(target) + '.asscat-part');
        try {
          const st = this.k.stat(s);
          const data = this.k.readFile(s);
          this.k.writeFile(part, data, { mtime: st.mtime_ns, btime: st.btime_ns });
          if (U.sha256(this.k.readFile(part)) !== U.sha256(data)) throw new Error('verification failed');
          this.k.rename(part, target, { noReplace: true });
          this.k.utimes(target, st.mtime_ns);
          copied.push(target.slice(lib.root.length + 1));
          this.err(`import: ${copied.length}/${report.new.length}`);
        } catch (e) { failed.push({ path: rel, error: e.message }); if (this.k.exists(part)) this.k.unlink(part); }
      }
      const sync = lib.sync('fast');
      const out = { source: src, imported: copied.length, already_in_library: report.in_library.length, filtered_out: report.filtered_out.length, into: destRel, failed, sync };
      if (lib.setting('import.after') === 'auto') {
        const v = [...lib.db.views.values()].find(x => x.active);
        out.after = v ? lib.materialize(v, { apply: true }) : { skipped: 'import.after=auto but no active view' };
      }
      return out;
    }
    cmdShoots(rest) {
      if (rest[0] === 'apply') {
        const p = parseArgs(rest.slice(1), { flags: ['yes'] });
        if (!p._[0]) throw new UsageError('shoots apply <proposal.json> [--yes]');
        const lib = this.openConfigured();
        let prop; try { prop = JSON.parse(this.k.readFile(normPath(p._[0], this.cwd))); } catch (e) { throw new AppError(`cannot read proposal: ${e.message}`); }
        const results = [];
        for (const s of prop.shoots || []) {
          if (!s.name) { results.push({ id: s.id, skipped: 'no name' }); continue; }
          const sel = lib.resolve({ paths: s.files }, lib.root);
          const r = { id: s.id, shoot: lib.tag_add(sel, 'shoot', s.name, p.yes) };
          if (s.klient) r.klient = lib.tag_add(sel, 'klient', s.klient, p.yes);
          results.push(r);
        }
        return { applied: !!p.yes, shoots: results };
      }
      const lib = this.openConfigured();
      const res = U.parseDuration(rest[0] || '2h'); const minFiles = Number(rest[1] || 3);
      if (res == null || !(minFiles >= 1)) throw new UsageError('shoots [resolution e.g. 2h] [min_files]');
      const files = [...lib.db.paths.values()].filter(r => r.file_id && r.path.startsWith('_inbox/')).sort((a, b) => (a.mtime_ns ?? 0) - (b.mtime_ns ?? 0) || cmpStr(a.path, b.path));
      const groups = []; let cur = [];
      for (const f of files) { if (cur.length && (f.mtime_ns ?? 0) - (cur[cur.length - 1].mtime_ns ?? 0) > res) { groups.push(cur); cur = []; } cur.push(f); }
      if (cur.length) groups.push(cur);
      const shoots = [], no_shoot = [];
      for (const g of groups) {
        if (g.length < minFiles) { no_shoot.push(...g.map(f => f.path)); continue; }
        shoots.push({ id: shoots.length + 1, from: U.fmtLocal(g[0].mtime_ns, this.k.tzMin, false), to: U.fmtLocal(g[g.length - 1].mtime_ns, this.k.tzMin, false), files: g.map(f => f.path), name: null, klient: null });
      }
      return { shoots, no_shoot, hint: 'save with "> proposal.json", fill name/klient, then "shoots apply proposal.json --yes"' };
    }
    cmdFiles(lib, p) {
      const sel = lib.resolve({ paths: p._, search: p.search, view: p.view, folder: p.folder }, this.cwd);
      const out = sel.ids.map(id => {
        const f = lib.db.files.get(id);
        const rows = [...lib.db.paths.values()].filter(r => r.file_id === id);
        return { file_id: id, hash: f.hash.slice(0, 16) + '…', size: f.size, paths: rows.map(r => ({ path: r.path, mtime: U.fmtLocal(r.mtime_ns, this.k.tzMin), hash_status: r.last_full_check ? 'verified' : 'assigned (not re-verified since move)' })),
          history: lib.db.history.filter(h => h.file_id === id).sort((a, b) => b.left_at - a.left_at).map(h => h.path),
          tags: lib.tagsJson(id),
          edges: { originals: lib.db.edges.filter(e => e.to_id === id).map(e => ({ file_id: e.from_id, paths: lib.activePaths(e.from_id), origin: e.origin, status: e.status })),
                   edits: lib.db.edges.filter(e => e.from_id === id).map(e => ({ file_id: e.to_id, paths: lib.activePaths(e.to_id), origin: e.origin, status: e.status })) } };
      });
      const pending = sel.pending.map(path => { const r = lib.db.paths.get(path); return { path, file_id: null, hash_status: r.read_error ? 'error: ' + r.read_error : 'waiting for full hash' }; });
      return [...out, ...pending];
    }
    selFrom(lib, p, n) {
      const sel = { paths: p._.slice(n), search: p.search, view: p.view, folder: p.folder };
      if (!sel.paths.length && sel.search == null && sel.view == null) throw new UsageError('missing selector (paths, --search or --view/--folder)');
      return lib.resolve(sel, this.cwd);
    }
    cmdTag(rest) {
      const [sub, ...r] = rest;
      const p = parseArgs(r, { flags: ['yes'], opts: ['search', 'view', 'folder'] });
      const lib = this.openConfigured();
      const need = (n, u) => { if (p._.length < n) throw new UsageError(u); };
      switch (sub) {
        case 'add': need(2, 'tag add <key> <value> <selector…>'); return lib.tag_add(this.selFrom(lib, p, 2), p._[0], p._[1], p.yes);
        case 'remove': need(2, 'tag remove <key> <value> <selector…>'); return lib.tag_remove(this.selFrom(lib, p, 2), p._[0], p._[1], p.yes);
        case 'rename-value': need(3, 'tag rename-value <key> <old> <new>'); return lib.tag_rename_value(p._[0], p._[1], p._[2], p.yes);
        case 'rename-key': need(2, 'tag rename-key <old> <new>'); return lib.tag_rename_key(p._[0], p._[1], p.yes);
        case 'values': need(1, 'tag values <key>'); return lib.tag_values(p._[0]);
        default: throw new UsageError('tag add|remove|rename-value|rename-key|values');
      }
    }
    oneFile(lib, path) {
      const sel = lib.resolve({ paths: [path] }, this.cwd);
      if (sel.pending.length && !sel.ids.length) throw new AppError(`${path}: waiting for full hash`);
      if (sel.ids.length !== 1) throw new AppError(`${path}: expected exactly one file, got ${sel.ids.length}`);
      return sel.ids[0];
    }
    cmdEdge(rest) {
      const [sub, a, b] = rest;
      const lib = this.openConfigured();
      if (sub === 'list') {
        if (!a) throw new UsageError('edge list <path>');
        const id = this.oneFile(lib, a);
        const desc = e => ({ original: e.from_id, edit: e.to_id, origin: e.origin, status: e.status, method: e.method });
        const walk = (start, dir) => { const seen = new Set([start]), q = [start], out = []; while (q.length) { const c = q.shift(); for (const e of lib.db.edges) { const nx = dir === 'up' ? (e.to_id === c ? e.from_id : null) : (e.from_id === c ? e.to_id : null); if (nx == null || seen.has(nx)) continue; seen.add(nx); q.push(nx); out.push({ file_id: nx, paths: lib.activePaths(nx), via: desc(e) }); } } return out; };
        return { file_id: id, paths: lib.activePaths(id), ancestors: walk(id, 'up'), descendants: walk(id, 'down') };
      }
      if (!['add', 'confirm', 'reject'].includes(sub) || !a || !b) throw new UsageError('edge add|confirm|reject <original> <edit> | edge list <path>');
      const from = this.oneFile(lib, a), to = this.oneFile(lib, b);
      if (from === to) throw new AppError('original and edit are the same content');
      let e = lib.db.edges.find(x => x.from_id === from && x.to_id === to);
      if (sub === 'add') {
        if (e) { e.origin = 'user'; e.status = 'confirmed'; e.method = null; }
        else { e = { from_id: from, to_id: to, origin: 'user', status: 'confirmed', score: null, method: null, bridged: 0, created_at: lib.nowS() }; lib.db.edges.push(e); }
      } else {
        if (!e) throw new AppError('no such edge; use "edge add"');
        e.status = sub === 'confirm' ? 'confirmed' : 'rejected';
      }
      lib.commit();
      return e;
    }
    cmdSetting(rest) {
      const [sub, key, ...v] = rest;
      if (!(key in DEFAULT_SETTINGS)) throw new UsageError(`setting get|set <key>; keys: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
      const lib = this.openConfigured();
      if (sub === 'get') return { key, value: lib.setting(key), default: key in lib.db.settings ? false : true };
      if (sub === 'set') {
        let val; try { val = JSON.parse(v.join(' ')); } catch { throw new UsageError(`value must be JSON, e.g. setting set edge.same_path '"ask"'`); }
        if (!SETTING_CHECK[key](val)) throw new AppError(`invalid value for ${key}`);
        lib.db.settings[key] = JSON.stringify(val); lib.commit();
        return { key, value: val };
      }
      throw new UsageError('setting get|set');
    }
    cmdView(rest) {
      const [sub, ...r] = rest;
      const lib = this.openConfigured();
      switch (sub) {
        case 'set': {
          const p = parseArgs(r, { multi: ['filter', 'none'] });
          const [name, tpl] = p._;
          if (!name || !tpl) throw new UsageError('view set <name> <template> [--filter k=v]… [--none k=name]…');
          const template = Library.validateTemplate(tpl);
          const filter = (p.filter || []).map(s => { const [k, v] = kv(s, '--filter'); if (!norm_key(k) || !v.trim()) throw new AppError('empty filter key/value'); return { key: norm_key(k), value: v.trim() }; });
          const none = {};
          for (const s of p.none || []) { const [k, v] = kv(s, '--none'); if (bad_folder_name(v.trim())) throw new AppError(`"${v}" is not a valid folder name`); none[norm_key(k)] = v.trim(); }
          const old = lib.db.views.get(name);
          lib.db.views.set(name, { name, template, filter: JSON.stringify(filter), none_names: JSON.stringify(none), active: old ? old.active : 0 });
          lib.commit(); return this.viewJson(lib.db.views.get(name));
        }
        case 'list': return [...lib.db.views.values()].map(v => this.viewJson(v));
        case 'activate': { const v = lib.getView(r[0]); for (const x of lib.db.views.values()) x.active = 0; v.active = 1; lib.commit(); return this.viewJson(v); }
        case 'delete': { lib.getView(r[0]); lib.db.views.delete(r[0]); lib.commit(); return { deleted: r[0] }; }
        case 'show': {
          const v = lib.getView(r[0]);
          const plan = lib.preview(v, {});
          const byPath = new Map(plan.rows.map(x => [x.path, x]));
          const items = lib.viewItems(v);
          const shownFile = new Set(); const tree = new Map(); const invalid = [];
          // a file with several paths appears once: at the path that would move (7.2)
          const order = items.slice().sort((a, b) => (byPath.get(a.row.path)?.result === 'stay:duplicate') - (byPath.get(b.row.path)?.result === 'stay:duplicate'));
          for (const it of order) {
            if (shownFile.has(it.row.file_id)) continue; shownFile.add(it.row.file_id);
            if (it.error) { invalid.push({ path: it.row.path, error: it.error }); continue; }
            if (!tree.has(it.folder)) tree.set(it.folder, []);
            tree.get(it.folder).push({ name: basename('/' + it.row.path), path: it.row.path, file_id: it.row.file_id });
          }
          const folder = (r[1] || '').replace(/\/+$/, '');
          if (folder) {
            const files = tree.get(folder) || [];
            const sub = new Map();
            for (const [f, list] of tree) if (f.startsWith(folder + '/')) { const nxt = f.slice(folder.length + 1).split('/')[0]; sub.set(nxt, (sub.get(nxt) || 0) + list.length); }
            if (!files.length && !sub.size) throw new AppError(`no virtual folder "${folder}" in view ${v.name}`);
            return { view: v.name, folder, folders: [...sub].map(([name, files]) => ({ name, files })), files };
          }
          const counts = {};
          for (const [f, list] of tree) { const parts = f.split('/'); for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join('/'); counts[k] = (counts[k] || 0) + list.length; } }
          const lines = Object.keys(counts).sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase())).map(k => `${'  '.repeat(k.split('/').length - 1)}${k.split('/').pop()}/  (${counts[k]})`);
          return { view: v.name, template: v.template, filter: JSON.parse(v.filter), files: shownFile.size, tree: lines, invalid };
        }
        default: throw new UsageError('view set|list|activate|delete|show');
      }
    }
    viewJson(v) { return { name: v.name, template: v.template, filter: JSON.parse(v.filter), none_names: JSON.parse(v.none_names), active: !!v.active }; }
    cmdMaterialize(rest) {
      const p = parseArgs(rest, { flags: ['apply', 'rename-conflicts'] });
      const lib = this.openConfigured();
      if (p._[0] === 'undo') return lib.undo_last(!!p.apply);
      if (!p._[0]) throw new UsageError('materialize <view> [--rename-conflicts] [--apply] | materialize undo [--apply]');
      const v = lib.getView(p._[0]);
      return lib.materialize(v, { apply: !!p.apply, renameConflicts: !!p['rename-conflicts'], crashAfter: this.crashAfter });
    }
  }

  G.Asscat = { App, Library, Db, AppError, HELP, bad_folder_name, norm_key, norm_value, DEFAULT_SETTINGS };
})(typeof window !== 'undefined' ? window : globalThis);
