import { defineConfig } from 'vite';

// Builds the windows' interfaces (src/renderer) into build/renderer, loaded from disk by Electron.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../build/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'src/renderer/index.html',
        tabs: 'src/renderer/tabs.html',
      },
    },
  },
});
