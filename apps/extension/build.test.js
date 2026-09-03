import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApiUrl } from './build.mjs';

const railway = 'https://buddy-mcp-production.up.railway.app';
afterEach(() => vi.unstubAllEnvs());

describe('extension build configuration', () => {
  it('defaults development to localhost and production to Railway, including blank overrides', () => {
    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('BUDDY_API_BASE_URL', value);
      expect(resolveApiUrl(false).origin).toBe('http://127.0.0.1:8787');
      expect(resolveApiUrl(true).origin).toBe(railway);
    }
  });

  it('accepts an explicit trimmed HTTPS override in both modes', () => {
    vi.stubEnv('BUDDY_API_BASE_URL', '  https://custom.example/api/  ');
    expect(resolveApiUrl(true).href).toBe('https://custom.example/api/');
    expect(resolveApiUrl(false).href).toBe('https://custom.example/api/');
  });

  it.each([
    'http://api.example', 'http://127.0.0.1:8787', 'https://127.0.0.1', 'https://127.1',
    'https://127.2.3.4', 'https://2130706433', 'https://0x7f000001', 'https://localhost',
    'https://LOCALHOST.', 'https://api.localhost', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'ftp://example.com', 'https://user:password@example.com', 'https://example.com/?token=secret',
    'https://example.com/#token', 'invalid',
  ])('fails closed for unsafe production override %s', (value) => {
    vi.stubEnv('BUDDY_API_BASE_URL', value);
    expect(() => resolveApiUrl(true)).toThrow();
  });

  it('generates matching destinations and least-privilege permissions in real builds', () => {
    const env = { ...process.env };
    delete env.BUDDY_API_BASE_URL;
    const run = (mode, override) => {
      execFileSync(process.execPath, ['apps/extension/build.mjs', `--mode=${mode}`], {
        env: { ...env, ...(override ? { BUDDY_API_BASE_URL: override } : {}) }, stdio: 'pipe',
      });
      return {
        manifest: JSON.parse(readFileSync('apps/extension/dist/manifest.json', 'utf8')),
        background: readFileSync('apps/extension/dist/background.js', 'utf8'),
      };
    };
    const development = run('development');
    expect(development.manifest.host_permissions).toEqual(['http://127.0.0.1:8787/*']);
    expect(development.background).toContain('http://127.0.0.1:8787');
    expect(run('production', 'https://custom.example').manifest.host_permissions).toEqual(['https://custom.example/*']);
    const production = run('production');
    expect(production.manifest.host_permissions).toEqual([`${railway}/*`]);
    expect(production.background).toContain(railway);
    execFileSync(process.execPath, ['apps/extension/verify-production-manifest.mjs'], { env, stdio: 'pipe' });
    const invalid = spawnSync(process.execPath, ['apps/extension/build.mjs', '--mode=production'], {
      env: { ...env, BUDDY_API_BASE_URL: 'https://localhost' }, encoding: 'utf8',
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('must not use localhost');
    // Failed builds validate before touching the last known good bundle.
    expect(readFileSync('apps/extension/dist/background.js', 'utf8')).toBe(production.background);
    expect(spawnSync(process.execPath, ['apps/extension/build.mjs', '--mode=prod'], { env }).status).not.toBe(0);
  }, 120_000);
});
