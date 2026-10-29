import { defineConfig } from 'vite';

// Builds the window's interface (src/renderer) into build/renderer, loaded from disk by Electron.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../build/renderer',
    emptyOutDir: true,
  },
});
