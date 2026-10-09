#!/usr/bin/env python3
"""Régénère les icônes PWA à partir de assets/minia.png (carré, pixel art)."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SRC = ASSETS / "minia.png"

def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Manquant : {SRC}")
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    sq = img.crop((left, top, left + side, top + side))
    # Pixel art → nearest neighbor
    master = sq.resize((1024, 1024), Image.Resampling.NEAREST)
    master.save(SRC, "PNG", optimize=True)
    master.convert("RGB").save(ASSETS / "minia.jpg", "JPEG", quality=95, optimize=True)
    for size, name in (
        (180, "icon-180.png"),
        (180, "apple-touch-icon.png"),
        (192, "icon-192.png"),
        (512, "icon-512.png"),
    ):
        out = ASSETS / name
        master.resize((size, size), Image.Resampling.NEAREST).save(out, "PNG", optimize=True)
        print("ok", out.name)

if __name__ == "__main__":
    main()
