// What an AI is doing, from the SmartPrep tool it calls, as the user would say it: each step the
// chat shows (SmartDesktop's agent.js, which keeps a copy of this). No Node here, so a website's
// demo could use it too.

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartprep__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  const cards = (list) => (list?.length === 1 ? `the card ${quoted(list[0].title ?? list[0])}` : `${list?.length ?? 0} cards`);
  switch (tool) {
    case 'list_topics': return 'Looking through the topics';
    case 'create_topic': return input.name ? `Starting the topic ${quoted(input.name)}` : 'Starting a topic';
    case 'get_topic': return 'Reading the topic';
    case 'get_cards': return input.card_ids?.length === 1 ? 'Reading a card' : 'Reading the cards';
    case 'write_cards': return input.cards?.length ? `Writing ${cards(input.cards)}` : 'Writing cards';
    case 'remove_cards': return 'Removing cards';
    case 'get_questions': return 'Reading your questions';
    case 'answer_question': return input.card?.title ? `Answering your question with ${quoted(input.card.title)}` : 'Answering your question';
    case 'reply_to_question': return 'Replying to your question';
    case 'rename_topic': return input.name ? `Renaming the topic ${quoted(input.name)}` : 'Changing the topic';
    case 'set_icon': return 'Choosing the topic’s icon';
    case 'show_card': return 'Showing you a card';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
