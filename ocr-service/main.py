import io
import os
import asyncio
import hashlib
import time
from typing import Any

# Render free instances expose very little CPU. Limit ONNX Runtime thread pools
# to avoid oversubscription on the small CPU allocation. GPU/DirectML mode does
# not need these CPU inference limits, but leaving them set is harmless because
# the ONNX execution provider handles the main inference work.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("ORT_INTRA_OP_NUM_THREADS", "1")
os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")

import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, ImageEnhance, ImageFilter
from rapidocr import RapidOCR
from visual_evidence import assess as assess_visual_quality

app = FastAPI(title="PARAKH RapidOCR Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_lang_type = os.getenv("RAPIDOCR_LANG_TYPE", "en")
_max_ocr_side = max(768, int(os.getenv("RAPIDOCR_MAX_SIDE", "768")))
_cache_ttl = max(30, int(os.getenv("RAPIDOCR_CACHE_TTL_SECONDS", "120")))
_cache_limit = max(1, int(os.getenv("RAPIDOCR_CACHE_ITEMS", "8")))
_use_cls = os.getenv("RAPIDOCR_USE_CLS", "false").lower() == "true"
_use_dml = os.getenv("RAPIDOCR_USE_DML", "false").lower() == "true"
_text_score = max(0.0, min(1.0, float(os.getenv("RAPIDOCR_TEXT_SCORE", "0.5"))))

_rapid_ocr = None
_result_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_inflight: dict[str, asyncio.Task] = {}


def _get_rapidocr():
    global _rapid_ocr
    if _rapid_ocr is None:
        params = {
            "Global.use_cls": _use_cls,
            "Global.text_score": _text_score,
            "Rec.lang_type": _lang_type,
        }
        if _use_dml:
            params["EngineConfig.onnxruntime.use_dml"] = True
        _rapid_ocr = RapidOCR(params=params)
        print(
            f"[ocr:rapid] initialized useDML={_use_dml} "
            f"useCls={_use_cls} textScore={_text_score} maxSide={_max_ocr_side}"
        )
    return _rapid_ocr


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _prepare_image(content: bytes):
    pil_image = ImageOps.exif_transpose(Image.open(io.BytesIO(content)).convert("RGB"))
    original_width, original_height = pil_image.size
    scale = min(1.0, _max_ocr_side / max(original_width, original_height))
    if scale < 1.0:
        width = max(1, round(original_width * scale))
        height = max(1, round(original_height * scale))
        pil_image = pil_image.resize((width, height), Image.Resampling.LANCZOS)
    return pil_image


def _enhance_for_ocr(image):
    """Conservative blur recovery for hard images.

    Keep dimensions unchanged so OCR bounding boxes remain in the same coordinate
    space as the already-tested pipeline. This path is only used when the first
    OCR pass produces weak evidence.
    """
    enhanced = ImageEnhance.Contrast(image).enhance(1.12)
    enhanced = enhanced.filter(ImageFilter.UnsharpMask(radius=1.2, percent=115, threshold=3))
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


def _box_to_rect(box):
    try:
        points = np.asarray(box, dtype=float)
        if points.shape != (4, 2):
            return None
        xs = points[:, 0]
        ys = points[:, 1]
        left = float(xs.min())
        top = float(ys.min())
        right = float(xs.max())
        bottom = float(ys.max())
        return {
            "left": round(left, 2),
            "top": round(top, 2),
            "width": round(max(0.0, right - left), 2),
            "height": round(max(0.0, bottom - top), 2),
        }
    except Exception:
        return None


def extract_result(result: Any, image_index: int, image_width: int, image_height: int):
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
            "imageWidth": int(image_width),
            "imageHeight": int(image_height),
        }
        if boxes is not None and index < len(boxes):
            rect = _box_to_rect(boxes[index])
            if rect:
                entry["boundingBox"] = rect
        entries.append(entry)
    return entries


async def _analyze_contents(items: list[tuple[bytes, str]]):
    started_at = time.monotonic()
    prepared = []
    visual_evidence = []
    for image_index, (content, _media_type) in enumerate(items[:6]):
        try:
            prepared.append(np.asarray(_prepare_image(content)))
            visual_evidence.append({"imageIndex": image_index + 1, **assess_visual_quality(content)})
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid image {image_index + 1}: {exc}") from exc

    rapid = _get_rapidocr()

    async def run_one(image_index, array):
        image_started = time.monotonic()

        def infer(arr):
            result = rapid(arr)
            return extract_result(result, image_index, arr.shape[1], arr.shape[0])

        entries = await asyncio.to_thread(infer, array)
        initial_quality = _ocr_quality(entries)
        used_fallback = False

        # Only retry weak OCR results. Sharp/normal images keep the exact fast
        # path that has already been benchmarked successfully.
        if initial_quality < 0.62:
            fallback_started = time.monotonic()
            enhanced = np.asarray(_enhance_for_ocr(Image.fromarray(array)))
            fallback_entries = await asyncio.to_thread(infer, enhanced)
            fallback_quality = _ocr_quality(fallback_entries)
            if fallback_quality > initial_quality:
                entries = fallback_entries
            used_fallback = True
            fallback_ms = round((time.monotonic() - fallback_started) * 1000)
            print(
                f"[ocr:rapid] image={image_index + 1} blurFallback=True "
                f"initialQuality={initial_quality:.3f} fallbackQuality={fallback_quality:.3f} "
                f"fallback={fallback_ms}ms"
            )

        one_engine_ms = round((time.monotonic() - image_started) * 1000)
        print(
            f"[ocr:rapid] image={image_index + 1} "
            f"size={array.shape[1]}x{array.shape[0]} "
            f"engine={one_engine_ms}ms entries={len(entries)} "
            f"fallback={used_fallback}"
        )
        return image_index, one_engine_ms, entries

    if _use_dml:
        # DirectML inference through one shared RapidOCR instance is kept
        # sequential. This avoids concurrent execution races on the shared
        # execution provider and keeps detection results deterministic.
        results = []
        for image_index, array in enumerate(prepared):
            results.append(await run_one(image_index, array))
    else:
        # CPU inference can use independent worker calls concurrently.
        results = list(await asyncio.gather(
            *(run_one(image_index, array) for image_index, array in enumerate(prepared))
        ))

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
            "warnings": [warning for item in visual_evidence for warning in item.get("warnings", [])],
            "visualEvidence": visual_evidence,
            "unreadableFields": [],
            "needsReview": any(entry["confidence"] < 0.6 for entry in all_entries) or any(item.get("warnings") for item in visual_evidence),
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
        print(f"[ocr:rapid] warmup complete in {elapsed_ms}ms useCls={_use_cls} useDML={_use_dml} textScore={_text_score} maxSide={_max_ocr_side} omp={os.getenv('OMP_NUM_THREADS')}")
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
