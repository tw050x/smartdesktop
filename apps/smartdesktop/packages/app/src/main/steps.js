// Each app's own words for its tools' steps (@smartdesktop/ui's main/steps, which the apps use too).
import { describeStep as smartdoc } from '@smartdesktop/ui/main/steps/smartdoc.js';
import { describeStep as smartspec } from '@smartdesktop/ui/main/steps/smartspec.js';
import { describeStep as smartad } from '@smartdesktop/ui/main/steps/smartad.js';
import { describeStep as smartprep } from '@smartdesktop/ui/main/steps/smartprep.js';
import { describeStep as smartplan } from '@smartdesktop/ui/main/steps/smartplan.js';

// Each step the chat shows, in words, by the app whose tool the AI called: Claude Code names a tool
// `mcp__<app>__<tool>`, Codex gives the tool and its server apart.
const BY_APP = { smartdoc, smartspec, smartad, smartprep, smartplan };

// The AI's own web tools (Claude Code's names; Codex's search is passed in as WebSearch).
const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; } };
const WEB = {
  WebFetch: ({ url }) => (host(url) ? `Reading ${host(url)}` : 'Reading a web page'),
  WebSearch: ({ query }) => (query ? `Searching the web for “${query}”` : 'Searching the web'),
};

export function describeStep(name, input = {}, server = null) {
  if (WEB[name]) return WEB[name](input ?? {});
  const named = /^mcp__([a-z]+)__(.+)$/.exec(name ?? '');
  const app = named?.[1] ?? server;
  const tool = named?.[2] ?? name ?? '';
  const describe = BY_APP[app];
  if (describe) return describe(tool, input ?? {});
  return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
