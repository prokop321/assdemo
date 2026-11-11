// node tests/builder.js — every builder command composes to a line the shell tokenizer reads back correctly
const fs = require('fs'), path = require('path'), vm = require('vm');
for (const f of ['util', 'os', 'gen', 'asscat', 'shell', 'demos', 'builder'])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.js'), 'utf8'), { filename: f + '.js' });
const { compose, commands } = Builder; let bad = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { bad++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } };
const cmd = c => commands.find(x => x.c === c);
const toks = line => Shell.tokenize(line).map(t => t.op || t.w);
let r = compose(cmd('asscat tag add'), { key: 'klient', val: 'Qila "Q" \\n', sel: { mode: 'paths', value: 'Den 3 pláž/, a.jpg' }, yes: true });
check('tag add', toks(r.line), ['asscat', 'tag', 'add', 'klient', 'Qila "Q" \\n', 'Den 3 pláž/', 'a.jpg', '--yes']);
r = compose(cmd('asscat tag add'), { key: 'k', val: 'v', sel: { mode: 'view', value: 'klienti', folder: 'Qila/2026' } });
check('view selector', toks(r.line), ['asscat', 'tag', 'add', 'k', 'v', '--view', 'klienti', '--folder', 'Qila/2026']);
check('required', compose(cmd('asscat tag add'), { key: '', val: 'v', sel: { mode: 'paths', value: 'a' } }).error, '"key" is required');
r = compose(cmd('asscat view set'), { name: 'v', tpl: '{klient}/{rok}', f: 'druh=foto, klient=qila', none: 'klient=bez klienta' });
check('view set', toks(r.line), ['asscat', 'view', 'set', 'v', '{klient}/{rok}', '--filter', 'druh=foto', '--filter', 'klient=qila', '--none', 'klient=bez klienta']);
r = compose(cmd('asscat materialize'), { name: 'v', rc: false, ap: true, cr: '3' });
check('crash-after first', toks(r.line), ['asscat', '--crash-after', '3', 'materialize', 'v', '--apply']);
r = compose(cmd('asscat setting set'), { key: 'edge.same_path', v: '"ask"' });
check('json value', toks(r.line), ['asscat', 'setting', 'set', 'edge.same_path', '"ask"']);
r = compose(cmd('asscat shoots'), { r: '2h', m: '3', o: '/tmp/p.json' });
check('redirect', toks(r.line), ['asscat', 'shoots', '2h', '3', '>', '/tmp/p.json']);
r = compose(cmd('disk create'), { n: 'CARD', fs: 'msdos', card: true });
check('disk create', toks(r.line), ['disk', 'create', 'CARD', '--fs', 'msdos', '--card']);
check('tilde', compose(cmd('cd'), { p: '~/My Pics' }).line, 'cd ~/"My Pics"');
check('tilde expands', new Shell.Shell(new OS.Kernel(), {}).exec('true') >= 0 && Shell.tokenize('a ~/"My Pics" "~/x"').map(t => [t.w, !!t.tilde]), [['a', false], ['~/My Pics', true], ['~/x', false]]);
// end to end: builder lines run in the shell exactly like typed ones
const k = new OS.Kernel({ start: Date.parse('2026-11-11T13:00:00Z') * 1e6 }); const out = [];
const sh = new Shell.Shell(k, { out: s => out.push(s), err: s => out.push('ERR ' + s) });
const run = (c, v) => { const x = compose(cmd(c), v); if (x.error) throw new Error(x.error); const code = sh.exec(x.line); if (code) { bad++; console.log('FAIL exit', code, x.line, out.slice(-2)); } };
run('mkdir -p', { p: '~/Pictures/K' }); run('cd', { p: '~/Pictures/K' }); run('asscat library open', { dir: '~/Pictures/K' });
run('genphotos', { d: 'Den 3 pláž', n: '3', s: '2026-08-07 10:00', e: '2m' });
run('asscat library open', { dir: '.' });
run('asscat tag add', { key: 'klient', val: 'Qila', sel: { mode: 'paths', value: 'Den 3 pláž/' }, yes: true });
run('asscat view set', { name: 'v', tpl: '{klient}/{rok}' });
run('asscat materialize', { name: 'v', ap: true });
check('moved', k.readdir('/Users/prokop/Pictures/K/Qila/2026'), ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG']);
console.log(`${commands.length} commands in the builder, ${bad ? bad + ' failure(s)' : 'all checks passed'}`);
process.exit(bad ? 1 : 0);
