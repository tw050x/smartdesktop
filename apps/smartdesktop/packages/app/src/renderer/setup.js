import { clearAiProgress, failureText, progressLine, progressMark, trackAiProgress } from './ai-progress.js';

// The setup window (see main.js): the AIs the chat runs, a row each with its name, where it stands
// and the one thing to do next, installed with its maker's own installer and signed in to in the
// browser. It opens the first time SmartDesktop runs, from the app menu's (or the Dock icon's) Set Up AI…, and from
// the chat when the AI chosen there isn't ready. (It was the AI half of each app's status panel.)
const api = window.smartdesktop;
document.body.classList.add(`platform-${api.platform}`);
const list = document.getElementById('ai-list');
trackAiProgress(api);
const busy = new Set(); // the AIs being installed or signed in to: each its own, at once
const failed = {}; // provider id → why its install or sign-in didn't work, shown once

async function show(statuses) {
  if (!statuses) {
    try {
      statuses = await api.agentStatus();
    } catch {
      statuses = {};
    }
  }
  list.replaceChildren();
  for (const s of Object.values(statuses)) {
    const row = document.createElement('div');
    row.className = 'ai-row';
    const text = document.createElement('div');
    text.className = 'ai-row-text';
    const name = document.createElement('strong');
    // Named by the AI, and the tool that runs it (Claude Code, Codex), with where it stands below.
    name.textContent = `${s.name} (${s.tool})`;
    let state = document.createElement('span');
    const ready = s.installed && s.loggedIn;
    state.textContent = ready ? `Signed in${s.account ? ` with your ${s.account}` : ''}` : s.installed ? 'Not signed in' : 'Not installed';
    if (failed[s.id] && !busy.has(s.id)) {
      state.textContent = failed[s.id];
      delete failed[s.id];
    }
    // While it's being installed or signed in to, where that's got to, in words.
    if (busy.has(s.id)) state = progressLine(s.id, s.installed ? 'Waiting for you to sign in in your browser…' : `Getting ready to install ${s.tool}…`);
    text.append(name, state);
    // Not ready: what the button does, in a line.
    const maker = s.id === 'codex' ? 'OpenAI' : 'Anthropic';
    const how = !s.installed
      ? (s.installers?.length ? `Install sets up ${s.tool} with ${maker}’s own installer, then you sign in.` : `${s.tool} can’t be installed from here on this Mac: Get it opens ${maker}’s page about it.`)
      : !s.loggedIn ? `Sign in opens ${s.name}’s sign-in page in your browser. Sign in there, then come back.` : null;
    if (how) text.append(Object.assign(document.createElement('span'), { className: 'ai-row-how', textContent: how }));
    row.append(text);
    if (ready) {
      row.append(Object.assign(document.createElement('span'), { className: 'ai-ready', textContent: 'Ready' }));
    } else {
      const act = (label, run) => {
        // While it runs, the percentage done (or a spinner) takes the button's place.
        if (busy.has(s.id)) return progressMark(s.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-button';
        button.textContent = label;
        button.addEventListener('click', async () => {
          busy.add(s.id);
          show(statuses);
          let next = null;
          try {
            next = await run();
          } catch (error) {
            failed[s.id] = failureText(error);
          }
          busy.delete(s.id);
          clearAiProgress(s.id);
          show(next ?? undefined);
        });
        return button;
      };
      if (!s.installed && s.installers?.length) row.append(act('Install', () => api.agentInstall(s.id)));
      else if (!s.installed) row.append(act('Get it', () => api.agentInstallHelp(s.id).then(() => null)));
      else row.append(act('Sign in', () => api.agentSignIn(s.id)));
    }
    list.append(row);
  }
}

document.getElementById('setup-done').addEventListener('click', () => window.close());
// Coming back from the browser after signing in, or from installing by hand: where they stand now.
window.addEventListener('focus', () => !busy.size && show());
show();
