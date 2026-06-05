// Hex-grid coordinate math.
//
// The map is a POINTY-TOP hex grid stored in a rectangular array, addressed by
// "odd-r" OFFSET coordinates { col, row } — the same layout the legacy game
// and its map generator used (see legacy-lua/src/hexgrid.lua, mapgen.lua; the
// legacy axial conversion `q = x - (y - y%2)/2` is exactly odd-r).
//
// All algorithms work in CUBE coordinates internally — the standard, correct
// hex model (reference: redblobgames.com/grids/hexagons). This DELIBERATELY
// replaces the legacy `Math.calculateHexDistance`, whose formula was
// non-standard and roughly doubled distances. `math.hexDistance` keeps the
// legacy formula verbatim for bug-compatible callers; new simulation code
// should use `hexDistance` from this module.
//
// Pixel/screen projection lives in the renderer (apps/web), not here — the
// simulation only deals in abstract grid coordinates.

/** Offset coordinate — the storage / identity coordinate of a map cell. */
export interface Hex {
  readonly col: number;
  readonly row: number;
}

/** Cube coordinate — used internally for all hex algorithms. q + r + s === 0. */
interface Cube {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

/** Construct a hex from offset coordinates. */
export function hex(col: number, row: number): Hex {
  return { col, row };
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.col === b.col && a.row === b.row;
}

/** Stable string key for using hexes as Map/Set keys. */
export function hexKey(h: Hex): string {
  return `${h.col},${h.row}`;
}

/** odd-r offset -> cube. */
function toCube(h: Hex): Cube {
  const q = h.col - (h.row - (h.row & 1)) / 2;
  const r = h.row;
  return { q, r, s: -q - r };
}

/** cube -> odd-r offset. */
function fromCube(c: Cube): Hex {
  return { col: c.q + (c.r - (c.r & 1)) / 2, row: c.r };
}

// The six neighbour directions, in cube space, ordered clockwise from "east".
const CUBE_DIRECTIONS: readonly Cube[] = [
  { q: 1, r: 0, s: -1 },
  { q: 1, r: -1, s: 0 },
  { q: 0, r: -1, s: 1 },
  { q: -1, r: 0, s: 1 },
  { q: -1, r: 1, s: 0 },
  { q: 0, r: 1, s: -1 },
];

/** Number of neighbours every hex has. */
export const NEIGHBOR_COUNT = 6;

function addCube(a: Cube, b: Cube): Cube {
  return { q: a.q + b.q, r: a.r + b.r, s: a.s + b.s };
}

/** The neighbour of `h` in direction `dir` (0..5; wraps for any integer). */
export function neighbor(h: Hex, dir: number): Hex {
  const d = CUBE_DIRECTIONS[((dir % 6) + 6) % 6]!;
  return fromCube(addCube(toCube(h), d));
}

/** All six neighbours of `h`, ordered by direction. */
export function neighbors(h: Hex): Hex[] {
  const c = toCube(h);
  return CUBE_DIRECTIONS.map((d) => fromCube(addCube(c, d)));
}

/** Distance between two hexes, measured in grid steps. */
export function hexDistance(a: Hex, b: Hex): number {
  const ca = toCube(a);
  const cb = toCube(b);
  return (
    (Math.abs(ca.q - cb.q) +
      Math.abs(ca.r - cb.r) +
      Math.abs(ca.s - cb.s)) /
    2
  );
}

/** True if `a` and `b` are adjacent (exactly one step apart). */
export function isAdjacent(a: Hex, b: Hex): boolean {
  return hexDistance(a, b) === 1;
}

/** Every hex within `radius` steps of `center`, inclusive of `center`. */
export function hexesInRange(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  if (radius < 0) return out;
  const c = toCube(center);
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) {
      out.push(fromCube(addCube(c, { q: dq, r: dr, s: -dq - dr })));
    }
  }
  return out;
}

/** The hexes at exactly `radius` steps from `center` (a hollow ring). */
export function hexRing(center: Hex, radius: number): Hex[] {
  if (radius <= 0) return [{ col: center.col, row: center.row }];
  const out: Hex[] = [];
  const c = toCube(center);
  // Start `radius` steps along direction 4, then walk the six sides.
  let cur = addCube(c, {
    q: CUBE_DIRECTIONS[4]!.q * radius,
    r: CUBE_DIRECTIONS[4]!.r * radius,
    s: CUBE_DIRECTIONS[4]!.s * radius,
  });
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push(fromCube(cur));
      cur = addCube(cur, CUBE_DIRECTIONS[side]!);
    }
  }
  return out;
}

/** Round fractional cube coordinates to the nearest valid hex. */
function cubeRound(q: number, r: number, s: number): Cube {
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  else rs = -rq - rr;
  return { q: rq, r: rr, s: rs };
}

/**
 * The straight line of hexes from `a` to `b` inclusive — useful for
 * line-of-sight and projectile paths. Length is `hexDistance(a, b) + 1`.
 */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  if (n === 0) return [{ col: a.col, row: a.row }];
  const ca = toCube(a);
  const cb = toCube(b);
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(
      fromCube(
        cubeRound(
          ca.q + (cb.q - ca.q) * t,
          ca.r + (cb.r - ca.r) * t,
          ca.s + (cb.s - ca.s) * t,
        ),
      ),
    );
  }
  return out;
}
