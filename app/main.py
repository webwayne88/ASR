from pathlib import Path
import sys
import time
import logging

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

PACKAGE_ROOT = Path(__file__).resolve().parent
if __package__ is None or __package__ == "":
    # support `python app/main.py` by adding the project root to sys.path
    sys.path.append(str(PACKAGE_ROOT.parent))
    from app.config import settings  # type: ignore
    from app.device import resolve_device  # type: ignore
    from app.schemas import TranscribeResponse  # type: ignore
    from app.utils import save_upload_to_temp  # type: ignore
    from app.asr.whisper_engine import WhisperEngine  # type: ignore
    from app.asr.gigaam_engine import GigaAMEngine  # type: ignore
else:
    from .config import settings
    from .device import resolve_device
    from .schemas import TranscribeResponse
    from .utils import save_upload_to_temp
    from .asr.whisper_engine import WhisperEngine
    from .asr.gigaam_engine import GigaAMEngine

app = FastAPI(title="Offline ASR Service", version="1.0.0")

logger = logging.getLogger(__name__)

ENGINES = {
    "whisper": WhisperEngine(),
    "gigaam": GigaAMEngine(),
}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/engines")
def engines():
    return {
        "available": list(ENGINES.keys()),
        "defaults": {
            "whisper": settings.whisper_default_model,
            "gigaam": settings.gigaam_default_model,
        }
    }

@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    engine: str = Form("whisper"),
    model: str | None = Form(None),
    device: str = Form(settings.device),     # auto/cpu/cuda
    language: str | None = Form(None),
):
    engine = (engine or "").lower().strip()
    if engine not in ENGINES:
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Use one of: {list(ENGINES.keys())}")

    device_resolved = resolve_device(device)

    if model is None:
        model = settings.whisper_default_model if engine == "whisper" else settings.gigaam_default_model

    try:
        data = await file.read()
        audio_path = save_upload_to_temp(data, file.filename, temp_dir="tmp")

        asr = ENGINES[engine]
        asr.load(model_id=model, device=device_resolved)
        start_ts = time.perf_counter()
        out = asr.transcribe(audio_path=audio_path, language=language)
        duration = time.perf_counter() - start_ts
        logger.info(
            "Transcription completed in %.2fs (engine=%s, model=%s, device=%s, language=%s)",
            duration, engine, model, device_resolved, language or "auto",
        )

        resp = TranscribeResponse(
            engine=engine, model=model, device=device_resolved,
            language=out.get("language"),
            text=out.get("text", ""),
            segments=out.get("segments"),
            duration_seconds=duration,
            meta=out.get("meta", {}),
        )
        return resp
    except HTTPException:
        raise
    except Exception as e:
        # управляемый фейл, чтобы клиенту было понятно, что именно сломалось
        raise HTTPException(status_code=500, detail=f"Transcription failed: {type(e).__name__}: {e}") from e

UI_DIR = Path(__file__).parent / "ui"
app.mount("/ui", StaticFiles(directory=str(UI_DIR), html=True), name="ui")

@app.get("/")
def root():
    # редирект можно не делать — просто отдаём UI
    return FileResponse(str(UI_DIR / "index.html"))
