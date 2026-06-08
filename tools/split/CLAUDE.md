# tools/split/ - multi-figure sketch splitter

## What this tool does

Takes a single image with several drawings on one sheet (e.g. a PENUP
export, a phone photo of paper) and writes one cropped PNG per figure,
each with an alpha background. Generic split output lands in
`output/`; verified terrain and road outputs can be written into
`sprites/terrain/` and `sprites/roads/`.

## When to use

- You drew a whole "page" of monsters at once and want each one as its
  own sprite-ready PNG.
- Source image has clear whitespace between figures.

Not appropriate for sheets where figures touch or overlap - the splitter
will merge them. Re-draw with more spacing in that case.

## Dependencies

```sh
# One-time setup from the repo root:
python -m venv tools/.venv
tools/.venv/Scripts/python.exe -m pip install -r tools/requirements.txt
```

Pillow is the only Python dep. The venv lives at `tools/.venv/` and is
gitignored.

## Usage

```sh
# Bare filename reads input/<file>:
tools/.venv/Scripts/python.exe tools/split/split.py PENUP_20260524_155607.png

# Or any path:
tools/.venv/Scripts/python.exe tools/split/split.py D:/tmp/sketch.png

# Tuning knobs (defaults work for ~1000×1000 PENUP exports):
tools/.venv/Scripts/python.exe tools/split/split.py sketch.png \
  --threshold 180 \
  --dilate 11 \
  --min-area 800 \
  --padding 12
```

Output lands at `output/<basename>/01.png`, `02.png`, ... in raster
order (top-to-bottom, left-to-right).

## Tuning when the output looks wrong

| Symptom | Adjustment |
|---|---|
| Missing figures (only partial output) | Lower `--threshold` (more pixels read as ink) or lower `--min-area` (don't drop small blobs). |
| Two figures merged into one crop | Lower `--dilate` so the ink stops bridging the gap. |
| One figure split into multiple crops | Raise `--dilate` so the figure's pieces merge. |
| Crops too tight (cutting off strokes) | Raise `--padding`. |
| Noise / page numbers polluting output | Raise `--min-area`. |

## Workflow integration

1. Drop the sheet at `input/<sheet>.png`.
2. Run the splitter. Eyeball `output/<sheet>/`.
3. Rename or move the keepers into their real sprite folder, such as
   `sprites/terrain/` or `sprites/roads/`.
4. Delete `output/<sheet>/` once everything is integrated. It is a
   scratch artifact, not a source of truth.

## Implementation notes

- Pure Pillow + stdlib. No numpy / scipy / OpenCV - the flood-fill scan
  is fast enough for ~1000×1000 sheets and keeps the dep surface tiny.
- Connected-components run on a DILATED mask (so a soldier's body + sword
  merge into one blob) but the actual crop is taken from the ORIGINAL
  image (so the saved PNG keeps the line-art crispness).
