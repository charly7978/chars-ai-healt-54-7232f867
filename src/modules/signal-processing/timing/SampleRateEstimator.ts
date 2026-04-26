/**
 * SampleRateEstimator
 * --------------------
 * Robust, allocation-light estimator for the effective camera frame rate.
 *
 *   • Primary input: real frame timestamps (ms, monotonic).
 *   • Fallback: when no timestamp is supplied the caller can pass
 *     `performance.now()` — keeps a real monotonic clock instead of cold
 *     starting at 30 fps.
 *   • Outlier rejection: median + MAD (·3 by default), tunable.
 *   • Stall detection: if no NEW timestamp arrives within `stallTimeoutMs`,
 *     OR a single inter-frame gap exceeds `gapTimeoutMs`, the estimator
 *     freezes at the last trusted SR and reports `stalled = true` until at
 *     least `recoveryFrames` plausible deltas have arrived again.
 *   • Auto-calibration: feed timestamps for ~`calibrationDurationMs` and
 *     call `finishCalibration()` to derive a window length and outlier
 *     factor from the observed jitter (CoV of inter-frame deltas).
 */

export interface SampleRateEstimatorOptions {
  /** Hard min/max accepted SR (Hz). */
  minSR?: number;
  maxSR?: number;
  /** Min/max plausible inter-frame deltas (ms). */
  minDeltaMs?: number;
  maxDeltaMs?: number;
  /** Sliding window of last N inter-frame deltas. Auto-tuned by calibration. */
  windowSize?: number;
  /** EMA factor smoothing instant SR against cached SR (0..1). */
  smoothing?: number;
  /** Outlier rejection: keep deltas in [median ± madFactor·MAD]. */
  madFactor?: number;
  /** Min plausible deltas required to update the estimate. */
  minDeltasForUpdate?: number;
  /** Max time without any new timestamp before declaring a stall (ms). */
  stallTimeoutMs?: number;
  /** Single-gap threshold that immediately triggers a stall (ms). */
  gapTimeoutMs?: number;
  /** Consecutive plausible deltas required to clear stall. */
  recoveryFrames?: number;
  /** Default SR returned before any data has been observed. */
  defaultSR?: number;
}

export interface SampleRateEstimate {
  /** Current best estimate (Hz). */
  sampleRate: number;
  /** True when the estimator has at least one trustworthy update. */
  valid: boolean;
  /** True when timestamps are missing or inter-frame gap is too big. */
  stalled: boolean;
  /** Coefficient of variation of accepted inter-frame deltas (jitter). */
  jitterCoV: number;
  /** Median inter-frame delta in ms (0 when no data). */
  medianDeltaMs: number;
  /** How many timestamps have been seen. */
  samplesObserved: number;
  /** True if the latest push was rejected as out of plausible range. */
  lastRejected: boolean;
}

export interface CalibrationResult {
  jitterCoV: number;
  medianDeltaMs: number;
  recommendedWindow: number;
  recommendedMadFactor: number;
  acceptedSamples: number;
}

const DEFAULTS: Required<SampleRateEstimatorOptions> = {
  minSR: 15,
  maxSR: 60,
  minDeltaMs: 8,
  maxDeltaMs: 120,
  windowSize: 60,
  smoothing: 0.7, // weight for previous cached SR
  madFactor: 3,
  minDeltasForUpdate: 4,
  stallTimeoutMs: 600,    // ~18 dropped frames @ 30fps
  gapTimeoutMs: 250,      // single gap that breaks delineation
  recoveryFrames: 6,
  defaultSR: 30,
};

export class SampleRateEstimator {
  private opts: Required<SampleRateEstimatorOptions>;
  private history: number[] = [];

  private cachedSR = 0;
  private cachedValid = false;

  private samplesObserved = 0;
  private lastRejected = false;

  // Stall state
  private stalled = false;
  private consecutiveGoodDeltas = 0;
  private lastTimestamp = -1;

  // Reusable scratch arrays for outlier rejection
  private _scratch: number[] = [];

  constructor(opts: SampleRateEstimatorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.cachedSR = this.opts.defaultSR;
  }

  reset(): void {
    this.history.length = 0;
    this.cachedSR = this.opts.defaultSR;
    this.cachedValid = false;
    this.samplesObserved = 0;
    this.lastRejected = false;
    this.stalled = false;
    this.consecutiveGoodDeltas = 0;
    this.lastTimestamp = -1;
  }

  /** Allow callers to override options at runtime (e.g. after calibration). */
  setOptions(patch: Partial<SampleRateEstimatorOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (this.history.length > this.opts.windowSize) {
      this.history.splice(0, this.history.length - this.opts.windowSize);
    }
  }

  getOptions(): Required<SampleRateEstimatorOptions> {
    return { ...this.opts };
  }

  /**
   * Push a new frame timestamp (ms). Returns the current estimate.
   * Pass `nowMs` (e.g. `performance.now()`) to allow stall detection even
   * when timestamps are out-of-order or duplicate; defaults to `timestamp`.
   */
  push(timestamp: number, nowMs?: number): SampleRateEstimate {
    const wallClock = nowMs ?? timestamp;

    // ── Stall detection: long silence since last update? ────────────────
    if (this.lastTimestamp >= 0 && wallClock - this.lastTimestamp > this.opts.stallTimeoutMs) {
      this.stalled = true;
      this.consecutiveGoodDeltas = 0;
    }

    if (!isFinite(timestamp)) {
      this.lastRejected = true;
      return this.snapshot();
    }

    const isNew = this.history.length === 0 || timestamp > this.history[this.history.length - 1];
    if (!isNew) {
      this.lastRejected = true;
      return this.snapshot();
    }

    const prev = this.history[this.history.length - 1];
    this.history.push(timestamp);
    if (this.history.length > this.opts.windowSize) this.history.shift();
    this.samplesObserved++;
    this.lastTimestamp = wallClock;

    // ── Single huge gap → immediate stall ───────────────────────────────
    if (prev !== undefined) {
      const delta = timestamp - prev;
      if (delta > this.opts.gapTimeoutMs) {
        this.stalled = true;
        this.consecutiveGoodDeltas = 0;
        this.lastRejected = true;
        return this.snapshot();
      }
      if (delta >= this.opts.minDeltaMs && delta <= this.opts.maxDeltaMs) {
        this.consecutiveGoodDeltas++;
      } else {
        this.consecutiveGoodDeltas = 0;
        this.lastRejected = true;
      }
    }

    // Recover from stall once we've seen enough good consecutive deltas
    if (this.stalled && this.consecutiveGoodDeltas >= this.opts.recoveryFrames) {
      this.stalled = false;
    }

    if (this.stalled) {
      // Keep cached SR frozen; do not pollute estimate with post-stall noise.
      return this.snapshot();
    }

    this.recompute();
    return this.snapshot();
  }

  /** Just read the current state without pushing. */
  read(): SampleRateEstimate {
    return this.snapshot();
  }

  // ─── Calibration ────────────────────────────────────────────────────────
  /**
   * Compute jitter from observed deltas and recommend a window size and MAD
   * factor. Caller decides whether to apply via `setOptions(...)`.
   */
  computeCalibration(): CalibrationResult {
    const deltas = this.collectPlausibleDeltas();
    if (deltas.length < 8) {
      return {
        jitterCoV: 0,
        medianDeltaMs: 0,
        recommendedWindow: this.opts.windowSize,
        recommendedMadFactor: this.opts.madFactor,
        acceptedSamples: deltas.length,
      };
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[i];
    const mean = sum / deltas.length;
    let varSum = 0;
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i] - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / deltas.length);
    const cov = std / Math.max(1e-6, mean);

    // Heuristic: noisier streams → wider window + tighter outlier band.
    // Window grows from 30 (cov<0.05) to 120 (cov>0.30).
    const w = Math.round(30 + Math.min(1, Math.max(0, (cov - 0.05) / 0.25)) * 90);
    // MAD factor narrows when jitter is high (more aggressive trimming).
    const mad = cov > 0.20 ? 2.0 : cov > 0.10 ? 2.5 : 3.0;

    return {
      jitterCoV: cov,
      medianDeltaMs: median,
      recommendedWindow: w,
      recommendedMadFactor: mad,
      acceptedSamples: deltas.length,
    };
  }

  /** Compute calibration AND apply the recommended options. */
  applyCalibration(): CalibrationResult {
    const r = this.computeCalibration();
    if (r.acceptedSamples >= 8) {
      this.setOptions({
        windowSize: r.recommendedWindow,
        madFactor: r.recommendedMadFactor,
      });
    }
    return r;
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  private collectPlausibleDeltas(): number[] {
    const out = this._scratch;
    out.length = 0;
    for (let i = 1; i < this.history.length; i++) {
      const d = this.history[i] - this.history[i - 1];
      if (d >= this.opts.minDeltaMs && d <= this.opts.maxDeltaMs && isFinite(d)) {
        out.push(d);
      }
    }
    return out;
  }

  private recompute(): void {
    const deltas = this.collectPlausibleDeltas();
    if (deltas.length < this.opts.minDeltasForUpdate) {
      this.lastRejected = true;
      return;
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const devs: number[] = [];
    for (let i = 0; i < sorted.length; i++) devs.push(Math.abs(sorted[i] - median));
    devs.sort((a, b) => a - b);
    const mad = devs[devs.length >> 1] || 1;
    const lo = median - this.opts.madFactor * mad;
    const hi = median + this.opts.madFactor * mad;

    let sum = 0, count = 0;
    for (let i = 0; i < deltas.length; i++) {
      const v = deltas[i];
      if (v >= lo && v <= hi) { sum += v; count++; }
    }
    const robustMs = count >= this.opts.minDeltasForUpdate ? sum / count : median;
    const instantSR = clamp(1000 / Math.max(1, robustMs), this.opts.minSR, this.opts.maxSR);

    const next = this.cachedValid
      ? this.cachedSR * this.opts.smoothing + instantSR * (1 - this.opts.smoothing)
      : instantSR;

    this.cachedSR = next;
    this.cachedValid = true;
    this.lastRejected = false;
  }

  private snapshot(): SampleRateEstimate {
    const deltas = this.collectPlausibleDeltas();
    let median = 0, jitterCoV = 0;
    if (deltas.length >= 2) {
      const sorted = deltas.slice().sort((a, b) => a - b);
      median = sorted[sorted.length >> 1];
      let sum = 0; for (let i = 0; i < deltas.length; i++) sum += deltas[i];
      const mean = sum / deltas.length;
      let v = 0; for (let i = 0; i < deltas.length; i++) { const d = deltas[i] - mean; v += d * d; }
      const std = Math.sqrt(v / deltas.length);
      jitterCoV = std / Math.max(1e-6, mean);
    }
    return {
      sampleRate: this.cachedValid ? this.cachedSR : this.opts.defaultSR,
      valid: this.cachedValid,
      stalled: this.stalled,
      jitterCoV,
      medianDeltaMs: median,
      samplesObserved: this.samplesObserved,
      lastRejected: this.lastRejected,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
