# terrainassets

Reusable terrain sprites and deterministic terrain-generation utilities for
hex-based strategy games.

## Purpose

This package keeps terrain art and terrain map generation in one reusable place.
Consuming games can link the `sprites/terrain` directory for rendering and import
the TypeScript generator from `@vquand/terrainassets` to create reproducible maps
from a seed.

The repository is intentionally scoped to terrain and tile assets plus the
generation code that produces matching terrain codes, elevation layers, weather
overlays, and connected road variants. Character sprites, weapons, mounts,
buildings, and game-specific UI art should live in their own repositories or in
the consuming game repository.

## Tech stack

- TypeScript with ES module exports.
- Deterministic RNG implemented in `src/rng.ts`.
- Pointy-top odd-r hex-grid math in `src/hex.ts`.
- Terrain and road generation in `src/mapgen.ts`.
- PNG terrain sprites under `sprites/terrain`.

## Layout

```text
src/
  hex.ts                pointy-top odd-r hex grid math
  mapgen.ts             deterministic terrain/map generation
  rng.ts                deterministic RNG used by mapgen
input/                  gitignored raw sprite sheets and temporary inputs
output/                 gitignored splitter output and intermediate files
sprites/
  terrain/              terrain tile sprites
    simplified/         simplified terrain tile set
  weather/              weather and hazard overlay sprites
  roads/                road overlay sprites
    rock-road/          connected road tile variants
tools/
  split/                sprite sheet splitting helpers
```

Map generation keeps terrain and overlays separate: base terrain codes must
resolve to tracked terrain sprites, and generated weather types must resolve to
tracked files in `sprites/weather/`.

The current source game links `sprites/terrain` into
`apps/web/public/sprites/terrain` and imports map generation through the
`@vquand/terrainassets` package.

## Map generation defaults

`generateMap(seed)` creates a full topology map with these defaults:

- Width: `1000`
- Height: `500`
- Depth: `4`
- Topology: `full` sea, land, and weather
- Tile shape: `hex`
- Road density: `0.0964285714` road tiles per land tile
- Sea coverage: `30%` of total map cells
- Blocked sea coverage: `20%` of sea cells
- Blocked land coverage: `10%` of land cells
- Weather coverage cap: `0.035` of total map cells

The legacy-compatible call shape still works:

```ts
import { generateMap } from "@vquand/terrainassets";

const map = generateMap(12345, 80, 40);
```

Use the options form to customize generation:

```ts
const map = generateMap(12345, {
  width: 120,
  height: 60,
  depth: 4,
  topology: "full",
  tileShape: "hex",
  roadDensity: 0.0964285714,
  weatherCoverageLimit: 0.035,
  debug: true,
});
```

## Configurable layering requirement

The generator is divided into deterministic, seedable stages. A root seed derives
per-stage seeds unless a caller passes explicit seed overrides.

1. Land/sea ratio

   The ratio seed creates the initial sea and land mask. By default, sea covers
   `30%` of the total surface and land covers the remaining `70%`. This stage
   does not require sprites. Debug output renders sea as light blue and land as
   light gray.

2. Sea passability

   The sea seed assigns sea cells as either swimmable or blocked. Swimmable sea
   uses layer `-1`; blocked sea uses layer `-9`. By default, blocked sea covers
   `20%` of cells that were already selected as sea, not `20%` of the whole map.
   If the topology contains no sea, this stage has no effect.

3. Land layers

   The land seed assigns land cells to walkable layers and blocked terrain.
   Default depth `4` produces walkable land layers `1`, `2`, and `3`, plus layer
   `9` for non-walkable cliffs or high mountains. The three walkable land
   heights are named in the generated cell data as `plain` (layer `1`), `hill` (layer `2`), and `plateau` (layer `3`). By default, blocked land covers `10%` of cells that were already
   selected as land, not `10%` of the whole map. If the topology contains no
   land, this stage has no effect.

4. Roads

   Roads are generated on land after terrain layers. A road can only move
   between walkable land cells, and each step may change by at most one layer:
   `1` to `2`, `2` to `1`, `2` to `3`, or `3` to `2` are valid. Roads cannot
   move to layer `9`, layer `-9`, or sea. Roads are one tile wide; generation
   must not widen a road into neighboring tiles. `roadDensity` targets the
   number of road overlay tiles divided by the total number of land tiles. The
   default is 1.5 times the density produced by the reference seed
   `ratio=1600779894`, `sea=1557164007`, `land=1924685185`,
   `weather=825734366`, `road=891917556` at `80 x 40`.

5. Weather

   The weather seed places special weather overlays after roads are available,
   so road-aware weather can be constrained by road adjacency. By default,
   weather cannot cover more than `3.5%` of the total surface area. Callers can
   change this with `weatherCoverageLimit`.

   Weather placement is also restricted by local terrain context:

   - `BURNING_GROUND` requires an adjacent `VOLCANO` terrain cell.
   - `EVIL_BURNING_GROUND` requires an adjacent `CEMETARY`, `CEMETERY`,
     `EVIL_BEING`, or `EVIL_BEINGS` terrain cell. These are future-content
     hooks, so this weather type is not emitted by the default terrain set.
   - `RAIN` must be on or near shallow water, river, or lake.
   - `STORM` must be near deep sea.
   - `TORNADO` must be near water and near blocked mountains or cliffs.
   - `DEADLY_TORNADO` must be near roads, blocked mountains, or cliffs.

6. Sprite fill

   The final stage resolves the generated terrain codes and road overlays into
   sprite-ready tile values and renders the PNG assets from `sprites/`. The
   base terrain sprite is rendered first, then any road sprite from
   `sprites/roads/rock-road` is rendered on top. The debug site can display
   either pointy-top hex tiles or square tiles. Hex is the default shape.

## Debug HTML

When debug is enabled, the returned map includes staged snapshots in
`map.debug`. Use `renderMapGenerationDebugHtml` to produce an HTML file that
shows each generation step on a canvas timeline.

```ts
import { generateMap, renderMapGenerationDebugHtml } from "@vquand/terrainassets";

const map = generateMap(12345, { width: 120, height: 60, debug: true });
const html = renderMapGenerationDebugHtml(map);
```

A CLI or consuming app can expose this as a `--debug` flag by writing the HTML
string to disk when the flag is present.

## Local debug server

Run the debug server directly:

```sh
npm install
npm run debug -- --host 0.0.0.0 --port 5999
```

Or run it through Docker:

```sh
docker compose -f docker-compose.debug.yml up --build
```

Open `http://localhost:5999` to inspect the staged generation output. Query
parameters can override generation inputs, for example:

```text
http://localhost:5999/?seed=12345&width=120&height=60&depth=4&topology=full&tileShape=hex&roadDensity=0.0964285714&blockedSeaRatio=0.2&blockedLandRatio=0.1&weatherCoverageLimit=0.035
```

The debug page displays the root seed, every per-step derived seed, and the seed
used by each individual generation step. Use `Regenerate` to reload the current
seed, `Reroll` to update the URL with a new root seed, and the zoom toggle to
switch between fit-to-view and 60px-per-tile rendering. In the land and sprite
views, higher walkable land levels are drawn slightly raised with a brown side
wall. A bold border is drawn only on the raised tile's top surface where it
meets a lower adjacent land tile. The two lower/front hex edges are skipped
because the brown elevated wall already communicates that drop, and the brown
wall itself is not highlighted. Hovering a land tile highlights precomputed
visible boundary edges for the contiguous land area at that same layer,
including visible front cliff edges where raised land drops to a lower level.
If `weatherCoverageLimit` is omitted from the URL, the debug server uses the
same weather coverage default as `generateMap`.
