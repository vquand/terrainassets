# terrainassets

Reusable terrain tile assets for simple games.

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

This repository is intentionally scoped to terrain and tile assets plus the
deterministic map-generation code that produces matching terrain codes and road
variants. Character sprites, weapons, mounts, animals, buildings, and
game-specific UI art should stay in their own repositories or in the consuming
game repository.

The current source game links `sprites/terrain` into
`apps/web/public/sprites/terrain` and imports map generation through the
`@vquand/terrainassets` package.
