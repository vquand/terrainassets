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
sprites/
  terrain/              terrain tile sprites
    simplified/         simplified terrain tile set
    rock-road/          connected road tile variants
```

The current source game links `sprites/terrain` into
`apps/web/public/sprites/terrain` and imports map generation through the
`@vquand/terrainassets` package.

## Map generation defaults

`generateMap(seed)` creates a full topology map with these defaults:

- Width: `1000`
- Height: `500`
- Depth: `4`
- Topology: `full` sea, land, and weather
- Sea coverage: `30%` of total map cells
- Weather coverage cap: `0.25` of total map cells

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
  weatherCoverageLimit: 0.2,
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
   uses layer `-1`; blocked sea uses layer `-9`. If the topology contains no
   sea, this stage has no effect.

3. Land layers

   The land seed assigns land cells to walkable layers and blocked terrain.
   Default depth `4` produces walkable land layers `1`, `2`, and `3`, plus layer
   `9` for non-walkable cliffs or high mountains. If the topology contains no
   land, this stage has no effect.

4. Weather

   The weather seed places special weather overlays. By default, weather cannot
   cover more than `25%` of the total surface area. Callers can change this with
   `weatherCoverageLimit`.

5. Roads

   Roads are generated on land after terrain and weather. A road can only move
   between walkable land cells, and each step may change by at most one layer:
   `1` to `2`, `2` to `1`, `2` to `3`, or `3` to `2` are valid. Roads cannot
   move to layer `9`, layer `-9`, or sea.

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
http://localhost:5999/?seed=12345&width=120&height=60&depth=4&topology=full&weatherCoverageLimit=0.25
```

The debug page displays the root seed, every per-step derived seed, and the seed
used by each individual generation step. Use `Regenerate` to reload the current
seed and `Reroll` to update the URL with a new root seed.
