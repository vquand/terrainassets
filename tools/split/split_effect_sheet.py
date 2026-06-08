#!/usr/bin/env python3
"""Split a 2x3 weather/effect sheet into named transparent PNGs."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

TOOLS_DIR = Path(__file__).resolve().parent.parent
ROOT = TOOLS_DIR.parent
INPUT_DIR = ROOT / "input"
OUTPUT_DIR = ROOT / "output"

DEFAULT_SOURCE = "PENUP_20260607_223835.png"
NAMES = (
    "rain",
    "storm",
    "tornado",
    "deadly-tornado",
    "burning-ground",
    "evil-burning-ground",
)


def resolve_input(arg: str) -> Path:
    p = Path(arg)
    if "/" in arg or "\\" in arg or p.exists():
        return p
    return INPUT_DIR / arg


def alpha_components(img: Image.Image, *, min_area: int, dilate: int) -> list[tuple[int, int, int, int]]:
    mask = img.getchannel("A").point(lambda a: 255 if a >= 16 else 0, mode="L")
    if dilate > 1:
        mask = mask.filter(ImageFilter.MaxFilter(dilate))

    w, h = mask.size
    pix = mask.load()
    seen = bytearray(w * h)
    boxes: list[tuple[int, int, int, int]] = []

    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or pix[x, y] == 0:
                continue

            q: deque[tuple[int, int]] = deque([(x, y)])
            min_x = max_x = x
            min_y = max_y = y
            count = 0
            while q:
                cx, cy = q.popleft()
                if cx < 0 or cy < 0 or cx >= w or cy >= h:
                    continue
                ci = cy * w + cx
                if seen[ci] or pix[cx, cy] == 0:
                    continue
                seen[ci] = 1
                count += 1
                min_x = min(min_x, cx)
                max_x = max(max_x, cx)
                min_y = min(min_y, cy)
                max_y = max(max_y, cy)
                q.extend(((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)))

            if count >= min_area:
                boxes.append((min_x, min_y, max_x + 1, max_y + 1))

    return boxes


def split_into_cells(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    if len(boxes) != 6:
        raise SystemExit(f"expected 6 alpha components, found {len(boxes)}: {boxes}")

    rows: list[list[tuple[int, int, int, int]]] = []
    for box in sorted(boxes, key=lambda b: ((b[1] + b[3]) / 2, b[0])):
        center_y = (box[1] + box[3]) / 2
        for row in rows:
            row_center = sum((b[1] + b[3]) / 2 for b in row) / len(row)
            if abs(center_y - row_center) < 180:
                row.append(box)
                break
        else:
            rows.append([box])

    if len(rows) != 3 or any(len(row) != 2 for row in rows):
        raise SystemExit(f"expected 3 rows of 2 components, got {[len(row) for row in rows]} rows")

    ordered: list[tuple[int, int, int, int]] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda b: b[0]))
    return ordered


def trim_to_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def crop_with_padding(img: Image.Image, box: tuple[int, int, int, int], padding: int) -> Image.Image:
    x0, y0, x1, y1 = box
    crop_box = (
        max(0, x0 - padding),
        max(0, y0 - padding),
        min(img.width, x1 + padding),
        min(img.height, y1 + padding),
    )
    return trim_to_alpha(img.crop(crop_box))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default=DEFAULT_SOURCE, help="filename in input/ or any path")
    parser.add_argument("--padding", type=int, default=16)
    parser.add_argument("--dilate", type=int, default=31, help="odd alpha dilation kernel")
    parser.add_argument("--min-area", type=int, default=3000)
    args = parser.parse_args()

    input_path = resolve_input(args.input)
    if not input_path.is_file():
        raise SystemExit(f"input not found: {input_path}")

    img = Image.open(input_path).convert("RGBA")
    out_dir = OUTPUT_DIR / input_path.stem
    out_dir.mkdir(parents=True, exist_ok=True)

    boxes = split_into_cells(alpha_components(img, min_area=args.min_area, dilate=args.dilate))
    for name, box in zip(NAMES, boxes, strict=True):
        out_path = out_dir / f"{name}.png"
        crop_with_padding(img, box, args.padding).save(out_path)
        print(out_path.relative_to(ROOT))


if __name__ == "__main__":
    main()
