/**
 * Shared types used by both the Electron main process and the React renderer.
 * Keep this file free of Node.js or browser-specific imports.
 */

export type JobStatus = "queued" | "preparing" | "processing" | "muxing" | "completed" | "failed" | "canceled";
export type AnalysisStatus = "queued" | "analyzing" | "completed" | "failed" | "canceled";
export type DeviceMode = "auto" | "cuda" | "cpu";
export type BlurTarget = "faces" | "plates" | "both";
export type ModelPolicy = "standard" | "commercial_safe";
export type SelectionMode = "blur_selected" | "keep_selected";

export type JobRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  outputDir: string;
  blurTarget: BlurTarget;
  device: DeviceMode;
  modelPolicy: ModelPolicy;
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
  startedAt?: string | null;
  error: string | null;
  message?: string | null;
  requestedDevice?: DeviceMode;
  deviceUsed?: string;
  workerPython?: string;
  audioPreserved?: boolean;
  sourceHasAudio?: boolean;
  elapsedSeconds?: number;
};

export type TrackSummary = {
  track_id: number;
  object_type: "face" | "plate";
  label: string;
  first_seen_frame: number;
  last_seen_frame: number;
  frames_seen: number;
  representative_box: [number, number, number, number];
  preview_path?: string | null;
  ocr_preview_path?: string | null;
  merged_track_ids?: number[] | null;
  plate_verified?: boolean | null;
  plate_verification_source?: "geometry" | "paddleocr" | null;
  plate_verification_score?: number | null;
  plate_text?: string | null;
  plate_ocr_error?: string | null;
};

export type AnalysisRecord = {
  id: string;
  inputPath: string;
  inputName: string;
  blurTarget: BlurTarget;
  device: DeviceMode;
  modelPolicy: ModelPolicy;
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

export type JobSettings = Pick<JobRecord, "blurTarget" | "device" | "modelPolicy" | "exportQuality" | "audioMode"> & {
  outputDir?: string;
  selectionMode?: SelectionMode;
  selectedTrackIds?: number[];
  analysisPath?: string | null;
};

export type AnalysisSettings = {
  blurTarget: BlurTarget;
  device: DeviceMode;
  modelPolicy: ModelPolicy;
};

export type AnalysisStartPayload = {
  inputPath: string;
  settings: AnalysisSettings;
};
