/**
 * TILE TRACE BANK
 *
 * Maintains per-tile temporal traces for the top-K tiles of the fine
 * extraction mask. Used by SpatialCoherence and by BeerLambertExtractor's
 * tile-coherent variants to verify that the fused PPG isn't a fluke produced
 * by one rogue tile.
 *
 * Key properties:
 *  - Pre-allocated Float64Array per slot — zero allocations per frame after
 *    bank construction.
 *  - Slot assignment is sticky: if a tile that already has a slot is in the
 *    new top-K, it keeps its slot and trace continuity is preserved. Only
 *    when a new tile pushes out a worse one do we evict.
 *  - Detrended traces are exposed (mean-subtracted on the fly during read)
 *    so consumers don't have to detrend again.
 */

export interface TileSnapshot {
  tileIndex: number;
  /** Linearised green for this tile, this frame. */
  g: number;
  /** Linearised red. */
  r: number;
  /** Composite score that decided ranking. */
  score: number;
}

export class TileTraceBank {
  private readonly K: number;
  private readonly windowLen: number;
  /** Tile index occupying each slot, or -1 if empty. */
  private slotTile: Int32Array;
  /** Last-known score per slot. */
  private slotScore: Float64Array;
  /** Green traces, one per slot (linear). */
  private gTraces: Float64Array[];
  /** Red traces. */
  private rTraces: Float64Array[];
  /** Per-slot ring head. */
  private heads: Int32Array;
  /** Per-slot count (≤ windowLen). */
  private counts: Int32Array;
  /** Reusable detrended view for a slot. */
  private detrendBuf: Float64Array;

  constructor(topK = 6, windowLen = 180) {
    this.K = topK;
    this.windowLen = windowLen;
    this.slotTile = new Int32Array(topK).fill(-1);
    this.slotScore = new Float64Array(topK);
    this.gTraces = Array.from({ length: topK }, () => new Float64Array(windowLen));
    this.rTraces = Array.from({ length: topK }, () => new Float64Array(windowLen));
    this.heads = new Int32Array(topK);
    this.counts = new Int32Array(topK);
    this.detrendBuf = new Float64Array(windowLen);
  }

  /**
   * Update the bank with this frame's top-K tiles. Snapshots must be sorted
   * by score descending (caller's responsibility — the AdaptiveROIMask does
   * this for free as part of fine-mask selection).
   */
  update(snapshots: TileSnapshot[]): void {
    // First pass: keep tiles that are still in the new top-K
    const keep = new Uint8Array(this.K);
    for (let s = 0; s < this.K; s++) {
      const tIdx = this.slotTile[s];
      if (tIdx < 0) continue;
      let stillIn = false;
      for (let i = 0; i < snapshots.length; i++) {
        if (snapshots[i].tileIndex === tIdx) { stillIn = true; break; }
      }
      if (stillIn) keep[s] = 1; else this.slotTile[s] = -1;
    }

    // Second pass: assign new tiles to free slots in score order
    for (let i = 0; i < snapshots.length && i < this.K; i++) {
      const snap = snapshots[i];
      // already in a slot?
      let slot = -1;
      for (let s = 0; s < this.K; s++) {
        if (this.slotTile[s] === snap.tileIndex) { slot = s; break; }
      }
      if (slot < 0) {
        // find empty slot, else evict worst-scoring slot below this snap
        for (let s = 0; s < this.K; s++) {
          if (this.slotTile[s] === -1) { slot = s; break; }
        }
        if (slot < 0) {
          // evict the slot with the lowest *current snapshot* score that is
          // worse than this incoming snap. Since `snapshots` is sorted desc,
          // we always prefer to keep higher-ranked incomings.
          let worst = -1; let worstScore = snap.score;
          for (let s = 0; s < this.K; s++) {
            if (this.slotScore[s] < worstScore) { worstScore = this.slotScore[s]; worst = s; }
          }
          if (worst >= 0) {
            this.slotTile[worst] = -1;
            this.heads[worst] = 0;
            this.counts[worst] = 0;
            slot = worst;
          }
        }
        if (slot < 0) continue; // bank full of better tiles
        // initialise empty trace with current sample
        this.slotTile[slot] = snap.tileIndex;
        this.heads[slot] = 0;
        this.counts[slot] = 0;
      }
      this.slotScore[slot] = snap.score;
      this.pushSample(slot, snap.g, snap.r);
    }
  }

  /** Push a single sample into the ring of slot s. */
  private pushSample(s: number, g: number, r: number): void {
    const h = this.heads[s];
    this.gTraces[s][h] = g;
    this.rTraces[s][h] = r;
    this.heads[s] = (h + 1) % this.windowLen;
    if (this.counts[s] < this.windowLen) this.counts[s]++;
  }

  /** Number of slots currently active (have ≥ minSamples samples). */
  activeSlots(minSamples = 30): number {
    let n = 0;
    for (let s = 0; s < this.K; s++) {
      if (this.slotTile[s] !== -1 && this.counts[s] >= minSamples) n++;
    }
    return n;
  }

  /**
   * Read the last `n` green samples of slot s in chronological order, mean-
   * subtracted. Returns a *view* into a reused buffer — copy if you need to
   * keep it past the next call.
   */
  getDetrendedGreen(s: number, n: number): Float64Array | null {
    const cnt = this.counts[s];
    if (this.slotTile[s] < 0 || cnt < Math.min(n, 30)) return null;
    const len = Math.min(n, cnt);
    const head = this.heads[s];
    const trace = this.gTraces[s];
    const start = (head - len + this.windowLen) % this.windowLen;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const v = trace[(start + i) % this.windowLen];
      this.detrendBuf[i] = v;
      sum += v;
    }
    const mean = sum / len;
    for (let i = 0; i < len; i++) this.detrendBuf[i] -= mean;
    // Return a subview of the right length without copy
    return this.detrendBuf.subarray(0, len);
  }

  /** Same as getDetrendedGreen but for red. */
  getDetrendedRed(s: number, n: number): Float64Array | null {
    const cnt = this.counts[s];
    if (this.slotTile[s] < 0 || cnt < Math.min(n, 30)) return null;
    const len = Math.min(n, cnt);
    const head = this.heads[s];
    const trace = this.rTraces[s];
    const start = (head - len + this.windowLen) % this.windowLen;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const v = trace[(start + i) % this.windowLen];
      this.detrendBuf[i] = v;
      sum += v;
    }
    const mean = sum / len;
    for (let i = 0; i < len; i++) this.detrendBuf[i] -= mean;
    return this.detrendBuf.subarray(0, len);
  }

  /** Materialise all active slot traces (clones) — intended for SpatialCoherence. */
  collectGreenTraces(n: number): Float64Array[] {
    const out: Float64Array[] = [];
    for (let s = 0; s < this.K; s++) {
      const view = this.getDetrendedGreen(s, n);
      if (view) out.push(new Float64Array(view));
    }
    return out;
  }

  reset(): void {
    this.slotTile.fill(-1);
    this.slotScore.fill(0);
    this.heads.fill(0);
    this.counts.fill(0);
    for (let s = 0; s < this.K; s++) {
      this.gTraces[s].fill(0);
      this.rTraces[s].fill(0);
    }
  }
}