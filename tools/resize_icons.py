#!/usr/bin/env python3
"""
Resize app.png into required icon sizes.
Usage: python tools/resize_icons.py
Requires: Pillow
"""
from pathlib import Path
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "icons" / "app.png"
TARGETS = [16, 20, 24, 32, 48, 96]


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Source not found: {SOURCE}")
    img = Image.open(SOURCE).convert("RGBA")
    for size in TARGETS:
        out_path = ROOT / "icons" / f"app-{size}.png"
        resized = img.resize((size, size), resample=Image.LANCZOS)
        resized.save(out_path, format="PNG")
        print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
