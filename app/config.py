from pydantic import BaseModel

class Settings(BaseModel):
    # "auto" => cuda если есть, иначе cpu
    device: str = "auto"

    # Whisper
    whisper_default_model: str = "base"   # tiny/base/small/medium/large-v3

    # GigaAM
    gigaam_default_model: str = "v3_e2e_rnnt"  # пример; подставьте ваш ID

settings = Settings()
