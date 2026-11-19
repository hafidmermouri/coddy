import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  define: { __SPEC_VERSION__: JSON.stringify(readFileSync('spec/VERSION', 'utf8').trim()) },
  build: {
    lib: { entry: 'src/extension.ts', formats: ['cjs'], fileName: () => 'extension.js' },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: 'node20',
    rollupOptions: { external: ['vscode', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)] },
  },
});
