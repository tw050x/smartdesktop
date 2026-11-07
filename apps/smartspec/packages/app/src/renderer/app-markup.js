// The window's markup, put in an empty body before starting the interface (see app-shell.js).
export const APP_MARKUP = `
<header class="top-bar">
  <!-- Back and forward through where this window has been (see schemas.js). -->
  <div class="history-nav" id="history-nav" role="group" aria-label="History">
    <button class="icon-button" id="history-back" type="button" aria-label="Back" title="Back" disabled>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>
    </button>
    <button class="icon-button" id="history-forward" type="button" aria-label="Forward" title="Forward" disabled>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
    </button>
  </div>
  <!-- Where you are: home, the mode, any levels open and the item in focus (see schemas.js). -->
  <nav class="breadcrumb" id="breadcrumb" aria-label="Location"></nav>
  <!-- The drafts of the schematic showing, centred in the top bar (see schemas.js). -->
  <div class="draft-nav" id="draft-nav" role="group" aria-label="Drafts" hidden></div>
  <div class="top-bar-end">
    <!-- Focus | Overview, for a schematic in Design (see schemas.js). -->
    <div class="view-switch" id="view-switch" role="group" aria-label="View" hidden>
      <button type="button" data-view="focus">Focus</button>
      <button type="button" data-view="overview">Overview</button>
    </div>
    <button class="icon-button" id="settings-button" type="button" aria-haspopup="dialog" aria-controls="settings-dialog" aria-label="Settings" title="Settings">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M9.25,22l-0.4-3.2q-0.32-0.13-0.61-0.3T7.68,18.13L4.7,19.38L1.95,14.63l2.58-1.95Q4.5,12.5 4.5,12.34q0-0.16 0-0.34t0-0.34t0.03-0.34L1.95,9.38L4.7,4.63L7.68,5.88Q7.95,5.68 8.25,5.5t0.6-0.3L9.25,2h5.5l0.4,3.2q0.33,0.13 0.61,0.3t0.56,0.38L19.3,4.63l2.75,4.75l-2.57,1.95q0.02,0.18 0.02,0.34t0,0.34t0,0.34t-0.05,0.34l2.57,1.95l-2.75,4.75l-2.95-1.25q-0.27,0.2-0.57,0.38t-0.6,0.3L14.75,22H9.25ZM11,20h1.98l0.35-2.65q0.78-0.2 1.44-0.59t1.21-0.94l2.47,1.03l0.98-1.7l-2.15-1.63q0.13-0.35 0.17-0.74T17.5,12t-0.05-0.79q-0.05-0.39-0.17-0.74l2.15-1.63l-0.98-1.7L15.98,8.2q-0.55-0.57-1.21-0.96T13.33,6.65L13,4H11.03L10.68,6.65Q9.9,6.85 9.24,7.24T8.03,8.17L5.55,7.15L4.58,8.85l2.15,1.6Q6.6,10.83 6.55,11.2T6.5,12q0,0.4 0.05,0.77t0.17,0.75L4.58,15.15l0.98,1.7L8.03,15.8q0.55,0.58 1.21,0.96t1.44,0.59L11,20Zm1.05-4.5q1.45,0 2.47-1.03T15.55,12T14.53,9.52T12.05,8.5q-1.47,0-2.49,1.02T8.55,12t1.01,2.47t2.49,1.03ZM12,12Z"/></svg>
    </button>
    <button class="server-pill" id="server-pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="mcp-card">
      <span class="server-dot" aria-hidden="true"></span><span class="server-pill-labels"><span id="server-pill-label">MCP server</span><span id="server-pill-ai" hidden></span></span>
    </button>
  </div>
</header>

<!-- The modes to switch between, opened from the breadcrumb (see mode-switcher.js). -->
<div class="tool-card" id="mode-card" role="menu" aria-label="Modes" hidden></div>
<!-- Everything in the schematic, to focus on, opened from the breadcrumb (see schemas.js). -->
<div class="tool-card focus-menu" id="focus-menu" role="menu" aria-label="Focus" hidden></div>

<main class="content" id="content"></main>
<!-- Answering a proposal, along the bottom of the window (see schemas.js). -->
<!-- The contextual bar: plain sentences about what's going on in this view, and what to do about it (see schemas.js). -->
<footer class="review-bar" id="review-bar" aria-label="About this view" hidden></footer>

<!-- MCP server details: a full-height panel that slides in over the right of the window, above a mask that dulls the rest. -->
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
    <h3 id="mcp-card-title">MCP server</h3>
    <dl class="server-details">
      <dt>Status</dt><dd id="server-state"></dd>
      <dt>Address</dt><dd id="server-url"></dd>
      <dt>Access</dt><dd>This computer only, with the app’s token</dd>
    </dl>
    <p class="panel-note" id="server-off" hidden>The server couldn’t start. Another copy of the app may be running.</p>

    <section class="mcp-setup" id="mcp-setup">
      <h3>Set up an AI app</h3>
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
  </div>
</aside>

<div class="mcp-resizer" id="mcp-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the MCP server panel" aria-controls="mcp-card"></div>

<!-- Shown at the bottom of the window once an update has downloaded (see settings.js). -->
<div class="update-toast" id="update-toast" role="status" hidden>
  <span id="update-toast-text"></span>
  <button class="primary-button" id="update-toast-restart" type="button">Restart to Update</button>
  <button class="secondary-button" id="update-toast-later" type="button">Later</button>
</div>

<!-- Settings, opened from the top bar's gear (see settings.js). -->
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
      <p class="setting-line"><span id="update-version"></span> · <span id="update-state"></span></p>
      <button class="secondary-button" id="update-action" type="button">Check for Updates</button>
      <p class="setting-note">New versions download by themselves and install when SmartSpec quits.</p>
    </section>
  </div>
</dialog>
`;
