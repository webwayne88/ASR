from abc import ABC, abstractmethod
from typing import Optional, Dict, Any

class ASREngine(ABC):
    name: str

    @abstractmethod
    def load(self, model_id: str, device: str) -> None:
        ...

    @abstractmethod
    def transcribe(self, audio_path: str, language: Optional[str] = None, **kwargs) -> Dict[str, Any]:
        ...
