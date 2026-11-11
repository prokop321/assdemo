// A small unix-like shell over the mock kernel. Attaches to globalThis.Shell.
(function (G) {
  'use strict';
  const { U, OS, Asscat, Gen } = G;
  const { normPath, dirname, basename, join } = OS;
  const HOME = '/Users/prokop';

  class ShellError extends Error {}

  // tokenizer: quotes, backslash escapes, operators ; && > >>
  function tokenize(line) {
    const out = []; let cur = null, i = 0, quoted = false, tilde = false;
    const push = () => { if (cur !== null) out.push({ w: cur, q: quoted, tilde }); cur = null; quoted = false; tilde = false; };
    while (i < line.length) {
      const c = line[i];
      if (c === '#' && cur === null) break;
      if (/\s/.test(c)) { push(); i++; continue; }
      if (c === ';') { push(); out.push({ op: ';' }); i++; continue; }
      if (c === '&' && line[i + 1] === '&') { push(); out.push({ op: '&&' }); i += 2; continue; }
      if (c === '>') { push(); if (line[i + 1] === '>') { out.push({ op: '>>' }); i += 2; } else { out.push({ op: '>' }); i++; } continue; }
      if (c === '"' || c === "'") {
        const q = c; i++; cur = cur ?? ''; quoted = true;
        while (i < line.length && line[i] !== q) {
          if (q === '"' && line[i] === '\\' && i + 1 < line.length) { const n = line[i + 1]; cur += n === 'n' ? '\n' : n === 'r' ? '\r' : n; i += 2; continue; }
          cur += line[i++];
        }
        if (i >= line.length) throw new ShellError('unterminated quote');
        i++; continue;
      }
      if (c === '\\' && i + 1 < line.length) { cur = (cur ?? '') + line[i + 1]; i += 2; continue; }
      if (c === '~' && cur === null) tilde = true;        // unquoted leading ~ expands to $HOME
      cur = (cur ?? '') + c; i++;
    }
    push();
    return out;
  }

  const HELP = `Mock macOS-ish shell. Paths: absolute, relative, ~. Operators: ; && > >>
files     ls [-la] [path]   cd   pwd   tree [path]   cat   stat   find [path] [-name pat]
          mkdir [-p]   touch [-d "YYYY-MM-DD HH:MM"]   echo … [> file]   write <file> <text…>
          rm [-r]   rmdir   mv (across disks = copy+delete, keeps dates)   cp [-r] [-p]   ln -s   chmod 000|644
mock data genphotos <dir> <n> [--start "2026-08-07 10:00"] [--every 2m] [--prefix IMG_] [--ext JPG] [--first 1] [--kb 2]
          mkfile <path> [--kb N] [--mtime "date"]
disks     disk                               list disks
          disk create <name> [--fs exfat|msdos|apfs|apfs-cs|hfs|smbfs] [--card]   plug in a new disk
          disk eject <name>   disk mount <name>   disk destroy <name>
time      date   clock +2h | -1d | set "2026-11-12 09:00"   tz <minutes east of UTC, e.g. 120>
system    hostname [name]   ps   kill <pid>|%lock   io [reset]   (file read counter)
          jsonset <file> <a.0.b> <value>   edit a JSON file in place
          holdlock <folder> [--host NAME]    a separate process keeps the library locked
app       asscat-cli … (alias asscat)      asscat help
demo      demo   demo <name>   (then press Enter to step through)   selftest [n]
ui        clear   reset   (state is saved in this browser's localStorage)`;

  class Shell {
    constructor(k, io = {}) {
      this.k = k; this.cwd = HOME; this.out = io.out || (() => {}); this.err = io.err || (() => {});
      this.queue = []; this.lastExit = 0;
    }
    path(p) { if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1); return normPath(p, this.cwd); }
    prompt() { const c = this.cwd === HOME ? '~' : this.cwd.startsWith(HOME + '/') ? '~' + this.cwd.slice(HOME.length) : this.cwd; return `prokop@${this.k.hostname} ${c} %`; }

    exec(line) {
      let toks;
      try { toks = tokenize(line); } catch (e) { this.err('sh: ' + e.message); return 2; }
      // split into commands
      const cmds = []; let cur = { argv: [], redir: null, sep: ';' };
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.op === ';' || t.op === '&&') { cmds.push(cur); cur = { argv: [], redir: null, sep: t.op }; continue; }
        if (t.op === '>' || t.op === '>>') { const f = toks[++i]; if (!f || f.op) { this.err('sh: missing file after ' + t.op); return 2; } cur.redir = { mode: t.op, file: f.w }; continue; }
        cur.argv.push(t.tilde && (t.w === '~' || t.w.startsWith('~/')) ? HOME + t.w.slice(1) : t.w);
      }
      cmds.push(cur);
      let code = 0;
      for (const c of cmds) {
        if (c.sep === '&&' && code !== 0) break;
        if (!c.argv.length) continue;
        code = this.run1(c);
      }
      this.lastExit = code;
      return code;
    }
    run1({ argv, redir }) {
      const buf = [];
      const out = redir ? s => buf.push(s) : this.out;
      let code;
      try { code = this.cmd(argv, out); }
      catch (e) {
        if (e instanceof OS.OSError) { this.err(`${argv[0]}: ${e.message}`); code = 1; }
        else if (e instanceof ShellError) { this.err(`${argv[0]}: ${e.message}`); code = e.code || 1; }
        else { this.err(`${argv[0]}: internal error: ${e.message}`); code = 1; }
      }
      if (redir) {
        try {
          const p = this.path(redir.file); const text = buf.join('\n') + (buf.length ? '\n' : '');
          const prev = redir.mode === '>>' && this.k.exists(p) ? this.k.readFile(p) : '';
          this.k.writeFile(p, prev + text);
        } catch (e) { this.err(`sh: ${e.message}`); return 1; }
      }
      return code ?? 0;
    }
    flags(args, known) {
      const f = {}, rest = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--') && known.opts && known.opts.includes(a.slice(2))) { f[a.slice(2)] = args[++i]; continue; }
        if (/^-[a-zA-Z]+$/.test(a) && known.short) { for (const ch of a.slice(1)) { if (!known.short.includes(ch)) throw new ShellError(`unknown option -${ch}`); f[ch] = true; } continue; }
        if (a.startsWith('--') && known.bool && known.bool.includes(a.slice(2))) { f[a.slice(2)] = true; continue; }
        rest.push(a);
      }
      return [f, rest];
    }
    time(str) {
      const t = U.parseLocal(str, this.k.tzMin);
      if (t == null) throw new ShellError(`bad date "${str}" (use "YYYY-MM-DD HH:MM[:SS]")`);
      return t;
    }
    lsLine(p, name) {
      const st = this.k.stat(p);
      const t = st.type === 'dir' ? 'd' : st.type === 'link' ? 'l' : '-';
      const m = st.mode;
      const perm = [6, 3, 0].map(s => ((m >> s) & 4 ? 'r' : '-') + ((m >> s) & 2 ? 'w' : '-') + ((m >> s) & 1 ? 'x' : '-')).join('');
      const size = st.type === 'file' ? String(st.size) : '-';
      return `${t}${perm}  ${size.padStart(7)}  ${U.fmtLocal(st.mtime_ns, this.k.tzMin)}  ${name}${st.type === 'dir' ? '/' : ''}${st.type === 'link' ? ' -> ' + st.target : ''}`;
    }
    copyTree(from, to, preserve) {
      const st = this.k.stat(from);
      if (st.type === 'dir') {
        this.k.mkdir(to, { p: true });
        for (const n of this.k.readdir(from)) this.copyTree(join(from, n), join(to, n), preserve);
        if (preserve) this.k.utimes(to, st.mtime_ns);
      } else if (st.type === 'link') this.k.symlink(st.target, to);
      else this.k.copyFile(from, to, { preserve });
    }
    move(from, to) {
      try { this.k.rename(from, to); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        this.copyTree(from, to, true); this.k.rmTree(from);
      }
    }
    target(src, dst) {           // mv/cp into an existing directory
      return this.k.exists(dst) && this.k.stat(dst).type === 'dir' && !(this.k._lookup(dst) === this.k._lookup(src)) ? join(dst, basename(src)) : dst;
    }

    cmd(argv, out) {
      const [c, ...a] = argv; const k = this.k;
      switch (c) {
        case 'help': out(HELP); return 0;
        case 'pwd': out(this.cwd); return 0;
        case 'cd': {
          const p = this.path(a[0] || '~');
          if (!k.exists(p)) throw new ShellError(`no such directory: ${a[0]}`);
          if (k.stat(p).type !== 'dir') throw new ShellError(`not a directory: ${a[0]}`);
          this.cwd = p; return 0;
        }
        case 'ls': {
          const [f, r] = this.flags(a, { short: 'la1' });
          const targets = r.length ? r : ['.'];
          for (const t of targets) {
            const p = this.path(t);
            if (targets.length > 1) out(t + ':');
            if (k.stat(p).type !== 'dir') { out(f.l ? this.lsLine(p, t) : t); continue; }
            const names = k.readdir(p).filter(n => f.a || !n.startsWith('.'));
            if (f.l) names.forEach(n => out(this.lsLine(join(p, n), n)));
            else out(names.map(n => { const st = k.stat(join(p, n)); return n + (st.type === 'dir' ? '/' : ''); }).join('  '));
          }
          return 0;
        }
        case 'tree': {
          const [f, r] = this.flags(a, { short: 'a' });
          const root = this.path(r[0] || '.');
          const lines = [r[0] || '.'];
          const walk = (p, pre) => {
            const names = k.readdir(p).filter(n => f.a || !n.startsWith('.'));
            names.forEach((n, i) => {
              const last = i === names.length - 1, q = join(p, n), st = k.stat(q);
              lines.push(`${pre}${last ? '└── ' : '├── '}${n}${st.type === 'dir' ? '/' : ''}`);
              if (st.type === 'dir') walk(q, pre + (last ? '    ' : '│   '));
            });
          };
          walk(root, ''); out(lines.join('\n')); return 0;
        }
        case 'find': {
          const i = a.indexOf('-name'); const pat = i >= 0 ? a[i + 1] : null;
          const rest = a.filter((_, j) => j !== i && j !== i + 1 || i < 0);
          const root = this.path(rest[0] || '.');
          const re = pat ? new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
          const res = [];
          const walk = p => { for (const n of k.readdir(p)) { const q = join(p, n); if (!re || re.test(n)) res.push(q); if (k.stat(q).type === 'dir') walk(q); } };
          walk(root); out(res.join('\n')); return 0;
        }
        case 'cat': for (const p of a) out(k.readFile(this.path(p)).replace(/\n$/, '')); return 0;
        case 'stat': for (const p of a) { const st = k.stat(this.path(p)); const fs = k.statfs(this.path(p)); out(JSON.stringify({ ...st, mtime: U.fmtLocal(st.mtime_ns, k.tzMin), fs: fs.f_fstypename }, null, 2)); } return 0;
        case 'echo': out(a.join(' ')); return 0;
        case 'write': { if (a.length < 1) throw new ShellError('write <file> <text…>   (creates parent folders)'); k.mkdir(dirname(this.path(a[0])), { p: true }); k.writeFile(this.path(a[0]), a.slice(1).join(' ')); return 0; }
        case 'mkdir': { const [f, r] = this.flags(a, { short: 'p' }); for (const p of r) k.mkdir(this.path(p), { p: !!f.p }); return 0; }
        case 'touch': {
          const [f, r] = this.flags(a, { opts: ['d'], short: '' });
          let d = null; const files = [];
          for (let i = 0; i < r.length; i++) { if (r[i] === '-d') { d = r[++i]; continue; } files.push(r[i]); }
          for (const p0 of files) {
            const p = this.path(p0);
            if (!k.exists(p)) k.writeFile(p, '');
            k.utimes(p, d ? this.time(d) : k.now());
          }
          void f; return 0;
        }
        case 'rm': {
          const [f, r] = this.flags(a, { short: 'rf' });
          for (const p0 of r) {
            const p = this.path(p0);
            if (!k.exists(p)) { if (f.f) continue; throw new OS.OSError('ENOENT', 'no such file or directory', p0); }
            if (k.stat(p).type === 'dir') { if (!f.r) throw new ShellError(`${p0}: is a directory (use -r)`); k.rmTree(p); } else k.unlink(p);
          }
          return 0;
        }
        case 'rmdir': for (const p of a) k.rmdir(this.path(p)); return 0;
        case 'mv': {
          if (a.length < 2) throw new ShellError('mv <src…> <dst>');
          const dst = this.path(a[a.length - 1]);
          for (const s of a.slice(0, -1)) { const src = this.path(s); this.move(src, this.target(src, dst)); }
          return 0;
        }
        case 'cp': {
          const [f, r] = this.flags(a, { short: 'rRpa' });
          if (r.length < 2) throw new ShellError('cp [-r] [-p] <src…> <dst>');
          const dst = this.path(r[r.length - 1]);
          for (const s of r.slice(0, -1)) {
            const src = this.path(s);
            if (k.stat(src).type === 'dir' && !(f.r || f.R || f.a)) throw new ShellError(`${s} is a directory (not copied)`);
            this.copyTree(src, this.target(src, dst), !!(f.p || f.a));
          }
          return 0;
        }
        case 'ln': { if (a[0] !== '-s' || a.length < 3) throw new ShellError('ln -s <target> <link>'); k.symlink(a[1], this.path(a[2])); return 0; }
        case 'chmod': { if (a.length < 2) throw new ShellError('chmod <octal> <path…>'); for (const p of a.slice(1)) k.chmod(this.path(p), parseInt(a[0], 8)); return 0; }
        case 'mkfile': {
          const [f, r] = this.flags(a, { opts: ['kb', 'mtime'] });
          for (const p0 of r) {
            const p = this.path(p0); k.mkdir(dirname(p), { p: true });
            k.writeFile(p, Gen.body(U.ext(p0) || 'bin', p + ':' + k.t, Number(f.kb || 1)), f.mtime ? { mtime: this.time(f.mtime) } : {});
          }
          return 0;
        }
        case 'genphotos': {
          const [f, r] = this.flags(a, { opts: ['start', 'every', 'prefix', 'ext', 'first', 'kb', 'seed'] });
          if (r.length < 2) throw new ShellError('genphotos <dir> <n> [--start "YYYY-MM-DD HH:MM"] [--every 2m] [--prefix IMG_] [--ext JPG]');
          const list = Gen.photos(k, this.path(r[0]), Number(r[1]), {
            start: f.start ? this.time(f.start) : undefined, every: f.every ? U.parseDuration(f.every) : undefined,
            prefix: f.prefix, ext: f.ext, first: f.first ? Number(f.first) : undefined, kb: f.kb ? Number(f.kb) : undefined, seed: f.seed });
          out(`created ${list.length} file(s) in ${r[0]}`); return 0;
        }
        case 'date': out(`${U.fmtLocal(k.now(), k.tzMin)} (UTC${U.tzString(k.tzMin)})`); return 0;
        case 'clock': {
          if (a[0] === 'set') { k.t = this.time(a.slice(1).join(' ')); }
          else if (a[0]) { const d = U.parseDuration(a[0]); if (d == null) throw new ShellError('clock +2h | -1d | set "YYYY-MM-DD HH:MM"'); k.advance(d); }
          out(U.fmtLocal(k.now(), k.tzMin)); return 0;
        }
        case 'tz': {
          if (a[0] != null) { const m = Number(a[0]); if (!Number.isFinite(m)) throw new ShellError('tz <minutes east of UTC>, e.g. tz 120'); k.tzMin = m; }
          out(`UTC${U.tzString(k.tzMin)}  (FAT/exFAT disks store local time, so their mtimes shift when this changes)`); return 0;
        }
        case 'hostname': if (a[0]) k.hostname = a[0]; out(k.hostname); return 0;
        case 'io': if (a[0] === 'reset') { k.io.reads = 0; k.io.bytes = 0; k.io.media = 0; } out(`file reads: ${k.io.media} outside hidden folders (${k.io.reads} total incl. .asscat / config), ${k.io.bytes} bytes`); return 0;
        case 'ps': out('  PID  HOST              COMMAND'); for (const p of k.procs.values()) out(`${String(p.pid).padStart(5)}  ${p.host.padEnd(16)}  ${p.name}`); return 0;
        case 'kill': {
          if (a[0] === '%lock') { const ps = [...k.procs.values()].filter(p => p.name.includes('holding lock')); ps.forEach(p => k.exit(p.pid)); out(`killed ${ps.map(p => p.pid).join(', ') || 'nothing'}`); return 0; }
          const pid = Number(a[0]); if (!k.procs.has(pid)) throw new ShellError(`no such process ${a[0]}`); k.exit(pid); out(`killed ${pid}`); return 0; }
        case 'holdlock': {
          const [f, r] = this.flags(a, { opts: ['host'] });
          if (!r[0]) throw new ShellError('holdlock <library folder> [--host NAME]');
          const app = new Asscat.App(k, { cwd: this.cwd, err: () => {} });
          app.pid = k.spawn('asscat-cli (holding lock)', { host: f.host });
          try { new Asscat.Library(app, this.path(r[0])).open(); }
          catch (e) { k.exit(app.pid); throw new ShellError(e.message); }
          out(`pid ${app.pid} now holds the library lock (stop it with: kill ${app.pid})`); return 0;
        }
        case 'disk': case 'df': case 'mount': return this.diskCmd(c === 'disk' ? a : [], out);
        case 'asscat': case 'asscat-cli': {
          const app = new Asscat.App(k, { cwd: this.cwd, out, err: this.err });
          return app.run(a);
        }
        case 'selftest': { const r = G.Selftest.run(s => out(s), a[0]); return r.fail ? 1 : 0; }
        case 'demo': return this.demoCmd(a, out);
        case 'jsonset': {
          if (a.length < 3) throw new ShellError('jsonset <file> <a.0.b> <value>   (value parsed as JSON, else string)');
          const p = this.path(a[0]); const j = JSON.parse(k.readFile(p));
          const keys = a[1].split('.'); let o = j;
          for (const key of keys.slice(0, -1)) { if (o[key] == null) throw new ShellError(`no ${key} in ${a[1]}`); o = o[key]; }
          let v; try { v = JSON.parse(a[2]); } catch { v = a[2]; }
          o[keys[keys.length - 1]] = v; k.writeFile(p, JSON.stringify(j, null, 2)); return 0;
        }
        default: throw new ShellError(`command not found (try "help")`);
      }
    }
    diskCmd(a, out) {
      const k = this.k; const [sub, ...r] = a;
      if (!sub || sub === 'list') {
        out('NAME              FS        MOUNTED AT');
        for (const d of k.disks()) out(`${d.name.padEnd(16)}  ${d.fs.padEnd(8)}  ${d.mountedAt || '(ejected)'}    ${d.label}`);
        return 0;
      }
      const [f, rest] = this.flags(r, { opts: ['fs'], bool: ['card'] });
      const name = rest[0]; if (!name) throw new ShellError(`disk ${sub} <name>`);
      switch (sub) {
        case 'create': {
          const v = k.createDisk({ name, fs: f.fs || 'exfat' });
          if (f.card) Gen.card(k, v.mountedAt);
          out(`attached "${name}" (${v.prof.label}) at ${v.mountedAt}${f.card ? ' with camera files in DCIM/' : ''}`); return 0;
        }
        case 'eject': k.ejectDisk(name); out(`ejected ${name}`); return 0;
        case 'mount': out(`mounted at ${k.mountDisk(name)}`); return 0;
        case 'destroy': k.destroyDisk(name); out(`destroyed ${name}`); return 0;
        default: throw new ShellError('disk [list|create|eject|mount|destroy]');
      }
    }
    demoCmd(a, out) {
      const D = G.Demos;
      if (!a[0]) { out('demos (run "demo <name>", then press Enter on an empty line to step):'); for (const [n, d] of Object.entries(D)) out(`  ${n.padEnd(10)} ${d.title}`); return 0; }
      if (a[0] === 'stop') { this.queue = []; out('demo stopped'); return 0; }
      const d = D[a[0]]; if (!d) throw new ShellError(`no demo ${a[0]}`);
      this.queue = d.steps.slice(); out(`# ${d.title} — ${this.queue.filter(x => !x.startsWith('#')).length} commands. Press Enter on an empty line to run the next one ("demo stop" to quit).`);
      return 0;
    }
  }

  G.Shell = { Shell, tokenize, HOME };
})(typeof window !== 'undefined' ? window : globalThis);
