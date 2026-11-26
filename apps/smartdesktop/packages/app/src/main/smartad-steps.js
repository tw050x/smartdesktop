// What an AI is doing, from the SmartAd tool it calls, as the user would say it: each step the chat
// shows. A copy of SmartAd's own describe-step.js: keep the two alike.

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartad__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  switch (tool) {
    case 'list_ads': return 'Looking through the ads';
    case 'get_ad': return 'Reading the ad';
    case 'get_proposal': return 'Reading the proposal';
    case 'propose_ad': return input.name ? `Proposing ${quoted(input.name)}` : 'Proposing a change';
    case 'rename_ad': return input.name ? `Renaming the ad ${quoted(input.name)}` : 'Renaming an ad';
    case 'set_icon': return 'Choosing the ad’s icon';
    case 'view_frames': return 'Looking at the ad';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
