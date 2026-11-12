import { Menu } from 'electron';

// The application menu. Entries that don't apply to the window's state are disabled rather than
// hidden.
export function buildMenu({ hasWindow, inHome = false, actions }) {
  const isMac = process.platform === 'darwin';

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Schematic…', accelerator: 'CmdOrCtrl+Shift+N', click: actions.newSchema },
      { type: 'separator' },
      { label: 'Connect an AI…', click: actions.showConnectAi },
      { type: 'separator' },
      // A schematic's tab, or the window from Home (its pinned tab can't close).
      { label: inHome ? 'Close Window' : 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: hasWindow, click: actions.close },
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
