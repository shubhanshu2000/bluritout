const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blurItOut", {
  // File / folder selection
  pickFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  pickOutputDir: () => ipcRenderer.invoke("dialog:pick-output"),

  // Job management
  listJobs: () => ipcRenderer.invoke("jobs:list"),
  createJobs: (payload) => ipcRenderer.invoke("jobs:create", payload),
  cancelJob: (jobId) => ipcRenderer.invoke("jobs:cancel", jobId),
  clearCompletedJobs: () => ipcRenderer.invoke("jobs:clear-completed"),
  removeJob: (jobId) => ipcRenderer.invoke("jobs:remove", jobId),

  // Analysis management
  listAnalyses: () => ipcRenderer.invoke("analyses:list"),
  startAnalysis: (payload) => ipcRenderer.invoke("analyses:start", payload),
  cancelAnalysis: (analysisId) => ipcRenderer.invoke("analyses:cancel", analysisId),

  // Shell operations (security: validated server-side to known output paths)
  openOutput: (outputPath) => ipcRenderer.invoke("jobs:open-output", outputPath),
  openFolder: (outputPath) => ipcRenderer.invoke("jobs:open-folder", outputPath),

  // Analysis extras
  getPreview: (previewPath) => ipcRenderer.invoke("analyses:get-preview", previewPath),
  rerunAnalysis: (payload) => ipcRenderer.invoke("analyses:rerun", payload),

  // App info
  getVersion: () => ipcRenderer.invoke("app:version"),
  healthCheck: (payload) => ipcRenderer.invoke("app:health-check", payload),

  // Event subscriptions (return unsubscribe function)
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
