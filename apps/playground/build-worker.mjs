import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(new URL('./dist/server/', import.meta.url));
const assetsDirectory = fileURLToPath(new URL('./dist/assets/', import.meta.url));
const indexPath = fileURLToPath(new URL('./dist/index.html', import.meta.url));
await mkdir(outputDirectory, { recursive: true });

const embeddedAssets = {
  '/index.html': {
    body: await readFile(indexPath, 'utf8'),
    type: 'text/html; charset=utf-8',
  },
};

for (const filename of await readdir(assetsDirectory)) {
  embeddedAssets[`/assets/${filename}`] = {
    body: await readFile(fileURLToPath(new URL(`./dist/assets/${filename}`, import.meta.url)), 'utf8'),
    type: filename.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/javascript; charset=utf-8',
  };
}

const worker = `const assets = ${JSON.stringify(embeddedAssets)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/index.html';
    let asset = assets[pathname];
    if (!asset && request.method === 'GET' && !pathname.includes('.')) {
      asset = assets['/index.html'];
    }
    if (!asset || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: {
        'content-type': asset.type,
        'cache-control': pathname === '/index.html'
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      },
    });
  },
};
`;

await writeFile(
  fileURLToPath(new URL('./dist/server/index.js', import.meta.url)),
  worker,
);
