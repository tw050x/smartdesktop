// Back and forward in the top bar: where this tab has been, as a browser keeps it (as in
// SmartSpec). The buttons are in the window's top bar (tab-strip.js), which asks the tab showing to
// go back or forward (`travel`), and is told when they can (`onState`). Each stop is home, or a document's variation, draft and tool, with the focus in the
// highlight tool and whether the draft preview was open. Going somewhere new drops what was ahead.
//
// The window tells it what's showing with observe() each time something changes. Changes come in
// bursts (a tool and its review, a document and its draft), so a stop is only taken once they've
// settled. Going back or forward asks the app to open that stop, and what shows on the way there
// isn't a stop of its own.
const HISTORY_LIMIT = 200;
const SETTLE_MS = 200;
const ARRIVE_MS = 3000; // the most a stop can take to open before what's showing is taken instead

export function createHistoryNav({ api, canTravel = true, onState = () => {} }) {
  let visited = [];
  let visiting = -1;
  let showing = null; // the latest state observed
  let settle = null;
  let arriving = null; // { key, timer }: the stop being opened

  const keyOf = (state) => JSON.stringify(state);
  let shown = null;
  const show = () => {
    const state = { back: canTravel && visiting > 0, forward: canTravel && visiting < visited.length - 1 };
    if (JSON.stringify(state) === shown) return;
    shown = JSON.stringify(state);
    onState(state);
  };

  function take() {
    settle = null;
    if (!showing) return;
    const key = keyOf(showing);
    if (arriving) {
      if (key !== arriving.key) return;
      clearTimeout(arriving.timer);
      arriving = null;
    }
    if (visited[visiting] === key) return;
    visited = [...visited.slice(0, visiting + 1), key].slice(-HISTORY_LIMIT);
    visiting = visited.length - 1;
    show();
  }

  // What's showing now: { home: true }, or { docId, variationId, draftId, tool, focus, preview }.
  function observe(state) {
    showing = state;
    clearTimeout(settle);
    settle = setTimeout(take, SETTLE_MS);
  }

  async function travel(delta) {
    const next = visiting + delta;
    if (!canTravel || next < 0 || next >= visited.length) return;
    visiting = next;
    show();
    const stop = JSON.parse(visited[next]);
    clearTimeout(arriving?.timer);
    arriving = {
      key: visited[next],
      // Somewhere that can't be opened any more (a draft deleted since): this stop becomes what
      // shows instead.
      timer: setTimeout(() => {
        arriving = null;
        if (showing) visited[visiting] = keyOf(showing);
      }, ARRIVE_MS),
    };
    try {
      if (stop.home) return void (await api.goHome());
      await api.openDraft(stop.docId, stop.variationId, stop.draftId, stop.tool);
      if (stop.focus) await api.setFocus(stop.focus);
      if (stop.preview) await api.openPreview();
    } catch {
      // Left as far as it got: the timer takes what's showing.
    }
  }

  show();
  return { observe, travel };
}
