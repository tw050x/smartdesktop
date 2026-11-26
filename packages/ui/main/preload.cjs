// The family's preload, for every page of an app that gives its API as data (its main/api.js, see
// tabs.js's `api`): it asks the main process for that list as it starts (synchronously, as a
// sandboxed preload can load no file of its own), and makes `window.<app>` from it, each call
// resolving with its value or rejecting with the main process's error, and each event taking a
// callback. With `platform`, `windowId` and `tabKind` from the page's arguments, as before.
const { contextBridge, ipcRenderer } = require('electron');

const { id, calls, events } = ipcRenderer.sendSync('preload-api');

const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${id}-${name}=`))?.split('=')[1];

const api = { platform: process.platform, windowId: argument('window'), tabKind: argument('tab') ?? null };
for (const [name, channel] of Object.entries(calls)) api[name] = (...args) => call(channel, ...args);
for (const [name, channel] of Object.entries(events)) api[name] = on(channel);

contextBridge.exposeInMainWorld(id, api);
