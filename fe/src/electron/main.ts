import { spawn, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const _require = createRequire(import.meta.url);

// ─── Logging ────────────────────────────────────────────────────────────────
// electron-log writes to %APPDATA%/BlurItOut/logs/main.log automatically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log: any = _require("electron-log");
log.initialize();
log.transports.file.level = "info";
log.transports.console.level = "warn"; // keep dev console quiet; full output goes to file

// Resolve bundled ffmpeg/ffprobe paths for dev mode via ffmpeg-static / ffprobe-static.
// These packages ship platform-specific binaries inside node_modules.
function devFfmpegPaths(): { ffmpeg: string | null; ffprobe: string | null } {
  try {
    const ffmpeg: string = _require("ffmpeg-static");
    const ffprobeModule: { path: string } = _require("ffprobe-static");
    const ffprobe = ffprobeModule?.path ?? null;
    return {
      ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : null,
      ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null,
    };
  } catch {
    return { ffmpeg: null, ffprobe: null };
  }
}
import type { JobStatus, DeviceMode, JobRecord, TrackSummary, AnalysisRecord, JobSettings, AnalysisSettings, AnalysisStartPayload, ModelPolicy } from "../shared/types.js";

const jobStoreName = "bluritout-jobs.json";
const analysisStoreName = "bluritout-analyses.json";
const workerLogRetentionDays = 14;
const maxWorkerLogFiles = 50;
const maxWorkerLogBytes = 25 * 1024 * 1024;
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const workerState = {
  queue: [] as string[],
  runningJobId: null as string | null,
  runningAnalysisId: null as string | null,
  analysisRerunPending: false,
  jobs: new Map<string, JobRecord>(),
  analyses: new Map<string, AnalysisRecord>(),
  analysisByInput: new Map<string, string>(),
  processes: new Map<string, ReturnType<typeof spawn>>(),
};

function userStorePath(fileName: string) {
  return path.join(app.getPath("userData"), fileName);
}

function workerCachePath(dirName: string) {
  const cacheDir = path.join(app.getPath("userData"), dirName);
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function normalizeWindowsExecutablePath(rawPath: string) {
  if (/^\/[a-zA-Z]\//.test(rawPath)) {
    return `${rawPath[1]}:${rawPath.slice(2)}`;
  }
  return rawPath;
}

/** Resolve the worker executable / script path + command for spawning. */
function resolveWorker(overrides?: { modelPolicy?: ModelPolicy }): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (app.isPackaged) {
    // Packaged mode: use PyInstaller-compiled binary from extraResources
    const ext = process.platform === "win32" ? ".exe" : "";
    const workerExe = path.join(process.resourcesPath, "engine", `worker${ext}`);
    const env = { ...process.env };
    env.BLURITOUT_PADDLE_CACHE = workerCachePath("paddlex-cache");
    env.BLURITOUT_TORCH_CACHE = workerCachePath("torch-cache");
    env.BLURITOUT_INSIGHTFACE_HOME = workerCachePath("insightface-cache");
    // Set ffmpeg paths from bundled binaries
    const ffmpegExt = process.platform === "win32" ? ".exe" : "";
    const ffmpegDir = path.join(process.resourcesPath, "ffmpeg");
    if (fs.existsSync(path.join(ffmpegDir, `ffmpeg${ffmpegExt}`))) {
      env.BLURITOUT_FFMPEG = path.join(ffmpegDir, `ffmpeg${ffmpegExt}`);
      env.BLURITOUT_FFPROBE = path.join(ffmpegDir, `ffprobe${ffmpegExt}`);
    }
    if (overrides?.modelPolicy) {
      env.BLURITOUT_MODEL_POLICY = overrides.modelPolicy;
    }
    return { command: workerExe, args: [], env };
  }

  // Dev mode: use Python from venv
  const pythonPath = devPythonCommand();
  const workerScript = path.resolve(app.getAppPath(), "..", "engine", "worker.py");
  const env = devPythonEnv(pythonPath);
  env.BLURITOUT_PADDLE_CACHE = workerCachePath("paddlex-cache");
  env.BLURITOUT_TORCH_CACHE = workerCachePath("torch-cache");
  env.BLURITOUT_INSIGHTFACE_HOME = workerCachePath("insightface-cache");
  // Set ffmpeg/ffprobe from bundled npm packages so the worker doesn't depend on PATH
  const ffmpegPaths = devFfmpegPaths();
  if (ffmpegPaths.ffmpeg) env.BLURITOUT_FFMPEG = ffmpegPaths.ffmpeg;
  if (ffmpegPaths.ffprobe) env.BLURITOUT_FFPROBE = ffmpegPaths.ffprobe;
  if (overrides?.modelPolicy) {
    env.BLURITOUT_MODEL_POLICY = overrides.modelPolicy;
  }
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
  if (!path.isAbsolute(normalizedPython) || !fs.existsSync(normalizedPython)) {
    return nextEnv;
  }

  const scriptsDir = path.dirname(normalizedPython);
  const venvRoot = path.dirname(scriptsDir);
  if (!fs.existsSync(path.join(venvRoot, "pyvenv.cfg"))) {
    return nextEnv;
  }

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

type RuntimeProbe = {
  pythonPath: string | null;
  usingManagedPython: boolean;
  cudaAvailable: boolean | null;
  torchVersion: string | null;
  cudaVersion: string | null;
  cudaDeviceName: string | null;
  warnings: string[];
  errors: string[];
};

type ModelStackProbe = {
  modelPolicy: ModelPolicy | null;
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

function probeWorkerRuntime(): RuntimeProbe {
  if (app.isPackaged) {
    return {
      pythonPath: null,
      usingManagedPython: false,
      cudaAvailable: null,
      torchVersion: null,
      cudaVersion: null,
      cudaDeviceName: null,
      warnings: ["CUDA probe is unavailable for the packaged worker binary in this health check."],
      errors: [],
    };
  }

  const pythonPath = devPythonCommand();
  const env = devPythonEnv(pythonPath);
  const usingManagedPython = Boolean(env.VIRTUAL_ENV);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!path.isAbsolute(pythonPath)) {
    warnings.push("Using system Python from PATH instead of repo venv. CUDA depends on that interpreter.");
  }

  const probeScript = [
    "import json",
    "info = {'cudaAvailable': False, 'torchVersion': None, 'cudaVersion': None, 'cudaDeviceName': None}",
    "try:",
    "    import torch",
    "    info['torchVersion'] = getattr(torch, '__version__', None)",
    "    info['cudaVersion'] = getattr(torch.version, 'cuda', None)",
    "    info['cudaAvailable'] = bool(torch.cuda.is_available())",
    "    if info['cudaAvailable']:",
    "        try:",
    "            info['cudaDeviceName'] = torch.cuda.get_device_name(0)",
    "        except Exception as exc:",
    "            info['cudaDeviceName'] = f'CUDA device query failed: {exc}'",
    "except Exception as exc:",
    "    info['probeError'] = str(exc)",
    "print(json.dumps(info))",
  ].join("\n");

  const result = spawnSync(pythonPath, ["-c", probeScript], {
    env,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });

  if (result.error) {
    errors.push(`Failed to probe worker runtime: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    errors.push(`Worker runtime probe exited with code ${String(result.status)}${details ? `: ${details}` : ""}`);
  }

  let cudaAvailable: boolean | null = null;
  let torchVersion: string | null = null;
  let cudaVersion: string | null = null;
  let cudaDeviceName: string | null = null;

  if (result.status === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as {
        cudaAvailable?: boolean;
        torchVersion?: string | null;
        cudaVersion?: string | null;
        cudaDeviceName?: string | null;
        probeError?: string;
      };
      cudaAvailable = typeof parsed.cudaAvailable === "boolean" ? parsed.cudaAvailable : null;
      torchVersion = parsed.torchVersion ?? null;
      cudaVersion = parsed.cudaVersion ?? null;
      cudaDeviceName = parsed.cudaDeviceName ?? null;
      if (parsed.probeError) {
        errors.push(`Worker runtime probe could not import torch: ${parsed.probeError}`);
      }
    } catch (error) {
      errors.push(`Worker runtime probe returned invalid JSON: ${String(error)}`);
    }
  }

  if (cudaAvailable === false) {
    warnings.push("CUDA is not available in the active worker runtime. GPU requests will fall back to CPU.");
  }

  return {
    pythonPath: path.isAbsolute(pythonPath) ? pythonPath : null,
    usingManagedPython,
    cudaAvailable,
    torchVersion,
    cudaVersion,
    cudaDeviceName,
    warnings,
    errors,
  };
}

function probeWorkerModelStack(modelPolicy?: ModelPolicy): ModelStackProbe {
  const resolved = resolveWorker({ modelPolicy });
  const warnings: string[] = [];
  const errors: string[] = [];
  const result = spawnSync(resolved.command, [...resolved.args, "--describe-stack"], {
    env: resolved.env,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });

  if (result.error) {
    errors.push(`Failed to probe CV model stack: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    errors.push(`CV model stack probe exited with code ${String(result.status)}${details ? `: ${details}` : ""}`);
  }

  let faceProvider: string | null = null;
  let resolvedModelPolicy: ModelPolicy | null = null;
  let configuredFaceProvider: string | null = null;
  let faceModel: string | null = null;
  let faceFallbackChain: string[] = [];
  let configuredPlateProvider: string | null = null;
  let plateProvider: string | null = null;
  let plateModelPath: string | null = null;
  let plateModelExists: boolean | null = null;

  if (result.status === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as {
        modelPolicy?: ModelPolicy | null;
        configuredFaceProvider?: string | null;
        faceProvider?: string | null;
        faceModel?: string | null;
        faceFallbackChain?: string[];
        configuredPlateProvider?: string | null;
        plateProvider?: string | null;
        plateModelPath?: string | null;
        plateModelExists?: boolean;
        commercialWarnings?: string[];
      };
      resolvedModelPolicy = parsed.modelPolicy ?? null;
      configuredFaceProvider = parsed.configuredFaceProvider ?? null;
      faceProvider = parsed.faceProvider ?? null;
      faceModel = parsed.faceModel ?? null;
      faceFallbackChain = Array.isArray(parsed.faceFallbackChain) ? parsed.faceFallbackChain : [];
      configuredPlateProvider = parsed.configuredPlateProvider ?? null;
      plateProvider = parsed.plateProvider ?? null;
      plateModelPath = parsed.plateModelPath ?? null;
      plateModelExists = typeof parsed.plateModelExists === "boolean" ? parsed.plateModelExists : null;
      warnings.push(...(parsed.commercialWarnings ?? []));
    } catch (error) {
      errors.push(`CV model stack probe returned invalid JSON: ${String(error)}`);
    }
  }

  if (plateProvider !== "disabled" && plateModelExists === false) {
    errors.push("Configured plate model file was not found for the active worker stack.");
  }

  return {
    modelPolicy: resolvedModelPolicy,
    configuredFaceProvider,
    faceProvider,
    faceModel,
    faceFallbackChain,
    configuredPlateProvider,
    plateProvider,
    plateModelPath,
    plateModelExists,
    warnings,
    errors,
  };
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
  records.forEach((record) => {
    record.modelPolicy = record.modelPolicy || "standard";
    // Reset jobs that were interrupted mid-run (app was killed)
    if (["processing", "preparing", "muxing"].includes(record.status)) {
      record.status = "failed";
      record.error = "Interrupted by app restart";
    }
    workerState.jobs.set(record.id, record);
  });
}

function restoreAnalyses() {
  const storePath = userStorePath(analysisStoreName);
  if (!fs.existsSync(storePath)) {
    return;
  }
  const records = JSON.parse(fs.readFileSync(storePath, "utf8")) as AnalysisRecord[];
  records.forEach((record) => {
    record.modelPolicy = record.modelPolicy || "standard";
    // Reset analyses that were interrupted mid-run
    if (record.status === "analyzing" || record.status === "queued") {
      record.status = "failed";
      record.error = "Interrupted by app restart";
    }
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
  let stats: fs.Stats;
  try {
    stats = fs.statSync(inputPath);
  } catch {
    throw new Error(`File not accessible: ${path.basename(inputPath)}`);
  }
  return {
    id: randomUUID(),
    inputPath,
    inputName: path.basename(inputPath),
    outputDir: settings.outputDir || path.dirname(inputPath),
    blurTarget: settings.blurTarget,
    device: settings.device,
    modelPolicy: settings.modelPolicy,
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
    modelPolicy: settings.modelPolicy,
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

function requiresPlateDetection(blurTarget: string): boolean {
  return blurTarget === "plates" || blurTarget === "both";
}

function getModelPolicyBlockReason(settings: { blurTarget: string; modelPolicy?: ModelPolicy }): string | null {
  if (!requiresPlateDetection(settings.blurTarget)) {
    return null;
  }
  const modelStack = probeWorkerModelStack(settings.modelPolicy);
  if (modelStack.plateProvider !== "disabled") {
    return null;
  }
  if (modelStack.modelPolicy === "commercial_safe" || settings.modelPolicy === "commercial_safe") {
    return "Plate detection is disabled under commercial-safe policy. Switch blur target to faces only, switch model policy to Standard, or provide BLURITOUT_PLATE_MODEL_PATH with a compatible plate model.";
  }
  return "Plate detection is disabled in the active worker stack.";
}

function createBlockedAnalysis(payload: AnalysisStartPayload, reason: string): AnalysisRecord {
  const analysis = {
    ...createAnalysisRecord(payload.inputPath, payload.settings),
    status: "failed" as const,
    error: reason,
  };
  workerState.analyses.set(analysis.id, analysis);
  workerState.analysisByInput.set(analysis.inputPath, analysis.id);
  broadcastAnalyses();
  return analysis;
}

/** Kill a worker process reliably. On Windows SIGTERM is unreliable for Python. */
function killWorkerProcess(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && child.pid) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    child.kill("SIGTERM");
  }
}

function waitForWorkerExit(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", done);
    setTimeout(done, timeoutMs);
  });
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
  const thumbsDir = path.join(baseDir, `${sanitizedBase}-${analysisId}-thumbs`);
  return {
    analysisPath: path.join(baseDir, `${sanitizedBase}-${analysisId}.json`),
    previewPath: path.join(baseDir, `${sanitizedBase}-${analysisId}.jpg`),
    thumbsDir,
  };
}

function scheduleNextJob() {
  // Don't start a job while analysis or another job is running (prevents GPU OOM)
  if (workerState.runningJobId || workerState.runningAnalysisId || workerState.analysisRerunPending || workerState.queue.length === 0) {
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

  // ── Disk space preflight ──────────────────────────────────────────────────
  // Intermediate AVI (uncompressed) can be up to ~3× the source file size.
  const requiredBytes = (job.fileSize || 0) * 3;
  if (requiredBytes > 0) {
    const checkDir = job.outputDir || path.dirname(job.inputPath);
    try {
      const { bavail, bsize } = fs.statfsSync(checkDir);
      const freeBytes = Number(bavail) * Number(bsize);
      if (freeBytes < requiredBytes) {
        const fmt = (n: number) => `${(n / 1_073_741_824).toFixed(1)} GB`;
        const msg = `Not enough disk space — need ~${fmt(requiredBytes)}, only ${fmt(freeBytes)} free in output folder`;
        log.warn(`[job:${jobId}] ${msg}`);
        patchJob(jobId, { status: "failed", error: msg });
        workerState.runningJobId = null;
        scheduleNextJob();
        return;
      }
    } catch {
      // statfs not supported on this path (e.g. network drive) — skip check
    }
  }

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
        model_policy: job.modelPolicy,
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

  const worker = resolveWorker({ modelPolicy: job.modelPolicy });
  log.info(`[job:${jobId}] spawning worker — input: ${job.inputPath}`);
  const child = spawn(worker.command, [...worker.args, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: worker.env,
  });
  workerState.processes.set(jobId, child);

  // Write worker stderr to a per-job log file for post-mortem diagnostics
  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const workerLogPath = path.join(logsDir, `worker-job-${jobId}.log`);
  const workerLogStream = fs.createWriteStream(workerLogPath, { flags: "a" });
  const stderrBuffer: string[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    chunk
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.status === "processing" && !workerState.jobs.get(jobId)?.startedAt) {
            patchJob(jobId, { startedAt: new Date().toISOString() });
          }
          handleWorkerEvent(jobId, event);
        } catch (error) {
          log.warn(`[job:${jobId}] invalid worker output: ${String(error)}`);
          patchJob(jobId, { error: `Invalid worker output: ${String(error)}` });
        }
      });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (message) {
      workerLogStream.write(`[stderr] ${message}\n`);
      stderrBuffer.push(message);
      if (stderrBuffer.length > 50) stderrBuffer.shift();
    }
  });

  child.on("exit", (code) => {
    workerLogStream.end();
    workerState.processes.delete(jobId);
    if (workerState.runningJobId === jobId) {
      workerState.runningJobId = null;
    }
    log.info(`[job:${jobId}] worker exited with code ${code}`);
    const current = workerState.jobs.get(jobId);
    if (current && !["completed", "failed", "canceled"].includes(current.status)) {
      if (code !== 0) {
        const stderrSummary = stderrBuffer.slice(-5).join("\n");
        log.error(`[job:${jobId}] failed — ${stderrSummary || `exit code ${code}`}`);
        patchJob(jobId, { status: "failed", error: current.error || stderrSummary || `Worker exited with code ${code}` });
      } else {
        patchJob(jobId, { status: "completed", progress: 100 });
      }
    }
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    scheduleNextJob();
  });
}

function runAnalysis(payload: AnalysisStartPayload) {
  const blockReason = getModelPolicyBlockReason(payload.settings);
  if (blockReason) {
    return createBlockedAnalysis(payload, blockReason);
  }

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
        model_policy: analysis.modelPolicy,
        // Analysis quality matters more than throughput because track selection
        // depends on stable detections and previews for every object.
        detection_interval: 1,
        overwrite: true,
        mode: "analyze",
        analysis_output: artifacts.analysisPath,
        preview_output: artifacts.previewPath,
        thumbnails_dir: artifacts.thumbsDir,
      },
      null,
      2,
    ),
    "utf8",
  );

  patchAnalysis(analysis.id, { status: "analyzing", progress: 0, error: null });
  workerState.runningAnalysisId = analysis.id;

  const worker = resolveWorker({ modelPolicy: analysis.modelPolicy });
  log.info(`[analysis:${analysis.id}] spawning worker — input: ${analysis.inputPath}`);
  const child = spawn(worker.command, [...worker.args, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: worker.env,
  });
  workerState.processes.set(analysis.id, child);

  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const workerLogPath = path.join(logsDir, `worker-analysis-${analysis.id}.log`);
  const workerLogStream = fs.createWriteStream(workerLogPath, { flags: "a" });
  const stderrBuffer: string[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    chunk
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        try {
          handleAnalysisEvent(analysis.id, JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          log.warn(`[analysis:${analysis.id}] invalid worker output: ${String(error)}`);
          patchAnalysis(analysis.id, { status: "failed", error: `Invalid worker output: ${String(error)}` });
        }
      });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (message) {
      workerLogStream.write(`[stderr] ${message}\n`);
      stderrBuffer.push(message);
      if (stderrBuffer.length > 50) stderrBuffer.shift();
    }
  });

  child.on("exit", (code) => {
    workerLogStream.end();
    workerState.processes.delete(analysis.id);
    if (workerState.runningAnalysisId === analysis.id) {
      workerState.runningAnalysisId = null;
    }
    log.info(`[analysis:${analysis.id}] worker exited with code ${code}`);
    const current = workerState.analyses.get(analysis.id);
    if (current && !["completed", "failed", "canceled"].includes(current.status)) {
      if (code !== 0) {
        const stderrSummary = stderrBuffer.slice(-5).join("\n");
        log.error(`[analysis:${analysis.id}] failed — ${stderrSummary || `exit code ${code}`}`);
        patchAnalysis(analysis.id, { status: "failed", error: current.error || stderrSummary || `Worker exited with code ${code}` });
      } else {
        patchAnalysis(analysis.id, { status: "completed", progress: 100 });
      }
    }
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    scheduleNextJob();
  });

  return analysis;
}

/** Prune orphaned analysis cache files/dirs that no longer have a matching analysis record. */
function pruneAnalysisCache() {
  const cacheDir = path.join(app.getPath("userData"), "analysis-cache");
  if (!fs.existsSync(cacheDir)) return;
  const knownIds = new Set(Array.from(workerState.analyses.keys()));
  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      const match = entry.match(/-([0-9a-f-]{36})(-thumbs|\.(json|jpg))$/i);
      if (match && !knownIds.has(match[1])) {
        const fullPath = path.join(cacheDir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch {
    // Non-fatal
  }
}

function pruneWorkerLogs() {
  const logsDir = path.join(app.getPath("userData"), "logs");
  if (!fs.existsSync(logsDir)) return;

  try {
    const cutoffMs = Date.now() - workerLogRetentionDays * 24 * 60 * 60 * 1000;
    const entries = fs
      .readdirSync(logsDir)
      .filter((entry) => /^worker-(job|analysis)-.+\.log$/i.test(entry))
      .map((entry) => {
        const fullPath = path.join(logsDir, entry);
        return { fullPath, stat: fs.statSync(fullPath) };
      })
      .filter((entry) => entry.stat.isFile());

    for (const entry of entries) {
      if (entry.stat.mtimeMs < cutoffMs || entry.stat.size > maxWorkerLogBytes) {
        fs.unlinkSync(entry.fullPath);
      }
    }

    const remaining = entries
      .filter((entry) => fs.existsSync(entry.fullPath))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    for (const entry of remaining.slice(maxWorkerLogFiles)) {
      fs.unlinkSync(entry.fullPath);
    }
  } catch (error) {
    log.warn(`Worker log cleanup skipped: ${String(error)}`);
  }
}

app.whenReady().then(() => {
  log.info(`BlurItOut ${app.getVersion()} starting — userData: ${app.getPath("userData")}`);
  restoreJobs();
  restoreAnalyses();
  pruneAnalysisCache();
  pruneWorkerLogs();
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
  const blockReason = getModelPolicyBlockReason(payload.settings);
  const created = payload.inputPaths.map((inputPath) => {
    const job = createJob(inputPath, payload.settings);
    if (blockReason) {
      job.status = "failed";
      job.error = blockReason;
      job.updatedAt = new Date().toISOString();
    } else {
      workerState.queue.push(job.id);
    }
    workerState.jobs.set(job.id, job);
    return job;
  });
  broadcastJobs();
  if (!blockReason) {
    scheduleNextJob();
  }
  return created;
});

ipcMain.handle("jobs:cancel", async (_, jobId: string) => {
  if (workerState.runningJobId === jobId) {
    const child = workerState.processes.get(jobId);
    if (child) {
      killWorkerProcess(child);
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
    killWorkerProcess(child);
  }
  patchAnalysis(analysisId, { status: "canceled", error: null });
  return true;
});

// Validate that a path belongs to a known job output before opening it (security)
function isKnownOutputPath(outputPath: string): boolean {
  const requestedPath = normalizePathForComparison(outputPath);
  for (const job of workerState.jobs.values()) {
    if (job.outputPaths.some((knownPath) => normalizePathForComparison(knownPath) === requestedPath)) return true;
  }
  return false;
}

function normalizePathForComparison(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isKnownAnalysisPreviewPath(previewPath: string): boolean {
  const requestedPath = normalizePathForComparison(previewPath);
  for (const analysis of workerState.analyses.values()) {
    const knownPaths = [
      analysis.previewPath,
      ...analysis.tracks.flatMap((track) => [track.preview_path, track.ocr_preview_path]),
    ].filter((knownPath): knownPath is string => Boolean(knownPath));
    if (knownPaths.some((knownPath) => normalizePathForComparison(knownPath) === requestedPath)) {
      return true;
    }
  }
  return false;
}

ipcMain.handle("jobs:open-output", async (_, outputPath: string) => {
  if (!isKnownOutputPath(outputPath)) return;
  shell.showItemInFolder(outputPath);
});

ipcMain.handle("jobs:open-folder", async (_, outputPath: string) => {
  if (!isKnownOutputPath(outputPath)) return;
  shell.openPath(path.dirname(outputPath));
});

ipcMain.handle("jobs:clear-completed", async () => {
  const completedStatuses = new Set(["completed", "failed", "canceled"]);
  for (const [id, job] of workerState.jobs) {
    if (completedStatuses.has(job.status)) {
      workerState.jobs.delete(id);
    }
  }
  broadcastJobs();
});

ipcMain.handle("jobs:remove", async (_, jobId: string) => {
  workerState.jobs.delete(jobId);
  broadcastJobs();
});

ipcMain.handle("app:version", async () => app.getVersion());

ipcMain.handle("app:health-check", async (_, payload?: { modelPolicy?: ModelPolicy }) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const runtimeProbe = probeWorkerRuntime();
  const modelStackProbe = probeWorkerModelStack(payload?.modelPolicy);

  // Check worker executable
  let workerAvailable = false;
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const workerExe = path.join(process.resourcesPath, "engine", `worker${ext}`);
    workerAvailable = fs.existsSync(workerExe);
    if (!workerAvailable) errors.push(`Worker not found at ${workerExe}`);
  } else {
    // Dev mode: check if Python is resolvable and probe its torch/CUDA runtime.
    const python = devPythonCommand();
    workerAvailable = path.isAbsolute(python) ? fs.existsSync(python) : true;
    if (!workerAvailable) errors.push("Python worker not found");
  }

  // Check ffmpeg / ffprobe
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const ffmpegPath = path.join(process.resourcesPath, "ffmpeg", `ffmpeg${ext}`);
    const ffprobePath = path.join(process.resourcesPath, "ffmpeg", `ffprobe${ext}`);
    ffmpegAvailable = fs.existsSync(ffmpegPath);
    ffprobeAvailable = fs.existsSync(ffprobePath);
    if (!ffmpegAvailable) errors.push("ffmpeg binary not found in resources");
    if (!ffprobeAvailable) errors.push("ffprobe binary not found in resources");
  } else {
    // Dev mode: ffmpeg comes from ffmpeg-static / ffprobe-static npm packages
    const ffmpegPaths = devFfmpegPaths();
    ffmpegAvailable = ffmpegPaths.ffmpeg !== null;
    ffprobeAvailable = ffmpegPaths.ffprobe !== null;
    if (!ffmpegAvailable) errors.push("ffmpeg-static binary not found — run: npm install");
    if (!ffprobeAvailable) errors.push("ffprobe-static binary not found — run: npm install");
  }

  warnings.push(...runtimeProbe.warnings);
  warnings.push(...modelStackProbe.warnings);
  errors.push(...runtimeProbe.errors);
  errors.push(...modelStackProbe.errors);

  return {
    workerAvailable,
    ffmpegAvailable,
    ffprobeAvailable,
    pythonPath: runtimeProbe.pythonPath,
    usingManagedPython: runtimeProbe.usingManagedPython,
    cudaAvailable: runtimeProbe.cudaAvailable,
    torchVersion: runtimeProbe.torchVersion,
    cudaVersion: runtimeProbe.cudaVersion,
    cudaDeviceName: runtimeProbe.cudaDeviceName,
    modelPolicy: modelStackProbe.modelPolicy,
    configuredFaceProvider: modelStackProbe.configuredFaceProvider,
    faceProvider: modelStackProbe.faceProvider,
    faceModel: modelStackProbe.faceModel,
    faceFallbackChain: modelStackProbe.faceFallbackChain,
    configuredPlateProvider: modelStackProbe.configuredPlateProvider,
    plateProvider: modelStackProbe.plateProvider,
    plateModelPath: modelStackProbe.plateModelPath,
    plateModelExists: modelStackProbe.plateModelExists,
    warnings,
    errors,
  };
});

// Return a preview image as a base64 data URL so the renderer doesn't need
// direct file:// access (blocked by Electron's security policy).
ipcMain.handle("analyses:get-preview", async (_, previewPath: string) => {
  if (!previewPath || !isKnownAnalysisPreviewPath(previewPath)) return null;
  if (!previewPath || !fs.existsSync(previewPath)) return null;
  try {
    const data = fs.readFileSync(previewPath);
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
});

// Force a fresh analysis even when a completed one already exists for this input.
ipcMain.handle("analyses:rerun", async (_, payload: AnalysisStartPayload) => {
  workerState.analysisRerunPending = true;
  try {
    const runningId = workerState.runningAnalysisId;
    if (runningId) {
      const child = workerState.processes.get(runningId);
      patchAnalysis(runningId, { status: "canceled", error: null });
      if (child) {
        killWorkerProcess(child);
        await waitForWorkerExit(child);
      }
      workerState.processes.delete(runningId);
      if (workerState.runningAnalysisId === runningId) {
        workerState.runningAnalysisId = null;
      }
    }

    // Remove existing analysis entry so runAnalysis doesn't short-circuit
    const existingId = workerState.analysisByInput.get(payload.inputPath);
    if (existingId) {
      workerState.analysisByInput.delete(payload.inputPath);
      // Keep the old record in the map - it gets replaced when the new one broadcasts
    }
    return runAnalysis(payload);
  } finally {
    workerState.analysisRerunPending = false;
    if (!workerState.runningAnalysisId) {
      scheduleNextJob();
    }
  }
});
