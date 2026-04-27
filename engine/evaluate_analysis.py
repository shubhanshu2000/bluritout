from __future__ import annotations

import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np

import worker


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize BlurItOut analysis outputs for regression checks.")
    parser.add_argument("analysis_paths", nargs="+", help="Path(s) to analysis.json files")
    parser.add_argument("--device", default="cuda", choices=["auto", "cuda", "cpu"], help="Device for face-embedding checks")
    parser.add_argument(
        "--duplicate-threshold",
        type=float,
        default=0.82,
        help="Cosine similarity threshold for likely duplicate face-track pairs",
    )
    parser.add_argument(
        "--large-face-area-ratio",
        type=float,
        default=0.2,
        help="Flag face tracks larger than this fraction of the frame as oversized",
    )
    return parser.parse_args()


def load_analysis(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def track_area_ratio(track: dict, frame_width: int, frame_height: int) -> float:
    x1, y1, x2, y2 = map(int, track["representative_box"])
    area = max(0, x2 - x1) * max(0, y2 - y1)
    return area / max(1.0, float(frame_width * frame_height))


def likely_duplicate_pairs(face_tracks: list[dict], device: str, threshold: float) -> list[dict]:
    embeddings: dict[int, np.ndarray] = {}
    for track in face_tracks:
        embedding = worker.compute_face_track_embedding(track, device)
        if embedding is not None:
            embeddings[int(track["track_id"])] = embedding

    duplicates: list[dict] = []
    for left_track, right_track in combinations(face_tracks, 2):
        left_id = int(left_track["track_id"])
        right_id = int(right_track["track_id"])
        left_embedding = embeddings.get(left_id)
        right_embedding = embeddings.get(right_id)
        if left_embedding is None or right_embedding is None:
            continue
        similarity = float(np.dot(left_embedding, right_embedding))
        if similarity < threshold:
            continue
        duplicates.append(
            {
                "left_track_id": left_id,
                "right_track_id": right_id,
                "similarity": round(similarity, 4),
                "left_label": left_track.get("label"),
                "right_label": right_track.get("label"),
            }
        )
    duplicates.sort(key=lambda item: item["similarity"], reverse=True)
    return duplicates


def summarize_analysis(path: Path, device: str, duplicate_threshold: float, large_face_area_ratio: float) -> dict:
    payload = load_analysis(path)
    width = int(payload.get("width") or 0)
    height = int(payload.get("height") or 0)
    tracks = payload.get("tracks", [])
    face_tracks = [track for track in tracks if track.get("object_type") == "face"]
    plate_tracks = [track for track in tracks if track.get("object_type") == "plate"]
    oversized_faces = [
        {
            "track_id": int(track["track_id"]),
            "label": track.get("label"),
            "area_ratio": round(track_area_ratio(track, width, height), 4),
        }
        for track in face_tracks
        if track_area_ratio(track, width, height) > large_face_area_ratio
    ]
    merged_groups = [track.get("merged_track_ids") for track in face_tracks if len(track.get("merged_track_ids") or []) > 1]
    missing_previews = [int(track["track_id"]) for track in tracks if not track.get("preview_path")]
    likely_duplicates = likely_duplicate_pairs(face_tracks, device, duplicate_threshold)

    return {
        "analysis_path": str(path),
        "input_path": payload.get("input_path"),
        "face_tracks": len(face_tracks),
        "plate_tracks": len(plate_tracks),
        "oversized_face_tracks": oversized_faces,
        "merged_face_groups": merged_groups,
        "missing_preview_tracks": missing_previews,
        "likely_duplicate_face_pairs": likely_duplicates[:20],
    }


def main() -> int:
    args = parse_args()
    device = worker.resolve_device(args.device)
    summaries = [
        summarize_analysis(Path(raw_path).expanduser().resolve(), device, args.duplicate_threshold, args.large_face_area_ratio)
        for raw_path in args.analysis_paths
    ]
    json.dump({"device": device, "summaries": summaries}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
