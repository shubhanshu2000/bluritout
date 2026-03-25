import { useEffect, useState } from "react";
import "./App.css";

type JobStatus = "queued" | "preparing" | "processing" | "muxing" | "completed" | "failed" | "canceled";
type DeviceMode = "auto" | "cuda" | "cpu";

type JobRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  outputDir: string;
  blurTarget: "faces" | "plates" | "both";
  device: DeviceMode;
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  status: JobStatus;
  progress: number;
  frameProgress: { currentFrame: number; totalFrames: number } | null;
  fileSize: number;
  outputPaths: string[];
  error: string | null;
  requestedDevice?: DeviceMode;
  deviceUsed?: string;
  audioPreserved?: boolean;
  sourceHasAudio?: boolean;
  elapsedSeconds?: number;
};

type Settings = {
  blurTarget: "faces" | "plates" | "both";
  device: DeviceMode;
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  outputDir: string;
};

declare global {
  interface Window {
    blurItOut: {
      pickFiles: () => Promise<string[]>;
      pickFolder: () => Promise<string | null>;
      pickOutputDir: () => Promise<string | null>;
      listJobs: () => Promise<JobRecord[]>;
      createJobs: (payload: { inputPaths: string[]; settings: Settings }) => Promise<JobRecord[]>;
      cancelJob: (jobId: string) => Promise<boolean>;
      openOutput: (outputPath: string) => Promise<void>;
      openFolder: (outputPath: string) => Promise<void>;
      onJobsUpdated: (callback: (jobs: JobRecord[]) => void) => () => void;
    };
  }
}

const defaultSettings: Settings = {
  blurTarget: "both",
  device: "cuda",
  exportQuality: "near_source",
  audioMode: "preserve",
  outputDir: "",
};

function formatBytes(value: number) {
  if (!value) {
    return "Unknown size";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDeviceLabel(value?: string) {
  if (value === "cuda") {
    return "GPU";
  }
  if (value === "cpu") {
    return "CPU";
  }
  if (value === "auto") {
    return "Auto";
  }
  return "Unknown";
}

export default function App() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const bridge = window.blurItOut;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    bridge.listJobs().then(setJobs);
    const unsubscribe = bridge.onJobsUpdated(setJobs);
    return unsubscribe;
  }, [bridge]);

  async function handlePickFiles() {
    const files = await bridge.pickFiles();
    if (files.length > 0) {
      setSelectedPaths((current) => Array.from(new Set([...current, ...files])));
    }
  }

  async function handlePickFolder() {
    const folder = await bridge.pickFolder();
    if (folder) {
      setSelectedPaths((current) => Array.from(new Set([...current, folder])));
    }
  }

  async function handlePickOutput() {
    const outputDir = await bridge.pickOutputDir();
    if (outputDir) {
      setSettings((current) => ({ ...current, outputDir }));
    }
  }

  async function handleStart() {
    if (selectedPaths.length === 0) {
      return;
    }
    await bridge.createJobs({ inputPaths: selectedPaths, settings });
    setSelectedPaths([]);
  }

  return (
    <div className="app-shell">
      {!bridge ? (
        <main className="workspace bridge-error">
          <div className="empty-state">
            <h3>Electron bridge unavailable</h3>
            <p>
              The renderer loaded, but the preload API did not attach. Re-run <code>npm run transpile:electron</code> and restart
              Electron.
            </p>
          </div>
        </main>
      ) : null}

      {bridge ? (
        <>
          <aside className="sidebar">
            <div className="poster">
              <p className="eyebrow">BlurItOut</p>
              <h1>Private edits for creator-scale video.</h1>
              <p className="support-copy">
                Local processing, preserved audio, and controlled exports for long-form footage.
              </p>
            </div>

            <section className="control-group">
              <div className="section-header">
                <span>Inputs</span>
                <p>Build a queue from local videos or whole folders.</p>
              </div>

              <div className="action-row">
                <button onClick={() => void handlePickFiles()}>Add videos</button>
                <button className="ghost" onClick={() => void handlePickFolder()}>
                  Add folder
                </button>
              </div>

              <div className="selection-list">
                {selectedPaths.length === 0 ? (
                  <p className="muted">No media selected yet.</p>
                ) : (
                  selectedPaths.map((item) => (
                    <div key={item} className="selection-item">
                      {item}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="control-group">
              <div className="section-header">
                <span>Processing profile</span>
                <p>GPU is the default request. If it is unavailable, BlurItOut falls back to CPU.</p>
              </div>

              <label>
                Blur target
                <select
                  value={settings.blurTarget}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, blurTarget: event.target.value as Settings["blurTarget"] }))
                  }
                >
                  <option value="both">Faces + plates</option>
                  <option value="faces">Faces only</option>
                  <option value="plates">Plates only</option>
                </select>
              </label>

              <label>
                Device
                <select
                  value={settings.device}
                  onChange={(event) => setSettings((current) => ({ ...current, device: event.target.value as DeviceMode }))}
                >
                  <option value="cuda">GPU (recommended)</option>
                  <option value="cpu">CPU</option>
                  <option value="auto">Auto</option>
                </select>
              </label>

              <label>
                Quality profile
                <select
                  value={settings.exportQuality}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, exportQuality: event.target.value as Settings["exportQuality"] }))
                  }
                >
                  <option value="near_source">Near-source quality</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>

              <label>
                Audio
                <select value={settings.audioMode} onChange={() => undefined}>
                  <option value="preserve">Preserve original audio</option>
                </select>
              </label>

              <div className="output-row">
                <div>
                  <span>Output folder</span>
                  <p>{settings.outputDir || "Same folder as source"}</p>
                </div>
                <button className="ghost" onClick={() => void handlePickOutput()}>
                  Choose
                </button>
              </div>
            </section>

            <button className="primary-action" disabled={selectedPaths.length === 0} onClick={() => void handleStart()}>
              Start local processing
            </button>
          </aside>

          <main className="workspace">
            <header className="workspace-header">
              <div>
                <p className="eyebrow">Queue</p>
                <h2>Creator exports</h2>
              </div>
              <div className="header-notes">
                <span>Audio restored by default</span>
                <span>FFmpeg final export</span>
              </div>
            </header>

            <section className="jobs-grid">
              {jobs.length === 0 ? (
                <div className="empty-state">
                  <h3>No jobs yet</h3>
                  <p>Select one or more local videos to begin the first private export queue.</p>
                </div>
              ) : (
                jobs.map((job) => {
                  const outputPath = job.outputPaths[0];
                  const requestedDevice = job.requestedDevice || job.device;
                  const actualDevice = job.deviceUsed || job.device;
                  const canCancel = ["queued", "preparing", "processing", "muxing"].includes(job.status);

                  return (
                    <article key={job.id} className="job-card">
                      <div className="job-header">
                        <div>
                          <p className="job-title">{job.inputName}</p>
                          <p className="job-meta">
                            {formatBytes(job.fileSize)} | {job.blurTarget} | requested {formatDeviceLabel(requestedDevice)}
                          </p>
                        </div>
                        <span className={`status-pill status-${job.status}`}>{job.status}</span>
                      </div>

                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${job.progress}%` }} />
                      </div>

                      <div className="job-facts">
                        <span>{job.progress}% complete</span>
                        <span>
                          {job.frameProgress
                            ? `${job.frameProgress.currentFrame}/${job.frameProgress.totalFrames} frames`
                            : "Waiting for worker"}
                        </span>
                      </div>

                      <div className="job-notes">
                        <p>{job.exportQuality === "near_source" ? "Near-source export" : "Balanced export"}</p>
                        <p>
                          Using {formatDeviceLabel(actualDevice)}
                          {requestedDevice !== actualDevice ? ` (fallback from ${formatDeviceLabel(requestedDevice)})` : ""}
                        </p>
                        <p>{job.audioPreserved === false && job.sourceHasAudio ? "Audio fallback used" : "Audio preserved when available"}</p>
                      </div>

                      {job.error ? <p className="error-text">{job.error}</p> : null}

                      <div className="job-actions">
                        {canCancel ? (
                          <button className="ghost" onClick={() => void bridge.cancelJob(job.id)}>
                            Cancel
                          </button>
                        ) : null}
                        {outputPath ? (
                          <>
                            <button className="ghost" onClick={() => void bridge.openOutput(outputPath)}>
                              Show file
                            </button>
                            <button onClick={() => void bridge.openFolder(outputPath)}>Open folder</button>
                          </>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          </main>
        </>
      ) : null}
    </div>
  );
}
