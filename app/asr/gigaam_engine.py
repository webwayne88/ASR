from __future__ import annotations
from typing import Optional, Dict, Any
import threading

from .base import ASREngine

class GigaAMEngine(ASREngine):
    name = "gigaam"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded_key: Optional[tuple[str, str]] = None  # (model_id, device)
        self._model = None
        self._sdk_variant: Optional[str] = None

    def load(self, model_id: str, device: str) -> None:
        key = (model_id, device)
        if self._loaded_key == key and self._model is not None:
            return

        with self._lock:
            if self._loaded_key == key and self._model is not None:
                return

            import gigaam  # предположение: пакет доступен

            m = gigaam.load_model(model_id)

            # Вариант A: модель torch-like и поддерживает .to()
            try:
                if hasattr(m, "to"):
                    m = m.to(device)
                    self._sdk_variant = "torch-like"
                else:
                    self._sdk_variant = "unknown-no-to"
            except Exception as e:
                raise RuntimeError(f"GigaAM: failed to move model to device={device}: {e}") from e

            self._model = m
            self._loaded_key = key

    def transcribe(self, audio_path: str, language: Optional[str] = None, **kwargs) -> Dict[str, Any]:
        if self._model is None:
            raise RuntimeError("GigaAM model is not loaded")

        # Пытаемся поддержать разные варианты SDK.
        # Вариант A: model.transcribe(path) -> dict/str
        if hasattr(self._model, "transcribe"):
            out = self._model.transcribe(audio_path, **kwargs)  # language может быть не поддержан
        # Вариант B: model(audio_path) -> ...
        elif callable(self._model):
            out = self._model(audio_path, **kwargs)
        else:
            raise RuntimeError("GigaAM: unsupported model interface (no transcribe() and not callable)")

        # Нормализация вывода
        if isinstance(out, str):
            return {"text": out.strip(), "language": language, "segments": None, "meta": {"sdk_variant": self._sdk_variant}}

        if isinstance(out, dict):
            text = out.get("text") or out.get("result") or ""
            segments = out.get("segments")
            return {"text": str(text).strip(), "language": out.get("language") or language, "segments": segments, "meta": {"sdk_variant": self._sdk_variant}}

        return {"text": str(out).strip(), "language": language, "segments": None, "meta": {"sdk_variant": self._sdk_variant}}
