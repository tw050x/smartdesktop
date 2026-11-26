import { startChatWindow } from '../chat-window.js';
import { makeCursor, mirrorHover } from './hover.js';

// The website demo's chat window: the app's own (chat-window.js), floating beside the demo's app
// window as it does beside the app's. The demo (demo.js) starts it with its stand-in API, once both
// have loaded, and its director drives it as it does the app's window: its own cursor, drawn here,
// shows while the director's cursor is over this window.
window.startChat = (api) => {
  startChatWindow(api);
  mirrorHover();
  window.demoCursor = makeCursor();
};
