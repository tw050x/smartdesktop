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
    <span class="crumb-sep" aria-hidden="true">/</span>
    <button class="tool-button" id="tool-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="tool-card">
      <span id="tool-label"></span>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <span class="crumb-sep" id="focus-sep" aria-hidden="true" hidden>/</span>
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
      <span class="server-dot" aria-hidden="true"></span><span id="server-pill-label">MCP server</span>
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
        </section>
        <section class="home-column" aria-labelledby="home-drafts-title">
          <div class="home-column-head"><h2 id="home-drafts-title">Drafts</h2></div>
          <ul class="home-list" id="home-drafts"></ul>
        </section>
      </div>
    </div>
    <!-- The pages, with the review laid over them and their margins (see margin-review.js). -->
    <div class="pages-wrap">
      <div class="pages" id="pages"></div>
      <div class="margin-layer" id="margin-layer"></div>
    </div>
  </section>
  <!-- A highlights review as a list, in place of the document (see highlights-list.js). -->
  <section class="list-view" id="list-view" aria-label="Highlights"></section>
  <div class="scrollbar" id="scrollbar" aria-hidden="true"><div class="scrollbar-thumb" id="scrollbar-thumb"></div></div>
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
          <span id="app-picker-label">Claude Code</span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="app-picker-menu" id="app-picker-menu" role="menu" hidden>
          <button type="button" role="menuitemradio" data-app="claude-code" aria-checked="true">Claude Code</button>
          <button type="button" role="menuitemradio" data-app="claude-desktop" aria-checked="false">Claude Desktop</button>
        </div>
      </div>
      <div class="tab-panel" id="setup-claude-code">
        <ol class="setup-steps">
          <li>Copy the setup command:<div class="code-block"><pre><code data-setup="claude-code"></code></pre><button class="icon-button code-copy" type="button" data-target="claude-code" aria-label="Copy command" title="Copy command"></button></div></li>
          <li>Paste it into a terminal and press Return. Or paste it into a Claude Code chat and ask Claude to add the server.</li>
          <li>Start a new Claude Code session. Type <code>/mcp</code> to check it’s connected. Claude opens this app whenever it needs it.</li>
        </ol>
      </div>
      <div class="tab-panel" id="setup-claude-desktop" hidden>
        <ol class="setup-steps">
          <li>Download SmartDoc for Claude Desktop from the website: <button class="secondary-button" id="open-website" type="button">Open the website</button></li>
          <li>Open the downloaded file. Claude Desktop shows what it installs; choose Install.</li>
          <li>Start a new chat and ask Claude to review your document. It opens this app whenever it needs it.</li>
        </ol>
      </div>
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
`;
