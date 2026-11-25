const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const adapter = 'node_modules/@deepseek-ai/libreoffice-kit';
const native = 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64';
const officeVersion = '0.2.3';

function stageOffice(root, target, packages) {
  const engine = path.join(root, native);
  const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'prebuilds.json'), 'utf8'));
  if (manifest.version !== officeVersion || packages[adapter]?.version !== officeVersion ||
    packages[native]?.version !== officeVersion || manifest.platform !== 'win32-x64' || manifest.status !== 'built') {
    throw new Error('Unexpected Windows LibreOffice Kit version or platform');
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(engine, relative);
    if (!file.startsWith(engine + path.sep) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) {
      throw new Error('Windows LibreOffice Kit asset verification failed');
    }
  }
  const required = new Set();
  function include(name) {
    if (required.has(name)) return;
    const entry = packages[name];
    if (!entry) throw new Error('Office dependency missing from package-lock');
    required.add(name);
    for (const dependency of Object.keys(entry.dependencies || {})) {
      let owner = name;
      while (owner && !packages[owner + '/node_modules/' + dependency]) {
        const outer = owner.lastIndexOf('/node_modules/');
        owner = outer < 0 ? '' : owner.slice(0, outer);
      }
      include((owner ? owner + '/' : '') + 'node_modules/' + dependency);
    }
  }
  include(adapter);
  include(native);
  // The SDK's Windows pipe launcher uses this optional addon at runtime.
  include('node_modules/koffi');
  include('node_modules/@koromix/koffi-win32-x64');
  for (const name of required) {
    const source = path.join(root, name);
    fs.cpSync(source, path.join(target, name), {
      recursive: true, filter: file => file === source || path.basename(file) !== 'node_modules'
    });
  }
  console.log('Verified Windows x64 LibreOffice Kit ' + officeVersion + ' asset hashes, bundled sources and notices');
}

module.exports = { officeVersion, stageOffice };
