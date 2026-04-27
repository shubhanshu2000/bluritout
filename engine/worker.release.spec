# -*- mode: python ; coding: utf-8 -*-
"""
Smaller PyInstaller spec for public beta release builds.

This profile intentionally avoids PyTorch, PaddleOCR/Paddle, facenet-pytorch,
and Ultralytics. The worker uses InsightFace ONNX models for faces, the ONNX
plate detector backend for plates, and lightweight tracker embeddings.
"""

import os
from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

engine_dir = os.path.abspath(SPECPATH)


def _filter_datas(datas, excludes):
    result = []
    for src, dst in datas:
        src_norm = src.replace("\\", "/").lower()
        dst_norm = dst.replace("\\", "/").lower()
        if not any(exc in src_norm or exc in dst_norm for exc in excludes):
            result.append((src, dst))
    return result


def _filter_binaries(binaries, excludes):
    result = []
    for item in binaries:
        src, dst = item[:2]
        src_norm = src.replace("\\", "/").lower()
        dst_norm = dst.replace("\\", "/").lower()
        if any(exc in src_norm or exc in dst_norm for exc in excludes):
            continue
        result.append(item)
    return result


def _copy_metadata_optional(package_name):
    try:
        return copy_metadata(package_name)
    except Exception:
        return []


onnxruntime_datas, onnxruntime_binaries, onnxruntime_hiddenimports = collect_all("onnxruntime")
onnxruntime_datas = _filter_datas(
    onnxruntime_datas,
    ["providers_cuda", "providers_tensorrt", "cublas", "cudart", "cudnn", "cufft", "cufftw", "curand", "cusolver", "cusparse"],
)
onnxruntime_binaries = _filter_binaries(
    onnxruntime_binaries,
    ["providers_cuda", "providers_tensorrt", "cublas", "cudart", "cudnn", "cufft", "cufftw", "curand", "cusolver", "cusparse", "torch/lib"],
)
insightface_datas, insightface_binaries, insightface_hiddenimports = collect_all("insightface")
matplotlib_datas, matplotlib_binaries, matplotlib_hiddenimports = collect_all("matplotlib")
skimage_datas, skimage_binaries, skimage_hiddenimports = collect_all("skimage")
sklearn_datas, sklearn_binaries, sklearn_hiddenimports = collect_all("sklearn")
deep_sort_datas, deep_sort_binaries, deep_sort_hiddenimports = collect_all("deep_sort_realtime")
cv2_datas, cv2_binaries, cv2_hiddenimports = collect_all("cv2")
PIL_datas, PIL_binaries, PIL_hiddenimports = collect_all("PIL")
numpy_datas, numpy_binaries, numpy_hiddenimports = collect_all("numpy")
scipy_datas, scipy_binaries, scipy_hiddenimports = collect_all("scipy")

# The release tracker passes embeddings explicitly, so the built-in PyTorch
# MobileNet embedder and its weights are not required.
deep_sort_datas = _filter_datas(deep_sort_datas, ["deep_sort_realtime/embedder"])

extra_model_datas = []
insightface_model_dir = os.path.join(engine_dir, "models", "insightface-cache", "models", "buffalo_l")
for model_file in ("det_10g.onnx", "w600k_r50.onnx"):
    model_path = os.path.join(insightface_model_dir, model_file)
    if os.path.exists(model_path):
        extra_model_datas.append((model_path, "models/insightface-cache/models/buffalo_l"))

cascade_path = os.path.join(engine_dir, "models", "haarcascade_frontalface_default.xml")
if os.path.exists(cascade_path):
    extra_model_datas.append((cascade_path, "models"))

optional_onnx_model = os.path.join(engine_dir, "yolov8n-license-plate.onnx")
if os.path.exists(optional_onnx_model):
    extra_model_datas.append((optional_onnx_model, "."))

a = Analysis(
    [os.path.join(engine_dir, "worker.py")],
    pathex=[engine_dir],
    binaries=(
        onnxruntime_binaries
        + insightface_binaries
        + matplotlib_binaries
        + skimage_binaries
        + sklearn_binaries
        + deep_sort_binaries
        + cv2_binaries
        + PIL_binaries
        + numpy_binaries
        + scipy_binaries
    ),
    datas=(
        extra_model_datas
        + onnxruntime_datas
        + insightface_datas
        + matplotlib_datas
        + skimage_datas
        + sklearn_datas
        + deep_sort_datas
        + cv2_datas
        + PIL_datas
        + numpy_datas
        + scipy_datas
        + _copy_metadata_optional("onnxruntime")
        + _copy_metadata_optional("insightface")
        + _copy_metadata_optional("matplotlib")
        + _copy_metadata_optional("scikit-image")
        + _copy_metadata_optional("scikit-learn")
        + _copy_metadata_optional("deep-sort-realtime")
        + _copy_metadata_optional("opencv-python-headless")
        + _copy_metadata_optional("opencv-python")
    ),
    hiddenimports=(
        [
            "deep_sort_realtime",
            "deep_sort_realtime.deepsort_tracker",
            "onnxruntime",
            "insightface",
            "insightface.app",
            "insightface.model_zoo",
            "matplotlib",
            "skimage",
            "skimage.transform",
            "sklearn",
            "cv2",
            "PIL",
            "PIL.Image",
            "numpy",
            "scipy",
            "scipy.spatial",
            "scipy.linalg",
        ]
        + onnxruntime_hiddenimports
        + insightface_hiddenimports
        + matplotlib_hiddenimports
        + skimage_hiddenimports
        + sklearn_hiddenimports
        + deep_sort_hiddenimports
        + cv2_hiddenimports
        + PIL_hiddenimports
        + numpy_hiddenimports
        + scipy_hiddenimports
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "facenet_pytorch",
        "paddle",
        "paddleocr",
        "paddlex",
        "polars",
        "tkinter",
        "torch",
        "torchaudio",
        "torchvision",
        "ultralytics",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    _filter_binaries(
        a.binaries,
        [
            "torch/lib",
            "providers_cuda",
            "providers_tensorrt",
            "cublas",
            "cudart",
            "cudnn",
            "cufft",
            "cufftw",
            "curand",
            "cusolver",
            "cusparse",
        ],
    ),
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="worker",
)
