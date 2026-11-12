// How installing an AI's tool, or signing in to it, is getting on, shown while it runs (in the
// server panel and the chat): the step in words ("Downloading Claude Code…") and, in the button's
// place, how much of the download has arrived ("42%"), as the settings say for an update; a
// spinner while there's no percentage to give (getting ready, setting up, signing in).

const progress = {}; // provider id → { stage, line, percent }

let tracking = false;
export function trackAiProgress(api) {
  if (tracking) return;
  tracking = true;
  api.onAgentProgress?.(({ id, stage, line, percent }) => {
    progress[id] = { stage, line, percent: Number.isFinite(percent) ? percent : null };
    refresh();
  });
}

export const clearAiProgress = (id) => delete progress[id];

// Why it didn't work, without the wrapping Electron puts round an error from the main process.
export const failureText = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');

// The step, in words. `fallback` is what it says until the app hears from the installer.
export function progressLine(id, fallback) {
  const line = document.createElement('span');
  line.className = 'ai-progress-line';
  line.dataset.ai = id;
  line.dataset.fallback = fallback;
  line.setAttribute('role', 'status');
  fillLine(line);
  return line;
}

// In the button's place: the percentage, or a spinner without one.
export function progressMark(id) {
  const mark = document.createElement('span');
  mark.className = 'ai-progress';
  mark.dataset.ai = id;
  fillMark(mark);
  return mark;
}

function fillLine(line) {
  const text = progress[line.dataset.ai]?.line ?? line.dataset.fallback;
  if (line.textContent !== text) line.textContent = text;
}

function fillMark(mark) {
  const percent = progress[mark.dataset.ai]?.percent ?? null;
  if (percent === null) {
    if (!mark.querySelector('.ai-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'ai-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      mark.replaceChildren(spinner);
    }
  } else if (mark.textContent !== `${percent}%`) mark.textContent = `${percent}%`;
}

function refresh() {
  for (const line of document.querySelectorAll('.ai-progress-line[data-ai]')) fillLine(line);
  for (const mark of document.querySelectorAll('.ai-progress[data-ai]')) fillMark(mark);
}
