// SmartDoc's side of SmartDesktop, the app that runs the AI chat for SmartDoc and SmartSpec (its
// own repo, tw050x/smartdesktop). SmartDoc connects to it (its hub.js) when it's running, says
// hello with SmartDoc's MCP server (so the chat's AI can use SmartDoc's tools), and then tells it
// about its windows (what each shows, which has the focus, lines of context for the chat, the
// shortcuts to offer) with messages; it hears back over a stream what the chat asks of SmartDoc (an
// action in a window, the chat opening or closing, which chat owns which tab: `{ type: 'owners', tabs:
// { <tab id>: { chat, title } } }`). SmartDesktop is started when the chat is asked
// for and isn't running. A development build connects to SmartDesktop's development build (its own
// data folder, SmartDesktop Dev), an installed one to the installed one.
//
// The same in both apps (SmartSpec's desktop.js; keep the two alike), apart from the app's name.
const APP = 'smartdoc';
const NAME = 'SmartDoc';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOOK_EVERY_MS = 5000; // while not connected, how often to look for SmartDesktop
const START_WAIT_MS = 15000; // how long to wait for SmartDesktop to start

// `appData` is where apps keep their data (SmartDesktop's folder is in it); `packaged` whether this
// is an installed build; `mcp()` SmartDoc's MCP server ({ url, token }) once it runs; `version`
// SmartDoc's. `onEvent(event)` hears what the chat asks; `onStatus(status)` where the connection
// stands: 'connected', 'starting', 'off' (not running) or 'missing' (not installed).
export function createDesktop({ appData, packaged, version, mcp, onEvent = () => {}, onStatus = () => {} }) {
  const folder = process.env.SMARTDESKTOP_USER_DATA ?? path.join(appData, packaged ? 'SmartDesktop' : 'SmartDesktop Dev');
  let link = null; // { base, token, client, stream }
  // An installed SmartDoc looks for SmartDesktop where apps are installed, to say if it's missing
  // (it's then looked for again whenever SmartDoc tries to start it).
  const installed = () => !packaged || ['/Applications', path.join(os.homedir(), 'Applications')].some((dir) => existsSync(path.join(dir, 'SmartDesktop.app')));
  let status = installed() ? 'off' : 'missing';
  let connecting = null;
  // What SmartDesktop is told again whenever SmartDoc connects (it may have started since, or
  // restarted): each window's last 'window' message, and the window with the focus.
  const windows = new Map(); // window id → the last 'window' message for it
  let focused = null; // { windowId, bounds }
  // The tabs a SmartDesktop session (a chat's AI) has taken: tab id → session id. Each makes that
  // tab its chat's (see SmartDesktop's notes), so SmartDesktop is told again whenever it connects.
  const held = new Map();

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus(status);
  };

  async function where() {
    const { port, token } = JSON.parse(await readFile(path.join(folder, 'connect.json'), 'utf8'));
    const base = `http://127.0.0.1:${port}`;
    const who = await (await fetch(`${base}/whoami`, { signal: AbortSignal.timeout(2000) })).json();
    if (who.app !== 'SmartDesktop') throw new Error('Not SmartDesktop');
    return { base, token };
  }

  // Connects if SmartDesktop is running (and SmartDoc's server is): hello, the stream, and
  // everything it should know.
  function connect() {
    if (link) return Promise.resolve(true);
    connecting ??= (async () => {
      const server = mcp();
      if (!server) return false;
      let found;
      try {
        found = await where();
      } catch {
        return false;
      }
      const headers = { authorization: `Bearer ${found.token}`, 'content-type': 'application/json' };
      const hello = await fetch(`${found.base}/hello`, { method: 'POST', headers, body: JSON.stringify({ app: APP, name: NAME, version, mcp: server }) });
      if (!hello.ok) return false;
      const { client } = await hello.json();
      const controller = new AbortController();
      const events = await fetch(`${found.base}/events?client=${client}`, { headers, signal: controller.signal });
      if (!events.ok) return false;
      link = { ...found, headers, client, controller };
      setStatus('connected');
      listen(events.body, link);
      for (const message of windows.values()) await post(message);
      for (const [windowId, session] of held) await post({ type: 'session-tab', windowId, session });
      if (focused) await post({ type: 'focus', ...focused });
      return true;
    })().catch(() => false).finally(() => (connecting = null));
    return connecting;
  }

  // The stream of what the chat asks: events, each a line of JSON after `data: `. When it ends,
  // SmartDesktop has gone (quit or restarted).
  async function listen(body, mine) {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          try {
            onEvent(JSON.parse(data));
          } catch {}
        }
      }
    } catch {}
    if (link === mine) {
      link = null;
      setStatus('off');
    }
  }

  async function post(message) {
    if (!link) return null;
    try {
      const res = await fetch(`${link.base}/message`, { method: 'POST', headers: link.headers, body: JSON.stringify({ client: link.client, ...message }), signal: AbortSignal.timeout(5000) });
      if (res.status === 404) {
        // SmartDesktop restarted and doesn't know SmartDoc: connect again (which tells it everything).
        link.controller.abort();
        link = null;
        await connect();
        return null;
      }
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }

  // Starts SmartDesktop (in the background, so the app keeps the focus) and waits for it to be
  // ready. An installed SmartDoc opens the installed SmartDesktop by its bundle id; a development
  // build starts SmartDesktop's development build from SMARTDESKTOP_DEV_DIR (its packages/app
  // folder) if that's set.
  async function start() {
    if (link) return true;
    if (await connect()) return true;
    setStatus('starting');
    let launched;
    if (packaged) {
      if (!installed()) {
        setStatus('missing');
        return false;
      }
      launched = await new Promise((resolve) => {
        const child = spawn('/usr/bin/open', ['-g', '-b', 'com.tw050x.smartdesktop'], { stdio: 'ignore' });
        child.on('exit', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    } else if (process.env.SMARTDESKTOP_DEV_DIR) {
      const dir = path.resolve(process.env.SMARTDESKTOP_DEV_DIR);
      const child = spawn(path.join(dir, '../../node_modules/.bin/electron'), ['.'], { cwd: dir, detached: true, stdio: 'ignore' });
      child.unref();
      launched = true;
    } else launched = false;
    if (!launched) {
      setStatus(installed() ? 'off' : 'missing');
      return false;
    }
    for (const until = Date.now() + START_WAIT_MS; Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (await connect()) return true;
    }
    setStatus('off');
    return false;
  }

  // While not connected, it keeps looking, so SmartDoc connects as soon as SmartDesktop starts.
  setInterval(() => !link && status !== 'starting' && connect(), LOOK_EVERY_MS).unref?.();

  return {
    get status() {
      return status;
    },
    // Whether SmartDesktop is on this Mac (an installed build looks where apps are installed, each
    // time it's asked, so one installed since counts).
    installed,
    connect,
    start,
    // What a window shows ({ shows: { key, text, detail }, title, hint, shortcuts, home }), kept to
    // tell SmartDesktop again whenever it connects. `home: true` marks a Home tab, whose events go to
    // no chat.
    window(windowId, changes) {
      const message = { ...(windows.get(windowId) ?? { type: 'window', windowId }), ...changes };
      windows.set(windowId, message);
      return post({ type: 'window', windowId, ...changes });
    },
    focus(windowId, bounds) {
      focused = { windowId, bounds };
      return post({ type: 'focus', windowId, bounds });
    },
    blur(windowId) {
      if (focused?.windowId === windowId) focused = null;
      return post({ type: 'blur', windowId });
    },
    closed(windowId) {
      windows.delete(windowId);
      held.delete(windowId);
      if (focused?.windowId === windowId) focused = null;
      return post({ type: 'closed', windowId });
    },
    // A SmartDesktop session (`smartdesktop-<chat id>`) took this tab: it becomes that chat's.
    sessionTab(windowId, session) {
      if (held.get(windowId) === session) return null;
      held.set(windowId, session);
      return post({ type: 'session-tab', windowId, session });
    },
    // A line of context for the chat (see note in SmartDesktop's agent.js); only while connected.
    note: (windowId, note) => post({ type: 'note', windowId, note }),
    // The chat: opened, closed or toggled ('toggle') from a window's chat button, starting
    // SmartDesktop if need be; and a request for the AI (the chat sends it, or puts it in its box).
    async chat(windowId, open) {
      if (open !== false && !(await start())) return { chatOpen: false };
      return post({ type: 'chat', windowId, open });
    },
    async ask(windowId, text) {
      if (!(await start())) return null;
      return post({ type: 'ask', windowId, text });
    },
  };
}
