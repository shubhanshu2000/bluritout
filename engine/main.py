from __future__ import annotations

from pathlib import Path

from worker import JobConfig, process_job


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    sample_path = repo_root / "test_videos" / "sample.mp4"
    output_dir = repo_root / "test_videos"

    config = JobConfig(
        job_id="sample-run",
        input_paths=[str(sample_path)],
        output_dir=str(output_dir),
        blur_target="both",
        device="cuda",
        detection_interval=3,
        export_quality="near_source",
        audio_mode="preserve",
        overwrite=True,
    )
    result = process_job(config)
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
