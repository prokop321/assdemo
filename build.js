// node build.js  -> dist/asscat-demo.html (one self-contained file, scripts inlined)
const fs = require('fs'), path = require('path');
let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
html = html.replace(/<script src="(src\/[^"]+)"><\/script>/g, (_, f) =>
  '<script>\n' + fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'asscat-demo.html'), html);
console.log('dist/asscat-demo.html', (html.length / 1024).toFixed(0) + ' KB');
