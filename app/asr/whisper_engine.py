from __future__ import annotations
from typing import Optional, Dict, Any
import threading

from .base import ASREngine

class WhisperEngine(ASREngine):
    name = "whisper"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded_key: Optional[tuple[str, str]] = None  # (model_id, device)
        self._model = None

    def load(self, model_id: str, device: str) -> None:
        key = (model_id, device)
        if self._loaded_key == key and self._model is not None:
            return

        with self._lock:
            if self._loaded_key == key and self._model is not None:
                return

            import whisper
            # whisper сам использует torch и device
            self._model = whisper.load_model(model_id, device=device)
            self._loaded_key = key

    def transcribe(self, audio_path: str, language: Optional[str] = None, **kwargs) -> Dict[str, Any]:
        if self._model is None:
            raise RuntimeError("Whisper model is not loaded")

        # fp16 имеет смысл только на cuda; на cpu может ломать/замедлять
        fp16 = kwargs.pop("fp16", None)
        if fp16 is None:
            fp16 = True  # whisper сам приведёт к fp16 на cuda; на cpu обычно игнорируется/приводится

        result = self._model.transcribe(
            audio_path,
            language=language,
            fp16=fp16,
            **kwargs,
        )

        # приводим сегменты к JSON-friendly
        segments = result.get("segments")
        if isinstance(segments, list):
            segments = [
                {
                    "id": s.get("id"),
                    "start": s.get("start"),
                    "end": s.get("end"),
                    "text": s.get("text"),
                    "avg_logprob": s.get("avg_logprob"),
                    "no_speech_prob": s.get("no_speech_prob"),
                }
                for s in segments
            ]

        return {
            "text": (result.get("text") or "").strip(),
            "language": result.get("language"),
            "segments": segments,
            "meta": {
                "task": result.get("task"),
            },
        }
