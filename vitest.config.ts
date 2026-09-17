import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Deliberately separate from vite.config.ts: the build roots at web/, but the tests
// live at tests/ and reach into web/src/.
export default defineConfig({
  root: __dirname,
  resolve: { alias: { '@': resolve(__dirname, 'web/src') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
