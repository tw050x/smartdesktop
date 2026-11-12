import { describeStep as smartdoc } from './smartdoc-steps.js';
import { describeStep as smartspec } from './smartspec-steps.js';

// Each step the chat shows, in words, by the app whose tool the AI called: Claude Code names a tool
// `mcp__<app>__<tool>`, Codex gives the tool and its server apart.
const BY_APP = { smartdoc, smartspec };

export function describeStep(name, input = {}, server = null) {
  const named = /^mcp__([a-z]+)__(.+)$/.exec(name ?? '');
  const app = named?.[1] ?? server;
  const tool = named?.[2] ?? name ?? '';
  const describe = BY_APP[app];
  if (describe) return describe(tool, input ?? {});
  return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
