const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('shortListMe', {
  platform: process.platform,
  // Dropped files are opened by path, so the main process knows which file the window shows.
  openDroppedFile: (file) => ipcRenderer.invoke('open-path', webUtils.getPathForFile(file)),
  onFileOpened: (callback) => ipcRenderer.on('file-opened', (_event, file) => callback(file)),
  onFileClosed: (callback) => ipcRenderer.on('file-closed', () => callback()),
  onFullScreenChange: (callback) => ipcRenderer.on('full-screen', (_event, isFullScreen) => callback(isFullScreen)),
});
