#!/usr/bin/env node
// Keeps extension/sync.js identical to the shared core, then zips the folder
// for loading or upload.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'shared/sync.js'), path.join(root, 'extension/sync.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));

function extensionIdFromKey(b64) {
  if (!b64) return '';
  const hex = require('crypto').createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

fs.writeFileSync(
  path.join(root, 'web', 'version.json'),
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    zip: '/duet-extension.zip',
    id: extensionIdFromKey(manifest.key),
    installDir: '~/Library/Application Support/Duet/extension',
  }, null, 2) + '\n'
);

const out = path.join(root, 'duet-extension.zip');
const webOut = path.join(root, 'web', 'duet-extension.zip');
try {
  execSync(`cd "${path.join(root, 'extension')}" && zip -qr "${out}" .`);
  fs.copyFileSync(out, webOut);
  console.log(`Built ${out} (v${manifest.version})`);
  console.log(`Hosted copy ${webOut}`);
} catch {
  console.log('Copied shared/sync.js into extension/. (zip not installed — load the folder unpacked instead.)');
}
