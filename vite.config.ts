import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The built bundle lands in assignment_helper/static/, NOT dist/ —
// .gitignore ignores dist/, and the wheel must carry the bundle.
export default defineConfig({
  root: resolve(__dirname, 'web'),
  resolve: { alias: { '@': resolve(__dirname, 'web/src') } },
  build: {
    outDir: resolve(__dirname, 'assignment_helper/static'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
});
