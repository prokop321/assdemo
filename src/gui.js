// Minimal asscat GUI. It only talks to the app through CLI command lines (ctx.cli / ctx.raw),
// which run in the same shell and are echoed to the console marked [gui]. Attaches to window.Gui.
(function (G) {
  'use strict';
  const h = (t, p = {}, ...c) => {
    const e = document.createElement(t);
    for (const [k, v] of Object.entries(p)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'list') e.setAttribute('list', v);
      else e[k] = v;
    }
    for (const x of c.flat(9)) if (x != null && x !== false) e.append(x.nodeType ? x : String(x));
    return e;
  };
  const SETTINGS = {
    'edge.same_path': { label: 'Saving over an original', opts: ['auto', 'ask', 'manual'], help: 'auto = link the new version and inherit tags, ask = only suggest the link, manual = nothing' },
    'import.after': { label: 'After import', opts: ['manual', 'auto'], help: 'auto = materialize the active view right after import' },
    'materialize.locked': { label: 'Locked folders', list: true, help: 'comma separated, relative to the library; materialize never moves anything inside' },
    'scan.ignore': { label: 'Ignored file names', list: true, help: 'comma separated, exact names, any case' },
  };
  const RESULT_CLASS = r => r === 'move' || r === 'rename' ? 'r-move' : r === 'stay:in_place' ? 'r-ok' : r === 'stay:pending' || r === 'stay:locked' ? 'r-dim' : 'r-warn';

  function mount(root, ctx) {
    const st = {
      tab: 'files', lib: null, libErr: null, openPath: '/Users/prokop/Pictures/Knihovna',
      query: '', files: [], sel: new Set(), detail: null, pendingTag: null, tagKey: '', tagVal: '', editOf: '',
      views: [], view: null, tree: null, plan: null, renameConflicts: false, undo: null,
      form: { name: '', template: '{klient}/{rok}/{shoot}', filter: '', none: 'klient=bez klienta' },
      vols: [], volRes: {}, gap: '2h', minFiles: '3', shoots: null,
      settings: null, msg: '', bad: false,
    };
    const SHOOT_FILE = '/tmp/asscat-gui-shoots.json';
    const cli = (...a) => ctx.cli(a.filter(x => x != null && x !== false));
    const say = (msg, bad = false) => { st.msg = msg; st.bad = bad; };
    const failed = (r, what) => { if (r.code === 0) return false; say(`${what}: ${r.json?.error || r.text || 'failed'}`, true); return true; };

    // ---------- loading ----------
    function loadLib() {
      const r = cli('library');
      st.lib = null; st.libErr = null;
      if (r.code !== 0) { st.libErr = r.json?.error || r.text; return; }
      if (r.json.library) st.lib = r.json;
    }
    const pathsOf = it => (it.paths || []).map(p => typeof p === 'string' ? p : p.path);
    function loadFiles() {
      if (!st.lib) return;
      const r = st.query.trim() ? cli('search', ...st.query.trim().split(/\s+/)) : cli('files', st.lib.library + '/');
      if (r.code !== 0) { st.files = []; if (!/not in library/.test(r.json?.error || '')) failed(r, 'list'); return; }
      st.files = r.json.map(it => ({ id: it.file_id, paths: it.file_id == null ? [it.path] : pathsOf(it), tags: it.tags || {}, pending: it.file_id == null ? it.hash_status : null }));
      const ids = new Set(st.files.map(f => f.id));
      for (const id of [...st.sel]) if (!ids.has(id)) st.sel.delete(id);
      loadDetail();
    }
    function loadDetail() {
      st.detail = null;
      if (st.sel.size !== 1) return;
      const f = st.files.find(x => x.id === [...st.sel][0]);
      if (!f) return;
      const r = cli('files', f.paths[0]);
      if (r.code === 0) st.detail = r.json[0];
    }
    function loadViews() {
      if (!st.lib) return;
      const r = cli('view', 'list'); st.views = r.code === 0 ? r.json : [];
      if (st.view && !st.views.some(v => v.name === st.view)) { st.view = null; st.tree = null; st.plan = null; }
    }
    function showView(name) {
      st.view = name; st.plan = null; st.undo = null;
      const r = cli('view', 'show', name); st.tree = r.code === 0 ? r.json : null; failed(r, 'view');
    }
    function loadVols() { const r = cli('volumes'); st.vols = r.code === 0 ? r.json : []; }
    function loadSettings() {
      st.settings = {};
      for (const k of Object.keys(SETTINGS)) { const r = cli('setting', 'get', k); if (r.code === 0) st.settings[k] = r.json.value; }
    }
    function loadTab() {
      if (!st.lib) return;
      if (st.tab === 'files') loadFiles();
      if (st.tab === 'views') { loadViews(); if (st.view) showView(st.view); }
      if (st.tab === 'import') loadVols();
      if (st.tab === 'settings') loadSettings();
    }
    function refresh() { loadLib(); loadTab(); render(); }

    // ---------- actions ----------
    function act(fn) { say(''); try { fn(); } catch (e) { say(e.message, true); } render(); }
    const selPaths = () => st.files.filter(f => st.sel.has(f.id)).map(f => f.paths[0]);
    const A = {
      open: startOver => act(() => {
        const r = cli('library', 'open', st.openPath, startOver ? '--start-over' : null);
        if (failed(r, 'open')) { st.libErr = r.json?.error; return; }
        say(r.json.created ? `new library created in ${r.json.library}` : `opened ${r.json.library}`);
        loadLib(); loadTab();
      }),
      sync: mode => act(() => {
        const r = cli('sync', mode); if (failed(r, 'sync')) return;
        const s = mode === 'full' ? r.json.full : r.json;
        say(`sync ${mode}: ${s.listed} files · new ${s.new} · changed ${s.changed} · moved ${s.moved} · gone ${s.gone} · hashed ${s.hashed}${s.errors.length ? ` · ${s.errors.length} error(s)` : ''}`, s.errors.length > 0);
        loadLib(); loadTab();
      }),
      search: () => act(() => { st.sel.clear(); loadFiles(); }),
      tagPreview: () => act(() => {
        if (!st.sel.size) return say('select files first', true);
        const r = cli('tag', 'add', st.tagKey, st.tagVal, ...selPaths());
        if (failed(r, 'tag')) return;
        st.pendingTag = { key: st.tagKey, value: st.tagVal, paths: selPaths(), p: r.json };
      }),
      tagApply: () => act(() => {
        const t = st.pendingTag; st.pendingTag = null;
        const r = cli('tag', 'add', t.key, t.value, ...t.paths, '--yes');
        if (failed(r, 'tag')) return;
        say(`tagged ${r.json.files} file(s) with ${r.json.key} = ${r.json.value}`); loadFiles();
      }),
      untag: (path, key, value) => act(() => {
        const r = cli('tag', 'remove', key, value, path, '--yes');
        if (failed(r, 'untag')) return; say(`removed ${key} = ${value}`); loadFiles();
      }),
      edgeAdd: (orig, edit) => act(() => {
        const r = cli('edge', 'add', orig, edit);
        if (failed(r, 'link')) return; say(`${edit} is now an edit of ${orig} and inherits its tags`); st.editOf = ''; loadFiles();
      }),
      edgeSet: (op, orig, edit) => act(() => { const r = cli('edge', op, orig, edit); if (!failed(r, op)) { say(`edge ${op}ed`); loadFiles(); } }),
      viewSave: () => act(() => {
        const f = st.form;
        const multi = (flag, s) => s.split(',').map(x => x.trim()).filter(Boolean).flatMap(x => [flag, x]);
        const r = cli('view', 'set', f.name.trim(), f.template.trim(), ...multi('--filter', f.filter), ...multi('--none', f.none));
        if (failed(r, 'view')) return; say(`view ${r.json.name} saved`); loadViews(); showView(r.json.name);
      }),
      viewActivate: n => act(() => { const r = cli('view', 'activate', n); if (!failed(r, 'activate')) { say(`${n} is the active view`); loadViews(); } }),
      viewDelete: n => act(() => { const r = cli('view', 'delete', n); if (!failed(r, 'delete')) { say(`view ${n} deleted`); loadViews(); } }),
      preview: () => act(() => {
        const r = cli('materialize', st.view, st.renameConflicts ? '--rename-conflicts' : null);
        if (!failed(r, 'preview')) st.plan = r.json;
      }),
      apply: () => act(() => {
        const r = cli('materialize', st.view, st.renameConflicts ? '--rename-conflicts' : null, '--apply');
        if (failed(r, 'materialize')) return;
        say(`moved ${r.json.done} file(s)${r.json.failed.length ? `, ${r.json.failed.length} failed` : ''}`, r.json.failed.length > 0);
        st.plan = null; showView(st.view);
      }),
      undoPreview: () => act(() => { const r = cli('materialize', 'undo'); if (!failed(r, 'undo')) { if (r.json.result) say(r.json.result); else st.undo = r.json; } }),
      undoApply: () => act(() => {
        const r = cli('materialize', 'undo', '--apply'); st.undo = null;
        if (failed(r, 'undo')) return;
        say(`moved back ${r.json.done} file(s)${r.json.stays.length ? `, ${r.json.stays.length} stay (moved or changed since)` : ''}`); if (st.view) showView(st.view);
      }),
      check: name => act(() => { const r = cli('check', name); if (!failed(r, 'check')) st.volRes[name] = { check: r.json }; }),
      import: name => act(() => {
        const r = cli('import', name); if (failed(r, 'import')) return;
        st.volRes[name] = { imported: r.json };
        say(`imported ${r.json.imported} file(s) into ${r.json.into}`); loadLib();
      }),
      shoots: () => act(() => {
        const r = cli('shoots', st.gap, st.minFiles); if (failed(r, 'shoots')) return;
        st.shoots = r.json; if (!r.json.shoots.length) say('no shoots found in _inbox');
      }),
      shootsApply: () => act(() => {
        // write the proposal through the shell exactly like a user would: generate, fill fields, apply
        let r = ctx.raw(`asscat shoots ${G.Builder.quote(st.gap)} ${G.Builder.quote(st.minFiles)} > ${SHOOT_FILE}`);
        if (failed(r, 'shoots')) return;
        st.shoots.shoots.forEach((s, i) => {
          for (const f of ['name', 'klient']) if (s[f]) ctx.raw(`jsonset ${SHOOT_FILE} shoots.${i}.${f} ${G.Builder.quote(s[f])}`);
        });
        r = cli('shoots', 'apply', SHOOT_FILE, '--yes'); if (failed(r, 'apply shoots')) return;
        const n = r.json.shoots.filter(s => !s.skipped).length;
        say(`tagged ${n} shoot(s)`); st.shoots = null;
      }),
      saveSetting: (k, v) => act(() => { const r = cli('setting', 'set', k, JSON.stringify(v)); if (!failed(r, 'setting')) { say(`${k} saved`); loadSettings(); } }),
    };

    // ---------- rendering ----------
    const inp = (value, oninput, p = {}) => h('input', { type: 'text', value, oninput: e => oninput(e.target.value), ...p });
    const onEnter = fn => ({ onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } } });
    const btn = (label, fn, p = {}) => h('button', { onclick: fn, ...p }, label);
    const chip = (key, v, path) => {
      const inh = typeof v === 'object';
      return h('span', { class: 'chip' + (inh ? ' inh' : ''), title: inh ? `inherited from ${v.inherited_from.path}` : '' },
        `${key}: ${inh ? v.value : v}`, inh ? ' ↖' : btn('×', e => { e.stopPropagation(); A.untag(path, key, v); }, { class: 'x', title: 'remove tag' }));
    };

    function libBar() {
      if (!st.lib) {
        return h('div', { class: 'card' },
          h('h3', {}, 'Open a library'),
          h('p', { class: 'muted' }, 'Any folder can be a library. A new folder gets a new database; the files stay where they are.'),
          h('div', { class: 'row' }, inp(st.openPath, v => st.openPath = v, { size: 40, ...onEnter(() => A.open(false)) }), btn('Open', () => A.open(false))),
          st.libErr ? h('p', { class: 'bad' }, st.libErr) : null,
          st.libErr && /start-over/.test(st.libErr) ? btn('Start over with an empty database', () => A.open(true)) : null,
          h('p', { class: 'muted' }, 'Tip: the console demos ("demo tour") create a sample library in ~/Pictures/Knihovna.'));
      }
      const L = st.lib;
      return h('div', { class: 'libbar' },
        h('div', {}, h('b', {}, L.name), h('span', { class: 'muted' }, ` ${L.library} · ${L.files} files · ${L.active_paths} paths · ${L.tags} tags · ${L.fs.type}${L.fs.case_sensitive ? ' (case-sensitive)' : ''}`)),
        h('div', { class: 'row' }, btn('Sync', () => A.sync('fast'), { title: 'scan for new, moved and changed files' }), btn('Full check', () => A.sync('full'), { title: 're-read every file' }),
          btn('Other library…', () => { st.lib = null; render(); })));
    }

    function filesTab() {
      const all = st.files.length && st.files.every(f => st.sel.has(f.id));
      const toggle = id => { st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id); st.pendingTag = null; loadDetail(); render(); };
      const list = h('div', { class: 'list' },
        h('div', { class: 'lhead' },
          h('input', { type: 'checkbox', checked: all, title: 'select all', onchange: () => { if (all) st.sel.clear(); else st.files.forEach(f => f.id != null && st.sel.add(f.id)); loadDetail(); render(); } }),
          h('span', {}, `${st.files.length} ${st.query ? 'results' : 'files'}${st.sel.size ? ` · ${st.sel.size} selected` : ''}`)),
        st.files.slice(0, 400).map(f => h('div', { class: 'item' + (st.sel.has(f.id) ? ' sel' : '') + (f.pending ? ' pending' : ''), onclick: () => f.id != null && toggle(f.id) },
          h('input', { type: 'checkbox', checked: st.sel.has(f.id), disabled: f.id == null, onclick: e => e.stopPropagation(), onchange: () => toggle(f.id) }),
          h('div', { class: 'grow' },
            h('div', { class: 'path' }, f.paths[0], f.paths.length > 1 ? h('span', { class: 'muted' }, ` +${f.paths.length - 1} copy`) : null, f.pending ? h('span', { class: 'muted' }, ` · ${f.pending}`) : null),
            h('div', { class: 'chips' }, Object.entries(f.tags).flatMap(([k, vs]) => vs.map(v => chip(k, v, f.paths[0]))))))),
        st.files.length > 400 ? h('div', { class: 'muted' }, `… ${st.files.length - 400} more, refine the search`) : null);

      const tagBox = h('div', { class: 'card' },
        h('h3', {}, st.sel.size ? `Tag ${st.sel.size} selected file(s)` : 'Tag files'),
        h('div', { class: 'row' },
          inp(st.tagKey, v => st.tagKey = v, { placeholder: 'key (klient, shoot…)', size: 12 }),
          inp(st.tagVal, v => st.tagVal = v, { placeholder: 'value', size: 14, ...onEnter(A.tagPreview) }),
          btn('Add…', A.tagPreview, { disabled: !st.sel.size })),
        st.pendingTag ? (() => {
          const p = st.pendingTag.p;
          return h('div', { class: 'confirm' },
            h('div', {}, `Add ${p.key} = "${p.value}" to ${p.files} file(s) (${p.paths} path(s))${p.already ? `, ${p.already} already have it` : ''}.`),
            p.note ? h('div', { class: 'muted' }, p.note) : null,
            p.warning ? h('div', { class: 'bad' }, `⚠ ${p.warning}: views using "${p.key}" will skip these files`) : null,
            p.pending_hash.length ? h('div', { class: 'muted' }, `${p.pending_hash.length} file(s) still waiting for hashing are skipped`) : null,
            h('div', { class: 'row' }, btn('Apply', A.tagApply, { class: 'primary' }), btn('Cancel', () => { st.pendingTag = null; render(); })));
        })() : null);

      let detail = null;
      if (st.detail) {
        const d = st.detail, me = d.paths[0].path;
        const ed = (e, label) => h('div', { class: 'edge' }, `${label} ${e.paths[0] || `#${e.file_id} (earlier version, not on disk)`}`, h('span', { class: 'muted' }, ` · ${e.origin}, ${e.status}`),
          e.status === 'suggested' && label === '↖' && e.paths[0] ? h('span', {}, ' ', btn('confirm', () => A.edgeSet('confirm', e.paths[0], me)), btn('reject', () => A.edgeSet('reject', e.paths[0], me))) : null);
        detail = h('div', { class: 'card' },
          h('h3', {}, 'File'),
          h('div', { class: 'muted' }, `#${d.file_id} · ${d.size} B · ${d.hash}`),
          d.paths.map(p => h('div', { class: 'path' }, p.path, h('span', { class: 'muted' }, ` · ${p.mtime}`))),
          d.history.length ? h('div', {}, h('div', { class: 'label' }, 'Previously at'), d.history.map(p => h('div', { class: 'path muted' }, p))) : null,
          d.edges.originals.length || d.edges.edits.length ? h('div', {}, h('div', { class: 'label' }, 'Versions'), d.edges.originals.map(e => ed(e, '↖')), d.edges.edits.map(e => ed(e, '↘'))) : null,
          h('div', { class: 'label' }, 'This file is an edit of'),
          h('div', { class: 'row' }, inp(st.editOf, v => st.editOf = v, { placeholder: 'path of the original', size: 26, list: 'gui-paths' }),
            btn('Link', () => A.edgeAdd(st.editOf.trim(), me), { title: 'the edit inherits the original\'s tags' })),
          h('datalist', { id: 'gui-paths' }, st.files.filter(f => f.id !== d.file_id).slice(0, 300).map(f => h('option', { value: f.paths[0] }))));
      }
      return h('div', { class: 'cols' },
        h('div', { class: 'main' },
          h('div', { class: 'row' }, inp(st.query, v => st.query = v, { placeholder: 'search paths and tags (makarska plaz, qila…)', class: 'grow', ...onEnter(A.search) }),
            btn('Search', A.search), st.query ? btn('All files', () => { st.query = ''; A.search(); }) : null),
          list),
        h('div', { class: 'side' }, tagBox, detail));
    }

    function viewsTab() {
      const f = st.form;
      const views = h('div', { class: 'card' },
        h('h3', {}, 'Views'),
        st.views.length ? st.views.map(v => h('div', { class: 'vrow' + (st.view === v.name ? ' sel' : ''), onclick: () => act(() => showView(v.name)) },
          h('div', { class: 'grow' }, h('b', {}, v.name), v.active ? h('span', { class: 'chip' }, 'active') : null, h('div', { class: 'muted mono' }, v.template, v.filter.length ? `  where ${v.filter.map(x => `${x.key}=${x.value}`).join(', ')}` : '')),
          v.active ? null : btn('activate', e => { e.stopPropagation(); A.viewActivate(v.name); }, { title: 'used after import when "After import" is auto' }),
          btn('delete', e => { e.stopPropagation(); A.viewDelete(v.name); }))) : h('p', { class: 'muted' }, 'No views yet.'),
        h('h3', {}, 'New / edit view'),
        h('div', { class: 'form' },
          h('label', {}, 'name', inp(f.name, v => f.name = v, { size: 14 })),
          h('label', {}, 'folders', inp(f.template, v => f.template = v, { size: 24, list: 'gui-tpl', class: 'mono' })),
          h('label', {}, 'only files with', inp(f.filter, v => f.filter = v, { size: 18, placeholder: 'druh=foto, klient=qila' })),
          h('label', {}, 'name when missing', inp(f.none, v => f.none = v, { size: 18, placeholder: 'klient=bez klienta' }))),
        h('datalist', { id: 'gui-tpl' }, ['{klient}/{rok}/{shoot}', '{klient}/{rok}', 'Archiv/{rok}/{mesic}', '{druh}/{rok}/{datum}', '{shoot}'].map(x => h('option', { value: x }))),
        h('p', { class: 'muted' }, 'Folder levels: {any tag key} or rok, mesic, datum, pripona, druh, or fixed text.'),
        btn('Save view', A.viewSave),
        h('hr'),
        btn('Undo last materialize…', A.undoPreview),
        st.undo ? h('div', { class: 'confirm' },
          h('div', {}, `Move ${st.undo.back} file(s) back to where they were before view "${st.undo.view}" moved them.`),
          st.undo.stays.length ? h('div', { class: 'muted' }, `${st.undo.stays.length} stay: moved or changed since.`) : null,
          h('div', { class: 'row' }, btn('Undo', A.undoApply, { class: 'primary' }), btn('Cancel', () => { st.undo = null; render(); }))) : null);

      let right = h('div', { class: 'card muted' }, 'Pick a view to see its virtual folders.');
      if (st.view && st.tree) {
        const t = st.tree;
        const plan = st.plan;
        right = h('div', { class: 'card' },
          h('h3', {}, `${t.view}: ${t.files} files`),
          h('pre', { class: 'tree' }, t.tree.join('\n') || '(no files match)'),
          t.invalid.length ? h('div', { class: 'bad' }, `${t.invalid.length} file(s) can't be placed: ${t.invalid.map(x => x.error).join('; ')}`) : null,
          h('div', { class: 'row' },
            btn('Preview moves', A.preview),
            h('label', {}, h('input', { type: 'checkbox', checked: st.renameConflicts, onchange: e => { st.renameConflicts = e.target.checked; if (st.plan) A.preview(); } }), ' number clashing names')),
          plan ? h('div', {},
            h('div', { class: 'chips' }, Object.entries(plan.summary).map(([k, n]) => h('span', { class: 'chip ' + RESULT_CLASS(k) }, `${k} ${n}`))),
            plan.warnings.map(w => h('div', { class: 'bad' }, `⚠ ${w.warning}: ${w.paths.join(', ')}. ${w.hint}`)),
            h('div', { class: 'plan' }, plan.rows.map(r => h('div', { class: 'prow ' + RESULT_CLASS(r.result) },
              h('span', { class: 'res' }, r.result), h('span', { class: 'mono' }, r.path, r.target && r.target !== r.path ? ` → ${r.target}` : ''), r.reason ? h('span', { class: 'muted' }, ` · ${r.reason}`) : null))),
            h('div', { class: 'row' }, btn(`Move ${(plan.summary.move || 0) + (plan.summary.rename || 0)} file(s) on disk`, A.apply, { class: 'primary', disabled: !((plan.summary.move || 0) + (plan.summary.rename || 0)) }),
              h('span', { class: 'muted' }, 'a backup of the database is made first; you can undo'))) : null);
      }
      return h('div', { class: 'cols' }, h('div', { class: 'side' }, views), h('div', { class: 'main' }, right));
    }

    function importTab() {
      const vols = h('div', { class: 'card' },
        h('h3', {}, 'Cards and disks'),
        st.vols.length ? st.vols.map(v => {
          const res = st.volRes[v.name];
          return h('div', { class: 'vol' },
            h('div', { class: 'row' }, h('b', { class: 'grow' }, v.name), h('span', { class: 'muted' }, `${v.fs}${v.has_dcim ? ' · camera card' : ''}`), btn('Check', () => A.check(v.name)), btn('Import', () => A.import(v.name), { class: 'primary' })),
            res?.check ? h('div', { class: 'muted' }, `${res.check.total} files: ${res.check.new_count} new, ${res.check.in_library.length} already in library, ${res.check.filtered_out.length} skipped by the filter`) : null,
            res?.imported ? h('div', {}, `Imported ${res.imported.imported} into ${res.imported.into}; ${res.imported.already_in_library} were already in the library${res.imported.failed.length ? `; ${res.imported.failed.length} failed` : ''}.`) : null);
        }) : h('p', { class: 'muted' }, 'No card connected. Plug one in from the file browser sidebar ("+ Plug in disk").'),
        btn('↻ Look again', () => act(loadVols)));
      const sh = st.shoots;
      const shoots = h('div', { class: 'card' },
        h('h3', {}, 'Shoots in _inbox'),
        h('div', { class: 'row' }, h('label', {}, 'new shoot after a gap of ', inp(st.gap, v => st.gap = v, { size: 4 })), h('label', {}, 'min. files ', inp(st.minFiles, v => st.minFiles = v, { size: 2 })), btn('Propose', A.shoots)),
        sh ? h('div', {},
          sh.shoots.map(s => h('div', { class: 'shoot' },
            h('div', { class: 'muted' }, `#${s.id} · ${s.files.length} files · ${s.from} – ${s.to} · ${s.files[0].split('/').pop()} …`),
            h('div', { class: 'row' }, inp(s.name || '', v => s.name = v, { placeholder: 'shoot name', size: 18 }), inp(s.klient || '', v => s.klient = v, { placeholder: 'client (optional)', size: 14 })))),
          sh.no_shoot.length ? h('div', { class: 'muted' }, `${sh.no_shoot.length} file(s) don't belong to any shoot`) : null,
          sh.shoots.length ? btn('Tag shoots', A.shootsApply, { class: 'primary' }) : null) : null);
      return h('div', { class: 'cols' }, h('div', { class: 'main' }, vols), h('div', { class: 'side' }, shoots));
    }

    function settingsTab() {
      if (!st.settings) return h('div', {});
      return h('div', { class: 'card' }, h('h3', {}, 'Library settings'),
        Object.entries(SETTINGS).map(([k, s]) => {
          const cur = st.settings[k];
          let field, get;
          if (s.opts) { field = h('select', {}, s.opts.map(o => h('option', { value: o, selected: o === cur }, o))); get = () => field.value; }
          else { field = h('input', { type: 'text', size: 34, value: (cur || []).map(x => x.replace('\r', '\\r')).join(', ') }); get = () => field.value.split(',').map(x => x.trim().replace('\\r', '\r')).filter(Boolean); }
          return h('div', { class: 'setting' }, h('div', {}, h('b', {}, s.label), h('div', { class: 'muted' }, s.help)), h('div', { class: 'row' }, field, btn('Save', () => A.saveSetting(k, get()))));
        }));
    }

    function render() {
      const tabs = [['files', 'Files & tags'], ['views', 'Views'], ['import', 'Import'], ['settings', 'Settings']];
      const body = !st.lib ? null : { files: filesTab, views: viewsTab, import: importTab, settings: settingsTab }[st.tab]();
      root.replaceChildren(...[
        h('div', { class: 'gtop' }, libBar(),
          st.lib ? h('nav', { class: 'tabs' }, tabs.map(([id, l]) => h('button', { class: st.tab === id ? 'on' : '', onclick: () => act(() => { st.tab = id; loadTab(); }) }, l)),
            h('span', { class: 'grow' }), btn('↻', refresh, { title: 'reload from the library (after changes made in the console or the file browser)' })) : null),
        st.msg ? h('div', { class: 'gmsg' + (st.bad ? ' bad' : '') }, st.msg) : null,
        body].filter(Boolean));
    }
    refresh();
    return { refresh };
  }
  G.Gui = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
