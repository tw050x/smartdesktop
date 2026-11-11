// The window's markup, put in an empty body before starting the interface (see app-shell.js).
export const APP_MARKUP = `
<header class="top-bar">
  <!-- The app's status, first in the bar, just after the traffic lights: it opens the panel with
       the AIs and the server, which slides in from the left (see server-status.js). -->
  <button class="server-pill" id="server-pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="mcp-card">
    <span class="server-dot" aria-hidden="true"></span><span class="server-pill-labels"><span id="server-pill-label">Starting…</span><span id="server-pill-ai" hidden></span></span>
  </button>
  <!-- Back and forward through where this window has been (see schemas.js). -->
  <div class="history-nav" id="history-nav" role="group" aria-label="History">
    <button class="icon-button" id="history-back" type="button" aria-label="Back" title="Back" disabled>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>
    </button>
    <button class="icon-button" id="history-forward" type="button" aria-label="Forward" title="Forward" disabled>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
    </button>
  </div>
  <!-- Home, the mode and, in Design, the focus: what the AI's work is for (see schemas.js). -->
  <nav class="breadcrumb" id="breadcrumb" aria-label="Location"></nav>
  <!-- The drafts of the schematic showing, centred in the top bar (see schemas.js). -->
  <div class="draft-nav" id="draft-nav" role="group" aria-label="Drafts" hidden></div>
  <div class="top-bar-end">
    <!-- Focus | Overview, for a schematic in Design (see schemas.js). -->
    <div class="view-switch" id="view-switch" role="group" aria-label="View" hidden>
      <button type="button" data-view="focus">Focus</button>
      <button type="button" data-view="overview">Overview</button>
    </div>
    <!-- The chat with your AI, docked or in its own window (see chat-panel.js). -->
    <button class="icon-button chat-button" id="chat-button" type="button" aria-label="Open the chat" title="Open the chat" aria-pressed="false">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z"/><circle cx="8.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="12" r="1" fill="currentColor" stroke="none"/></svg>
    </button>
  </div>
</header>

<!-- The modes to switch between, opened from the breadcrumb (see mode-switcher.js). -->
<div class="tool-card" id="mode-card" role="menu" aria-label="Modes" hidden></div>
<!-- Everything in the schematic, to focus on, opened from the breadcrumb (see schemas.js). -->
<div class="tool-card focus-menu" id="focus-menu" role="menu" aria-label="Focus" hidden></div>

<main class="content" id="content"></main>
<!-- The actions bar: what there is to decide about this view, with its buttons, or a sentence on what's going on (see showBar in schemas.js). -->
<footer class="review-bar" id="review-bar" aria-label="About this view" hidden></footer>

<!-- The chat with your AI: docked at the right, or floating in a window of its own (see chat-panel.js). -->
<aside id="chat-panel" hidden></aside>

<!-- The AIs and the MCP server: a full-height panel that slides in over the left of the window, above a mask that dulls the rest. -->
<div class="mcp-mask" id="mcp-mask"></div>
<aside class="mcp-card" id="mcp-card" role="dialog" aria-modal="true" aria-labelledby="mcp-card-title" inert>
  <div class="mcp-card-bar">
    <button class="icon-button" id="mcp-close" type="button" aria-label="Close" title="Close">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </div>
  <div class="panel">
    <div class="ai-release" id="ai-release" hidden>
      <p id="ai-release-text"></p>
      <button type="button" class="secondary-button" id="ai-release-button">Release this window</button>
    </div>
    <!-- The AIs the chat runs: where each stands, and installing or signing in, a click each (see
         server-status.js and main/agent.js). -->
    <section class="ai-setup">
      <h3>AI</h3>
      <p class="panel-hint">The AI you work with in the chat runs on this Mac, signed in with your own account on its maker’s site. SmartSpec never sees your sign-in.</p>
      <div class="ai-list" id="ai-list"></div>
    </section>
    <h3 id="mcp-card-title">MCP server</h3>
    <p class="panel-hint server-intro">How the AI reads your schematics and proposes its changes in SmartSpec: a server built into the app that only this Mac can reach. It’s also how you can connect another AI app yourself.</p>
    <dl class="server-details">
      <dt>Status</dt><dd id="server-state"></dd>
      <dt>Address</dt><dd id="server-url"></dd>
      <dt>Access</dt><dd>This computer only, with the app’s token</dd>
    </dl>
    <!-- Why the server isn't running, in plain words, and a way to try again (see server-status.js). -->
    <div class="server-off" id="server-off" hidden>
      <p class="panel-note" id="server-off-text"></p>
      <button type="button" class="secondary-button" id="server-retry">Try again</button>
    </div>

    <!-- For anyone who'd rather connect an AI app of their own to SmartSpec's server by hand. -->
    <details class="manual-setup">
      <summary>Connect another AI app yourself</summary>
    <section class="mcp-setup" id="mcp-setup">
      <!-- The AI app to set up: a button naming it, opening a menu of the apps (see server-status.js). -->
      <div class="app-picker">
        <button class="app-picker-button" id="app-picker-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="app-picker-menu">
          <span id="app-picker-label">Claude Desktop</span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="app-picker-menu" id="app-picker-menu" role="menu" hidden>
          <button type="button" role="menuitemradio" data-app="claude-desktop" aria-checked="true">Claude Desktop</button>
          <button type="button" role="menuitemradio" data-app="claude-code" aria-checked="false">Claude Code</button>
          <button type="button" role="menuitemradio" data-app="other" aria-checked="false">Other agents</button>
        </div>
      </div>
      <!-- Claude Desktop: SmartSpec adds itself to its settings file, or the user does (see server-status.js). -->
      <div class="tab-panel" id="setup-claude-desktop">
        <p class="setup-state" id="claude-desktop-state"></p>
        <button class="primary-button" id="add-to-claude-desktop" type="button" hidden>Add to Claude Desktop</button>
        <details class="setup-manual">
          <summary>Or add it yourself</summary>
          <ol class="setup-steps">
            <li>In Claude Desktop, open Settings → Developer → Edit Config.</li>
            <li>Add SmartSpec to the file (if it has <code>mcpServers</code> already, add the <code>smartspec</code> entry inside it):<div class="code-block"><pre><code data-setup="config"></code></pre><button class="icon-button code-copy" type="button" data-target="config" aria-label="Copy config" title="Copy config"></button></div></li>
            <li>Quit Claude Desktop and open it again.</li>
          </ol>
        </details>
      </div>
      <div class="tab-panel" id="setup-claude-code" hidden>
        <ol class="setup-steps">
          <li>Copy the setup command:<div class="code-block"><pre><code data-setup="claude-code"></code></pre><button class="icon-button code-copy" type="button" data-target="claude-code" aria-label="Copy command" title="Copy command"></button></div></li>
          <li>Paste it into a terminal and press Return. Or paste it into a Claude Code chat and ask Claude to add the server.</li>
          <li>Start a new Claude Code session. Type <code>/mcp</code> to check it’s connected. Claude opens this app whenever it needs it.</li>
        </ol>
      </div>
      <div class="tab-panel" id="setup-other" hidden>
        <ol class="setup-steps">
          <li>Add SmartSpec as an MCP server. Most agents take a config entry like this:<div class="code-block"><pre><code data-setup="config"></code></pre><button class="icon-button code-copy" type="button" data-target="config" aria-label="Copy config" title="Copy config"></button></div></li>
          <li>Restart your agent and ask it to design something in SmartSpec. It opens this app whenever it needs it.</li>
        </ol>
      </div>
      <p class="setup-note">Keep SmartSpec in your Applications folder: these point at it there. If you move it, set up your agents again.</p>
    </section>
    </details>
  </div>
</aside>

<div class="mcp-resizer" id="mcp-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the panel" aria-controls="mcp-card"></div>

<!-- Shown at the bottom of the window once an update has downloaded (see settings.js). -->
<div class="update-toast" id="update-toast" role="status" hidden>
  <span id="update-toast-text"></span>
  <button class="primary-button" id="update-toast-restart" type="button">Restart to Update</button>
  <button class="secondary-button" id="update-toast-later" type="button">Later</button>
</div>

<!-- Settings, opened from the SmartSpec menu (see settings.js). -->
<dialog class="settings-dialog" id="settings-dialog" aria-labelledby="settings-title" tabindex="-1">
  <div class="settings-head">
    <h2 id="settings-title">Settings</h2>
    <button class="icon-button" id="settings-close" type="button" aria-label="Close" title="Close">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </div>
  <div class="settings-body" id="settings-body">
    <!-- How the app looks: as the system is, or always light or dark (see settings.js). -->
    <section class="setting">
      <h3 class="setting-title" id="appearance-title">Appearance</h3>
      <div class="segmented" id="appearance" role="radiogroup" aria-labelledby="appearance-title">
        <button type="button" role="radio" data-appearance="system" aria-checked="true">System</button>
        <button type="button" role="radio" data-appearance="light" aria-checked="false">Light</button>
        <button type="button" role="radio" data-appearance="dark" aria-checked="false">Dark</button>
      </div>
      <p class="setting-note">System matches your Mac’s appearance.</p>
    </section>
    <!-- The app's version and its updates, which download by themselves (see settings.js). -->
    <section class="setting">
      <h3 class="setting-title">Updates</h3>
      <p class="setting-line"><span id="update-version"></span> <span class="beta-tag">Beta</span> · <span id="update-state"></span></p>
      <button class="secondary-button" id="update-action" type="button">Check for Updates</button>
      <p class="setting-note">SmartSpec is in beta, so it may change significantly from one version to the next. New versions download by themselves and install when SmartSpec quits.</p>
    </section>
  </div>
</dialog>
`;
