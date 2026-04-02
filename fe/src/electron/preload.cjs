const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blurItOut", {
  pickFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  pickOutputDir: () => ipcRenderer.invoke("dialog:pick-output"),
  listJobs: () => ipcRenderer.invoke("jobs:list"),
  listAnalyses: () => ipcRenderer.invoke("analyses:list"),
  startAnalysis: (payload) => ipcRenderer.invoke("analyses:start", payload),
  createJobs: (payload) => ipcRenderer.invoke("jobs:create", payload),
  cancelJob: (jobId) => ipcRenderer.invoke("jobs:cancel", jobId),
  cancelAnalysis: (analysisId) => ipcRenderer.invoke("analyses:cancel", analysisId),
  openOutput: (outputPath) => ipcRenderer.invoke("jobs:open-output", outputPath),
  openFolder: (outputPath) => ipcRenderer.invoke("jobs:open-folder", outputPath),
  onJobsUpdated: (callback) => {
    const listener = (_event, jobs) => callback(jobs);
    ipcRenderer.on("jobs:updated", listener);
    return () => ipcRenderer.removeListener("jobs:updated", listener);
  },
  onAnalysesUpdated: (callback) => {
    const listener = (_event, analyses) => callback(analyses);
    ipcRenderer.on("analyses:updated", listener);
    return () => ipcRenderer.removeListener("analyses:updated", listener);
  },
});
