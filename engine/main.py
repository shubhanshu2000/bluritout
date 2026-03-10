import cv2
import os
import time
import threading
import queue
import torch
from ultralytics import YOLO
from facenet_pytorch import MTCNN
from PIL import Image

VIDEO_PATH = os.path.join("..", "test_videos", "sample.mp4")
OUTPUT_PATH = os.path.join("..", "test_videos", "output_yolo.mp4")

# ── Models
face_detector = MTCNN(keep_all=True, device="cuda")
plate_model = YOLO("yolov8n-license-plate.pt")
plate_model.to("cuda")

# ── Warm up plate model
dummy = torch.zeros(1, 3, 640, 640, device="cuda")
plate_model(dummy, verbose=False)

DETECT_EVERY_N = 3
FACE_INFER_SIZE = 640  # MTCNN needs higher res to catch small faces
PLATE_INFER_SIZE = 640  # plates are small, keep at 640
BLUR_KERNEL = (25, 25)
QUEUE_SIZE = 32


def reader_thread(cap, frame_queue):
    while True:
        ret, frame = cap.read()
        frame_queue.put((ret, frame))
        if not ret:
            break


def blur_regions(frame, boxes):
    """Apply Gaussian blur to all bounding boxes on a frame."""
    for x1, y1, x2, y2 in boxes:
        # Clamp to frame bounds to avoid index errors
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
        region = frame[y1:y2, x1:x2]
        if region.size > 0:
            frame[y1:y2, x1:x2] = cv2.GaussianBlur(region, BLUR_KERNEL, 0)
    return frame


def detect_faces(frame):
    """Returns list of (x1,y1,x2,y2) for all detected faces."""
    # MTCNN expects PIL RGB image
    pil_img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    boxes, _ = face_detector.detect(pil_img)
    if boxes is None:
        return []
    return [(max(0, int(b[0])), max(0, int(b[1])), int(b[2]), int(b[3])) for b in boxes]


def detect_plates(frame):
    """Returns list of (x1,y1,x2,y2) for all detected license plates."""
    results = plate_model(frame, verbose=False, imgsz=PLATE_INFER_SIZE, half=True)
    boxes = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            boxes.append((x1, y1, x2, y2))
    return boxes


def benchmark(path, output_path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print("Error: Could not open video.")
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    frame_queue = queue.Queue(maxsize=QUEUE_SIZE)
    t = threading.Thread(target=reader_thread, args=(cap, frame_queue), daemon=True)
    t.start()

    print("Starting benchmark  (faces + license plates)...")
    start_time = time.time()
    frame_count = 0
    last_faces = []  # cached between detection frames
    last_plates = []  # cached between detection frames

    while True:
        ret, frame = frame_queue.get()
        if not ret:
            break

        if frame_count % DETECT_EVERY_N == 0:
            last_faces = detect_faces(frame)
            last_plates = detect_plates(frame)

        frame = blur_regions(frame, last_faces)
        frame = blur_regions(frame, last_plates)

        out.write(frame)
        frame_count += 1

        if frame_count % 500 == 0:
            elapsed_so_far = time.time() - start_time
            live_fps = frame_count / elapsed_so_far
            print(
                f"  {frame_count} / {total_frames} frames  |  {live_fps:.1f} FPS"
                f"  |  faces={len(last_faces)}  plates={len(last_plates)}"
            )

    elapsed = time.time() - start_time
    processing_fps = frame_count / elapsed if elapsed > 0 else 0

    print("\nBenchmark Complete")
    print(f"Total Frames : {frame_count}")
    print(f"Time Taken   : {elapsed:.2f}s")
    print(f"Avg FPS      : {processing_fps:.2f}")

    cap.release()
    out.release()


if __name__ == "__main__":
    benchmark(VIDEO_PATH, OUTPUT_PATH)
