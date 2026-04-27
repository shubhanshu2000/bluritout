from pathlib import Path

import numpy as np

from engine.worker import build_ffmpeg_command, blur_regions, discover_inputs, output_path_for, resolve_device


def test_discover_inputs_includes_supported_files(tmp_path: Path):
    file_path = tmp_path / "clip.mp4"
    file_path.write_bytes(b"")
    ignored_path = tmp_path / "notes.txt"
    ignored_path.write_text("ignore", encoding="utf-8")

    discovered = discover_inputs([str(tmp_path)])

    assert discovered == [file_path]


def test_output_path_for_uses_default_suffix(tmp_path: Path):
    source = tmp_path / "video.mov"
    source.write_bytes(b"")

    output = output_path_for(source, None)

    assert output.name == "video_blurred.mp4"
    assert output.parent == tmp_path


def test_resolve_device_preserves_cpu_mode():
    assert resolve_device("cpu") == "cpu"


def test_build_ffmpeg_command_includes_audio_mapping(tmp_path: Path):
    intermediate = tmp_path / "intermediate.avi"
    source = tmp_path / "source.mp4"
    output = tmp_path / "output.mp4"

    command = build_ffmpeg_command(intermediate, source, output, True, "near_source")

    assert command[:4] == ["ffmpeg", "-y", "-i", str(intermediate)]
    assert "1:a:0?" in command
    assert "libx264" in command
    assert str(output) == command[-1]


def test_blur_regions_expands_and_strongly_anonymizes_box():
    yy, xx = np.indices((120, 120), dtype=np.uint8)
    frame = np.dstack((xx, yy, (xx * 3 + yy * 2).astype(np.uint8))).copy()
    before = frame.copy()

    blur_regions(frame, [(40, 40, 80, 80)])

    assert np.any(frame[50:70, 50:70] != before[50:70, 50:70])
    assert np.any(frame[34:39, 50:70] != before[34:39, 50:70])
    assert np.array_equal(frame[0:20, 0:20], before[0:20, 0:20])
