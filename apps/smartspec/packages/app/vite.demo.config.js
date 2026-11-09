import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Builds the website demo (src/renderer/demo.html: the app's interface with a stand-in API and a
// script) into the site, where its pages show it. The app's own store runs in it, over files held in
// memory: the Node modules it uses are swapped for the demo's (src/renderer/demo/node).
const shim = (name) => fileURLToPath(new URL(`src/renderer/demo/node/${name}.js`, import.meta.url));
export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      'node:fs/promises': shim('fs'),
      'node:path': shim('path'),
      'node:crypto': shim('crypto'),
      'node:events': shim('events'),
    },
  },
  build: {
    outDir: '../../../../site/demo',
    emptyOutDir: true,
    rollupOptions: { input: { demo: 'src/renderer/demo.html' } },
  },
});
