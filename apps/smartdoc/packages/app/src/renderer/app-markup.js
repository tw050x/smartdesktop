// The window's markup, shared by the app (index.html) and the website's demo (demo.html), which
// both put it in an empty body before starting the interface (see app-shell.js).
export const APP_MARKUP = `
<header class="top-bar">
  <!-- Where you are: home, the open document's tool and, in the highlight tool, its focus (see
       app-shell.js, tool-switcher.js and focus-picker.js). -->
  <nav class="top-bar-start breadcrumb" aria-label="Location">
    <button class="icon-button crumb-home" id="go-home" type="button" aria-label="Home" title="Home">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/></svg>
    </button>
    <button class="tool-button" id="tool-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="tool-card">
      <span id="tool-label"></span>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <button class="tool-button focus-button" id="focus-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="focus-card" hidden>
      <span id="focus-label"></span>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
  </nav>
  <!-- The open document's drafts, centred in the top bar: which one is showing, and the ones
       either side. -->
  <div class="draft-nav" id="draft-nav" role="group" aria-label="Drafts" hidden>
    <button class="icon-button" id="draft-prev" type="button" aria-label="Previous draft" title="Previous draft">‹</button>
    <span class="draft-label" id="draft-label"></span>
    <button class="icon-button" id="draft-next" type="button" aria-label="Next draft" title="Next draft">›</button>
  </div>
  <div class="top-bar-end">
    <!-- All | To do, in Review and draft: with To do, decided findings are hidden (see app-shell.js). -->
    <div class="view-switch" id="done-switch" role="group" aria-label="Show" hidden>
      <button type="button" data-show="all">All</button>
      <button type="button" data-show="todo">To do</button>
    </div>
    <!-- Document | List, for a highlights review (see app-shell.js). -->
    <div class="view-switch" id="view-switch" role="group" aria-label="View" hidden>
      <button type="button" data-view="document">Document</button>
      <button type="button" data-view="list">List</button>
    </div>
    <button class="server-pill" id="server-pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="mcp-card">
      <span class="server-dot" aria-hidden="true"></span><span class="server-pill-labels"><span id="server-pill-label">MCP server</span><span id="server-pill-ai" hidden></span></span>
    </button>
  </div>
</header>

<!-- The tools to switch between, opened from the top bar's tool button (see tool-switcher.js). -->
<div class="tool-card" id="tool-card" role="menu" aria-label="Tools" hidden></div>
<!-- The highlight tool's focuses, opened from the breadcrumb's focus (see focus-picker.js). -->
<div class="tool-card focus-card" id="focus-card" role="dialog" aria-label="Focuses" hidden></div>

<main class="workspace">
  <section class="document" id="document">
    <!-- While a file is dragged over the window, all that shows (see app-shell.js). -->
    <div class="drop-zone" id="drop-zone" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14l3 3 3-3"/></svg>
      <p>Drop the PDF to open it in SmartDoc</p>
    </div>
    <!-- The home screen, with no document open: documents › variations › drafts (see home.js). -->
    <div class="empty-state" id="empty-state">
      <div class="home">
        <section class="home-column" aria-labelledby="home-documents-title">
          <div class="home-column-head"><h2 id="home-documents-title">Documents</h2></div>
          <ul class="home-list" id="home-documents"></ul>
        </section>
        <section class="home-column" aria-labelledby="home-variations-title">
          <div class="home-column-head"><h2 id="home-variations-title">Variations</h2></div>
          <ul class="home-list" id="home-variations"></ul>
          <!-- Shown instead of the list while there's no document to choose (see home.js). -->
          <div class="home-skeleton" aria-hidden="true"><div class="home-item"><div class="home-row"><span class="home-title"><span class="home-skeleton-bar" style="width:44%"></span></span><span class="home-meta"><span class="home-skeleton-bar" style="width:22%"></span></span></div></div><div class="home-item"><div class="home-row"><span class="home-title"><span class="home-skeleton-bar" style="width:58%"></span></span><span class="home-meta"><span class="home-skeleton-bar" style="width:30%"></span></span></div></div><div class="home-item"><div class="home-row"><span class="home-title"><span class="home-skeleton-bar" style="width:36%"></span></span><span class="home-meta"><span class="home-skeleton-bar" style="width:18%"></span></span></div></div></div>
        </section>
        <section class="home-column" aria-labelledby="home-drafts-title">
          <div class="home-column-head"><h2 id="home-drafts-title">Drafts</h2></div>
          <ul class="home-list" id="home-drafts"></ul>
          <div class="home-skeleton" aria-hidden="true"><div class="home-item"><div class="home-row"><span class="home-title"><span class="home-skeleton-bar" style="width:22%"></span></span><span class="home-meta"><span class="home-skeleton-bar" style="width:20%"></span></span></div><div class="home-reviews"><div class="home-review" style="--review-color: #2f6fde"><span class="home-skeleton-icon"></span><span class="home-review-text"><span class="home-skeleton-bar" style="width:62%"></span></span></div><div class="home-review" style="--review-color: #b45309"><span class="home-skeleton-icon"></span><span class="home-review-text"><span class="home-skeleton-bar" style="width:48%"></span></span></div></div></div><div class="home-item"><div class="home-row"><span class="home-title"><span class="home-skeleton-bar" style="width:24%"></span></span><span class="home-meta"><span class="home-skeleton-bar" style="width:20%"></span></span></div><div class="home-reviews"><div class="home-review" style="--review-color: #2f6fde"><span class="home-skeleton-icon"></span><span class="home-review-text"><span class="home-skeleton-bar" style="width:54%"></span></span></div><div class="home-review" style="--review-color: #b45309"><span class="home-skeleton-icon"></span><span class="home-review-text"><span class="home-skeleton-bar" style="width:48%"></span></span></div></div></div></div>
        </section>
      </div>
    </div>
    <!-- The pages, with the review laid over them and their margins (see margin-review.js). -->
    <div class="pages-wrap" id="pages-wrap">
      <div class="pages" id="pages"></div>
      <div class="margin-layer" id="margin-layer"></div>
    </div>
  </section>
  <!-- The AI's preview beside the draft it was written from, in place of the document (see compare.js). -->
  <section class="compare" id="compare" aria-label="Comparison with the previous draft"></section>
  <!-- A highlights review as a list, in place of the document (see highlights-list.js). -->
  <section class="list-view" id="list-view" aria-label="Highlights"></section>
  <div class="scrollbar" id="scrollbar" aria-hidden="true"><div class="scrollbar-thumb" id="scrollbar-thumb"></div></div>
  <!-- At the pages' edges, to resize them from both sides at once (see app-shell.js). -->
  <div class="page-resizer left" title="Drag to resize the page. Double-click to reset."></div>
  <div class="page-resizer right" title="Drag to resize the page. Double-click to reset."></div>
  <!-- Find, in this draft and the others on its line (see find-bar.js). -->
  <div class="find-bar" id="find-bar" role="search" aria-label="Find in the document" hidden>
    <div class="find-row">
      <input id="find-input" type="text" placeholder="Find in this draft" aria-label="Find in this draft" spellcheck="false" autocomplete="off">
      <span class="find-status" id="find-status" role="status"></span>
      <button class="icon-button find-step" id="find-prev" type="button" aria-label="Previous match" title="Previous match">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>
      </button>
      <button class="icon-button find-step" id="find-next" type="button" aria-label="Next match" title="Next match">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button class="icon-button" id="find-close" type="button" aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="find-history" id="find-history" hidden>
      <p class="find-verdict" id="find-verdict" role="status"></p>
      <ul class="find-drafts" id="find-drafts"></ul>
    </div>
  </div>
  <footer class="review-bar" id="review-bar" aria-label="Review"></footer>
</main>

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
      <!-- Claude Desktop: SmartDoc adds itself to its settings file, or the user does (see server-status.js). -->
      <div class="tab-panel" id="setup-claude-desktop">
        <p class="setup-state" id="claude-desktop-state"></p>
        <button class="primary-button" id="add-to-claude-desktop" type="button" hidden>Add to Claude Desktop</button>
        <p class="panel-note" id="claude-extension-note" hidden>SmartDoc is also installed in Claude Desktop as an extension, from an earlier version. Remove it in Claude Desktop’s Settings → Extensions, so its tools don’t show twice.</p>
        <details class="setup-manual">
          <summary>Or add it yourself</summary>
          <ol class="setup-steps">
            <li>In Claude Desktop, open Settings → Developer → Edit Config.</li>
            <li>Add SmartDoc to the file (if it has <code>mcpServers</code> already, add the <code>smartdoc</code> entry inside it):<div class="code-block"><pre><code data-setup="config"></code></pre><button class="icon-button code-copy" type="button" data-target="config" aria-label="Copy config" title="Copy config"></button></div></li>
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
          <li>Add SmartDoc as an MCP server. Most agents take a config entry like this:<div class="code-block"><pre><code data-setup="config"></code></pre><button class="icon-button code-copy" type="button" data-target="config" aria-label="Copy config" title="Copy config"></button></div></li>
          <li>Restart your agent and ask it to review your document. It opens this app whenever it needs it.</li>
        </ol>
      </div>
      <p class="setup-note">Keep SmartDoc in your Applications folder: these point at it there. If you move it, set up your agents again.</p>
    </section>
  </div>
</aside>

<div class="mcp-resizer" id="mcp-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the MCP server panel" aria-controls="mcp-card"></div>

<!-- A new variation: what it's for, and the prompt asking the AI to make it (see variation-card.js). -->
<dialog class="variation-dialog" id="variation-dialog" aria-labelledby="variation-title">
  <form method="dialog">
    <h2 id="variation-title">New variation</h2>
    <p id="variation-message"></p>
    <label for="variation-purpose">What’s the variation for?</label>
    <textarea id="variation-purpose" rows="4" placeholder="For example: tailor it to the product lead role at Acme. Paste the job spec here."></textarea>
    <div class="variation-buttons">
      <button class="secondary-button" type="button" id="variation-cancel">Cancel</button>
      <button class="primary-button" type="submit" id="variation-copy">Copy the prompt</button>
    </div>
  </form>
</dialog>

<!-- Shown at the bottom of the window once an update has downloaded (see settings.js). -->
<div class="update-toast" id="update-toast" role="status" hidden>
  <span id="update-toast-text"></span>
  <button class="primary-button" id="update-toast-restart" type="button">Restart to Update</button>
  <button class="secondary-button" id="update-toast-later" type="button">Later</button>
</div>

<!-- Settings, opened from the SmartDoc menu (see settings.js). -->
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
      <p class="setting-note">System matches your Mac’s appearance. Your documents stay as they are.</p>
    </section>
    <!-- The app's version and its updates, which download by themselves (see settings.js). -->
    <section class="setting">
      <h3 class="setting-title">Updates</h3>
      <p class="setting-line"><span id="update-version"></span> · <span id="update-state"></span></p>
      <button class="secondary-button" id="update-action" type="button">Check for Updates</button>
      <p class="setting-note">New versions download by themselves and install when SmartDoc quits.</p>
    </section>
  </div>
</dialog>
`;
