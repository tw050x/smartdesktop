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
        // A question asked in a window of its own (main/confirm.js).
        confirm: 'src/renderer/confirm.html',
        // The chat, floating in a window of its own (main.js, chat-window.js).
        chat: 'src/renderer/chat.html',
      },
    },
  },
});
