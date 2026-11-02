// The MCP server's status in the top bar: a pill showing only whether it's starting (amber), on
// (green) or off (red). Clicking it dulls
// the window with a white mask (leaving the pill clear) and slides in a full-height panel on the
// right with the server's details and, for each AI app, how to connect it; for Claude Desktop,
// a button that adds SmartDoc for the user. Connect an AI in the menu opens it too. The panel's
// drag handle resizes it, and closes it when dragged below the minimum width.

const PANEL_MIN = 300;
const PANEL_MAX_SHARE = 0.66;
const panelMax = () => Math.max(PANEL_MIN, window.innerWidth * PANEL_MAX_SHARE);

const copyIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9,18q-0.82,0-1.41-0.59T7,16V4Q7,3.17 7.59,2.59T9,2h9q0.82,0 1.41,0.59T20,4V16q0,0.82-0.59,1.41T18,18H9Zm0-2h9V4H9V16ZM5,22q-0.83,0-1.41-0.59T3,20V6H5V20H16v2H5Zm4-6V4V16Z"/></svg>';
const copiedIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// The pill's short label, and its tooltip saying what it's about.
const LABELS = { starting: 'Starting…', running: 'Ready', off: 'Not running' };
const TITLES = { starting: 'MCP server: starting', running: 'MCP server: ready for your AI', off: 'MCP server: not running' };
const STATES = { starting: 'Starting…', running: 'Running', off: 'Not running' };

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
  let status = { state: 'starting' };

  function render() {
    pill.dataset.state = status.state;
    stateEl.textContent = STATES[status.state];
    label.textContent = LABELS[status.state];
    pill.title = TITLES[status.state];
    pill.setAttribute('aria-label', TITLES[status.state]);
    urlEl.textContent = status.url ?? '—';
    off.hidden = status.state !== 'off';
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

  function setOpen(open) {
    if (open) refreshClaudeDesktop();
    document.body.classList.toggle('mcp-open', open);
    card.inert = !open;
    pill.setAttribute('aria-expanded', String(open));
  }
  const isOpen = () => document.body.classList.contains('mcp-open');

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
      const raw = startWidth + startX - m.clientX;
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
  api.onShowConnect(() => setOpen(true));
  render();
  showSetups();
}
