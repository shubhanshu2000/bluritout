# BlurItOut Engine

## Evaluation Workflow

Use the engine evaluation tools before adopting CV changes.

### 1. Compare existing analysis outputs

```powershell
& '.\engine\.venv\Scripts\python.exe' '.\engine\evaluate_analysis.py' `
  '.\tmp\face-accuracy-pass\analysis.json' `
  '.\tmp\scrfd-face-check\analysis.json' `
  --device cuda
```

This reports:
- `face_tracks`
- `plate_tracks`
- `oversized_face_tracks`
- `merged_face_groups`
- `missing_preview_tracks`
- `likely_duplicate_face_pairs`

### 2. Run the fixed evaluation suite

```powershell
& '.\engine\.venv\Scripts\python.exe' '.\engine\run_eval_suite.py' `
  --device cuda `
  --overwrite
```

Default suite manifest:
- [eval_suite.json](C:\Users\Shubhanshu\Desktop\code\psp\paisa\blurItOut\engine\eval_suite.json)

Default output:
- `tmp/eval-suite/report.json`

### 3. Add your real problem videos

Edit `engine/eval_suite.json` and add more entries:

```json
{
  "id": "my-problem-video",
  "input_path": "../test_videos/my-problem-video.mp4",
  "notes": "Faces split across angle changes"
}
```

For best results, keep a small fixed set of videos that represent:
- duplicate faces
- missed faces
- false faces
- false plates
- hard low-resolution plates

## Plate Detector Swap Contract

The worker now supports multiple plate-detector backends through environment variables.

### Current knobs

- `BLURITOUT_PLATE_PROVIDER`
  - `auto`
  - `ultralytics_yolov8`
  - `onnx_yolo`
  - `disabled`
- `BLURITOUT_PLATE_MODEL_PATH`
  - absolute path to the model file to load

### Current behavior

- `auto` resolves by model file extension:
  - `.pt` / `.pth` -> `ultralytics_yolov8`
  - `.onnx` -> `onnx_yolo`
- if no model path override is supplied, the worker uses:
  - `engine/yolov8n-license-plate.pt`

### Important note

Changing the runtime backend does **not** make a model commercially safe.

- `onnx_yolo` is only a generic runtime path
- the checkpoint license and dataset license still matter

### Practical migration path

1. obtain a commercially acceptable plate detector checkpoint
2. export it to ONNX if needed
3. point `BLURITOUT_PLATE_MODEL_PATH` at that file
4. set `BLURITOUT_PLATE_PROVIDER=auto`
5. run `engine/run_eval_suite.py` before adopting it

## Model Policy

The worker also supports a higher-level policy switch:

- `BLURITOUT_MODEL_POLICY`
  - `standard`
  - `commercial_safe`

### Current behavior

- `standard`
  - current repo-default behavior
  - face auto -> InsightFace
  - plate auto -> bundled Ultralytics `.pt` model

- `commercial_safe`
  - avoids built-in known-risk defaults
  - face auto -> OpenCV Haar cascade
  - plate auto -> `disabled` unless you provide a model override
  - if `BLURITOUT_PLATE_MODEL_PATH` points to `.onnx`, auto resolves to `onnx_yolo`

### Important note

`commercial_safe` means:
- the repo will stop silently choosing the known risky built-ins
- it does **not** certify that an externally supplied model is commercially safe
