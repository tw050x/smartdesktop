import { Menu } from 'electron';
import path from 'node:path';

const isMac = process.platform === 'darwin';
const showInFolderLabel = { darwin: 'Show in Finder', win32: 'Show in File Explorer' }[process.platform] ?? 'Show in File Manager';

// The application menu. The File menu always lists every entry and disables the ones that
// don't apply: the window shows at most one file, so "the open file" is the window's state.
export function buildMenu({ file, recent, actions }) {
  const hasFile = Boolean(file);

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: actions.showOpenDialog },
      {
        label: 'Open Recent',
        enabled: recent.length > 0,
        submenu: [
          ...recent.map((p) => ({ label: path.basename(p), toolTip: p, click: () => actions.open(p) })),
          { type: 'separator' },
          { label: 'Clear Menu', enabled: recent.length > 0, click: actions.clearRecent },
        ],
      },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: hasFile, click: actions.reload },
      { label: showInFolderLabel, enabled: hasFile, click: actions.showInFolder },
      { type: 'separator' },
      { label: 'Close File', accelerator: 'CmdOrCtrl+W', enabled: hasFile, click: actions.close },
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    fileMenu,
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]);
}
