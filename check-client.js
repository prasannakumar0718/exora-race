'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('No inline game script found in index.html');
for (let i = 0; i < scripts.length; i++) new vm.Script(scripts[i][1], { filename: `index.html:inline-script-${i + 1}` });
console.log(`PASS: syntax checked ${scripts.length} inline browser script(s)`);
