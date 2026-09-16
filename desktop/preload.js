// Exposes a minimal, explicit bridge to the renderer (the same web UI the
// browser version uses) so it can detect "am I running inside the desktop
// shell?" and, if so, offer native folder pickers and a backend restart --
// contextBridge keeps this the *only* thing the page can reach into Node/
// Electron internals for for.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  restartBackend: () => ipcRenderer.invoke("restart-backend"),
});
