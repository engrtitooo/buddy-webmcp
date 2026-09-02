import { readFile } from 'node:fs/promises';

const configuredUrl = process.env.BUDDY_API_BASE_URL?.trim() || 'https://api.example.com';
const expectedUrl = new URL(configuredUrl);
if (expectedUrl.protocol !== 'https:') throw new Error('Expected production API URL must use HTTPS.');
const expectedPermissions = [`${expectedUrl.origin}/*`];
const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'));
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Unexpected production host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
}
console.log('Production extension manifest uses only the expected API origin.');
