import { startApp } from '../app-shell.js';
import { createDemoApi } from './demo-api.js';
import { createDirector } from './director.js';
import { mirrorHover } from './hover.js';

// The website demo: the app's own interface (app-shell.js) working through a stand-in API, played
// scene by scene. The site shows it in an iframe (so its styles stay its own) and moves through
// the scenes as its story scrolls, through window.demo. On its own it plays the scenes in turn.
//
// The chat floats in a window of its own beside it, as in the app: demo-chat.html, in a frame the
// site places beside the window's right edge (window.demo.attachChat). On its own, the demo puts
// that frame over its own right side.
const api = createDemoApi();
startApp(api);
mirrorHover();
const director = createDirector({ api });
window.demo = director;

if (window.parent === window) {
  const frame = Object.assign(document.createElement('iframe'), { className: 'demo-own-chat', src: 'demo-chat.html', title: 'Chat' });
  const place = { x: 1280 - 400 - 16, y: 64, width: 400, height: 680 };
  Object.assign(frame.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` });
  document.body.append(frame);
  api.onChatShown((on) => frame.classList.toggle('shown', on));
  frame.addEventListener('load', async () => {
    await director.attachChat(frame.contentWindow, place);
    for (let i = 0; ; i = (i + 1) % director.scenes.length) {
      await director.show(director.scenes[i]);
      await director.start();
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  });
}
