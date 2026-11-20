import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Webview bundle: dist/webview.js + dist/webview.css, loaded by src/panel.ts.
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: 'src/webview/main.tsx', formats: ['iife'], name: 'coddy', fileName: () => 'webview.js', cssFileName: 'webview' },
  },
});
