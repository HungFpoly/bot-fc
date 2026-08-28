const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  saveVideo: (buffer, filename) => ipcRenderer.send("save-video", { buffer, filename }),
  onSaveVideoResult: (cb) => ipcRenderer.on("save-video-result", (_, result) => cb(result)),
});
