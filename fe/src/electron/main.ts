import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

type JobStatus = "queued" | "preparing" | "processing" | "muxing" | "completed" | "failed" | "canceled";
type DeviceMode = "auto" | "cuda" | "cpu";
type BlurTarget = "faces" | "plates" | "both";
type SelectionMode = "blur_selected" | "keep_selected";
type AnalysisStatus = "queued" | "analyzing" | "completed" | "failed" | "canceled";

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
  createdAt: string;
  updatedAt: string;
  error: string | null;
  message?: string | null;
  startedAt?: string | null;
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
  createdAt: string;
  updatedAt: string;
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

type JobSettings = Pick<JobRecord, "blurTarget" | "device" | "exportQuality" | "audioMode"> & {
  outputDir?: string;
  selectionMode?: SelectionMode;
  selectedTrackIds?: number[];
  analysisPath?: string | null;
};

type AnalysisSettings = {
  blurTarget: BlurTarget;
  device: DeviceMode;
};

type AnalysisStartPayload = {
  inputPath: string;
  settings: AnalysisSettings;
};

const jobStoreName = "bluritout-jobs.json";
const analysisStoreName = "bluritout-analyses.json";
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const workerState = {
  queue: [] as string[],
  runningJobId: null as string | null,
  runningAnalysisId: null as string | null,
  jobs: new Map<string, JobRecord>(),
  analyses: new Map<string, AnalysisRecord>(),
  analysisByInput: new Map<string, string>(),
  processes: new Map<string, ReturnType<typeof spawn>>(),
};

function userStorePath(fileName: string) {
  return path.join(app.getPath("userData"), fileName);
}

function normalizeWindowsExecutablePath(rawPath: string) {
  if (/^\/[a-zA-Z]\//.test(rawPath)) {
    return `${rawPath[1]}:${rawPath.slice(2)}`;
  }
  return rawPath;
}

/** Resolve the worker executable / script path + command for spawning. */
function resolveWorker(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (app.isPackaged) {
    // Packaged mode: use PyInstaller-compiled binary from extraResources
    const ext = process.platform === "win32" ? ".exe" : "";
    const workerExe = path.join(process.resourcesPath, "engine", `worker${ext}`);
    const env = { ...process.env };
    // Set ffmpeg paths from bundled binaries
    const ffmpegExt = process.platform === "win32" ? ".exe" : "";
    const ffmpegDir = path.join(process.resourcesPath, "ffmpeg");
    if (fs.existsSync(path.join(ffmpegDir, `ffmpeg${ffmpegExt}`))) {
      env.BLURITOUT_FFMPEG = path.join(ffmpegDir, `ffmpeg${ffmpegExt}`);
      env.BLURITOUT_FFPROBE = path.join(ffmpegDir, `ffprobe${ffmpegExt}`);
    }
    return { command: workerExe, args: [], env };
  }

  // Dev mode: use Python from venv
  const pythonPath = devPythonCommand();
  const workerScript = path.resolve(app.getAppPath(), "..", "engine", "worker.py");
  const env = devPythonEnv(pythonPath);
  return { command: pythonPath, args: [workerScript], env };
}

function devPythonCommand(): string {
  if (process.env.BLURITOUT_PYTHON) {
    return normalizeWindowsExecutablePath(process.env.BLURITOUT_PYTHON);
  }

  const repoRoot = path.resolve(app.getAppPath(), "..");
  const candidatePaths =
    process.platform === "win32"
      ? [
          path.join(repoRoot, "engine", ".venv", "Scripts", "python.exe"),
          path.join(repoRoot, ".venv", "Scripts", "python.exe"),
        ]
      : [
          path.join(repoRoot, "engine", ".venv", "bin", "python"),
          path.join(repoRoot, ".venv", "bin", "python"),
        ];

  return candidatePaths.find((candidate) => fs.existsSync(candidate)) || "python";
}

function devPythonEnv(pythonPath: string): NodeJS.ProcessEnv {
  const nextEnv = { ...process.env };
  delete nextEnv.PYTHONHOME;
  delete nextEnv.PYTHONPATH;
  delete nextEnv.__PYVENV_LAUNCHER__;

  const normalizedPython = normalizeWindowsExecutablePath(pythonPath);
  const scriptsDir = path.dirname(normalizedPython);
  const venvRoot = path.dirname(scriptsDir);
  nextEnv.VIRTUAL_ENV = venvRoot;
  nextEnv.PATH = `${scriptsDir}${path.delimiter}${process.env.PATH || ""}`;
  // Platform-aware site-packages path
  if (process.platform === "win32") {
    nextEnv.PYTHONPATH = path.join(venvRoot, "Lib", "site-packages");
  } else {
    // On Linux/macOS, detect the python version directory
    const libDir = path.join(venvRoot, "lib");
    if (fs.existsSync(libDir)) {
      const entries = fs.readdirSync(libDir).filter((e) => e.startsWith("python"));
      if (entries.length > 0) {
        nextEnv.PYTHONPATH = path.join(libDir, entries[0], "site-packages");
      }
    }
  }
  return nextEnv;
}

function persistState() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userStorePath(jobStoreName), JSON.stringify(Array.from(workerState.jobs.values()), null, 2), "utf8");
  fs.writeFileSync(userStorePath(analysisStoreName), JSON.stringify(Array.from(workerState.analyses.values()), null, 2), "utf8");
}

function restoreJobs() {
  const storePath = userStorePath(jobStoreName);
  if (!fs.existsSync(storePath)) {
    return;
  }
  const records = JSON.parse(fs.readFileSync(storePath, "utf8")) as JobRecord[];
  records.forEach((record) => workerState.jobs.set(record.id, record));
}

function restoreAnalyses() {
  const storePath = userStorePath(analysisStoreName);
  if (!fs.existsSync(storePath)) {
    return;
  }
  const records = JSON.parse(fs.readFileSync(storePath, "utf8")) as AnalysisRecord[];
  records.forEach((record) => {
    workerState.analyses.set(record.id, record);
    workerState.analysisByInput.set(record.inputPath, record.id);
  });
}

function sortedJobs() {
  return Array.from(workerState.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sortedAnalyses() {
  return Array.from(workerState.analyses.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function broadcastJobs() {
  const jobs = sortedJobs();
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("jobs:updated", jobs));
  persistState();
}

function broadcastAnalyses() {
  const analyses = sortedAnalyses();
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("analyses:updated", analyses));
  persistState();
}

function patchJob(jobId: string, patch: Partial<JobRecord>) {
  const current = workerState.jobs.get(jobId);
  if (!current) {
    return;
  }
  workerState.jobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  broadcastJobs();
}

function patchAnalysis(analysisId: string, patch: Partial<AnalysisRecord>) {
  const current = workerState.analyses.get(analysisId);
  if (!current) {
    return;
  }
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  workerState.analyses.set(analysisId, next);
  workerState.analysisByInput.set(next.inputPath, next.id);
  broadcastAnalyses();
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    backgroundColor: "#10151d",
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";
  if (!app.isPackaged) {
    void mainWindow.loadURL(devServerUrl);
    return;
  }

  void mainWindow.loadFile(path.join(app.getAppPath(), "dist-react", "index.html"));
}

function createJob(inputPath: string, settings: JobSettings): JobRecord {
  const stats = fs.statSync(inputPath);
  return {
    id: randomUUID(),
    inputPath,
    inputName: path.basename(inputPath),
    outputDir: settings.outputDir || path.dirname(inputPath),
    blurTarget: settings.blurTarget,
    device: settings.device,
    requestedDevice: settings.device,
    exportQuality: settings.exportQuality,
    audioMode: settings.audioMode,
    analysisPath: settings.analysisPath || null,
    selectionMode: settings.selectionMode,
    selectedTrackIds: settings.selectedTrackIds || [],
    status: "queued",
    progress: 0,
    frameProgress: null,
    fileSize: stats.size,
    outputPaths: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

function createAnalysisRecord(inputPath: string, settings: AnalysisSettings): AnalysisRecord {
  return {
    id: randomUUID(),
    inputPath,
    inputName: path.basename(inputPath),
    blurTarget: settings.blurTarget,
    device: settings.device,
    status: "queued",
    progress: 0,
    frameProgress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    tracks: [],
    previewTrackIds: [],
  };
}

function shouldIgnoreWorkerStderr(message: string) {
  return message.includes("FutureWarning") || message.includes("torch.load") || message.includes("weights_only=False");
}

function handleWorkerEvent(jobId: string, event: Record<string, unknown>) {
  const current = workerState.jobs.get(jobId);

  if (event.status === "processing") {
    const totalFrames = Number(event.total_frames || 0);
    const currentFrame = Number(event.current_frame || 0);
    const progress = totalFrames > 0 ? Math.min(99, Math.round((currentFrame / totalFrames) * 100)) : 0;
    patchJob(jobId, {
      status: "processing",
      progress,
      frameProgress: { currentFrame, totalFrames },
      requestedDevice: String(event.requested_device || current?.requestedDevice || current?.device || "") as DeviceMode,
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      workerPython: String(event.worker_python || current?.workerPython || ""),
      message: String(event.message || ""),
    });
    return;
  }

  if (event.status === "muxing") {
    patchJob(jobId, {
      status: "muxing",
      progress: 99,
      requestedDevice: String(event.requested_device || current?.requestedDevice || current?.device || "") as DeviceMode,
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      workerPython: String(event.worker_python || current?.workerPython || ""),
      message: String(event.message || ""),
    });
    return;
  }

  if (event.status === "completed") {
    patchJob(jobId, {
      status: "completed",
      progress: 100,
      outputPaths: Array.isArray(event.outputs) ? (event.outputs as string[]) : [],
      requestedDevice: String(event.requested_device || "") as DeviceMode,
      audioPreserved: Boolean(event.audio_preserved),
      sourceHasAudio: Boolean(event.source_has_audio),
      elapsedSeconds: Number(event.elapsed_seconds || 0),
      deviceUsed: String(event.device || ""),
      workerPython: String(event.worker_python || ""),
      error: null,
      message: null,
    });
    return;
  }

  if (event.status === "failed") {
    patchJob(jobId, {
      status: "failed",
      error: String(event.error || "Processing failed"),
      requestedDevice: String(event.requested_device || current?.requestedDevice || "") as DeviceMode,
      audioPreserved: Boolean(event.audio_preserved),
      sourceHasAudio: Boolean(event.source_has_audio),
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      workerPython: String(event.worker_python || current?.workerPython || ""),
    });
    return;
  }

  if (event.status === "queued" || event.status === "preparing") {
    patchJob(jobId, {
      status: event.status as JobStatus,
      requestedDevice: String(event.requested_device || current?.requestedDevice || "") as DeviceMode,
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      workerPython: String(event.worker_python || current?.workerPython || ""),
      message: String(event.message || ""),
    });
  }
}

function handleAnalysisEvent(analysisId: string, event: Record<string, unknown>) {
  const current = workerState.analyses.get(analysisId);
  if (!current) {
    return;
  }

  if (event.status === "analyzing") {
    const totalFrames = Number(event.total_frames || 0);
    const currentFrame = Number(event.current_frame || 0);
    const progress = totalFrames > 0 ? Math.min(99, Math.round((currentFrame / totalFrames) * 100)) : 0;
    patchAnalysis(analysisId, {
      status: "analyzing",
      progress,
      frameProgress: { currentFrame, totalFrames },
      requestedDevice: String(event.requested_device || current.requestedDevice || current.device) as DeviceMode,
      deviceUsed: String(event.device || current.deviceUsed || ""),
      workerPython: String(event.worker_python || current.workerPython || ""),
      message: String(event.message || "Detecting and tracking objects"),
    });
    return;
  }

  if (event.status === "completed") {
    patchAnalysis(analysisId, {
      status: "completed",
      progress: 100,
      requestedDevice: String(event.requested_device || current.requestedDevice || current.device) as DeviceMode,
      deviceUsed: String(event.device || current.deviceUsed || ""),
      workerPython: String(event.worker_python || current.workerPython || ""),
      analysisPath: String(event.analysis_path || ""),
      previewPath: String(event.preview_path || ""),
      tracks: Array.isArray(event.tracks) ? (event.tracks as TrackSummary[]) : [],
      previewTrackIds: Array.isArray(event.preview_tracks) ? (event.preview_tracks as number[]) : [],
      error: null,
      message: null,
    });
    return;
  }

  if (event.status === "failed") {
    patchAnalysis(analysisId, {
      status: "failed",
      error: String(event.error || "Analysis failed"),
      requestedDevice: String(event.requested_device || current.requestedDevice || current.device) as DeviceMode,
      deviceUsed: String(event.device || current.deviceUsed || ""),
      workerPython: String(event.worker_python || current.workerPython || ""),
    });
    return;
  }

  if (event.status === "queued" || event.status === "preparing") {
    patchAnalysis(analysisId, {
      requestedDevice: String(event.requested_device || current.requestedDevice || current.device) as DeviceMode,
      deviceUsed: String(event.device || current.deviceUsed || ""),
      workerPython: String(event.worker_python || current.workerPython || ""),
      message: String(event.message || current.message || ""),
    });
  }
}

function analysisArtifactsPath(analysisId: string, inputPath: string) {
  const baseDir = path.join(app.getPath("userData"), "analysis-cache");
  fs.mkdirSync(baseDir, { recursive: true });
  const sanitizedBase = path.basename(inputPath, path.extname(inputPath));
  return {
    analysisPath: path.join(baseDir, `${sanitizedBase}-${analysisId}.json`),
    previewPath: path.join(baseDir, `${sanitizedBase}-${analysisId}.jpg`),
  };
}

function scheduleNextJob() {
  if (workerState.runningJobId || workerState.queue.length === 0) {
    return;
  }

  const jobId = workerState.queue.shift();
  if (!jobId) {
    return;
  }

  const job = workerState.jobs.get(jobId);
  if (!job || job.status !== "queued") {
    scheduleNextJob();
    return;
  }

  workerState.runningJobId = jobId;
  patchJob(jobId, { status: "preparing", progress: 0, error: null });

  const configPath = path.join(app.getPath("userData"), `${jobId}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        job_id: jobId,
        input_paths: [job.inputPath],
        output_dir: job.outputDir,
        blur_target: job.blurTarget,
        device: job.device,
        detection_interval: 3,
        export_quality: job.exportQuality,
        audio_mode: job.audioMode,
        overwrite: true,
        analysis_path: job.analysisPath || undefined,
        selection_mode: job.selectionMode || "blur_selected",
        selected_track_ids: job.selectedTrackIds || [],
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(pythonCommand(), [workerScriptPath(), "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: pythonChildEnv(pythonCommand()),
  });
  workerState.processes.set(jobId, child);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    chunk
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        try {
          handleWorkerEvent(jobId, JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          patchJob(jobId, { error: `Invalid worker output: ${String(error)}` });
        }
      });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (!message || shouldIgnoreWorkerStderr(message)) {
      return;
    }
    patchJob(jobId, { error: message || "Worker error" });
  });

  child.on("exit", (code) => {
    workerState.processes.delete(jobId);
    workerState.runningJobId = null;
    const current = workerState.jobs.get(jobId);
    if (current && !["completed", "failed", "canceled"].includes(current.status) && code !== 0) {
      patchJob(jobId, { status: "failed", error: current.error || `Worker exited with code ${code}` });
    }
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    scheduleNextJob();
  });
}

function runAnalysis(payload: AnalysisStartPayload) {
  const existingId = workerState.analysisByInput.get(payload.inputPath);
  if (existingId) {
    const existing = workerState.analyses.get(existingId);
    if (existing && (existing.status === "queued" || existing.status === "analyzing")) {
      return existing;
    }
  }

  const analysis = createAnalysisRecord(payload.inputPath, payload.settings);
  workerState.analyses.set(analysis.id, analysis);
  workerState.analysisByInput.set(analysis.inputPath, analysis.id);
  broadcastAnalyses();

  const artifacts = analysisArtifactsPath(analysis.id, analysis.inputPath);
  const configPath = path.join(app.getPath("userData"), `${analysis.id}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        job_id: analysis.id,
        input_paths: [analysis.inputPath],
        blur_target: analysis.blurTarget,
        device: analysis.device,
        overwrite: true,
        mode: "analyze",
        analysis_output: artifacts.analysisPath,
        preview_output: artifacts.previewPath,
      },
      null,
      2,
    ),
    "utf8",
  );

  patchAnalysis(analysis.id, { status: "analyzing", progress: 0, error: null });
  const child = spawn(pythonCommand(), [workerScriptPath(), "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: pythonChildEnv(pythonCommand()),
  });
  workerState.processes.set(analysis.id, child);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    chunk
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        try {
          handleAnalysisEvent(analysis.id, JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          patchAnalysis(analysis.id, { status: "failed", error: `Invalid worker output: ${String(error)}` });
        }
      });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (!message || shouldIgnoreWorkerStderr(message)) {
      return;
    }
    patchAnalysis(analysis.id, { status: "failed", error: message || "Worker error" });
  });

  child.on("exit", (code) => {
    workerState.processes.delete(analysis.id);
    const current = workerState.analyses.get(analysis.id);
    if (current && !["completed", "failed", "canceled"].includes(current.status) && code !== 0) {
      patchAnalysis(analysis.id, { status: "failed", error: current.error || `Worker exited with code ${code}` });
    }
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  return analysis;
}

app.whenReady().then(() => {
  restoreJobs();
  restoreAnalyses();
  createWindow();
  broadcastJobs();
  broadcastAnalyses();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:pick-files", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:pick-output", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("jobs:list", async () => sortedJobs());
ipcMain.handle("analyses:list", async () => sortedAnalyses());

ipcMain.handle("analyses:start", async (_, payload: AnalysisStartPayload) => runAnalysis(payload));

ipcMain.handle("jobs:create", async (_, payload: { inputPaths: string[]; settings: JobSettings }) => {
  const created = payload.inputPaths.map((inputPath) => {
    const job = createJob(inputPath, payload.settings);
    workerState.jobs.set(job.id, job);
    workerState.queue.push(job.id);
    return job;
  });
  broadcastJobs();
  scheduleNextJob();
  return created;
});

ipcMain.handle("jobs:cancel", async (_, jobId: string) => {
  if (workerState.runningJobId === jobId) {
    const child = workerState.processes.get(jobId);
    if (child) {
      child.kill();
    }
    patchJob(jobId, { status: "canceled", error: null });
    return true;
  }

  workerState.queue = workerState.queue.filter((item) => item !== jobId);
  patchJob(jobId, { status: "canceled", error: null });
  return true;
});

ipcMain.handle("analyses:cancel", async (_, analysisId: string) => {
  const child = workerState.processes.get(analysisId);
  if (child) {
    child.kill();
  }
  patchAnalysis(analysisId, { status: "canceled", error: null });
  return true;
});

ipcMain.handle("jobs:open-output", async (_, outputPath: string) => shell.showItemInFolder(outputPath));
ipcMain.handle("jobs:open-folder", async (_, outputPath: string) => shell.openPath(path.dirname(outputPath)));
