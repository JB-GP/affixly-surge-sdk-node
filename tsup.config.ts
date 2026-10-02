import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Inject the package version from package.json at build time (D03): the
// published bundle's `version` export is generated from the single source of
// truth, never hand-copied into src.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  splitting: false,
  external: ['@anthropic-ai/sdk', 'openai', '@google/genai'],
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
});
