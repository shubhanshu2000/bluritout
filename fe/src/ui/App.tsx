import { useEffect, useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import "./App.css";
import type { AnalysisRecord, BlurTarget, DeviceMode, JobRecord, JobStatus, ModelPolicy, SelectionMode } from "../shared/types";

type Settings = {
  blurTarget: BlurTarget;
  device: DeviceMode;
  modelPolicy: ModelPolicy;
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  outputDir: string;
};

type HealthStatus = {
  workerAvailable: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  pythonPath: string | null;
  usingManagedPython: boolean;
  cudaAvailable: boolean | null;
  torchVersion: string | null;
  cudaVersion: string | null;
  cudaDeviceName: string | null;
  modelPolicy: string | null;
  configuredFaceProvider: string | null;
  faceProvider: string | null;
  faceModel: string | null;
  faceFallbackChain: string[];
  configuredPlateProvider: string | null;
  plateProvider: string | null;
  plateModelPath: string | null;
  plateModelExists: boolean | null;
  warnings: string[];
  errors: string[];
};

declare global {
  interface Window {
    blurItOut?: {
      pickFiles: () => Promise<string[]>;
      pickFolder: () => Promise<string | null>;
      pickOutputDir: () => Promise<string | null>;
      listJobs: () => Promise<JobRecord[]>;
      listAnalyses: () => Promise<AnalysisRecord[]>;
      startAnalysis: (payload: { inputPath: string; settings: { blurTarget: BlurTarget; device: DeviceMode; modelPolicy: ModelPolicy } }) => Promise<AnalysisRecord>;
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
      clearCompletedJobs: () => Promise<void>;
      removeJob: (jobId: string) => Promise<void>;
      openOutput: (outputPath: string) => Promise<void>;
      openFolder: (outputPath: string) => Promise<void>;
      getVersion: () => Promise<string>;
      healthCheck: (payload?: { modelPolicy?: ModelPolicy }) => Promise<HealthStatus>;
      getPreview: (previewPath: string) => Promise<string | null>;
      rerunAnalysis: (payload: { inputPath: string; settings: { blurTarget: BlurTarget; device: DeviceMode; modelPolicy: ModelPolicy } }) => Promise<AnalysisRecord>;
      onJobsUpdated: (callback: (jobs: JobRecord[]) => void) => () => void;
      onAnalysesUpdated: (callback: (analyses: AnalysisRecord[]) => void) => () => void;
    };
  }
}

const defaultSettings: Settings = {
  blurTarget: "both",
  device: "cuda",
  modelPolicy: "standard",
  exportQuality: "near_source",
  audioMode: "preserve",
  outputDir: "",
};

const supportedVideoPattern = /\.(mp4|mov|mkv|avi|m4v|webm)$/i;
const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["queued", "preparing", "processing", "muxing"]);

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  const paths: Record<string, ReactNode> = {
    check: (
      <>
        <path d="m5 13 4 4L19 7" />
      </>
    ),
    close: (
      <>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </>
    ),
    cpu: (
      <>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M9 1v3" />
        <path d="M15 1v3" />
        <path d="M9 20v3" />
        <path d="M15 20v3" />
        <path d="M1 9h3" />
        <path d="M1 15h3" />
        <path d="M20 9h3" />
        <path d="M20 15h3" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </>
    ),
    play: <polygon points="8 5 19 12 8 19 8 5" fill="currentColor" stroke="none" />,
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    queue: (
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12h2" />
        <path d="M3 12h2" />
        <path d="M12 3v2" />
        <path d="M12 19v2" />
        <path d="m17 7 1.5-1.5" />
        <path d="M5.5 18.5 7 17" />
        <path d="m17 17 1.5 1.5" />
        <path d="M5.5 5.5 7 7" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
    target: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3" />
        <path d="M12 19v3" />
        <path d="M2 12h3" />
        <path d="M19 12h3" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M6 6l1 15h10l1-15" />
      </>
    ),
    upload: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m17 8-5-5-5 5" />
        <path d="M12 3v12" />
      </>
    ),
    warn: (
      <>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </>
    ),
  };
  return <svg {...common}>{paths[name] || paths.info}</svg>;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(value: number) {
  if (!value) return "Unknown size";
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
  if (value === "cuda") return "GPU";
  if (value === "cpu") return "CPU";
  if (value === "auto") return "Auto";
  return "Unknown";
}

function sanitizeUserMessage(message: string) {
  if (!message) return "";
  if (/plate detection is unavailable with the current local model setup/i.test(message)) {
    return "";
  }
  if (/commercial[-\s]?safe|license|licensing|agpl|model policy/i.test(message)) {
    return "";
  }
  return message;
}

function visibleUserMessages(messages: string[]) {
  return messages.map(sanitizeUserMessage).filter((message, index, list) => message && list.indexOf(message) === index);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function estimateEta(job: JobRecord): string | null {
  if (!job.frameProgress || !job.startedAt || job.frameProgress.currentFrame === 0) return null;
  const elapsed = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  if (elapsed <= 0) return null;
  const fps = job.frameProgress.currentFrame / elapsed;
  if (fps <= 0) return null;
  const remaining = (job.frameProgress.totalFrames - job.frameProgress.currentFrame) / fps;
  return formatDuration(remaining);
}

export default function App() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisRecord[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("blur_selected");
  const [selectedTrackIds, setSelectedTrackIds] = useState<number[]>([]);
  const [version, setVersion] = useState<string>("");
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [trackThumbnails, setTrackThumbnails] = useState<{ analysisId: string; map: Map<number, string> } | null>(null);
  const [scenePreview, setScenePreview] = useState<{ previewPath: string; url: string | null } | null>(null);
  const bridge = window.blurItOut;

  useEffect(() => {
    if (!bridge) return;
    void bridge.listJobs().then(setJobs);
    void bridge.listAnalyses().then(setAnalyses);
    void bridge.getVersion().then(setVersion);
    void bridge.healthCheck({ modelPolicy: settings.modelPolicy }).then(setHealth);
    const unsubscribeJobs = bridge.onJobsUpdated(setJobs);
    const unsubscribeAnalyses = bridge.onAnalysesUpdated(setAnalyses);
    return () => {
      unsubscribeJobs();
      unsubscribeAnalyses();
    };
  }, [bridge, settings.modelPolicy]);

  const analyzablePath = selectedPaths.length === 1 && supportedVideoPattern.test(selectedPaths[0]) ? selectedPaths[0] : null;
  const currentAnalysis = useMemo(() => {
    if (!analyzablePath) return null;
    return analyses.find((item) => item.inputPath === analyzablePath) || null;
  }, [analyses, analyzablePath]);

  const analysisMatchesSelection =
    !!currentAnalysis &&
    currentAnalysis.status === "completed" &&
    currentAnalysis.blurTarget === settings.blurTarget &&
    currentAnalysis.modelPolicy === settings.modelPolicy &&
    Boolean(currentAnalysis.analysisPath);
  const scenePreviewUrl = currentAnalysis?.previewPath && scenePreview?.previewPath === currentAnalysis.previewPath ? scenePreview.url : null;
  const visibleTrackThumbnails = currentAnalysis && trackThumbnails?.analysisId === currentAnalysis.id ? trackThumbnails.map : new Map<number, string>();

  useEffect(() => {
    if (!bridge || !currentAnalysis?.previewPath) return;
    let cancelled = false;
    const previewPath = currentAnalysis.previewPath;
    void bridge.getPreview(previewPath).then((url) => {
      if (!cancelled) setScenePreview({ previewPath, url });
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, currentAnalysis?.previewPath]);

  useEffect(() => {
    if (!currentAnalysis || currentAnalysis.tracks.length === 0) return;
    const analysis = currentAnalysis;

    if (!scenePreviewUrl && (!bridge || !analysis.tracks.some((track) => track.preview_path))) {
      return;
    }

    let cancelled = false;
    async function loadThumbnails() {
      const map = new Map<number, string>();

      if (bridge) {
        const tracksWithFiles = analysis.tracks.filter((track) => track.preview_path);
        if (tracksWithFiles.length > 0) {
          const results = await Promise.all(
            tracksWithFiles.map((track) => bridge.getPreview(track.preview_path!).then((dataUrl) => ({ id: track.track_id, dataUrl }))),
          );
          if (cancelled) return;
          for (const { id, dataUrl } of results) {
            if (dataUrl) map.set(id, dataUrl);
          }
        }
      }

      const missingTracks = analysis.tracks.filter((track) => !map.has(track.track_id));
      if (scenePreviewUrl && missingTracks.length > 0) {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            if (cancelled) {
              resolve();
              return;
            }
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              resolve();
              return;
            }
            for (const track of missingTracks) {
              const [x1, y1, x2, y2] = track.representative_box;
              const rawWidth = x2 - x1;
              const rawHeight = y2 - y1;
              if (rawWidth <= 0 || rawHeight <= 0) continue;
              const pad = Math.max(20, Math.round(0.35 * Math.min(rawWidth, rawHeight)));
              const cx1 = Math.max(0, x1 - pad);
              const cy1 = Math.max(0, y1 - pad);
              const cx2 = Math.min(img.naturalWidth, x2 + pad);
              const cy2 = Math.min(img.naturalHeight, y2 + pad);
              const w = cx2 - cx1;
              const h = cy2 - cy1;
              if (w <= 0 || h <= 0) continue;
              canvas.width = w;
              canvas.height = h;
              ctx.clearRect(0, 0, w, h);
              ctx.drawImage(img, cx1, cy1, w, h, 0, 0, w, h);
              map.set(track.track_id, canvas.toDataURL("image/jpeg", 0.85));
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = scenePreviewUrl;
        });
      }

      if (!cancelled) {
        setTrackThumbnails({ analysisId: analysis.id, map });
      }
    }

    void loadThumbnails();
    return () => {
      cancelled = true;
    };
  }, [bridge, currentAnalysis, scenePreviewUrl]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!currentAnalysis || currentAnalysis.status !== "completed") {
        setSelectedTrackIds([]);
        return;
      }
      setSelectedTrackIds((current) => {
        if (current.length > 0) {
          const valid = current.filter((trackId) => currentAnalysis.tracks.some((track) => track.track_id === trackId));
          if (valid.length > 0) return valid;
        }
        if (currentAnalysis.previewTrackIds.length > 0) return currentAnalysis.previewTrackIds;
        return currentAnalysis.tracks.map((track) => track.track_id);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [currentAnalysis]);

  const hasCompletedJobs = jobs.some((job) => !ACTIVE_JOB_STATUSES.has(job.status));

  function addPaths(newPaths: string[]) {
    const videos = newPaths.filter((path) => supportedVideoPattern.test(path) || !path.includes("."));
    setSelectedPaths((current) => Array.from(new Set([...current, ...videos])));
  }

  function removePath(pathToRemove: string) {
    setSelectedPaths((current) => current.filter((path) => path !== pathToRemove));
  }

  async function handlePickFiles() {
    if (!bridge) return;
    const files = await bridge.pickFiles();
    if (files.length > 0) addPaths(files);
  }

  async function handlePickFolder() {
    if (!bridge) return;
    const folder = await bridge.pickFolder();
    if (folder) addPaths([folder]);
  }

  async function handlePickOutput() {
    if (!bridge) return;
    const outputDir = await bridge.pickOutputDir();
    if (outputDir) setSettings((current) => ({ ...current, outputDir }));
  }

  async function handleAnalyze() {
    if (!bridge || !analyzablePath) return;
    setSelectedTrackIds([]);
    const payload = {
      inputPath: analyzablePath,
      settings: { blurTarget: settings.blurTarget, device: settings.device, modelPolicy: settings.modelPolicy },
    };
    if (currentAnalysis) {
      await bridge.rerunAnalysis(payload);
      return;
    }
    await bridge.startAnalysis(payload);
  }

  async function handleStart() {
    if (!bridge || selectedPaths.length === 0 || actionsDisabled) return;
    const selectiveSettings =
      analysisMatchesSelection && analyzablePath ? { analysisPath: currentAnalysis?.analysisPath || null, selectionMode, selectedTrackIds } : {};
    await bridge.createJobs({
      inputPaths: selectedPaths,
      settings: { ...settings, ...selectiveSettings },
    });
    setSelectedPaths([]);
  }

  function toggleTrack(trackId: number) {
    setSelectedTrackIds((current) =>
      current.includes(trackId) ? current.filter((item) => item !== trackId) : [...current, trackId].sort((a, b) => a - b),
    );
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    const dropped = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    if (dropped.length > 0) addPaths(dropped);
  }

  const healthOk = !health || (health.workerAvailable && health.ffmpegAvailable && health.ffprobeAvailable && health.errors.length === 0);
  const actionsDisabled = !healthOk;
  const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  const historyJobs = jobs.filter((job) => !ACTIVE_JOB_STATUSES.has(job.status));
  const completedCount = jobs.filter((job) => job.status === "completed").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const faceTrackCount = currentAnalysis?.tracks.filter((track) => track.object_type === "face").length ?? 0;
  const plateTrackCount = currentAnalysis?.tracks.filter((track) => track.object_type === "plate").length ?? 0;
  const activeAnalysis = currentAnalysis && ["queued", "analyzing"].includes(currentAnalysis.status);
  const selectedInputLabel = selectedPaths.length === 0 ? "No source selected" : selectedPaths.length === 1 ? fileName(selectedPaths[0]) : `${selectedPaths.length} sources selected`;
  const visibleHealthErrors = visibleUserMessages(health?.errors ?? []);
  const currentAnalysisError = currentAnalysis?.error ? sanitizeUserMessage(currentAnalysis.error) : "";

  if (!bridge) {
    return (
      <main className="bridge-error">
        <div className="empty-panel">
          <h1>Electron bridge unavailable</h1>
          <p>The renderer loaded, but the preload API did not attach. Re-run npm run transpile:electron and restart Electron.</p>
        </div>
      </main>
    );
  }

  const renderJobCard = (job: JobRecord) => {
    const outputPath = job.outputPaths[0];
    const requestedDevice = job.requestedDevice || job.device;
    const actualDevice = job.deviceUsed || job.device;
    const canCancel = ACTIVE_JOB_STATUSES.has(job.status);
    const eta = job.status === "processing" ? estimateEta(job) : null;

    return (
      <article key={job.id} className="job-card">
        <div className="job-header">
          <div>
            <p className="job-title">{job.inputName}</p>
            <p className="job-meta">
              {formatBytes(job.fileSize)} / {job.blurTarget} / requested {formatDeviceLabel(requestedDevice)}
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
            {job.frameProgress ? `${job.frameProgress.currentFrame}/${job.frameProgress.totalFrames} frames` : "Waiting for worker"}
            {eta ? ` / ${eta} remaining` : ""}
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
              ? `${job.selectionMode === "keep_selected" ? "Keep selected IDs" : "Blur selected IDs"}: ${job.selectedTrackIds?.length || 0} tracked objects`
              : "Class-wide blur"}
          </p>
        </div>

        {job.error ? <p className="error-text">{job.error}</p> : null}

        <div className="job-actions">
          {canCancel ? (
            <button className="ghost" onClick={() => void bridge.cancelJob(job.id)}>
              Cancel
            </button>
          ) : (
            <button className="ghost remove-job-btn" onClick={() => void bridge.removeJob(job.id)}>
              <Icon name="trash" />
              Remove
            </button>
          )}
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
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="titlebar-crumbs">
          <span>BlurItOut</span>
          <span>/</span>
          <strong>{selectedInputLabel}</strong>
        </div>
        <div className="titlebar-actions">
          {version ? <span className="version-pill">v{version}</span> : null}
        </div>
      </header>

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <p>BlurItOut</p>
            <span>Local privacy editor</span>
          </div>
        </div>

        <button className="new-job-btn" disabled={selectedPaths.length === 0 || actionsDisabled} onClick={() => void handleStart()}>
          <Icon name="plus" />
          Start export
        </button>

        <div className="side-section">
          <p className="side-label">Session</p>
          <div className="side-stat">
            <span>Sources</span>
            <strong>{selectedPaths.length}</strong>
          </div>
          <div className="side-stat">
            <span>Active jobs</span>
            <strong>{activeJobs.length}</strong>
          </div>
          <div className="side-stat">
            <span>Completed</span>
            <strong>{completedCount}</strong>
          </div>
          <div className="side-stat">
            <span>Failed</span>
            <strong>{failedCount}</strong>
          </div>
        </div>

      </aside>

      <main className="main">
        <section className="screen">
          <div className="screen-head">
            <div>
              <p className="eyebrow">Desktop workspace</p>
              <h1>Detect, choose, blur, export.</h1>
              <p className="screen-copy">Import local videos, analyze one source for stable face and plate IDs, then export with audio preserved.</p>
            </div>
            <div className="head-metrics">
              <div>
                <span>Faces</span>
                <strong>{faceTrackCount}</strong>
              </div>
              <div>
                <span>Plates</span>
                <strong>{plateTrackCount}</strong>
              </div>
              <div>
                <span>Selected</span>
                <strong>{selectedTrackIds.length}</strong>
              </div>
            </div>
          </div>

          {health && !healthOk && visibleHealthErrors.length > 0 ? (
            <div className="alert error">
              <Icon name="warn" />
              <div>
                <strong>Worker setup needs attention</strong>
                {visibleHealthErrors.map((error, index) => (
                  <p key={index}>{error}</p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="process-grid">
            <div className="control-stack">
              <section className="panel import-panel" id="import">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">01</p>
                    <h2>Import sources</h2>
                  </div>
                  <Icon name="folder" />
                </div>

                <div className={`drop-zone${isDragOver ? " drag-over" : ""}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                  <div className="drop-icon">
                    <Icon name="upload" size={22} />
                  </div>
                  <h3>Drop videos here</h3>
                  <p>Use one video for selective tracking, or multiple files/folders for batch class blur.</p>
                  <div className="button-row">
                    <button onClick={() => void handlePickFiles()}>
                      <Icon name="plus" />
                      Add videos
                    </button>
                    <button className="ghost" onClick={() => void handlePickFolder()}>
                      Add folder
                    </button>
                  </div>
                </div>

                <div className="selected-list">
                  {selectedPaths.length === 0 ? (
                    <p className="muted">No media selected yet.</p>
                  ) : (
                    selectedPaths.map((path) => (
                      <div key={path} className="selected-item">
                        <div>
                          <strong>{fileName(path)}</strong>
                          <span>{path}</span>
                        </div>
                        <button className="icon-btn" title="Remove" onClick={() => removePath(path)}>
                          <Icon name="close" />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {selectedPaths.length > 0 ? (
                  <button className="ghost full" onClick={() => setSelectedPaths([])}>
                    Clear sources
                  </button>
                ) : null}
              </section>

              <section className="panel settings-panel">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">03</p>
                    <h2>Process video</h2>
                  </div>
                  <Icon name="settings" />
                </div>

                <div className="settings-grid">
                  <label>
                    <span>Blur target</span>
                    <select value={settings.blurTarget} onChange={(event) => setSettings((current) => ({ ...current, blurTarget: event.target.value as BlurTarget }))}>
                      <option value="both">Faces + plates</option>
                      <option value="faces">Faces only</option>
                      <option value="plates">Plates only</option>
                    </select>
                  </label>

                  <label>
                    <span>Device</span>
                    <select value={settings.device} onChange={(event) => setSettings((current) => ({ ...current, device: event.target.value as DeviceMode }))}>
                      <option value="cuda">GPU (recommended)</option>
                      <option value="cpu">CPU</option>
                      <option value="auto">Auto</option>
                    </select>
                  </label>

                  <label>
                    <span>Selection logic</span>
                    <select value={selectionMode} onChange={(event) => setSelectionMode(event.target.value as SelectionMode)}>
                      <option value="blur_selected">Blur selected IDs</option>
                      <option value="keep_selected">Keep selected IDs, blur the rest</option>
                    </select>
                  </label>

                  <label>
                    <span>Quality</span>
                    <select
                      value={settings.exportQuality}
                      onChange={(event) => setSettings((current) => ({ ...current, exportQuality: event.target.value as Settings["exportQuality"] }))}
                    >
                      <option value="near_source">Near-source</option>
                      <option value="balanced">Balanced</option>
                    </select>
                  </label>
                </div>

                <div className="output-card compact-output">
                  <div>
                    <span>Output</span>
                    <p>{settings.outputDir || "Same folder as source"}</p>
                  </div>
                  <button className="ghost" onClick={() => void handlePickOutput()}>
                    Choose
                  </button>
                </div>

                <button className="primary-action" disabled={selectedPaths.length === 0 || actionsDisabled} onClick={() => void handleStart()}>
                  <Icon name="play" />
                  Start local processing
                </button>
              </section>
            </div>

            <section className="panel stage-panel" id="analysis">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">02</p>
                  <h2>Selective preview</h2>
                </div>
                {currentAnalysis ? <span className={`status-pill status-${currentAnalysis.status}`}>{currentAnalysis.status}</span> : null}
              </div>

              <div className="preview-stage">
                {scenePreviewUrl ? (
                  <img src={scenePreviewUrl} alt="Annotated analysis preview" />
                ) : (
                  <div className="preview-empty">
                    <div className="blur-logo">BLUR</div>
                    <h3>{analyzablePath ? "Run analysis to build preview" : "Select exactly one video"}</h3>
                    <p>Tracked face and plate IDs appear here after analysis.</p>
                  </div>
                )}
              </div>

              {currentAnalysis ? (
                <>
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
                  <p className="job-meta">
                    Requested {formatDeviceLabel(currentAnalysis.requestedDevice || currentAnalysis.device)} / using{" "}
                    {formatDeviceLabel(currentAnalysis.deviceUsed || currentAnalysis.device)}
                  </p>
                  {currentAnalysisError ? <p className="error-text">{currentAnalysisError}</p> : null}
                </>
              ) : null}

              <div className="button-row stage-actions">
                <button onClick={() => void handleAnalyze()} disabled={!analyzablePath}>
                  <Icon name="target" />
                  {currentAnalysis ? "Re-analyze" : "Analyze video"}
                </button>
                {activeAnalysis && currentAnalysis ? (
                  <button className="ghost" onClick={() => void bridge.cancelAnalysis(currentAnalysis.id)}>
                    <Icon name="stop" />
                    Cancel analysis
                  </button>
                ) : null}
              </div>

              {!analyzablePath ? <p className="muted">Selective blur requires exactly one selected video.</p> : null}
              {currentAnalysis && currentAnalysis.blurTarget !== settings.blurTarget ? (
                <p className="warning-text">Blur target changed since the last analysis. Re-run analysis before selective export.</p>
              ) : null}
              {analysisMatchesSelection ? <p className="ready-text">Analysis ready. The next export will use the selected tracked IDs.</p> : null}
            </section>

            <section className="panel tracks-panel">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">02B</p>
                  <h2>Select faces and plates</h2>
                </div>
                {currentAnalysis?.tracks.length ? (
                  <div className="button-row compact">
                    <button className="ghost" onClick={() => setSelectedTrackIds(currentAnalysis.tracks.map((track) => track.track_id))}>
                      Select all
                    </button>
                    <button className="ghost" onClick={() => setSelectedTrackIds([])}>
                      Clear
                    </button>
                  </div>
                ) : null}
              </div>

              {!analyzablePath ? (
                <div className="empty-panel">
                  <h3>Select one video</h3>
                  <p>Face and plate choices are available after one source is selected and analyzed.</p>
                </div>
              ) : !currentAnalysis ? (
                <div className="empty-panel">
                  <h3>No analysis yet</h3>
                  <p>Run analysis to create stable object IDs and thumbnails.</p>
                </div>
              ) : (
                <div className="track-grid">
                  {currentAnalysis.tracks.length === 0 ? (
                    <p className="muted">No tracked objects yet.</p>
                  ) : (
                    currentAnalysis.tracks.map((track) => {
                      const checked = selectedTrackIds.includes(track.track_id);
                      const thumb = visibleTrackThumbnails.get(track.track_id);
                      let plateVerification =
                        track.object_type === "plate"
                          ? track.plate_verification_source === "paddleocr"
                            ? track.plate_verified
                              ? `OCR verified${track.plate_text ? ` / ${track.plate_text}` : ""}`
                              : "OCR rejected"
                            : track.plate_ocr_error
                              ? "Geometry verified (OCR unavailable)"
                              : "Geometry verified"
                          : null;
                      if (track.object_type === "plate" && track.plate_verification_source === "paddleocr" && !track.plate_verified && !track.plate_text) {
                        plateVerification = "OCR unconfirmed";
                      }
                      return (
                        <label key={track.track_id} className={`track-card ${checked ? "selected" : ""}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleTrack(track.track_id)} />
                          {thumb ? <img src={thumb} alt={track.label} /> : <div className="track-placeholder" />}
                          <div>
                            <div className="track-title">
                              <strong>{track.label}</strong>
                              <span className={`track-type ${track.object_type}`}>{track.object_type}</span>
                            </div>
                            <p>
                              ID {track.track_id} / seen {track.frames_seen} frames / {track.first_seen_frame}-{track.last_seen_frame}
                            </p>
                            {plateVerification ? <span className="track-note">{plateVerification}</span> : null}
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </section>
          </div>

          <div className="lower-grid">
            <section className="panel queue-panel current-processing-panel" id="queue">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Current</p>
                  <h2>Processing now</h2>
                </div>
                <Icon name="queue" />
              </div>

              <div className="jobs-list">
                {activeJobs.length === 0 ? (
                  <div className="empty-panel">
                    <h3>No active processing</h3>
                    <p>Start local processing to see live progress, cancel controls, and frame status here.</p>
                  </div>
                ) : (
                  activeJobs.map(renderJobCard)
                )}
              </div>
            </section>

            <section className="panel queue-panel history-panel">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">History</p>
                  <h2>Finished exports</h2>
                </div>
                {hasCompletedJobs ? (
                  <button className="ghost" onClick={() => void bridge.clearCompletedJobs()}>
                    Clear history
                  </button>
                ) : (
                  <Icon name="queue" />
                )}
              </div>

              <div className="jobs-list history-list">
                {historyJobs.length === 0 ? (
                  <div className="empty-panel">
                    <h3>No export history</h3>
                    <p>Completed, failed, and canceled jobs will appear here after processing.</p>
                  </div>
                ) : (
                  historyJobs.map(renderJobCard)
                )}
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
