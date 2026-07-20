interface Timer {
  id: number;
  at: number;
  /** Insertion order, used to break ties so equal deadlines fire deterministically. */
  ord: number;
  fn: () => void;
}

/**
 * Virtual time. Nothing in the queue reads the wall clock, so a run is a pure
 * function of its seed and its fault script — the same seed replays the same
 * interleaving on any machine, and data/trace.json is byte-identical between
 * runs. (The rendered SVG additionally carries a provenance line keyed to the
 * commit, so it is reproducible per commit rather than across all of them.)
 */
export class VirtualClock {
  #now = 0;
  #ord = 0;
  #nextId = 1;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#timers.push({ id, at: this.#now + Math.max(0, delayMs), ord: this.#ord++, fn });
    return id;
  }

  clearTimeout(id: number): void {
    const i = this.#timers.findIndex((t) => t.id === id);
    if (i >= 0) this.#timers.splice(i, 1);
  }

  #takeEarliest(): Timer | undefined {
    if (this.#timers.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.#timers.length; i++) {
      const a = this.#timers[i];
      const b = this.#timers[best];
      if (a.at < b.at || (a.at === b.at && a.ord < b.ord)) best = i;
    }
    return this.#timers.splice(best, 1)[0];
  }

  /** Drain every timer due at or before `horizonMs`, in deadline order. */
  runUntilIdle(horizonMs: number): void {
    for (;;) {
      const next = this.#takeEarliest();
      if (!next) break;
      if (next.at > horizonMs) {
        this.#timers.push(next);
        break;
      }
      this.#now = next.at;
      next.fn();
    }
    if (this.#now < horizonMs) this.#now = horizonMs;
  }
}
