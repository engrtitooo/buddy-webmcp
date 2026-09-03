import { readFile } from 'node:fs/promises';
import { resolveApiUrl } from './build.mjs';

const expectedUrl = resolveApiUrl(true);
const expectedPermissions = [`${expectedUrl.origin}/*`];
const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Unexpected production host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
}
for (const file of ['background.js', 'content.js', 'manifest.json']) {
  const source = await readFile(new URL(`./dist/${file}`, import.meta.url), 'utf8');
  if (/localhost|127\.0\.0\.1/i.test(source)) throw new Error(`Development address found in production ${file}.`);
  if (file === 'background.js' && !source.includes(expectedUrl.href.replace(/\/$/, ''))) {
    throw new Error('Production service worker does not contain the expected API URL.');
  }
}
console.log('Production extension uses only the expected API origin and contains no localhost references.');
