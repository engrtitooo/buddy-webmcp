import { existsSync } from 'node:fs';
import { sites } from '@openai/sites-vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), ...(existsSync(new URL('.openai/hosting.json', import.meta.url)) ? [sites()] : [])],
  server: { port: 5173 },
  build: { target: 'chrome149' },
});
