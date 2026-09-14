import io
import os
import asyncio
import hashlib
import time
from typing import Any

_CPU_COUNT = os.cpu_count() or 4
_CPU_THREADS = max(2, min(8, _CPU_COUNT - 1))
os.environ.setdefault("OMP_NUM_THREADS", str(_CPU_THREADS))
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("ORT_INTRA_OP_NUM_THREADS", str(_CPU_THREADS))
os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "2")

import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageStat
from rapidocr import RapidOCR

app = FastAPI(title="PARAKH RapidOCR Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_lang_type = os.getenv("RAPIDOCR_LANG_TYPE", "en")
_max_ocr_side = max(0, int(os.getenv("RAPIDOCR_MAX_SIDE", "0")))
_engine_max_side = max(2000, int(os.getenv("RAPIDOCR_ENGINE_MAX_SIDE", "10000")))
_use_cls = os.getenv("RAPIDOCR_USE_CLS", "false").lower() == "true"
_use_cuda = os.getenv("RAPIDOCR_USE_CUDA", "true").lower() == "true"
_use_dml = os.getenv("RAPIDOCR_USE_DML", "false").lower() == "true"
_text_score = max(0.0, min(1.0, float(os.getenv("RAPIDOCR_TEXT_SCORE", "0.5"))))
_cuda_device = max(0, int(os.getenv("RAPIDOCR_CUDA_DEVICE", "0")))

_rapid_ocr = None
_result_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_inflight: dict[str, asyncio.Task] = {}
_cache_ttl = max(30, int(os.getenv("RAPIDOCR_CACHE_TTL_SECONDS", "120")))
_cache_limit = max(1, int(os.getenv("RAPIDOCR_CACHE_ITEMS", "8")))


def _get_rapidocr():
    global _rapid_ocr
    if _rapid_ocr is None:
        params = {
            "Global.use_cls": _use_cls,
            "Global.text_score": _text_score,
            "Global.max_side_len": _engine_max_side,
            "Det.limit_side_len": _engine_max_side,
            "Det.limit_type": "max",
            "Rec.lang_type": _lang_type,
            "EngineConfig.onnxruntime.intra_op_num_threads": _CPU_THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": 2,
        }
        if _use_cuda:
            params["EngineConfig.onnxruntime.use_cuda"] = True
            params["EngineConfig.onnxruntime.cuda_ep_cfg.device_id"] = _cuda_device
        if _use_dml:
            params["EngineConfig.onnxruntime.use_dml"] = True
        _rapid_ocr = RapidOCR(params=params)
        providers = "CUDA->CPU" if _use_cuda else "DML->CPU" if _use_dml else "CPU"
        print(
            f"[ocr:rapid] initialized providers={providers} cudaDevice={_cuda_device} "
            f"useCls={_use_cls} textScore={_text_score} inputMaxSide={_max_ocr_side or 'source'} "
            f"engineMaxSide={_engine_max_side} cpuThreads={_CPU_THREADS}"
        )
    return _rapid_ocr


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _preprocess_for_ocr(pil_image: Image.Image):
    """Prepare OCR input while preserving source resolution by default."""
    original_width, original_height = pil_image.size
    image = ImageOps.exif_transpose(pil_image.convert("RGB"))

    gray_stats = ImageStat.Stat(ImageOps.grayscale(image))
    mean = float(gray_stats.mean[0])
    stddev = float(gray_stats.stddev[0])
    if stddev < 42 or mean < 65 or mean > 205:
        image = ImageOps.autocontrast(image, cutoff=1)
        image = ImageEnhance.Contrast(image).enhance(1.10)

    image = image.filter(ImageFilter.UnsharpMask(radius=1.0, percent=110, threshold=3))

    scale = 1.0
    if _max_ocr_side > 0:
        scale = min(1.0, _max_ocr_side / max(image.width, image.height))
        if scale < 1.0:
            width = max(1, round(image.width * scale))
            height = max(1, round(image.height * scale))
            image = image.resize((width, height), Image.Resampling.LANCZOS)

    return image, original_width, original_height, scale


def _enhance_for_ocr(image):
    enhanced = ImageOps.autocontrast(image, cutoff=1)
    enhanced = ImageEnhance.Contrast(enhanced).enhance(1.14)
    enhanced = enhanced.filter(ImageFilter.UnsharpMask(radius=1.25, percent=125, threshold=3))
    return enhanced


def _ocr_quality(entries):
    if not entries:
        return 0.0
    confidences = [to_float(entry.get("confidence"), 0.0) for entry in entries]
    avg_confidence = sum(confidences) / len(confidences)
    return (min(len(entries), 30) / 30.0) * 0.4 + avg_confidence * 0.6


def _cache_key(items: list[tuple[bytes, str]]) -> str:
    digest = hashlib.sha256()
    for content, media_type in items:
        digest.update(media_type.encode("utf-8"))
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _get_cached(key: str):
    cached = _result_cache.get(key)
    if not cached:
        return None
    created_at, result = cached
    if time.monotonic() - created_at > _cache_ttl:
        _result_cache.pop(key, None)
        return None
    return result


def _store_cached(key: str, result: dict[str, Any]):
    _result_cache[key] = (time.monotonic(), result)
    while len(_result_cache) > _cache_limit:
        oldest_key = min(_result_cache, key=lambda cache_key: _result_cache[cache_key][0])
        _result_cache.pop(oldest_key, None)


def _box_to_rect(box, scale: float, original_width: int, original_height: int):
    try:
        points = np.asarray(box, dtype=float)
        if points.shape != (4, 2):
            return None
        if scale <= 0:
            return None
        xs = points[:, 0] / scale
        ys = points[:, 1] / scale
        left = max(0.0, min(float(original_width), float(xs.min())))
        top = max(0.0, min(float(original_height), float(ys.min())))
        right = max(left, min(float(original_width), float(xs.max())))
        bottom = max(top, min(float(original_height), float(ys.max())))
        return {"left": round(left, 2), "top": round(top, 2), "width": round(right - left, 2), "height": round(bottom - top, 2)}
    except Exception:
        return None


def extract_result(result: Any, image_index: int, ocr_width: int, ocr_height: int, scale: float, original_width: int, original_height: int):
    if result is None:
        return []
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    boxes = getattr(result, "boxes", None)
    if texts is None or scores is None:
        return []
    entries = []
    for index, value in enumerate(texts):
        text_value = str(value or "").strip()
        if not text_value:
            continue
        confidence = max(0.0, min(1.0, to_float(scores[index], 0.0) if index < len(scores) else 0.0))
        entry = {
            "imageIndex": image_index + 1,
            "type": "OCR_TEXT",
            "text": text_value,
            "confidence": confidence,
            "source": "rapidocr",
            "imageWidth": int(original_width),
            "imageHeight": int(original_height),
            "ocrImageWidth": int(ocr_width),
            "ocrImageHeight": int(ocr_height),
        }
        if boxes is not None and index < len(boxes):
            rect = _box_to_rect(boxes[index], scale, original_width, original_height)
            if rect:
                entry["boundingBox"] = rect
        entries.append(entry)
    return entries


async def _analyze_contents(items: list[tuple[bytes, str]]):
    started_at = time.monotonic()
    prepared = []
    for image_index, (content, _media_type) in enumerate(items[:6]):
        try:
            raw = Image.open(io.BytesIO(content))
            image, original_width, original_height, scale = _preprocess_for_ocr(raw)
            prepared.append((np.asarray(image), original_width, original_height, scale))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid image {image_index + 1}: {exc}") from exc

    rapid = _get_rapidocr()

    async def run_one(image_index, payload):
        array, original_width, original_height, scale = payload
        image_started = time.monotonic()

        def infer(arr):
            result = rapid(arr)
            return extract_result(result, image_index, arr.shape[1], arr.shape[0], scale, original_width, original_height)

        entries = await asyncio.to_thread(infer, array)
        initial_quality = _ocr_quality(entries)
        used_fallback = False

        if initial_quality < 0.62:
            fallback_started = time.monotonic()
            enhanced = np.asarray(_enhance_for_ocr(Image.fromarray(array)))
            fallback_entries = await asyncio.to_thread(infer, enhanced)
            fallback_quality = _ocr_quality(fallback_entries)
            if fallback_quality > initial_quality:
                entries = fallback_entries
            used_fallback = True
            fallback_ms = round((time.monotonic() - fallback_started) * 1000)
            print(f"[ocr:rapid] image={image_index + 1} enhancementRetry=True initialQuality={initial_quality:.3f} fallbackQuality={fallback_quality:.3f} fallback={fallback_ms}ms")

        one_engine_ms = round((time.monotonic() - image_started) * 1000)
        print(f"[ocr:rapid] image={image_index + 1} original={original_width}x{original_height} ocr={array.shape[1]}x{array.shape[0]} engine={one_engine_ms}ms entries={len(entries)} fallback={used_fallback} scale={scale:.4f}")
        return image_index, one_engine_ms, entries

    results = list(await asyncio.gather(*(run_one(image_index, payload) for image_index, payload in enumerate(prepared))))
    results.sort(key=lambda item: item[0])
    all_entries = []
    raw_text_parts = []
    engine_ms = 0
    for _image_index, one_engine_ms, entries in results:
        engine_ms += one_engine_ms
        all_entries.extend(entries)
        raw_text_parts.append("\n".join(entry["text"] for entry in entries))

    elapsed_ms = round((time.monotonic() - started_at) * 1000)
    print(f"[ocr:rapid] request images={len(prepared)} engine={engine_ms}ms total={elapsed_ms}ms entries={len(all_entries)}")
    return {
        "provider": "rapidocr",
        "model": "RapidOCR",
        "timingMs": elapsed_ms,
        "engineTimingMs": engine_ms,
        "result": {
            "declarationEvidence": all_entries,
            "rawText": "\n\n".join(part for part in raw_text_parts if part).strip(),
            "warnings": [],
            "unreadableFields": [],
            "needsReview": any(entry["confidence"] < 0.6 for entry in all_entries),
        },
    }


@app.on_event("startup")
async def warmup():
    try:
        started_at = time.monotonic()
        rapid = _get_rapidocr()
        warm_image = np.full((192, 192, 3), 255, dtype=np.uint8)
        await asyncio.to_thread(lambda: rapid(warm_image))
        elapsed_ms = round((time.monotonic() - started_at) * 1000)
        print(f"[ocr:rapid] warmup complete in {elapsed_ms}ms providers={'CUDA->CPU' if _use_cuda else 'DML->CPU' if _use_dml else 'CPU'} inputMaxSide={_max_ocr_side or 'source'} engineMaxSide={_engine_max_side} cpuThreads={_CPU_THREADS}")
    except Exception as exc:
        print(f"[ocr:rapid] warmup skipped: {exc}")


@app.get("/health")
def health():
    return {"status": "ok", "service": "parakh-rapidocr", "engine": "RapidOCR"}


@app.post("/api/ocr/analyze")
async def analyze(images: list[UploadFile] = File(...)):
    if not images:
        raise HTTPException(status_code=400, detail="At least one image is required.")
    items = []
    for upload in images[:6]:
        content = await upload.read()
        items.append((content, upload.content_type or "image/jpeg"))
    key = _cache_key(items)
    cached = _get_cached(key)
    if cached is not None:
        print("[ocr:rapid] cache hit")
        return {**cached, "cached": True}
    existing = _inflight.get(key)
    if existing is not None:
        result = await existing
        print("[ocr:rapid] reused in-flight request")
        return {**result, "cached": True}
    task = asyncio.create_task(_analyze_contents(items))
    _inflight[key] = task
    try:
        result = await task
        _store_cached(key, result)
        return {**result, "cached": False}
    finally:
        _inflight.pop(key, None)
