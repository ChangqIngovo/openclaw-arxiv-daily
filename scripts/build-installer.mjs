import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
// An explicit allowlist keeps credentials, local runtime state and node_modules out.
const names = ['package.json', 'package-lock.json', 'openclaw.plugin.json', 'README.md', 'LICENSE',
  'CONTRIBUTING.md', '.gitignore', '.gitattributes', 'config.example.json', 'upgrade-manifests.json',
  'scripts/build-installer.mjs', 'installer-template.cjs', 'configure-zotero.ps1', 'zotero-callback.html', 'ZOTERO.md', '.nojekyll', 'install.sh', 'install.ps1', 'MODEL_SETUP.md', 'DETAILS.md',
  ...(await readdir(join(root, 'src'))).filter(n => n.endsWith('.js')).sort().map(n => `src/${n}`),
  ...(await readdir(join(root, 'test'))).filter(n => n.endsWith('.test.js')).sort().map(n => `test/${n}`)];
const files = [];
for (const name of names) {
  const bytes = await readFile(join(root, name));
  files.push({name, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64')});
}
const template = await readFile(join(root, 'installer-template.cjs'), 'utf8');
const marker = '__ARXIV_PAYLOAD__';
if (template.split(marker).length !== 2) throw new Error('Expected exactly one payload marker.');
const output = template.replace(marker, JSON.stringify(files));
const destination = join(root, 'install-arxiv-daily.cjs');
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw new Error('Installer is out of date. Run npm run build:installer.');
  console.log('Bundled installer matches the source files.');
} else {
  await writeFile(destination, output);
  console.log(`Built install-arxiv-daily.cjs from ${files.length} reviewed source files.`);
}
