from pydantic import BaseModel
from typing import Optional, List, Literal, Any, Dict

EngineName = Literal["whisper", "gigaam"]

class TranscribeResponse(BaseModel):
    engine: EngineName
    model: str
    device: str
    language: Optional[str] = None
    text: str
    segments: Optional[List[Dict[str, Any]]] = None
    duration_seconds: float
    meta: Dict[str, Any] = {}
