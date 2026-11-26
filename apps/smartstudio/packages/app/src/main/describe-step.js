// What an AI is doing, from the SmartStudio tool it calls, as the user would say it: each step the
// chat shows (SmartDesktop's agent.js, which keeps a copy of this). No Node here, so a website's
// demo could use it too.

// A stretch of a take, as minutes and seconds: 0:42–0:51.
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const span = (start, end) => (end === undefined ? `from ${clock(start)}` : `${clock(start)}–${clock(end)}`);

export function describeStep(name, input = {}) {
  const tool = name.replace(/^mcp__smartstudio__/, '');
  const quoted = (text) => `“${String(text).length > 60 ? `${String(text).slice(0, 57)}…` : text}”`;
  switch (tool) {
    case 'list_projects': return 'Looking through the projects';
    case 'create_project': return input.name ? `Starting the project ${quoted(input.name)}` : 'Starting a project';
    case 'get_project': return 'Reading the project';
    case 'rename_project': return input.name ? `Renaming the project ${quoted(input.name)}` : 'Changing the project';
    case 'generate': {
      const what = input.kind === 'video' ? 'a clip' : 'a song';
      return input.prompt ? `Making ${what}: ${quoted(input.prompt)}` : `Making ${what}`;
    }
    case 'get_selection': return 'Looking at what you selected';
    case 'inspect_take': return input.start !== undefined ? `Listening to ${span(input.start, input.end)}` : 'Listening to a take';
    case 'remake_part': return input.start !== undefined ? `Making ${span(input.start, input.end)} again` : 'Making part of a song again';
    case 'add_note': return input.text ? `Noting ${quoted(input.text)}` : 'Adding a note';
    case 'stop_take': return 'Stopping a take';
    case 'generate_status': return 'Checking the generation server';
    case 'set_icon': return 'Choosing the project’s icon';
    case 'use_window': return 'Joining this window';
    default: return tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}
