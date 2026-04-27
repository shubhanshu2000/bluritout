# Third-Party Notices

This file is a practical release checklist, not legal advice. Verify licenses before publishing source archives, binaries, model files, or packaged app builds.

## Project License

BlurItOut project code is AGPL-3.0-or-later.

## High-Risk Or Release-Critical Items

### Ultralytics / YOLO

- Current use: plate detection stack can use Ultralytics YOLO.
- Current package: `ultralytics==8.4.20`.
- License risk: AGPL-3.0 unless you have a separate Ultralytics license.
- Open-source impact: if this stack remains included, publish BlurItOut under AGPL-compatible terms and provide source to recipients.
- Closed-source impact: do not ship this stack in a proprietary app without a commercial license or replacement.

### InsightFace

- Current use: standard face stack can use InsightFace `buffalo_l`.
- Current package: `insightface==0.7.3`.
- License risk: InsightFace code is MIT, but upstream states pretrained model packs are restricted separately and may require licensing for non-research or commercial usage.
- Release action: do not assume bundling pretrained InsightFace models is safe just because BlurItOut source is AGPL. Verify the model pack license or remove bundled model weights from public releases.

### ffmpeg-static

- Current use: dev/package ffmpeg binary source.
- Current frontend package: `ffmpeg-static@5.3.0`.
- License shown by package metadata: `GPL-3.0-or-later`.
- Release action: if bundling this binary, comply with GPL requirements and include appropriate notices/source-offer obligations. If you want a less restrictive path later, replace it with a verified LGPL FFmpeg build and document the build configuration.

## Lower-Risk But Still Notice-Required Items

### PaddleOCR / PaddlePaddle

- Current use: OCR verification for plate crops.
- Current packages include `paddleocr==3.4.0` and `paddlepaddle==3.2.0`.
- Upstream project metadata indicates Apache-2.0.
- Release action: include Apache-2.0 notices and preserve upstream model README/license metadata when bundling model caches.

### OpenCV

- Current use: video/image processing and Haar cascade fallback.
- Release action: preserve OpenCV license notices for bundled data files such as `haarcascade_frontalface_default.xml`.

### Electron / React / Node Packages

- Current use: desktop shell and UI.
- Release action: generate a dependency notice report before public release and include it in the source/binary distribution.

## Do Not Publish Until Checked

- Any large model file under `engine/models/`.
- Any `*.pt`, `*.onnx`, `*.pth`, or downloaded model cache file.
- Any packaged app binary that bundles the above model files.
- Any test video that you do not own or have permission to redistribute.

## Recommended Public Release Position

For the first public open-source release:

- publish the source under AGPL-3.0-or-later
- include LICENSE, README.md, THIRD_PARTY_NOTICES.md, and RELEASE_TASKS.md
- do not claim "commercial-safe" for the standard model stack
- do not publish third-party model weights unless their redistribution terms are verified
- clearly label the app as local-first privacy tooling with model-license caveats
