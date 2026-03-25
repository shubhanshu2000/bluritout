from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import warnings
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

import cv2
from PIL import Image

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

warnings.filterwarnings(
    "ignore",
    message=r".*You are using `torch\.load` with `weights_only=False`.*",
    category=FutureWarning,
)


DEFAULT_DETECT_EVERY_N = 3
DEFAULT_BLUR_KERNEL = (25, 25)
DEFAULT_OUTPUT_SUFFIX = "_blurred"
QUEUE_SIZE = 32
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}


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
    audio_preserved: bool = False
    source_has_audio: bool = False
    error: str | None = None


def emit_event(event: dict) -> None:
    print(json.dumps(event), flush=True)


def load_config(path: str) -> JobConfig:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
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
        self.face_detector = None
        self.plate_model = None

    def load(self) -> None:
        if self.blur_target in {"faces", "both"}:
            from facenet_pytorch import MTCNN

            self.face_detector = MTCNN(keep_all=True, device=self.device)
        if self.blur_target in {"plates", "both"}:
            from ultralytics import YOLO

            model_path = Path(__file__).resolve().parent / "yolov8n-license-plate.pt"
            self.plate_model = YOLO(str(model_path))
            self.plate_model.to(self.device)
            if self.device == "cuda" and torch is not None:
                dummy = torch.zeros(1, 3, 640, 640, device=self.device)
                self.plate_model(dummy, verbose=False)

    def detect_faces(self, frame) -> list[tuple[int, int, int, int]]:
        if self.face_detector is None:
            return []
        pil_image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        boxes, _ = self.face_detector.detect(pil_image)
        if boxes is None:
            return []
        return [(max(0, int(box[0])), max(0, int(box[1])), int(box[2]), int(box[3])) for box in boxes]

    def detect_plates(self, frame) -> list[tuple[int, int, int, int]]:
        if self.plate_model is None:
            return []
        results = self.plate_model(frame, verbose=False, imgsz=640, half=self.device == "cuda")
        boxes: list[tuple[int, int, int, int]] = []
        for result in results:
            for box in result.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                boxes.append((x1, y1, x2, y2))
        return boxes


def reader_thread(cap: cv2.VideoCapture, frame_queue: queue.Queue) -> None:
    while True:
        ret, frame = cap.read()
        frame_queue.put((ret, frame))
        if not ret:
            break


def blur_regions(frame, boxes: Iterable[tuple[int, int, int, int]]) -> None:
    for x1, y1, x2, y2 in boxes:
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
        region = frame[y1:y2, x1:x2]
        if region.size > 0:
            frame[y1:y2, x1:x2] = cv2.GaussianBlur(region, DEFAULT_BLUR_KERNEL, 0)


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


def render_intermediate(
    source_path: Path,
    intermediate_path: Path,
    models: ModelRegistry,
    detection_interval: int,
    emit: Callable[[dict], None],
    event_base: dict,
) -> tuple[int, SourceMediaInfo]:
    cap, info = open_video(source_path)
    fourcc = cv2.VideoWriter_fourcc(*"MJPG")
    writer = cv2.VideoWriter(str(intermediate_path), fourcc, info.fps, (info.width, info.height))
    frame_queue: queue.Queue = queue.Queue(maxsize=QUEUE_SIZE)
    reader = threading.Thread(target=reader_thread, args=(cap, frame_queue), daemon=True)
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
                if models.blur_target in {"faces", "both"}:
                    last_faces = models.detect_faces(frame)
                if models.blur_target in {"plates", "both"}:
                    last_plates = models.detect_plates(frame)

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
        cap.release()
        writer.release()

    return frame_count, info


def process_file(
    source_path: Path,
    config: JobConfig,
    file_index: int,
    total_files: int,
    models: ModelRegistry,
    emit: Callable[[dict], None],
) -> dict:
    output_path = output_path_for(source_path, config.output_dir)
    if output_path.exists() and not config.overwrite:
        raise FileExistsError(f"Output already exists: {output_path}")

    event_base = {
        "job_id": config.job_id,
        "current_file": str(source_path),
        "files_completed": file_index,
        "files_total": total_files,
        "device": models.device,
    }
    emit({**event_base, "status": "preparing", "message": "Preparing media metadata"})

    started_at = time.time()
    with tempfile.TemporaryDirectory(prefix="bluritout-") as temp_dir:
        intermediate_path = Path(temp_dir) / f"{source_path.stem}_intermediate.avi"
        frame_count, info = render_intermediate(
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
    models = ModelRegistry(device=resolved_device, blur_target=config.blur_target)
    models.load()

    emit(
        {
            "job_id": config.job_id,
            "status": "queued",
            "files_total": len(source_files),
            "device": resolved_device,
            "requested_device": config.device,
            "message": "Job accepted",
        }
    )

    outputs: list[str] = []
    source_has_audio = False
    audio_preserved = True

    for index, source_path in enumerate(source_files):
        try:
            result = process_file(source_path, config, index, len(source_files), models, emit)
        except Exception as exc:
            return JobResult(
                job_id=config.job_id,
                status="failed",
                outputs=outputs,
                elapsed_seconds=time.time() - started_at,
                device=resolved_device,
                requested_device=config.device,
                audio_preserved=audio_preserved,
                source_has_audio=source_has_audio,
                error=str(exc),
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
        audio_preserved=audio_preserved,
        source_has_audio=source_has_audio,
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BlurItOut local worker")
    parser.add_argument("--config", required=True, help="Path to a JSON config file")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
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
                "audio_preserved": False,
                "source_has_audio": False,
                "error": str(exc),
            }
        )
        return 1

    emit_event(asdict(result))
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
