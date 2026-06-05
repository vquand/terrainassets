// Map generation — ported from legacy-lua/src/mapgen.lua.
//
// Differences from the legacy version, all deliberate:
//  - Fully deterministic: the legacy used Lua's global `math.random` for path
//    widening and feature placement, so a seed did NOT reproduce a map. Here
//    every random choice goes through one seeded `Rng`.
//  - Paths are hex-adjacent BY CONSTRUCTION (shape waypoints joined with
//    `hexLine`), so the legacy `pathValidator` repair pass is unnecessary.
//  - Produces a per-hex `elevation` tier (gameplay-affecting, per the design)
//    — the legacy computed a height field only to pick terrain, then dropped it.
//
// The sin-hash noise is ported verbatim; it is deterministic under V8 (which
// is the only engine we target: browser, Electron, Node).

import { Rng } from "./rng.js";
import { hex, hexKey, hexLine, neighbor, neighbors, type Hex } from "./hex.js";

export type RoadVariant =
  | "straight"
  | "slight-side"
  | "turn-back"
  | "dead-end"
  | "three-adjacent"
  | "three-left-spread"
  | "three-right-spread"
  | "three-alternate"
  | "four-adjacent-gap"
  | "four-spread-gap"
  | "four-opposite-gap"
  | "five-way";

export enum RoadDir {
  E = 0,
  NE = 1,
  NW = 2,
  W = 3,
  SW = 4,
  SE = 5,
}

export enum RoadConnectionCode {
  E = 1 << RoadDir.E,
  NE = 1 << RoadDir.NE,
  NW = 1 << RoadDir.NW,
  W = 1 << RoadDir.W,
  SW = 1 << RoadDir.SW,
  SE = 1 << RoadDir.SE,
  E_NE = E | NE,
  E_NW = E | NW,
  E_W = E | W,
  E_SW = E | SW,
  E_SE = E | SE,
  NE_NW = NE | NW,
  NE_W = NE | W,
  NE_SW = NE | SW,
  NE_SE = NE | SE,
  NW_W = NW | W,
  NW_SW = NW | SW,
  NW_SE = NW | SE,
  W_SW = W | SW,
  W_SE = W | SE,
  SW_SE = SW | SE,
  E_NE_NW = E | NE | NW,
  E_NE_W = E | NE | W,
  E_NE_SW = E | NE | SW,
  E_NE_SE = E | NE | SE,
  E_NW_W = E | NW | W,
  E_NW_SW = E | NW | SW,
  E_NW_SE = E | NW | SE,
  E_W_SW = E | W | SW,
  E_W_SE = E | W | SE,
  E_SW_SE = E | SW | SE,
  NE_NW_W = NE | NW | W,
  NE_NW_SW = NE | NW | SW,
  NE_NW_SE = NE | NW | SE,
  NE_W_SW = NE | W | SW,
  NE_W_SE = NE | W | SE,
  NE_SW_SE = NE | SW | SE,
  NW_W_SW = NW | W | SW,
  NW_W_SE = NW | W | SE,
  NW_SW_SE = NW | SW | SE,
  W_SW_SE = W | SW | SE,
  E_NE_NW_W = E | NE | NW | W,
  E_NE_NW_SW = E | NE | NW | SW,
  E_NE_NW_SE = E | NE | NW | SE,
  E_NE_W_SW = E | NE | W | SW,
  E_NE_W_SE = E | NE | W | SE,
  E_NE_SW_SE = E | NE | SW | SE,
  E_NW_W_SW = E | NW | W | SW,
  E_NW_W_SE = E | NW | W | SE,
  E_NW_SW_SE = E | NW | SW | SE,
  E_W_SW_SE = E | W | SW | SE,
  NE_NW_W_SW = NE | NW | W | SW,
  NE_NW_W_SE = NE | NW | W | SE,
  NE_NW_SW_SE = NE | NW | SW | SE,
  NE_W_SW_SE = NE | W | SW | SE,
  NW_W_SW_SE = NW | W | SW | SE,
  E_NE_NW_W_SW = E | NE | NW | W | SW,
  E_NE_NW_W_SE = E | NE | NW | W | SE,
  E_NE_NW_SW_SE = E | NE | NW | SW | SE,
  E_NE_W_SW_SE = E | NE | W | SW | SE,
  E_NW_W_SW_SE = E | NW | W | SW | SE,
  NE_NW_W_SW_SE = NE | NW | W | SW | SE,
}

export interface RoadTile {
  readonly code: RoadConnectionCode;
  readonly variant: RoadVariant;
  /** Baked rotation asset suffix: `variant-r${rotation}`. */
  readonly rotation: number;
  /** Neighbor directions this visual road connects to: 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE. */
  readonly connections: readonly RoadDir[];
}

/** One generated map cell. */
export interface MapCell {
  readonly hex: Hex;
  /** Terrain code keying into @undersiege/data terrain (e.g. "GRASSLAND"). */
  terrain: string;
  /** Elevation tier 0..4 (0 = sea level). Affects vision/range/movement. */
  elevation: number;
  /** Optional visual road centerline overlay for ROCK_ROAD tiles. */
  road?: RoadTile;
}

/** An enemy spawn point at the edge of the map. */
export interface Portal {
  readonly id: number;
  readonly hex: Hex;
  /** Which edge the portal sits on — informational, not used in pathfinding. */
  readonly edge: "N" | "S" | "E" | "W";
}

/** A fully generated map. */
export interface GameMap {
  readonly seed: number;
  /** Scenario preset id when the map came from a hand-authored layout. */
  readonly preset?: string;
  readonly width: number;
  readonly height: number;
  /** Cells in row-major order: index = row * width + col. */
  readonly cells: readonly MapCell[];
  /** Every generated route, hex-adjacent. */
  readonly paths: readonly (readonly Hex[])[];
  /** The route enemies follow — `paths[0]`. */
  readonly mainPath: readonly Hex[];
  /** Enemy entry point (start of the main path). */
  readonly spawn: Hex;
  /** Player base location (end of the main path). */
  readonly capitol: Hex;
  /** Edge-of-map enemy spawn points; deterministic given the seed. */
  readonly portals: readonly Portal[];
}

/** Look up a cell, or undefined if out of bounds. */
export function cellAt(map: GameMap, col: number, row: number): MapCell | undefined {
  if (col < 0 || row < 0 || col >= map.width || row >= map.height) return undefined;
  return map.cells[row * map.width + col];
}

// --- noise (verbatim port of the legacy sin-hash noise) --------------------

function noise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43758.5453) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number, seed: number): number {
  const corners =
    (noise(x - 1, y - 1, seed) +
      noise(x + 1, y - 1, seed) +
      noise(x - 1, y + 1, seed) +
      noise(x + 1, y + 1, seed)) /
    16;
  const sides =
    (noise(x - 1, y, seed) +
      noise(x + 1, y, seed) +
      noise(x, y - 1, seed) +
      noise(x, y + 1, seed)) /
    8;
  return corners + sides + noise(x, y, seed) / 4;
}

function interpolatedNoise(x: number, y: number, seed: number): number {
  const intX = Math.floor(x);
  const fracX = x - intX;
  const intY = Math.floor(y);
  const fracY = y - intY;
  const v1 = smoothNoise(intX, intY, seed);
  const v2 = smoothNoise(intX + 1, intY, seed);
  const v3 = smoothNoise(intX, intY + 1, seed);
  const v4 = smoothNoise(intX + 1, intY + 1, seed);
  const i1 = v1 * (1 - fracX) + v2 * fracX;
  const i2 = v3 * (1 - fracX) + v4 * fracX;
  return i1 * (1 - fracY) + i2 * fracY;
}

/** Multi-octave noise in roughly [0, 1]. */
function perlinNoise(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  persistence: number,
): number {
  let total = 0;
  let amplitude = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    const frequency = 2 ** i;
    total += interpolatedNoise(x * frequency, y * frequency, seed + i) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
  }
  return total / maxValue;
}

// --- terrain & elevation from the height field -----------------------------

/** Terrain code for a height/moisture pair (verbatim legacy bands). */
function terrainFor(height: number, moisture: number): string {
  if (height < 0.3) {
    if (moisture < 0.4) return "RIVER";
    return moisture < 0.7 ? "LAKE" : "SEA";
  }
  if (height < 0.5) {
    if (moisture < 0.3) return "GRASSLAND";
    return moisture < 0.6 ? "SWAMP" : "FOREST";
  }
  if (height < 0.7) {
    return moisture < 0.5 ? "GRASSLAND" : "FOREST";
  }
  if (height > 0.85) return "MOUNTAIN";
  return moisture < 0.35 ? "DESERT" : moisture < 0.65 ? "GRASSLAND" : "FOREST";
}

/** Elevation tier 0..4 — breakpoints aligned with the terrain bands. */
function elevationFor(height: number): number {
  if (height < 0.3) return 0;
  if (height < 0.5) return 1;
  if (height < 0.7) return 2;
  if (height < 0.85) return 3;
  return 4;
}

// --- route shape templates (verbatim port of ROUTE_SHAPES) -----------------

type ShapeFn = (col: number, startCol: number, endCol: number, startRow: number, endRow: number) => number;

const ROUTE_SHAPES: readonly ShapeFn[] = [
  // Straight line.
  (c, sc, ec, sr, er) => sr + (er - sr) * ((c - sc) / (ec - sc)),
  // Gentle S-curve.
  (c, sc, ec, sr, er) => {
    const p = (c - sc) / (ec - sc);
    return sr + (er - sr) * p + Math.sin(p * Math.PI * 2) * 8;
  },
  // Valley.
  (c, sc, ec, sr, er) => {
    const p = (c - sc) / (ec - sc);
    return sr + (er - sr) * p - Math.sin(p * Math.PI) * 6;
  },
  // Hill.
  (c, sc, ec, sr, er) => {
    const p = (c - sc) / (ec - sc);
    return sr + (er - sr) * p + Math.sin(p * Math.PI) * 5;
  },
  // Zigzag.
  (c, sc, ec, sr, er) => {
    const p = (c - sc) / (ec - sc);
    return sr + (er - sr) * p + Math.sin(p * Math.PI * 6) * 4;
  },
];

// --- generation -------------------------------------------------------------

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));
const idxOf = (width: number, col: number, row: number) => row * width + col;
const inBoundsOf = (width: number, height: number, col: number, row: number) =>
  col >= 0 && row >= 0 && col < width && row < height;

/** Build a shaped, hex-adjacent path from the left edge to the right edge. */
function buildPath(width: number, height: number, startRow: number, endRow: number, shape: ShapeFn): Hex[] {
  const minRow = 1;
  const maxRow = height - 2;
  // One waypoint per column, following the shape.
  const waypoints: Hex[] = [];
  for (let col = 0; col < width; col++) {
    const row = clampInt(shape(col, 0, width - 1, startRow, endRow), minRow, maxRow);
    waypoints.push(hex(col, row));
  }
  // Join waypoints with hex lines — guarantees adjacency.
  const path: Hex[] = [waypoints[0]!];
  for (let i = 1; i < waypoints.length; i++) {
    const seg = hexLine(waypoints[i - 1]!, waypoints[i]!);
    for (let j = 1; j < seg.length; j++) path.push(seg[j]!);
  }
  return path;
}

function joinWaypoints(points: readonly Hex[]): Hex[] {
  if (points.length === 0) return [];
  const out: Hex[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const seg = hexLine(points[i - 1]!, points[i]!);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]!);
  }
  return out;
}

interface MapGenerationState {
  readonly rng: Rng;
  readonly width: number;
  readonly height: number;
  readonly terrain: string[];
  readonly elevation: number[];
  readonly roadConnections: Map<string, Set<number>>;
}

function connectRoad(state: MapGenerationState, a: Hex, b: Hex): void {
  const aDir = directionBetween(a, b);
  const bDir = directionBetween(b, a);
  if (aDir === undefined || bDir === undefined) return;
  const aKey = hexKey(a);
  const bKey = hexKey(b);
  const aSet = state.roadConnections.get(aKey) ?? new Set<number>();
  const bSet = state.roadConnections.get(bKey) ?? new Set<number>();
  aSet.add(aDir);
  bSet.add(bDir);
  state.roadConnections.set(aKey, aSet);
  state.roadConnections.set(bKey, bSet);
}

function directionBetween(from: Hex, to: Hex): number | undefined {
  for (let dir = 0; dir < 6; dir++) {
    const n = neighbor(from, dir);
    if (n.col === to.col && n.row === to.row) return dir;
  }
  return undefined;
}

function addRoadPath(state: MapGenerationState, path: readonly Hex[], widenChance: number): void {
  const { rng, width, height, terrain } = state;
  for (let i = 0; i < path.length; i++) {
    const cell = path[i]!;
    if (!inBoundsOf(width, height, cell.col, cell.row)) continue;
    terrain[idxOf(width, cell.col, cell.row)] = "ROCK_ROAD";
    if (i > 0) connectRoad(state, path[i - 1]!, cell);

    for (const n of neighbors(cell)) {
      if (!inBoundsOf(width, height, n.col, n.row)) continue;
      const ni = idxOf(width, n.col, n.row);
      if (terrain[ni] === "MOUNTAIN") continue;
      if (rng.next() < widenChance) terrain[ni] = "ROCK_ROAD";
    }
  }
}

function generateLandAndSea(seed: number, width: number, height: number): Pick<MapGenerationState, "terrain" | "elevation"> {
  const terrain: string[] = new Array(width * height);
  const elevation: number[] = new Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const h = perlinNoise(col / 10, row / 10, seed, 4, 0.5);
      const m = perlinNoise(col / 8, row / 8, seed + 1000, 3, 0.6);
      const i = idxOf(width, col, row);
      terrain[i] = terrainFor(h, m);
      elevation[i] = elevationFor(h);
    }
  }
  return { terrain, elevation };
}

function fillSeaWithIslands(state: MapGenerationState): void {
  const { rng, width, height, terrain, elevation } = state;
  const islandCount = rng.int(1, 3);
  for (let i = 0; i < islandCount; i++) {
    const center = hex(rng.int(2, width - 3), rng.int(2, height - 3));
    if (terrain[idxOf(width, center.col, center.row)] !== "SEA") continue;
    terrain[idxOf(width, center.col, center.row)] = rng.next() < 0.55 ? "GRASSLAND" : "FOREST";
    elevation[idxOf(width, center.col, center.row)] = 1;
    for (const n of neighbors(center)) {
      if (!inBoundsOf(width, height, n.col, n.row)) continue;
      const ni = idxOf(width, n.col, n.row);
      if (terrain[ni] === "SEA" && rng.next() < 0.45) {
        terrain[ni] = "SHALLOW_WATER";
      }
    }
  }
}

function fillLandElements(_state: MapGenerationState): void {
  // The height/moisture terrain bands currently provide the base land element
  // mix. Keep this stage explicit so more biome passes can be added without
  // entangling road generation.
}

function drawRoads(state: MapGenerationState): Hex[][] {
  const { rng, width, height, terrain } = state;
  const paths: Hex[][] = [];
  const numPaths = Math.max(2, Math.floor(height / 6));
  const minBand = Math.floor(height * 0.3);
  const maxBand = Math.floor(height * 0.7);
  const step = (maxBand - minBand) / (numPaths + 1);

  for (let p = 1; p <= numPaths; p++) {
    const startRow = clampInt(minBand + step * p, minBand, maxBand);
    const endRow = clampInt(minBand + step * (p + rng.int(-1, 1)), minBand, maxBand);
    const shape = ROUTE_SHAPES[(p - 1) % ROUTE_SHAPES.length]!;
    const path = buildPath(width, height, startRow, endRow, shape);
    addRoadPath(state, path, 0.7);
    paths.push(path);
  }

  // Cross-connections: occasionally link two routes.
  for (let col = 4; col < width - 4; col += 8) {
    if (paths.length < 2) break;
    const a = rng.pick(paths);
    let b = rng.pick(paths);
    while (b === a) b = rng.pick(paths);
    const pa = a.find((c) => Math.abs(c.col - col) <= 1);
    const pb = b.find((c) => Math.abs(c.col - col) <= 1);
    if (!pa || !pb) continue;
    const connector = hexLine(pa, pb).filter((cell) => {
      if (!inBoundsOf(width, height, cell.col, cell.row)) return false;
      return terrain[idxOf(width, cell.col, cell.row)] !== "MOUNTAIN";
    });
    addRoadPath(state, connector, 0.6);
  }

  return paths;
}

function drawPortalRoads(state: MapGenerationState, portals: readonly Portal[], capitol: Hex): Hex[][] {
  const { rng, width, height } = state;
  const roads: Hex[][] = [];
  for (const portal of portals) {
    const waypoints: Hex[] = [portal.hex];
    const turns = rng.int(3, 5);
    const rowDelta = capitol.row - portal.hex.row;
    const curveAmp = Math.max(2, Math.round(height * 0.12));
    const wave = rng.pick([-1, 1]);

    for (let i = 1; i <= turns; i++) {
      const t = i / (turns + 1);
      const baseCol = portal.hex.col + (capitol.col - portal.hex.col) * t;
      const baseRow = portal.hex.row + rowDelta * t;
      const lateral = Math.sin(t * Math.PI * 2) * curveAmp * wave;
      const jitter = rng.int(-2, 2);
      const colJitter = rng.int(-1, 1);
      waypoints.push(
        hex(
          clampInt(baseCol + colJitter, 1, width - 2),
          clampInt(baseRow + lateral + jitter, 1, height - 2),
        ),
      );
    }

    waypoints.push(capitol);
    const road = joinWaypoints(waypoints);
    addRoadPath(state, road, 0.35);
    roads.push(road);
  }
  return roads;
}

type RoadTileSpec = Pick<RoadTile, "variant" | "rotation">;

const ROAD_TILE_BY_CONNECTION_CODE: Readonly<Record<RoadConnectionCode, RoadTileSpec>> = {
  // Dead ends. Base art connects west; r1 moves west -> northwest.
  [RoadConnectionCode.W]: { variant: "dead-end", rotation: 0 },
  [RoadConnectionCode.NW]: { variant: "dead-end", rotation: 1 },
  [RoadConnectionCode.NE]: { variant: "dead-end", rotation: 2 },
  [RoadConnectionCode.E]: { variant: "dead-end", rotation: 3 },
  [RoadConnectionCode.SE]: { variant: "dead-end", rotation: 4 },
  [RoadConnectionCode.SW]: { variant: "dead-end", rotation: 5 },

  // Straight roads. Base art connects west <-> east.
  [RoadConnectionCode.E_W]: { variant: "straight", rotation: 0 },
  [RoadConnectionCode.NW_SE]: { variant: "straight", rotation: 1 },
  [RoadConnectionCode.NE_SW]: { variant: "straight", rotation: 2 },

  // Slight-side roads. Base art connects west <-> northeast.
  [RoadConnectionCode.NE_W]: { variant: "slight-side", rotation: 0 },
  [RoadConnectionCode.E_NW]: { variant: "slight-side", rotation: 1 },
  [RoadConnectionCode.NE_SE]: { variant: "slight-side", rotation: 2 },
  [RoadConnectionCode.E_SW]: { variant: "slight-side", rotation: 3 },
  [RoadConnectionCode.W_SE]: { variant: "slight-side", rotation: 4 },
  [RoadConnectionCode.NW_SW]: { variant: "slight-side", rotation: 5 },

  // Tight turn-back roads. Base art connects west <-> northwest.
  [RoadConnectionCode.NW_W]: { variant: "turn-back", rotation: 0 },
  [RoadConnectionCode.NE_NW]: { variant: "turn-back", rotation: 1 },
  [RoadConnectionCode.E_NE]: { variant: "turn-back", rotation: 2 },
  [RoadConnectionCode.E_SE]: { variant: "turn-back", rotation: 3 },
  [RoadConnectionCode.SW_SE]: { variant: "turn-back", rotation: 4 },
  [RoadConnectionCode.W_SW]: { variant: "turn-back", rotation: 5 },

  // Three-way junctions.
  [RoadConnectionCode.NE_NW_W]: { variant: "three-adjacent", rotation: 0 },
  [RoadConnectionCode.E_NE_NW]: { variant: "three-adjacent", rotation: 1 },
  [RoadConnectionCode.E_NE_SE]: { variant: "three-adjacent", rotation: 2 },
  [RoadConnectionCode.E_SW_SE]: { variant: "three-adjacent", rotation: 3 },
  [RoadConnectionCode.W_SW_SE]: { variant: "three-adjacent", rotation: 4 },
  [RoadConnectionCode.NW_W_SW]: { variant: "three-adjacent", rotation: 5 },
  [RoadConnectionCode.E_NE_W]: { variant: "three-left-spread", rotation: 0 },
  [RoadConnectionCode.E_NW_SE]: { variant: "three-left-spread", rotation: 1 },
  [RoadConnectionCode.NE_SW_SE]: { variant: "three-left-spread", rotation: 2 },
  [RoadConnectionCode.E_W_SW]: { variant: "three-left-spread", rotation: 3 },
  [RoadConnectionCode.NW_W_SE]: { variant: "three-left-spread", rotation: 4 },
  [RoadConnectionCode.NE_NW_SW]: { variant: "three-left-spread", rotation: 5 },
  [RoadConnectionCode.E_NW_W]: { variant: "three-right-spread", rotation: 0 },
  [RoadConnectionCode.NE_NW_SE]: { variant: "three-right-spread", rotation: 1 },
  [RoadConnectionCode.E_NE_SW]: { variant: "three-right-spread", rotation: 2 },
  [RoadConnectionCode.E_W_SE]: { variant: "three-right-spread", rotation: 3 },
  [RoadConnectionCode.NW_SW_SE]: { variant: "three-right-spread", rotation: 4 },
  [RoadConnectionCode.NE_W_SW]: { variant: "three-right-spread", rotation: 5 },
  [RoadConnectionCode.NE_W_SE]: { variant: "three-alternate", rotation: 0 },
  [RoadConnectionCode.E_NW_SW]: { variant: "three-alternate", rotation: 1 },

  // Four-way intersections.
  [RoadConnectionCode.NW_W_SW_SE]: { variant: "four-adjacent-gap", rotation: 5 },
  [RoadConnectionCode.NE_NW_W_SW]: { variant: "four-adjacent-gap", rotation: 0 },
  [RoadConnectionCode.E_NE_NW_W]: { variant: "four-adjacent-gap", rotation: 1 },
  [RoadConnectionCode.E_NE_NW_SE]: { variant: "four-adjacent-gap", rotation: 3 },
  [RoadConnectionCode.E_NE_SW_SE]: { variant: "four-adjacent-gap", rotation: 4 },
  [RoadConnectionCode.E_W_SW_SE]: { variant: "four-adjacent-gap", rotation: 4 },
  [RoadConnectionCode.NE_NW_W_SE]: { variant: "four-spread-gap", rotation: 0 },
  [RoadConnectionCode.E_NE_NW_SW]: { variant: "four-spread-gap", rotation: 1 },
  [RoadConnectionCode.E_NE_W_SE]: { variant: "four-spread-gap", rotation: 2 },
  [RoadConnectionCode.E_NW_SW_SE]: { variant: "four-spread-gap", rotation: 3 },
  [RoadConnectionCode.NE_W_SW_SE]: { variant: "four-spread-gap", rotation: 4 },
  [RoadConnectionCode.E_NW_W_SW]: { variant: "four-spread-gap", rotation: 5 },
  [RoadConnectionCode.E_NE_W_SW]: { variant: "four-opposite-gap", rotation: 0 },
  [RoadConnectionCode.E_NW_W_SE]: { variant: "four-opposite-gap", rotation: 1 },
  [RoadConnectionCode.NE_NW_SW_SE]: { variant: "four-opposite-gap", rotation: 2 },

  // Five-way intersections. Base art is missing southeast.
  [RoadConnectionCode.E_NE_NW_W_SW]: { variant: "five-way", rotation: 0 },
  [RoadConnectionCode.E_NE_NW_W_SE]: { variant: "five-way", rotation: 1 },
  [RoadConnectionCode.E_NE_NW_SW_SE]: { variant: "five-way", rotation: 2 },
  [RoadConnectionCode.E_NE_W_SW_SE]: { variant: "five-way", rotation: 3 },
  [RoadConnectionCode.E_NW_W_SW_SE]: { variant: "five-way", rotation: 4 },
  [RoadConnectionCode.NE_NW_W_SW_SE]: { variant: "five-way", rotation: 5 },
};

function roadConnectionCode(connections: ReadonlySet<number>): RoadConnectionCode | undefined {
  let code = 0;
  for (const dir of connections) code |= 1 << dir;
  return code in ROAD_TILE_BY_CONNECTION_CODE ? (code as RoadConnectionCode) : undefined;
}

function roadConnectionsFromCode(code: RoadConnectionCode): RoadDir[] {
  const out: RoadDir[] = [];
  for (let dir = RoadDir.E; dir <= RoadDir.SE; dir++) {
    if ((code & (1 << dir)) !== 0) out.push(dir);
  }
  return out;
}

export function roadTileFor(connections: ReadonlySet<number>): RoadTile | undefined {
  const code = roadConnectionCode(connections);
  if (code === undefined) return undefined;
  const spec = ROAD_TILE_BY_CONNECTION_CODE[code];
  return {
    code,
    ...spec,
    connections: roadConnectionsFromCode(code),
  };
}

export function supportedRoadTiles(): RoadTile[] {
  const out: RoadTile[] = [];
  for (let code = 1; code < 1 << 6; code++) {
    if (!(code in ROAD_TILE_BY_CONNECTION_CODE)) continue;
    const tile = roadTileFor(new Set(roadConnectionsFromCode(code as RoadConnectionCode)));
    if (tile) out.push(tile);
  }
  return out.sort((a, b) => a.connections.length - b.connections.length || a.code - b.code);
}

function buildRoadTiles(state: MapGenerationState): Map<string, RoadTile> {
  const out = new Map<string, RoadTile>();
  for (const [key, connections] of state.roadConnections) {
    const [col, row] = key.split(",").map(Number);
    if (
      col === undefined ||
      row === undefined ||
      !Number.isFinite(col) ||
      !Number.isFinite(row) ||
      !inBoundsOf(state.width, state.height, col, row) ||
      state.terrain[idxOf(state.width, col, row)] !== "ROCK_ROAD"
    ) {
      continue;
    }
    const road = roadTileFor(connections);
    if (road) out.set(key, road);
  }
  return out;
}

export function roadTilesForPaths(paths: readonly (readonly Hex[])[]): Map<string, RoadTile> {
  const connections = new Map<string, Set<number>>();
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1]!;
      const cell = path[i]!;
      const prevDir = directionBetween(prev, cell);
      const cellDir = directionBetween(cell, prev);
      if (prevDir === undefined || cellDir === undefined) continue;
      const prevKey = hexKey(prev);
      const cellKey = hexKey(cell);
      const prevSet = connections.get(prevKey) ?? new Set<number>();
      const cellSet = connections.get(cellKey) ?? new Set<number>();
      prevSet.add(prevDir);
      cellSet.add(cellDir);
      connections.set(prevKey, prevSet);
      connections.set(cellKey, cellSet);
    }
  }

  const out = new Map<string, RoadTile>();
  for (const [key, dirs] of connections) {
    const road = roadTileFor(dirs);
    if (road) out.set(key, road);
  }
  return out;
}

/** Generate a map. The same (seed, width, height) always yields the same map. */
export function generateMap(seed: number, width: number, height: number): GameMap {
  const rng = new Rng(seed);
  const { terrain, elevation } = generateLandAndSea(seed, width, height);
  const state: MapGenerationState = { rng, width, height, terrain, elevation, roadConnections: new Map() };
  fillSeaWithIslands(state);
  fillLandElements(state);
  const paths = drawRoads(state);
  const idx = (col: number, row: number) => idxOf(width, col, row);
  const inBounds = (col: number, row: number) => inBoundsOf(width, height, col, row);

  const mainPath = paths[0]!;

  // Strategic features along the main path.
  const isWater = (t: string) => t === "RIVER" || t === "LAKE" || t === "SEA";

  // Bridges where the route runs alongside water.
  for (let i = 1; i < mainPath.length - 1; i++) {
    const cell = mainPath[i]!;
    const nearWater = neighbors(cell).some(
      (n) => inBounds(n.col, n.row) && isWater(terrain[idx(n.col, n.row)]!),
    );
    if (nearWater && rng.next() < 0.3) {
      terrain[idx(cell.col, cell.row)] = "BRIDGE";
    }
  }

  // Clearings near the route, for building.
  const clearings = rng.int(3, 6);
  for (let c = 0; c < clearings; c++) {
    const cx = rng.int(4, width - 5);
    const cy = rng.int(2, height - 3);
    const nearPath = mainPath.some(
      (pt) => Math.abs(pt.col - cx) <= 3 && Math.abs(pt.row - cy) <= 2,
    );
    if (!nearPath) continue;
    for (const n of [hex(cx, cy), ...neighbors(hex(cx, cy))]) {
      if (!inBounds(n.col, n.row)) continue;
      const t = terrain[idx(n.col, n.row)]!;
      if (t !== "MOUNTAIN" && t !== "SEA" && rng.next() < 0.8) {
        terrain[idx(n.col, n.row)] = "GRASSLAND";
      }
    }
  }

  // Storm patches.
  const storms = rng.int(1, 3);
  for (let s = 0; s < storms; s++) {
    const sx = rng.int(2, width - 3);
    const sy = rng.int(1, height - 2);
    for (const n of [hex(sx, sy), ...neighbors(hex(sx, sy))]) {
      if (!inBounds(n.col, n.row)) continue;
      if (terrain[idx(n.col, n.row)] !== "MOUNTAIN" && rng.next() < 0.6) {
        terrain[idx(n.col, n.row)] = "STORM";
      }
    }
  }

  // Portals: 2–4 edge spawn points, deterministic from `rng`. Min 4-hex
  // separation so they're visibly distinct.
  const portals = generatePortals(rng, width, height, terrain, idx);
  const portalRoads = drawPortalRoads(state, portals, mainPath[mainPath.length - 1]!);
  paths.push(...portalRoads);
  const roadTiles = buildRoadTiles(state);

  // Assemble cells.
  const cells: MapCell[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = idx(col, row);
      const h = hex(col, row);
      const road = roadTiles.get(hexKey(h));
      cells.push(
        road
          ? { hex: h, terrain: terrain[i]!, elevation: elevation[i]!, road }
          : { hex: h, terrain: terrain[i]!, elevation: elevation[i]! },
      );
    }
  }

  return {
    seed,
    width,
    height,
    cells,
    paths,
    mainPath,
    spawn: mainPath[0]!,
    capitol: mainPath[mainPath.length - 1]!,
    portals,
  };
}

/** Generate 2–4 portal spawn points on the map edges. */
function generatePortals(
  rng: Rng,
  width: number,
  height: number,
  terrain: readonly string[],
  idx: (col: number, row: number) => number,
): Portal[] {
  const isImpassable = (t: string) =>
    t === "MOUNTAIN" || t === "SEA" || t === "STORM";

  // Candidate edge tiles per side, ordered so the first finite-cost pick wins.
  const candidates: Record<Portal["edge"], Hex[]> = {
    W: [], E: [], N: [], S: [],
  };
  for (let row = 1; row < height - 1; row++) {
    if (!isImpassable(terrain[idx(0, row)]!)) candidates.W.push(hex(0, row));
    if (!isImpassable(terrain[idx(width - 1, row)]!)) candidates.E.push(hex(width - 1, row));
  }
  for (let col = 1; col < width - 1; col++) {
    if (!isImpassable(terrain[idx(col, 0)]!)) candidates.N.push(hex(col, 0));
    if (!isImpassable(terrain[idx(col, height - 1)]!)) candidates.S.push(hex(col, height - 1));
  }

  const target = rng.int(2, 4);
  const edges: Portal["edge"][] = ["W", "N", "E", "S"]; // try in a fixed order
  const portals: Portal[] = [];
  let id = 0;
  for (let attempt = 0; attempt < target * 4 && portals.length < target; attempt++) {
    const edge = edges[attempt % edges.length]!;
    const pool = candidates[edge];
    if (pool.length === 0) continue;
    const pick = pool[rng.int(0, pool.length - 1)]!;
    const tooClose = portals.some(
      (p) => Math.abs(p.hex.col - pick.col) + Math.abs(p.hex.row - pick.row) < 4,
    );
    if (tooClose) continue;
    portals.push({ id: id++, hex: pick, edge });
  }
  return portals;
}
