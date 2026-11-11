// Mock unix-like kernel: volumes, inodes, mounts, clock, timezone, advisory locks, processes.
// Classic script, attaches to globalThis.OS.
(function (G) {
  'use strict';
  const U = G.U;

  class OSError extends Error {
    constructor(code, msg, path) { super(`${code}: ${msg}${path != null ? ` '${path}'` : ''}`); this.code = code; this.path = path; }
  }

  // Filesystem behaviour profiles. `step` = mtime granularity in ns, `local` = stores local wall time,
  // `cs` = case-sensitive names (here: byte-exact names), `nfd` = stores names decomposed (HFS+).
  const FS_PROFILES = {
    apfs:      { fstypename: 'apfs',  step: 1,   local: false, cs: false, label: 'APFS' },
    'apfs-cs': { fstypename: 'apfs',  step: 1,   local: false, cs: true,  label: 'APFS (case-sensitive; demo: byte-exact names)' },
    hfs:       { fstypename: 'hfs',   step: 1e9, local: false, cs: false, nfd: true, label: 'Mac OS Extended (stores names as NFD)' },
    exfat:     { fstypename: 'exfat', step: 1e7, local: true,  cs: false, label: 'ExFAT (local time, 10 ms)' },
    msdos:     { fstypename: 'msdos', step: 2e9, local: true,  cs: false, label: 'MS-DOS FAT32 (local time, 2 s)' },
    smbfs:     { fstypename: 'smbfs', step: 1e9, local: false, cs: false, label: 'SMB share (1 s)' },
  };

  function splitPath(p) { return p.split('/').filter(c => c && c !== '.'); }
  // lexical normalisation; cwd used for relative paths
  function normPath(p, cwd = '/') {
    if (p == null || p === '') return cwd;
    const parts = p.startsWith('/') ? [] : splitPath(cwd);
    for (const c of splitPath(p)) { if (c === '..') parts.pop(); else parts.push(c); }
    return '/' + parts.join('/');
  }
  function dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
  function join(a, b) { return a === '/' ? '/' + b : a + '/' + b; }

  class Volume {
    constructor(k, { name, fs = 'apfs', removable = true }) {
      if (!FS_PROFILES[fs]) throw new OSError('EINVAL', `unknown filesystem type ${fs}`);
      this.k = k; this.id = ++k.volSeq; this.name = name; this.fs = fs; this.prof = FS_PROFILES[fs];
      this.removable = removable; this.mountedAt = null; this.inoSeq = 1;
      this.root = k._newNode(this, 'dir', '');
      this.root.ino = 2;
    }
    key(name) { return this.prof.cs ? name : U.lower(U.nfc(name)); }
    store(name) { return this.prof.nfd ? name.normalize('NFD') : name; }
    encodeTime(utc) {
      if (utc == null) return null;
      const t = this.prof.local ? utc + this.k.tzMin * 60e9 : utc;
      return Math.floor(t / this.prof.step) * this.prof.step;
    }
    decodeTime(raw) { return raw == null ? null : (this.prof.local ? raw - this.k.tzMin * 60e9 : raw); }
  }

  class Kernel {
    constructor(opts = {}) {
      this.hostname = opts.hostname || 'MacBook-Prokop';
      this.tzMin = opts.tzMin ?? 60;                         // Europe/Prague in November
      this.realtime = !!opts.realtime;
      this.t = opts.start ?? Date.parse('2026-11-11T13:02:11Z') * 1e6;
      this._lastReal = Date.now();
      this.io = { reads: 0, bytes: 0, media: 0 };
      this.volSeq = 0; this.volumes = []; this.locks = new Map(); this.procs = new Map(); this.pidSeq = 4100;
      this.faults = {};                                      // test hooks
      this.listeners = [];
      if (!opts.empty) this._boot();
    }
    _boot() {
      const v = new Volume(this, { name: 'Macintosh HD', fs: 'apfs', removable: false });
      v.mountedAt = '/'; this.rootVol = v; this.volumes.push(v);
      for (const d of ['/Users/prokop/Desktop', '/Users/prokop/Pictures', '/Users/prokop/.config/asscat', '/Volumes', '/tmp'])
        this.mkdir(d, { p: true });
    }
    // ---------- clock ----------
    now() {
      if (this.realtime) { const r = Date.now(); this.t += Math.max(0, r - this._lastReal) * 1e6; this._lastReal = r; }
      this.t += 1000; return this.t;
    }
    advance(ns) { this.t += ns; }
    nowS() { return Math.floor(this.now() / 1e9); }

    _newNode(vol, type, name) {
      const t = vol.encodeTime(this.t);
      return { ino: vol.inoSeq++ + 2, type, name, vol, parent: null, children: type === 'dir' ? new Map() : null,
               data: type === 'file' ? '' : null, mode: type === 'dir' ? 0o755 : 0o644,
               mtime: t, ctime: t, atime: t, btime: t, target: null, mount: null };
    }
    // ---------- path resolution ----------
    _enter(node) { return node.mount ? node.mount.root : node; }
    _lookup(path, noEnterLast = false) {
      let node = this.rootVol.root;
      const parts = splitPath(normPath(path));
      for (let i = 0; i < parts.length; i++) {
        if (node.type !== 'dir') throw new OSError('ENOTDIR', 'not a directory', path);
        const ch = node.children.get(node.vol.key(parts[i]));
        if (!ch) return null;
        node = noEnterLast && i === parts.length - 1 ? ch : this._enter(ch);
      }
      return node;
    }
    _need(path) { const n = this._lookup(path); if (!n) throw new OSError('ENOENT', 'no such file or directory', path); return n; }
    _parentOf(path) {
      path = normPath(path);
      if (path === '/') throw new OSError('EINVAL', 'invalid argument', path);
      const dir = this._need(dirname(path));
      if (dir.type !== 'dir') throw new OSError('ENOTDIR', 'not a directory', dirname(path));
      return { dir, name: basename(path) };
    }
    _touchDir(dir) { const t = dir.vol.encodeTime(this.now()); dir.mtime = t; dir.ctime = t; }
    _insert(dir, node) { node.parent = dir; dir.children.set(dir.vol.key(node.name), node); this._touchDir(dir); }
    _remove(node) { node.parent.children.delete(node.vol.key(node.name)); this._touchDir(node.parent); node.parent = null; }
    _changed() { for (const f of this.listeners) try { f(); } catch (e) { /* ignore */ } }

    // ---------- syscalls ----------
    exists(path) { try { return !!this._lookup(path); } catch { return false; } }
    stat(path) {
      const n = this._need(path), v = n.vol;
      return {
        type: n.type, ino: n.ino, mode: n.mode, size: n.type === 'file' ? U.utf8Len(n.data) : (n.type === 'dir' ? n.children.size : n.target.length),
        mtime_ns: v.decodeTime(n.mtime), atime_ns: v.decodeTime(n.atime), btime_ns: v.decodeTime(n.btime),
        ctime_ns: v.prof.local ? null : n.ctime, dev: v.id, volume: v.name, name: n.name, target: n.target,
      };
    }
    readdir(path) {
      const n = this._need(path);
      if (n.type !== 'dir') throw new OSError('ENOTDIR', 'not a directory', path);
      if (!(n.mode & 0o444)) throw new OSError('EACCES', 'permission denied', path);
      return [...n.children.values()].map(c => c.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    _readable(n, path) {
      if (n.type === 'dir') throw new OSError('EISDIR', 'is a directory', path);
      if (n.type !== 'file') throw new OSError('EINVAL', 'not a regular file', path);
      if (!(n.mode & 0o444)) throw new OSError('EACCES', 'permission denied', path);
      if (this.faults.readError && this.faults.readError(path)) throw new OSError('EIO', 'input/output error', path);
    }
    readFile(path) {
      const n = this._need(path); this._readable(n, path);
      n.atime = n.vol.encodeTime(this.now());
      this.io.reads++; this.io.bytes += U.utf8Len(n.data);
      if (!/\/\./.test(normPath(path))) this.io.media++;
      if (this.trace) this.trace('read', normPath(path));
      return n.data;
    }
    // read selected byte ranges (used by partial hashing); counts as one read
    readRanges(path, ranges) {
      const n = this._need(path); this._readable(n, path);
      const bytes = U.utf8(n.data); const out = [];
      for (const [off, len] of ranges) { out.push(bytes.slice(off, off + len)); this.io.bytes += Math.min(len, Math.max(0, bytes.length - off)); }
      this.io.reads++; n.atime = n.vol.encodeTime(this.now());
      if (!/\/\./.test(normPath(path))) this.io.media++;
      if (this.trace) this.trace('read', normPath(path));
      return out;
    }
    writeFile(path, data, opts = {}) {
      path = normPath(path);
      let n = this._lookup(path);
      const t = this.now();
      if (n) {
        if (n.type !== 'file') throw new OSError('EISDIR', 'is a directory', path);
        if (!(n.mode & 0o222)) throw new OSError('EACCES', 'permission denied', path);
        n.data = String(data);
      } else {
        const { dir, name } = this._parentOf(path);
        if (opts.exclusive === false) { /* fine */ }
        n = this._newNode(dir.vol, 'file', dir.vol.store(name)); n.data = String(data);
        n.btime = dir.vol.encodeTime(opts.btime ?? t);
        this._insert(dir, n);
      }
      n.mtime = n.vol.encodeTime(opts.mtime ?? t); n.ctime = n.vol.encodeTime(t); n.atime = n.vol.encodeTime(t);
      this._changed();
      return n;
    }
    mkdir(path, opts = {}) {
      path = normPath(path);
      if (opts.p) {
        let cur = '/';
        for (const c of splitPath(path)) {
          cur = join(cur, c);
          const n = this._lookup(cur);
          if (n) { if (n.type !== 'dir') throw new OSError('EEXIST', 'file exists', cur); continue; }
          this.mkdir(cur);
        }
        return;
      }
      const { dir, name } = this._parentOf(path);
      if (dir.children.has(dir.vol.key(name))) throw new OSError('EEXIST', 'file exists', path);
      this._insert(dir, this._newNode(dir.vol, 'dir', dir.vol.store(name)));
      this._changed();
    }
    symlink(target, path) {
      const { dir, name } = this._parentOf(path);
      if (dir.children.has(dir.vol.key(name))) throw new OSError('EEXIST', 'file exists', path);
      const n = this._newNode(dir.vol, 'link', dir.vol.store(name)); n.target = target;
      this._insert(dir, n); this._changed();
    }
    unlink(path) {
      const n = this._need(path);
      if (n.type === 'dir') throw new OSError('EISDIR', 'is a directory', path);
      this._remove(n); this._changed();
    }
    rmdir(path) {
      const n = this._need(path);
      if (n.type !== 'dir') throw new OSError('ENOTDIR', 'not a directory', path);
      if (n.vol.root === n || n.mount) throw new OSError('EBUSY', 'resource busy', path);
      if (n.children.size) throw new OSError('ENOTEMPTY', 'directory not empty', path);
      this._remove(n); this._changed();
    }
    rmTree(path) {
      const n = this._need(path);
      if (n.type === 'dir') {
        if (n.mount || n.vol.root === n) throw new OSError('EBUSY', 'resource busy (mount point)', path);
        for (const c of [...n.children.values()]) this.rmTree(join(normPath(path), c.name));
        this.rmdir(path);
      } else this.unlink(path);
    }
    // POSIX rename; noReplace = RENAME_EXCL (the app's rename_new never overwrites)
    rename(from, to, opts = {}) {
      from = normPath(from); to = normPath(to);
      const src = this._need(from);
      if (src.vol.root === src || src.mount) throw new OSError('EBUSY', 'resource busy', from);
      const { dir, name } = this._parentOf(to);
      if (dir.vol !== src.vol) throw new OSError('EXDEV', 'cross-device link', to);
      for (let p = dir; p; p = p.parent) if (p === src) throw new OSError('EINVAL', 'cannot move a directory into itself', to);
      const existing = dir.children.get(dir.vol.key(name));
      if (existing === src) {                            // only the spelling changes (case / NFC-NFD)
        this._remove(src); src.name = dir.vol.store(name); this._insert(dir, src);
        src.ctime = src.vol.encodeTime(this.now()); this._changed(); return;
      }
      if (existing) {
        if (opts.noReplace) throw new OSError('EEXIST', 'file exists', to);
        if (existing.type === 'dir') {
          if (src.type !== 'dir') throw new OSError('EISDIR', 'is a directory', to);
          if (existing.children.size) throw new OSError('ENOTEMPTY', 'directory not empty', to);
        } else if (src.type === 'dir') throw new OSError('ENOTDIR', 'not a directory', to);
        this._remove(existing);
      }
      this._remove(src); src.name = dir.vol.store(name); this._insert(dir, src);
      src.ctime = src.vol.encodeTime(this.now());
      this._changed();
    }
    utimes(path, mtime_ns) { const n = this._need(path); n.mtime = n.vol.encodeTime(mtime_ns); n.ctime = n.vol.encodeTime(this.now()); this._changed(); }
    chmod(path, mode) { const n = this._need(path); n.mode = mode; n.ctime = n.vol.encodeTime(this.now()); this._changed(); }
    statfs(path) {
      const n = this._need(path); const v = n.vol;
      return { f_fstypename: v.prof.fstypename, f_mntonname: v.mountedAt, volume: v.name, fs: v.fs, label: v.prof.label, removable: v.removable };
    }
    // copy file (Finder-like: preserves mtime when preserve=true); works across volumes
    copyFile(from, to, opts = {}) {
      const st = this.stat(from);
      const data = this.readFile(from);
      if (opts.noReplace && this.exists(to)) throw new OSError('EEXIST', 'file exists', to);
      this.writeFile(to, data, { mtime: opts.preserve ? st.mtime_ns : undefined, btime: opts.preserve ? st.btime_ns : undefined });
    }

    // ---------- disks ----------
    disks() { return this.volumes.map(v => ({ name: v.name, fs: v.fs, label: v.prof.label, mountedAt: v.mountedAt, removable: v.removable })); }
    createDisk({ name, fs = 'exfat' }) {
      if (!name || name.includes('/')) throw new OSError('EINVAL', 'bad disk name');
      const v = new Volume(this, { name, fs, removable: true });
      this.volumes.push(v); this.mountDisk(v.name); return v;
    }
    _vol(name) {
      const v = this.volumes.find(x => x.name === name) || this.volumes.find(x => x.mountedAt === normPath(name));
      if (!v) throw new OSError('ENOENT', 'no such disk', name);
      return v;
    }
    mountDisk(name) {
      const v = this._vol(name);
      if (v.mountedAt) throw new OSError('EBUSY', 'already mounted', v.mountedAt);
      let mp = '/Volumes/' + v.name, i = 1;
      while (this.exists(mp)) mp = `/Volumes/${v.name} ${i++}`;
      this.mkdir(mp);
      const node = this._lookup(mp); node.mount = v; v.mountedAt = mp; v.root.parent = node.parent;
      this._changed(); return mp;
    }
    ejectDisk(name) {
      const v = this._vol(name);
      if (!v.removable) throw new OSError('EBUSY', 'cannot eject the startup disk');
      if (!v.mountedAt) throw new OSError('EINVAL', 'not mounted', name);
      for (const [key, pid] of this.locks) if (key.startsWith(v.id + ':') && this.procs.has(pid))
        throw new OSError('EBUSY', `disk is in use by pid ${pid}`, v.mountedAt);
      const node = this._lookup(v.mountedAt, true); node.mount = null;
      this.rmdir(v.mountedAt); v.mountedAt = null; v.root.parent = null;
      this._changed();
    }
    destroyDisk(name) { const v = this._vol(name); if (v.mountedAt) this.ejectDisk(name); this.volumes = this.volumes.filter(x => x !== v); this._changed(); }

    // ---------- processes & advisory locks (flock) ----------
    spawn(name, opts = {}) { const pid = ++this.pidSeq; this.procs.set(pid, { pid, name, host: opts.host || this.hostname, started: this.t }); return pid; }
    exit(pid) { this.procs.delete(pid); for (const [k, p] of [...this.locks]) if (p === pid) this.locks.delete(k); this._changed(); }
    flock(path, pid) {
      const n = this._need(path); const key = n.vol.id + ':' + n.ino;
      const holder = this.locks.get(key);
      if (holder != null && holder !== pid && this.procs.has(holder)) return false;
      this.locks.set(key, pid); return true;
    }

    // ---------- persistence ----------
    toJSON() {
      const ser = n => {
        const o = { n: n.name, t: n.type, i: n.ino, m: n.mode, mt: n.mtime, ct: n.ctime, at: n.atime, bt: n.btime };
        if (n.type === 'file') o.d = n.data;
        if (n.type === 'link') o.tg = n.target;
        if (n.type === 'dir') o.c = [...n.children.values()].map(ser);
        return o;
      };
      return { v: 1, t: this.t, tzMin: this.tzMin, hostname: this.hostname, volSeq: this.volSeq, pidSeq: this.pidSeq,
               volumes: this.volumes.map(v => ({ id: v.id, name: v.name, fs: v.fs, removable: v.removable, mountedAt: v.mountedAt, inoSeq: v.inoSeq, root: ser(v.root) })) };
    }
    static fromJSON(j, opts = {}) {
      const k = new Kernel({ ...opts, empty: true, start: j.t, tzMin: j.tzMin, hostname: j.hostname });
      k.volSeq = j.volSeq; k.pidSeq = j.pidSeq;
      const de = (vol, o, parent) => {
        const n = { ino: o.i, type: o.t, name: o.n, vol, parent, children: o.t === 'dir' ? new Map() : null, data: o.d ?? null,
                    mode: o.m, mtime: o.mt, ctime: o.ct, atime: o.at, btime: o.bt, target: o.tg ?? null, mount: null };
        if (o.c) for (const c of o.c) n.children.set(vol.key(c.n), de(vol, c, n));
        return n;
      };
      for (const vj of j.volumes) {
        const v = Object.create(Volume.prototype);
        Object.assign(v, { k, id: vj.id, name: vj.name, fs: vj.fs, prof: FS_PROFILES[vj.fs], removable: vj.removable, mountedAt: null, inoSeq: vj.inoSeq });
        v.root = de(v, vj.root, null); v._mp = vj.mountedAt;
        k.volumes.push(v); if (vj.mountedAt === '/') { k.rootVol = v; v.mountedAt = '/'; }
      }
      for (const v of k.volumes) if (v._mp && v._mp !== '/') {
        const node = k._lookup(v._mp);
        if (node) { node.mount = v; v.mountedAt = v._mp; v.root.parent = node.parent; }
        delete v._mp;
      }
      return k;
    }
  }

  G.OS = { Kernel, OSError, FS_PROFILES, normPath, dirname, basename, join, splitPath };
})(typeof window !== 'undefined' ? window : globalThis);
