import os
import uuid
from pathlib import Path

def ensure_dir(path: str) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)

def save_upload_to_temp(upload_bytes: bytes, filename: str, temp_dir: str = "tmp") -> str:
    ensure_dir(temp_dir)
    ext = os.path.splitext(filename)[1] or ".bin"
    out_path = os.path.join(temp_dir, f"{uuid.uuid4().hex}{ext}")
    with open(out_path, "wb") as f:
        f.write(upload_bytes)
    return out_path
