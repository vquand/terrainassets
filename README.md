# terrainassets

Reusable terrain tile assets for simple games.

## Layout

```text
sprites/
  terrain/              terrain tile sprites
    simplified/         simplified terrain tile set
    rock-road/          connected road tile variants
```

This repository is intentionally scoped to terrain and tile assets. Character
sprites, weapons, mounts, animals, buildings, and game-specific UI art should
stay in their own repositories or in the consuming game repository.

The current source game links `sprites/terrain` into
`apps/web/public/sprites/terrain`.
