// The app's status, first in the top bar after the traffic lights: a pill saying whether SmartDoc
// is ready to work with an AI: Ready (green) once its server is running and at least one AI is
// installed and signed in, Set up your AI (amber) while none is, Starting… (amber) and Not running
// (red) for the server. The user wanted one status for the app, not the server's alone. Clicking it dulls the window with a mask
// (leaving the pill clear) and slides in a full-height panel from the left with the AIs the chat
// runs (installing and signing in), the server's details and, folded away, how to connect another
// AI app by hand. Connect an AI in the menu opens it too. The panel's drag handle, at its right
// edge, resizes it, and closes it when dragged below the minimum width.

import { arrowKeysIn } from './menu-keys.js';
import { clearAiProgress, failureText, progressLine, progressMark, trackAiProgress } from './ai-progress.js';

const PANEL_MIN = 300;
const PANEL_MAX_SHARE = 0.66;
const panelMax = () => Math.max(PANEL_MIN, window.innerWidth * PANEL_MAX_SHARE);

const copyIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9,18q-0.82,0-1.41-0.59T7,16V4Q7,3.17 7.59,2.59T9,2h9q0.82,0 1.41,0.59T20,4V16q0,0.82-0.59,1.41T18,18H9Zm0-2h9V4H9V16ZM5,22q-0.83,0-1.41-0.59T3,20V6H5V20H16v2H5Zm4-6V4V16Z"/></svg>';
const copiedIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// The pill's short label, and its tooltip saying what it's about.
const LABELS = { starting: 'Starting…', running: 'Ready', setup: 'Set up your AI', off: 'Not running' };
const TITLES = { starting: 'SmartDoc is starting', setup: 'SmartDoc’s server is running, but no AI is set up for the chat yet', off: 'SmartDoc’s server isn’t running' };
const STATES = { starting: 'Starting…', running: 'Running', off: 'Not running' };

// Why the server isn't running, for the user: what's using its port, if that's it, and what to do.
function offReason(status) {
  if (status.reason === 'port-in-use') {
    const { holder, port } = status;
    if (holder?.kind === 'smartdoc') {
      const which = holder.development ? 'A development copy of SmartDoc' : 'Another copy of SmartDoc';
      return `${which} is already open and running the server your AI connects to, so this one can’t run its own. Your AI works with that copy. Quit it and this one takes over by itself within a few seconds.`;
    }
    const who = holder?.kind === 'other' ? `Another app, ${holder.name},` : 'Another app on this Mac';
    return `${who} is using port ${port}, which SmartDoc’s server needs, so your AI can’t connect. Quit that app and SmartDoc starts its server by itself within a few seconds.`;
  }
  if (status.reason === 'error') return `The server couldn’t start: ${status.message}`;
  return 'The server couldn’t start.';
}

// Where Claude Desktop stands (see connect.js), and the button for it, if any.
const CLAUDE_DESKTOP = {
  'not-installed': { text: 'Claude Desktop isn’t on this Mac. Once it is, come back here to add SmartDoc to it.' },
  'not-added': { text: 'SmartDoc can add itself to Claude Desktop for you.', button: 'Add to Claude Desktop' },
  added: { text: 'SmartDoc is in Claude Desktop. If Claude Desktop was open, quit it and open it again to connect, then ask Claude to review your document.' },
  different: { text: 'Claude Desktop has SmartDoc set up from before (perhaps from where the app used to be).', button: 'Update Claude Desktop' },
  unreadable: { text: 'Claude Desktop’s settings file isn’t in a form SmartDoc can safely change. Add SmartDoc yourself, below.' },
};

export function createServerStatus({ api }) {
  const pill = document.getElementById('server-pill');
  const label = document.getElementById('server-pill-label');
  const mask = document.getElementById('mcp-mask');
  const card = document.getElementById('mcp-card');
  const stateEl = document.getElementById('server-state');
  const urlEl = document.getElementById('server-url');
  const off = document.getElementById('server-off');
  const offText = document.getElementById('server-off-text');
  const retry = document.getElementById('server-retry');
  const aiLabel = document.getElementById('server-pill-ai');
  const release = document.getElementById('ai-release');
  const releaseText = document.getElementById('ai-release-text');
  let status = { state: 'starting' };
  let aiName = null;
  let ais = null; // the AIs the chat runs, once known: { claude: { installed, loggedIn, … }, … }

  // The app's state: the server's, and once it's running, whether an AI is ready for the chat.
  const appState = () => {
    if (status.state !== 'running') return status.state;
    if (!ais) return 'starting';
    return Object.values(ais).some((a) => a.installed && a.loggedIn) ? 'running' : 'setup';
  };

  function render() {
    const state = appState();
    pill.dataset.state = state;
    stateEl.textContent = STATES[status.state];
    label.textContent = LABELS[state];
    const ready = Object.values(ais ?? {}).filter((a) => a.installed && a.loggedIn).map((a) => a.name);
    const base = status.state === 'off' && status.reason === 'port-in-use'
      ? (status.holder?.kind === 'smartdoc' ? 'Another copy of SmartDoc is running the server' : 'SmartDoc’s server port is in use by another app')
      : state === 'running' ? `SmartDoc is ready: ${ready.join(' and ')} ${ready.length > 1 ? 'are' : 'is'} set up for the chat` : TITLES[state];
    const title = aiName ? `${base}. ${aiName} works in this window.` : base;
    pill.title = title;
    pill.setAttribute('aria-label', title);
    urlEl.textContent = status.url ?? '—';
    off.hidden = status.state !== 'off';
    if (status.state === 'off') offText.textContent = offReason(status);
  }

  async function showSetups() {
    for (const code of card.querySelectorAll('[data-setup]')) code.textContent = await api.mcpSetup(code.dataset.setup);
  }

  const desktopState = document.getElementById('claude-desktop-state');
  const addButton = document.getElementById('add-to-claude-desktop');
  const extensionNote = document.getElementById('claude-extension-note');
  function showClaudeDesktop(desktop) {
    const shown = CLAUDE_DESKTOP[desktop.state];
    desktopState.textContent = shown.text;
    addButton.hidden = !shown.button;
    addButton.textContent = shown.button ?? '';
    extensionNote.hidden = !desktop.extension;
  }
  const refreshClaudeDesktop = () => api.claudeDesktopStatus().then(showClaudeDesktop);
  addButton.addEventListener('click', async () => {
    addButton.disabled = true;
    try {
      showClaudeDesktop(await api.addToClaudeDesktop());
    } catch (error) {
      desktopState.textContent = error.message;
    } finally {
      addButton.disabled = false;
    }
  });

  // The AIs the chat runs, each a row: its name, where it stands, and the one thing to do next.
  const aiList = document.getElementById('ai-list');
  trackAiProgress(api);
  const aiBusy = new Set(); // the AIs being installed or signed in to: each its own, at once
  const failed = {}; // provider id → why its install or sign-in didn't work, shown once
  async function showAis(statuses) {
    if (!aiList || !api.agentStatus) return;
    if (!statuses) {
      try {
        statuses = await api.agentStatus();
      } catch {
        statuses = {};
      }
    }
    ais = statuses;
    render();
    aiList.replaceChildren();
    for (const s of Object.values(statuses)) {
      const row = document.createElement('div');
      row.className = 'ai-row';
      const text = document.createElement('div');
      text.className = 'ai-row-text';
      const name = document.createElement('strong');
      // Named by the tool itself (Claude Code, Codex), with where it stands below.
      name.textContent = s.tool;
      let state = document.createElement('span');
      const ready = s.installed && s.loggedIn;
      state.textContent = ready ? `Signed in${s.account ? ` with your ${s.account}` : ''}` : s.installed ? 'Not signed in' : 'Not installed';
      // While it's being installed or signed in to, where that's got to, in words.
      if (failed[s.id] && !aiBusy.has(s.id)) {
        state.textContent = failed[s.id];
        delete failed[s.id];
      }
      if (aiBusy.has(s.id)) state = progressLine(s.id, s.installed ? 'Waiting for you to sign in in your browser…' : `Getting ready to install ${s.tool}…`);
      text.append(name, state);
      // Not ready: what the button does, in a line.
      const maker = s.id === 'codex' ? 'OpenAI' : 'Anthropic';
      const how = !s.installed
        ? (s.installers?.length ? `Install sets up ${s.tool} with ${maker}’s own installer, then you sign in.` : `${s.tool} can’t be installed from here on this Mac: Get it opens ${maker}’s page about it.`)
        : !s.loggedIn ? `Sign in opens ${s.name}’s sign-in page in your browser. Sign in there, then come back.` : null;
      if (how) text.append(Object.assign(document.createElement('span'), { className: 'ai-row-how', textContent: how }));
      row.append(text);
      if (ready) {
        const mark = document.createElement('span');
        mark.className = 'ai-ready';
        mark.textContent = 'Ready';
        row.append(mark);
      } else {
        const act = (label, run) => {
          // While it runs, the percentage done (or a spinner) takes the button's place.
          if (aiBusy.has(s.id)) return progressMark(s.id);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary-button';
          button.textContent = label;
          button.addEventListener('click', async () => {
            aiBusy.add(s.id);
            showAis(statuses);
            let next = null;
            try {
              next = await run();
            } catch (error) {
              failed[s.id] = failureText(error);
            }
            aiBusy.delete(s.id);
            clearAiProgress(s.id);
            showAis(next ?? undefined);
          });
          return button;
        };
        if (!s.installed && s.installers?.length) row.append(act('Install', () => api.agentInstall(s.id)));
        else if (!s.installed) row.append(act('Get it', () => api.agentInstallHelp(s.id).then(() => null)));
        else row.append(act('Sign in', () => api.agentSignIn(s.id)));
      }
      aiList.append(row);
    }
  }

  function setOpen(open) {
    if (open) {
      refreshClaudeDesktop();
      showAis();
    }
    const wasIn = card.contains(document.activeElement);
    document.body.classList.toggle('mcp-open', open);
    card.inert = !open;
    pill.setAttribute('aria-expanded', String(open));
    // The focus goes into the panel as it opens, and back to the pill as it closes.
    if (open) document.getElementById('mcp-close').focus({ preventScroll: true });
    else if (wasIn) pill.focus();
  }
  const isOpen = () => document.body.classList.contains('mcp-open');

  // While the panel is open, Tab goes round its controls only, until Escape or Close closes it.
  const FOCUSABLE = 'button, select, textarea, input, a[href], [tabindex]:not([tabindex="-1"])';
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !isOpen()) return;
    const stops = [...card.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.checkVisibility({ visibilityProperty: true }));
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement);
    const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
    e.preventDefault();
    stops[next].focus();
  });

  pill.addEventListener('click', () => setOpen(!isOpen()));

  const handle = document.getElementById('mcp-resizer');
  const setWidth = (w) => document.documentElement.style.setProperty('--mcp-width', `${Math.round(w)}px`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = card.getBoundingClientRect().width;
    document.body.classList.add('mcp-resizing');
    let closing = false;
    let width = startWidth;
    const onMove = (m) => {
      const raw = startWidth + m.clientX - startX; // its edge is on the right now
      closing = raw < PANEL_MIN;
      document.body.classList.toggle('mcp-closing', closing);
      width = Math.min(panelMax(), Math.max(0, raw));
      setWidth(width);
    };
    // Ends on release, or whenever the handle loses the pointer, so a drag is never left half-done.
    let ended = false;
    const onUp = () => {
      if (ended) return;
      ended = true;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('lostpointercapture', onUp);
      document.body.classList.remove('mcp-resizing');
      if (closing) {
        // It slides out from where it was let go, then opens again at its width before this drag.
        setOpen(false);
        setTimeout(() => setWidth(startWidth), 200);
      }
      document.body.classList.remove('mcp-closing');
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    handle.addEventListener('lostpointercapture', onUp);
  });
  mask.addEventListener('click', () => setOpen(false));
  document.getElementById('mcp-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      pill.focus();
    }
  });

  // The AI app to set up: its button opens a menu of the apps; choosing one shows its setup steps.
  const appButton = document.getElementById('app-picker-button');
  const appLabel = document.getElementById('app-picker-label');
  const appMenu = document.getElementById('app-picker-menu');
  const appOptions = [...appMenu.querySelectorAll('[data-app]')];
  const setAppMenuOpen = (open) => {
    appMenu.hidden = !open;
    appButton.setAttribute('aria-expanded', String(open));
  };
  appButton.addEventListener('click', () => setAppMenuOpen(appMenu.hidden));
  // Up or Down on the button opens the menu on the app chosen.
  appButton.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !appMenu.hidden) return;
    e.preventDefault();
    setAppMenuOpen(true);
    appOptions.find((o) => o.getAttribute('aria-checked') === 'true')?.focus();
  });
  for (const option of appOptions) {
    option.addEventListener('click', () => {
      for (const o of appOptions) {
        o.setAttribute('aria-checked', String(o === option));
        document.getElementById(`setup-${o.dataset.app}`).hidden = o !== option;
      }
      appLabel.textContent = option.textContent;
      setAppMenuOpen(false);
      appButton.focus();
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!appMenu.hidden && !appMenu.contains(e.target) && !appButton.contains(e.target)) setAppMenuOpen(false);
  });
  arrowKeysIn(appMenu);
  appMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // closes just the menu, not the panel
      setAppMenuOpen(false);
      appButton.focus();
    }
  });

  // Copy buttons sit in each code block's corner; a tick shows briefly once copied.
  for (const button of card.querySelectorAll('.code-copy')) {
    const title = button.title;
    let timer = 0;
    button.innerHTML = copyIcon;
    button.addEventListener('click', async () => {
      await api.copyMcpSetup(button.dataset.target);
      button.innerHTML = copiedIcon;
      button.title = 'Copied';
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.innerHTML = copyIcon;
        button.title = title;
      }, 1500);
    });
  }

  api.onMcpStatus((next) => {
    status = next;
    render();
  });
  // Asked for at once too: a status sent before this window was listening (a reload, say) would
  // otherwise leave it saying Starting… for good.
  api.mcpStatus?.().then((next) => {
    status = next;
    render();
  });
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      status = await api.retryMcp();
      render();
    } finally {
      retry.disabled = false;
    }
  });
  api.onShowConnect(() => setOpen(true));
  // Whether an AI is ready, for the pill: at the start, and on coming back to the window (from
  // signing in in the browser, say), unless one is being set up here (which says when it's done).
  const checkAis = async () => {
    if (aiBusy.size || !api.agentStatus) return;
    try {
      ais = await api.agentStatus();
    } catch {
      ais = {};
    }
    render();
  };
  checkAis();
  addEventListener('focus', checkAis);
  document.getElementById('ai-release-button').addEventListener('click', () => api.releaseAiControl());
  render();
  showSetups();

  return {
    // The AI working in this window, or null: said in the server panel (with a way to release the
    // window). The pill itself only ever shows the server's status; it no longer takes turns with
    // "Controlled by …", which the user found unneeded now the AI works in the chat.
    setAiControl(name) {
      aiName = name;
      aiLabel.hidden = true;
      release.hidden = !name;
      releaseText.textContent = name ? `${name} works in this window.` : '';
      render();
    },
  };
}
