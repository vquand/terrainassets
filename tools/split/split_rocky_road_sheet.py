#!/usr/bin/env python3
"""Split rocky-road sketches into normalized game-tile sprites."""

from __future__ import annotations

import json
import math
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

TOOLS_DIR = Path(__file__).resolve().parent.parent
ROOT = TOOLS_DIR.parent
SPRITES_DIR = ROOT / "sprites"
INPUT_DIR = ROOT / "input"
OUTPUT_DIR = ROOT / "output"
PUBLIC_DIR = SPRITES_DIR / "roads" / "rock-road"

TILE_W = 64
TILE_H = 74
PADDING = 12

# Source indices are reading order within each sketch sheet.
VARIANTS = (
    {
        "name": "slight-side",
        "source": "PENUP_20260531_204817.png",
        "sourceIndex": 1,
        "description": "Road bends slightly from the left edge toward the upper-right edge.",
        "connections": ["west", "northeast"],
    },
    {
        "name": "straight",
        "source": "PENUP_20260531_204817.png",
        "sourceIndex": 2,
        "description": "Road travels straight through the tile from left to right.",
        "connections": ["west", "east"],
    },
    {
        "name": "dead-end",
        "source": "PENUP_20260531_204817.png",
        "sourceIndex": 3,
        "description": "Road enters from the left and terminates at a rock blockage.",
        "connections": ["west"],
    },
    {
        "name": "turn-back",
        "source": "PENUP_20260531_204817.png",
        "sourceIndex": 4,
        "description": "Road enters from the left and curls back toward the upper-left edge.",
        "connections": ["west", "northwest"],
    },
    {
        "name": "three-adjacent",
        "source": "PENUP_20260603_222850.png",
        "sourceIndex": 1,
        "description": "Three-way junction with three adjacent exits, based west/northwest/northeast.",
        "connections": ["west", "northwest", "northeast"],
    },
    {
        "name": "three-left-spread",
        "source": "PENUP_20260603_222850.png",
        "sourceIndex": 3,
        "description": "Three-way junction with an asymmetric left spread, based west/east/northeast.",
        "connections": ["west", "east", "northeast"],
    },
    {
        "name": "three-right-spread",
        "source": "PENUP_20260603_222850.png",
        "sourceIndex": 2,
        "mirrorOf": "three-left-spread",
        "description": "Three-way junction with the mirrored asymmetric spread, based west/east/northwest.",
        "connections": ["west", "east", "northwest"],
    },
    {
        "name": "three-alternate",
        "source": "PENUP_20260603_222850.png",
        "sourceIndex": 2,
        "description": "Three-way junction with evenly spaced exits, based west/northeast/southeast.",
        "connections": ["west", "northeast", "southeast"],
    },
    {
        "name": "four-adjacent-gap",
        "source": "PENUP_20260603_222741.png",
        "sourceIndex": 3,
        "description": "Four-way junction missing two adjacent exits, based northwest/west/southwest/southeast.",
        "connections": ["northwest", "west", "southwest", "southeast"],
    },
    {
        "name": "four-spread-gap",
        "source": "PENUP_20260603_222741.png",
        "sourceIndex": 1,
        "description": "Four-way junction missing two separated exits, based northeast/west/southwest/southeast.",
        "connections": ["northeast", "west", "southwest", "southeast"],
    },
    {
        "name": "four-opposite-gap",
        "source": "PENUP_20260603_222741.png",
        "sourceIndex": 2,
        "description": "Four-way X junction missing two opposite exits, based west/east/northeast/southwest.",
        "connections": ["west", "east", "northeast", "southwest"],
    },
    {
        "name": "five-way",
        "source": "PENUP_20260603_222741.png",
        "sourceIndex": 4,
        "description": "Five-way junction hub, based east/northeast/northwest/west/southwest.",
        "connections": ["east", "northeast", "northwest", "west", "southwest"],
    },
)


def alpha_components(alpha: Image.Image, min_area: int = 5000) -> list[tuple[int, int, int, int]]:
    """Return connected alpha-component bboxes in reading order."""
    mask = alpha.point(lambda a: 255 if a >= 16 else 0, mode="L").filter(ImageFilter.MaxFilter(21))
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
                q.append((cx + 1, cy))
                q.append((cx - 1, cy))
                q.append((cx, cy + 1))
                q.append((cx, cy - 1))

            if count >= min_area:
                boxes.append((min_x, min_y, max_x + 1, max_y + 1))

    rows: list[list[tuple[int, int, int, int]]] = []
    for box in sorted(boxes, key=lambda b: b[1]):
        center_y = (box[1] + box[3]) / 2
        for row in rows:
            row_center_y = sum((b[1] + b[3]) / 2 for b in row) / len(row)
            if abs(center_y - row_center_y) < 220:
                row.append(box)
                break
        else:
            rows.append([box])

    ordered: list[tuple[int, int, int, int]] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda b: b[0]))
    return ordered


def crop_with_padding(src: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    x0, y0, x1, y1 = box
    padded = (
        max(0, x0 - PADDING),
        max(0, y0 - PADDING),
        min(src.width, x1 + PADDING),
        min(src.height, y1 + PADDING),
    )
    return src.crop(padded)


def crop_to_alpha_bounds(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    if bbox is None:
        return img
    return img.crop(bbox)


def game_tile_mask() -> Image.Image:
    mask = Image.new("L", (TILE_W, TILE_H), 0)
    cx = TILE_W / 2
    cy = TILE_H / 2
    radius = TILE_H / 2
    points = []
    for i in range(6):
        angle = math.radians(60 * i - 90)
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def apply_game_tile_mask(img: Image.Image) -> Image.Image:
    out = img.convert("RGBA")
    mask = game_tile_mask()
    alpha = out.getchannel("A")
    clipped = Image.new("L", out.size, 0)
    alpha_pix = alpha.load()
    mask_pix = mask.load()
    clipped_pix = clipped.load()
    for y in range(out.height):
        for x in range(out.width):
            clipped_pix[x, y] = min(alpha_pix[x, y], mask_pix[x, y])
    out.putalpha(clipped)
    return out


def normalize_to_game_tile(img: Image.Image, connections: list[str] | None = None) -> Image.Image:
    img = crop_to_alpha_bounds(img.convert("RGBA"))
    scale = max(TILE_W / img.width, TILE_H / img.height)
    scaled = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
    tile = Image.new("RGBA", (TILE_W, TILE_H), (0, 0, 0, 0))
    tile.alpha_composite(scaled, ((TILE_W - scaled.width) // 2, (TILE_H - scaled.height) // 2))
    return remove_orange_road_fill(apply_game_tile_mask(tile))


def remove_orange_road_fill(img: Image.Image) -> Image.Image:
    """Keep road markings, but make orange source shoulders transparent."""
    out = img.convert("RGBA")
    pix = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pix[x, y]
            if a == 0:
                continue
            if b < 45 and g >= b and r > 8 and r > g * 1.35:
                pix[x, y] = (0, 0, 0, 0)
    return out


def rotate_game_tile(img: Image.Image, steps: int) -> Image.Image:
    """Rotate road art while preserving the game's pointy-top hex footprint."""
    if steps % 6 == 0:
        return img.copy()
    rotated = img.rotate(-60 * steps, resample=Image.Resampling.BICUBIC, expand=True)
    left = (rotated.width - TILE_W) // 2
    top = (rotated.height - TILE_H) // 2
    tile = Image.new("RGBA", (TILE_W, TILE_H), (0, 0, 0, 0))
    tile.alpha_composite(rotated, (-left, -top))
    return apply_game_tile_mask(tile)


def main() -> None:
    sources: dict[str, tuple[Image.Image, list[tuple[int, int, int, int]]]] = {}
    for source_name in sorted({str(variant["source"]) for variant in VARIANTS}):
        source = INPUT_DIR / source_name
        if not source.is_file():
            raise SystemExit(f"missing input: {source}")
        src = Image.open(source).convert("RGBA")
        boxes = alpha_components(src.getchannel("A"))
        sources[source_name] = (src, boxes)

    raw_dir = OUTPUT_DIR / "rocky-road-variants" / "raw"
    normalized_dir = OUTPUT_DIR / "rocky-road-variants" / "normalized"
    raw_dir.mkdir(parents=True, exist_ok=True)
    normalized_dir.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    metadata = []
    raw_by_name = {}
    normalized_by_name = {}
    for variant in VARIANTS:
        name = variant["name"]
        mirror_of = variant.get("mirrorOf")
        if mirror_of is not None:
            mirror_name = str(mirror_of)
            if mirror_name not in raw_by_name or mirror_name not in normalized_by_name:
                raise SystemExit(f"{name} mirrors {mirror_name}, but {mirror_name} has not been generated yet")
            raw = ImageOps.mirror(raw_by_name[mirror_name])
            normalized = ImageOps.mirror(normalized_by_name[mirror_name])
        else:
            source_name = str(variant["source"])
            src, boxes = sources[source_name]
            source_index = int(variant["sourceIndex"])
            if source_index < 1 or source_index > len(boxes):
                raise SystemExit(f"{source_name} has {len(boxes)} variants; cannot read index {source_index}")
            box = boxes[source_index - 1]
            raw = crop_to_alpha_bounds(crop_with_padding(src, box))
            normalized = normalize_to_game_tile(raw, list(variant["connections"]))
        raw_by_name[name] = raw
        normalized_by_name[name] = normalized
        raw_path = raw_dir / f"{name}.png"
        normalized_path = normalized_dir / f"{name}.png"
        public_path = PUBLIC_DIR / f"{name}.png"
        raw.save(raw_path)
        normalized.save(normalized_path)
        normalized.save(public_path)
        for rotation in range(6):
            rotate_game_tile(normalized, rotation).save(PUBLIC_DIR / f"{name}-r{rotation}.png")
        metadata.append(
            {
                **variant,
                "rawSize": raw.size,
                "tileSize": normalized.size,
                "publicPath": str(public_path.relative_to(ROOT)).replace("\\", "/"),
                "rotations": [
                    str((PUBLIC_DIR / f"{name}-r{rotation}.png").relative_to(ROOT)).replace("\\", "/")
                    for rotation in range(6)
                ],
            }
        )
        print(public_path.relative_to(ROOT))

    metadata_path = PUBLIC_DIR / "variants.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_DIR / "rocky-road-variants" / "README.md").write_text(
        "# Rocky Road Variants\n\n"
        "Generated from `input/PENUP_20260531_204817.png`, "
        "`input/PENUP_20260603_222741.png`, and "
        "`input/PENUP_20260603_222850.png`.\n\n"
        "- `slight-side`: west to northeast\n"
        "- `straight`: west to east\n"
        "- `dead-end`: west only, blocked by rocks\n"
        "- `turn-back`: west to northwest\n\n"
        "Junction variants cover 3-way, 4-way, and 5-way connection codes.\n\n"
        "Normalized sprites are exact `64x74` game-tile PNGs.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
