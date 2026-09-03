import { build, context } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCTION_API_URL =
  'https://buddy-mcp-production.up.railway.app';
const DEVELOPMENT_API_URL =
  'http://127.0.0.1:8787';

export function resolveApiUrl(production) {
  const apiBaseUrl =
    process.env.BUDDY_API_BASE_URL?.trim() ||
    (production ? PRODUCTION_API_URL : DEVELOPMENT_API_URL);
  const apiUrl = new URL(apiBaseUrl);
  const hostname = apiUrl.hostname.toLowerCase().replace(/\.$/, '');
  // URL parsing canonicalizes shortened, integer, and hex IPv4 loopback aliases.
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    /^127\./.test(hostname) || hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname);
  if (production && (apiUrl.protocol !== 'https:' || loopback)) {
    throw new Error('Production BUDDY_API_BASE_URL must use HTTPS and must not use localhost or loopback addresses.');
  }
  if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error('BUDDY_API_BASE_URL must be an HTTP(S) URL.');
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error('BUDDY_API_BASE_URL must not contain credentials, a query, or a fragment.');
  }
  return apiUrl;
}

async function main() {
  const root = resolve(import.meta.dirname);
  const outdir = resolve(root, 'dist');
  const watch = process.argv.includes('--watch');
  const modeIndex = process.argv.indexOf('--mode');
  const inlineMode = process.argv.find((argument) => argument.startsWith('--mode='));
  const mode = inlineMode?.slice('--mode='.length) ?? (modeIndex >= 0 ? process.argv[modeIndex + 1] : 'development');
  if (!['development', 'production'].includes(mode)) throw new Error('Build mode must be development or production.');
  const apiUrl = resolveApiUrl(mode === 'production');
  // This fixed directory is resolved beneath the extension workspace; validate before replacing it.
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(root, 'public/manifest.json'), 'utf8'));
  manifest.host_permissions = [`${apiUrl.origin}/*`];
  await writeFile(resolve(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const options = {
    entryPoints: { content: resolve(root, 'src/content.tsx'), background: resolve(root, 'src/background.ts') },
    bundle: true, outdir, format: 'iife', target: 'chrome149', minify: !watch,
    sourcemap: watch ? 'inline' : false, legalComments: 'none',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'text' },
    define: { __BUDDY_API_BASE_URL__: JSON.stringify(apiUrl.href.replace(/\/$/, '')) },
  };
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('Buddy extension is rebuilding on changes.');
  } else await build(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
