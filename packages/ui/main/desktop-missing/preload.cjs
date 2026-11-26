const { contextBridge, ipcRenderer } = require('electron');

// The SmartDesktop-missing window's only reach into the app: installing, its progress, its answer and
// its height (see desktop-missing.js).
contextBridge.exposeInMainWorld('desktopMissing', {
  install: () => ipcRenderer.send('desktop-missing-install'),
  respond: (choice) => ipcRenderer.send('desktop-missing-response', choice),
  fitHeight: (height) => ipcRenderer.send('desktop-missing-fit', height),
  onProgress: (callback) => ipcRenderer.on('desktop-missing-progress', (_event, value) => callback(value)),
});
