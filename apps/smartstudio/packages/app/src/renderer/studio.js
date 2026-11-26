import { iconSvg } from '@smartdesktop/ui/main/icons.js';
import { rubberBand } from '@smartdesktop/ui/renderer/rubber-band.js';
import { clock, createTimeline } from './timeline.js';

// The tab's content: home (the user's projects, in one column), or one project: a prompt to make
// a take (music or video) above its takes, newest first, each with its player once it's made. The
// main process owns the projects and makes the takes (generator.js, on the generation server);
// this asks for what it shows, again whenever they change, and keeps each take's player as it is
// while the rest changes, so a song playing isn't stopped by another finishing.
//
// Each finished take plays on a timeline (timeline.js), where the user selects a stretch of it: to
// play it again, note something about it, ask the AI about it, or (music) have it made again, the
// rest of the song kept. One stretch is selected at a time in a tab, and the main process keeps it
// for the AI (get_selection), with a clip's frames from it; the chat is told, and offers what to
// ask about it.

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') element.addEventListener('click', value);
    else if (key === 'className') element.className = value;
    else if (value !== undefined && value !== null && value !== false) element.setAttribute(key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}
const icon = (name, size = 14, className = 'studio-icon') => {
  const span = h('span', { className, 'aria-hidden': 'true' });
  span.innerHTML = iconSvg(name, size);
  return span;
};
const pill = (text, kind = '') => h('span', { className: `pill ${kind}` }, text);
const statusPills = (...pills) => (pills.some(Boolean) ? h('span', { className: 'status-pills' }, ...pills) : null);
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const length = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : `${seconds}s`);
const short = (text, most = 48) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const span = ({ start, end }) => `${clock(start, true)}–${clock(end, true)}`;
const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const KIND = {
  music: {
    label: 'Music',
    icon: 'music',
    prompt: 'Describe the music: genre, instruments, mood, voice, tempo. For example: warm neo-soul, live drums, Rhodes piano, soft female vocals, 90 bpm',
    lengths: [30, 60, 120, 180],
    usual: 60,
  },
  video: {
    label: 'Video',
    icon: 'film',
    prompt: 'Describe the shot: subject, action, camera, light and sound. For example: a slow dolly through a rainy neon street at night, reflections on wet tarmac, distant thunder',
    lengths: [3, 5, 10],
    usual: 5,
  },
};
const STATUS = { queued: 'Waiting', running: 'Making…', failed: 'Failed' };

// `onShown({ chatId, name, line })` hears where the tab is, for the chat (see app-shell.js), with
// the chat's line of context for going there: home ('home', name null), or a project (its id).
// `onCards(cards, shortcuts)` hears what to offer in the chat about what it shows (nothing yet);
// `onNote(note)` gives the chat a line of context for the AI, about what the user did; and
// `onChooseIcon(request)` opens the icon picker for a project; and `onAsk(text)` sends the AI a
// request, in the chat.
// Where a take's file plays from: studio-media:// in SmartStudio's own window (main.js serves it);
// shown in another app's window, or a browser, the page is served over HTTP, and so is its media,
// beside its pages (see @smartdesktop/ui's main/guests.js).
function takeSource(projectId, file) {
  const take = `take/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
  if (!/^https?:$/.test(location.protocol)) return `studio-media://${take}`;
  const base = location.href.split('/page/')[0];
  return `${base}/media/${take}`;
}

export function createStudio({ el, bottomBar, goal: goalEl, api, onShown = () => {}, onCards = () => {}, onNote = () => {}, onChooseIcon = () => {}, onAsk = () => {} }) {
  // What the tab shows: null for home, else { projectId, name }.
  let here = null;
  let rendering = 0;
  let naming = null; // the project being renamed on home
  let homeShowing = false; // home's column rises in only as it arrives, not each time it's drawn again
  let view = null; // the project showing: { projectId, root, update(project) }
  let server = { reachable: false, checking: true };

  // A tab shows home or a project, going between them as a browser tab goes between pages (the
  // user's choice, 2026-11-26): the window's Home button takes it home. One opened to show a project
  // waits for it (`document`), rather than showing home first.
  let waiting = api.tabKind === 'document';

  // Back and forward: where this tab has been, as a browser keeps it. The buttons are in the
  // window's top bar (tab-strip.js), which asks this tab to go back or forward and is told when it can.
  const HISTORY_LIMIT = 200;
  const stop = () => JSON.stringify(here && { projectId: here.projectId, name: here.name });
  let visited = waiting ? [] : [stop()];
  let visiting = visited.length - 1;
  let historyShown = null;
  const showHistory = () => {
    const state = { back: visiting > 0, forward: visiting < visited.length - 1 };
    if (JSON.stringify(state) === historyShown) return;
    historyShown = JSON.stringify(state);
    api.historyState?.(state);
  };
  function remember() {
    const now = stop();
    if (visited[visiting] === now) return;
    visited = [...visited.slice(0, visiting + 1), now].slice(-HISTORY_LIMIT);
    visiting = visited.length - 1;
    showHistory();
  }
  function travel(delta) {
    const next = visiting + delta;
    if (next < 0 || next >= visited.length) return;
    visiting = next;
    here = JSON.parse(visited[next]);
    showHistory();
    render();
  }
  api.onHistoryStep?.((delta) => travel(delta));
  showHistory();
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.key === '[') travel(-1);
    else if (event.key === ']') travel(1);
  });

  // Shows a project, here, or in a new tab beside this one (`newTab`).
  function open(next, { newTab = false } = {}) {
    if (newTab) {
      api.openInTab({ projectId: next.projectId, name: next.name ?? '' });
      return;
    }
    waiting = false;
    here = { projectId: next.projectId, name: next.name ?? '' };
    remember();
    render();
  }

  async function render() {
    const ticket = ++rendering;
    if (here) {
      const project = await api.getProject(here.projectId).catch(() => null);
      if (ticket !== rendering) return;
      if (!project) {
        // It's gone (deleted): the tab goes home.
        here = null;
        view = null;
        waiting = false;
        return render();
      }
      here.name = project.name;
      if (view?.projectId !== project.id) {
        view = projectView(project);
        el.replaceChildren(view.root);
      }
      view.update(project);
      document.body.classList.add('has-project');
      document.body.classList.remove('document-tab', 'home-tab');
      homeShowing = false;
      goalEl.textContent = project.description ?? '';
      goalEl.title = project.description ?? '';
      const opened = `Opened “${project.name}”`;
      onShown({ chatId: project.id, name: project.name, line: { text: opened, detail: `${opened} (project_id ${project.id})` } });
      onCards([], view.shortcuts());
      return;
    }
    view = null;
    document.body.classList.remove('has-project');
    // What the tab is now (its page's styles): waiting for a project, or on home.
    document.body.classList.toggle('document-tab', waiting);
    document.body.classList.toggle('home-tab', !waiting);
    const next = waiting ? h('div', { className: 'tab-waiting-view' }) : await homeView();
    if (ticket !== rendering) return;
    const listTop = el.querySelector('.browser-list')?.scrollTop ?? 0;
    if (!homeShowing && !waiting) next.classList.add('arriving');
    homeShowing = !waiting;
    el.replaceChildren(next);
    const list = el.querySelector('.browser-list');
    if (list) {
      list.scrollTop = listTop;
      rubberBand(list);
    }
    goalEl.textContent = '';
    showBar(null);
    onCards([], []);
  }

  // --- Home ---------------------------------------------------------------------------------

  // Home: the user's projects, one column, most recently changed first. Each row is the project's
  // icon and name, the last thing asked of it, and how many takes. Clicking one opens it in its
  // tab; its right-click menu opens it in a new tab, renames it, changes its icon or deletes it.
  async function homeView() {
    onShown({ chatId: 'home', name: null, line: { text: 'Went home', detail: 'The window shows SmartStudio\'s home.' } });
    const projects = await api.listProjects();
    if (naming && !projects.some((project) => project.id === naming)) naming = null;
    const rows = projects.map((project) => (naming === project.id ? namingRow(project) : projectRow(project)));
    return h('div', { className: 'browser home-projects' }, column('Projects', rows));
  }

  function projectRow(project) {
    const mark = h('span', { className: 'home-doc-icon', 'aria-hidden': 'true' });
    mark.innerHTML = iconSvg(project.icon, 15);
    const kinds = project.kinds.map((kind) => KIND[kind].label.toLowerCase()).join(' and ');
    const button = h('button', { className: 'browser-row', type: 'button', 'data-project': project.id, title: project.name, onclick: () => open({ projectId: project.id, name: project.name }) },
      h('span', { className: 'title-row' }, h('strong', {}, mark, project.name), statusPills(project.running > 0 && pill(`Making ${project.running}`, 'proposed'), project.unread > 0 && pill(`${project.unread} new`, 'proposed'))),
      (project.description || project.last?.prompt) && h('span', { className: 'browser-row-text' }, project.description || project.last.prompt),
      h('span', { className: 'browser-row-meta' }, `${project.takes ? `${many(project.takes, 'take')}${kinds ? `, ${kinds}` : ''}` : 'No takes yet'} · ${when(project.updatedAt)}`));
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      const box = button.getBoundingClientRect();
      const chosen = await api.showHomeMenu([
        { id: 'open', label: 'Open in New Tab' },
        { separator: true },
        { id: 'rename', label: 'Rename…' },
        { id: 'icon', label: 'Change Icon…' },
        { separator: true },
        { id: 'delete', label: 'Delete Project…' },
      ]);
      if (chosen === 'open') open({ projectId: project.id, name: project.name }, { newTab: true });
      else if (chosen === 'rename') {
        naming = project.id;
        render();
      } else if (chosen === 'icon') onChooseIcon({ docId: project.id, current: project.icon, name: project.name, at: { left: box.left + 24, top: box.bottom + 4 } });
      else if (chosen === 'delete' && await api.deleteProject(project.id)) render();
    });
    return button;
  }

  // A project's name being written over its row. Enter or leaving it saves, Escape doesn't, and a
  // name that's refused says why, keeping what was typed.
  function namingRow(project) {
    const field = h('input', { className: 'name-input', type: 'text', value: project.name, 'aria-label': 'Project name', maxlength: '200' });
    const said = h('span', { className: 'name-error', role: 'alert' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      const named = field.value.trim();
      done = true;
      if (!save || !named || named === project.name) {
        naming = null;
        return render();
      }
      try {
        await api.renameProject(project.id, named);
        onNote({ text: `Renamed “${project.name}” to “${named}”`, detail: `Renamed the project “${project.name}” (project_id ${project.id}) to “${named}”` });
        naming = null;
        render();
      } catch (error) {
        done = false;
        said.textContent = cleanError(error);
        field.focus();
      }
    };
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => setTimeout(() => document.activeElement !== field && finish(true)));
    setTimeout(() => {
      field.focus();
      field.select();
    });
    return h('div', { className: 'naming' }, field, said);
  }

  // A column of rows. With none, it shows placeholder rows instead, fading out, with no text and no
  // buttons, as the family's homes do.
  const SKELETON = [[44, 82, 30], [58, 70, 26], [36, 88, 32]];
  function column(title, rows) {
    const placeholder = (widths) => h('div', { className: 'browser-row' }, ...widths.map((width) => h('span', { className: 'skeleton-bar', style: `width: ${width}%` })));
    return h('section', { className: `browser-column${rows.length ? '' : ' browser-column-unused'}`, 'aria-label': title },
      h('div', { className: 'browser-head' }, h('h2', {}, title)),
      rows.length
        ? h('ul', { className: 'browser-list' }, ...rows.map((one) => h('li', {}, one)))
        : h('div', { className: 'browser-list browser-skeleton', 'aria-hidden': 'true' }, ...SKELETON.map(placeholder)));
  }

  // --- One project --------------------------------------------------------------------------

  // A project: the prompt (what to make, and how long), and its takes below, newest first. Made
  // once for the project, then updated as it changes: the prompt keeps what's typed, and each
  // take's element is kept while it's the same, so its player keeps playing.
  function projectView(first) {
    const projectId = first.id;
    let kind = 'music';
    let seconds = { music: KIND.music.usual, video: KIND.video.usual };
    let busy = false;
    let selected = null; // the stretch selected: { takeId, kind, prompt, start, end }
    const timelines = new Map(); // take id → its timeline

    // What to make: Music or Video.
    const kinds = h('div', { className: 'segmented', role: 'radiogroup', 'aria-label': 'What to make' });
    for (const [key, about] of Object.entries(KIND)) {
      kinds.append(h('button', { type: 'button', role: 'radio', 'data-kind': key, 'aria-checked': String(key === kind), onclick: () => choose(key) }, icon(about.icon, 13), about.label));
    }
    const prompt = h('textarea', { className: 'prompt-input studio-prompt', rows: '3', 'aria-label': 'What to make', maxlength: '4000' });
    const lyrics = h('textarea', { className: 'prompt-input studio-lyrics', rows: '4', 'aria-label': 'Lyrics', maxlength: '10000', placeholder: '[Verse]\nThe words, in sections such as [Verse], [Chorus] and [Bridge]\n\nLeave empty for an instrumental' });
    const lyricsBox = h('details', { className: 'studio-lyrics-box' }, h('summary', {}, 'Lyrics'), lyrics);
    const lengths = h('div', { className: 'segmented studio-lengths', role: 'radiogroup', 'aria-label': 'Length' });
    const go = h('button', { className: 'primary-button studio-go', type: 'button', title: 'Generate (⌘↩)', onclick: () => generate() }, 'Generate');
    const note = h('p', { className: 'studio-note', role: 'status' });
    const composer = h('section', { className: 'studio-composer', 'aria-label': 'Make a take' },
      h('div', { className: 'studio-row' }, kinds, h('span', { className: 'studio-spacer' }), lengths),
      prompt,
      lyricsBox,
      h('div', { className: 'studio-row' }, note, h('span', { className: 'studio-spacer' }), go));
    const takes = h('div', { className: 'studio-takes', 'aria-label': 'Takes' });
    const empty = h('p', { className: 'studio-empty' }, 'Nothing made yet. Describe what you want above and press Generate. Your AI can make takes here too.');
    const root = h('div', { className: 'studio' }, composer, h('h2', { className: 'studio-heading' }, 'Takes'), empty, takes);

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        generate();
      }
    });
    lyrics.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        generate();
      }
    });
    prompt.addEventListener('input', () => showNote());

    function choose(next) {
      kind = next;
      for (const button of kinds.querySelectorAll('[data-kind]')) button.setAttribute('aria-checked', String(button.dataset.kind === kind));
      prompt.placeholder = KIND[kind].prompt;
      lyricsBox.hidden = kind !== 'music';
      lengths.replaceChildren(...KIND[kind].lengths.map((value) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === seconds[kind]), onclick: () => { seconds[kind] = value; choose(kind); } }, length(value))));
      showNote();
    }

    // Whether the server can make this kind now, and why not; Generate waits on it.
    function blocker() {
      if (server.checking && !server.reachable) return 'Checking the generation server…';
      if (!server.reachable) return `Can't reach the generation server${server.url ? ` at ${server.url}` : ''}. Check it's running, and its address in Settings.`;
      const ready = server.kinds?.[kind];
      if (ready && !ready.ready) return `${KIND[kind].label} isn't set up on the generation server yet: it needs ${ready.missing.join(', ')}.`;
      return null;
    }
    function showNote(said = null) {
      const why = blocker();
      note.textContent = said ?? why ?? (server.device ? `Made on ${server.device}${server.version ? ` with ComfyUI ${server.version}` : ''}.` : '');
      note.classList.toggle('problem', Boolean(said || why));
      go.disabled = busy || Boolean(why);
    }

    async function generate(fields = null) {
      const asked = fields ?? { kind, prompt: prompt.value, lyrics: kind === 'music' ? lyrics.value : '', seconds: seconds[kind] };
      if (!fields && !asked.prompt.trim()) {
        prompt.focus();
        return showNote('Say what to make first.');
      }
      if (blocker()) return showNote();
      busy = true;
      showNote();
      try {
        const take = await api.generate(projectId, asked);
        onNote({ text: `Asked for ${take.kind === 'video' ? 'a clip' : 'a song'}`, detail: `The user asked for a ${take.kind} take (${take.id}, ${take.seconds}s) in the project “${here?.name}” (project_id ${projectId}): ${take.prompt}` });
        busy = false;
        showNote();
      } catch (error) {
        busy = false;
        showNote(cleanError(error));
      }
    }

    // A take: what was asked, how it's going, and once made, its player.
    const elements = new Map(); // take id → { key, element }
    function takeView(take) {
      const about = KIND[take.kind];
      const state = take.status === 'done' ? null : pill(STATUS[take.status] ?? take.status, take.status === 'failed' ? 'failed' : 'proposed');
      const head = h('div', { className: 'take-head' },
        icon(about.icon, 15, 'take-kind'),
        h('div', { className: 'take-title' },
          h('p', { className: 'take-prompt', title: take.prompt }, take.prompt),
          h('p', { className: 'take-meta' }, [take.from ? `${span(take.from)} made again` : null, length(take.seconds), `seed ${take.seed}`, when(take.createdAt), take.by === 'ai' ? 'asked for by your AI' : null].filter(Boolean).join(' · '))),
        h('span', { className: 'status-pills' }, Object.assign(pill('New', 'proposed take-new'), { hidden: !take.unread }), state));
      const body = [];
      if (take.lyrics) body.push(h('details', { className: 'take-lyrics' }, h('summary', {}, 'Lyrics'), h('pre', {}, take.lyrics)));
      let parts = null;
      if (take.status === 'done' && take.file) {
        parts = takeTimeline(take);
        body.push(parts.timeline.element, parts.panel, parts.notes);
      } else if (take.status === 'failed') {
        body.push(h('p', { className: 'take-error' }, take.error || 'It couldn’t be made.'));
      } else {
        const bar = h('div', { className: 'take-progress', role: 'progressbar', 'aria-label': 'How far along', 'data-take': take.id }, h('span', {}));
        body.push(bar);
        setProgress(bar, take.progress);
      }
      const actions = h('div', { className: 'take-actions' });
      const button = (label, run) => actions.append(h('button', { className: 'secondary-button', type: 'button', onclick: run }, label));
      const reuse = () => {
        choose(take.kind);
        prompt.value = take.prompt;
        if (take.kind === 'music') {
          lyrics.value = take.lyrics;
          lyricsBox.open = Boolean(take.lyrics);
        }
        if (KIND[take.kind].lengths.includes(take.seconds)) {
          seconds[take.kind] = take.seconds;
          choose(take.kind);
        }
        prompt.focus();
        root.closest('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
      };
      if (take.status === 'done') {
        button('Show in Finder', () => api.showTakeFile(projectId, take.file));
        button('Use This Prompt', reuse);
      } else if (take.status === 'failed' && take.from) {
        button('Try Again', () => remake(take.from.take, take.from));
      } else if (take.status === 'failed') {
        button('Try Again', () => generate({ kind: take.kind, prompt: take.prompt, lyrics: take.lyrics, seconds: take.seconds }));
        button('Use This Prompt', reuse);
      } else {
        button('Stop', () => api.stopTake(projectId, take.id).catch((error) => showNote(cleanError(error))));
      }
      const element = h('article', { className: `take ${take.status}`, 'data-take': take.id }, head, ...body, actions);
      return { element, parts };
    }

    // A finished take's timeline, with what to do with the stretch selected on it (a panel shown
    // while it's selected), and its notes, listed.
    function takeTimeline(take) {
      const timeline = createTimeline({
        kind: take.kind,
        src: takeSource(projectId, take.file),
        seconds: take.seconds,
        notes: take.notes,
        remade: take.from,
        loadLevels: () => api.getLevels(projectId, take.id),
        saveLevels: (levels) => api.setLevels(projectId, take.id, levels),
        onSelect: (stretch) => selectedOn(take, stretch),
        onPlay: () => {
          for (const [id, other] of timelines) if (id !== take.id) other.pause();
        },
        onNoteClick: (note) => timeline.select(note),
      });
      timelines.set(take.id, timeline);

      const label = h('span', { className: 'take-part-span' });
      const said = h('input', { className: 'take-part-input', type: 'text', maxlength: '2000', 'aria-label': 'A note on this part, or a question for your AI', placeholder: take.kind === 'music' ? 'What’s wrong here? (a note, or ask your AI)' : 'What’s happening here? (a note, or ask your AI)' });
      const problem = h('p', { className: 'take-part-note', role: 'status' });
      const partButton = (text, title, run, primary = false) => h('button', { className: primary ? 'primary-button' : 'secondary-button', type: 'button', title, onclick: run }, text);
      const again = take.kind === 'music' ? partButton('Make Again', 'Make this part of the song again; the rest stays as it is', () => remake(take.id, timeline.selection())) : null;
      const panel = h('div', { className: 'take-part', hidden: '' },
        h('div', { className: 'take-part-row' },
          label,
          said,
          partButton('Save Note', 'Note this on the timeline', () => saveNote()),
          partButton('Ask AI', 'Ask your AI about this part, in the chat', () => askAbout()),
          again,
          h('button', { className: 'icon-button take-part-close', type: 'button', 'aria-label': 'Let go of the selection', title: 'Let go (Esc)', onclick: () => timeline.select(null) }, '×')),
        problem);
      said.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) askAbout();
          else saveNote();
        } else if (event.key === 'Escape') timeline.select(null);
      });
      const tell = (text) => {
        problem.textContent = text ?? '';
        problem.hidden = !text;
      };
      async function saveNote() {
        const stretch = timeline.selection();
        const text = said.value.trim();
        if (!stretch) return;
        if (!text) {
          said.focus();
          return tell('Write the note first.');
        }
        try {
          await api.addNote(projectId, take.id, { ...stretch, text });
          onNote({ text: `Noted ${span(stretch)}: “${short(text, 60)}”`, detail: `The user noted ${stretch.start}s to ${stretch.end}s of take ${take.id} (${take.kind}: “${take.prompt}”) in the project “${here?.name}” (project_id ${projectId}): ${text}` });
          said.value = '';
          tell(null);
        } catch (error) {
          tell(cleanError(error));
        }
      }
      function askAbout() {
        const stretch = timeline.selection();
        if (!stretch) return;
        const text = said.value.trim();
        onAsk(text
          ? `About the part I’ve selected (${span(stretch)} of take ${take.id}): ${text}`
          : `Have a look at the part I’ve selected (${span(stretch)} of take ${take.id}) and tell me what you notice.`);
        said.value = '';
      }
      function showPanel(stretch) {
        panel.hidden = !stretch;
        if (!stretch) return tell(null);
        label.textContent = `${span(stretch)} · ${(stretch.end - stretch.start).toFixed(1)}s`;
        if (again) {
          const why = remakeBlocker(stretch);
          again.disabled = Boolean(why);
          again.title = why ?? 'Make this part of the song again; the rest stays as it is';
        }
      }

      const notes = h('ul', { className: 'take-notes', 'aria-label': 'Notes' });
      function showNotes(list) {
        timeline.setNotes(list);
        notes.hidden = !list.length;
        notes.replaceChildren(...list.map((note) => h('li', { className: `take-note${note.by === 'ai' ? ' by-ai' : ''}` },
          h('button', { className: 'take-note-span', type: 'button', title: 'Select this part', onclick: () => timeline.select(note) }, span(note)),
          h('span', { className: 'take-note-text' }, note.text),
          note.by === 'ai' ? pill('AI', 'proposed') : null,
          h('button', { className: 'icon-button take-note-remove', type: 'button', 'aria-label': 'Remove note', title: 'Remove note', onclick: () => api.removeNote(projectId, take.id, note.id).catch((error) => showNote(cleanError(error))) }, '×'))));
      }
      showNotes(take.notes);
      return { timeline, panel, notes, showPanel, showNotes };
    }

    // Why a part can't be made again now, or null.
    function remakeBlocker(stretch) {
      if (stretch.end - stretch.start < 1) return 'Select at least a second to make it again';
      if (!server.reachable) return 'The generation server isn’t reachable';
      const feature = server.features?.repaint;
      if (feature && !feature.ready) return `The generation server needs SmartStudio’s own nodes for this (${feature.missing.join(', ') || 'music models'}): run scripts/install-comfy-nodes.sh`;
      return null;
    }

    async function remake(takeId, stretch) {
      if (!stretch) return;
      try {
        const take = await api.remakePart(projectId, takeId, { start: stretch.start, end: stretch.end });
        onNote({ text: `Asked for ${span(stretch)} again`, detail: `The user asked for ${stretch.start}s to ${stretch.end}s of take ${takeId} to be made again (the new take ${take.id}) in the project “${here?.name}” (project_id ${projectId}).` });
      } catch (error) {
        showNote(cleanError(error));
      }
    }

    // A stretch selected (or let go of) on a take's timeline: the only one in the tab, kept for the
    // AI, with a clip's frames, and said in the chat, which offers what to ask about it.
    let framing = 0;
    function selectedOn(take, stretch) {
      if (!stretch) {
        elements.get(take.id)?.parts?.showPanel(null);
        if (selected?.takeId !== take.id) return;
        selected = null;
        api.setSelection(null).catch(() => {});
        onCards([], shortcuts());
        return;
      }
      for (const [id, other] of timelines) {
        if (id !== take.id && other.selection()) {
          other.select(null, { quiet: true });
          elements.get(id)?.parts?.showPanel(null);
        }
      }
      selected = { takeId: take.id, kind: take.kind, prompt: take.prompt, ...stretch };
      elements.get(take.id)?.parts?.showPanel(stretch);
      const base = { projectId, takeId: take.id, ...stretch };
      api.setSelection(base).catch(() => {});
      const ticket = ++framing;
      if (take.kind === 'video') {
        timelines.get(take.id)?.frames(stretch).then((frames) => {
          if (ticket === framing) api.setSelection({ ...base, frames }).catch(() => {});
        }).catch(() => {});
      }
      onNote({
        text: `Selected ${span(stretch)} of “${short(take.prompt)}”`,
        detail: `The user selected ${stretch.start}s to ${stretch.end}s of take ${take.id} (${take.kind}, ${take.seconds}s: “${take.prompt}”) in the project “${here?.name}” (project_id ${projectId}). get_selection says what's there${take.kind === 'video' ? ', with frames from it' : ''}.`,
        focus: true,
      });
      onCards([], shortcuts());
    }

    // What the chat offers to ask, about the stretch selected.
    function shortcuts() {
      if (!selected) return [];
      const where = span(selected);
      return selected.kind === 'music'
        ? [
          { id: 'part-look', label: 'What’s off in this part?', text: `Listen to the part I’ve selected (${where}) and tell me what you notice.` },
          { id: 'part-fix', label: 'Fix this part', text: `Something’s not right in the part I’ve selected (${where}). Have a look, then make just that part again so it fits the song.` },
        ]
        : [
          { id: 'part-look', label: 'What’s happening here?', text: `Look at the part of the clip I’ve selected (${where}) and tell me what you see, and anything that looks wrong.` },
        ];
    }

    function update(project) {
      const newest = [...project.takes].reverse();
      empty.hidden = newest.length > 0;
      const keep = new Set();
      for (const [index, take] of newest.entries()) {
        keep.add(take.id);
        // Rebuilt only when what it shows changes, so its player isn't stopped: whether it's new is
        // its pill alone.
        const key = JSON.stringify([take.status, take.file, take.error]);
        let known = elements.get(take.id);
        if (!known || known.key !== key) {
          const { element, parts } = takeView(take);
          if (known) {
            known.element.replaceWith(element);
            if (selected?.takeId === take.id) selectedOn(take, null);
          }
          if (!parts) timelines.delete(take.id);
          known = { key, element, parts, noted: JSON.stringify(take.notes) };
          elements.set(take.id, known);
        } else if (known.parts) {
          // Its notes, as they change, without stopping it playing.
          const noted = JSON.stringify(take.notes);
          if (known.noted !== noted) known.parts.showNotes(take.notes);
          known.noted = noted;
        } else if (take.progress) {
          const bar = known.element.querySelector('.take-progress');
          if (bar) setProgress(bar, take.progress);
        }
        const isNew = known.element.querySelector('.take-new');
        if (isNew) isNew.hidden = !take.unread;
        // In its place, newest first (by index: an element just replaced is no longer there).
        const current = takes.children[index] ?? null;
        if (known.element !== current) takes.insertBefore(known.element, current);
        // A take the AI asked for is seen once it's shown here, finished.
        if (take.unread && document.visibilityState === 'visible') setTimeout(() => api.markSeen(projectId, take.id).catch(() => {}), 1500);
      }
      for (const [id, known] of elements) {
        if (!keep.has(id)) {
          known.element.remove();
          elements.delete(id);
          timelines.delete(id);
          if (selected?.takeId === id) {
            selected = null;
            api.setSelection(null).catch(() => {});
          }
        }
      }
      const making = project.takes.filter((take) => take.status === 'queued' || take.status === 'running').length;
      showBar(making
        ? `Making ${many(making, 'take')} on the generation server. They wait their turn there, one at a time; you can carry on meanwhile.`
        : project.takes.length
          ? `${many(project.takes.length, 'take')}. Drag across a take’s timeline to select a part: to play it again, note it, ask your AI about it, or make it again.`
          : 'Describe what to make, choose Music or Video, and press Generate (⌘↩). Your AI can make takes here too.');
    }

    choose('music');
    return {
      projectId,
      root,
      update,
      serverChanged: () => {
        showNote();
        if (selected) elements.get(selected.takeId)?.parts?.showPanel(selected);
      },
      shortcuts,
      focus: () => prompt.focus(),
    };
  }

  function setProgress(bar, progress) {
    const fill = bar.firstChild;
    if (progress?.max > 0) {
      const share = Math.max(0, Math.min(1, progress.value / progress.max));
      bar.classList.remove('waiting');
      fill.style.width = `${Math.round(share * 100)}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    } else {
      bar.classList.add('waiting');
      fill.style.width = '';
    }
  }

  // --- The bottom bar -------------------------------------------------------------------------

  // The bottom bar is the actions bar: with nothing to decide (as yet), a sentence on what's going on.
  function showBar(said) {
    bottomBar.hidden = !said;
    bottomBar.replaceChildren(...(said ? [h('p', { className: 'review-bar-text', title: said }, said)] : []));
  }

  // How far along a take is, as the generator says: only its bar changes.
  api.onTakeProgress?.(({ projectId, takeId, value, max }) => {
    if (view?.projectId !== projectId) return;
    const bar = view.root.querySelector(`.take-progress[data-take="${CSS.escape(takeId)}"]`);
    if (bar) setProgress(bar, { value, max });
  });
  // The generation server's state: what Generate waits on.
  const serverChanged = (state) => {
    server = state ?? { reachable: false };
    view?.serverChanged();
  };
  api.onServerCheck?.(serverChanged);
  api.getServer?.().then(({ state }) => serverChanged(state)).catch(() => {});
  api.onProjectsChanged((id) => {
    if (!here || !id || id === here.projectId) render();
  });
  // The window's Home button: home, here.
  api.onGoHome?.(() => {
    if (!here && !waiting) return;
    waiting = false;
    here = null;
    remember();
    render();
  });
  // A project opened in this tab: in a new tab from home (see main.js's openInTab), or an AI's.
  api.onOpenProject?.((request) => {
    if (!request?.projectId) return;
    waiting = false;
    here = { projectId: request.projectId, name: request.name ?? '' };
    remember();
    render().then(() => view?.focus());
  });
  render();
}
