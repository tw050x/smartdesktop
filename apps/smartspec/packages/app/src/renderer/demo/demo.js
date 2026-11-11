import { startApp } from '../app-shell.js';
import { createDemoApi } from './demo-api.js';
import { createDirector } from './director.js';
import { mirrorHover } from './hover.js';

// The website demo: the app’s own interface (app-shell.js) working through a stand-in API, played
// scene by scene. The site shows it in an iframe (so its styles stay its own) and moves through
// the scenes as its story scrolls, through window.demo. On its own it plays the scenes in turn.
const api = createDemoApi();
// The chat opens in a window of its own, as the site shows it (see app-shell.js).
try {
  localStorage.setItem('chat-in-window', '1');
} catch {}
startApp(api);
mirrorHover();
const director = createDirector({ api });
window.demo = director;

if (window.parent === window) {
  (async () => {
    for (let i = 0; ; i = (i + 1) % director.scenes.length) {
      await director.show(director.scenes[i]);
      director.start();
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  })();
}

