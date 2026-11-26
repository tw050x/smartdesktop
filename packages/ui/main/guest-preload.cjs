// The preload of a guest tab: another app's page shown in this app's window (see tabs.js's
// createGuestTab, guests.js). It makes the same `window.<app>` that app's own preload does, from
// the API it gives as data (asked of this app's main process, which has it from that app), but
// every call goes to this app's main process, which passes it on to that app's server, and the
// events come back the same way. The page can't tell it's a guest.
const { contextBridge, ipcRenderer } = require('electron');

const { id, calls, events } = ipcRenderer.sendSync('guest-api');

const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke('guest-call', channel, args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${id}-${name}=`))?.split('=')[1];

const api = { platform: process.platform, windowId: argument('window'), tabKind: argument('tab') ?? null };
for (const [name, channel] of Object.entries(calls)) api[name] = (...args) => call(channel, ...args);
for (const [name, channel] of Object.entries(events)) api[name] = on(channel);

contextBridge.exposeInMainWorld(id, api);
