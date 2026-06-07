# Asset Inventory

This file tracks terrain, weather, and road sprite coverage. The target layout is:

```text
sprites/
  terrain/   base terrain tiles only
  weather/   transparent weather/effect overlays
  roads/     transparent road overlays and road variant metadata
```

Status legend:

- Present: asset exists in the intended folder.
- Misplaced: asset exists, but should move to a different folder.
- Missing: asset does not exist yet.
- Needs decision: asset exists, but its intended meaning should be clarified before moving or duplicating it.

## Current Folder Gaps

| Folder | Status | Notes |
|---|---|---|
| `sprites/terrain/` | Present | Contains terrain sprites and weather-like sprites today. |
| `sprites/weather/` | Missing | Should contain weather/effect overlays. |
| `sprites/roads/` | Present | Contains road overlays and road variant metadata. |

## Terrain Base Tiles

| Asset | Status | Current path | Target path | Notes |
|---|---|---|---|---|
| `grassland` | Present | `sprites/terrain/grassland.png` | `sprites/terrain/grassland.png` | Base land. |
| `forest` | Present | `sprites/terrain/forest.png` | `sprites/terrain/forest.png` | Base land. |
| `desert` | Present | `sprites/terrain/desert.png` | `sprites/terrain/desert.png` | Base land. |
| `mountain` | Present | `sprites/terrain/mountain.png` | `sprites/terrain/mountain.png` | Blocked or high terrain. |
| `sea` | Present | `sprites/terrain/sea.png` | `sprites/terrain/sea.png` | Deep or blocked sea rendering. |
| `shallow-water` | Present | `sprites/terrain/shallow-water.png` | `sprites/terrain/shallow-water.png` | Swimmable sea rendering. |
| `deep-sea` | Missing | N/A | `sprites/terrain/deep-sea.png` | Optional if `sea.png` should not represent blocked sea. |
| `swamp` | Needs decision | `sprites/terrain/swamp.png` | `sprites/terrain/swamp.png` or `sprites/weather/miasma.png` | Keep as terrain if it is ground; create weather overlay if it is an effect. |
| `snowfield` | Needs decision | `sprites/terrain/snow.png` | `sprites/terrain/snowfield.png` | Rename if this is terrain. If it is weather, move to `sprites/weather/snow.png`. |
| `volcanic` | Needs decision | `sprites/terrain/volcano.png` | `sprites/terrain/volcanic.png` | Current file looks like a terrain/hazard tile, not weather. |
| `ruins` | Present | `sprites/terrain/ruins.png` | `sprites/terrain/ruins.png` | Feature terrain. |
| `lake` | Present | `sprites/terrain/lake.png` | `sprites/terrain/lake.png` | Optional inland water terrain. |
| `river` | Present | `sprites/terrain/river.png` | `sprites/terrain/river.png` | Optional water/feature terrain. |
| `bridge` | Present | `sprites/terrain/bridge.png` | `sprites/terrain/bridge.png` | Optional terrain feature or overlay. |

## Terrain Height Variants

These are useful if plain, hill, and plateau should have different base art instead of relying only on elevation/shadow rendering.

| Asset | Status | Target path |
|---|---|---|
| `grassland-plain` | Missing | `sprites/terrain/grassland-plain.png` |
| `grassland-hill` | Missing | `sprites/terrain/grassland-hill.png` |
| `grassland-plateau` | Missing | `sprites/terrain/grassland-plateau.png` |
| `forest-plain` | Missing | `sprites/terrain/forest-plain.png` |
| `forest-hill` | Missing | `sprites/terrain/forest-hill.png` |
| `forest-plateau` | Missing | `sprites/terrain/forest-plateau.png` |
| `desert-plain` | Missing | `sprites/terrain/desert-plain.png` |
| `desert-hill` | Missing | `sprites/terrain/desert-hill.png` |
| `desert-plateau` | Missing | `sprites/terrain/desert-plateau.png` |

## Blocked Terrain And Passability

| Asset | Status | Current path | Target path | Notes |
|---|---|---|---|---|
| `mountain-blocked` | Missing | N/A | `sprites/terrain/mountain-blocked.png` | Optional explicit blocked land tile. |
| `cliff-blocked` | Missing | N/A | `sprites/terrain/cliff-blocked.png` | Optional explicit cliff tile. |
| `deep-sea-blocked` | Missing | N/A | `sprites/terrain/deep-sea-blocked.png` | Optional explicit blocked sea tile. |

## Weather Overlays

Weather sprites should be transparent overlays in `sprites/weather/`, not base terrain tiles.

| Asset | Status | Current path | Target path | Notes |
|---|---|---|---|---|
| `rain` | Missing | N/A | `sprites/weather/rain.png` | Movement/visibility penalty candidate. |
| `storm` | Misplaced | `sprites/terrain/storm.png` | `sprites/weather/storm.png` | Move if it is an overlay effect. |
| `snow` | Needs decision | `sprites/terrain/snow.png` | `sprites/weather/snow.png` | Move if weather overlay; otherwise rename terrain to `snowfield.png`. |
| `fog` | Missing | N/A | `sprites/weather/fog.png` | Visibility penalty candidate. |
| `sandstorm` | Missing | N/A | `sprites/weather/sandstorm.png` | Desert weather candidate. |
| `heatwave` | Missing | N/A | `sprites/weather/heatwave.png` | Desert/volcanic attrition candidate. |
| `ashfall` | Missing | N/A | `sprites/weather/ashfall.png` | Volcano-adjacent weather candidate. |
| `miasma` | Missing | N/A | `sprites/weather/miasma.png` | Swamp/ruins poison effect candidate. |
| `blizzard` | Missing | N/A | `sprites/weather/blizzard.png` | Snow/mountain severe weather candidate. |
| `thunderstorm` | Missing | N/A | `sprites/weather/thunderstorm.png` | Storm variant with lightning candidate. |

## Road Overlays

Road sprites should be transparent overlays in `sprites/roads/`, not terrain sprites.

| Asset | Status | Current path | Target path | Notes |
|---|---|---|---|---|
| `rock-road.png` | Present | `sprites/roads/rock-road.png` | `sprites/roads/rock-road.png` | Single fallback road tile. |
| `rock-road` variants | Present | `sprites/roads/rock-road/` | `sprites/roads/rock-road/` | Includes rotated connection variants and `variants.json`. |
| `variants.json` | Present | `sprites/roads/rock-road/variants.json` | `sprites/roads/rock-road/variants.json` | Road lookup metadata. |

## Optional Transition Tiles

These are not required for version one, but they would improve map readability.

| Asset group | Status | Target path pattern | Notes |
|---|---|---|---|
| Coast edges | Missing | `sprites/terrain/coast-*.png` | Land/sea transitions. |
| Cliff edge overlays | Missing | `sprites/terrain/cliff-*.png` | Could replace canvas-drawn fake 3D later. |
| River banks | Missing | `sprites/terrain/river-bank-*.png` | River/land transitions. |
| Forest edges | Missing | `sprites/terrain/forest-edge-*.png` | Softer biome boundaries. |
| Mountain edges | Missing | `sprites/terrain/mountain-edge-*.png` | Clearer blocked terrain boundaries. |

## Migration Tasks

1. Create `sprites/weather/`.
2. Decide whether `snow.png`, `storm.png`, `swamp.png`, and `volcano.png` are terrain bases or weather overlays.
3. Add missing weather overlays as transparent sprites.
