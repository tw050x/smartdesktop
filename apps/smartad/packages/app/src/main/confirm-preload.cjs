const { contextBridge, ipcRenderer } = require('electron');

// The question window's only reach into the app: its answer, and its height (see confirm.js).
contextBridge.exposeInMainWorld('confirmWindow', {
  respond: (choice) => ipcRenderer.send('confirm-response', choice),
  fitHeight: (height) => ipcRenderer.send('confirm-fit', height),
});
