import { useEffect, useMemo, useState } from "react";
import "./App.css";

type JobStatus = "queued" | "preparing" | "processing" | "muxing" | "completed" | "failed" | "canceled";
type AnalysisStatus = "queued" | "analyzing" | "completed" | "failed" | "canceled";
type DeviceMode = "auto" | "cuda" | "cpu";
type BlurTarget = "faces" | "plates" | "both";
type SelectionMode = "blur_selected" | "keep_selected";

type JobRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  outputDir: string;
  blurTarget: BlurTarget;
  device: DeviceMode;
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  selectionMode?: SelectionMode;
  selectedTrackIds?: number[];
  analysisPath?: string | null;
  status: JobStatus;
  progress: number;
  frameProgress: { currentFrame: number; totalFrames: number } | null;
  fileSize: number;
  outputPaths: string[];
  error: string | null;
  requestedDevice?: DeviceMode;
  deviceUsed?: string;
  workerPython?: string;
  audioPreserved?: boolean;
  sourceHasAudio?: boolean;
  elapsedSeconds?: number;
};

type TrackSummary = {
  track_id: number;
  object_type: "face" | "plate";
  label: string;
  first_seen_frame: number;
  last_seen_frame: number;
  frames_seen: number;
  representative_box: [number, number, number, number];
};

type AnalysisRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  blurTarget: BlurTarget;
  device: DeviceMode;
  status: AnalysisStatus;
  progress: number;
  frameProgress: { currentFrame: number; totalFrames: number } | null;
  error: string | null;
  requestedDevice?: DeviceMode;
  deviceUsed?: string;
  workerPython?: string;
  message?: string | null;
  analysisPath?: string | null;
  previewPath?: string | null;
  tracks: TrackSummary[];
  previewTrackIds: number[];
};

type Settings = {
  blurTarget: BlurTarget;
  device: DeviceMode;
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  outputDir: string;
};

declare global {
  interface Window {
    blurItOut?: {
      pickFiles: () => Promise<string[]>;
      pickFolder: () => Promise<string | null>;
      pickOutputDir: () => Promise<string | null>;
      listJobs: () => Promise<JobRecord[]>;
      listAnalyses: () => Promise<AnalysisRecord[]>;
      startAnalysis: (payload: { inputPath: string; settings: { blurTarget: BlurTarget; device: DeviceMode } }) => Promise<AnalysisRecord>;
      createJobs: (payload: {
        inputPaths: string[];
        settings: Settings & {
          analysisPath?: string | null;
          selectionMode?: SelectionMode;
          selectedTrackIds?: number[];
        };
      }) => Promise<JobRecord[]>;
      cancelJob: (jobId: string) => Promise<boolean>;
      cancelAnalysis: (analysisId: string) => Promise<boolean>;
      openOutput: (outputPath: string) => Promise<void>;
      openFolder: (outputPath: string) => Promise<void>;
      onJobsUpdated: (callback: (jobs: JobRecord[]) => void) => () => void;
      onAnalysesUpdated: (callback: (analyses: AnalysisRecord[]) => void) => () => void;
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

const supportedVideoPattern = /\.(mp4|mov|mkv|avi|m4v|webm)$/i;

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

function toFileUrl(filePath?: string | null) {
  if (!filePath) {
    return "";
  }
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

export default function App() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisRecord[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("blur_selected");
  const [selectedTrackIds, setSelectedTrackIds] = useState<number[]>([]);
  const bridge = window.blurItOut;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    void bridge.listJobs().then(setJobs);
    void bridge.listAnalyses().then(setAnalyses);
    const unsubscribeJobs = bridge.onJobsUpdated(setJobs);
    const unsubscribeAnalyses = bridge.onAnalysesUpdated(setAnalyses);
    return () => {
      unsubscribeJobs();
      unsubscribeAnalyses();
    };
  }, [bridge]);

  const analyzablePath = selectedPaths.length === 1 && supportedVideoPattern.test(selectedPaths[0]) ? selectedPaths[0] : null;
  const currentAnalysis = useMemo(() => {
    if (!analyzablePath) {
      return null;
    }
    return analyses.find((item) => item.inputPath === analyzablePath) || null;
  }, [analyses, analyzablePath]);

  const analysisMatchesSelection =
    !!currentAnalysis &&
    currentAnalysis.status === "completed" &&
    currentAnalysis.blurTarget === settings.blurTarget &&
    Boolean(currentAnalysis.analysisPath);

  useEffect(() => {
    if (!currentAnalysis || currentAnalysis.status !== "completed") {
      setSelectedTrackIds([]);
      return;
    }

    setSelectedTrackIds((current) => {
      if (current.length > 0) {
        const valid = current.filter((trackId) => currentAnalysis.tracks.some((track) => track.track_id === trackId));
        if (valid.length > 0) {
          return valid;
        }
      }
      if (currentAnalysis.previewTrackIds.length > 0) {
        return currentAnalysis.previewTrackIds;
      }
      return currentAnalysis.tracks.map((track) => track.track_id);
    });
  }, [currentAnalysis]);

  async function handlePickFiles() {
    if (!bridge) {
      return;
    }
    const files = await bridge.pickFiles();
    if (files.length > 0) {
      setSelectedPaths((current) => Array.from(new Set([...current, ...files])));
    }
  }

  async function handlePickFolder() {
    if (!bridge) {
      return;
    }
    const folder = await bridge.pickFolder();
    if (folder) {
      setSelectedPaths((current) => Array.from(new Set([...current, folder])));
    }
  }

  async function handlePickOutput() {
    if (!bridge) {
      return;
    }
    const outputDir = await bridge.pickOutputDir();
    if (outputDir) {
      setSettings((current) => ({ ...current, outputDir }));
    }
  }

  async function handleAnalyze() {
    if (!bridge || !analyzablePath) {
      return;
    }
    setSelectedTrackIds([]);
    await bridge.startAnalysis({
      inputPath: analyzablePath,
      settings: {
        blurTarget: settings.blurTarget,
        device: settings.device,
      },
    });
  }

  async function handleStart() {
    if (!bridge || selectedPaths.length === 0) {
      return;
    }

    const selectiveSettings =
      analysisMatchesSelection && analyzablePath
        ? {
            analysisPath: currentAnalysis?.analysisPath || null,
            selectionMode,
            selectedTrackIds,
          }
        : {};

    await bridge.createJobs({
      inputPaths: selectedPaths,
      settings: {
        ...settings,
        ...selectiveSettings,
      },
    });
    setSelectedPaths([]);
  }

  function toggleTrack(trackId: number) {
    setSelectedTrackIds((current) =>
      current.includes(trackId) ? current.filter((item) => item !== trackId) : [...current, trackId].sort((a, b) => a - b),
    );
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
              <p className="support-copy">Detect, track, choose specific IDs, then export locally with restored audio.</p>
            </div>

            <section className="control-group">
              <div className="section-header">
                <span>Inputs</span>
                <p>Pick one video for selective tracking, or queue multiple paths for class-based batch export.</p>
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
                <p>GPU is requested by default. If it is unavailable at runtime, BlurItOut falls back to CPU.</p>
              </div>

              <label>
                Blur target
                <select
                  value={settings.blurTarget}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, blurTarget: event.target.value as BlurTarget }))
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

            <section className="control-group">
              <div className="section-header">
                <span>Selective blur</span>
                <p>Analyze one video to track consistent IDs across frames, then choose which tracked objects to blur or keep.</p>
              </div>

              <div className="analysis-controls">
                <button onClick={() => void handleAnalyze()} disabled={!analyzablePath}>
                  Analyze selected video
                </button>
                {currentAnalysis && ["queued", "analyzing"].includes(currentAnalysis.status) ? (
                  <button className="ghost" onClick={() => void bridge.cancelAnalysis(currentAnalysis.id)}>
                    Cancel analysis
                  </button>
                ) : null}
              </div>

              {!analyzablePath ? <p className="muted">Selective blur requires exactly one selected video.</p> : null}
              {currentAnalysis && currentAnalysis.blurTarget !== settings.blurTarget ? (
                <p className="warning-text">Blur target changed since the last analysis. Re-run analysis before selective export.</p>
              ) : null}
              {analysisMatchesSelection ? (
                <p className="muted">Analysis ready. Your next export will use the selected tracked IDs.</p>
              ) : null}

              <label>
                Selection logic
                <select value={selectionMode} onChange={(event) => setSelectionMode(event.target.value as SelectionMode)}>
                  <option value="blur_selected">Blur selected IDs</option>
                  <option value="keep_selected">Keep selected IDs, blur the rest</option>
                </select>
              </label>
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
                <span>Tracking-by-detection for selective blur</span>
              </div>
            </header>

            <section className="analysis-panel">
              <div className="analysis-summary">
                <div>
                  <p className="eyebrow">Tracked IDs</p>
                  <h3>Analysis preview</h3>
                </div>
                {currentAnalysis ? (
                  <span className={`status-pill status-${currentAnalysis.status}`}>{currentAnalysis.status}</span>
                ) : null}
              </div>

              {!analyzablePath ? (
                <div className="empty-state">
                  <h3>Select one video</h3>
                  <p>Choose a single source file to preview tracked objects and map the UI directly to stable track IDs.</p>
                </div>
              ) : !currentAnalysis ? (
                <div className="empty-state">
                  <h3>No analysis yet</h3>
                  <p>Run analysis to detect faces and number plates, assign track IDs, and make object-level blur decisions.</p>
                </div>
              ) : (
                <div className="analysis-grid">
                  <div className="preview-card">
                    {currentAnalysis.previewPath ? (
                      <img className="preview-image" src={toFileUrl(currentAnalysis.previewPath)} alt="Tracked object preview" />
                    ) : (
                      <div className="preview-placeholder">Preview will appear after analysis finishes.</div>
                    )}
                  </div>

                  <div className="track-list-card">
                    <div className="track-toolbar">
                      <div>
                        <p className="job-title">{currentAnalysis.inputName}</p>
                        <p className="job-meta">
                          Requested {formatDeviceLabel(currentAnalysis.requestedDevice || currentAnalysis.device)} • using{" "}
                          {formatDeviceLabel(currentAnalysis.deviceUsed || currentAnalysis.device)}
                        </p>
                      </div>
                      {currentAnalysis.tracks.length > 0 ? (
                        <div className="mini-actions">
                          <button className="ghost" onClick={() => setSelectedTrackIds(currentAnalysis.tracks.map((track) => track.track_id))}>
                            Select all
                          </button>
                          <button className="ghost" onClick={() => setSelectedTrackIds([])}>
                            Clear
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${currentAnalysis.progress}%` }} />
                    </div>

                    <div className="job-facts">
                      <span>{currentAnalysis.progress}% complete</span>
                      <span>
                        {currentAnalysis.frameProgress
                          ? `${currentAnalysis.frameProgress.currentFrame}/${currentAnalysis.frameProgress.totalFrames} frames`
                          : "Waiting for analysis worker"}
                      </span>
                    </div>

                    {currentAnalysis.error ? <p className="error-text">{currentAnalysis.error}</p> : null}

                    <div className="job-notes">
                      <p>
                        Worker: {currentAnalysis.workerPython || "Resolving analysis worker path..."}
                      </p>
                      <p>
                        Requested {formatDeviceLabel(currentAnalysis.requestedDevice || currentAnalysis.device)} • using{" "}
                        {formatDeviceLabel(currentAnalysis.deviceUsed || currentAnalysis.device)}
                      </p>
                    </div>

                    <div className="track-list">
                      {currentAnalysis.tracks.length === 0 ? (
                        <p className="muted">No tracked objects yet.</p>
                      ) : (
                        currentAnalysis.tracks.map((track) => {
                          const checked = selectedTrackIds.includes(track.track_id);
                          return (
                            <label key={track.track_id} className={`track-row ${checked ? "track-row-selected" : ""}`}>
                              <input type="checkbox" checked={checked} onChange={() => toggleTrack(track.track_id)} />
                              <div>
                                <div className="track-heading">
                                  <strong>{track.label}</strong>
                                  <span className={`track-type track-type-${track.object_type}`}>{track.object_type}</span>
                                </div>
                                <p className="job-meta">
                                  ID {track.track_id} • seen {track.frames_seen} frames • frames {track.first_seen_frame} to{" "}
                                  {track.last_seen_frame}
                                </p>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

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
                        <p>{job.workerPython ? `Worker: ${job.workerPython}` : "Worker path resolving..."}</p>
                        <p>{job.audioPreserved === false && job.sourceHasAudio ? "Audio fallback used" : "Audio preserved when available"}</p>
                        <p>
                          {job.analysisPath
                            ? `${job.selectionMode === "keep_selected" ? "Keep selected IDs" : "Blur selected IDs"}: ${
                                job.selectedTrackIds?.length || 0
                              } tracked objects`
                            : "Class-wide blur"}
                        </p>
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
