// node tests/demos.js [demo…] — runs the guided demos headlessly and prints the transcript
const fs = require('fs'), path = require('path'), vm = require('vm');
for (const f of ['util', 'os', 'gen', 'asscat', 'selftest', 'shell', 'demos'])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.js'), 'utf8'), { filename: f + '.js' });
const k = new OS.Kernel({ start: Date.parse('2026-11-11T13:00:00Z') * 1e6 });
const sh = new Shell.Shell(k, { out: s => console.log(s), err: s => console.log('[stderr] ' + s) });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(Demos);
let bad = 0;
for (const n of names) for (const step of Demos[n].steps) {
  if (step.startsWith('#')) { console.log('\n' + step); continue; }
  console.log(`\n${sh.prompt()} ${step}`);
  const code = sh.exec(step); k.advance(2e9);
  if (code) { console.log(`[exit ${code}]`); bad++; }
}
console.log(`\n${bad} command(s) exited non-zero`);
