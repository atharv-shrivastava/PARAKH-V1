import io
import os
import asyncio
import hashlib
import time
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("ORT_INTRA_OP_NUM_THREADS", "1")
os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", "1")

import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageStat
from rapidocr import RapidOCR

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

MAX_IMAGES = 6
MAX_SIDE = max(1024, int(os.getenv("RAPIDOCR_MAX_SIDE", "1600")))
CACHE_TTL = max(30, int(os.getenv("RAPIDOCR_CACHE_TTL_SECONDS", "120")))
CACHE_LIMIT = max(1, int(os.getenv("RAPIDOCR_CACHE_ITEMS", "8")))
RAPIDOCR_LANG_TYPE = os.getenv("RAPIDOCR_LANG_TYPE", "en").strip() or "en"
RAPIDOCR_USE_CLS = os.getenv("RAPIDOCR_USE_CLS", "false").lower() == "true"
RAPIDOCR_USE_DML = os.getenv("RAPIDOCR_USE_DML", "false").lower() == "true"
RAPIDOCR_TEXT_SCORE = max(0.0, min(1.0, float(os.getenv("RAPIDOCR_TEXT_SCORE", "0.5"))))
RAPIDOCR_PARALLELISM = max(1, min(MAX_IMAGES, int(os.getenv("RAPIDOCR_PARALLELISM", "4"))))

LANGUAGE_ALIASES = {
    "od": "or",
    "ori": "or",
    "punjabi": "pa",
    "hindi": "hi",
    "marathi": "mr",
    "bengali": "bn",
    "gujarati": "gu",
    "tamil": "ta",
    "telugu": "te",
    "kannada": "kn",
    "malayalam": "ml",
    "assamese": "as",
    "urdu": "ur",
}

_rapid_ocr = None
_result_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_inflight: dict[str, asyncio.Task] = {}


def normalize_language(value: Any) -> str:
    language = str(value or "").strip().lower().replace("_", "-")
    language = language.split("-")[0]
    return LANGUAGE_ALIASES.get(language, language or "en")


def _get_rapidocr():
    global _rapid_ocr
    if _rapid_ocr is None:
        params = {
            "Global.use_cls": RAPIDOCR_USE_CLS,
            "Global.text_score": RAPIDOCR_TEXT_SCORE,
            "Rec.lang_type": RAPIDOCR_LANG_TYPE,
        }
        if RAPIDOCR_USE_DML:
            params["EngineConfig.onnxruntime.use_dml"] = True
        _rapid_ocr = RapidOCR(params=params)
        print(
            f"[ocr:rapid] initialized useDML={RAPIDOCR_USE_DML} "
            f"lang={RAPIDOCR_LANG_TYPE} parallelism={RAPIDOCR_PARALLELISM}"
        )
    return _rapid_ocr


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def prepare_image(content: bytes):
    pil = ImageOps.exif_transpose(Image.open(io.BytesIO(content)).convert("RGB"))
    original_width, original_height = pil.size
    stats = ImageStat.Stat(ImageOps.grayscale(pil))
    if stats.stddev[0] < 42 or stats.mean[0] < 65 or stats.mean[0] > 205:
        pil = ImageOps.autocontrast(pil, cutoff=1)
        pil = ImageEnhance.Contrast(pil).enhance(1.10)
    pil = pil.filter(ImageFilter.UnsharpMask(radius=1.0, percent=110, threshold=3))
    scale = min(1.0, MAX_SIDE / max(pil.width, pil.height))
    if scale < 1.0:
        pil = pil.resize(
            (max(1, round(pil.width * scale)), max(1, round(pil.height * scale))),
            Image.Resampling.LANCZOS,
        )
    return pil, original_width, original_height, scale


def enhanced_image(image: Image.Image):
    image = ImageOps.autocontrast(image, cutoff=1)
    image = ImageEnhance.Contrast(image).enhance(1.14)
    return image.filter(ImageFilter.UnsharpMask(radius=1.25, percent=125, threshold=3))


def _box_to_rect(box, scale: float, original_width: int, original_height: int):
    try:
        points = np.asarray(box, dtype=float)
        if points.shape == (4, 2):
            xs = points[:, 0] / max(scale, 1e-6)
            ys = points[:, 1] / max(scale, 1e-6)
            left = max(0.0, min(float(original_width), float(xs.min())))
            top = max(0.0, min(float(original_height), float(ys.min())))
            right = max(left, min(float(original_width), float(xs.max())))
            bottom = max(top, min(float(original_height), float(ys.max())))
            return {
                "left": round(left, 2),
                "top": round(top, 2),
                "width": round(right - left, 2),
                "height": round(bottom - top, 2),
            }
        if points.size == 4:
            x1, y1, x2, y2 = points.reshape(-1).tolist()
            return _box_to_rect(
                [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                scale,
                original_width,
                original_height,
            )
    except Exception:
        pass
    return None


def extract_rapid(
    result: Any,
    image_index: int,
    scale: float,
    original_width: int,
    original_height: int,
):
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
        confidence = max(
            0.0,
            min(1.0, to_float(scores[index], 0.0) if index < len(scores) else 0.0),
        )
        entry = {
            "imageIndex": image_index + 1,
            "type": "OCR_TEXT",
            "text": text_value,
            "confidence": confidence,
            "source": "rapidocr",
            "imageWidth": original_width,
            "imageHeight": original_height,
        }
        if boxes is not None and index < len(boxes):
            rect = _box_to_rect(boxes[index], scale, original_width, original_height)
            if rect:
                entry["boundingBox"] = rect
        entries.append(entry)
    return entries


def quality(entries):
    if not entries:
        return 0.0
    average = sum(to_float(item.get("confidence"), 0.0) for item in entries) / len(entries)
    return min(len(entries), 30) / 30.0 * 0.4 + average * 0.6


def dedupe_entries(entries):
    seen = set()
    output = []
    for item in entries:
        box = item.get("boundingBox") or {}
        key = (
            int(item.get("imageIndex", 0)),
            str(item.get("text", "")).strip().casefold(),
            round(float(box.get("left", -1)), -1),
            round(float(box.get("top", -1)), -1),
        )
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


def cache_key(items: list[tuple[bytes, str]], language: str) -> str:
    digest = hashlib.sha256()
    digest.update(normalize_language(language).encode("utf-8"))
    for content, media_type in items:
        digest.update(media_type.encode("utf-8"))
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def get_cached(key: str):
    item = _result_cache.get(key)
    if not item:
        return None
    created_at, result = item
    if time.monotonic() - created_at > CACHE_TTL:
        _result_cache.pop(key, None)
        return None
    return result


def store_cached(key: str, result: dict[str, Any]):
    _result_cache[key] = (time.monotonic(), result)
    while len(_result_cache) > CACHE_LIMIT:
        oldest = min(_result_cache, key=lambda current: _result_cache[current][0])
        _result_cache.pop(oldest, None)


async def _infer_one(rapid, prepared, semaphore: asyncio.Semaphore):
    image, original_width, original_height, scale, image_index = prepared
    async with semaphore:
        image_started = time.monotonic()

        def infer(source):
            return extract_rapid(
                rapid(source),
                image_index,
                scale,
                original_width,
                original_height,
            )

        entries = await asyncio.to_thread(infer, np.asarray(image))
        first_quality = quality(entries)

        if first_quality < 0.55:
            fallback_entries = await asyncio.to_thread(infer, np.asarray(enhanced_image(image)))
            if quality(fallback_entries) > first_quality:
                entries = fallback_entries

        elapsed = round((time.monotonic() - image_started) * 1000)
        print(
            f"[ocr:rapid] image={image_index + 1} "
            f"size={original_width}x{original_height} entries={len(entries)} "
            f"engine={elapsed}ms"
        )
        return entries


async def rapid_analyze(items: list[tuple[bytes, str]]):
    started = time.monotonic()
    prepared = []
    for image_index, (content, _media_type) in enumerate(items[:MAX_IMAGES]):
        try:
            image, original_width, original_height, scale = prepare_image(content)
            prepared.append((image, original_width, original_height, scale, image_index))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid image {image_index + 1}: {exc}") from exc

    rapid = _get_rapidocr()
    semaphore = asyncio.Semaphore(RAPIDOCR_PARALLELISM)
    per_image = await asyncio.gather(
        *(_infer_one(rapid, item, semaphore) for item in prepared)
    )

    all_entries = dedupe_entries([entry for entries in per_image for entry in entries])
    total_ms = round((time.monotonic() - started) * 1000)
    raw_text = "\n".join(item["text"] for item in all_entries).strip()
    return {
        "provider": "rapidocr",
        "model": "RapidOCR",
        "language": RAPIDOCR_LANG_TYPE,
        "timingMs": total_ms,
        "engineTimingMs": total_ms,
        "imageCount": len(prepared),
        "parallel": len(prepared) > 1,
        "result": {
            "declarationEvidence": all_entries,
            "rawText": raw_text,
            "warnings": [],
            "unreadableFields": [],
            "needsReview": any(item["confidence"] < 0.6 for item in all_entries),
        },
    }


@app.on_event("startup")
async def warmup():
    try:
        started = time.monotonic()
        await asyncio.to_thread(_get_rapidocr)
        print(
            f"[ocr:rapid] warmup initialized lang={RAPIDOCR_LANG_TYPE} "
            f"parallelism={RAPIDOCR_PARALLELISM} "
            f"elapsed={round((time.monotonic() - started) * 1000)}ms"
        )
    except Exception as exc:
        print(f"[ocr:rapid] warmup skipped: {exc}")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "parakh-rapidocr",
        "primary": "RapidOCR",
        "imageMode": "parallel",
        "parallelism": RAPIDOCR_PARALLELISM,
    }


@app.post("/api/ocr/analyze")
async def analyze(images: list[UploadFile] = File(...), language: str = ""):
    if not images:
        raise HTTPException(status_code=400, detail="At least one image is required.")

    items = []
    for upload in images[:MAX_IMAGES]:
        items.append((await upload.read(), upload.content_type or "image/jpeg"))

    requested_language = normalize_language(language or RAPIDOCR_LANG_TYPE)
    key = cache_key(items, requested_language)
    cached = get_cached(key)
    if cached is not None:
        return {**cached, "cached": True}

    existing = _inflight.get(key)
    if existing is not None:
        result = await existing
        return {**result, "cached": True}

    async def task_body():
        return await rapid_analyze(items)

    task = asyncio.create_task(task_body())
    _inflight[key] = task
    try:
        result = await task
        store_cached(key, result)
        return {**result, "cached": False}
    finally:
        _inflight.pop(key, None)
