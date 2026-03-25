import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

type JobStatus = "queued" | "preparing" | "processing" | "muxing" | "completed" | "failed" | "canceled";

type JobRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  outputDir: string;
  blurTarget: "faces" | "plates" | "both";
  device: "auto" | "cuda" | "cpu";
  exportQuality: "near_source" | "balanced";
  audioMode: "preserve";
  status: JobStatus;
  progress: number;
  frameProgress: { currentFrame: number; totalFrames: number } | null;
  fileSize: number;
  outputPaths: string[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  message?: string | null;
  requestedDevice?: "cuda" | "cpu" | "auto";
  deviceUsed?: string;
  audioPreserved?: boolean;
  sourceHasAudio?: boolean;
  elapsedSeconds?: number;
};

type JobSettings = Pick<JobRecord, "blurTarget" | "device" | "exportQuality" | "audioMode"> & {
  outputDir?: string;
};

const storeName = "bluritout-jobs.json";
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const workerState = {
  queue: [] as string[],
  runningJobId: null as string | null,
  jobs: new Map<string, JobRecord>(),
  processes: new Map<string, ReturnType<typeof spawn>>(),
};

function userStorePath() {
  return path.join(app.getPath("userData"), storeName);
}

function workerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "engine", "worker.py");
  }
  return path.resolve(app.getAppPath(), "..", "engine", "worker.py");
}

function pythonCommand() {
  if (process.env.BLURITOUT_PYTHON) {
    return process.env.BLURITOUT_PYTHON;
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

  const discovered = candidatePaths.find((candidate) => fs.existsSync(candidate));
  return discovered || "python";
}

function persistJobs() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userStorePath(), JSON.stringify(Array.from(workerState.jobs.values()), null, 2), "utf8");
}

function restoreJobs() {
  const storePath = userStorePath();
  if (!fs.existsSync(storePath)) {
    return;
  }
  const records = JSON.parse(fs.readFileSync(storePath, "utf8")) as JobRecord[];
  records.forEach((record) => workerState.jobs.set(record.id, record));
}

function sortedJobs() {
  return Array.from(workerState.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function broadcastJobs() {
  const jobs = sortedJobs();
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("jobs:updated", jobs));
  persistJobs();
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
      requestedDevice: String(event.requested_device || current?.requestedDevice || current?.device || "") as JobRecord["requestedDevice"],
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      message: String(event.message || ""),
    });
    return;
  }

  if (event.status === "muxing") {
    patchJob(jobId, {
      status: "muxing",
      progress: 99,
      requestedDevice: String(event.requested_device || current?.requestedDevice || current?.device || "") as JobRecord["requestedDevice"],
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      message: String(event.message || ""),
    });
    return;
  }

  if (event.status === "completed") {
    patchJob(jobId, {
      status: "completed",
      progress: 100,
      outputPaths: Array.isArray(event.outputs) ? (event.outputs as string[]) : [],
      requestedDevice: String(event.requested_device || "") as JobRecord["requestedDevice"],
      audioPreserved: Boolean(event.audio_preserved),
      sourceHasAudio: Boolean(event.source_has_audio),
      elapsedSeconds: Number(event.elapsed_seconds || 0),
      deviceUsed: String(event.device || ""),
      error: null,
      message: null,
    });
    return;
  }

  if (event.status === "failed") {
    patchJob(jobId, {
      status: "failed",
      error: String(event.error || "Processing failed"),
      requestedDevice: String(event.requested_device || "") as JobRecord["requestedDevice"],
      audioPreserved: Boolean(event.audio_preserved),
      sourceHasAudio: Boolean(event.source_has_audio),
      deviceUsed: String(event.device || ""),
    });
    return;
  }

  if (event.status === "queued" || event.status === "preparing") {
    patchJob(jobId, {
      status: event.status as JobStatus,
      requestedDevice: String(event.requested_device || current?.requestedDevice || "") as JobRecord["requestedDevice"],
      deviceUsed: String(event.device || current?.deviceUsed || ""),
      message: String(event.message || ""),
    });
  }
}

function shouldIgnoreWorkerStderr(message: string) {
  return message.includes("FutureWarning") || message.includes("torch.load") || message.includes("weights_only=False");
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
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(pythonCommand(), [workerScriptPath(), "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
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

app.whenReady().then(() => {
  restoreJobs();
  createWindow();
  broadcastJobs();

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

ipcMain.handle("jobs:open-output", async (_, outputPath: string) => shell.showItemInFolder(outputPath));
ipcMain.handle("jobs:open-folder", async (_, outputPath: string) => shell.openPath(path.dirname(outputPath)));
