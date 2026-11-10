// The AIs the chat panel runs: the user's own command-line AI, signed in with their own account
// on the provider's site (the app never sees the sign-in; the tool keeps it), installed from the
// app if they don't have it. Each runs non-interactively, streaming what it does, with SmartDoc's
// tools only (through the app's own MCP server), acting on the window the chat is in. Each
// conversation is one of the AI's sessions, resumed for each message; a finding's thread is
// branched from the draft's main conversation where the AI can do that. Each draft has a chat of its
// own.
//
// Two are supported: Claude (Claude Code) and ChatGPT (Codex CLI). Gemini CLI was tried and left
// out: Google no longer lets it run on a personal account.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeStep } from './describe-step.js';

const home = os.homedir();

const toml = (value) => JSON.stringify(value); // a JSON string is a TOML basic string

// An Apple silicon Mac, even with the app running under Rosetta (the installers check the same).
const appleSilicon = () => process.arch === 'arm64' || /Apple/.test(os.cpus()[0]?.model ?? '');
const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
};

// Each AI: how to find, check, sign in to, install and run it, and how to read what it reports.
export const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    tool: 'Claude Code',
    binary: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR', // where it keeps its settings and sign-in
    places: [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    // Without an API key in its environment it runs on the user's Claude account, not a key they
    // may have set for something else.
    dropEnv: ['ANTHROPIC_API_KEY'],
    statusArgs: ['auth', 'status', '--json'],
    readStatus(stdout) {
      const auth = JSON.parse(stdout);
      return { loggedIn: Boolean(auth.loggedIn), account: auth.authMethod === 'claude.ai' ? 'Claude account' : auth.authMethod ?? null };
    },
    signInArgs: ['auth', 'login', '--claudeai'],
    // Anthropic's own installer, which needs nothing else on the Mac.
    installer: { label: 'Anthropic’s installer', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    // What the installer downloads, and how big it is, to say how far it's got: the binary named in
    // its release's manifest, into ~/.claude/downloads, compressed if the Mac has zstd.
    async download({ home: installHome }) {
      const base = 'https://downloads.claude.ai/claude-code-releases';
      const latest = await fetch(`${base}/latest`, { signal: AbortSignal.timeout(15000) });
      const version = (await latest.text()).trim();
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('No version');
      const platform = `darwin-${appleSilicon() ? 'arm64' : 'x64'}`;
      const name = `claude-${version}-${platform}`;
      const [plain, packed] = await Promise.all([getJson(`${base}/${version}/manifest.json`), getJson(`${base}/${version}/manifest.zst.json`).catch(() => null)]);
      const sizes = {};
      if (plain.platforms?.[platform]?.size) sizes[name] = plain.platforms[platform].size;
      if (packed?.platforms?.[platform]?.size) sizes[`${name}.zst`] = packed.platforms[platform].size;
      return { dirs: [path.join(installHome, '.claude/downloads')], sizes };
    },
    installHelp: 'https://code.claude.com/docs/en/setup',
    args({ prompt, systemPrompt, mcp, resume, fork }) {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { smartdoc: { type: 'http', url: mcp.url, headers: mcp.headers } } }),
        '--tools', '', '--allowedTools', 'mcp__smartdoc', '--setting-sources', 'project',
        '--append-system-prompt', systemPrompt];
      if (resume) args.push('--resume', resume);
      else if (fork) args.push('--resume', fork, '--fork-session');
      return args;
    },
    // Claude Code's stream: its session, its replies and the tools it calls.
    read(event) {
      const out = { messages: [] };
      if (event.type === 'system' && event.session_id) out.sessionId = event.session_id;
      if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) {
          if (part.type === 'text' && part.text.trim()) out.messages.push({ role: 'assistant', text: part.text.trim() });
          else if (part.type === 'tool_use') out.messages.push({ role: 'step', text: describeStep(part.name, part.input) });
        }
      }
      if (event.type === 'result' && event.is_error) out.error = event.result || 'Claude stopped with an error.';
      return out;
    },
  },

  codex: {
    id: 'codex',
    name: 'ChatGPT',
    tool: 'Codex',
    binary: 'codex',
    homeEnv: 'CODEX_HOME',
    places: [path.join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    dropEnv: ['OPENAI_API_KEY'],
    statusArgs: ['login', 'status'],
    // It says where it stands on its error stream.
    readStatus(stdout, code, stderr) {
      const text = `${stdout}\n${stderr}`.trim();
      return { loggedIn: code === 0 && /Logged in/i.test(text) && !/Not logged in/i.test(text), account: /ChatGPT/i.test(text) ? 'ChatGPT account' : /API key/i.test(text) ? 'API key' : null };
    },
    signInArgs: ['login'],
    // OpenAI's own installer, which needs nothing else on the Mac (not Node or Homebrew). It asks
    // nothing when told not to (it would ask to start Codex, and to remove another copy).
    installer: { label: 'OpenAI’s installer', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', env: { CODEX_NON_INTERACTIVE: 'true' } },
    // What it downloads: its release's package for this Mac, into a new temporary folder (`mktemp
    // -d`, which on a Mac is in the user's own temporary folder, whatever TMPDIR says).
    async download({ temp }) {
      const asset = `codex-package-${appleSilicon() ? 'aarch64' : 'x86_64'}-apple-darwin.tar.gz`;
      const release = await getJson('https://releases.openai.com/codex/channels/latest');
      const url = release.assets?.find((a) => a.name === asset)?.browser_download_url;
      if (!url) throw new Error('No package');
      const size = Number((await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) })).headers.get('content-length'));
      return { dirs: temp, sizes: size ? { [asset]: size } : {} };
    },
    installHelp: 'https://developers.openai.com/codex/cli',
    // Its own config is left out: it can name a model a ChatGPT account isn't allowed, and SmartDoc
    // gives it only SmartDoc's tools. Read-only, it can't change anything on the Mac.
    args({ prompt, systemPrompt, mcp, resume, fork }) {
      const headers = Object.entries(mcp.headers).map(([k, v]) => `${toml(k)} = ${toml(v)}`).join(', ');
      const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only',
        '-c', `mcp_servers.smartdoc.url=${toml(mcp.url)}`, '-c', `mcp_servers.smartdoc.http_headers={ ${headers} }`];
      // It has no separate system prompt, so a new session's first message carries it.
      if (resume) return [...args, 'resume', resume, prompt];
      if (fork) return [...args, 'fork', fork, `${systemPrompt}\n\n${prompt}`];
      return [...args, `${systemPrompt}\n\n${prompt}`];
    },
    // Codex's stream: its thread, its replies and the tools it calls (each when it starts).
    read(event) {
      const out = { messages: [] };
      if (event.type === 'thread.started' && event.thread_id) out.sessionId = event.thread_id;
      const item = event.item ?? {};
      if (event.type === 'item.started' && item.type === 'mcp_tool_call') out.messages.push({ role: 'step', text: describeStep(item.tool, item.arguments) });
      if (event.type === 'item.completed' && item.type === 'agent_message' && item.text?.trim()) out.messages.push({ role: 'assistant', text: item.text.trim() });
      if (event.type === 'turn.failed') out.error = event.error?.message || 'ChatGPT stopped with an error.';
      if (event.type === 'error' && !out.error) out.error = event.message;
      return out;
    },
  },
};

// The chat a window's draft has: one for each draft of each variation of each document.
export const chatIdOf = (doc) => (doc ? `${doc.id}/${doc.variationId}/${doc.currentDraftId}` : null);

// The files in a folder and the folders in it, `depth` levels down, with their sizes, looking only
// in folders changed since `since`.
function filesIn(dir, depth, since) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const at = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        if (depth > 1 && fs.statSync(at).mtimeMs >= since) out.push(...filesIn(at, depth - 1, since));
      } else if (entry.isFile()) {
        const { size, mtimeMs } = fs.statSync(at);
        if (mtimeMs >= since) out.push({ path: at, size });
      }
    } catch {}
  }
  return out;
}

// `trial` (development builds only) shows the AIs as if not set up, to try the setup without
// touching the user's own: `home` gives each its own empty folder for its settings and sign-in (so
// it's signed out, and signing in there leaves the real sign-in alone), and a home folder of its
// own for installing into (so the installers leave the user's tools and shell profile alone), and
// `hide` lists AIs to treat as not installed until they're installed from the app.
export function createAgent({ userData, mcp, onEvent, trial = null }) {
  const hidden = new Set((trial?.hide ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  const chatsDir = path.join(userData, 'chats');
  const workDir = path.join(userData, 'agent'); // an empty folder to run in, so no project settings load
  const running = new Map(); // `${chatId}:${conversation}` → child process
  const found = new Map(); // provider id → the path to its tool, once found
  let shellPath = null;

  // The user's login shell's PATH: an app opened from the Finder doesn't get it, and tools
  // installed with npm (and Node itself) are only on it.
  async function loginPath() {
    if (shellPath !== null) return shellPath;
    shellPath = await new Promise((resolve) => {
      execFile(process.env.SHELL || '/bin/zsh', ['-lc', 'echo "$PATH"'], { timeout: 8000 }, (error, stdout) => resolve(error ? '' : stdout.trim()));
    });
    return shellPath;
  }
  const env = async (provider) => {
    const rest = { ...process.env };
    for (const key of provider.dropEnv) delete rest[key];
    if (trial?.home) {
      const own = path.join(trial.home, provider.id);
      fs.mkdirSync(own, { recursive: true });
      rest[provider.homeEnv] = own;
    }
    const tool = found.get(provider.id);
    return { ...rest, PATH: [tool && path.dirname(tool), await loginPath(), rest.PATH ?? '/usr/bin:/bin'].filter(Boolean).join(':') };
  };

  // The Mac's own temporary folder for the user, where `mktemp` makes its folders.
  let tempDir = null;
  const userTemp = async () => (tempDir ??= await new Promise((resolve) => {
    execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { timeout: 4000 }, (error, stdout) => resolve(error ? os.tmpdir() : stdout.trim()));
  }));

  // Where an AI's installer puts things: the user's home, or in a trial, a home of its own.
  const installHome = (provider) => (trial?.home ? path.join(trial.home, provider.id, 'home') : home);

  async function find(provider, fresh = false) {
    if (hidden.has(provider.id)) return null;
    if (!fresh && found.has(provider.id)) return found.get(provider.id);
    const places = trial?.home ? [path.join(installHome(provider), '.local/bin', provider.binary), ...provider.places] : provider.places;
    let at = places.find((place) => fs.existsSync(place)) ?? null;
    if (!at) {
      const PATH = await loginPath();
      at = PATH.split(':').map((dir) => path.join(dir, provider.binary)).find((place) => fs.existsSync(place)) ?? null;
    }
    if (at) found.set(provider.id, at);
    else found.delete(provider.id);
    return at;
  }

  const run = (file, args, options) => new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, error }));
  });

  // Where each AI stands: installed, signed in, and how it could be installed if it isn't.
  async function status() {
    const all = {};
    for (const provider of Object.values(PROVIDERS)) {
      const base = { id: provider.id, name: provider.name, tool: provider.tool, installers: [provider.installer.label], installHelp: provider.installHelp };
      const tool = await find(provider, true);
      if (!tool) {
        all[provider.id] = { ...base, installed: false, loggedIn: false };
        continue;
      }
      const result = await run(tool, provider.statusArgs, { env: await env(provider), timeout: 15000 });
      try {
        all[provider.id] = { ...base, installed: true, ...provider.readStatus(result.stdout, result.code, result.stderr) };
      } catch {
        all[provider.id] = { ...base, installed: true, loggedIn: false };
      }
    }
    return all;
  }

  // The tool's own sign-in: it opens the provider's page in the browser, and keeps the sign-in.
  async function signIn(id, onProgress = () => {}) {
    onProgress({ id, stage: 'sign-in', line: `Waiting for you to sign in to ${PROVIDERS[id].name} in your browser…` });
    const provider = PROVIDERS[id];
    const tool = await find(provider);
    if (!tool) throw new Error(`${provider.tool} isn’t installed.`);
    await new Promise(async (resolve) => {
      const child = spawn(tool, provider.signInArgs, { env: await env(provider), stdio: 'ignore' });
      child.on('exit', resolve);
      child.on('error', resolve);
    });
    return status();
  }

  // Installs the tool the way its maker publishes it, when the user asks, saying how it's getting
  // on (`onProgress({ id, stage, line, percent })`): getting ready, how much of its download has
  // arrived (the file the installer is writing, against the size its maker publishes for it), then
  // setting up. Without the size (offline, or the maker changed how it's published), no percentage.
  async function install(id, onProgress = () => {}) {
    const provider = PROVIDERS[id];
    const { installer } = provider;
    const say = (line, percent = null) => onProgress({ id, stage: 'install', line, percent });
    say(`Getting ready to install ${provider.tool}…`);
    const started = Date.now();
    const tmp = path.join(userData, 'installs', `${id}-${started}`);
    await mkdir(tmp, { recursive: true });
    const into = installHome(provider);
    await mkdir(into, { recursive: true });

    let expected = null;
    const temp = [...new Set([tmp, await userTemp(), os.tmpdir(), '/tmp'].map((dir) => dir.replace(/\/$/, '')))];
    provider.download?.({ home: into, temp }).then((e) => (expected = e), () => {});
    let shown = -1;
    let downloaded = false;
    const watch = setInterval(() => {
      if (!expected || downloaded) return;
      let percent = null;
      // Only what's been written since it started: not one left from before.
      for (const file of expected.dirs.flatMap((dir) => filesIn(dir, 2, started - 1000))) {
        const size = expected.sizes[path.basename(file.path)];
        if (size) percent = Math.max(percent ?? 0, Math.min(100, Math.floor((file.size / size) * 100)));
      }
      if (percent === null) return;
      if (percent >= 100) {
        downloaded = true;
        say(`Setting up ${provider.tool}…`);
      } else if (percent !== shown) say(`Downloading ${provider.tool}…`, (shown = percent));
    }, 250);

    const lines = [];
    const code = await new Promise(async (resolve) => {
      const environment = { ...(await env(provider)), ...installer.env, TMPDIR: `${tmp}/`, HOME: into };
      const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', installer.command], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
      // What it says is kept to explain a failure.
      const take = (chunk) => {
        for (const raw of String(chunk).split(/[\r\n]+/)) {
          const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u2800-\u28ff]/g, '').trim();
          if (line) lines.push(line);
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('exit', (exit) => {
        clearTimeout(timer);
        resolve(exit ?? 1);
      });
      child.on('error', () => resolve(1));
    });
    clearInterval(watch);
    fs.rm(tmp, { recursive: true, force: true }, () => {});
    shellPath = null; // a new install may have changed it
    if (code) throw new Error(`Installing ${provider.tool} didn’t work: ${lines.at(-1) || 'it stopped with an error'}.`);
    hidden.delete(provider.id);
    return status();
  }

  // --- Conversations, kept for each draft --------------------------------------------------------
  // Each draft has its own chat (`chatId`, from `chatIdOf`): going back to a draft shows what was
  // said on it, and a new draft starts a new chat, with a new session for the AI. A draft preview
  // belongs to the chat of the draft it was made from, until it's accepted. Each conversation has
  // the AI's session for each AI it has talked to (`sessions`), so switching AI starts that AI
  // afresh rather than losing the other's.

  const chatFile = (chatId) => path.join(chatsDir, ...chatId.split('/').map((part) => part.replace(/[^\w.-]/g, '_'))) + '.json';
  async function load(chatId) {
    let chats;
    try {
      chats = JSON.parse(await readFile(chatFile(chatId), 'utf8'));
    } catch {
      chats = { main: { messages: [] }, threads: {} };
    }
    for (const convo of [chats.main, ...Object.values(chats.threads ?? {})]) convo.sessions ??= {};
    return chats;
  }
  async function save(chatId, chats) {
    await mkdir(path.dirname(chatFile(chatId)), { recursive: true });
    await writeFile(chatFile(chatId), JSON.stringify(chats, null, 2));
  }

  const conversationOf = (chats, key) => (key === 'main' ? chats.main : (chats.threads[key] ??= { sessions: {}, messages: [] }));
  const hasSession = async (chatId, conversation, id) => Boolean(conversationOf(await load(chatId), conversation).sessions[id]);

  // Sends the user's message in a conversation ('main' or a finding's id) to an AI, and streams
  // what it does back through onEvent (with the window it was sent from, and the draft's chat),
  // keeping it all with the draft.
  async function send({ provider: id, windowId, chatId, conversation, text, prompt, systemPrompt, sessionHeaders }) {
    const provider = PROVIDERS[id] ?? PROVIDERS.claude;
    const key = `${chatId}:${conversation}`;
    if (running.has(key)) throw new Error(`${provider.name} is still working on this.`);
    const tool = await find(provider);
    if (!tool) throw new Error(`${provider.tool} isn’t installed.`);
    await mkdir(workDir, { recursive: true });
    const chats = await load(chatId);
    const convo = conversationOf(chats, conversation);
    const add = async (message) => {
      convo.messages.push({ id: `m-${Date.now().toString(36)}-${convo.messages.length}`, at: new Date().toISOString(), by: provider.id, ...message });
      await save(chatId, chats);
      onEvent({ windowId, chatId, conversation, type: 'messages', messages: convo.messages });
    };
    await add({ role: 'user', text });

    // A thread's first message branches from the main conversation with the same AI, if any.
    const resume = convo.sessions[provider.id] ?? null;
    const fork = !resume && conversation !== 'main' ? chats.main.sessions[provider.id] ?? null : null;
    const args = provider.args({ prompt: prompt ?? text, systemPrompt, mcp: mcp(sessionHeaders), resume, fork });

    const child = spawn(tool, args, { cwd: workDir, env: await env(provider), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    running.set(key, child);
    onEvent({ windowId, chatId, conversation, type: 'running', running: true });
    let buffer = '';
    let errors = '';
    let replied = false;
    let failed = null;
    const handle = async (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const out = provider.read(event);
      if (out.sessionId && convo.sessions[provider.id] !== out.sessionId) {
        convo.sessions[provider.id] = out.sessionId;
        await save(chatId, chats);
      }
      for (const message of out.messages) {
        if (message.role === 'assistant') replied = true;
        await add(message);
      }
      if (out.error) failed = out.error;
    };
    let queue = Promise.resolve();
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) queue = queue.then(() => handle(line));
    });
    child.stderr.on('data', (chunk) => (errors += chunk));
    return new Promise((resolve) => {
      const finish = async (code) => {
        await queue;
        if (buffer.trim()) await handle(buffer);
        running.delete(key);
        if (child.stopped) await add({ role: 'step', text: 'Stopped' });
        else if (failed && !replied) await add({ role: 'error', text: failed });
        else if (code && !replied) await add({ role: 'error', text: errors.trim().split('\n').at(-1) || `${provider.name} couldn’t run.` });
        onEvent({ windowId, chatId, conversation, type: 'running', running: false });
        resolve();
      };
      child.on('exit', finish);
      child.on('error', (error) => {
        errors += error.message;
        finish(1);
      });
    });
  }

  function stop(chatId, conversation) {
    const child = running.get(`${chatId}:${conversation}`);
    if (!child) return;
    child.stopped = true;
    child.kill('SIGTERM');
  }

  const runningIn = (chatId) => [...running.keys()].filter((key) => key.startsWith(`${chatId}:`)).map((key) => key.slice(chatId.length + 1));

  return { status, signIn, install, load, hasSession, send, stop, runningIn };
}
