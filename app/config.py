import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)  # загружаем значения, если файл существует

DEFAULT_DEVICE = "auto"
DEFAULT_WHISPER_MODEL = "base"
DEFAULT_GIGAAM_MODEL = "v3_e2e_rnnt"

class Settings(BaseModel):
    # "auto" => cuda если есть, иначе cpu
    device: str = DEFAULT_DEVICE

    # Whisper
    whisper_default_model: str = DEFAULT_WHISPER_MODEL   # tiny/base/small/medium/large-v3

    # GigaAM
    gigaam_default_model: str = DEFAULT_GIGAAM_MODEL  # пример; подставьте ваш ID

def load_settings() -> Settings:
    return Settings(
        device=os.getenv("ASR_DEVICE", DEFAULT_DEVICE),
        whisper_default_model=os.getenv("ASR_WHISPER_MODEL", DEFAULT_WHISPER_MODEL),
        gigaam_default_model=os.getenv("ASR_GIGAAM_MODEL", DEFAULT_GIGAAM_MODEL),
    )

settings = load_settings()
