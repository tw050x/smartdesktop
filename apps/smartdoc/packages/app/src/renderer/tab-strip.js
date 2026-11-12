// The top bar across a window: room for the traffic lights, back and forward (in the tab showing),
// the window's tabs, and the app's status at its end. Home is the first tab, pinned: an icon that
// can't be closed, and the only tab showing home; each other tab shows a document, by its name, with
// a button to close it (shown while it's pointed at, or showing), and beside it a sparkle while an AI
// works in it (the user's choice). The window has tabs rather than
// opening more windows (the user's choice; more windows are still allowed). The status pill opens
// the status panel (server-status.js) in the tab showing.
//
// The tab showing has a blue pill under it, centred on the line between the top bar and the page
// below, and pointing at a tab shows one under it too, in place of a tooltip (the user's choice). In
// the app that line is where the top bar's page ends and the tab's begins, so each draws its half
// (the tab's from `tabLines`, see main.js).
//
// Each tab has its document's or schematic's icon (see main/icons.js) before its name: as tabs get
// narrow, the name gives way and the icon stays, so a tab can still be told apart (the user's
// choice). Its right-click menu changes the icon.
//
// The app draws it in the window's own page (tabs.html, see tabs.js), above the tabs' pages, from
// what the main process sends (`onTabs`: { tabs, back, forward, status }); the website's demo draws
// it in its page, from what its stand-in API sends.
import { iconSvg } from '../main/icons.js';

const HOME_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/></svg>';
// An AI working in the tab: a sparkle, beside its close button.
const AI_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5Z"/><path d="M19 15.5c.25 2 1.25 3 3.25 3.25-2 .25-3 1.25-3.25 3.25-.25-2-1.25-3-3.25-3.25 2-.25 3-1.25 3.25-3.25Z"/></svg>';
// A chat in SmartDesktop owning the tab: a speech bubble, a button beside its close button.
const CHAT_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>';
const FORWARD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

export function createTabStrip({ el, api }) {
  el.innerHTML = `
    <div class="history-nav" role="group" aria-label="History">
      <button class="icon-button" data-step="-1" type="button" aria-label="Back" title="Back" disabled>${BACK_ICON}</button>
      <button class="icon-button" data-step="1" type="button" aria-label="Forward" title="Forward" disabled>${FORWARD_ICON}</button>
    </div>
    <div class="tabs" role="tablist" aria-label="Tabs"></div>
    <div class="top-bar-end">
      <button class="server-pill" type="button" aria-haspopup="dialog">
        <span class="server-dot" aria-hidden="true"></span><span class="server-pill-labels"><span class="server-pill-label"></span></span>
      </button>
    </div>`;
  const back = el.querySelector('[data-step="-1"]');
  const forward = el.querySelector('[data-step="1"]');
  const tabsEl = el.querySelector('.tabs');
  const pill = el.querySelector('.server-pill');
  // The pills: under the tab showing (`active`), and under the tab pointed at (`hover`), each a box
  // in this page ({ left, width }) or null.
  const pills = { active: document.createElement('div'), hover: document.createElement('div') };
  for (const pill of Object.values(pills)) {
    pill.className = 'tab-hover-pill';
    pill.hidden = true;
    el.append(pill);
  }
  const lines = { active: null, hover: null };
  let sent = null;
  function showLines() {
    for (const [which, box] of Object.entries(lines)) {
      pills[which].hidden = !box;
      if (box) Object.assign(pills[which].style, { left: `${box.left}px`, width: `${box.width}px` });
    }
    const now = JSON.stringify(lines);
    if (now === sent) return;
    sent = now;
    api.tabLines?.({ ...lines });
  }
  const INSET = 10; // the pill's ends, in from the tab's
  const boxOf = (tab) => {
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { left: Math.round(r.left + INSET), width: Math.round(Math.max(12, r.width - 2 * INSET)) };
  };
  let pointed = null; // the tab pointed at
  const measure = () => {
    lines.active = boxOf(el.querySelector('.tab[aria-selected="true"]'));
    lines.hover = pointed?.isConnected ? boxOf(pointed) : null;
    showLines();
  };
  el.addEventListener('pointerover', (event) => {
    const tab = event.target.closest?.('.tab') ?? null;
    if (tab === pointed) return;
    pointed = tab;
    measure();
  });
  el.addEventListener('pointerleave', () => {
    pointed = null;
    measure();
  });
  addEventListener('resize', measure);
  for (const button of [back, forward]) button.addEventListener('click', () => api.historyStep?.(Number(button.dataset.step)));
  pill.addEventListener('click', () => api.showStatus?.());

  function render({ tabs = [], back: canBack = false, forward: canForward = false, status = null } = {}) {
    back.disabled = !canBack;
    forward.disabled = !canForward;
    tabsEl.replaceChildren(...tabs.map((tab) => {
      const node = document.createElement('div');
      node.className = `tab${tab.home ? ' tab-home' : ''}${tab.ai ? ' tab-ai' : ''}`;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(tab.active));
      node.dataset.noTip = '';
      node.dataset.id = tab.id;
      node.addEventListener('mousedown', (event) => {
        // The middle button closes it, as in a browser.
        if (event.button === 1 && !tab.home) {
          event.preventDefault();
          api.tabClose?.(tab.id);
        }
      });
      node.addEventListener('click', (event) => {
        if (!event.target.closest('.tab-close')) api.tabActivate?.(tab.id);
      });
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const r = node.getBoundingClientRect();
        api.tabMenu?.(tab.id, { left: Math.round(r.left), width: Math.round(r.width) });
      });
      if (tab.home) {
        node.innerHTML = HOME_ICON;
        node.setAttribute('aria-label', 'Home');
      } else {
        const icon = document.createElement('span');
        icon.className = 'tab-icon';
        icon.innerHTML = iconSvg(tab.icon, 15);
        node.append(icon);
        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = tab.title;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.innerHTML = CLOSE_ICON;
        close.setAttribute('aria-label', `Close ${tab.title}`);
        close.addEventListener('click', () => api.tabClose?.(tab.id));
        node.append(title);
        // One mark beside the close button. A tab a chat owns has a button bringing that chat forward
        // in SmartDesktop, ready to type in (the user's choice): the chat mark, or the sparkle while
        // its AI works. Another AI working in it (not a chat's) shows the sparkle alone.
        if (tab.chat) {
          const chat = document.createElement('button');
          chat.type = 'button';
          chat.className = `tab-chat-button${tab.ai ? ' working' : ''}`;
          chat.innerHTML = tab.ai ? AI_ICON : CHAT_ICON;
          chat.setAttribute('aria-label', tab.ai ? `Show the chat “${tab.chat.title}”, working in this tab` : `Show the chat “${tab.chat.title}”`);
          chat.addEventListener('click', () => api.tabChat?.(tab.id));
          node.append(chat);
        } else if (tab.ai) {
          const ai = document.createElement('span');
          ai.className = 'tab-ai-mark';
          ai.innerHTML = AI_ICON;
          ai.setAttribute('aria-label', `${tab.ai} is working in this tab`);
          node.append(ai);
        }
        node.append(close);
      }
      return node;
    }));
    // The tabs moved or changed: the pills follow (once they're laid out).
    requestAnimationFrame(() => {
      if (pointed && !pointed.isConnected) pointed = tabsEl.querySelector(`.tab[data-id="${pointed.dataset.id}"]`);
      measure();
    });
    if (status) {
      pill.dataset.state = status.state;
      pill.querySelector('.server-pill-label').textContent = status.label;
      pill.title = status.title;
      pill.setAttribute('aria-label', status.title);
    }
  }
  return { render };
}
