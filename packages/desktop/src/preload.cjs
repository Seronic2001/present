// What Studio may ask of the app. Its presence is also how Studio knows it is in the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presentDesktop', {
  platform: process.platform,
  menu: () => ipcRenderer.send('app:menu'),
  exportDeck: options => ipcRenderer.invoke('deck:export', options),
  displays: () => ipcRenderer.invoke('show:displays'),
  start: options => ipcRenderer.invoke('show:start', options),
  stop: () => ipcRenderer.invoke('show:stop'),
  onShow: listener => { ipcRenderer.on('show:state', (_e, state) => listener(state)); },
  onToggle: listener => { ipcRenderer.on('show:toggle', () => listener()); },
  onBegin: listener => { ipcRenderer.on('show:begin', () => listener()); },
});
