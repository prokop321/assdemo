// Command builder: pick a command, fill its parameters, get the exact command line the shell runs.
// compose() is pure (tested in node); mount() is the browser part. Attaches to globalThis.Builder.
(function (G) {
  'use strict';

  // ---------- dynamic suggestion sources ----------
  function libDb(ctx) {
    try {
      const k = ctx.k(), cfg = JSON.parse(k.readFile('/Users/prokop/.config/asscat/config.json'));
      return cfg.library ? G.Asscat.Db.parse(k.readFile(cfg.library + '/.asscat/library.db')) : null;
    } catch { return null; }
  }
  const S = {
    disks: ctx => ctx.k().disks().filter(d => d.removable).map(d => d.name),
    mounted: ctx => ctx.k().disks().filter(d => d.removable && d.mountedAt).map(d => d.name),
    unmounted: ctx => ctx.k().disks().filter(d => !d.mountedAt).map(d => d.name),
    tagKeys: ctx => { const db = libDb(ctx); return db ? [...new Set(db.tags.map(t => t.key))].sort() : []; },
    tagValues: keyField => (ctx, v) => { const db = libDb(ctx); const kk = G.Asscat.norm_key(v[keyField] || ''); return db ? [...new Set(db.tags.filter(t => !kk || t.key === kk).map(t => t.value))].sort() : []; },
    views: ctx => { const db = libDb(ctx); return db ? [...db.views.keys()].sort() : []; },
    settings: () => Object.keys(G.Asscat.DEFAULT_SETTINGS),
    settingValues: (ctx, v) => ({
      'edge.same_path': ['"auto"', '"ask"', '"manual"'], 'import.after': ['"manual"', '"auto"'],
      'scan.ignore': ['["Thumbs.db", "desktop.ini", "Icon\\r"]'], 'materialize.locked': ['[]', '["Projekty"]'],
    }[v.key] || []),
    templates: () => ['{klient}/{rok}/{shoot}', '{klient}/{rok}', 'Archiv/{rok}/{mesic}', '{druh}/{rok}', '{shoot}'],
    durations: () => ['30m', '1h', '2h', '1d', '-1h', '+7d'],
    demos: () => Object.keys(G.Demos || {}),
    procs: ctx => [...ctx.k().procs.keys()].map(String).concat(['%lock']),
  };

  // ---------- command catalogue ----------
  // field types: text | path | num | select | flag | opt (named value) | multi (comma list -> repeated option)
  //              selector (paths / --search / --view+--folder) | redirect (> file)
  const sel = { n: 'sel', l: 'files', t: 'selector', req: true };
  const yes = (l = 'apply (--yes)') => ({ n: 'yes', l, t: 'flag', f: '--yes' });
  const C = [
    ['asscat: library', [
      { c: 'asscat library', d: 'show the configured library' },
      { c: 'asscat library open', d: 'choose and open a library folder', a: [{ n: 'dir', l: 'folder', t: 'path', req: true, def: '.' }, { n: 'so', l: '--start-over', t: 'flag', f: '--start-over' }] },
      { c: 'asscat library forget', a: [{ n: 'dir', l: 'folder', t: 'path', req: true }] },
      { c: 'asscat sync', d: 'scan the library', a: [{ n: 'm', l: 'mode', t: 'select', opts: ['fast', 'full'] }] },
      { c: 'asscat files', d: 'what the library knows about files', a: [sel] },
      { c: 'asscat search', a: [{ n: 'q', l: 'words', t: 'text', req: true, ph: 'makarska plaz' }] },
      { c: 'asscat db', d: 'dump a table', a: [{ n: 't', l: 'table', t: 'select', opts: ['', 'library', 'files', 'paths', 'path_history', 'tags', 'edges', 'keywords', 'settings', 'views', 'ops', 'op_steps'] }] },
    ]],
    ['asscat: card', [
      { c: 'asscat volumes' },
      { c: 'asscat check', a: [{ n: 'v', l: 'volume', t: 'text', req: true, src: S.mounted }] },
      { c: 'asscat import', a: [{ n: 'v', l: 'volume', t: 'text', req: true, src: S.mounted }] },
      { c: 'asscat filter' },
      { c: 'asscat filter set', a: [{ n: 'j', l: 'json', t: 'text', req: true, def: '{"include_ext":["jpg","jpeg","cr3","arw","mp4","mov"]}' }] },
      { c: 'asscat shoots', d: 'propose shoots for _inbox', a: [{ n: 'r', l: 'gap', t: 'text', def: '2h', src: S.durations }, { n: 'm', l: 'min files', t: 'num', def: '3' }, { n: 'o', l: 'save to', t: 'redirect', def: '/tmp/proposal.json' }] },
      { c: 'asscat shoots apply', a: [{ n: 'f', l: 'proposal', t: 'path', req: true, def: '/tmp/proposal.json' }, yes()] },
      { c: 'jsonset', d: 'fill a value in the proposal', a: [{ n: 'f', l: 'file', t: 'path', req: true, def: '/tmp/proposal.json' }, { n: 'p', l: 'field', t: 'text', req: true, def: 'shoots.0.name', src: () => ['shoots.0.name', 'shoots.0.klient', 'shoots.1.name', 'shoots.1.klient'] }, { n: 'v', l: 'value', t: 'text', req: true }] },
    ]],
    ['asscat: tags & edges', [
      { c: 'asscat tag add', a: [{ n: 'key', l: 'key', t: 'text', req: true, src: S.tagKeys, ph: 'klient' }, { n: 'val', l: 'value', t: 'text', req: true, src: S.tagValues('key') }, sel, yes()] },
      { c: 'asscat tag remove', a: [{ n: 'key', l: 'key', t: 'text', req: true, src: S.tagKeys }, { n: 'val', l: 'value', t: 'text', req: true, src: S.tagValues('key') }, sel, yes()] },
      { c: 'asscat tag rename-value', a: [{ n: 'key', l: 'key', t: 'text', req: true, src: S.tagKeys }, { n: 'old', l: 'old', t: 'text', req: true, src: S.tagValues('key') }, { n: 'new', l: 'new', t: 'text', req: true }, yes()] },
      { c: 'asscat tag rename-key', a: [{ n: 'old', l: 'old key', t: 'text', req: true, src: S.tagKeys }, { n: 'new', l: 'new key', t: 'text', req: true }, yes()] },
      { c: 'asscat tag values', a: [{ n: 'key', l: 'key', t: 'text', req: true, src: S.tagKeys }] },
      { c: 'asscat edge', d: 'manual edge original -> edit', a: [{ n: 'op', l: '', t: 'select', opts: ['add', 'confirm', 'reject'] }, { n: 'o', l: 'original', t: 'path', req: true }, { n: 'e', l: 'edit', t: 'path', req: true }] },
      { c: 'asscat edge list', a: [{ n: 'p', l: 'file', t: 'path', req: true }] },
      { c: 'asscat setting get', a: [{ n: 'key', l: 'key', t: 'select', opts: S.settings }] },
      { c: 'asscat setting set', a: [{ n: 'key', l: 'key', t: 'select', opts: S.settings }, { n: 'v', l: 'value (JSON)', t: 'text', req: true, src: S.settingValues }] },
    ]],
    ['asscat: views', [
      { c: 'asscat view set', a: [{ n: 'name', l: 'name', t: 'text', req: true, src: S.views }, { n: 'tpl', l: 'template', t: 'text', req: true, src: S.templates }, { n: 'f', l: 'filter k=v, …', t: 'multi', f: '--filter', ph: 'druh=foto' }, { n: 'none', l: 'none names k=name, …', t: 'multi', f: '--none', ph: 'klient=bez klienta' }] },
      { c: 'asscat view list' },
      { c: 'asscat view show', a: [{ n: 'name', l: 'view', t: 'text', req: true, src: S.views }, { n: 'f', l: 'virtual folder', t: 'text', ph: 'Qila/2026' }] },
      { c: 'asscat view activate', a: [{ n: 'name', l: 'view', t: 'text', req: true, src: S.views }] },
      { c: 'asscat view delete', a: [{ n: 'name', l: 'view', t: 'text', req: true, src: S.views }] },
      { c: 'asscat materialize', d: 'without apply = preview only', a: [{ n: 'name', l: 'view', t: 'text', req: true, src: S.views }, { n: 'rc', l: '--rename-conflicts', t: 'flag', f: '--rename-conflicts' }, { n: 'ap', l: '--apply', t: 'flag', f: '--apply' }, { n: 'cr', l: 'crash after N renames', t: 'opt', f: '--crash-after', pre: true, ph: '' }] },
      { c: 'asscat materialize undo', a: [{ n: 'ap', l: '--apply', t: 'flag', f: '--apply' }] },
    ]],
    ['files', [
      { c: 'ls', a: [{ n: 'l', l: '-l', t: 'flag', f: '-l', def: true }, { n: 'a', l: '-a', t: 'flag', f: '-a' }, { n: 'p', l: 'path', t: 'path' }] },
      { c: 'cd', a: [{ n: 'p', l: 'folder', t: 'path', def: '~/Pictures/Knihovna' }] },
      { c: 'tree', a: [{ n: 'p', l: 'path', t: 'path' }] },
      { c: 'cat', a: [{ n: 'p', l: 'file', t: 'path', req: true }] },
      { c: 'mkdir -p', a: [{ n: 'p', l: 'folder', t: 'path', req: true }] },
      { c: 'mv', d: 'move / rename (across disks = copy + delete)', a: [{ n: 's', l: 'from', t: 'path', req: true }, { n: 'd', l: 'to', t: 'path', req: true }] },
      { c: 'cp -rp', a: [{ n: 's', l: 'from', t: 'path', req: true }, { n: 'd', l: 'to', t: 'path', req: true }] },
      { c: 'rm -r', a: [{ n: 'p', l: 'path', t: 'path', req: true }] },
      { c: 'write', d: 'overwrite a file with text (like saving in an editor)', a: [{ n: 'p', l: 'file', t: 'path', req: true }, { n: 't', l: 'text', t: 'text', req: true, def: 'edited content' }] },
      { c: 'touch -d', d: 'set modification time', a: [{ n: 'd', l: 'date', t: 'text', req: true, def: '2026-08-07 10:00' }, { n: 'p', l: 'file', t: 'path', req: true }] },
      { c: 'chmod', a: [{ n: 'm', l: 'mode', t: 'select', opts: ['000', '644'] }, { n: 'p', l: 'file', t: 'path', req: true }] },
      { c: 'genphotos', d: 'create mock photos', a: [{ n: 'd', l: 'folder', t: 'path', req: true }, { n: 'n', l: 'count', t: 'num', req: true, def: '5' }, { n: 's', l: 'start', t: 'opt', f: '--start', def: '2026-08-07 10:00' }, { n: 'e', l: 'every', t: 'opt', f: '--every', def: '2m' }, { n: 'x', l: 'prefix', t: 'opt', f: '--prefix', ph: 'IMG_' }, { n: 'ext', l: 'ext', t: 'opt', f: '--ext', ph: 'JPG' }] },
      { c: 'mkfile', a: [{ n: 'p', l: 'file', t: 'path', req: true }, { n: 'kb', l: 'KB', t: 'opt', f: '--kb', ph: '1' }] },
    ]],
    ['disks & system', [
      { c: 'disk', d: 'list disks' },
      { c: 'disk create', d: 'plug in a new disk', a: [{ n: 'n', l: 'name', t: 'text', req: true, def: 'CARD' }, { n: 'fs', l: 'fs', t: 'opt', f: '--fs', sel: ['exfat', 'msdos', 'apfs', 'apfs-cs', 'hfs', 'smbfs'], def: 'exfat' }, { n: 'card', l: 'camera files', t: 'flag', f: '--card', def: true }] },
      { c: 'disk eject', a: [{ n: 'n', l: 'disk', t: 'text', req: true, src: S.mounted }] },
      { c: 'disk mount', a: [{ n: 'n', l: 'disk', t: 'text', req: true, src: S.unmounted }] },
      { c: 'clock', d: 'move the clock', a: [{ n: 'd', l: 'by', t: 'text', req: true, def: '+1d', src: S.durations }] },
      { c: 'tz', d: 'timezone, minutes east of UTC', a: [{ n: 'm', l: 'minutes', t: 'select', opts: ['60', '120', '0', '-300'] }] },
      { c: 'io', a: [{ n: 'r', l: 'reset', t: 'select', opts: ['', 'reset'] }] },
      { c: 'ps' },
      { c: 'kill', a: [{ n: 'p', l: 'pid', t: 'text', req: true, src: S.procs }] },
      { c: 'holdlock', d: 'another process keeps the library locked', a: [{ n: 'p', l: 'library', t: 'path', req: true, def: '.' }, { n: 'h', l: 'host', t: 'opt', f: '--host', def: 'MacBook-Studio' }] },
      { c: 'demo', a: [{ n: 'n', l: 'demo', t: 'select', opts: S.demos }] },
      { c: 'selftest' },
      { c: 'help' },
      { c: 'asscat help' },
    ]],
  ];
  const ALL = C.flatMap(([g, list]) => list.map(x => ({ ...x, group: g, a: x.a || [] })));

  // ---------- composing ----------
  function quote(v) {
    v = String(v);
    if (/^~\/./.test(v) && !/^[\p{L}\p{N}_@%+=:,./~{}-]+$/u.test(v)) return '~/' + quote(v.slice(2));   // keep ~ expandable
    if (v !== '' && /^[\p{L}\p{N}_@%+=:,./~{}-]+$/u.test(v)) return v;
    return '"' + v.replace(/(["\\])/g, '\\$1') + '"';
  }
  const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  // values: {fieldName: string|boolean, sel: {mode, value, folder}} -> {line} | {error}
  function compose(cmd, values) {
    const pre = [], parts = [cmd.c]; let redir = '';
    for (const f of cmd.a) {
      const v = values[f.n];
      const empty = v == null || v === '' || v === false;
      if (f.req && f.t !== 'flag' && f.t !== 'selector' && (v == null || String(v).trim() === '')) return { error: `"${f.l || f.n}" is required` };
      switch (f.t) {
        case 'flag': if (v) parts.push(f.f); break;
        case 'opt': if (!empty) (f.pre ? pre : parts).push(f.f, quote(String(v).trim())); break;
        case 'multi': for (const x of list(v)) parts.push(f.f, quote(x)); break;
        case 'redirect': if (!empty) redir = ' > ' + quote(String(v).trim()); break;
        case 'selector': {
          const s = v || {};
          if (s.mode === 'search') { if (!s.value) return { error: 'search words are required' }; parts.push('--search', quote(s.value)); }
          else if (s.mode === 'view') { if (!s.value) return { error: 'view name is required' }; parts.push('--view', quote(s.value)); if (s.folder) parts.push('--folder', quote(s.folder)); }
          else { const ps = list(s.value); if (!ps.length) return { error: 'give at least one path ("folder/" = everything in it)' }; ps.forEach(p => parts.push(quote(p))); }
          break;
        }
        default: if (!empty) parts.push(quote(String(v).trim()));
      }
    }
    // global options like --crash-after go right after "asscat"
    if (pre.length) parts.splice(0, 1, 'asscat', ...pre, cmd.c.replace(/^asscat /, ''));
    return { line: parts.join(' ') + redir };
  }

  // ---------- browser UI ----------
  function mount(root, ctx) {
    const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs); e.append(...kids); return e; };
    const pick = el('select', { id: 'bCmd', title: 'command' });
    for (const [g, cmds] of C) {
      const og = el('optgroup', { label: g });
      for (const c of cmds) og.append(el('option', { value: ALL.findIndex(x => x.c === c.c && x.group === g), textContent: c.c.replace(/^asscat /, '') }));
      pick.append(og);
    }
    const fields = el('div', { id: 'bFields' });
    const preview = el('code', { id: 'bPreview' });
    const run = el('button', { id: 'bRun', textContent: 'Run', title: 'run this command (same as typing it)' });
    const edit = el('button', { id: 'bEdit', textContent: '↓ to prompt', title: 'copy into the text prompt to change it by hand' });
    root.append(el('div', { className: 'brow' }, pick, fields), el('div', { className: 'brow' }, preview, run, edit));
    let cur = ALL[0], inputs = {}, dlSeq = 0;

    const values = () => {
      const v = {};
      for (const [n, i] of Object.entries(inputs)) v[n] = i.sel ? { mode: i.mode.value, value: i.val.value.trim(), folder: i.folder.value.trim() } : (i.type === 'checkbox' ? i.checked : i.value);
      return v;
    };
    const update = () => {
      const r = compose(cur, values());
      preview.textContent = r.line ?? '⚠ ' + r.error; preview.className = r.error ? 'bad' : '';
      run.disabled = !!r.error; edit.disabled = !!r.error;
      return r;
    };
    // suggestions: static list, a source function, or path completion
    const attachList = (inp, f) => {
      const dl = el('datalist', { id: 'bdl' + (++dlSeq) }); inp.setAttribute('list', dl.id); fields.append(dl);
      const fill = () => {
        let items = [];
        try {
          if (f.t === 'path') items = ctx.completePath(inp.value);
          else if (f.src) items = f.src(ctx, values());
        } catch { items = []; }
        dl.replaceChildren(...items.slice(0, 200).map(x => el('option', { value: x })));
      };
      inp.addEventListener('focus', fill); inp.addEventListener('input', () => { if (f.t === 'path') fill(); });
    };
    const label = (text, ...kids) => el('label', {}, text ? el('span', { textContent: text }) : '', ...kids);

    function render() {
      fields.replaceChildren(); inputs = {};
      if (cur.d) fields.append(el('span', { className: 'bdesc', textContent: cur.d }));
      for (const f of cur.a) {
        let inp;
        if (f.t === 'flag') { inp = el('input', { type: 'checkbox', checked: !!f.def }); fields.append(el('label', { className: 'bflag' }, inp, f.l)); }
        else if (f.t === 'select' || f.sel) {
          const opts = typeof (f.opts || f.sel) === 'function' ? (f.opts || f.sel)(ctx) : (f.opts || f.sel);
          inp = el('select'); opts.forEach(o => inp.append(el('option', { value: o, textContent: o === '' ? '—' : o }))); if (f.def) inp.value = f.def;
          fields.append(label(f.l, inp));
        } else if (f.t === 'selector') {
          const mode = el('select'); [['paths', 'paths'], ['search', '--search'], ['view', '--view folder']].forEach(([v, t]) => mode.append(el('option', { value: v, textContent: t })));
          const val = el('input', { type: 'text', placeholder: 'path, path/ … (comma separated)', size: 22 });
          const folder = el('input', { type: 'text', placeholder: 'virtual folder', size: 14, hidden: true });
          const pathF = { t: 'path' }, viewF = { src: S.views };
          let dlf = pathF;
          attachList(val, new Proxy({}, { get: (_, p) => dlf[p] }));
          mode.onchange = () => {
            dlf = mode.value === 'paths' ? pathF : mode.value === 'view' ? viewF : {};
            val.placeholder = { paths: 'path, path/ … (comma separated)', search: 'words', view: 'view name' }[mode.value];
            folder.hidden = mode.value !== 'view'; update();
          };
          [mode, val, folder].forEach(x => x.addEventListener('input', update));
          fields.append(label(f.l, mode, val, folder));
          inputs[f.n] = { sel: true, mode, val, folder };
          continue;
        } else {
          inp = el('input', { type: 'text', value: f.def ?? '', placeholder: f.ph ?? '', size: f.t === 'num' ? 4 : Math.max(8, Math.min(28, String(f.def || f.ph || '').length + 4)) });
          if (f.t === 'path' || f.src) attachList(inp, f);
          fields.append(label(f.l, inp));
        }
        inp.addEventListener('input', update); inp.addEventListener('change', update);
        inputs[f.n] = inp;
      }
      update();
    }
    pick.onchange = () => { cur = ALL[+pick.value]; render(); const first = fields.querySelector('input[type=text]'); if (first) first.focus(); };
    run.onclick = () => { const r = update(); if (r.line) ctx.run(r.line); };
    edit.onclick = () => { const r = update(); if (r.line) ctx.toPrompt(r.line); };
    fields.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); run.click(); } });
    render();
  }

  G.Builder = { compose, quote, commands: ALL, mount };
})(typeof window !== 'undefined' ? window : globalThis);
