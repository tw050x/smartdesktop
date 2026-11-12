// The AIs the chat runs: the user's own command-line AI, signed in with their own account on the
// provider's site (SmartDesktop never sees the sign-in; the tool keeps it), installed from the setup
// window if they don't have it. Each runs non-interactively, streaming what it does, with the tools
// of the apps connected to SmartDesktop (SmartDoc's and SmartSpec's MCP servers), acting on the
// window of each that the user was last in. There's one conversation, across both apps, which is one
// of the AI's sessions, resumed for each message.
//
// Two are supported: Claude (Claude Code) and ChatGPT (Codex CLI). Gemini CLI was tried and left
// out: Google no longer lets it run on a personal account.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeStep } from './steps.js';

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
    // The models to choose from, each by its full name, so the version chosen is the one used (the
    // user wanted versions shown; Claude Code's aliases follow whichever is newest). Update this as
    // Claude's models change.
    models: () => [
      { id: 'claude-fable-5-1', name: 'Fable 5.1' },
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
    ],
    args({ prompt, systemPrompt, where, servers, resume, model }) {
      const mcpServers = Object.fromEntries(servers.map((s) => [s.name, { type: 'http', url: s.url, headers: s.headers }]));
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }),
        '--tools', '', '--allowedTools', servers.map((s) => `mcp__${s.name}`).join(','), '--setting-sources', 'project',
        '--append-system-prompt', `${systemPrompt}\n\n${where}`];
      if (model) args.push('--model', model);
      if (resume) args.push('--resume', resume);
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
    // Its own config is left out: it can name a model a ChatGPT account isn't allowed, and SmartDesktop
    // gives it only the apps' tools. Read-only, it can't change anything on the Mac.
    // The models to choose from: those Codex's own catalogue lists for the account (the
    // models_cache.json it keeps in its home), in its order.
    models: (environment) => {
      try {
        const file = path.join(environment.CODEX_HOME ?? path.join(home, '.codex'), 'models_cache.json');
        const { models = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
        return models.filter((m) => m.visibility === 'list' && m.slug).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, about: m.description ?? null }));
      } catch {
        return [];
      }
    },
    args({ prompt, systemPrompt, where, servers, resume, model }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only'];
      for (const s of servers) {
        const headers = Object.entries(s.headers).map(([k, v]) => `${toml(k)} = ${toml(v)}`).join(', ');
        args.push('-c', `mcp_servers.${s.name}.url=${toml(s.url)}`, '-c', `mcp_servers.${s.name}.http_headers={ ${headers} }`);
      }
      if (model) args.push('-m', model);
      // It has no separate system prompt, so a new session's first message carries it, and each
      // later one where things are now (which apps and windows are open, and what they show).
      if (resume) return [...args, 'resume', resume, `[${where}]\n\n${prompt}`];
      return [...args, `${systemPrompt}\n\n${where}\n\n${prompt}`];
    },
    // Codex's stream: its thread, its replies and the tools it calls (each when it starts).
    read(event) {
      const out = { messages: [] };
      if (event.type === 'thread.started' && event.thread_id) out.sessionId = event.thread_id;
      const item = event.item ?? {};
      if (event.type === 'item.started' && item.type === 'mcp_tool_call') out.messages.push({ role: 'step', text: describeStep(item.tool, item.arguments, item.server) });
      if (event.type === 'item.completed' && item.type === 'agent_message' && item.text?.trim()) out.messages.push({ role: 'assistant', text: item.text.trim() });
      if (event.type === 'turn.failed') out.error = event.error?.message || 'ChatGPT stopped with an error.';
      if (event.type === 'error' && !out.error) out.error = event.message;
      return out;
    },
  },
};

// An AI saying the session it was asked to carry on isn't there (Codex: "no rollout found";
// Claude Code: "No conversation found").
export const sessionGone = (text) => /no rollout found|no conversation found|session[^\n]*(not found|does not exist|doesn.t exist)/i.test(text);


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

// What the user did or looked at in the apps since their last message (the conversation's context
// lines: see note), to go before their next message to the AI, so it knows what they're asking
// about. Empty when there's nothing new.
export function contextFor(messages) {
  const since = messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1).filter((m) => m.kind === 'context');
  if (!since.length) return '';
  return `[What I've done in the apps since my last message, for context:\n${since.map((m) => `- ${m.detail ?? m.text}`).join('\n')}]\n\n`;
}

// The AI ends a reply with any follow-up questions it suggests as <suggest>…</suggest> lines (see
// the chat's system prompt): taken out of what's shown and kept as the message's `suggestions`, for
// the chat to offer as shortcuts. At most three.
const SUGGEST = /<suggest>([\s\S]*?)<\/suggest>/g;
export function withSuggestions(message) {
  if (message.role !== 'assistant' || !message.text?.includes('<suggest>')) return message;
  const suggestions = [...message.text.matchAll(SUGGEST)].map((match) => match[1].replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
  const text = message.text.replace(SUGGEST, '').replace(/\n{3,}/g, '\n\n').trim();
  return { ...message, text, ...(suggestions.length && { suggestions }) };
}

// The AI names a chat with its first reply, as a <title>…</title> line (see the chat's system
// prompt): taken out of what's shown, and given back as `title` for the chat's tab.
const TITLE = /<title>([\s\S]*?)<\/title>/g;
export function withTitle(message) {
  if (message.role !== 'assistant' || !message.text?.includes('<title>')) return { message, title: null };
  const title = [...message.text.matchAll(TITLE)].map((match) => match[1].replace(/\s+/g, ' ').trim()).find(Boolean) ?? null;
  const text = message.text.replace(TITLE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { message: { ...message, text }, title: title && title.slice(0, 60) };
}

// `trial` (development builds only) shows the AIs as if not set up, to try the setup without
// touching the user's own: `home` gives each its own empty folder for its settings and sign-in (so
// it's signed out, and signing in there leaves the real sign-in alone), and a home folder of its
// own for installing into (so the installers leave the user's tools and shell profile alone), and
// `hide` lists AIs to treat as not installed until they're installed from the app.
export function createAgent({ userData, onEvent, trial = null }) {
  const hidden = new Set((trial?.hide ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  const workDir = path.join(userData, 'agent'); // an empty folder to run in, so no project settings load
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
        all[provider.id] = { ...base, installed: false, loggedIn: false, models: [] };
        continue;
      }
      // The models it offers, to choose from in the chat (none known: just its own default).
      base.models = provider.models?.(await env(provider)) ?? [];
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

  // --- The chats ------------------------------------------------------------------------------
  // Several (the user's choice: each a conversation of its own, in a tab of the chat window), each
  // across both apps' tabs it owns: what the user does there goes into it as lines of context (note),
  // so the AI knows, and it reads in the order things happened. Each has the AI's session for each AI
  // it has talked to (`sessions`), so switching AI starts that AI afresh rather than losing the
  // other's, and its own AI process while it works (chats can work at the same time). Each is a file
  // of its own, chats/<id>.json ({ id, title, titleBy, createdAt, messages, sessions }), held in
  // memory once read, so lines and replies arriving at once never lose each other.

  const chatsDir = path.join(userData, 'chats');
  const chatFile = (id) => path.join(chatsDir, `${String(id).replace(/[^\w-]/g, '_')}.json`);
  const cache = new Map(); // chat id → its chat, once read
  const running = new Map(); // chat id → its AI's process while it works
  const NEW_TITLE = 'New chat';

  // The one conversation there was before chats had tabs (chat.json) becomes the first chat.
  let migrated = null;
  const migrate = () => (migrated ??= (async () => {
    const old = path.join(userData, 'chat.json');
    if (!fs.existsSync(old)) return;
    try {
      await mkdir(chatsDir, { recursive: true });
      const chat = JSON.parse(await readFile(old, 'utf8'));
      const id = newId();
      await writeFile(chatFile(id), JSON.stringify({ id, title: 'Earlier chat', titleBy: 'ai', createdAt: chat.messages?.find((m) => m.at)?.at ?? new Date().toISOString(), messages: chat.messages ?? [], sessions: chat.sessions ?? {} }, null, 2));
      fs.renameSync(old, `${old}.moved`);
    } catch {}
  })());

  const newId = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  async function load(id) {
    await migrate();
    if (cache.has(id)) return cache.get(id);
    let chat;
    try {
      chat = JSON.parse(await readFile(chatFile(id), 'utf8'));
    } catch {
      return null;
    }
    chat.messages ??= [];
    chat.sessions ??= {};
    chat.title ??= NEW_TITLE;
    cache.set(id, chat);
    return chat;
  }
  async function save(chat) {
    await mkdir(chatsDir, { recursive: true });
    await writeFile(chatFile(chat.id), JSON.stringify(chat, null, 2));
  }
  const tell = (chat) => onEvent({ chatId: chat.id, type: 'messages', messages: chat.messages });
  const need = async (id) => {
    const chat = await load(id);
    if (!chat) throw new Error('That chat isn’t there any more.');
    return chat;
  };

  // A new chat, named "New chat" until the AI names it (see withTitle) or the user does.
  async function create() {
    await migrate();
    const id = newId();
    const chat = { id, title: NEW_TITLE, titleBy: null, createdAt: new Date().toISOString(), messages: [], sessions: {} };
    cache.set(id, chat);
    await save(chat);
    return chat;
  }

  // Every chat kept: { id, title, createdAt }, newest first.
  async function list() {
    await migrate();
    let files = [];
    try {
      files = (await fs.promises.readdir(chatsDir)).filter((f) => f.endsWith('.json'));
    } catch {}
    const all = [];
    for (const file of files) {
      const chat = await load(file.replace(/\.json$/, ''));
      if (chat) all.push({ id: chat.id, title: chat.title, createdAt: chat.createdAt });
    }
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // The user names a chat: the AI's name never replaces it.
  async function rename(id, title) {
    const chat = await need(id);
    chat.title = String(title ?? '').trim() || NEW_TITLE;
    chat.titleBy = 'user';
    await save(chat);
    onEvent({ chatId: id, type: 'title', title: chat.title });
  }

  // Sends the user's message in a chat to an AI, and streams what it does back through onEvent.
  // `servers` are the connected apps' MCP servers ({ name, url, headers }), and `where` says what's
  // open in the chat's own tabs: both given afresh for each message, as they change between
  // messages. `turn()` is called as the AI starts, and again every few seconds while it works (the
  // apps keep its session alive by it).
  async function send(id, { provider: providerId, text, prompt, systemPrompt, where = '', servers, model = null, turn = () => {} }) {
    const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
    if (running.has(id)) throw new Error(`${provider.name} is still working on the last message in this chat.`);
    const tool = await find(provider);
    if (!tool) throw new Error(`${provider.tool} isn’t installed.`);
    await mkdir(workDir, { recursive: true });
    const chat = await need(id);
    // What the user has done in the chat's tabs since their last message goes with this one (see note).
    const context = contextFor(chat.messages);
    const add = async (message) => {
      const { message: shown, title } = withTitle(withSuggestions({ id: `m-${Date.now().toString(36)}-${chat.messages.length}`, at: new Date().toISOString(), by: provider.id, ...message }));
      if (title && chat.titleBy !== 'user' && chat.title === NEW_TITLE) {
        chat.title = title;
        chat.titleBy = 'ai';
        onEvent({ chatId: id, type: 'title', title });
      }
      // A reply that was only its title (and questions) adds nothing to read.
      if (shown.role !== 'assistant' || shown.text || shown.suggestions) chat.messages.push(shown);
      await save(chat);
      tell(chat);
    };
    // Another AI than the one last talked to: a line across saying so, as it doesn't know what the
    // other said (a new session, or back to its own from before).
    const lastBy = chat.messages.findLast((m) => m.role === 'user' || m.role === 'assistant')?.by;
    if (lastBy && lastBy !== provider.id) {
      await add({ role: 'event', text: chat.sessions[provider.id] ? `Back to ${provider.name}` : `New session with ${provider.name}` });
    }
    await add({ role: 'user', text });
    const resume = chat.sessions[provider.id] ?? null;
    running.set(id, null);
    onEvent({ chatId: id, type: 'running', running: true });

    let child = null;
    let code = 1;
    let replied = false;
    let failed = null;
    let errors = '';
    let keepAlive = null;
    try {
      // Only a model the AI offers (see models), else its own default.
      const chosen = model && (provider.models?.(await env(provider)) ?? []).some((m) => m.id === model) ? model : null;
      const args = provider.args({ prompt: context + (prompt ?? text), systemPrompt, where, servers, resume, model: chosen });
      turn();
      keepAlive = setInterval(turn, 10 * 1000);
      child = spawn(tool, args, { cwd: workDir, env: await env(provider), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      running.set(id, child);
      let buffer = '';
      const handle = async (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const out = provider.read(event);
        if (out.sessionId && chat.sessions[provider.id] !== out.sessionId) {
          chat.sessions[provider.id] = out.sessionId;
          await save(chat);
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
      code = await new Promise((resolve) => {
        const finish = async (exit) => {
          await queue;
          if (buffer.trim()) await handle(buffer);
          resolve(exit ?? 1);
        };
        child.on('exit', finish);
        child.on('error', (error) => {
          errors += error.message;
          finish(1);
        });
      });
    } finally {
      clearInterval(keepAlive);
      running.delete(id);
    }
    // The AI's session has gone (its data cleared, or the AI reinstalled): said plainly, with a way
    // to start a new session (newSession), rather than the AI's own error, so the user can fix it
    // instead if they can.
    const gone = !child?.stopped && !replied && resume && sessionGone(`${failed ?? ''}\n${errors}`);
    if (child?.stopped) await add({ role: 'step', text: 'Stopped' });
    else if (gone) await add({ role: 'error', kind: 'session-gone', provider: provider.id, text: `${provider.name} couldn’t carry on this conversation: its earlier session for it can’t be found. Its data may have been cleared, or ${provider.tool} reinstalled. If you can get it back, send your message again; otherwise start a new session, which won’t remember what was said here before.` });
    else if (failed && !replied) await add({ role: 'error', text: failed });
    else if (code && !replied) await add({ role: 'error', text: errors.trim().split('\n').at(-1) || `${provider.name} couldn’t run.` });
    onEvent({ chatId: id, type: 'running', running: false });
  }

  // A new session with an AI, the user's choice once its old one has gone: the next message starts
  // afresh, after a line saying so.
  async function newSession(id, providerId) {
    const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
    const chat = await need(id);
    delete chat.sessions[provider.id];
    chat.messages.push({ id: `m-${Date.now().toString(36)}-${chat.messages.length}`, at: new Date().toISOString(), role: 'event', text: `New session with ${provider.name}` });
    await save(chat);
    tell(chat);
  }

  function stop(id) {
    const child = running.get(id);
    if (!child) return;
    child.stopped = true;
    child.kill('SIGTERM');
  }

  // What the user did or looked at in one of the chat's tabs, as a quiet line in its conversation:
  // not sent to the AI by itself, but with the user's next message (contextFor), so it knows what has
  // happened and what they were looking at. `detail` is what the AI is told, if it needs more than
  // the line says. Looking at something new replaces a line about what they looked at before, if
  // nothing came between, so the conversation doesn't fill with them.
  async function note(id, { text, detail = null, focus = false, about = null } = {}) {
    if (!text) return;
    const chat = await load(id);
    if (!chat) return;
    const { messages } = chat;
    const last = messages.at(-1);
    if (last?.kind === 'context' && last.text === text) return;
    const entry = { id: `m-${Date.now().toString(36)}-${messages.length}`, at: new Date().toISOString(), role: 'event', kind: 'context', text, ...(detail && { detail }), ...(focus && { focus: true }), ...(about && { about }) };
    if (focus && last?.kind === 'context' && last.focus) messages[messages.length - 1] = entry;
    else messages.push(entry);
    await save(chat);
    tell(chat);
  }

  return { status, signIn, install, create, list, load, rename, send, newSession, note, stop, isRunning: (id) => running.has(id) };
}
