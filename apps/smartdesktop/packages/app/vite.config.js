import { defineConfig } from 'vite';

// Builds the windows' interfaces (src/renderer) into build/renderer, loaded from disk by Electron:
// the chat, the AI setup, the settings and the app windows' top bar.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../build/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        chat: 'src/renderer/chat.html',
        setup: 'src/renderer/setup.html',
        settings: 'src/renderer/settings.html',
        // An app window's top bar (see app-windows.js).
        app: 'src/renderer/app.html',
      },
    },
  },
});
