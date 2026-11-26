// What an AI is doing, from the SmartPlan tool it calls, as the user would say it: each step the
// chat shows (SmartDesktop's agent.js, which keeps a copy of this). No Node here, so a website's
// demo could use it too.

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartplan__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  const cards = (list) => (list?.length === 1 ? `the card ${quoted(list[0].title ?? list[0])}` : `${list?.length ?? 0} cards`);
  switch (tool) {
    case 'list_boards': return 'Looking through the boards';
    case 'create_board': return input.name ? `Starting the board ${quoted(input.name)}` : 'Starting a board';
    case 'get_board': return 'Reading the board';
    case 'rename_board': return input.name ? `Renaming the board ${quoted(input.name)}` : 'Changing the board';
    case 'add_lists': return input.lists?.length === 1 ? `Adding the list ${quoted(input.lists[0].name)}` : 'Adding lists';
    case 'update_list': return input.name ? `Renaming a list ${quoted(input.name)}` : 'Moving a list';
    case 'remove_list': return 'Removing a list';
    case 'add_cards': return input.cards?.length ? `Adding ${cards(input.cards)}` : 'Adding cards';
    case 'update_card': return input.title ? `Changing the card ${quoted(input.title)}` : 'Changing a card';
    case 'move_cards': return input.card_ids?.length === 1 ? 'Moving a card' : 'Moving cards';
    case 'remove_cards': return 'Removing cards';
    case 'set_icon': return 'Choosing the board’s icon';
    case 'show_card': return 'Showing you a card';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
