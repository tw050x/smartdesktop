import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ICONS } from './icons.js';
import { MODEL_GUIDE } from './ad-model.js';

// The app's MCP server: its instructions and tools. Kept apart from the HTTP server (mcp-server.js)
// and Electron, so the tests can build it too: the launcher keeps a copy of what it lists
// (packages/cli/lib/server.json), to answer AI apps before the app is running, and a test checks
// the copy matches (npm run server-snapshot writes it again after a change here).

const INSTRUCTIONS = `This server is SmartAd: a desktop app for designing adverts for the web with the user. You design the ad and make every change to it; the user directs you, and accepts or discards what you propose in the app. They never edit the ad themselves: the app has no editing tools, so anything they want changed, they ask you for.
An ad is data the app draws: its layers (background, images, logo, text, the call to action, shapes), each with its content, style and placement rules, and its animation as tracks of keyframes. It's one design laid out at every size it's made for (standard display sizes such as 300×250, 728×90, 160×600, 300×600, 320×50 and 970×250, and social shapes such as 1:1, 4:5 and 9:16), so write placement as rules that hold at every size, not positions for one.
Read before you change: list_ads shows the user's ads, get_ad reads an ad's draft (the latest unless you name one) and says whether a proposal is waiting on it, and get_proposal reads that proposal.
Only the user accepts what you propose: propose_ad creates a proposal holding the whole ad as you propose it, replacing any proposal already waiting (so build on that one, from get_proposal, if there is one), and it becomes a draft once they accept it in the app. A new ad is made by its first proposal, and has no draft until the user accepts it. Say why each part changes in reasons. Tell the user straight away to switch to SmartAd and review it. Each reply gives a wait command, a shell command that ends when they have answered: run it in the background if you can, or call get_ad later to see where it stands.
The user points at moments of the animation: a moment, a span of time, or a layer at a moment. Look at what's there at that moment before changing it, and leave the rest of the timeline as it was unless they ask.
A focus is what the user wants this work to be for: their prompt may say "focusing on" a goal. Keep to it, and pass it to propose_ad as goal, with a short goal_title if you're given one or can name it, so the app can show it. If the user's prompt names a window, call use_window with it first, so that window becomes yours.
Each ad has an icon, shown on its tab and on the user's home screen so they can tell it apart at a glance: one with no icon of its own (get_ad's and list_ads' icon is null) gets one from you, with propose_ad's icon for a new ad or set_icon for one there is.`;

// A tool's answer as text (JSON), and any pictures it carries (`PICTURES`: view_frames'), each
// after its label, as images the AI can see.
export const PICTURES = Symbol('pictures');
const json = (value) => {
  const pictures = value?.[PICTURES] ?? [];
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
      ...pictures.flatMap((picture) => [{ type: 'text', text: picture.label }, { type: 'image', data: picture.data, mimeType: 'image/png' }]),
    ],
  };
};

// Each tool's safety label, for the AI app to show the user and decide when to ask them: the
// tools that only read, and the ones that change or remove something the user can't get back (the
// rest change something, without loss). Every tool works only with the app, on this computer.
const READ_ONLY = new Set(['list_ads', 'get_ad', 'get_proposal', 'view_frames']);
const DESTRUCTIVE = new Set();
const annotations = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false });

// An ad's content: its layers, sizes and animation, in ad-model.js's format (MODEL_GUIDE), checked
// there as it's proposed (checkAd in main.js), every mistake said with where it is.
const AD_CONTENT = z.union([z.record(z.string(), z.unknown()), z.string()]).describe(`The whole ad as you propose it, as an object (or its JSON text): its sizes, layers and animation. It replaces the ad's content entirely: send all of it, not only what changes. Its format:\n${MODEL_GUIDE}`);
const ICON = z.enum(ICONS.map((i) => i.name));

// `call(name, args, run)` runs a tool for the session making the request, in its window, giving
// `run` the ads as that session may use them (see adsFor in main.js).
export function buildServer(call, { version }) {
  const server = new McpServer({ name: 'smartad', version }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: annotations(name) }, async (args) => {
    try {
      return json(await call(name, args ?? {}, (ads) => run(args ?? {}, ads)));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  tool('use_window', 'Takes over a SmartAd window, when the user\'s prompt names one: this session then works in it. Call it first, before any other tool, or SmartAd opens a new window for this session.', {
    window_id: z.string().describe('The window named in the prompt, such as w-7f3a'),
  }, ({ window_id }, ads) => ads.useWindow(window_id));

  tool('list_ads', 'Every ad, most recently changed first: its id, name, icon (null if it has none of its own), number of accepted drafts, and any proposal waiting for the user.', {}, (_args, ads) => ads.list());

  tool('get_ad', 'One of an ad\'s accepted drafts, the latest unless you name one: its name, icon, the draft\'s number of how many there are, its note and goal, and its content (layers, sizes and animation). proposal says if a proposal is waiting for the user; get_proposal reads it. An ad whose first proposal hasn\'t been accepted yet has no draft: read it with get_proposal.', {
    ad_id: z.string(),
    draft_id: z.string().optional().describe('The draft to read (default: the latest)'),
  }, ({ ad_id, draft_id }, ads) => ads.get(ad_id, { draftId: draft_id }));

  tool('get_proposal', 'The proposal waiting for the user on an ad: its content, as get_ad gives a draft\'s, the draft it\'s based on (null for a new ad), its note, goal and reasons. Null if nothing is waiting.', {
    ad_id: z.string(),
  }, ({ ad_id }, ads) => ads.getProposal(ad_id));

  tool('propose_ad', 'Proposes a new ad, or with ad_id a change to one, and shows it in the app for the user to accept or discard. content is the whole ad as proposed: it replaces any proposal already waiting, so build on that one if there is one. The content is checked, and the proposal is refused, saying why, if it isn\'t a valid ad.', {
    ad_id: z.string().optional().describe('The ad to change (leave out to propose a new one)'),
    name: z.string().trim().min(1).max(200).optional().describe('Needed for a new ad: what the user will know it by. To rename an ad there is, use rename_ad.'),
    content: AD_CONTENT,
    goal: z.string().trim().min(1).optional().describe('The focus the user gave you for this work, in their words. Kept when you propose again without one.'),
    goal_title: z.string().trim().min(1).max(60).optional().describe('A short name for that focus'),
    note: z.string().trim().min(1).describe('What this proposes and why, for the user reviewing it, in a plain sentence or two. The app already says it is a proposal, so no label such as "Proposed change:"'),
    reasons: z.record(z.string(), z.string().trim().min(1).max(300)).optional().describe('Why each part changes, keyed by what it\'s about (a layer\'s id, say): one short sentence for each thing you add, change or remove, shown to the user while they review. Kept when you propose again; send one again to replace it.'),
    icon: ICON.optional().describe('For a new ad: its icon, shown on its tab and on home (see set_icon for the list)'),
  }, ({ ad_id, goal_title, ...proposal }, ads) => ads.propose({ ...proposal, adId: ad_id, goalTitle: goal_title }));

  tool('rename_ad', 'Renames an ad, straight away. Only use it when the user asks.', {
    ad_id: z.string(),
    name: z.string().trim().min(1).max(200),
  }, ({ ad_id, name }, ads) => ads.rename(ad_id, name));

  tool('set_icon', `Gives an ad an icon, shown on its tab and on the user's home screen, so they can tell it apart at a glance (a tab too narrow for its name shows only its icon). Call it once, when the ad has no icon of its own yet (get_ad and list_ads give its icon, null when it has none): choose the one that best fits what it advertises. The user's own choice is never replaced.`, {
    ad_id: z.string().optional().describe('The ad (default: the one the window shows)'),
    icon: ICON.describe(`One of: ${ICONS.map((i) => `${i.name} (${i.label})`).join(', ')}`),
  }, ({ ad_id, icon }, ads) => ads.setIcon(icon, ad_id));

  tool('view_frames', 'Pictures of an ad as the app draws it, at chosen sizes and moments, so you can see what you made: check every size after proposing, and look at the moment the user points at before changing it. Of its latest draft unless you name one, or of the proposal waiting (proposal: true). By default every size (at most 4), for an animated ad halfway through and at its end, for a still ad as it is. At most 8 pictures at once. The text is read from the content with get_ad, which is exact; these are for how it looks.', {
    ad_id: z.string().optional().describe('The ad (default: the one the window shows)'),
    draft_id: z.string().optional().describe('A draft to look at (default: the latest)'),
    proposal: z.boolean().optional().describe('Look at the proposal waiting instead of a draft'),
    sizes: z.array(z.string()).min(1).max(8).optional().describe('Size ids from the ad\'s sizes, such as "300x250" or "story"'),
    times: z.array(z.number().min(0)).min(1).max(8).optional().describe('Moments, in seconds from the start'),
    width: z.number().int().min(200).max(1600).optional().describe('The widest a picture may be, in pixels (default 800; never enlarged)'),
  }, ({ ad_id, draft_id, proposal, sizes, times, width }, ads) => ads.viewFrames({ adId: ad_id, draftId: draft_id, proposal, sizes, times, width }));

  return server;
}
