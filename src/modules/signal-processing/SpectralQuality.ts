/**
 * SPECTRAL QUALITY ESTIMATOR
 *
 * Lightweight spectral SQI for a single PPG candidate trace.
 * Uses a Goertzel-style narrowband DFT instead of a full FFT — we only need
 * power at ~30 frequencies inside the cardiac band (0.6–3.5 Hz), so an O(N·K)
 * Goertzel with K=30 is ~5–10× cheaper than an O(N log N) FFT and avoids the
 * allocation of complex twiddle tables every window.
 *
 * Outputs (all 0..1 unless noted):
 *  - dominantFreqHz : peak frequency inside the cardiac band
 *  - peakSharpness  : (peak power - median power) / peak power
 *  - bandRatio      : in-band power / total power, 0..1
 *  - harmonicRatio  : power at 2×dominant / power at dominant
 *  - freqStability  : 1 - |f_now - f_prev| / f_prev (EWMA)
 *  - score          : weighted combo, 0..1 — primary spectral SQI scalar
 *
 * The estimator is stateful so freqStability is meaningful across calls.
 */

export interface SpectralQualityResult {
  dominantFreqHz: number;
  peakSharpness: number;
  bandRatio: number;
  harmonicRatio: number;
  freqStability: number;
  score: number; // 0..1
}

const NULL_RESULT: SpectralQualityResult = Object.freeze({
  dominantFreqHz: 0, peakSharpness: 0, bandRatio: 0,
  harmonicRatio: 0, freqStability: 0, score: 0,
});

export class SpectralQuality {
  private prevDominant = 0;
  private freqStabilityEMA = 0;

  /** Min/max BPM defining the cardiac band. */
  private readonly MIN_HZ = 0.6;   // 36 bpm
  private readonly MAX_HZ = 3.5;   // 210 bpm
  private readonly N_BINS = 30;    // ≈0.1 Hz resolution

  /**
   * Compute spectral SQI for the last `samples.length` uniformly-sampled
   * values at fs Hz. Returns a frozen NULL_RESULT for too-short inputs to
   * avoid noisy peaks dominating the scorer.
   */
  estimate(samples: ArrayLike<number>, fs: number): SpectralQualityResult {
    const n = samples.length;
    if (n < Math.max(64, fs * 2) || fs < 5) return NULL_RESULT;

    // Detrend (remove DC)
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;

    // Goertzel for K bins inside cardiac band + a few out-of-band bins
    // (for bandRatio normalization).
    const minHz = this.MIN_HZ, maxHz = Math.min(this.MAX_HZ, fs * 0.45);
    const step = (maxHz - minHz) / (this.N_BINS - 1);

    let inBandTotal = 0;
    let peakPower = 0;
    let peakHz = 0;
    const powers = new Float64Array(this.N_BINS);

    for (let k = 0; k < this.N_BINS; k++) {
      const fHz = minHz + k * step;
      const omega = 2 * Math.PI * fHz / fs;
      const coeff = 2 * Math.cos(omega);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        s0 = (samples[i] - mean) + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      powers[k] = power;
      inBandTotal += power;
      if (power > peakPower) { peakPower = power; peakHz = fHz; }
    }

    // Coarse out-of-band reference: 4 bins below and above the cardiac band
    let oobTotal = 0; let oobN = 0;
    const oobLow = [0.15, 0.25, 0.35, 0.45];
    const oobHigh = [4.0, 4.5, 5.0, 5.5];
    for (const fHz of oobLow.concat(oobHigh)) {
      if (fHz >= fs * 0.45) continue;
      const omega = 2 * Math.PI * fHz / fs;
      const coeff = 2 * Math.cos(omega);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = (samples[i] - mean) + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      oobTotal += s1 * s1 + s2 * s2 - coeff * s1 * s2;
      oobN++;
    }

    const totalPower = inBandTotal + oobTotal + 1e-9;
    const bandRatio = inBandTotal / totalPower;

    // Peak sharpness: 1 - median/peak inside the band
    const sortedCopy = Array.from(powers).sort((a, b) => a - b);
    const medianPower = sortedCopy[Math.floor(this.N_BINS / 2)];
    const peakSharpness = peakPower > 0 ? Math.max(0, 1 - medianPower / peakPower) : 0;

    // Harmonic ratio: power near 2×peakHz vs peak power
    let harmonicRatio = 0;
    if (peakHz > 0 && 2 * peakHz < fs * 0.45) {
      const omega = 2 * Math.PI * (2 * peakHz) / fs;
      const coeff = 2 * Math.cos(omega);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = (samples[i] - mean) + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const harmPower = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      harmonicRatio = peakPower > 0 ? Math.min(1, harmPower / peakPower) : 0;
    }

    // Frequency stability (EWMA of |Δf|/f_prev)
    let stability = 1;
    if (this.prevDominant > 0 && peakHz > 0) {
      stability = Math.max(0, 1 - Math.abs(peakHz - this.prevDominant) / this.prevDominant);
    }
    this.freqStabilityEMA = this.freqStabilityEMA * 0.7 + stability * 0.3;
    this.prevDominant = peakHz;

    const score = Math.max(0, Math.min(1,
      bandRatio * 0.35 +
      peakSharpness * 0.30 +
      this.freqStabilityEMA * 0.20 +
      harmonicRatio * 0.15
    ));

    return {
      dominantFreqHz: peakHz,
      peakSharpness,
      bandRatio,
      harmonicRatio,
      freqStability: this.freqStabilityEMA,
      score,
    };
  }

  reset(): void {
    this.prevDominant = 0;
    this.freqStabilityEMA = 0;
  }

  getDominantFreqHz(): number { return this.prevDominant; }
}