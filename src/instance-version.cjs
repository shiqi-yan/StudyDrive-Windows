const fs = require('node:fs');
const path = require('node:path');

const valid = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
const marker = profile => path.join(profile, 'instance-version.json');

function recordInstance(profile, version) {
  try {
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(marker(profile), JSON.stringify({ version, pid: process.pid }));
  } catch { /* The lock still protects the profile if its version cannot be recorded. */ }
}

function runningVersion(profile) {
  try {
    const { version, pid } = JSON.parse(fs.readFileSync(marker(profile), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !valid(version)) return '';
    process.kill(pid, 0);
    return version;
  } catch { return ''; }
}

module.exports = { recordInstance, runningVersion };
