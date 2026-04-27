from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import warnings
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

import cv2
import numpy as np
from PIL import Image

try:
    import torch
    if not hasattr(torch, "cuda") or not hasattr(torch, "from_numpy"):
        torch = None
except ImportError:  # pragma: no cover
    torch = None

warnings.filterwarnings(
    "ignore",
    message=r".*You are using `torch\.load` with `weights_only=False`.*",
    category=FutureWarning,
)


DEFAULT_DETECT_EVERY_N = 3
BLUR_BOX_PADDING_RATIO = 0.22
BLUR_MIN_PADDING_PX = 8
BLUR_PIXEL_BLOCK_SIZE = 12
BLUR_MIN_KERNEL = 41
BLUR_MAX_KERNEL = 151
DEFAULT_OUTPUT_SUFFIX = "_blurred"
QUEUE_SIZE = 32
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}
DEFAULT_MODEL_POLICY = "standard"
DEFAULT_FACE_PROVIDER = "auto"
FACE_DETECTOR_THRESHOLDS = [0.6, 0.7, 0.75]
MIN_FACE_SIZE = 30
MIN_FACE_CONFIDENCE = 0.9
INSIGHTFACE_DETECTOR_NAME = "buffalo_l"
INSIGHTFACE_FACE_CONFIDENCE = 0.55
FACE_MERGE_SIMILARITY_THRESHOLD = 0.82
MIN_FACE_ASPECT_RATIO = 0.55
MAX_FACE_ASPECT_RATIO = 1.8
MAX_FACE_AREA_RATIO = 0.2
MIN_FACE_TRACK_DETECTION_FRAMES = 2
MAX_FACE_MERGE_OVERLAP_FRAMES = 12
MIN_FACE_MERGE_OVERLAP_AVG_IOU = 0.45
MIN_FACE_MERGE_OVERLAP_PEAK_IOU = 0.6
TRACK_CLASS_TO_ID = {"face": 0, "plate": 1}
TRACK_ID_TO_CLASS = {value: key for key, value in TRACK_CLASS_TO_ID.items()}
DEFAULT_PLATE_PROVIDER = "auto"
DEFAULT_PLATE_MODEL_NAME = "yolov8n-license-plate.pt"
PREFERRED_PLATE_MODEL_NAMES = ("yolov8n-license-plate.onnx", DEFAULT_PLATE_MODEL_NAME)
PLATE_MODEL_CONFIDENCE = 0.35
MIN_PLATE_WIDTH = 28
MIN_PLATE_HEIGHT = 10
MIN_PLATE_ASPECT_RATIO = 1.8
MAX_PLATE_ASPECT_RATIO = 6.5
MIN_PLATE_AREA_RATIO = 0.0001
MAX_PLATE_AREA_RATIO = 0.08
MIN_STABLE_TRACK_FRAMES = 3
MIN_PLATE_OCR_SCORE = 0.45
MIN_PLATE_OCR_REJECTION_SCORE = 0.75
MIN_PLATE_TEXT_LENGTH = 5
MAX_PLATE_TEXT_LENGTH = 12
PLATE_OCR_MIN_WIDTH = 320
PLATE_OCR_BORDER = 12

_PLATE_OCR = None
_PLATE_OCR_LOADED = False
_PLATE_OCR_ERROR = None
_FACE_MERGE_MODELS = None
_FACE_MERGE_DEVICE = None
_INSIGHTFACE_ANALYZER = None
_INSIGHTFACE_DEVICE = None
_EVENT_STREAM = sys.stdout


def worker_base_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parent


def bundled_insightface_root() -> Path | None:
    candidates = [
        worker_base_dir() / "models" / "insightface-cache",
        worker_base_dir() / "_internal" / "models" / "insightface-cache",
    ]
    for candidate in candidates:
        model_dir = candidate / "models" / INSIGHTFACE_DETECTOR_NAME
        if model_dir.exists():
            return candidate
    return None


def bundled_paddlex_models_root() -> Path | None:
    candidates = [
        worker_base_dir() / "models" / "paddlex-cache" / "official_models",
        worker_base_dir() / "_internal" / "models" / "paddlex-cache" / "official_models",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def seed_bundled_paddlex_models(cache_dir: Path) -> None:
    bundled_models = bundled_paddlex_models_root()
    if bundled_models is None:
        return
    official_models_dir = cache_dir / "official_models"
    official_models_dir.mkdir(parents=True, exist_ok=True)
    for model_dir in bundled_models.iterdir():
        if not model_dir.is_dir():
            continue
        destination = official_models_dir / model_dir.name
        if destination.exists():
            continue
        shutil.copytree(model_dir, destination)


def env_choice(name: str, default: str, allowed: set[str]) -> str:
    value = str(os.environ.get(name, default)).strip().lower()
    return value if value in allowed else default


def configured_face_provider() -> str:
    return env_choice("BLURITOUT_FACE_PROVIDER", DEFAULT_FACE_PROVIDER, {"auto", "insightface", "mtcnn", "cascade"})


def configured_model_policy() -> str:
    return env_choice("BLURITOUT_MODEL_POLICY", DEFAULT_MODEL_POLICY, {"standard", "commercial_safe"})


def configured_plate_provider() -> str:
    return env_choice(
        "BLURITOUT_PLATE_PROVIDER",
        DEFAULT_PLATE_PROVIDER,
        {"auto", "ultralytics_yolov8", "ultralytics", "onnx_yolo", "disabled"},
    )


def configured_plate_model_path() -> Path:
    override = str(os.environ.get("BLURITOUT_PLATE_MODEL_PATH", "")).strip()
    if override:
        return Path(override).expanduser().resolve()
    worker_dir = Path(__file__).resolve().parent
    for model_name in PREFERRED_PLATE_MODEL_NAMES:
        candidate = (worker_dir / model_name).resolve()
        if candidate.exists():
            return candidate
    return (worker_dir / PREFERRED_PLATE_MODEL_NAMES[0]).resolve()


def resolve_plate_provider(configured_provider: str | None = None, model_path: Path | None = None) -> str:
    provider = configured_provider or configured_plate_provider()
    if provider == "auto":
        path = model_path or configured_plate_model_path()
        suffix = path.suffix.lower()
        policy = configured_model_policy()
        default_model_path = (Path(__file__).resolve().parent / DEFAULT_PLATE_MODEL_NAME).resolve()
        if policy == "commercial_safe" and path.resolve() == default_model_path:
            return "disabled"
        if suffix == ".onnx":
            return "onnx_yolo"
        if suffix in {".pt", ".pth"}:
            return "ultralytics_yolov8"
        return "onnx_yolo"
    return provider


def resolve_face_provider(configured_provider: str | None = None, policy: str | None = None) -> str:
    provider = configured_provider or configured_face_provider()
    active_policy = policy or configured_model_policy()
    if provider == "auto":
        if active_policy == "commercial_safe":
            return "cascade"
        return "insightface"
    if active_policy == "commercial_safe" and provider == "insightface":
        return "cascade"
    return provider


def commercial_risk_warnings() -> list[str]:
    warnings: list[str] = []
    model_policy = configured_model_policy()
    face_provider = resolve_face_provider(configured_face_provider(), model_policy)
    plate_model_path = configured_plate_model_path()
    plate_provider = resolve_plate_provider(configured_plate_provider(), plate_model_path)

    if model_policy == "commercial_safe":
        warnings.append(
            "Commercial-safe policy is active. Built-in risky providers are avoided where possible, but you still need to verify the license of any external model file you supply."
        )

    if face_provider == "insightface":
        warnings.append(
            "Face stack may use InsightFace pretrained models, which require a commercial license for monetized use."
        )
    if plate_provider in {"ultralytics_yolov8", "ultralytics"}:
        warnings.append(
            "Plate stack uses Ultralytics YOLO, which requires AGPL compliance or a commercial license for closed-source monetized use."
        )
    elif plate_provider == "onnx_yolo":
        warnings.append(
            "Plate stack uses a generic ONNX detector backend; commercial safety depends on the license of the supplied checkpoint and training data."
        )
    elif model_policy == "commercial_safe" and plate_provider == "disabled":
        warnings.append("Plate detection is disabled under commercial-safe policy until you provide a compatible model file.")
    return warnings


def describe_model_stack() -> dict:
    model_policy = configured_model_policy()
    configured_face = configured_face_provider()
    face_provider = resolve_face_provider(configured_face, model_policy)
    plate_model_path = configured_plate_model_path()
    configured_plate = configured_plate_provider()
    plate_provider = resolve_plate_provider(configured_plate, plate_model_path)
    return {
        "modelPolicy": model_policy,
        "configuredFaceProvider": configured_face,
        "faceProvider": face_provider,
        "faceModel": INSIGHTFACE_DETECTOR_NAME if face_provider in {"auto", "insightface"} else None,
        "faceFallbackChain": [face_provider],
        "configuredPlateProvider": configured_plate,
        "plateProvider": plate_provider,
        "plateModelPath": str(plate_model_path) if plate_provider != "disabled" else None,
        "plateModelExists": plate_model_path.exists() if plate_provider != "disabled" else False,
        "commercialWarnings": commercial_risk_warnings(),
    }


class OnnxYoloPlateDetector:
    def __init__(self, model_path: Path, device: str, input_size: int = 640):
        self.model_path = model_path
        self.device = device
        self.input_size = input_size
        self.session = self._create_session()
        self.input_name = self.session.get_inputs()[0].name

    def _create_session(self):
        import onnxruntime as ort

        providers = ["CPUExecutionProvider"]
        if self.device == "cuda":
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        return ort.InferenceSession(str(self.model_path), providers=providers)

    def _letterbox(self, frame: np.ndarray) -> tuple[np.ndarray, float, float, float]:
        height, width = frame.shape[:2]
        scale = min(self.input_size / max(1, width), self.input_size / max(1, height))
        resized_w = max(1, int(round(width * scale)))
        resized_h = max(1, int(round(height * scale)))
        resized = cv2.resize(frame, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        pad_w = self.input_size - resized_w
        pad_h = self.input_size - resized_h
        pad_left = pad_w / 2.0
        pad_top = pad_h / 2.0
        top = int(np.floor(pad_top))
        bottom = int(np.ceil(pad_h - top))
        left = int(np.floor(pad_left))
        right = int(np.ceil(pad_w - left))
        padded = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
        return padded, scale, pad_left, pad_top

    def predict(self, frame: np.ndarray, confidence_threshold: float, nms_threshold: float = 0.45) -> list[dict]:
        padded, scale, pad_left, pad_top = self._letterbox(frame)
        image = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = np.transpose(image, (2, 0, 1))[None, ...]
        outputs = self.session.run(None, {self.input_name: tensor})
        output = outputs[0]
        if output.ndim == 3:
            output = output[0]
        if output.ndim != 2:
            return []
        if output.shape[0] <= output.shape[1]:
            output = output.T

        candidate_boxes: list[list[int]] = []
        candidate_scores: list[float] = []

        for row in output:
            if row.shape[0] < 5:
                continue
            cx, cy, width, height = map(float, row[:4])
            class_scores = row[4:]
            score = float(np.max(class_scores)) if class_scores.size else 0.0
            if score < confidence_threshold:
                continue

            x1 = int(round((cx - width / 2.0 - pad_left) / max(scale, 1e-6)))
            y1 = int(round((cy - height / 2.0 - pad_top) / max(scale, 1e-6)))
            x2 = int(round((cx + width / 2.0 - pad_left) / max(scale, 1e-6)))
            y2 = int(round((cy + height / 2.0 - pad_top) / max(scale, 1e-6)))
            candidate_boxes.append([x1, y1, max(1, x2 - x1), max(1, y2 - y1)])
            candidate_scores.append(score)

        if not candidate_boxes:
            return []

        selected = cv2.dnn.NMSBoxes(candidate_boxes, candidate_scores, confidence_threshold, nms_threshold)
        if len(selected) == 0:
            return []

        detections: list[dict] = []
        selected_indexes = selected.flatten().tolist() if hasattr(selected, "flatten") else [int(selected)]
        frame_height, frame_width = frame.shape[:2]
        for index in selected_indexes:
            x, y, width, height = candidate_boxes[int(index)]
            x1 = max(0, min(frame_width - 1, x))
            y1 = max(0, min(frame_height - 1, y))
            x2 = max(x1 + 1, min(frame_width, x + width))
            y2 = max(y1 + 1, min(frame_height, y + height))
            detections.append(
                {
                    "box": [x1, y1, x2, y2],
                    "confidence": float(candidate_scores[int(index)]),
                    "object_type": "plate",
                }
            )
        return detections


@dataclass(slots=True)
class JobConfig:
    job_id: str
    input_paths: list[str]
    output_dir: str | None = None
    blur_target: str = "both"
    device: str = "cuda"
    detection_interval: int = DEFAULT_DETECT_EVERY_N
    export_quality: str = "near_source"
    audio_mode: str = "preserve"
    overwrite: bool = False
    mode: str = "process"
    analysis_output: str | None = None
    preview_output: str | None = None
    thumbnails_dir: str | None = None
    analysis_path: str | None = None
    selection_mode: str = "blur_selected"
    selected_track_ids: list[int] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict) -> "JobConfig":
        input_paths = payload.get("input_paths")
        if not input_paths:
            raise ValueError("input_paths is required")
        return cls(
            job_id=str(payload.get("job_id") or uuid.uuid4()),
            input_paths=[str(item) for item in input_paths],
            output_dir=str(payload["output_dir"]) if payload.get("output_dir") else None,
            blur_target=str(payload.get("blur_target", "both")),
            device=str(payload.get("device", "cuda")),
            detection_interval=max(1, int(payload.get("detection_interval", DEFAULT_DETECT_EVERY_N))),
            export_quality=str(payload.get("export_quality", "near_source")),
            audio_mode=str(payload.get("audio_mode", "preserve")),
            overwrite=bool(payload.get("overwrite", False)),
            mode=str(payload.get("mode", "process")),
            analysis_output=str(payload["analysis_output"]) if payload.get("analysis_output") else None,
            preview_output=str(payload["preview_output"]) if payload.get("preview_output") else None,
            thumbnails_dir=str(payload["thumbnails_dir"]) if payload.get("thumbnails_dir") else None,
            analysis_path=str(payload["analysis_path"]) if payload.get("analysis_path") else None,
            selection_mode=str(payload.get("selection_mode", "blur_selected")),
            selected_track_ids=[int(item) for item in payload.get("selected_track_ids", [])],
        )


@dataclass(slots=True)
class SourceMediaInfo:
    width: int
    height: int
    fps: float
    total_frames: int
    duration_seconds: float | None
    has_audio: bool


@dataclass(slots=True)
class JobResult:
    job_id: str
    status: str
    outputs: list[str] = field(default_factory=list)
    elapsed_seconds: float = 0.0
    device: str = "cpu"
    requested_device: str = "cuda"
    worker_python: str = sys.executable
    audio_preserved: bool = False
    source_has_audio: bool = False
    error: str | None = None
    analysis_path: str | None = None
    preview_path: str | None = None
    tracks: list[dict] = field(default_factory=list)
    preview_tracks: list[int] = field(default_factory=list)


def emit_event(event: dict) -> None:
    print(json.dumps(event), file=_EVENT_STREAM, flush=True)


def load_config(path: str) -> JobConfig:
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return JobConfig.from_dict(payload)


def resolve_device(requested_device: str) -> str:
    requested = requested_device.lower()
    if requested not in {"auto", "cuda", "cpu"}:
        raise ValueError(f"Unsupported device: {requested_device}")

    cuda_available = bool(torch and torch.cuda.is_available())
    if requested == "auto":
        return "cuda" if cuda_available else "cpu"
    if requested == "cuda" and not cuda_available:
        return "cpu"
    return requested


def validate_runtime_support(blur_target: str) -> None:
    target = blur_target.lower()
    if target not in {"faces", "plates", "both"}:
        raise ValueError(f"Unsupported blur target: {blur_target}")

    model_policy = configured_model_policy()
    plate_provider = resolve_plate_provider(configured_plate_provider(), configured_plate_model_path())
    if target in {"plates", "both"} and plate_provider == "disabled":
        if model_policy == "commercial_safe":
            raise RuntimeError(
                "Plate detection is disabled under commercial-safe policy. "
                "Provide BLURITOUT_PLATE_MODEL_PATH with a compatible model or switch blur target to faces only."
            )
        raise RuntimeError("Plate detection is disabled for the active worker stack.")


def discover_inputs(input_paths: Sequence[str]) -> list[Path]:
    discovered: list[Path] = []
    for raw_path in input_paths:
        path = Path(raw_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Input path does not exist: {path}")
        if path.is_dir():
            for file in sorted(path.iterdir()):
                if file.is_file() and file.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
                    discovered.append(file)
        elif path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
            discovered.append(path)
    if not discovered:
        raise ValueError("No supported video files were found in the provided input paths")
    return discovered


def output_path_for(source_path: Path, output_dir: str | None) -> Path:
    destination_dir = Path(output_dir).expanduser().resolve() if output_dir else source_path.parent
    destination_dir.mkdir(parents=True, exist_ok=True)
    return destination_dir / f"{source_path.stem}{DEFAULT_OUTPUT_SUFFIX}.mp4"


def ffprobe_has_audio(input_path: Path) -> bool:
    command = [
        os.environ.get("BLURITOUT_FFPROBE", "ffprobe"),
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        str(input_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return False
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return bool(payload.get("streams"))


def build_ffmpeg_command(
    intermediate_path: Path,
    source_path: Path,
    output_path: Path,
    has_audio: bool,
    export_quality: str,
) -> list[str]:
    crf = "18" if export_quality == "near_source" else "21"
    command = [os.environ.get("BLURITOUT_FFMPEG", "ffmpeg"), "-y", "-i", str(intermediate_path)]
    if has_audio:
        command.extend(["-i", str(source_path)])
    command.extend(["-map", "0:v:0"])
    if has_audio:
        command.extend(["-map", "1:a:0?"])
    command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            crf,
            "-pix_fmt",
            "yuv420p",
        ]
    )
    if has_audio:
        command.extend(["-c:a", "copy"])
    command.extend(["-movflags", "+faststart", str(output_path)])
    return command


def mux_with_audio(
    intermediate_path: Path,
    source_path: Path,
    output_path: Path,
    has_audio: bool,
    export_quality: str,
) -> bool:
    command = build_ffmpeg_command(intermediate_path, source_path, output_path, has_audio, export_quality)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode == 0:
        return has_audio
    if has_audio:
        fallback = build_ffmpeg_command(intermediate_path, source_path, output_path, False, export_quality)
        fallback_result = subprocess.run(fallback, capture_output=True, text=True, check=False)
        if fallback_result.returncode == 0:
            return False
    raise RuntimeError(result.stderr.strip() or "ffmpeg muxing failed")


class ModelRegistry:
    def __init__(self, device: str, blur_target: str):
        self.device = device
        self.blur_target = blur_target
        self.model_policy = configured_model_policy()
        self.face_provider = resolve_face_provider(configured_face_provider(), self.model_policy)
        self.plate_model_path = configured_plate_model_path()
        self.plate_provider = resolve_plate_provider(configured_plate_provider(), self.plate_model_path)
        self.face_analyzer = None
        self.face_detector = None
        self.face_cascade = None
        self.plate_model = None

    def load(self) -> None:
        if self.blur_target in {"faces", "both"}:
            if self.face_provider == "insightface":
                self.face_analyzer = load_insightface_analyzer(self.device)
            if self.face_analyzer is None and self.face_provider == "mtcnn":
                try:
                    from facenet_pytorch import MTCNN

                    self.face_detector = MTCNN(
                        keep_all=True,
                        device=self.device,
                        thresholds=FACE_DETECTOR_THRESHOLDS,
                        min_face_size=MIN_FACE_SIZE,
                    )
                except ImportError:
                    if self.face_provider == "mtcnn":
                        raise RuntimeError("BLURITOUT_FACE_PROVIDER=mtcnn was requested but facenet_pytorch is unavailable")
            if self.face_analyzer is None and self.face_detector is None and self.face_provider == "cascade":
                cascade_path = Path(__file__).resolve().parent / "models" / "haarcascade_frontalface_default.xml"
                self.face_cascade = cv2.CascadeClassifier(str(cascade_path))
                if self.face_cascade.empty():
                    raise RuntimeError(f"Could not load fallback face cascade from {cascade_path}")
            if self.face_analyzer is None and self.face_detector is None and self.face_cascade is None:
                raise RuntimeError(f"Could not initialize face provider '{self.face_provider}'")
        if self.blur_target in {"plates", "both"}:
            if self.plate_provider == "disabled":
                return
            if self.plate_provider == "onnx_yolo":
                self.plate_model = OnnxYoloPlateDetector(self.plate_model_path, self.device)
            else:
                from ultralytics import YOLO

                self.plate_model = YOLO(str(self.plate_model_path))
                self.plate_model.to(self.device)
                if self.device == "cuda" and torch is not None:
                    dummy = torch.zeros(1, 3, 640, 640, device=self.device)
                    self.plate_model(dummy, verbose=False)

    def detect_objects(self, frame) -> list[dict]:
        detections: list[dict] = []
        if self.face_analyzer is not None:
            faces = self.face_analyzer.get(frame)
            for face in faces:
                bbox = getattr(face, "bbox", None)
                det_score = float(getattr(face, "det_score", 0.0) or 0.0)
                embedding = getattr(face, "normed_embedding", None)
                if bbox is None:
                    continue
                x1, y1, x2, y2 = map(int, bbox[:4])
                if not is_valid_face_detection(frame, [x1, y1, x2, y2], det_score, minimum_confidence=INSIGHTFACE_FACE_CONFIDENCE):
                    continue
                detections.append(
                    {
                        "box": [max(0, x1), max(0, y1), max(0, x2), max(0, y2)],
                        "confidence": det_score,
                        "object_type": "face",
                        "embedding": np.asarray(embedding, dtype=np.float32) if embedding is not None else None,
                    }
                )
        elif self.face_detector is not None:
            pil_image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            boxes, probabilities = self.face_detector.detect(pil_image)
            if boxes is not None:
                probability_list = probabilities.tolist() if hasattr(probabilities, "tolist") else (probabilities or [])
                for box, probability in zip(boxes, probability_list):
                    if probability is None:
                        continue
                    x1, y1, x2, y2 = map(int, box)
                    if not is_valid_face_detection(frame, [x1, y1, x2, y2], float(probability)):
                        continue
                    detections.append(
                        {
                            "box": [max(0, x1), max(0, y1), max(0, x2), max(0, y2)],
                            "confidence": float(probability),
                            "object_type": "face",
                        }
                    )
        elif self.face_cascade is not None:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            boxes = self.face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
            for x, y, width, height in boxes:
                detections.append(
                    {
                        "box": [int(x), int(y), int(x + width), int(y + height)],
                        "confidence": 0.85,
                        "object_type": "face",
                    }
                )

        if self.plate_model is not None:
            if self.plate_provider == "onnx_yolo":
                plate_detections = self.plate_model.predict(frame, PLATE_MODEL_CONFIDENCE)
                for item in plate_detections:
                    x1, y1, x2, y2 = map(int, item["box"])
                    confidence = float(item["confidence"])
                    if not is_valid_plate_detection(frame, [x1, y1, x2, y2], confidence):
                        continue
                    detections.append(item)
            else:
                results = self.plate_model(frame, verbose=False, imgsz=640, half=self.device == "cuda", conf=PLATE_MODEL_CONFIDENCE)
                for result in results:
                    for box in result.boxes:
                        x1, y1, x2, y2 = map(int, box.xyxy[0])
                        confidence = float(box.conf[0]) if box.conf is not None else 0.0
                        if not is_valid_plate_detection(frame, [x1, y1, x2, y2], confidence):
                            continue
                        detections.append(
                            {
                                "box": [x1, y1, x2, y2],
                                "confidence": confidence,
                                "object_type": "plate",
                            }
                        )
        return detections


def create_plate_tracker(device: str):
    from deep_sort_realtime.deepsort_tracker import DeepSort

    return DeepSort(
        max_iou_distance=0.9,
        max_age=45,
        n_init=2,
        max_cosine_distance=0.7,
        embedder=None,
        bgr=True,
    )


def geometry_embedding(frame_shape: Sequence[int], box: Sequence[int], object_type: str) -> np.ndarray:
    height, width = max(1, int(frame_shape[0])), max(1, int(frame_shape[1]))
    x1, y1, x2, y2 = map(float, box)
    box_width = max(1.0, x2 - x1)
    box_height = max(1.0, y2 - y1)
    center_x = (x1 + x2) / (2.0 * width)
    center_y = (y1 + y2) / (2.0 * height)
    width_ratio = box_width / width
    height_ratio = box_height / height
    area_ratio = (box_width * box_height) / float(width * height)
    aspect_ratio = min(8.0, box_width / box_height) / 8.0
    class_face = 1.0 if object_type == "face" else 0.0
    class_plate = 1.0 if object_type == "plate" else 0.0
    embedding = np.asarray(
        [
            class_face,
            class_plate,
            center_x,
            center_y,
            width_ratio,
            height_ratio,
            area_ratio,
            aspect_ratio,
        ],
        dtype=np.float32,
    )
    norm = np.linalg.norm(embedding)
    return embedding / norm if norm > 0 else embedding


def detection_embedding(frame_shape: Sequence[int], detection: dict) -> np.ndarray:
    embedding = detection.get("embedding")
    if embedding is not None:
        embedding_array = np.asarray(embedding, dtype=np.float32)
        norm = np.linalg.norm(embedding_array)
        if norm > 0:
            return embedding_array / norm
    return geometry_embedding(frame_shape, detection["box"], str(detection.get("object_type") or "face"))


def update_tracker(tracker, tracker_inputs: list, frame, embeds: list[np.ndarray] | None = None) -> list:
    # deep_sort_realtime validates "frame or embeds" before it checks whether
    # there are any detections, so empty updates must pass embeds=[] explicitly.
    if tracker_inputs:
        if embeds is not None:
            return tracker.update_tracks(tracker_inputs, embeds=embeds)
        return tracker.update_tracks(tracker_inputs, frame=frame)
    return tracker.update_tracks([], embeds=[])


def is_valid_face_detection(
    frame,
    box: Sequence[int],
    confidence: float,
    minimum_confidence: float = MIN_FACE_CONFIDENCE,
) -> bool:
    if confidence < minimum_confidence:
        return False
    x1, y1, x2, y2 = map(int, box)
    width = x2 - x1
    height = y2 - y1
    if width < MIN_FACE_SIZE or height < MIN_FACE_SIZE:
        return False

    aspect_ratio = width / max(1, height)
    if aspect_ratio < MIN_FACE_ASPECT_RATIO or aspect_ratio > MAX_FACE_ASPECT_RATIO:
        return False

    frame_area = max(1, frame.shape[0] * frame.shape[1])
    area_ratio = (width * height) / frame_area
    return area_ratio <= MAX_FACE_AREA_RATIO


def is_valid_plate_detection(frame, box: Sequence[int], confidence: float) -> bool:
    if confidence < PLATE_MODEL_CONFIDENCE:
        return False
    x1, y1, x2, y2 = map(int, box)
    width = x2 - x1
    height = y2 - y1
    if width < MIN_PLATE_WIDTH or height < MIN_PLATE_HEIGHT:
        return False

    aspect_ratio = width / max(1, height)
    if aspect_ratio < MIN_PLATE_ASPECT_RATIO or aspect_ratio > MAX_PLATE_ASPECT_RATIO:
        return False

    frame_area = max(1, frame.shape[0] * frame.shape[1])
    area_ratio = (width * height) / frame_area
    return MIN_PLATE_AREA_RATIO <= area_ratio <= MAX_PLATE_AREA_RATIO


def box_iou(box_a: Sequence[int], box_b: Sequence[int]) -> float:
    ax1, ay1, ax2, ay2 = map(int, box_a)
    bx1, by1, bx2, by2 = map(int, box_b)

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    intersection = inter_w * inter_h
    if intersection <= 0:
        return 0.0

    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    union = area_a + area_b - intersection
    return intersection / max(1, union)


def best_plate_detection_for_track(raw_detections: list[dict], track_box: Sequence[int]) -> dict | None:
    best_match: dict | None = None
    best_iou = 0.0
    for detection in raw_detections:
        if detection.get("object_type") != "plate":
            continue
        overlap = box_iou(detection["box"], track_box)
        if overlap < 0.2:
            continue
        if best_match is None or overlap > best_iou or (
            abs(overlap - best_iou) < 0.02 and float(detection.get("confidence", 0.0)) > float(best_match.get("confidence", 0.0))
        ):
            best_match = detection
            best_iou = overlap
    return best_match


def best_face_detection_for_track(raw_detections: list[dict], track_box: Sequence[int]) -> dict | None:
    best_match: dict | None = None
    best_iou = 0.0
    tx1, ty1, tx2, ty2 = map(int, track_box)
    track_width = max(1, tx2 - tx1)
    track_height = max(1, ty2 - ty1)
    track_area = track_width * track_height
    track_center_x = tx1 + (track_width / 2.0)
    track_center_y = ty1 + (track_height / 2.0)
    for detection in raw_detections:
        if detection.get("object_type") != "face":
            continue
        overlap = box_iou(detection["box"], track_box)
        if overlap < 0.25:
            continue
        if best_match is None or overlap > best_iou or (
            abs(overlap - best_iou) < 0.02 and float(detection.get("confidence", 0.0)) > float(best_match.get("confidence", 0.0))
        ):
            best_match = detection
            best_iou = overlap
    if best_match is not None:
        return best_match

    best_distance_score: float | None = None
    for detection in raw_detections:
        if detection.get("object_type") != "face":
            continue
        dx1, dy1, dx2, dy2 = map(int, detection["box"])
        detection_width = max(1, dx2 - dx1)
        detection_height = max(1, dy2 - dy1)
        detection_area = detection_width * detection_height
        area_ratio = detection_area / max(1.0, float(track_area))
        if area_ratio < 0.35 or area_ratio > 2.85:
            continue
        detection_center_x = dx1 + (detection_width / 2.0)
        detection_center_y = dy1 + (detection_height / 2.0)
        center_distance = ((track_center_x - detection_center_x) ** 2 + (track_center_y - detection_center_y) ** 2) ** 0.5
        normalized_distance = center_distance / max(1.0, float(max(track_width, track_height, detection_width, detection_height)))
        if normalized_distance > 0.7:
            continue
        distance_score = normalized_distance - (0.05 * float(detection.get("confidence", 0.0)))
        if best_distance_score is None or distance_score < best_distance_score:
            best_distance_score = distance_score
            best_match = detection
    return best_match


def score_face_box(box: Sequence[int], confidence: float) -> float:
    x1, y1, x2, y2 = map(int, box)
    width = max(1, x2 - x1)
    height = max(1, y2 - y1)
    area = width * height
    return float(confidence) * float(area**0.5)


def keep_stable_tracks(track_summaries: dict[int, dict], frame_tracks: list[dict], preview_objects: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    stable_track_ids = {
        track_id
        for track_id, summary in track_summaries.items()
        if int(summary.get("frames_seen", 0)) >= MIN_STABLE_TRACK_FRAMES
        and (
            summary.get("object_type") != "face"
            or int(summary.get("face_detection_frames", 0)) >= MIN_FACE_TRACK_DETECTION_FRAMES
        )
    }
    filtered_tracks = [track_summaries[track_id] for track_id in sorted(stable_track_ids)]
    filtered_frames = [
        {
            "frame": item["frame"],
            "objects": [obj for obj in item["objects"] if int(obj["track_id"]) in stable_track_ids],
        }
        for item in frame_tracks
    ]
    filtered_preview = [obj for obj in preview_objects if int(obj["track_id"]) in stable_track_ids]
    return filtered_tracks, filtered_frames, filtered_preview


def load_insightface_analyzer(device: str):
    global _INSIGHTFACE_ANALYZER, _INSIGHTFACE_DEVICE

    if _INSIGHTFACE_ANALYZER is not None and _INSIGHTFACE_DEVICE == device:
        return _INSIGHTFACE_ANALYZER

    try:
        bundled_root = bundled_insightface_root()
        cache_root = os.environ.get("BLURITOUT_INSIGHTFACE_HOME")
        if bundled_root is not None:
            insightface_root = bundled_root
        elif cache_root:
            insightface_root = Path(cache_root).expanduser().resolve()
        else:
            insightface_root = Path(tempfile.gettempdir()) / "bluritout-insightface"
        insightface_root.mkdir(parents=True, exist_ok=True)

        from insightface.app import FaceAnalysis

        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
        analyzer = FaceAnalysis(
            name=INSIGHTFACE_DETECTOR_NAME,
            root=str(insightface_root),
            allowed_modules=["detection", "recognition"],
            providers=providers,
        )
        analyzer.prepare(ctx_id=0 if device == "cuda" else -1, det_thresh=INSIGHTFACE_FACE_CONFIDENCE, det_size=(640, 640))
        _INSIGHTFACE_ANALYZER = analyzer
        _INSIGHTFACE_DEVICE = device
    except Exception as exc:
        _INSIGHTFACE_ANALYZER = None
        _INSIGHTFACE_DEVICE = None
        raise RuntimeError(f"Could not initialize InsightFace analyzer: {exc}") from exc
    return _INSIGHTFACE_ANALYZER


def load_face_merge_models(device: str):
    global _FACE_MERGE_MODELS, _FACE_MERGE_DEVICE

    if _FACE_MERGE_MODELS is not None and _FACE_MERGE_DEVICE == device:
        return _FACE_MERGE_MODELS

    try:
        cache_root = os.environ.get("BLURITOUT_TORCH_CACHE")
        if cache_root:
            torch_cache_dir = Path(cache_root).expanduser().resolve()
        else:
            torch_cache_dir = Path(tempfile.gettempdir()) / "bluritout-torch-cache"
        torch_cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("TORCH_HOME", str(torch_cache_dir))

        from facenet_pytorch import InceptionResnetV1, MTCNN

        face_aligner = MTCNN(
            image_size=160,
            margin=0,
            keep_all=False,
            post_process=True,
            device=device,
        )
        face_embedder = InceptionResnetV1(pretrained="vggface2").eval().to(device)
        _FACE_MERGE_MODELS = (face_aligner, face_embedder)
        _FACE_MERGE_DEVICE = device
    except Exception:
        _FACE_MERGE_MODELS = None
        _FACE_MERGE_DEVICE = None
    return _FACE_MERGE_MODELS


def build_face_embedding_tensor(crop: np.ndarray, face_aligner) -> torch.Tensor | None:
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb)
    aligned = face_aligner(pil_image)
    if aligned is not None:
        if aligned.ndim == 3:
            aligned = aligned.unsqueeze(0)
        return aligned

    if crop.shape[0] < MIN_FACE_SIZE or crop.shape[1] < MIN_FACE_SIZE:
        return None

    resized = cv2.resize(rgb, (160, 160), interpolation=cv2.INTER_CUBIC)
    tensor = torch.from_numpy(resized).permute(2, 0, 1).float()
    tensor = (tensor - 127.5) / 128.0
    return tensor.unsqueeze(0)


def compute_face_track_embedding(track: dict, device: str) -> np.ndarray | None:
    if track.get("object_type") != "face":
        return None

    embedding_sum = track.get("_face_embedding_sum")
    embedding_count = int(track.get("_face_embedding_count") or 0)
    if embedding_sum is not None and embedding_count > 0:
        averaged = np.asarray(embedding_sum, dtype=np.float32) / float(embedding_count)
        norm = np.linalg.norm(averaged)
        if norm > 0:
            return averaged / norm

    if torch is None:
        return None

    preview_path = track.get("preview_path")
    if not preview_path:
        return None

    models = load_face_merge_models(device)
    if models is None:
        return None
    face_aligner, face_embedder = models

    crop = cv2.imread(str(preview_path))
    if crop is None or crop.size == 0:
        return None

    face_tensor = build_face_embedding_tensor(crop, face_aligner)
    if face_tensor is None:
        return None

    with torch.inference_mode():
        embedding = face_embedder(face_tensor.to(device)).detach().cpu().numpy()[0]
    norm = np.linalg.norm(embedding)
    if norm <= 0:
        return None
    return embedding / norm


def tracks_overlap(track_a: dict, track_b: dict) -> bool:
    return not (
        int(track_a["last_seen_frame"]) < int(track_b["first_seen_frame"])
        or int(track_b["last_seen_frame"]) < int(track_a["first_seen_frame"])
    )


def build_track_box_index(frame_tracks: list[dict]) -> dict[int, dict[int, Sequence[int]]]:
    track_boxes: dict[int, dict[int, Sequence[int]]] = {}
    for frame_item in frame_tracks:
        frame_number = int(frame_item["frame"])
        for obj in frame_item["objects"]:
            track_boxes.setdefault(int(obj["track_id"]), {})[frame_number] = obj["box"]
    return track_boxes


def face_tracks_are_merge_compatible(
    left_track: dict,
    right_track: dict,
    frame_box_index: dict[int, dict[int, Sequence[int]]],
) -> bool:
    left_id = int(left_track["track_id"])
    right_id = int(right_track["track_id"])
    left_boxes = frame_box_index.get(left_id, {})
    right_boxes = frame_box_index.get(right_id, {})
    overlap_frames = sorted(set(left_boxes.keys()) & set(right_boxes.keys()))
    if not overlap_frames:
        return True
    if len(overlap_frames) > MAX_FACE_MERGE_OVERLAP_FRAMES:
        return False

    overlap_ious = [box_iou(left_boxes[frame_number], right_boxes[frame_number]) for frame_number in overlap_frames]
    if not overlap_ious:
        return True
    average_iou = sum(overlap_ious) / len(overlap_ious)
    peak_iou = max(overlap_ious)
    return average_iou >= MIN_FACE_MERGE_OVERLAP_AVG_IOU and peak_iou >= MIN_FACE_MERGE_OVERLAP_PEAK_IOU


def merge_face_tracks(tracks: list[dict], frame_tracks: list[dict], preview_objects: list[dict], device: str) -> tuple[list[dict], list[dict], list[dict]]:
    face_tracks = [track for track in tracks if track.get("object_type") == "face"]
    if len(face_tracks) < 2:
        return tracks, frame_tracks, preview_objects
    frame_box_index = build_track_box_index(frame_tracks)

    embeddings = {
        int(track["track_id"]): compute_face_track_embedding(track, device)
        for track in face_tracks
    }
    comparable_face_tracks = [track for track in face_tracks if embeddings.get(int(track["track_id"])) is not None]
    if len(comparable_face_tracks) < 2:
        return tracks, frame_tracks, preview_objects

    parent = {int(track["track_id"]): int(track["track_id"]) for track in face_tracks}

    def find(track_id: int) -> int:
        root = parent[track_id]
        while root != parent[root]:
            parent[root] = parent[parent[root]]
            root = parent[root]
        while track_id != root:
            next_track = parent[track_id]
            parent[track_id] = root
            track_id = next_track
        return root

    def union(left_id: int, right_id: int) -> None:
        left_root = find(left_id)
        right_root = find(right_id)
        if left_root != right_root:
            parent[right_root] = left_root

    sorted_faces = sorted(comparable_face_tracks, key=lambda track: (int(track["first_seen_frame"]), int(track["track_id"])))
    for index, left_track in enumerate(sorted_faces):
        left_id = int(left_track["track_id"])
        left_embedding = embeddings.get(left_id)
        if left_embedding is None:
            continue
        for right_track in sorted_faces[index + 1 :]:
            right_id = int(right_track["track_id"])
            right_embedding = embeddings.get(right_id)
            if right_embedding is None:
                continue
            if not face_tracks_are_merge_compatible(left_track, right_track, frame_box_index):
                continue
            similarity = float(np.dot(left_embedding, right_embedding))
            if similarity >= FACE_MERGE_SIMILARITY_THRESHOLD:
                union(left_id, right_id)

    grouped_tracks: dict[int, list[dict]] = {}
    for track in face_tracks:
        grouped_tracks.setdefault(find(int(track["track_id"])), []).append(track)

    if all(len(group) == 1 for group in grouped_tracks.values()):
        return tracks, frame_tracks, preview_objects

    merged_id_map: dict[int, int] = {}
    merged_face_tracks: dict[int, dict] = {}
    for group in grouped_tracks.values():
        canonical_track = max(group, key=lambda track: (int(track.get("frames_seen", 0)), -int(track["first_seen_frame"])))
        canonical_id = int(canonical_track["track_id"])
        best_preview_track = max(group, key=lambda track: float(track.get("_representative_score", 0.0)))
        merged_track = dict(canonical_track)
        merged_track["first_seen_frame"] = min(int(track["first_seen_frame"]) for track in group)
        merged_track["last_seen_frame"] = max(int(track["last_seen_frame"]) for track in group)
        merged_track["frames_seen"] = sum(int(track.get("frames_seen", 0)) for track in group)
        merged_track["representative_box"] = list(best_preview_track["representative_box"])
        merged_track["preview_path"] = best_preview_track.get("preview_path")
        merged_track["merged_track_ids"] = sorted(int(track["track_id"]) for track in group)
        merged_face_tracks[canonical_id] = merged_track
        for track in group:
            merged_id_map[int(track["track_id"])] = canonical_id

    merged_tracks: list[dict] = []
    for track in tracks:
        if track.get("object_type") != "face":
            merged_tracks.append(track)
            continue
        canonical_id = merged_id_map.get(int(track["track_id"]), int(track["track_id"]))
        if canonical_id in merged_face_tracks:
            merged_tracks.append(merged_face_tracks.pop(canonical_id))

    def remap_objects(objects: list[dict]) -> list[dict]:
        by_track_id: dict[int, dict] = {}
        for obj in objects:
            new_obj = dict(obj)
            track_id = int(new_obj["track_id"])
            canonical_id = merged_id_map.get(track_id, track_id)
            new_obj["track_id"] = canonical_id
            existing = by_track_id.get(canonical_id)
            if existing is None:
                by_track_id[canonical_id] = new_obj
                continue
            existing_area = max(1, (int(existing["box"][2]) - int(existing["box"][0])) * (int(existing["box"][3]) - int(existing["box"][1])))
            candidate_area = max(1, (int(new_obj["box"][2]) - int(new_obj["box"][0])) * (int(new_obj["box"][3]) - int(new_obj["box"][1])))
            if candidate_area > existing_area:
                by_track_id[canonical_id] = new_obj
        return sorted(by_track_id.values(), key=lambda item: (int(item["track_id"]), item["object_type"]))

    remapped_frames = [
        {"frame": item["frame"], "objects": remap_objects(item["objects"])}
        for item in frame_tracks
    ]
    remapped_preview_objects = remap_objects(preview_objects)
    return merged_tracks, remapped_frames, remapped_preview_objects


def relabel_tracks(tracks: list[dict], frame_tracks: list[dict], preview_objects: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    ordered_tracks = sorted(
        tracks,
        key=lambda track: (
            0 if track.get("object_type") == "face" else 1,
            int(track["first_seen_frame"]),
            int(track["track_id"]),
        ),
    )
    counters = {"face": 0, "plate": 0}
    labels_by_track_id: dict[int, str] = {}

    for track in ordered_tracks:
        object_type = str(track.get("object_type") or "face")
        counters[object_type] = counters.get(object_type, 0) + 1
        prefix = "Person" if object_type == "face" else "Plate"
        label = f"{prefix} {counters[object_type]}"
        track["label"] = label
        labels_by_track_id[int(track["track_id"])] = label

    relabeled_frames = [
        {
            "frame": item["frame"],
            "objects": [{**obj, "label": labels_by_track_id.get(int(obj["track_id"]), obj.get("label", ""))} for obj in item["objects"]],
        }
        for item in frame_tracks
    ]
    relabeled_preview = [{**obj, "label": labels_by_track_id.get(int(obj["track_id"]), obj.get("label", ""))} for obj in preview_objects]
    return ordered_tracks, relabeled_frames, relabeled_preview


def sanitize_track_payloads(tracks: list[dict]) -> list[dict]:
    internal_keys = {
        "_face_embedding_sum",
        "_face_embedding_count",
        "_representative_score",
        "face_detection_frames",
        "face_confidence_sum",
        "face_best_confidence",
        "ocr_box",
        "ocr_box_confidence",
    }
    sanitized_tracks: list[dict] = []
    for track in tracks:
        sanitized = {key: value for key, value in track.items() if key not in internal_keys}
        representative_box = sanitized.get("representative_box")
        if isinstance(representative_box, Sequence) and len(representative_box) == 4:
            x1, y1, x2, y2 = map(int, representative_box)
            sanitized["representative_box"] = [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
        sanitized_tracks.append(sanitized)
    return sanitized_tracks


def load_plate_ocr():
    global _PLATE_OCR, _PLATE_OCR_LOADED, _PLATE_OCR_ERROR

    if _PLATE_OCR_LOADED:
        return _PLATE_OCR

    _PLATE_OCR_LOADED = True
    try:
        cache_root = os.environ.get("BLURITOUT_PADDLE_CACHE")
        if cache_root:
            paddlex_cache_dir = Path(cache_root).expanduser().resolve()
        else:
            paddlex_cache_dir = Path(tempfile.gettempdir()) / "bluritout-paddlex-cache"
        paddlex_cache_dir.mkdir(parents=True, exist_ok=True)
        seed_bundled_paddlex_models(paddlex_cache_dir)
        os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(paddlex_cache_dir))
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR

        _PLATE_OCR = PaddleOCR(
            lang="en",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        _PLATE_OCR_ERROR = None
    except Exception as exc:
        _PLATE_OCR = None
        _PLATE_OCR_ERROR = f"{type(exc).__name__}: {exc}"
        print(f"Plate OCR unavailable: {_PLATE_OCR_ERROR}", file=sys.stderr, flush=True)
    return _PLATE_OCR


def normalize_plate_text(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def plate_text_looks_valid(text: str) -> bool:
    if not (MIN_PLATE_TEXT_LENGTH <= len(text) <= MAX_PLATE_TEXT_LENGTH):
        return False
    digit_count = sum(ch.isdigit() for ch in text)
    alpha_count = sum(ch.isalpha() for ch in text)
    return digit_count >= 2 and alpha_count >= 1


def extract_plate_ocr_result(ocr_result) -> tuple[str | None, float | None]:
    best_text: str | None = None
    best_score: float | None = None

    if not ocr_result:
        return None, None

    for page in ocr_result:
        if not page:
            continue
        for line in page:
            if not isinstance(line, (list, tuple)) or len(line) < 2:
                continue
            candidate = line[1]
            if not isinstance(candidate, (list, tuple)) or len(candidate) < 2:
                continue
            raw_text = str(candidate[0] or "")
            score = float(candidate[1] or 0.0)
            normalized = normalize_plate_text(raw_text)
            if not normalized:
                continue
            if best_score is None or score > best_score:
                best_text = normalized
                best_score = score

    return best_text, best_score


def upscale_plate_crop(crop: np.ndarray) -> np.ndarray:
    height, width = crop.shape[:2]
    if width <= 0 or height <= 0:
        return crop
    scale = max(1.0, PLATE_OCR_MIN_WIDTH / float(width))
    if scale == 1.0:
        return crop
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    return cv2.resize(crop, (resized_width, resized_height), interpolation=cv2.INTER_CUBIC)


def add_plate_border(image: np.ndarray) -> np.ndarray:
    return cv2.copyMakeBorder(
        image,
        PLATE_OCR_BORDER,
        PLATE_OCR_BORDER,
        PLATE_OCR_BORDER,
        PLATE_OCR_BORDER,
        cv2.BORDER_CONSTANT,
        value=(255, 255, 255),
    )


def build_plate_ocr_variants(crop: np.ndarray) -> list[np.ndarray]:
    base = upscale_plate_crop(crop)
    gray = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    thresholded = cv2.threshold(clahe, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    sharpened = cv2.addWeighted(clahe, 1.5, cv2.GaussianBlur(clahe, (0, 0), 1.2), -0.5, 0)

    return [
        add_plate_border(base),
        add_plate_border(cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR)),
        add_plate_border(cv2.cvtColor(thresholded, cv2.COLOR_GRAY2BGR)),
        add_plate_border(cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)),
    ]


def verify_plate_track(track: dict) -> bool:
    if track.get("object_type") != "plate":
        return True

    preview_path = track.get("preview_path")
    ocr_preview_path = track.get("ocr_preview_path")
    ocr = load_plate_ocr()
    crop_path = ocr_preview_path or preview_path
    if not crop_path or ocr is None:
        track["plate_verified"] = True
        track["plate_verification_source"] = "geometry"
        track["plate_verification_score"] = None
        track["plate_text"] = None
        track["plate_ocr_error"] = _PLATE_OCR_ERROR if ocr is None else None
        return True

    crop = cv2.imread(str(crop_path))
    if crop is None or crop.size == 0:
        track["plate_verified"] = False
        track["plate_verification_source"] = "paddleocr"
        track["plate_verification_score"] = None
        track["plate_text"] = None
        return False

    plate_text: str | None = None
    plate_score: float | None = None
    for variant in build_plate_ocr_variants(crop):
        try:
            ocr_result = ocr.ocr(variant, cls=False)
        except Exception:
            continue

        candidate_text, candidate_score = extract_plate_ocr_result(ocr_result)
        if candidate_score is None:
            continue
        if plate_score is None or candidate_score > plate_score:
            plate_text = candidate_text
            plate_score = candidate_score

    has_confident_text = bool(plate_text and plate_score is not None and plate_score >= MIN_PLATE_OCR_SCORE)
    is_verified = bool(has_confident_text and plate_text_looks_valid(plate_text))
    should_reject = bool(
        has_confident_text
        and not is_verified
        and plate_score is not None
        and plate_score >= MIN_PLATE_OCR_REJECTION_SCORE
    )
    track["plate_verified"] = is_verified
    track["plate_verification_source"] = "paddleocr"
    track["plate_verification_score"] = plate_score
    track["plate_text"] = plate_text
    track["plate_ocr_error"] = None
    return not should_reject


def verify_analysis_tracks(tracks: list[dict], frame_tracks: list[dict], preview_objects: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    retained_track_ids: set[int] = set()
    verified_tracks: list[dict] = []

    for track in tracks:
        if verify_plate_track(track):
            retained_track_ids.add(int(track["track_id"]))
            verified_tracks.append(track)

    filtered_frames = [
        {
            "frame": item["frame"],
            "objects": [obj for obj in item["objects"] if int(obj["track_id"]) in retained_track_ids],
        }
        for item in frame_tracks
    ]
    filtered_preview = [obj for obj in preview_objects if int(obj["track_id"]) in retained_track_ids]
    return verified_tracks, filtered_frames, filtered_preview


def reader_thread(cap: cv2.VideoCapture, frame_queue: queue.Queue, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        ret, frame = cap.read()
        try:
            frame_queue.put((ret, frame), timeout=1.0)
        except queue.Full:
            if stop_event.is_set():
                break
            continue
        if not ret:
            break


def odd_kernel_size(target: int, max_size: int) -> int:
    max_odd = max(3, max_size if max_size % 2 == 1 else max_size - 1)
    size = max(3, min(target, max_odd))
    return size if size % 2 == 1 else size - 1


def anonymize_region(region):
    height, width = region.shape[:2]
    if height <= 1 or width <= 1:
        return region

    pixelated_width = max(1, width // BLUR_PIXEL_BLOCK_SIZE)
    pixelated_height = max(1, height // BLUR_PIXEL_BLOCK_SIZE)
    pixelated = cv2.resize(region, (pixelated_width, pixelated_height), interpolation=cv2.INTER_AREA)
    pixelated = cv2.resize(pixelated, (width, height), interpolation=cv2.INTER_NEAREST)

    min_dimension = min(width, height)
    if min_dimension < 3:
        return pixelated

    target_kernel = max(BLUR_MIN_KERNEL, int(min(width, height) * 0.65))
    kernel_size = odd_kernel_size(target_kernel, min(min_dimension, BLUR_MAX_KERNEL))
    return cv2.GaussianBlur(pixelated, (kernel_size, kernel_size), 0)


def blur_regions(frame, boxes: Iterable[tuple[int, int, int, int]]) -> None:
    for x1, y1, x2, y2 in boxes:
        width = x2 - x1
        height = y2 - y1
        if width <= 0 or height <= 0:
            continue

        pad_x = max(BLUR_MIN_PADDING_PX, int(width * BLUR_BOX_PADDING_RATIO))
        pad_y = max(BLUR_MIN_PADDING_PX, int(height * BLUR_BOX_PADDING_RATIO))
        x1, y1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
        x2, y2 = min(frame.shape[1], x2 + pad_x), min(frame.shape[0], y2 + pad_y)
        region = frame[y1:y2, x1:x2]
        if region.size > 0:
            frame[y1:y2, x1:x2] = anonymize_region(region)


def clamp_box_to_frame(frame, box: Sequence[int]) -> list[int]:
    x1, y1, x2, y2 = map(int, box)
    max_x = max(0, frame.shape[1])
    max_y = max(0, frame.shape[0])
    cx1 = max(0, min(x1, max_x))
    cy1 = max(0, min(y1, max_y))
    cx2 = max(0, min(x2, max_x))
    cy2 = max(0, min(y2, max_y))
    return [
        min(cx1, cx2),
        min(cy1, cy2),
        max(cx1, cx2),
        max(cy1, cy2),
    ]


def expand_crop_box(frame, box: Sequence[int], pad_x: int, pad_y: int) -> list[int]:
    x1, y1, x2, y2 = clamp_box_to_frame(frame, box)
    return [
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(frame.shape[1], x2 + pad_x),
        min(frame.shape[0], y2 + pad_y),
    ]


def save_track_crop(
    frame,
    box: Sequence[int],
    thumbs_dir: Path | None,
    file_name: str,
    *,
    pad_x_ratio: float,
    pad_y_ratio: float,
    min_pad_x: int,
    min_pad_y: int,
    quality: int = 85,
) -> str | None:
    if thumbs_dir is None:
        return None

    x1, y1, x2, y2 = clamp_box_to_frame(frame, box)
    width = x2 - x1
    height = y2 - y1
    if width <= 0 or height <= 0:
        return None

    pad_x = max(min_pad_x, int(width * pad_x_ratio))
    pad_y = max(min_pad_y, int(height * pad_y_ratio))
    cx1, cy1, cx2, cy2 = expand_crop_box(frame, box, pad_x, pad_y)
    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None

    thumb_path = thumbs_dir / file_name
    cv2.imwrite(str(thumb_path), crop, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return str(thumb_path)


def save_track_thumbnail(frame, box: Sequence[int], thumbs_dir: Path | None, track_id: int) -> str | None:
    return save_track_crop(
        frame,
        box,
        thumbs_dir,
        f"{track_id}.jpg",
        pad_x_ratio=0.35,
        pad_y_ratio=0.35,
        min_pad_x=20,
        min_pad_y=20,
        quality=85,
    )


def save_plate_ocr_crop(frame, box: Sequence[int], thumbs_dir: Path | None, track_id: int) -> str | None:
    return save_track_crop(
        frame,
        box,
        thumbs_dir,
        f"{track_id}-ocr.jpg",
        pad_x_ratio=0.08,
        pad_y_ratio=0.18,
        min_pad_x=4,
        min_pad_y=4,
        quality=95,
    )


def open_video(path: Path) -> tuple[cv2.VideoCapture, SourceMediaInfo]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = (total_frames / fps) if fps > 0 and total_frames > 0 else None
    info = SourceMediaInfo(
        width=width,
        height=height,
        fps=fps,
        total_frames=total_frames,
        duration_seconds=duration,
        has_audio=ffprobe_has_audio(path),
    )
    return cap, info


def write_preview(preview_frame, preview_objects: list[dict], track_labels: dict[int, str], preview_output: Path) -> None:
    annotated = preview_frame.copy()
    for item in preview_objects:
        x1, y1, x2, y2 = item["box"]
        track_id = item["track_id"]
        label = track_labels.get(track_id, str(track_id))
        color = (93, 218, 255) if item["object_type"] == "face" else (109, 255, 136)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            annotated,
            label,
            (x1, max(24, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            color,
            2,
            cv2.LINE_AA,
        )
    preview_output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(preview_output), annotated)


def analyze_video(
    source_path: Path,
    config: JobConfig,
    device: str,
    emit: Callable[[dict], None],
) -> JobResult:
    if not config.analysis_output or not config.preview_output:
        raise ValueError("analysis_output and preview_output are required for analyze mode")

    models = ModelRegistry(device=device, blur_target=config.blur_target)
    models.load()
    tracker = create_plate_tracker(device)
    cap, info = open_video(source_path)

    track_labels: dict[int, str] = {}
    track_summaries: dict[int, dict] = {}
    frame_tracks: list[dict] = []
    counters = {"face": 0, "plate": 0}

    preview_frame = None
    preview_objects: list[dict] = []
    preview_count = -1

    start_time = time.time()
    frame_index = 0

    emit(
        {
            "job_id": config.job_id,
            "status": "analyzing",
            "current_file": str(source_path),
            "current_frame": 0,
            "total_frames": info.total_frames,
            "device": device,
            "requested_device": config.device,
            "worker_python": sys.executable,
            "message": "Detecting and tracking objects",
        }
    )

    detection_interval = config.detection_interval  # skip every N frames — tracker uses Kalman prediction between detections

    thumbs_dir: Path | None = None
    if config.thumbnails_dir:
        thumbs_dir = Path(config.thumbnails_dir).expanduser().resolve()
        thumbs_dir.mkdir(parents=True, exist_ok=True)

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            # Only run detection every N frames; DeepSort predicts positions on skipped frames.
            if frame_index % detection_interval == 0:
                raw_detections = models.detect_objects(frame)
            else:
                raw_detections = []

            tracker_inputs = []
            tracker_embeds = []
            for detection in raw_detections:
                x1, y1, x2, y2 = detection["box"]
                tracker_inputs.append(([x1, y1, max(1, x2 - x1), max(1, y2 - y1)], detection["confidence"], detection["object_type"]))
                tracker_embeds.append(detection_embedding(frame.shape, detection))

            tracks = update_tracker(tracker, tracker_inputs, frame, tracker_embeds)
            confirmed_objects: list[dict] = []

            for track in tracks:
                if not track.is_confirmed():
                    continue

                x1, y1, x2, y2 = map(int, track.to_ltrb())
                det_class = track.det_class
                if isinstance(det_class, np.ndarray):
                    if det_class.size == 0:
                        object_type = "face"
                    else:
                        object_type = str(det_class.reshape(-1)[0])
                elif det_class in (None, ""):
                    object_type = "face"
                else:
                    object_type = str(det_class)
                track_id = int(track.track_id)
                tracker_box = clamp_box_to_frame(frame, [x1, y1, x2, y2])
                best_face_detection = best_face_detection_for_track(raw_detections, tracker_box) if object_type == "face" else None
                best_plate_detection = best_plate_detection_for_track(raw_detections, tracker_box) if object_type == "plate" else None
                effective_box = tracker_box
                effective_confidence = 0.0
                if best_face_detection is not None:
                    effective_box = clamp_box_to_frame(frame, best_face_detection["box"])
                    effective_confidence = float(best_face_detection.get("confidence", 0.0))
                elif best_plate_detection is not None:
                    effective_box = clamp_box_to_frame(frame, best_plate_detection["box"])
                    effective_confidence = float(best_plate_detection.get("confidence", 0.0))

                if track_id not in track_labels:
                    counters[object_type] = counters.get(object_type, 0) + 1
                    prefix = "Person" if object_type == "face" else "Plate"
                    representative_box = effective_box
                    ocr_box = clamp_box_to_frame(frame, best_plate_detection["box"]) if best_plate_detection else representative_box
                    track_labels[track_id] = f"{prefix} {counters[object_type]}"
                    track_summaries[track_id] = {
                        "track_id": track_id,
                        "object_type": object_type,
                        "label": track_labels[track_id],
                        "first_seen_frame": frame_index,
                        "last_seen_frame": frame_index,
                        "frames_seen": 0,
                        "representative_box": representative_box,
                        "preview_path": save_track_thumbnail(frame, representative_box, thumbs_dir, track_id),
                        "ocr_preview_path": save_plate_ocr_crop(frame, ocr_box, thumbs_dir, track_id) if object_type == "plate" else None,
                        "ocr_box": ocr_box if object_type == "plate" else None,
                        "ocr_box_confidence": float(best_plate_detection["confidence"]) if best_plate_detection else 0.0,
                        "_representative_score": score_face_box(representative_box, effective_confidence) if object_type == "face" else 0.0,
                        "_face_embedding_sum": None,
                        "_face_embedding_count": 0,
                        "face_detection_frames": 0,
                        "face_confidence_sum": 0.0,
                        "face_best_confidence": 0.0,
                    }

                summary = track_summaries[track_id]
                summary["last_seen_frame"] = frame_index
                summary["frames_seen"] += 1

                current_box = effective_box

                if object_type == "face":
                    face_embedding = best_face_detection.get("embedding") if best_face_detection else None
                    if best_face_detection is not None:
                        summary["face_detection_frames"] = int(summary.get("face_detection_frames", 0)) + 1
                        summary["face_confidence_sum"] = float(summary.get("face_confidence_sum", 0.0)) + float(
                            best_face_detection.get("confidence", 0.0)
                        )
                        summary["face_best_confidence"] = max(
                            float(summary.get("face_best_confidence", 0.0)),
                            float(best_face_detection.get("confidence", 0.0)),
                        )
                    if face_embedding is not None:
                        embedding_array = np.asarray(face_embedding, dtype=np.float32)
                        if summary["_face_embedding_sum"] is None:
                            summary["_face_embedding_sum"] = embedding_array.copy()
                        else:
                            summary["_face_embedding_sum"] = np.asarray(summary["_face_embedding_sum"], dtype=np.float32) + embedding_array
                        summary["_face_embedding_count"] = int(summary.get("_face_embedding_count", 0)) + 1
                current_area = max(1, (current_box[2] - current_box[0]) * (current_box[3] - current_box[1]))
                current_score = score_face_box(current_box, effective_confidence) if object_type == "face" else float(current_area)
                if current_score > float(summary.get("_representative_score", 0.0)):
                    preview_path = save_track_thumbnail(frame, current_box, thumbs_dir, track_id)
                    summary["representative_box"] = current_box
                    if preview_path is not None:
                        summary["preview_path"] = preview_path
                    summary["_representative_score"] = current_score
                if object_type == "plate":
                    if best_plate_detection:
                        detected_box = clamp_box_to_frame(frame, best_plate_detection["box"])
                        detected_area = max(1, (detected_box[2] - detected_box[0]) * (detected_box[3] - detected_box[1]))
                        existing_ocr_box = summary.get("ocr_box") or current_box
                        existing_ocr_area = max(1, (existing_ocr_box[2] - existing_ocr_box[0]) * (existing_ocr_box[3] - existing_ocr_box[1]))
                        detected_confidence = float(best_plate_detection.get("confidence", 0.0))
                        existing_confidence = float(summary.get("ocr_box_confidence", 0.0))
                        if detected_confidence > existing_confidence + 0.05 or (
                            detected_confidence >= existing_confidence - 0.02 and detected_area > existing_ocr_area
                        ):
                            summary["ocr_box"] = detected_box
                            summary["ocr_box_confidence"] = detected_confidence
                            summary["ocr_preview_path"] = save_plate_ocr_crop(frame, detected_box, thumbs_dir, track_id)

                confirmed_objects.append(
                    {
                        "track_id": track_id,
                        "object_type": object_type,
                        "label": track_labels[track_id],
                        "box": current_box,
                    }
                )

            frame_tracks.append({"frame": frame_index, "objects": confirmed_objects})

            if len(confirmed_objects) > preview_count:
                preview_count = len(confirmed_objects)
                preview_frame = frame.copy()
                preview_objects = [dict(item) for item in confirmed_objects]

            if frame_index % 10 == 0 or frame_index == info.total_frames - 1:
                emit(
                    {
                        "job_id": config.job_id,
                        "status": "analyzing",
                        "current_file": str(source_path),
                        "current_frame": frame_index + 1,
                        "total_frames": info.total_frames,
                        "device": device,
                        "requested_device": config.device,
                        "worker_python": sys.executable,
                        "message": "Detecting and tracking objects",
                    }
                )

            frame_index += 1
    finally:
        cap.release()

    preview_output = Path(config.preview_output).expanduser().resolve()
    if preview_frame is None:
        preview_frame = np.zeros((max(1, info.height or 720), max(1, info.width or 1280), 3), dtype=np.uint8)
    tracks_payload, frame_tracks, preview_objects = keep_stable_tracks(track_summaries, frame_tracks, preview_objects)
    tracks_payload, frame_tracks, preview_objects = merge_face_tracks(tracks_payload, frame_tracks, preview_objects, device)
    tracks_payload, frame_tracks, preview_objects = verify_analysis_tracks(tracks_payload, frame_tracks, preview_objects)
    tracks_payload, frame_tracks, preview_objects = relabel_tracks(tracks_payload, frame_tracks, preview_objects)
    tracks_payload = sanitize_track_payloads(tracks_payload)
    final_track_labels = {int(track["track_id"]): str(track["label"]) for track in tracks_payload}
    write_preview(preview_frame, preview_objects, final_track_labels, preview_output)

    analysis_output = Path(config.analysis_output).expanduser().resolve()
    analysis_output.parent.mkdir(parents=True, exist_ok=True)
    analysis_payload = {
        "input_path": str(source_path),
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "total_frames": info.total_frames,
        "source_has_audio": info.has_audio,
        "tracks": tracks_payload,
        "frames": frame_tracks,
        "preview_tracks": [item["track_id"] for item in preview_objects],
        "preview_path": str(preview_output),
    }
    analysis_output.write_text(json.dumps(analysis_payload, separators=(",", ":")), encoding="utf-8")

    return JobResult(
        job_id=config.job_id,
        status="completed",
        outputs=[],
        elapsed_seconds=time.time() - start_time,
        device=device,
        requested_device=config.device,
        worker_python=sys.executable,
        source_has_audio=info.has_audio,
        analysis_path=str(analysis_output),
        preview_path=str(preview_output),
        tracks=tracks_payload,
        preview_tracks=analysis_payload["preview_tracks"],
    )


def render_detect_and_blur(
    source_path: Path,
    intermediate_path: Path,
    models: ModelRegistry,
    detection_interval: int,
    emit: Callable[[dict], None],
    event_base: dict,
) -> tuple[int, SourceMediaInfo]:
    cap, info = open_video(source_path)
    fourcc = cv2.VideoWriter_fourcc(*"XVID")
    writer = cv2.VideoWriter(str(intermediate_path), fourcc, info.fps, (info.width, info.height))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError(f"Could not open intermediate video writer: {intermediate_path}")
    frame_queue: queue.Queue = queue.Queue(maxsize=QUEUE_SIZE)
    stop_event = threading.Event()
    reader = threading.Thread(target=reader_thread, args=(cap, frame_queue, stop_event), daemon=True)
    reader.start()

    frame_count = 0
    last_faces: list[tuple[int, int, int, int]] = []
    last_plates: list[tuple[int, int, int, int]] = []

    try:
        while True:
            ret, frame = frame_queue.get()
            if not ret:
                break

            if frame_count % detection_interval == 0:
                detections = models.detect_objects(frame)
                last_faces = [tuple(item["box"]) for item in detections if item["object_type"] == "face"]
                last_plates = [tuple(item["box"]) for item in detections if item["object_type"] == "plate"]

            if models.blur_target in {"faces", "both"}:
                blur_regions(frame, last_faces)
            if models.blur_target in {"plates", "both"}:
                blur_regions(frame, last_plates)

            writer.write(frame)
            frame_count += 1

            if frame_count == 1 or frame_count % 30 == 0 or frame_count == info.total_frames:
                emit(
                    {
                        **event_base,
                        "status": "processing",
                        "current_frame": frame_count,
                        "total_frames": info.total_frames,
                        "message": "Blurring sensitive regions",
                    }
                )
    finally:
        stop_event.set()
        cap.release()
        writer.release()

    return frame_count, info


def should_blur_track(track_id: int, selected_ids: set[int], selection_mode: str) -> bool:
    if selection_mode == "keep_selected":
        return track_id not in selected_ids
    return track_id in selected_ids


def render_selective_blur(
    source_path: Path,
    intermediate_path: Path,
    analysis_path: Path,
    selected_track_ids: set[int],
    selection_mode: str,
    emit: Callable[[dict], None],
    event_base: dict,
) -> tuple[int, SourceMediaInfo]:
    analysis_payload = json.loads(analysis_path.read_text(encoding="utf-8"))
    frame_lookup = {int(item["frame"]): item["objects"] for item in analysis_payload["frames"]}

    cap, info = open_video(source_path)
    fourcc = cv2.VideoWriter_fourcc(*"XVID")
    writer = cv2.VideoWriter(str(intermediate_path), fourcc, info.fps, (info.width, info.height))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError(f"Could not open intermediate video writer: {intermediate_path}")
    frame_queue: queue.Queue = queue.Queue(maxsize=QUEUE_SIZE)
    stop_event = threading.Event()
    reader = threading.Thread(target=reader_thread, args=(cap, frame_queue, stop_event), daemon=True)
    reader.start()

    frame_index = 0

    try:
        while True:
            ret, frame = frame_queue.get()
            if not ret:
                break

            objects = frame_lookup.get(frame_index, [])
            boxes_to_blur = []
            for item in objects:
                track_id = int(item["track_id"])
                if should_blur_track(track_id, selected_track_ids, selection_mode):
                    boxes_to_blur.append(tuple(item["box"]))

            blur_regions(frame, boxes_to_blur)
            writer.write(frame)
            frame_index += 1

            if frame_index == 1 or frame_index % 30 == 0 or frame_index == info.total_frames:
                emit(
                    {
                        **event_base,
                        "status": "processing",
                        "current_frame": frame_index,
                        "total_frames": info.total_frames,
                        "message": "Applying selective blur from tracked IDs",
                    }
                )
    finally:
        stop_event.set()
        cap.release()
        writer.release()

    return frame_index, info


def process_file(
    source_path: Path,
    config: JobConfig,
    file_index: int,
    total_files: int,
    models: ModelRegistry | None,
    emit: Callable[[dict], None],
    device: str,
) -> dict:
    output_path = output_path_for(source_path, config.output_dir)
    if output_path.exists() and not config.overwrite:
        raise FileExistsError(f"Output already exists: {output_path}")

    event_base = {
        "job_id": config.job_id,
        "current_file": str(source_path),
        "files_completed": file_index,
        "files_total": total_files,
        "device": device,
        "requested_device": config.device,
        "worker_python": sys.executable,
    }
    emit({**event_base, "status": "preparing", "message": "Preparing media metadata"})

    started_at = time.time()
    intermediate_path = output_path.with_name(f".{output_path.stem}-{uuid.uuid4().hex}.avi")
    try:
        if config.analysis_path:
            frame_count, info = render_selective_blur(
                source_path=source_path,
                intermediate_path=intermediate_path,
                analysis_path=Path(config.analysis_path).expanduser().resolve(),
                selected_track_ids=set(config.selected_track_ids),
                selection_mode=config.selection_mode,
                emit=emit,
                event_base=event_base,
            )
        else:
            if models is None:
                raise RuntimeError("Model registry is required for class-based processing")
            frame_count, info = render_detect_and_blur(
                source_path=source_path,
                intermediate_path=intermediate_path,
                models=models,
                detection_interval=config.detection_interval,
                emit=emit,
                event_base=event_base,
            )

        emit({**event_base, "status": "muxing", "message": "Restoring audio and finalizing export"})
        audio_preserved = mux_with_audio(
            intermediate_path=intermediate_path,
            source_path=source_path,
            output_path=output_path,
            has_audio=info.has_audio and config.audio_mode == "preserve",
            export_quality=config.export_quality,
        )
    finally:
        try:
            intermediate_path.unlink(missing_ok=True)
        except OSError:
            pass

    return {
        "input_path": str(source_path),
        "output_path": str(output_path),
        "frame_count": frame_count,
        "total_frames": info.total_frames,
        "source_has_audio": info.has_audio,
        "audio_preserved": audio_preserved,
        "elapsed_seconds": time.time() - started_at,
    }


def process_job(config: JobConfig, emit: Callable[[dict], None] = emit_event) -> JobResult:
    started_at = time.time()
    source_files = discover_inputs(config.input_paths)
    resolved_device = resolve_device(config.device)
    validate_runtime_support(config.blur_target)

    if config.mode == "analyze":
        if len(source_files) != 1:
            raise ValueError("Analyze mode currently supports exactly one input video")
        return analyze_video(source_files[0], config, resolved_device, emit)

    models = None
    if not config.analysis_path:
        models = ModelRegistry(device=resolved_device, blur_target=config.blur_target)
        models.load()

    emit(
        {
            "job_id": config.job_id,
            "status": "queued",
            "files_total": len(source_files),
            "device": resolved_device,
            "requested_device": config.device,
            "worker_python": sys.executable,
            "message": "Job accepted",
        }
    )

    outputs: list[str] = []
    source_has_audio = False
    audio_preserved = True

    for index, source_path in enumerate(source_files):
        try:
            result = process_file(source_path, config, index, len(source_files), models, emit, resolved_device)
        except Exception as exc:
            return JobResult(
                job_id=config.job_id,
                status="failed",
                outputs=outputs,
                elapsed_seconds=time.time() - started_at,
                device=resolved_device,
                requested_device=config.device,
                worker_python=sys.executable,
                audio_preserved=audio_preserved,
                source_has_audio=source_has_audio,
                error=f"{exc}\n{traceback.format_exc()}",
            )

        outputs.append(result["output_path"])
        source_has_audio = source_has_audio or result["source_has_audio"]
        audio_preserved = audio_preserved and (not result["source_has_audio"] or result["audio_preserved"])
        emit(
            {
                "job_id": config.job_id,
                "status": "file_completed",
                "current_file": result["input_path"],
                "files_completed": index + 1,
                "files_total": len(source_files),
                "output_path": result["output_path"],
                "elapsed_seconds": result["elapsed_seconds"],
                "device": resolved_device,
                "requested_device": config.device,
                "worker_python": sys.executable,
                "audio_preserved": result["audio_preserved"],
                "source_has_audio": result["source_has_audio"],
                "message": "Finished processing file",
            }
        )

    return JobResult(
        job_id=config.job_id,
        status="completed",
        outputs=outputs,
        elapsed_seconds=time.time() - started_at,
        device=resolved_device,
        requested_device=config.device,
        worker_python=sys.executable,
        audio_preserved=audio_preserved,
        source_has_audio=source_has_audio,
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BlurItOut local worker")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--config", help="Path to a JSON config file")
    group.add_argument("--describe-stack", action="store_true", help="Print the configured CV model stack as JSON")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    global _EVENT_STREAM

    args = parse_args(argv or sys.argv[1:])
    if args.describe_stack:
        print(json.dumps(describe_model_stack()), flush=True)
        return 0
    _EVENT_STREAM = sys.stdout
    # Third-party CV libraries print initialization chatter to stdout. Electron
    # parses stdout as newline-delimited JSON, so route all non-event output to stderr.
    sys.stdout = sys.stderr
    try:
        config = load_config(args.config)
        result = process_job(config)
    except Exception as exc:
        emit_event(
            {
                "job_id": "unknown",
                "status": "failed",
                "outputs": [],
                "elapsed_seconds": 0.0,
                "device": "cpu",
                "requested_device": "cuda",
                "worker_python": sys.executable,
                "audio_preserved": False,
                "source_has_audio": False,
                "error": f"{exc}\n{traceback.format_exc()}",
            }
        )
        return 1

    emit_event(asdict(result))
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
