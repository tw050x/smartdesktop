// What an AI is doing, from the SmartSpec tool it calls, as the user would say it: each step the
// chat shows (main/agent.js). No Node here, so the website's demo can use it too.

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartspec__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  switch (tool) {
    case 'list_schematics': return 'Looking through the schematics';
    case 'get_schematic': return 'Reading the schematic';
    case 'get_schematic_item': return input.item_id ? `Reading ${quoted(input.item_id)}` : 'Reading an item';
    case 'get_proposal': return 'Reading the proposal';
    case 'get_comments': return 'Reading your comments';
    case 'reply_to_comment': return 'Answering your comment';
    case 'propose_schematic': return input.name ? `Proposing ${quoted(input.name)}` : 'Proposing a change';
    case 'list_domains': return 'Looking at the domains';
    case 'create_domain': return input.name ? `Making the domain ${quoted(input.name)}` : 'Making a domain';
    case 'rename_domain': return 'Renaming a domain';
    case 'move_schematic': return 'Moving a schematic';
    case 'list_folders': return 'Looking at the folders';
    case 'create_folder': return input.name ? `Making the folder ${quoted(input.name)}` : 'Making a folder';
    case 'rename_folder': return 'Renaming a folder';
    case 'move_domain': return 'Moving a domain';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
