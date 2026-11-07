import { Menu } from 'electron';

// The application menu. Entries that don't apply to the window's state are disabled rather than
// hidden.
export function buildMenu({ hasWindow, actions }) {
  const isMac = process.platform === 'darwin';

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Schematic…', accelerator: 'CmdOrCtrl+Shift+N', click: actions.newSchema },
      { type: 'separator' },
      { label: 'Connect an AI…', click: actions.showConnectAi },
      { type: 'separator' },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+W', enabled: hasWindow, click: actions.close },
    ],
  };

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
      ...(isMac ? [{ type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : []),
    ],
  };

  // The role keeps what macOS adds itself, such as the list of open windows.
  const windowMenu = {
    role: 'window',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: actions.newWindow },
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
    windowMenu,
  ]);
}
