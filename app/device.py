def resolve_device(device: str) -> str:
    device = (device or "auto").lower()
    if device in ("cpu", "cuda"):
        return device

    # auto
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        # если torch не импортируется, считаем cpu (управляемый деградирующий режим)
        return "cpu"
