// Deterministic pseudo-random number generator.
//
// The entire simulation must draw randomness ONLY through an Rng instance —
// never `Math.random()`, `Date.now()`, or `performance.now()`. Determinism is
// what lets us: (a) regression-test the port against the legacy Lua game with
// a fixed seed, (b) reproduce any bug from its seed, (c) save/restore a game
// mid-run by persisting the rng state.
//
// Algorithm: mulberry32 — a fast 32-bit generator whose entire state is one
// uint32, so save/load is trivial.

/** Hash an arbitrary string seed into a uint32 (xmur3, single step). */
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Rng {
  /** Current internal state (uint32). Persist this to save a game's rng. */
  private state: number;

  constructor(seed: number | string) {
    this.state =
      typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p` (default 0.5). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Pick a uniformly random element; throws on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty array");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Return a new array with the elements shuffled (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Snapshot the rng state for saving. */
  getState(): number {
    return this.state;
  }

  /** Restore a previously snapshotted state. */
  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** A clone positioned at the same state — useful for "what-if" branches. */
  fork(): Rng {
    return new Rng(this.state);
  }
}
