import { Menu, nativeImage } from 'electron';

// A macOS symbol for a menu item of the app's own (the standard ones get theirs from macOS), so it
// isn't the one without an icon (the user's choice). None elsewhere, or where the symbol is missing.
const symbol = (name) => {
  if (process.platform !== 'darwin' || !nativeImage.createMenuSymbol) return undefined;
  const image = nativeImage.createMenuSymbol(name);
  return image.isEmpty() ? undefined : image;
};

// The application menu. Entries that don't apply to the window's state are disabled rather than
// hidden. Each window shows at most one document, and the menu follows the focused window.
// `review` is null without one, else { highlights, canStartAgain, canClearDecisions }. `hasDraft`
// is whether a draft is showing, rather than nothing or a preview that isn't a draft yet.
export function buildMenu({ hasWindow, hasDocument, hasDraft, review, canStepBack, canStepForward, recent, actions }) {
  const isMac = process.platform === 'darwin';
  const imported = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: actions.showOpenDialog },
      {
        label: 'Open Recent',
        enabled: recent.length > 0,
        submenu: [
          ...recent.map((d) => ({ label: `${d.name} (imported ${imported(d.importedAt)})`, click: () => actions.openDocument(d.id) })),
        ],
      },
      { type: 'separator' },
      { label: 'Save Draft As…', accelerator: 'CmdOrCtrl+Shift+S', enabled: hasDraft, click: actions.saveDraftAs },
      { type: 'separator' },
      { label: 'New Variation…', enabled: hasDraft, click: actions.newVariation },
      { label: 'New Document from Draft', enabled: hasDraft, click: actions.documentFromDraft },
      { type: 'separator' },
      // One step at a time: a document back to the home screen, then the window itself.
      // A document's tab, or the window from Home (its pinned tab can't close).
      { label: hasDocument ? 'Close Tab' : 'Close Window', accelerator: 'CmdOrCtrl+W', enabled: hasWindow, click: actions.close },
    ],
  };

  // The standard Edit menu, with Find added.
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', enabled: hasDocument, click: () => actions.find('open') },
      { label: 'Find Next', accelerator: 'CmdOrCtrl+G', enabled: hasDocument, click: () => actions.find('next') },
      { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', enabled: hasDocument, click: () => actions.find('previous') },
      ...(isMac ? [{ type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : []),
    ],
  };

  const reviewMenu = {
    label: 'Review',
    submenu: [
      { label: 'Previous Draft', accelerator: 'CmdOrCtrl+[', enabled: canStepBack, click: () => actions.stepDraft(-1) },
      { label: 'Next Draft', accelerator: 'CmdOrCtrl+]', enabled: canStepForward, click: () => actions.stepDraft(1) },
      { type: 'separator' },
      { label: review?.highlights ? 'Start the Highlights Again…' : 'Start the Review Again…', enabled: Boolean(review?.canStartAgain), click: () => actions.resetReview(1) },
      ...(review?.highlights ? [] : [{ label: 'Clear My Decisions…', enabled: Boolean(review?.canClearDecisions), click: () => actions.resetReview(2) }]),
      { type: 'separator' },
      { label: 'Connect an AI…', click: actions.showConnectAi },
    ],
  };

  // The role keeps what macOS adds itself, such as the list of open windows.
  const windowMenu = {
    role: 'window',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: actions.newWindow },
      { type: 'separator' },
      { label: 'Show Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', enabled: hasWindow, click: () => actions.nextTab(-1) },
      { label: 'Show Next Tab', accelerator: 'CmdOrCtrl+Shift+]', enabled: hasWindow, click: () => actions.nextTab(1) },
      { type: 'separator' },
      // The AI chat, SmartDesktop's (started if it isn't running): it has no button in the window.
      { label: 'Show the Chat', accelerator: 'CmdOrCtrl+Shift+C', enabled: hasWindow, click: actions.showChat },
      { type: 'separator' },
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
    ],
  };

  // The standard app menu, with Settings in its usual place.
  const appMenu = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      // Its answer shows in the update toast (update-toast.js).
      { label: 'Check for Updates…', icon: symbol('arrow.down.circle'), click: actions.checkForUpdates },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: hasWindow, click: actions.showSettings },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    reviewMenu,
    windowMenu,
  ]);
}
