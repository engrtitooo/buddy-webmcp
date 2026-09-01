import { readFile } from 'node:fs/promises';

const expectedPermissions = ['https://api.example.com/*'];
const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Unexpected production host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
}
console.log('Production extension manifest uses only the expected API origin.');
