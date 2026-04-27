# Release Tasks

Execution order matters. Finish these in order and re-run validation after each material change.

## 1. Packaging

- [x] Run `npm run dist:win` in `fe/`
- [x] Fix all PyInstaller worker build failures
- [x] Fix all `electron-builder` packaging failures
- [x] Confirm the final Windows ZIP artifact is produced successfully

## 2. Packaged Runtime Validation

- [x] Launch the packaged Windows app outside dev mode
- [x] Confirm the packaged worker does not depend on repo-local model paths
- [x] Confirm the packaged app can spawn the bundled worker
- [x] Confirm ffmpeg and ffprobe resolve from bundled resources
- [x] Confirm logs, cache, and analysis files write under `userData`

## 3. Runtime Device Validation

- [x] Confirm packaged worker uses CUDA when available
- [x] Confirm packaged worker runs correctly on CPU mode
- [x] Confirm the UI runtime status probe reports the configured worker stack

## 4. Analysis Output Reliability

- [x] Fix missing preview generation for `deepranjanvlog.mp4` track `484`
- [x] Re-run a release regression subset after the preview fix
- [x] Confirm no valid stable tracks are missing previews in the release subset
- [ ] Re-run the full evaluation suite after the preview fix

## 5. Face Quality

- [ ] Investigate why `sample.mp4` still produces `254` face tracks
- [ ] Separate false face detections from identity fragmentation
- [ ] Reduce noisy face tracks without reintroducing oversized face artifacts
- [ ] Re-run the evaluation suite and compare with the current baseline

## 6. Plate Quality

- [x] Validate packaged worker reaches `paddleocr` and `OCR unconfirmed` on a real plate track
- [ ] Validate `paddleocr` and `OCR unconfirmed` states in the Electron UI
- [ ] Confirm plausible plates remain selectable in the app
- [ ] Confirm obvious false plate tracks are reduced enough for release
- [ ] If needed, improve plate detector quality instead of making OCR stricter

## 7. Full Desktop Flow Smoke Test

- [ ] Select files and folders
- [ ] Run analysis on a selected video
- [ ] Select tracks and start processing
- [ ] Cancel active work
- [ ] Open produced output file/folder
- [ ] Repeat on at least one long video

## 8. Release UX

- [x] Remove frontend lint blockers that prevented clean targeted UI validation
- [x] Make worker/setup/runtime failures readable and actionable for model-policy support states
- [x] Keep worker stdout JSON-only so third-party model logs cannot break Electron IPC parsing
- [ ] Remove or reduce dev-only messages visible to end users
- [ ] Confirm the app does not silently fail on common user errors

## 9. Logs And Cleanup

- [x] Confirm packaged worker stderr is separated from JSON stdout
- [x] Add log cleanup or rotation for `userData/logs`
- [x] Confirm startup pruning prevents unbounded worker-log growth

## 10. Final Regression Check

- [x] Run `engine/run_eval_suite.py --limit 1` on the fixed suite
- [ ] Run `engine/run_eval_suite.py` on the full fixed suite
- [ ] Compare the output with `tmp/eval-suite-full/report.json`
- [ ] Do not ship if track quality, previews, or stability regress materially

## 11. Release Branch Cleanup

- [ ] Separate unrelated local changes from release-critical changes
- [ ] Make the release worktree understandable and reviewable
- [ ] Confirm third-party model files and sample videos are legally redistributable before committing or publishing them
- [ ] Generate final third-party dependency notices for the shipped source/binary package
- [ ] Update `context/CURRENT_STATE.md` when the remaining blockers are cleared

## 12. Ship

- [x] Build the final Windows ZIP artifact
- [x] Run packaged-worker analysis/export smoke tests
- [x] Add initial AGPL open-source license metadata
- [ ] Run one last packaged-app UI smoke test
- [ ] Tag or publish only after packaged validation passes

## Current Ship Blockers

- full packaged-app UI flow still needs one manual smoke pass
- full evaluation suite has not been rerun because the long samples take much longer
- CV quality is still noisy on harder videos, especially `sample.mp4`
- Windows distribution is now ZIP, not portable EXE, because NSIS portable fails on the multi-GB CUDA bundle
- the app is now intended for AGPL open-source distribution, but third-party model/binary redistribution still needs final review before publishing
- commercial-safe mode is functional but not product-quality for plates unless a separately licensed ONNX plate model is supplied
