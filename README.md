# BlurItOut

BlurItOut is a local-first desktop app for blurring faces and license plates in video. It uses an Electron UI with a Python computer-vision worker so videos can be analyzed and exported on the user's machine.

## Status

This project is preparing for an open-source Windows release. The packaged worker and Windows ZIP build path are mostly validated, but the full packaged UI smoke test and full evaluation suite still need to pass before a public release.

## License

BlurItOut source code is licensed under AGPL-3.0-or-later. See LICENSE.

Third-party dependencies and model files have their own licenses. This matters for distribution:

- Ultralytics YOLO components are AGPL-3.0 unless you have a separate Ultralytics license.
- InsightFace code is MIT, but pretrained model packs may require separate permission for non-research or commercial use.
- `ffmpeg-static` is GPL-3.0-or-later in the current frontend dependency tree.
- PaddleOCR model/runtime components are Apache-2.0 based on their upstream project metadata.

See THIRD_PARTY_NOTICES.md before publishing binaries or model files.

## Main Runtime

- `fe/`: Electron + React desktop app
- `engine/`: Python worker for analysis, tracking, OCR, and export
- `web/`: separate landing page surface
- `be/`: backend stub, not the primary runtime today

## Development

```powershell
cd .\fe
npm install
npm run dev
```

## Windows Build

```powershell
cd .\fe
npm run dist:win
```

Use the smaller public beta profile for release artifacts:

```powershell
cd .\fe
npm run dist:win:release
```

Current Windows distribution target is ZIP, not NSIS portable EXE. The release profile avoids bundling PyTorch/CUDA, PaddleOCR/Paddle, facenet-pytorch, and Ultralytics; it uses InsightFace ONNX models for faces, the ONNX plate detector backend for plates, and lightweight tracker embeddings.

## Multi-OS Release Build

GitHub Actions can build and publish beta desktop artifacts for all supported platforms from a release tag:

```powershell
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

The `Desktop Release` workflow uses the smaller release worker profile and publishes these stable asset names to the GitHub Release:

- `BlurItOut-windows-x64.zip`
- `BlurItOut-macos-arm64.dmg`
- `BlurItOut-linux-x64.AppImage`

The website download buttons use GitHub's `releases/latest/download` URLs, so the links keep pointing to the latest published release assets. The default repository is `shubhanshu2000/blurItOut`; if the repository changes, set `VITE_GITHUB_REPOSITORY=owner/repo` when building the website.

The release used by the website must be a normal published GitHub Release, not a draft or prerelease. GitHub's `releases/latest/download` redirect does not target draft releases and can skip prereleases.

macOS builds are currently unsigned beta DMGs. Users may see Gatekeeper warnings until Apple code signing and notarization are configured.

## Release Checklist

Use RELEASE_TASKS.md as the source of truth for ship readiness.
