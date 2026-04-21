/**
 * SPATIAL COHERENCE ESTIMATOR
 *
 * Quantifies how much the per-tile traces agree with the fused/reference PPG
 * trace. Pulse from a real finger should be in-phase across all valid tiles
 * inside the contact blob — fingerprints, motion or background contamination
 * cause large parts of the mask to drift out of phase. We exploit that.
 *
 * Output is a 0..1 coherence score that downstream uses both as a global SQI
 * factor and as a per-tile weight to refine the fine extraction mask.
 *
 * Method: Pearson correlation between every active tile trace (last N samples)
 * and the fused reference trace, masked by per-tile quality. Tiles with too
 * few samples or near-constant traces are skipped (not penalized).
 */

export interface SpatialCoherenceResult {
  /** Mean correlation across active tiles, in [0,1] (negative correlations clipped). */
  meanCoherence: number;
  /** Fraction of active tiles whose correlation with the reference > 0.5. */
  inPhaseFraction: number;
  /** Per-tile correlation (length = activeTiles.length). */
  perTile: Float64Array;
}

const EMPTY: SpatialCoherenceResult = Object.freeze({
  meanCoherence: 0,
  inPhaseFraction: 0,
  perTile: new Float64Array(0),
});

export class SpatialCoherence {
  /**
   * @param tileTraces  array of Float64Array, each containing the last N samples
   *                    of one active tile (already detrended preferred).
   * @param reference   Float64Array of the fused reference signal (same N).
   */
  estimate(tileTraces: Float64Array[], reference: Float64Array): SpatialCoherenceResult {
    const T = tileTraces.length;
    const N = reference.length;
    if (T === 0 || N < 30) return EMPTY;

    // Pre-compute reference statistics
    let mR = 0;
    for (let i = 0; i < N; i++) mR += reference[i];
    mR /= N;
    let varR = 0;
    for (let i = 0; i < N; i++) { const d = reference[i] - mR; varR += d * d; }
    if (varR < 1e-9) return EMPTY;
    const sdR = Math.sqrt(varR);

    const out = new Float64Array(T);
    let sumCoh = 0;
    let inPhase = 0;
    let counted = 0;

    for (let t = 0; t < T; t++) {
      const trace = tileTraces[t];
      if (!trace || trace.length < N) continue;
      let mT = 0;
      for (let i = 0; i < N; i++) mT += trace[i];
      mT /= N;
      let varT = 0; let cov = 0;
      for (let i = 0; i < N; i++) {
        const dt = trace[i] - mT;
        const dr = reference[i] - mR;
        varT += dt * dt;
        cov += dt * dr;
      }
      if (varT < 1e-9) continue;
      const r = cov / (Math.sqrt(varT) * sdR);
      out[t] = r;
      const clipped = Math.max(0, r); // negative phase contributes 0, not penalty
      sumCoh += clipped;
      if (r > 0.5) inPhase++;
      counted++;
    }

    if (counted === 0) return EMPTY;
    return {
      meanCoherence: sumCoh / counted,
      inPhaseFraction: inPhase / counted,
      perTile: out,
    };
  }
}