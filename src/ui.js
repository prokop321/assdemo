// Browser UI: terminal + Finder-like browser over one shared mock kernel.
(function () {
  'use strict';
  const { U, OS, Shell } = window;
  const { join, dirname, basename } = OS;
  const KEY = 'asscat-demo-os-v1';
  const $ = id => document.getElementById(id);

  // ---------- boot / persistence ----------
  let k, sh;
  function boot(fresh) {
    let saved = null;
    if (!fresh) try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
    try { k = saved ? OS.Kernel.fromJSON(saved.kernel, { realtime: true }) : new OS.Kernel({ realtime: true, start: Date.now() * 1e6 }); }
    catch { k = new OS.Kernel({ realtime: true, start: Date.now() * 1e6 }); saved = null; }
    sh = new Shell.Shell(k, { out: s => print(s), err: s => print(s, 'err') });
    if (saved && saved.cwd && k.exists(saved.cwd)) sh.cwd = saved.cwd;
    finder.cwd = saved && saved.fcwd && k.exists(saved.fcwd) ? saved.fcwd : Shell.HOME;
    k.listeners.push(() => scheduleRender());
    return !!saved;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ kernel: k.toJSON(), cwd: sh.cwd, fcwd: finder.cwd })); } catch { /* storage full or blocked */ }
  }

  // ---------- terminal ----------
  const out = $('out'), input = $('in');
  const hist = []; let hi = 0;
  function print(text, cls) {
    const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; out.appendChild(d);
    if (out.childNodes.length > 4000) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }
  function runLine(line) {
    print(`${sh.prompt()} ${line}`, 'cmd');
    const t = line.trim();
    if (t === 'clear') { out.textContent = ''; return; }
    if (t === 'reset') {
      askYes('Erase all mock disks and the library and start over?', 'Erase').then(yes => {
        if (!yes) return print('reset cancelled', 'err');
        try { localStorage.removeItem(KEY); } catch { /* blocked */ }
        k.listeners = []; boot(true); out.textContent = ''; welcome(); render();
      });
      return;
    }
    if (t) { const code = sh.exec(line); if (code) print(`[exit ${code}]`, 'err'); }
    save(); render();
  }
  function stepDemo() {
    while (sh.queue.length && sh.queue[0].startsWith('#')) print(sh.queue.shift(), 'note');
    if (sh.queue.length) runLine(sh.queue.shift());
    while (sh.queue.length && sh.queue[0].startsWith('#')) print(sh.queue.shift(), 'note');
    if (!sh.queue.length) print('# end of demo — "demo" lists the next one', 'note');
  }
  function complete() {
    const v = input.value, m = /(\S*)$/.exec(v), word = m[1].replace(/^["']/, '');
    const dirPart = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
    const base = word.slice(dirPart.length);
    let names; try { names = k.readdir(sh.path(dirPart || '.')); } catch { return; }
    const hits = names.filter(n => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.')));
    if (!hits.length) return;
    if (hits.length > 1) {
      let pre = hits[0]; for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
      if (pre.length > base.length) input.value = v.slice(0, v.length - base.length) + pre;
      else print(hits.join('  '), 'err');
      return;
    }
    let full = dirPart + hits[0]; let isDir = false;
    try { isDir = k.stat(sh.path(full)).type === 'dir'; } catch { /* ignore */ }
    if (/\s/.test(full)) full = '"' + full + (isDir ? '/' : '"'); else if (isDir) full += '/';
    input.value = v.slice(0, v.length - m[1].length) + full;
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value; input.value = '';
      if (!v.trim() && sh.queue.length) { stepDemo(); return; }
      if (v.trim()) { hist.push(v); hi = hist.length; }
      runLine(v);
    } else if (e.key === 'ArrowUp') { if (hi > 0) input.value = hist[--hi]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hi < hist.length) input.value = hist[++hi] ?? ''; e.preventDefault(); }
    else if (e.key === 'Tab') { e.preventDefault(); complete(); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); out.textContent = ''; }
  });
  $('term').addEventListener('click', () => { if (!window.getSelection().toString()) input.focus(); });

  // ---------- in-page dialogs (the artifact viewer blocks prompt/confirm) ----------
  // fields: [{id, label, value, type:'text'|'select'|'checkbox', options}] -> Promise<values|null>
  function ask(title, fields = [], okLabel = 'OK') {
    return new Promise(resolve => {
      const dlg = $('ask'), body = $('askBody'); $('askTitle').textContent = title; $('askOk').textContent = okLabel; body.textContent = '';
      const els = {};
      for (const f of fields) {
        const l = document.createElement('label'); let el;
        if (f.type === 'select') { el = document.createElement('select'); for (const o of f.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; el.appendChild(op); } el.value = f.value; }
        else { el = document.createElement('input'); el.type = f.type === 'checkbox' ? 'checkbox' : 'text'; if (f.type === 'checkbox') el.checked = !!f.value; else el.value = f.value ?? ''; }
        el.id = 'ask-' + f.id;
        if (f.type === 'checkbox') { l.className = 'cb'; l.append(el, document.createTextNode(f.label)); } else l.append(document.createTextNode(f.label), el);
        body.appendChild(l); els[f.id] = el;
      }
      dlg.returnValue = '';
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        const v = {}; for (const f of fields) v[f.id] = f.type === 'checkbox' ? els[f.id].checked : els[f.id].value; resolve(v);
      };
      setTimeout(() => {
        dlg.showModal();
        const first = body.querySelector('input[type=text]'); if (first) { first.focus(); first.select(); }
      }, 0);
    });
  }
  const askText = async (title, value) => { const r = await ask(title, [{ id: 'v', label: '', value }]); return r ? r.v.trim() : null; };
  const askYes = async (title, ok) => !!(await ask(title, [], ok || 'OK'));

  // ---------- finder ----------
  const finder = { cwd: Shell.HOME, sel: new Set(), clip: null };
  function fstat(msg, bad) { const s = $('fstat'); s.textContent = msg || ''; s.className = bad ? 'bad' : ''; }
  function act(fn) { try { fn(); fstat(''); } catch (e) { fstat(e.message, true); } save(); render(); }
  function selected() { return [...finder.sel].map(n => join(finder.cwd, n)); }
  function go(p) { if (!k.exists(p) || k.stat(p).type !== 'dir') { fstat(`not a folder: ${p}`, true); return; } finder.cwd = p; finder.sel.clear(); save(); render(); }
  function openFile(p) {
    const dlg = $('dlg'); $('dlgTitle').textContent = p; let text;
    try { text = k.readFile(p); } catch (e) { fstat(e.message, true); return; }
    $('dlgText').value = text; dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'save') act(() => k.writeFile(p, $('dlgText').value)); };
    dlg.showModal();
  }
  function moveInto(paths, dest) {
    act(() => { for (const p of paths) { const t = join(dest, basename(p)); if (k.exists(t) && k._lookup(t) !== k._lookup(p)) throw new Error(`"${basename(p)}" already exists in ${dest}`); sh.move(p, t); } });
  }
  const actions = {
    up: () => go(dirname(finder.cwd)),
    mkdir: async () => { const n = await askText('New folder name', 'untitled folder'); if (n) act(() => k.mkdir(join(finder.cwd, n))); },
    newfile: async () => { const n = await askText('New file name', 'untitled.txt'); if (n) act(() => { const p = join(finder.cwd, n); if (k.exists(p)) throw new Error('already exists'); k.writeFile(p, ''); }); },
    edit: () => { const [p] = selected(); if (p && k.stat(p).type === 'file') openFile(p); else fstat('select a file', true); },
    rename: async () => { const [p] = selected(); if (!p) return fstat('select an item', true); const n = await askText('Rename to', basename(p)); if (n && n !== basename(p)) act(() => { k.rename(p, join(finder.cwd, n), { noReplace: true }); finder.sel = new Set([n]); }); },
    cut: () => { finder.clip = { mode: 'cut', paths: selected() }; fstat(`${finder.clip.paths.length} item(s) cut — open a folder and Paste`); },
    copy: () => { finder.clip = { mode: 'copy', paths: selected() }; fstat(`${finder.clip.paths.length} item(s) copied`); },
    paste: () => {
      const c = finder.clip; if (!c || !c.paths.length) return fstat('clipboard is empty', true);
      if (c.mode === 'cut') { moveInto(c.paths, finder.cwd); finder.clip = null; return; }
      act(() => { for (const p of c.paths) { let t = join(finder.cwd, basename(p)); for (let i = 2; k.exists(t); i++) t = join(finder.cwd, `${U.stem(basename(p))} ${i}${U.ext(basename(p)) ? '.' + U.ext(basename(p)) : ''}`); sh.copyTree(p, t, true); } });
    },
    delete: async () => { const ps = selected(); if (ps.length && await askYes(`Delete ${ps.length} item(s)? There is no trash in this mock OS.`, 'Delete')) act(() => { ps.forEach(p => k.rmTree(p)); finder.sel.clear(); }); },
    date: async () => {
      const ps = selected(); if (!ps.length) return fstat('select items', true);
      const cur = U.fmtLocal(k.stat(ps[0]).mtime_ns, k.tzMin);
      const v = await askText('Modification time (local, YYYY-MM-DD HH:MM[:SS])', cur); if (!v) return;
      act(() => { const t = U.parseLocal(v, k.tzMin); if (t == null) throw new Error('bad date'); ps.forEach(p => k.utimes(p, t)); });
    },
    term: () => { sh.cwd = finder.cwd; render(); input.focus(); },
  };
  document.querySelectorAll('#ftool button[data-a]').forEach(b => b.addEventListener('click', () => actions[b.dataset.a]()));
  $('hidden').addEventListener('change', render);
  $('fpath').addEventListener('keydown', e => { if (e.key === 'Enter') { const v = e.target.value.trim().replace(/^~(?=$|\/)/, Shell.HOME); go(OS.normPath(v, finder.cwd)); } });

  function dropTarget(el, dest) {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('drop');
      let paths; try { paths = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (paths.includes(dest)) return;
      moveInto(paths, dest);
    });
  }
  function renderSide() {
    const side = $('side'); side.textContent = '';
    const h = t => { const e = document.createElement('h4'); e.textContent = t; side.appendChild(e); };
    const item = (label, path, extra) => {
      const d = document.createElement('div'); d.className = 'it'; const s = document.createElement('span'); s.textContent = label; d.appendChild(s);
      d.title = path; d.onclick = () => go(path); dropTarget(d, path);
      if (extra) d.appendChild(extra); side.appendChild(d);
    };
    h('Places');
    for (const [l, p] of [['Home', Shell.HOME], ['Pictures', Shell.HOME + '/Pictures'], ['Desktop', Shell.HOME + '/Desktop'], ['tmp', '/tmp']]) if (k.exists(p)) item(l, p);
    h('Disks');
    for (const d of k.disks()) {
      if (!d.mountedAt) continue;
      let ej = null;
      if (d.removable) { ej = document.createElement('span'); ej.className = 'ej'; ej.textContent = '⏏'; ej.title = 'Eject'; ej.onclick = e => { e.stopPropagation(); act(() => { if (finder.cwd.startsWith(d.mountedAt)) finder.cwd = Shell.HOME; k.ejectDisk(d.name); }); }; }
      item(`${d.name} (${d.fs})`, d.mountedAt === '/' ? '/' : d.mountedAt, ej);
    }
    const ejected = k.disks().filter(d => !d.mountedAt);
    if (ejected.length) { h('Unplugged'); for (const d of ejected) { const x = document.createElement('div'); x.className = 'it'; x.textContent = `⏏ ${d.name}`; x.title = 'Plug back in'; x.onclick = () => act(() => k.mountDisk(d.name)); side.appendChild(x); } }
    const add = document.createElement('button'); add.textContent = '+ Plug in disk'; add.style.marginTop = '10px';
    add.onclick = async () => {
      const r = await ask('Plug in a disk', [
        { id: 'name', label: 'Name', value: 'CARD' },
        { id: 'fs', label: 'Filesystem', type: 'select', value: 'exfat', options: Object.keys(OS.FS_PROFILES) },
        { id: 'card', label: 'Fill it with camera files (DCIM)', type: 'checkbox', value: true }], 'Plug in');
      if (!r || !r.name.trim()) return;
      const name = r.name.trim(), fs = r.fs, card = r.card;
      act(() => { const v = k.createDisk({ name, fs }); if (card) window.Gen.card(k, v.mountedAt); finder.cwd = v.mountedAt; });
    };
    side.appendChild(add);
  }
  function renderList() {
    const list = $('flist'); list.textContent = '';
    if (!k.exists(finder.cwd)) finder.cwd = Shell.HOME;
    $('fpath').value = finder.cwd;
    const showHidden = $('hidden').checked;
    let names; try { names = k.readdir(finder.cwd); } catch (e) { fstat(e.message, true); return; }
    names = names.filter(n => showHidden || !n.startsWith('.'));
    const tbl = document.createElement('table');
    tbl.innerHTML = '<thead><tr><th>Name</th><th style="text-align:right">Size</th><th>Modified</th></tr></thead>';
    const tb = document.createElement('tbody');
    const dirs = [], files = [];
    for (const n of names) { const st = k.stat(join(finder.cwd, n)); (st.type === 'dir' ? dirs : files).push([n, st]); }
    for (const [n, st] of [...dirs, ...files]) {
      const p = join(finder.cwd, n);
      const tr = document.createElement('tr'); tr.className = 'row' + (finder.sel.has(n) ? ' sel' : ''); tr.draggable = true;
      const icon = st.type === 'dir' ? '📁 ' : st.type === 'link' ? '↪ ' : '📄 ';
      const c1 = document.createElement('td'); c1.textContent = icon + n + (st.type === 'link' ? ' → ' + st.target : '') + (st.mode & 0o444 ? '' : '  🔒');
      const c2 = document.createElement('td'); c2.className = 'num'; c2.textContent = st.type === 'file' ? U.fmtSize(st.size) : (st.type === 'dir' ? `${st.size} items` : '');
      const c3 = document.createElement('td'); c3.className = 'dim'; c3.textContent = U.fmtLocal(st.mtime_ns, k.tzMin);
      tr.append(c1, c2, c3);
      tr.onclick = e => { if (!(e.metaKey || e.ctrlKey)) finder.sel.clear(); finder.sel.has(n) && (e.metaKey || e.ctrlKey) ? finder.sel.delete(n) : finder.sel.add(n); renderList(); };
      tr.ondblclick = () => { if (st.type === 'dir') go(p); else if (st.type === 'file') openFile(p); };
      tr.addEventListener('dragstart', e => { if (!finder.sel.has(n)) { finder.sel = new Set([n]); } e.dataTransfer.setData('text/plain', JSON.stringify(selected())); });
      if (st.type === 'dir') dropTarget(tr, p);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb); list.appendChild(tbl);
    if (!names.length) { const e = document.createElement('div'); e.style.cssText = 'padding:16px;color:var(--muted)'; e.textContent = 'empty folder'; list.appendChild(e); }
    for (const n of [...finder.sel]) if (!names.includes(n)) finder.sel.delete(n);
  }
  let pending = false;
  function scheduleRender() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
  function render() {
    $('prompt').textContent = sh.prompt();
    const nx = $('next');
    const next = sh.queue.find(s => !s.startsWith('#'));
    nx.style.display = next ? 'block' : 'none'; nx.textContent = next ? `▶ Enter runs: ${next}` : '';
    renderSide(); renderList();
  }
  setInterval(() => { $('clock').textContent = `${U.fmtLocal(k.now(), k.tzMin, false)} UTC${U.tzString(k.tzMin)} · ${k.hostname}`; }, 1000);

  $('bDemo').onclick = () => { runLine('demo tour'); input.focus(); };
  $('bTest').onclick = () => { runLine('selftest'); input.focus(); };
  $('bReset').onclick = () => runLine('reset');

  function welcome() {
    print('Asscat demo on a mock unix-like OS. Nothing here touches your real disk; state lives in this browser tab (localStorage).', 'note');
    print('Type "help" for shell commands, "asscat help" for the app, "demo" for guided walkthroughs (run them in order), "selftest" for the spec\'s 22 acceptance tests.', 'note');
    print('The right pane is an independent file browser: drag rows onto folders to move, double-click a file to edit it, plug in disks in the sidebar.', 'note');
  }
  const restored = boot(false);
  welcome();
  if (restored) print('(restored previous state — "reset" to start over)', 'err');
  render();
})();
