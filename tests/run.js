// node tests/run.js [test-number]  — runs the spec's acceptance scenarios headlessly
const fs = require('fs'), path = require('path'), vm = require('vm');
for (const f of ['util', 'os', 'gen', 'asscat', 'selftest'])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', f + '.js'), 'utf8'), { filename: f + '.js' });
const r = globalThis.Selftest.run(s => console.log(s), process.argv[2]);
for (const [n, e] of r.failures) console.error(`\n${n}\n${e.stack}`);
process.exit(r.fail ? 1 : 0);
