const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jinjing", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testSettings: (settings) => ipcRenderer.invoke("settings:test", settings),
  searchEvidence: (params) => ipcRenderer.invoke("evidence:search", params),
  extractAttachment: (payload) => ipcRenderer.invoke("attachments:extract", payload),
  sendMessage: (payload) => ipcRenderer.invoke("chat:send", payload),
  interrupt: () => ipcRenderer.invoke("chat:interrupt"),
  newThread: () => ipcRenderer.invoke("chat:new"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  openExternal: (url) => ipcRenderer.invoke("system:open-external", url),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("jinjing:event", handler);
    return () => ipcRenderer.removeListener("jinjing:event", handler);
  },
});
