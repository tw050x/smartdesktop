import { defineConfig } from 'vite';

// Builds the windows' interfaces (src/renderer) into build/renderer, loaded from disk by Electron:
// the chat, the AI setup and the settings.
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
      },
    },
  },
});
