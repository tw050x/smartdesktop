import { defineConfig } from 'vite';

// Builds the website demo (src/renderer/demo.html: the app's interface with a stand-in API and a
// script) into the site, where the hero shows it. The site's workflow runs this before publishing.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../../../site/demo',
    emptyOutDir: true,
    rollupOptions: { input: { demo: 'src/renderer/demo.html' } },
  },
});
