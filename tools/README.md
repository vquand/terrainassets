# Sprite Tools

This folder holds local helper scripts for preparing sprite assets. The tools
are not runtime code.

## Setup

```powershell
python -m venv tools/.venv
tools/.venv/Scripts/python.exe -m pip install -r tools/requirements.txt
```

`tools/.venv/` is ignored by Git.

## Scratch Folders

Raw and intermediate files live in root-level scratch folders:

```text
input/    raw sheets, photos, and temporary source files
output/   generated crops and intermediate output
```

Both folders are ignored by Git, including all subfolders and files.

## Splitter

```powershell
tools/.venv/Scripts/python.exe tools/split/split.py my-sheet.png
```

Passing a bare filename reads from `input/my-sheet.png` and writes to
`output/my-sheet/`.

Specialized splitters:

```powershell
tools/.venv/Scripts/python.exe tools/split/split_terrain_sheet.py
tools/.venv/Scripts/python.exe tools/split/split_rocky_road_sheet.py
tools/.venv/Scripts/python.exe tools/split/split_effect_sheet.py PENUP_20260607_223835.png
```
