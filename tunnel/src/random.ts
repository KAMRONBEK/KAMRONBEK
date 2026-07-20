/**
 * mulberry32 — a small seeded PRNG. Every source of randomness in a run (jitter,
 * latency, which faults fire) draws from one of these, so a failing seed is a
 * complete, replayable bug report.
 */
/**
 * Client ids for simulated runs. Production uses randomUUID; the simulator needs
 * ids that are a function of the seed, or no run would replay.
 */
export function seededIds(rng: () => number): () => string {
  let n = 0;
  return () =>
    `c-${++n}-${Math.floor(rng() * 0xffff)
      .toString(16)
      .padStart(4, "0")}`;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
