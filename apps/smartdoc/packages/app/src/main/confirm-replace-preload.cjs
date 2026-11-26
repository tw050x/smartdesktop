const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('confirmReplace', {
  respond: (choice) => ipcRenderer.send('confirm-replace-response', choice),
  fitHeight: (height) => ipcRenderer.send('confirm-replace-fit', height),
});
