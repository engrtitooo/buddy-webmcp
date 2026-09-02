import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Realtime client credential boundary', () => {
  it('keeps the standard OpenAI key name out of every browser source', () => {
    const browserSources = [
      'apps/extension/src/background.ts',
      'apps/extension/src/content.tsx',
      'apps/extension/src/realtime-provider.ts',
      'packages/buddy-ui/src/index.tsx',
      'packages/buddy-ui/src/realtime.ts',
      'apps/extension/public/manifest.json',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(browserSources).not.toContain('OPENAI_API_KEY');
    expect(browserSources).not.toMatch(/authorization\s*:\s*[`'"]Bearer/i);
  });
});
