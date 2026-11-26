import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ICONS } from '@smartdesktop/ui/main/icons.js';
import { KINDS, LIMITS } from './store.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches (npm run server-snapshot writes it again after a change here).

const INSTRUCTIONS = `This server is SmartStudio: a desktop app for making music and video with the user, on their own generation server (ComfyUI on a GPU machine). A project is something being made (a song, a clip, a soundtrack), and its takes are what was asked for and what came back: each take is music (a song with lyrics, or an instrumental) or video (a clip, with its sound), made from a prompt.
The user asks for takes in the project's tab too, so read get_project before adding to one. generate asks for a take: for music, the prompt describes the style (genre, instruments, mood, voice, tempo), and lyrics are the words, in sections such as [Verse] and [Chorus] (none for an instrumental); for video, the prompt describes the shot (subject, action, camera, light, sound). A take takes from seconds (music) to minutes (video), and waits its turn behind others on the server: get_project shows each take's status (queued, running, done or failed, with why). Say what you asked for and let the user listen or watch; don't ask for the same take again unless they want another.
Each finished take shows on a timeline in its tab, where the user selects a stretch (to listen again, note something about it, or ask you about it) and writes notes on stretches ("the vocal cracks here"). get_selection says what they've selected: the take, the stretch, what was asked for, the notes on it, how it sounds (from its loudness: against the rest of the take, where it goes quiet, clips or jumps, second by second) and, for video, frames from it, which you can look at. inspect_take says the same of any stretch, or a whole take, without the frames. You can't listen, so say what you can tell and what you can't (lyrics, for one, aren't timed: you can't tell which words fall where).
remake_part makes a stretch of a song again, keeping the rest: a new take, the song with that part replaced. With the same prompt and lyrics it's played again the way the song was planned (to fix a glitch, a garbled word, a clumsy fill); with changed ones the song is planned again, so the part can differ more (the rest stays as it was either way). Video can't have a part made again yet: generate a new take instead. add_note marks a stretch with something you found, for the user to see on the timeline.
generate_status says whether the server is reachable and which kinds it can make now.
If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Each project has an icon, shown on its tab and on the user's home screen so they can tell it apart at a glance: one with no icon of its own (get_project's and list_projects' icon is null) gets one from you, with create_project's icon or set_icon.`;

// A tool's result as JSON; pictures in it (`images`: [{ at, data, mimeType }], base64, such as a
// clip's frames) go as pictures, after it, each said where it's from.
const json = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.images)) return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  const { images, ...rest } = value;
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ...rest, frames: images.map((image) => image.at) }, null, 2) },
      ...images.flatMap((image) => [{ type: 'text', text: `Frame at ${image.at}s${image.inside === false ? ' (just outside the selection)' : ''}:` }, { type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/jpeg' }]),
    ],
  };
};

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). The generation tools reach another machine: the user's
// generation server.
const READ_ONLY = new Set(['list_projects', 'get_project', 'generate_status', 'get_selection', 'inspect_take']);
const DESTRUCTIVE = new Set(['stop_take']);
const OPEN_WORLD = new Set(['generate', 'generate_status', 'stop_take', 'remake_part']);
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: OPEN_WORLD.has(name) });

const ICON = z.enum(ICONS.map((i) => i.name));
const PROJECT_ID = z.string().optional().describe('The project (default: the one the window shows)');
const SECONDS = (what) => z.number().min(0).max(LIMITS.music.max).describe(what);

// `call(name, args, run)` runs a tool for the session making the request, in its window, giving
// `run` the projects as that session may use them (see projectsFor in main.js).
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartstudio', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, (projects) => run(args ?? {}, projects)));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('use_window', 'Takes over a SmartStudio window, when the user\'s prompt names one: this session then works in it. Call it first, before any other tool, or SmartStudio opens a new window for this session.', {
    window_id: z.string().describe('The window named in the prompt, such as w-7f3a'),
  }, ({ window_id }, projects) => projects.useWindow(window_id));

  tool('list_projects', 'Every project, most recently changed first: its id, name, description, icon (null if it has none of its own), how many takes it has, which kinds, how many are still being made, and the last one asked for.', {}, (_args, projects) => projects.list());

  tool('create_project', 'Makes a new project and shows it to the user, ready for takes.', {
    name: z.string().trim().min(1).max(200).describe('What the user will know it by, such as "Summer single" or "Launch video"'),
    description: z.string().trim().max(2000).optional().describe('What it\'s for, in a sentence or two'),
    icon: ICON.optional().describe('Its icon, shown on its tab and on home (see set_icon for the list)'),
  }, ({ name, description, icon }, projects) => projects.create({ name, description, icon }));

  tool('get_project', 'One project in full: its name, description and icon, and its takes, oldest first: each one\'s id, kind, prompt, lyrics, seconds, seed, who asked for it (user or ai), status (queued, running, done or failed), error (why it failed), progress while running ({ value, max } of the step running), when, from (for a take remaking part of another: { take, start, end }, else null) and notes (on stretches of it: { id, start, end, text, by }).', {
    project_id: PROJECT_ID,
  }, ({ project_id }, projects) => projects.get(project_id));

  tool('rename_project', 'Renames a project, or changes its description, straight away. Only use it when the user asks.', {
    project_id: PROJECT_ID,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
  }, ({ project_id, name, description }, projects) => {
    if (name === undefined && description === undefined) throw new Error('Give a name, a description, or both.');
    return projects.rename(project_id, { name, description });
  });

  tool('generate', `Asks the generation server for a take in a project, which shows to the user in its tab as it's made. Gives the take's id: get_project says how it's going. Music is ${LIMITS.music.min} to ${LIMITS.music.max} seconds (default ${LIMITS.music.default}); video ${LIMITS.video.min} to ${LIMITS.video.max} (default ${LIMITS.video.default}).`, {
    project_id: PROJECT_ID,
    kind: z.enum(KINDS).describe('music: a song or instrumental; video: a clip with its sound'),
    prompt: z.string().trim().min(1).max(4000).describe('Music: the style, as comma-separated tags or a sentence (genre, instruments, mood, voice, tempo). Video: the shot (subject, action, camera, light, sound)'),
    lyrics: z.string().max(10_000).optional().describe('Music only: the words, in sections such as [Verse], [Chorus], [Bridge]. Leave out for an instrumental'),
    seconds: z.number().min(LIMITS.video.min).max(LIMITS.music.max).optional().describe('How long'),
    seed: z.number().int().min(0).optional().describe('The same seed and prompt make the same take again (default: a new one each time)'),
  }, ({ project_id, ...fields }, projects) => projects.generate(project_id, fields));

  tool('get_selection', 'What the user has selected on a take\'s timeline in the window: the project and take (its kind, prompt, lyrics and length), the stretch (start and end, in seconds), the notes on the take that overlap it, how it sounds (sound: its loudness against the rest of the take, peaks, where it goes quiet, clips or jumps, and second by second from a little before to a little after; null if the take hasn\'t been measured yet), and for video, frames from just before, in and just after it, as pictures. selection is null when nothing is selected.', {}, (_args, projects) => projects.selection());

  tool('inspect_take', 'How a stretch of a take sounds, from its loudness (as get_selection\'s sound), or the whole take without start and end, with the notes on that stretch. Gives sound null for a take not yet measured: the app measures each take as its tab shows it.', {
    project_id: PROJECT_ID,
    take_id: z.string(),
    start: SECONDS('Where the stretch starts, in seconds from the take\'s start (default: its start)').optional(),
    end: SECONDS('Where it ends (default: the take\'s end)').optional(),
  }, ({ project_id, take_id, start, end }, projects) => projects.inspect(project_id, take_id, { start, end }));

  tool('remake_part', `Makes a stretch of a finished song again, the rest kept: a new take in the project, the whole song with that part replaced, which shows in its tab as it's made (get_project says how it's going). The part is at least 1 second; it fades in and out over half a second at its edges, so it joins the song. Without prompt and lyrics the song's own are used, and the part is played again as the song was planned; give them changed (the whole song's lyrics, with the part's lines changed, say) and it's planned again, so it can differ more. Music only, for now.`, {
    project_id: PROJECT_ID,
    take_id: z.string().describe('The song to make part of again'),
    start: SECONDS('Where the part starts, in seconds from the song\'s start'),
    end: SECONDS('Where it ends'),
    prompt: z.string().trim().min(1).max(4000).optional().describe('The style, if it should change (default: the song\'s)'),
    lyrics: z.string().max(10_000).optional().describe('The whole song\'s lyrics, if they should change (default: the song\'s)'),
    seed: z.number().int().min(0).optional().describe('The same seed makes the same part again (default: a new one each time)'),
  }, ({ project_id, take_id, ...part }, projects) => projects.remakePart(project_id, take_id, part));

  tool('add_note', 'Marks a stretch of a take with a note, shown to the user on its timeline: something you found there, or what you changed. The user\'s own notes are theirs: don\'t repeat them.', {
    project_id: PROJECT_ID,
    take_id: z.string(),
    start: SECONDS('Where the stretch starts, in seconds'),
    end: SECONDS('Where it ends'),
    text: z.string().trim().min(1).max(2000),
  }, ({ project_id, take_id, ...note }, projects) => projects.addNote(project_id, take_id, note));

  tool('stop_take', 'Stops a take that\'s queued or being made. Only use it when the user asks.', {
    project_id: PROJECT_ID,
    take_id: z.string(),
  }, ({ project_id, take_id }, projects) => projects.stop(project_id, take_id));

  tool('generate_status', 'Whether the generation server answers, what it runs on, and which kinds it can make now (each kind needs its models there: missing lists those it hasn\'t).', {}, (_args, projects) => projects.serverStatus());

  tool('set_icon', `Gives a project an icon, shown on its tab and on the user's home screen, so they can tell it apart at a glance (a tab too narrow for its name shows only its icon). Call it once, when the project has no icon of its own yet (get_project and list_projects give its icon, null when it has none): choose the one that best fits what it's about. The user's own choice is never replaced.`, {
    project_id: PROJECT_ID,
    icon: ICON.describe(`One of: ${ICONS.map((i) => `${i.name} (${i.label})`).join(', ')}`),
  }, ({ project_id, icon }, projects) => projects.setIcon(icon, project_id));

  return server;
}
