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
import { hex, hexesInRange, hexKey, hexLine, neighbor, neighbors, type Hex } from "./hex.js";

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

export type TopologyMode = "full" | "land" | "sea";
export type WeatherType = "STORM" | "SNOW" | "VOLCANO" | "SWAMP";

export interface LayerSeeds {
  readonly ratio: number;
  readonly sea: number;
  readonly land: number;
  readonly weather: number;
  readonly road: number;
}

export interface GenerateMapOptions {
  readonly width?: number;
  readonly height?: number;
  /** Number of terrain depth bands. Default 4 => sea plus walkable land levels 1..3. */
  readonly depth?: number;
  /** full = sea + land + weather, land = land-only, sea = sea-only. */
  readonly topology?: TopologyMode;
  /** Maximum special-weather surface coverage, as a fraction of total cells. Default 0.25. */
  readonly weatherCoverageLimit?: number;
  /** Optional per-step seed overrides. Missing seeds are derived from the root seed. */
  readonly seeds?: Partial<LayerSeeds>;
  /** Capture generation snapshots suitable for renderMapGenerationDebugHtml. */
  readonly debug?: boolean;
}

export interface MapGenerationDebugCell {
  readonly col: number;
  readonly row: number;
  readonly terrain: string;
  readonly layer: number;
  readonly weather?: WeatherType;
  readonly road: boolean;
}

export interface MapGenerationDebugStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly seed: number;
  readonly cells: readonly MapGenerationDebugCell[];
}

export interface MapGenerationDebug {
  readonly seeds: LayerSeeds;
  readonly seaRatio: number;
  readonly steps: readonly MapGenerationDebugStep[];
}

/** One generated map cell. */
export interface MapCell {
  readonly hex: Hex;
  /** Terrain code keying into @undersiege/data terrain (e.g. "GRASSLAND"). */
  terrain: string;
  /** Layer/depth value: -9 = blocked deep sea, -1 = swimmable sea, 1..N = walkable land, 9 = blocked land. */
  layer: number;
  /** Elevation tier retained for existing callers; mirrors positive walkable land layers, 0 for sea, 4 for layer 9. */
  elevation: number;
  /** Optional special weather overlay generated after land/sea layers. */
  weather?: WeatherType;
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
  readonly layerSeeds: LayerSeeds;
  readonly depth: number;
  readonly topology: TopologyMode;
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
  /** Optional staged generation snapshots, present only when debug is enabled. */
  readonly debug?: MapGenerationDebug;
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
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const DEFAULT_SEA_RATIO = 0.3;

interface ResolvedGenerateMapOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly topology: TopologyMode;
  readonly weatherCoverageLimit: number;
  readonly seeds: LayerSeeds;
  readonly debug: boolean;
}

function deriveSeeds(seed: number, overrides: Partial<LayerSeeds> | undefined): LayerSeeds {
  const rng = new Rng(seed);
  return {
    ratio: overrides?.ratio ?? rng.int(1, 0x7fffffff),
    sea: overrides?.sea ?? rng.int(1, 0x7fffffff),
    land: overrides?.land ?? rng.int(1, 0x7fffffff),
    weather: overrides?.weather ?? rng.int(1, 0x7fffffff),
    road: overrides?.road ?? rng.int(1, 0x7fffffff),
  };
}

function resolveGenerateMapOptions(
  seed: number,
  widthOrOptions?: number | GenerateMapOptions,
  height?: number,
  options?: GenerateMapOptions,
): ResolvedGenerateMapOptions {
  const raw = typeof widthOrOptions === "object" ? widthOrOptions : options;
  const width = typeof widthOrOptions === "number" ? widthOrOptions : raw?.width ?? 1000;
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height ?? raw?.height ?? 500)),
    depth: Math.max(2, Math.round(raw?.depth ?? 4)),
    topology: raw?.topology ?? "full",
    weatherCoverageLimit: clamp01(raw?.weatherCoverageLimit ?? 0.25),
    seeds: deriveSeeds(seed, raw?.seeds),
    debug: raw?.debug ?? false,
  };
}

function terrainForLandLayer(layer: number, moisture: number): string {
  if (layer >= 9) return "MOUNTAIN";
  if (layer >= 3) return moisture < 0.35 ? "DESERT" : moisture < 0.65 ? "GRASSLAND" : "FOREST";
  if (layer === 2) return moisture < 0.45 ? "GRASSLAND" : "FOREST";
  if (moisture < 0.22) return "DESERT";
  if (moisture > 0.82) return "SWAMP";
  return moisture > 0.55 ? "FOREST" : "GRASSLAND";
}

function elevationForLayer(layer: number): number {
  if (layer < 0) return 0;
  if (layer >= 9) return 4;
  return layer;
}

function isSeaLayer(layer: number): boolean {
  return layer < 0;
}

function isRoadPassableLayer(layer: number): boolean {
  return layer >= 1 && layer < 9;
}

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
  readonly layer: number[];
  readonly elevation: number[];
  readonly weather: (WeatherType | undefined)[];
  readonly roadConnections: Map<string, Set<number>>;
  readonly debugSteps?: MapGenerationDebugStep[];
}

function captureDebugStep(
  state: MapGenerationState,
  id: string,
  title: string,
  description: string,
  seed: number,
): void {
  if (!state.debugSteps) return;
  const cells: MapGenerationDebugCell[] = [];
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      const i = idxOf(state.width, col, row);
      const weather = state.weather[i];
      cells.push({
        col,
        row,
        terrain: state.terrain[i]!,
        layer: state.layer[i]!,
        road: state.terrain[i] === "ROCK_ROAD",
        ...(weather ? { weather } : {}),
      });
    }
  }
  state.debugSteps.push({ id, title, description, seed, cells });
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
  const { rng, width, height, terrain, layer } = state;
  for (let i = 0; i < path.length; i++) {
    const cell = path[i]!;
    if (!inBoundsOf(width, height, cell.col, cell.row)) continue;
    if (!isRoadPassableLayer(layer[idxOf(width, cell.col, cell.row)]!)) continue;
    if (i > 0) {
      const prev = path[i - 1]!;
      if (
        !inBoundsOf(width, height, prev.col, prev.row) ||
        !isRoadPassableLayer(layer[idxOf(width, prev.col, prev.row)]!) ||
        Math.abs(layer[idxOf(width, prev.col, prev.row)]! - layer[idxOf(width, cell.col, cell.row)]!) > 1
      ) {
        continue;
      }
      connectRoad(state, prev, cell);
    }
    terrain[idxOf(width, cell.col, cell.row)] = "ROCK_ROAD";

    for (const n of neighbors(cell)) {
      if (!inBoundsOf(width, height, n.col, n.row)) continue;
      const ni = idxOf(width, n.col, n.row);
      if (!isRoadPassableLayer(layer[ni]!) || Math.abs(layer[ni]! - layer[idxOf(width, cell.col, cell.row)]!) > 1) {
        continue;
      }
      if (rng.next() < widenChance) terrain[ni] = "ROCK_ROAD";
    }
  }
}

function generateLandAndSeaMask(
  seed: number,
  width: number,
  height: number,
  topology: TopologyMode,
): { terrain: string[]; layer: number[]; elevation: number[]; weather: (WeatherType | undefined)[]; seaRatio: number } {
  const terrain: string[] = new Array(width * height);
  const layer: number[] = new Array(width * height);
  const elevation: number[] = new Array(width * height);
  const weather: (WeatherType | undefined)[] = new Array(width * height).fill(undefined);
  const seaRatio = topology === "land" ? 0 : topology === "sea" ? 1 : DEFAULT_SEA_RATIO;
  const cellCount = width * height;
  const seaTarget = Math.round(cellCount * seaRatio);
  const seaCells = new Set<number>();

  if (seaTarget > 0 && seaTarget < cellCount) {
    const scores: { index: number; value: number }[] = [];
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        scores.push({
          index: idxOf(width, col, row),
          value: perlinNoise(col / 48, row / 48, seed, 5, 0.52),
        });
      }
    }
    scores.sort((a, b) => a.value - b.value || a.index - b.index);
    for (let i = 0; i < seaTarget; i++) seaCells.add(scores[i]!.index);
  }

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = idxOf(width, col, row);
      const isSea = topology === "sea" || (topology === "full" && seaCells.has(i));
      terrain[i] = isSea ? "SEA_MASK" : "LAND_MASK";
      layer[i] = isSea ? -1 : 1;
      elevation[i] = isSea ? 0 : 1;
    }
  }
  return { terrain, layer, elevation, weather, seaRatio };
}

function fillSeaLayers(state: MapGenerationState, seed: number): void {
  const { width, height, terrain, layer, elevation } = state;
  let seaCount = 0;
  for (const value of layer) if (isSeaLayer(value)) seaCount++;
  if (seaCount === 0) return;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = idxOf(width, col, row);
      if (!isSeaLayer(layer[i]!)) continue;
      const depthNoise = perlinNoise(col / 22, row / 22, seed, 4, 0.58);
      const blocked = depthNoise > 0.74;
      layer[i] = blocked ? -9 : -1;
      elevation[i] = 0;
      terrain[i] = blocked ? "SEA" : "SHALLOW_WATER";
    }
  }
}

function fillLandLayers(state: MapGenerationState, seed: number, depth: number): void {
  const { width, height, terrain, layer, elevation } = state;
  let landCount = 0;
  for (const value of layer) if (!isSeaLayer(value)) landCount++;
  if (landCount === 0) return;

  const maxWalkableLayer = Math.max(1, depth - 1);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = idxOf(width, col, row);
      if (isSeaLayer(layer[i]!)) continue;
      const heightNoise = perlinNoise(col / 18, row / 18, seed, 5, 0.54);
      const moisture = perlinNoise(col / 15, row / 15, seed + 1000, 3, 0.6);
      const blocked = heightNoise > 0.9;
      const landLayer = blocked
        ? 9
        : Math.min(maxWalkableLayer, 1 + Math.floor(heightNoise * maxWalkableLayer));
      layer[i] = landLayer;
      elevation[i] = elevationForLayer(landLayer);
      terrain[i] = terrainForLandLayer(landLayer, moisture);
    }
  }
}

function fillWeather(state: MapGenerationState, seed: number, coverageLimit: number): void {
  if (coverageLimit <= 0) return;
  const { rng, width, height, terrain, layer, weather } = state;
  const maxWeatherCells = Math.floor(width * height * coverageLimit);
  if (maxWeatherCells === 0) return;
  const weatherRng = new Rng(seed);
  const types: readonly WeatherType[] = ["STORM", "SNOW", "VOLCANO", "SWAMP"];
  let covered = 0;
  const targetPatches = Math.max(1, Math.round(Math.sqrt(maxWeatherCells) / 2));

  for (let patch = 0; patch < targetPatches && covered < maxWeatherCells; patch++) {
    const center = hex(weatherRng.int(0, width - 1), weatherRng.int(0, height - 1));
    const radius = weatherRng.int(1, Math.max(1, Math.round(Math.min(width, height) * 0.035)));
    const type = weatherRng.pick(types);
    for (const cell of hexesInRange(center, radius)) {
      if (!inBoundsOf(width, height, cell.col, cell.row) || covered >= maxWeatherCells) continue;
      const i = idxOf(width, cell.col, cell.row);
      if (!isRoadPassableLayer(layer[i]!) || weather[i]) continue;
      if (rng.next() > 0.72) continue;
      weather[i] = type;
      terrain[i] = type;
      covered++;
    }
  }
}

function canRoadStep(state: MapGenerationState, from: Hex, to: Hex): boolean {
  if (!inBoundsOf(state.width, state.height, to.col, to.row)) return false;
  const fromLayer = state.layer[idxOf(state.width, from.col, from.row)]!;
  const toLayer = state.layer[idxOf(state.width, to.col, to.row)]!;
  return isRoadPassableLayer(toLayer) && Math.abs(fromLayer - toLayer) <= 1;
}

function findRoadPath(state: MapGenerationState, start: Hex, end: Hex): Hex[] {
  const startLayer = state.layer[idxOf(state.width, start.col, start.row)]!;
  const endLayer = state.layer[idxOf(state.width, end.col, end.row)]!;
  if (!isRoadPassableLayer(startLayer) || !isRoadPassableLayer(endLayer)) return [];

  const queue: Hex[] = [start];
  const cameFrom = new Map<string, Hex | null>([[hexKey(start), null]]);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur.col === end.col && cur.row === end.row) break;
    const nextCells = neighbors(cur).sort(
      (a, b) =>
        hexDistanceForSort(a, end) - hexDistanceForSort(b, end) ||
        Math.abs(a.row - end.row) - Math.abs(b.row - end.row),
    );
    for (const next of nextCells) {
      const key = hexKey(next);
      if (cameFrom.has(key) || !canRoadStep(state, cur, next)) continue;
      cameFrom.set(key, cur);
      queue.push(next);
    }
  }

  const endKey = hexKey(end);
  if (!cameFrom.has(endKey)) return [];
  const path: Hex[] = [];
  let cur: Hex | null = end;
  while (cur) {
    path.push(cur);
    cur = cameFrom.get(hexKey(cur)) ?? null;
  }
  return path.reverse();
}

function hexDistanceForSort(a: Hex, b: Hex): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

function roadCandidates(state: MapGenerationState, minCol: number, maxCol: number): Hex[] {
  const out: Hex[] = [];
  for (let row = 1; row < state.height - 1; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (!inBoundsOf(state.width, state.height, col, row)) continue;
      if (isRoadPassableLayer(state.layer[idxOf(state.width, col, row)]!)) out.push(hex(col, row));
    }
  }
  return out;
}

function drawRoads(state: MapGenerationState): Hex[][] {
  const { rng, width, height, layer } = state;
  const paths: Hex[][] = [];
  const passableCount = layer.reduce((count, value) => count + (isRoadPassableLayer(value) ? 1 : 0), 0);
  if (passableCount === 0) return paths;

  const numPaths = Math.max(1, Math.min(12, Math.floor(height / 50)));
  const left = rng.shuffle(roadCandidates(state, 0, Math.min(width - 1, Math.ceil(width * 0.15))));
  const right = rng.shuffle(roadCandidates(state, Math.max(0, Math.floor(width * 0.85)), width - 1));
  if (left.length === 0 || right.length === 0) return paths;

  for (let p = 0; p < numPaths; p++) {
    const start = left[p % left.length]!;
    const end = right[(p * 7 + rng.int(0, right.length - 1)) % right.length]!;
    const path = findRoadPath(state, start, end);
    if (path.length === 0) continue;
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
      return isRoadPassableLayer(layer[idxOf(width, cell.col, cell.row)]!);
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

/** Generate a map. The same seed and options always yield the same map. */
export function generateMap(seed: number, width: number, height: number): GameMap;
export function generateMap(seed: number, options?: GenerateMapOptions): GameMap;
export function generateMap(
  seed: number,
  widthOrOptions?: number | GenerateMapOptions,
  height?: number,
  options?: GenerateMapOptions,
): GameMap {
  const resolved = resolveGenerateMapOptions(seed, widthOrOptions, height, options);
  const { width, height: mapHeight, depth, topology, weatherCoverageLimit, seeds } = resolved;
  const rng = new Rng(seeds.road);
  const { terrain, layer, elevation, weather, seaRatio } = generateLandAndSeaMask(
    seeds.ratio,
    width,
    mapHeight,
    topology,
  );
  const debugSteps = resolved.debug ? [] : undefined;
  const state: MapGenerationState = {
    rng,
    width,
    height: mapHeight,
    terrain,
    layer,
    elevation,
    weather,
    roadConnections: new Map(),
    ...(debugSteps ? { debugSteps } : {}),
  };
  captureDebugStep(
    state,
    "land-sea-ratio",
    "Land / sea ratio",
    "Seeded mask stage: sea cells are light blue and land cells are light gray before sprites or passability are assigned.",
    seeds.ratio,
  );
  fillSeaLayers(state, seeds.sea);
  captureDebugStep(
    state,
    "sea-passability",
    "Sea passability",
    "Sea stage: swimmable sea is layer -1 and blocked sea is layer -9.",
    seeds.sea,
  );
  fillLandLayers(state, seeds.land, depth);
  captureDebugStep(
    state,
    "land-levels",
    "Land levels",
    "Land stage: walkable land uses layers 1..3 by default and blocked cliffs or mountains use layer 9.",
    seeds.land,
  );
  fillWeather(state, seeds.weather, weatherCoverageLimit);
  captureDebugStep(
    state,
    "weather",
    "Weather",
    "Weather stage: special weather overlays are capped by the configured total-surface coverage limit.",
    seeds.weather,
  );
  const paths = drawRoads(state);
  const idx = (col: number, row: number) => idxOf(width, col, row);
  const inBounds = (col: number, row: number) => inBoundsOf(width, mapHeight, col, row);

  const fallback = firstPassableHex(state) ?? hex(0, 0);
  const mainPath = paths[0] ?? [fallback];

  // Strategic features along the main path.
  const isWater = (cellLayer: number) => cellLayer < 0;

  // Bridges where the route runs alongside water.
  for (let i = 1; i < mainPath.length - 1; i++) {
    const cell = mainPath[i]!;
    const nearWater = neighbors(cell).some(
      (n) => inBounds(n.col, n.row) && isWater(layer[idx(n.col, n.row)]!),
    );
    if (nearWater && rng.next() < 0.3) {
      terrain[idx(cell.col, cell.row)] = "BRIDGE";
    }
  }

  // Clearings near the route, for building.
  const clearings = rng.int(3, 6);
  for (let c = 0; c < clearings; c++) {
    const cx = rng.int(4, width - 5);
    const cy = rng.int(2, mapHeight - 3);
    const nearPath = mainPath.some(
      (pt) => Math.abs(pt.col - cx) <= 3 && Math.abs(pt.row - cy) <= 2,
    );
    if (!nearPath) continue;
    for (const n of [hex(cx, cy), ...neighbors(hex(cx, cy))]) {
      if (!inBounds(n.col, n.row)) continue;
      const t = terrain[idx(n.col, n.row)]!;
      if (isRoadPassableLayer(layer[idx(n.col, n.row)]!) && t !== "ROCK_ROAD" && rng.next() < 0.8) {
        terrain[idx(n.col, n.row)] = "GRASSLAND";
      }
    }
  }

  // Portals: 2–4 edge spawn points, deterministic from `rng`. Min 4-hex
  // separation so they're visibly distinct.
  const portals = generatePortals(rng, width, mapHeight, layer, idx);
  const portalRoads = drawPortalRoads(state, portals, mainPath[mainPath.length - 1]!);
  paths.push(...portalRoads);
  captureDebugStep(
    state,
    "roads",
    "Roads",
    "Road stage: roads only traverse walkable land and can move at most one layer up or down per step.",
    seeds.road,
  );
  const roadTiles = buildRoadTiles(state);

  // Assemble cells.
  const cells: MapCell[] = [];
  for (let row = 0; row < mapHeight; row++) {
    for (let col = 0; col < width; col++) {
      const i = idx(col, row);
      const h = hex(col, row);
      const road = roadTiles.get(hexKey(h));
      const cellWeather = weather[i];
      cells.push(
        road
          ? {
              hex: h,
              terrain: terrain[i]!,
              layer: layer[i]!,
              elevation: elevation[i]!,
              road,
              ...(cellWeather ? { weather: cellWeather } : {}),
            }
          : {
              hex: h,
              terrain: terrain[i]!,
              layer: layer[i]!,
              elevation: elevation[i]!,
              ...(cellWeather ? { weather: cellWeather } : {}),
            },
      );
    }
  }

  return {
    seed,
    layerSeeds: seeds,
    depth,
    topology,
    width,
    height: mapHeight,
    cells,
    paths,
    mainPath,
    spawn: mainPath[0]!,
    capitol: mainPath[mainPath.length - 1]!,
    portals,
    ...(debugSteps ? { debug: { seeds, seaRatio, steps: debugSteps } } : {}),
  };
}

function firstPassableHex(state: MapGenerationState): Hex | undefined {
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      if (isRoadPassableLayer(state.layer[idxOf(state.width, col, row)]!)) return hex(col, row);
    }
  }
  return undefined;
}

export function renderMapGenerationDebugHtml(map: Pick<GameMap, "width" | "height" | "debug">): string {
  if (!map.debug) {
    throw new Error("renderMapGenerationDebugHtml: map was generated without debug snapshots");
  }
  const payload = JSON.stringify({
    width: map.width,
    height: map.height,
    debug: map.debug,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terrain Generation Debug</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; color: #1f2933; background: #f7f8fa; }
    header { padding: 16px 20px; border-bottom: 1px solid #d8dee4; background: #fff; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 73px); }
    nav { padding: 12px; border-right: 1px solid #d8dee4; background: #fff; overflow: auto; }
    button { padding: 10px 12px; border: 1px solid #c8d0d9; border-radius: 6px; background: #fff; cursor: pointer; }
    nav button { width: 100%; margin: 0 0 8px; text-align: left; }
    .nav-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .nav-actions button { margin: 0; text-align: center; font-weight: 600; }
    button.active { border-color: #2364aa; box-shadow: inset 3px 0 0 #2364aa; }
    section { padding: 16px; overflow: auto; }
    canvas { image-rendering: pixelated; width: 100%; max-width: 1400px; background: #fff; border: 1px solid #d8dee4; }
    p { max-width: 900px; line-height: 1.45; }
    .meta { color: #52606d; font-size: 13px; }
    .seed-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .seed-list span, .step-seed { display: inline-block; padding: 3px 6px; border-radius: 4px; background: #eef2f6; color: #334e68; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div>
        <strong>Terrain Generation Debug</strong>
        <div class="meta" id="meta"></div>
      </div>
      <div class="actions">
        <button type="button" id="regenerate">Re-gen current</button>
        <button type="button" id="reroll">Reroll</button>
      </div>
    </div>
    <div class="seed-list" id="seedList"></div>
  </header>
  <main>
    <nav>
      <div class="nav-actions">
        <button type="button" id="regenerateNav">Re-gen</button>
        <button type="button" id="rerollNav">Reroll</button>
      </div>
      <div id="steps"></div>
    </nav>
    <section>
      <h1 id="title"></h1>
      <div class="step-seed" id="stepSeed"></div>
      <p id="description"></p>
      <canvas id="map"></canvas>
    </section>
  </main>
  <script>
    const DATA = ${payload};
    const colors = {
      SEA_MASK: "#b8e7f4",
      LAND_MASK: "#d7dce0",
      SHALLOW_WATER: "#74cbe8",
      SEA: "#256d9b",
      GRASSLAND: "#78a85f",
      FOREST: "#3f7d4b",
      DESERT: "#d3bf73",
      SWAMP: "#637d54",
      MOUNTAIN: "#6b7280",
      STORM: "#5b6172",
      SNOW: "#e8eef4",
      VOLCANO: "#8f3d38",
      ROCK_ROAD: "#8a7352",
      BRIDGE: "#a88458"
    };
    const nav = document.getElementById("steps");
    const meta = document.getElementById("meta");
    const seedList = document.getElementById("seedList");
    const stepSeed = document.getElementById("stepSeed");
    const regenerate = document.getElementById("regenerate");
    const reroll = document.getElementById("reroll");
    const regenerateNav = document.getElementById("regenerateNav");
    const rerollNav = document.getElementById("rerollNav");
    const title = document.getElementById("title");
    const description = document.getElementById("description");
    const canvas = document.getElementById("map");
    const ctx = canvas.getContext("2d");
    canvas.width = DATA.width;
    canvas.height = DATA.height;
    const params = new URLSearchParams(window.location.search);
    const rootSeed = params.get("seed") ?? "12345";
    meta.textContent = \`Root seed \${rootSeed} | Sea ratio \${Math.round(DATA.debug.seaRatio * 100)}% | Size \${DATA.width} x \${DATA.height}\`;
    for (const [name, value] of Object.entries(DATA.debug.seeds)) {
      const item = document.createElement("span");
      item.textContent = \`\${name}: \${value}\`;
      seedList.appendChild(item);
    }

    function regenerateCurrent() {
      window.location.reload();
    }

    function rerollSeed() {
      const next = Math.floor(Math.random() * 2147483647) + 1;
      params.set("seed", String(next));
      window.location.search = params.toString();
    }

    regenerate.addEventListener("click", regenerateCurrent);
    regenerateNav.addEventListener("click", regenerateCurrent);
    reroll.addEventListener("click", rerollSeed);
    rerollNav.addEventListener("click", rerollSeed);

    function colorFor(cell) {
      if (cell.road) return colors.ROCK_ROAD;
      if (cell.terrain in colors) return colors[cell.terrain];
      if (cell.layer === -9) return colors.SEA;
      if (cell.layer === -1) return colors.SHALLOW_WATER;
      if (cell.layer === 9) return colors.MOUNTAIN;
      return colors.GRASSLAND;
    }

    function showStep(index) {
      const step = DATA.debug.steps[index];
      title.textContent = step.title;
      stepSeed.textContent = \`Step seed: \${step.seed}\`;
      description.textContent = step.description;
      const image = ctx.createImageData(DATA.width, DATA.height);
      for (const cell of step.cells) {
        const hex = colorFor(cell).slice(1);
        const offset = (cell.row * DATA.width + cell.col) * 4;
        image.data[offset] = parseInt(hex.slice(0, 2), 16);
        image.data[offset + 1] = parseInt(hex.slice(2, 4), 16);
        image.data[offset + 2] = parseInt(hex.slice(4, 6), 16);
        image.data[offset + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      for (const button of nav.querySelectorAll("button")) button.classList.remove("active");
      nav.querySelector(\`button[data-index="\${index}"]\`).classList.add("active");
    }

    DATA.debug.steps.forEach((step, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(index);
      button.textContent = \`\${index + 1}. \${step.title} | seed \${step.seed}\`;
      button.addEventListener("click", () => showStep(index));
      nav.appendChild(button);
    });
    showStep(0);
  </script>
</body>
</html>`;
}

/** Generate 2–4 portal spawn points on the map edges. */
function generatePortals(
  rng: Rng,
  width: number,
  height: number,
  layer: readonly number[],
  idx: (col: number, row: number) => number,
): Portal[] {
  // Candidate edge tiles per side, ordered so the first finite-cost pick wins.
  const candidates: Record<Portal["edge"], Hex[]> = {
    W: [], E: [], N: [], S: [],
  };
  for (let row = 1; row < height - 1; row++) {
    if (isRoadPassableLayer(layer[idx(0, row)]!)) candidates.W.push(hex(0, row));
    if (isRoadPassableLayer(layer[idx(width - 1, row)]!)) candidates.E.push(hex(width - 1, row));
  }
  for (let col = 1; col < width - 1; col++) {
    if (isRoadPassableLayer(layer[idx(col, 0)]!)) candidates.N.push(hex(col, 0));
    if (isRoadPassableLayer(layer[idx(col, height - 1)]!)) candidates.S.push(hex(col, height - 1));
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
