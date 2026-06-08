#!/usr/bin/env python3
"""split.py — split a multi-figure sketch into one PNG per figure.

Reads a sheet of drawings with whitespace between figures (a PENUP export,
a phone photo of paper, etc.) and writes one cropped PNG per figure to
output/<basename>/01.png, 02.png, …

Pipeline:
  1. Greyscale + threshold the source -> binary ink mask.
  2. Dilate the ink so nearby strokes of the same figure (e.g. a soldier
     and the sword in their hand) merge into one connected blob.
  3. Flood-fill scan finds each blob's bounding box on the DILATED mask.
  4. Crop the ORIGINAL image to that bbox with a few px of padding,
     convert near-white pixels to transparent, save.

Blobs smaller than --min-area pixels are dropped (scanning noise, page
numbers). Tune via flags if the splitter misses figures or over-merges
adjacent ones.
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageFilter, ImageOps
except ImportError:
    print("split.py: Pillow not installed. From the repo root, run:", file=sys.stderr)
    print("  python -m venv tools/.venv", file=sys.stderr)
    print("  tools\\.venv\\Scripts\\python.exe -m pip install -r tools\\requirements.txt", file=sys.stderr)
    print("Then run via: tools\\.venv\\Scripts\\python.exe tools\\split\\split.py <input>", file=sys.stderr)
    sys.exit(69)

# HEIC/HEIF (iPhone photos). Optional — if pillow-heif isn't installed,
# .heic inputs will fail to open but PNG/JPG still work.
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

TOOLS_DIR = Path(__file__).resolve().parent.parent
ROOT = TOOLS_DIR.parent
SPRITES_DIR = ROOT / "sprites"
INPUT_DIR = ROOT / "input"
OUTPUT_DIR = ROOT / "output"

# Defaults tuned for ~1000×1000 PENUP exports on white paper. Override via CLI.
THRESHOLD = 180     # 0..255; pixels darker than this count as ink
DILATE = 11         # MaxFilter kernel — bigger = more aggressive merging
MIN_AREA = 800      # px²; smaller blobs dropped as noise
PADDING = 12        # px around each crop


def resolve_input(arg: str) -> Path:
    """Bare filename -> input/<arg>. Path-like -> as-is."""
    p = Path(arg)
    if "/" in arg or p.exists():
        return p
    return INPUT_DIR / arg


def find_components(mask: Image.Image, min_area: int):
    """Find connected components in a binary mask (255 = ink).

    Iterative flood fill (no recursion limits, no scipy dependency).
    Returns a list of bounding boxes [(x0, y0, x1, y1)] in raster order.
    """
    w, h = mask.size
    pixels = mask.load()
    visited = bytearray(w * h)
    components = []
    for y in range(h):
        for x in range(w):
            if visited[y * w + x] or pixels[x, y] == 0:
                continue
            stack = [(x, y)]
            minx = maxx = x
            miny = maxy = y
            count = 0
            while stack:
                cx, cy = stack.pop()
                if cx < 0 or cy < 0 or cx >= w or cy >= h:
                    continue
                ci = cy * w + cx
                if visited[ci] or pixels[cx, cy] == 0:
                    continue
                visited[ci] = 1
                count += 1
                if cx < minx: minx = cx
                if cx > maxx: maxx = cx
                if cy < miny: miny = cy
                if cy > maxy: maxy = cy
                stack.append((cx + 1, cy))
                stack.append((cx - 1, cy))
                stack.append((cx, cy + 1))
                stack.append((cx, cy - 1))
            if count >= min_area:
                components.append((minx, miny, maxx + 1, maxy + 1))
    return components


def reading_order(components, line_height: int = 80):
    """Sort components top-to-bottom, then left-to-right within each row.

    Rows are defined by binning the bbox's top edge into `line_height`-tall
    bands so two figures whose tops differ by a few px still count as the
    same row.
    """
    return sorted(components, key=lambda b: (b[1] // line_height, b[0]))


# Endpoints of the alpha ramp, applied to the DARKEST RGB channel of each
# pixel. Pixels lighter than WHITE_FLOOR → fully transparent (clean paper);
# darker than INK_CEILING → fully opaque (definitive ink); in between → a
# linear fade. The "darkest channel" trick keeps saturated colours opaque
# even if their other channels are bright (e.g. pure red 255,0,0 → darkest
# channel = 0 → alpha = 255).
ALPHA_WHITE_FLOOR = 240
ALPHA_INK_CEILING = 100


def to_alpha(img: Image.Image) -> Image.Image:
    """Convert paper background to alpha. Handles both pure white (PNG
    screenshots) and anti-aliased felt-pen edges (smooth fade instead of a
    binary cut). Preserves any pre-existing transparency in the source —
    PENUP exports keep their original alpha when it's stricter than what
    we'd compute from RGB."""
    img = img.convert("RGBA")
    r, g, b, orig_alpha = img.split()

    # Pixel-wise minimum across R, G, B — the "darkest" channel.
    darkness = ImageChops.darker(ImageChops.darker(r, g), b)

    # Linear ramp from WHITE_FLOOR (alpha=0) to INK_CEILING (alpha=255).
    span = ALPHA_WHITE_FLOOR - ALPHA_INK_CEILING
    computed = darkness.point(
        lambda v: max(0, min(255, int((ALPHA_WHITE_FLOOR - v) * 255 / span))),
        mode="L",
    )

    # Keep whichever alpha is stricter (lower). This preserves PENUP's
    # native anti-aliasing while still trimming paper edges from
    # white-background inputs.
    final_alpha = ImageChops.darker(orig_alpha, computed)
    img.putalpha(final_alpha)
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("input", help="filename in input/ or any path")
    ap.add_argument("--threshold", type=int, default=THRESHOLD,
                    help=f"binarisation threshold 0..255 (default {THRESHOLD})")
    ap.add_argument("--dilate", type=int, default=DILATE,
                    help=f"dilation kernel size, odd number (default {DILATE})")
    ap.add_argument("--min-area", type=int, default=MIN_AREA,
                    help=f"min blob area in pixels (default {MIN_AREA})")
    ap.add_argument("--padding", type=int, default=PADDING,
                    help=f"padding around each crop (default {PADDING})")
    ap.add_argument("--autocontrast", action="store_true",
                    help="stretch greyscale histogram before thresholding")
    ap.add_argument("--photo", action="store_true",
                    help="camera-photo mode: treat any pixel that is dark OR "
                         "saturated as ink (handles felt-pen drawings in any "
                         "colour on white paper with uneven lighting). "
                         "Overrides --threshold for the ink test.")
    ap.add_argument("--largest", action="store_true",
                    help="keep only the single largest component (one-subject "
                         "photos — drops every other blob as noise)")
    args = ap.parse_args()

    input_path = resolve_input(args.input)
    if not input_path.is_file():
        print(f"split.py: input not found: {input_path}", file=sys.stderr)
        sys.exit(66)

    basename = input_path.stem
    out_dir = OUTPUT_DIR / basename
    out_dir.mkdir(parents=True, exist_ok=True)

    src = Image.open(input_path)
    src_rgba = src.convert("RGBA")

    # Flatten onto white before greyscaling — otherwise an RGBA source with
    # a transparent background (PENUP exports, anything saved with alpha)
    # turns into all-black under .convert("L") and the splitter sees one
    # giant blob covering the whole sheet.
    if src.mode in ("RGBA", "LA") or "transparency" in src.info:
        flat = Image.new("RGB", src.size, (255, 255, 255))
        flat.paste(src_rgba, mask=src_rgba.split()[-1])
        grey = flat.convert("L")
    else:
        grey = src.convert("L")

    if args.autocontrast:
        grey = ImageOps.autocontrast(grey)
    if args.photo:
        # HSV ink detector: a pixel is "ink" if either:
        #   - its value (brightness) is low → dark felt-pen black, OR
        #   - its saturation is high → coloured felt-pen (red sword, etc).
        # This catches actual drawings on white paper regardless of lighting
        # variation; the noise from paper texture is neither dark nor saturated.
        rgb = src.convert("RGB")
        if args.autocontrast:
            rgb = ImageOps.autocontrast(rgb)
        hsv = rgb.convert("HSV")
        _h, sat, val = hsv.split()
        dark = val.point(lambda v: 255 if v < 150 else 0, mode="L")
        saturated = sat.point(lambda v: 255 if v > 80 else 0, mode="L")
        binarised = ImageChops.lighter(dark, saturated)
    else:
        # Binary mask: ink = 255, paper = 0 (greyscale threshold).
        binarised = grey.point(lambda v: 255 if v < args.threshold else 0, mode="L")
    dilated = binarised.filter(ImageFilter.MaxFilter(args.dilate)) if args.dilate > 1 else binarised

    components = find_components(dilated, args.min_area)
    if args.largest:
        # One-subject photos — keep the single biggest bbox, drop everything
        # else as noise.
        components.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        components = components[:1]
    components = reading_order(components)
    if not components:
        print("split.py: no figures detected - try lowering --threshold or --min-area")
        sys.exit(1)

    print(f"split.py: {input_path} -> {out_dir}/  ({len(components)} figures)")
    for i, (x0, y0, x1, y1) in enumerate(components, start=1):
        x0 = max(0, x0 - args.padding)
        y0 = max(0, y0 - args.padding)
        x1 = min(src_rgba.width, x1 + args.padding)
        y1 = min(src_rgba.height, y1 + args.padding)
        crop = src_rgba.crop((x0, y0, x1, y1))
        out_path = out_dir / f"{i:02d}.png"
        to_alpha(crop).save(out_path)
        print(f"  {out_path.name}  {x1 - x0}x{y1 - y0}")

    print(f"split.py: done - verify in {out_dir}/ and clean up when integrated")


if __name__ == "__main__":
    main()
