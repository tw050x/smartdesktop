// The MCP server's status in the top bar: a pill showing whether it's running. Clicking it dulls
// the window with a white mask (leaving the pill clear) and slides in a full-height panel on the
// right with the server's details and, in a tab per AI app, how to connect one. The panel's
// drag handle resizes it, and closes it when dragged below the minimum width. Once AI apps have
// connected, the pill names the latest and the panel lists each with how long ago it connected.

const PANEL_MIN = 300;
const PANEL_MAX_SHARE = 0.66;
const panelMax = () => Math.max(PANEL_MIN, window.innerWidth * PANEL_MAX_SHARE);

const copyIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9,18q-0.82,0-1.41-0.59T7,16V4Q7,3.17 7.59,2.59T9,2h9q0.82,0 1.41,0.59T20,4V16q0,0.82-0.59,1.41T18,18H9Zm0-2h9V4H9V16ZM5,22q-0.83,0-1.41-0.59T3,20V6H5V20H16v2H5Zm4-6V4V16Z"/></svg>';
const copiedIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

const LABELS = { starting: 'MCP starting…', running: 'MCP server on', off: 'MCP server off' };
const STATES = { starting: 'Starting…', running: 'Running', off: 'Not running' };

// "just now", "5 min ago", "3 hr ago", "2 days ago".
function ago(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function createServerStatus({ api }) {
  const pill = document.getElementById('server-pill');
  const label = document.getElementById('server-pill-label');
  const mask = document.getElementById('mcp-mask');
  const card = document.getElementById('mcp-card');
  const stateEl = document.getElementById('server-state');
  const urlEl = document.getElementById('server-url');
  const off = document.getElementById('server-off');
  const setup = document.getElementById('mcp-setup');
  const clientsEl = document.getElementById('server-clients');
  let status = { state: 'starting', clients: [] };

  function render() {
    pill.dataset.state = status.state;
    stateEl.textContent = STATES[status.state];
    renderClients();
    urlEl.textContent = status.url ?? '—';
    off.hidden = status.state !== 'off';
    setup.hidden = status.state !== 'running';
    if (status.state === 'running') showSetups();
  }

  // Newest first. The times are kept current by a timer below.
  function renderClients() {
    const clients = status.clients ?? [];
    const [latest] = clients;
    label.textContent = status.state === 'running' && latest
      ? `${latest.label}${clients.length > 1 ? ` +${clients.length - 1}` : ''} · ${ago(latest.connectedAt)}`
      : LABELS[status.state];
    pill.title = clients.length ? `Last connected: ${clients.map((c) => `${c.label}, ${ago(c.connectedAt)}`).join('; ')}` : '';
    clientsEl.replaceChildren(...(clients.length ? clients : [null]).map((c) => {
      const li = document.createElement('li');
      if (!c) {
        li.className = 'server-clients-none';
        li.textContent = 'None yet';
        return li;
      }
      const name = document.createElement('span');
      name.textContent = c.label;
      if (c.version) name.title = `${c.name} ${c.version}`;
      const time = document.createElement('time');
      time.dateTime = c.connectedAt;
      time.title = new Date(c.connectedAt).toLocaleString();
      time.textContent = `connected ${ago(c.connectedAt)}`;
      li.append(name, time);
      return li;
    }));
  }
  setInterval(renderClients, 30_000);

  async function showSetups() {
    for (const code of card.querySelectorAll('[data-setup]')) code.textContent = await api.mcpSetup(code.dataset.setup);
  }

  function setOpen(open) {
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

  document.getElementById('open-website').addEventListener('click', () => api.openWebsite());

  // Tabs: one per AI app.
  const tabs = [...card.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) {
        t.setAttribute('aria-selected', String(t === tab));
        document.getElementById(t.getAttribute('aria-controls')).hidden = t !== tab;
      }
    });
  }

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
  render();
}
