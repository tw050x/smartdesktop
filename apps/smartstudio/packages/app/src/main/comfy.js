import { MODELS, NODES } from './workflows.js';

// The generation server: ComfyUI, on a machine with a GPU (the user's GX10, at first), reached over
// its HTTP API at the address in Settings (`url()`, such as http://secondary.gx10:8188). It runs one
// job at a time, from a queue: a graph is sent (`submit`), it's found in the history once it's done
// (`history`), and its files are fetched from `/view`. How far along the job running is comes over
// its WebSocket (`watch`). ComfyUI has no accounts or tokens: it's for a network the user trusts.
// No Electron here, so the tests can run it against a stand-in server.

const TIMEOUT_MS = 8000;

export function createComfy({ url, clientId, fetch: fetchImpl = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket }) {
  const base = () => String(url() ?? '').replace(/\/+$/, '');
  async function request(pathname, { method = 'GET', body, form, timeout = TIMEOUT_MS, raw = false } = {}) {
    if (!base()) throw new Error('No generation server is set. Add its address in Settings.');
    let res;
    try {
      res = await fetchImpl(`${base()}${pathname}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: form ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error(`Couldn't reach the generation server at ${base()} (${error.cause?.code ?? error.name ?? 'no answer'}). Check it's running, and its address in Settings.`);
    }
    if (raw) {
      if (!res.ok) throw new Error(`The generation server answered ${res.status} for ${pathname}.`);
      return res;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const error = new Error(explain(json) ?? `The generation server answered ${res.status}.`);
      error.status = res.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  return {
    base,

    // Whether the server answers, what it runs on, and which kinds it can make now: each kind needs
    // its model files there (workflows.js's MODELS), and says which are missing. `features` says
    // the same of what needs SmartStudio's own nodes there (NODES): remaking part of a song.
    async status() {
      const stats = await request('/system_stats', { timeout: 4000 });
      const folders = [...new Set(Object.values(MODELS).flatMap((needs) => Object.keys(needs)))];
      const present = Object.fromEntries(await Promise.all(folders.map(async (folder) => [folder, new Set(await request(`/models/${folder}`, { timeout: 4000 }).catch(() => []))])));
      const kinds = Object.fromEntries(Object.entries(MODELS).map(([kind, needs]) => {
        const missing = Object.entries(needs).flatMap(([folder, files]) => files.filter((file) => !present[folder]?.has(file)));
        return [kind, { ready: missing.length === 0, missing }];
      }));
      const nodes = new Set((await Promise.all(Object.values(NODES).flat().map(async (node) => {
        const info = await request(`/object_info/${encodeURIComponent(node)}`, { timeout: 4000 }).catch(() => null);
        return info?.[node] ? node : null;
      }))).filter(Boolean));
      const features = Object.fromEntries(Object.entries(NODES).map(([feature, needs]) => {
        const missing = needs.filter((node) => !nodes.has(node));
        return [feature, { ready: missing.length === 0 && kinds.music.ready, missing }];
      }));
      const device = stats?.devices?.[0];
      return {
        reachable: true,
        url: base(),
        version: stats?.system?.comfyui_version ?? null,
        device: device ? device.name.replace(/^cuda:\d+\s+/, '').replace(/\s*:\s*\w+$/, '') : null,
        kinds,
        features,
      };
    },

    // Puts a file in the server's input folder, for a graph to read (LoadAudio, say): `name`, its
    // name there (the input folder's top, the only place ComfyUI's loaders look), replaced if it's
    // there already. Gives the name to load it by.
    async upload(name, bytes, type = 'application/octet-stream') {
      const form = new FormData();
      form.append('image', new Blob([bytes], { type }), name);
      form.append('type', 'input');
      form.append('overwrite', 'true');
      const answer = await request('/upload/image', { method: 'POST', form, timeout: 120_000 });
      if (!answer?.name) throw new Error('The generation server didn\'t take the file.');
      return answer.subfolder ? `${answer.subfolder}/${answer.name}` : answer.name;
    },

    // Sends a graph to run; gives its id there.
    async submit(graph) {
      const answer = await request('/prompt', { method: 'POST', body: { prompt: graph, client_id: clientId } });
      if (!answer?.prompt_id) throw new Error('The generation server didn\'t take the job.');
      return answer.prompt_id;
    },

    // A job once it's finished (done or failed), or null while it's still waiting or running.
    async history(promptId) {
      const all = await request(`/history/${encodeURIComponent(promptId)}`);
      return all?.[promptId] ?? null;
    },

    // Whether a job is still waiting or running on the server.
    async queued(promptId) {
      const queue = await request('/queue');
      const ids = [...(queue?.queue_running ?? []), ...(queue?.queue_pending ?? [])].map((item) => item?.[1]);
      return ids.includes(promptId);
    },

    // Stops a job: taken out of the queue if it's waiting, interrupted if it's the one running.
    async cancel(promptId) {
      await request('/queue', { method: 'POST', body: { delete: [promptId] } }).catch(() => {});
      await request('/interrupt', { method: 'POST', body: { prompt_id: promptId } }).catch(() => {});
    },

    // A file a job saved, as bytes.
    async download({ filename, subfolder = '', type = 'output' }) {
      const query = new URLSearchParams({ filename, subfolder, type });
      const res = await request(`/view?${query}`, { raw: true, timeout: 120_000 });
      return Buffer.from(await res.arrayBuffer());
    },

    // How far along jobs are, as the server says over its WebSocket: `onProgress({ promptId, value,
    // max, node })` for each step of the node running. Reconnects while it's wanted; `close()` stops.
    watch(onProgress) {
      if (!Socket) return { close() {} };
      let socket = null;
      let stopped = false;
      let retry = null;
      const open = () => {
        if (stopped || !base()) return;
        try {
          socket = new Socket(`${base().replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
        } catch {
          retry = setTimeout(open, 5000);
          return;
        }
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return; // previews of the images being made
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message?.type === 'progress' && message.data?.prompt_id) {
            onProgress({ promptId: message.data.prompt_id, value: message.data.value, max: message.data.max, node: message.data.node ?? null });
          }
        });
        socket.addEventListener('close', () => {
          socket = null;
          if (!stopped) retry = setTimeout(open, 5000);
        });
        socket.addEventListener('error', () => {});
      };
      open();
      return {
        // The address changed: start again there.
        restart() {
          clearTimeout(retry);
          socket?.close();
        },
        close() {
          stopped = true;
          clearTimeout(retry);
          socket?.close();
        },
      };
    },
  };
}

// ComfyUI's error for a graph it won't run, in a line: what's wrong and with which node.
export function explain(body) {
  if (!body) return null;
  const errors = Object.values(body.node_errors ?? {}).flatMap((node) => (node.errors ?? []).map((error) => `${node.class_type}: ${error.details || error.message}`));
  const missing = errors.filter((line) => /not in \[/.test(line));
  if (missing.length) return `The generation server doesn't have the model files for this: ${missing.map((line) => line.replace(/^.*?: (\w+): '([^']+)'.*$/, '$2')).join(', ')}.`;
  if (errors.length) return errors.slice(0, 3).join('; ');
  return body.error?.message ?? body.error ?? null;
}

// The first file a finished job saved (an audio's or a video's), from its history entry: ComfyUI
// lists each saving node's outputs by kind ('audio', 'images' for videos and pictures, 'gifs'…).
export function outputFile(entry) {
  for (const output of Object.values(entry?.outputs ?? {})) {
    for (const items of Object.values(output)) {
      if (!Array.isArray(items)) continue;
      const file = items.find((item) => item && typeof item === 'object' && item.filename && (item.type ?? 'output') === 'output');
      if (file) return file;
    }
  }
  return null;
}

// Why a job failed, from its history entry, in a line.
export function failure(entry) {
  const error = entry?.status?.messages?.find(([kind]) => kind === 'execution_error')?.[1];
  if (error) return `${error.node_type ?? 'A step'} failed: ${String(error.exception_message ?? 'no reason given').trim().split('\n')[0]}`;
  if (entry?.status?.messages?.some(([kind]) => kind === 'execution_interrupted')) return 'It was stopped on the generation server.';
  return 'The generation server couldn\'t make it.';
}
