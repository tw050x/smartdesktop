import { Menu } from 'electron';

// The application menu. Entries that don't apply to the window's state are disabled rather than
// hidden. The window shows at most one document, so "the document" is the window's state.
export function buildMenu({ hasDocument, canStepBack, canStepForward, recent, actions }) {
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
          { type: 'separator' },
          { label: 'Clear Menu', enabled: recent.length > 0, click: actions.clearRecent },
        ],
      },
      { type: 'separator' },
      { label: 'Save Draft As…', accelerator: 'CmdOrCtrl+Shift+S', enabled: hasDocument, click: actions.saveDraftAs },
      { type: 'separator' },
      { label: 'Close Document', accelerator: 'CmdOrCtrl+W', enabled: hasDocument, click: actions.close },
    ],
  };

  const reviewMenu = {
    label: 'Review',
    submenu: [
      { label: 'Previous Draft', accelerator: 'CmdOrCtrl+[', enabled: canStepBack, click: () => actions.stepDraft(-1) },
      { label: 'Next Draft', accelerator: 'CmdOrCtrl+]', enabled: canStepForward, click: () => actions.stepDraft(1) },
      { type: 'separator' },
      { label: 'Connect an AI…', click: actions.showConnectAi },
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    fileMenu,
    { role: 'editMenu' },
    reviewMenu,
    { role: 'windowMenu' },
  ]);
}
