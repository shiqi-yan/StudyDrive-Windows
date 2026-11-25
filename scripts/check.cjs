const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const directory of ['src', 'scripts', 'tests']) {
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    if (!/\.(c|m)js$/.test(entry)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, entry)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checked');
