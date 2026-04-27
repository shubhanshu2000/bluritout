from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import evaluate_analysis
import worker


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run BlurItOut analysis on a fixed suite of videos and summarize the results.")
    parser.add_argument(
        "--manifest",
        default=str(Path(__file__).resolve().parent / "eval_suite.json"),
        help="Path to the eval-suite manifest JSON",
    )
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "tmp" / "eval-suite"),
        help="Directory where per-video analysis outputs and the summary report will be written",
    )
    parser.add_argument("--device", default="cuda", choices=["auto", "cuda", "cpu"], help="Worker device")
    parser.add_argument("--blur-target", default="both", choices=["faces", "plates", "both"], help="Worker blur target")
    parser.add_argument("--detection-interval", type=int, default=1, help="Analysis detection interval")
    parser.add_argument("--limit", type=int, default=0, help="Limit the number of manifest entries to run")
    parser.add_argument("--overwrite", action="store_true", help="Delete any existing per-video output before running")
    parser.add_argument(
        "--duplicate-threshold",
        type=float,
        default=0.82,
        help="Cosine similarity threshold used by the summary report for likely duplicate face tracks",
    )
    return parser.parse_args()


def load_manifest(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    videos = payload.get("videos")
    if not isinstance(videos, list) or not videos:
        raise ValueError("Manifest must contain a non-empty 'videos' array")
    return videos


def resolve_input_path(manifest_path: Path, raw_path: str) -> Path:
    return (manifest_path.parent / raw_path).expanduser().resolve()


def ensure_clean_dir(path: Path, overwrite: bool) -> None:
    if path.exists() and overwrite:
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def run_entry(entry: dict, manifest_path: Path, output_dir: Path, device: str, blur_target: str, detection_interval: int, duplicate_threshold: float, overwrite: bool) -> dict:
    entry_id = str(entry.get("id") or Path(str(entry["input_path"])).stem)
    input_path = resolve_input_path(manifest_path, str(entry["input_path"]))
    if not input_path.exists():
        raise FileNotFoundError(f"Eval-suite input does not exist: {input_path}")

    entry_dir = output_dir / entry_id
    ensure_clean_dir(entry_dir, overwrite)
    thumbs_dir = entry_dir / "thumbs"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    analysis_path = entry_dir / "analysis.json"
    preview_path = entry_dir / "preview.jpg"
    config = worker.JobConfig(
        job_id=f"eval-{entry_id}",
        input_paths=[str(input_path)],
        blur_target=blur_target,
        device=device,
        detection_interval=max(1, detection_interval),
        mode="analyze",
        analysis_output=str(analysis_path),
        preview_output=str(preview_path),
        thumbnails_dir=str(thumbs_dir),
    )

    start_time = time.time()
    result = worker.analyze_video(input_path, config, worker.resolve_device(device), lambda _event: None)
    elapsed_seconds = round(time.time() - start_time, 2)
    summary = evaluate_analysis.summarize_analysis(
        analysis_path,
        result.device,
        duplicate_threshold=duplicate_threshold,
        large_face_area_ratio=0.2,
    )
    summary.update(
        {
            "id": entry_id,
            "notes": entry.get("notes"),
            "elapsed_seconds": elapsed_seconds,
            "resolved_device": result.device,
            "worker_python": result.worker_python,
        }
    )
    return summary


def build_suite_report(
    entries: list[dict],
    manifest_path: Path,
    output_dir: Path,
    device: str,
    blur_target: str,
    detection_interval: int,
    duplicate_threshold: float,
    overwrite: bool,
    limit: int,
) -> dict:
    selected_entries = entries[:limit] if limit > 0 else entries
    summaries = [
        run_entry(
            entry=entry,
            manifest_path=manifest_path,
            output_dir=output_dir,
            device=device,
            blur_target=blur_target,
            detection_interval=detection_interval,
            duplicate_threshold=duplicate_threshold,
            overwrite=overwrite,
        )
        for entry in selected_entries
    ]
    return {
        "generated_at_epoch": int(time.time()),
        "manifest_path": str(manifest_path),
        "output_dir": str(output_dir),
        "requested_device": device,
        "blur_target": blur_target,
        "detection_interval": detection_interval,
        "duplicate_threshold": duplicate_threshold,
        "summaries": summaries,
    }


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    entries = load_manifest(manifest_path)
    report = build_suite_report(
        entries=entries,
        manifest_path=manifest_path,
        output_dir=output_dir,
        device=args.device,
        blur_target=args.blur_target,
        detection_interval=args.detection_interval,
        duplicate_threshold=args.duplicate_threshold,
        overwrite=args.overwrite,
        limit=args.limit,
    )
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
