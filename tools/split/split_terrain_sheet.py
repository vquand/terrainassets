#!/usr/bin/env python3
"""Split the generated terrain reference sheet into named terrain PNGs.

This is a thin wrapper around tools/split/split.py for sheets whose labels are
close enough to the icons that whole-page connected-component splitting merges
columns. It crops each section into small label-free mini-sheets, runs the
regular splitter on each, then copies the ordered crops into terrain outputs.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import math
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

TOOLS_DIR = Path(__file__).resolve().parent.parent
ROOT = TOOLS_DIR.parent
SPRITES_DIR = ROOT / "sprites"
INPUT_DIR = ROOT / "input"
OUTPUT_DIR = ROOT / "output"
TERRAIN_DIR = SPRITES_DIR / "terrain"
TILE_W = 64
TILE_H = 74
GAME_TILE_OVERDRAW = 1.35
SKIP_PUBLIC_TERRAINS = {"rock-road"}

SOURCE = "ChatGPT Image May 31, 2026, 11_35_33 AM.png"

# Icon-only bands, split into 2/3 icon mini-sheets so the generic
# connected-component splitter never sees labels or a whole text column.
FULL_GROUPS: tuple[tuple[str, tuple[str, ...], tuple[int, int, int, int]], ...] = (
    ("full-row1-a", ("bridge", "desert"), (210, 45, 590, 200)),
    ("full-row1-b", ("forest", "grassland", "lake"), (670, 45, 1325, 200)),
    ("full-row2-a", ("mountain", "rock-road"), (210, 220, 595, 365)),
    ("full-row2-b", ("river", "ruins", "sea"), (670, 220, 1325, 365)),
    ("full-row3-a", ("shallow-water", "snow"), (210, 390, 595, 535)),
    ("full-row3-b", ("storm", "swamp", "volcano"), (670, 390, 1325, 535)),
)

SIMPLIFIED_GROUPS: tuple[tuple[str, tuple[str, ...], tuple[int, int, int, int]], ...] = (
    ("simplified-row1-a", ("bridge", "desert"), (210, 600, 590, 730)),
    ("simplified-row1-b", ("forest", "grassland", "lake"), (670, 600, 1325, 730)),
    ("simplified-row2-a", ("mountain", "rock-road"), (210, 735, 595, 870)),
    ("simplified-row2-b", ("river", "ruins", "sea"), (670, 735, 1325, 870)),
    ("simplified-row3-a", ("shallow-water", "snow"), (210, 875, 595, 990)),
    ("simplified-row3-b", ("storm", "swamp", "volcano"), (670, 875, 1325, 990)),
)


def run_split(mini_path: Path, suffix: str, dilate: int) -> Path:
    out_dir = OUTPUT_DIR / mini_path.stem
    if out_dir.is_dir():
        for old_png in [*out_dir.glob("[0-9][0-9].png"), *out_dir.glob(f"*-{suffix}.png")]:
            old_png.unlink()
    env = dict(**__import__("os").environ, PYTHONIOENCODING="utf-8")
    subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("split.py")),
            str(mini_path),
            "--threshold",
            "245",
            "--dilate",
            str(dilate),
            "--min-area",
            "3000",
            "--padding",
            "8",
        ],
        check=True,
        cwd=ROOT,
        env=env,
    )
    return out_dir


def fill_enclosed_transparency(img: Image.Image) -> Image.Image:
    """Fill transparent regions enclosed by opaque ink with white.

    The splitter makes the white paper transparent. That is correct outside
    each hex, but snow/storm interiors also contain transparent "paper" areas.
    Flood from the image edges to preserve outside transparency, then fill only
    unvisited transparent pixels with opaque white.
    """
    img = img.convert("RGBA")
    w, h = img.size
    pix = img.load()
    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    def transparent(x: int, y: int) -> bool:
        return pix[x, y][3] < 16

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i] or not transparent(x, y):
            continue
        seen[i] = 1
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))

    for y in range(h):
        for x in range(w):
            if transparent(x, y) and not seen[y * w + x]:
                pix[x, y] = (255, 255, 255, 255)

    return img


def keep_largest_alpha_component(img: Image.Image) -> Image.Image:
    """Drop stray text fragments/noise outside the terrain hex."""
    img = img.convert("RGBA")
    w, h = img.size
    pix = img.load()
    seen = bytearray(w * h)
    components: list[list[tuple[int, int]]] = []

    def solid(x: int, y: int) -> bool:
        return pix[x, y][3] >= 16

    for start_y in range(h):
        for start_x in range(w):
            start_i = start_y * w + start_x
            if seen[start_i] or not solid(start_x, start_y):
                continue
            q: deque[tuple[int, int]] = deque([(start_x, start_y)])
            component: list[tuple[int, int]] = []
            while q:
                x, y = q.popleft()
                if x < 0 or y < 0 or x >= w or y >= h:
                    continue
                i = y * w + x
                if seen[i] or not solid(x, y):
                    continue
                seen[i] = 1
                component.append((x, y))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dx != 0 or dy != 0:
                            q.append((x + dx, y + dy))
            components.append(component)

    if not components:
        return img

    keep = set(max(components, key=len))
    for y in range(h):
        for x in range(w):
            if solid(x, y) and (x, y) not in keep:
                r, g, b, _a = pix[x, y]
                pix[x, y] = (r, g, b, 0)

    return img


def crop_to_alpha_bounds(img: Image.Image) -> Image.Image:
    """Remove transparent margins so sprites fill the game tile when scaled."""
    img = img.convert("RGBA")
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


def average_opaque_color(img: Image.Image) -> tuple[int, int, int]:
    img = img.convert("RGBA")
    alpha = img.getchannel("A")
    stat = ImageStat.Stat(img.convert("RGB"), alpha)
    return tuple(int(v) for v in stat.mean[:3])


def to_game_tile_asset(img: Image.Image) -> Image.Image:
    """Convert source art into an exact game-tile sprite.

    The original generated icons have their own transparent hex silhouette.
    Filling a game-sized hex first guarantees transparent source corners never
    reveal the old procedural tile underneath.
    """
    img = crop_to_alpha_bounds(img).convert("RGBA")
    base = Image.new("RGBA", (TILE_W, TILE_H), (*average_opaque_color(img), 255))
    scale = max(TILE_W / img.width, TILE_H / img.height) * GAME_TILE_OVERDRAW
    scaled_size = (round(img.width * scale), round(img.height * scale))
    scaled = img.resize(scaled_size, Image.Resampling.LANCZOS)
    pos = ((TILE_W - scaled.width) // 2, (TILE_H - scaled.height) // 2)
    base.alpha_composite(scaled, pos)
    base.putalpha(game_tile_mask())
    return base


def process_groups(
    src: Image.Image,
    groups: tuple[tuple[str, tuple[str, ...], tuple[int, int, int, int]], ...],
    *,
    mini_dir: Path,
    suffix: str,
    public_dir: Path,
    dilate: int,
) -> list[Path]:
    mini_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    for label, names, box in groups:
        mini_path = mini_dir / f"{label}.png"
        src.crop(box).save(mini_path)
        split_dir = run_split(mini_path, suffix, dilate)
        crops = sorted(split_dir.glob("[0-9][0-9].png"))
        if len(crops) != len(names):
            raise SystemExit(
                f"{label}: expected {len(names)} crops for {names}, got {len(crops)} in {split_dir}"
            )
        for name, crop in zip(names, crops, strict=True):
            treated = split_dir / f"{name}-{suffix}.png"
            img = fill_enclosed_transparency(Image.open(crop))
            treated_img = crop_to_alpha_bounds(keep_largest_alpha_component(img))
            treated_img.save(treated)
            crop.unlink()
            if name in SKIP_PUBLIC_TERRAINS:
                continue
            out = public_dir / f"{name}.png"
            to_game_tile_asset(treated_img).save(out)
            written.append(out)

    return written


def main() -> None:
    source = INPUT_DIR / SOURCE
    if not source.is_file():
        raise SystemExit(f"missing input: {source}")

    src = Image.open(source).convert("RGBA")
    written = [
        *process_groups(
            src,
            FULL_GROUPS,
            mini_dir=OUTPUT_DIR / "terrain-full-mini-sheets",
            suffix="full",
            public_dir=TERRAIN_DIR,
            dilate=5,
        ),
        *process_groups(
            src,
            SIMPLIFIED_GROUPS,
            mini_dir=OUTPUT_DIR / "terrain-simplified-mini-sheets",
            suffix="simplified",
            public_dir=TERRAIN_DIR / "simplified",
            dilate=3,
        ),
    ]

    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
