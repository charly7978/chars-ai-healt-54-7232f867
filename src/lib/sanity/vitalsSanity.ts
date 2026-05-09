// anti-sim-allow: reason="Module that DETECTS synthetic patterns; the keyword appears in its docstring." ref="GUARDRAIL-DIST-RUNTIME"
/**
 * Runtime sanity check for vital-sign streams.
 *
 * Goal: detect implausible patterns coming out of the pipeline
 * (constant value, perfectly periodic loop, zero-variance bursts) and
 * surface an error state instead of letting the UI render fabricated data.
 *
 * This is a defensive guardrail. The pipeline already returns 0/`--` when
 * the signal is bad; this catches the *opposite* failure mode where some
 * upstream stage somehow injects a "too clean" stream.
 */

export interface SanityMetrics {
  /** Last sample evaluated. */
  last: number;
  /** Window mean. */
  mean: number;
  /** Window max - min. */
  span: number;
  /** Window variance (population). */
  variance: number;
  /** Window standard deviation. */
  std: number;
  /** Std-dev of consecutive deltas. */
  deltaStd: number;
  /** Mean absolute delta between consecutive samples. */
  meanAbsDelta: number;
  /** Min/max within window. */
  min: number;
  max: number;
}

export type SanityVerdict =
  | { ok: true; metrics?: SanityMetrics }
  | { ok: false; reason: 'CONSTANT' | 'REPETITIVE' | 'ZERO_VARIANCE' | 'OUT_OF_RANGE'; detail: string; metrics?: SanityMetrics };

export interface VitalsSanityOptions {
  /** Window size in samples (BPM updates ~per beat → ~30 samples ≈ 30 s). */
  windowSize?: number;
  /** Minimum samples before any verdict can be emitted. */
  minSamples?: number;
  /** A stream is "constant" if last N values are all within this delta. */
  constantTolerance?: number;
  /** Stream is "repetitive" if std-dev of consecutive deltas is below this. */
  repetitiveStdMin?: number;
  /** Plausible physiologic range for the stream (BPM defaults: 30–220). */
  min?: number;
  max?: number;
  /** Optional listener invoked for every push (after verdict is computed). */
  onVerdict?: (sample: number, verdict: SanityVerdict, window: number[]) => void;
}

export class VitalsSanityChecker {
  private buf: number[] = [];
  private readonly opt: Required<Omit<VitalsSanityOptions, 'onVerdict'>>;
  private readonly onVerdict?: VitalsSanityOptions['onVerdict'];
  private lastVerdict: SanityVerdict = { ok: true };

  constructor(opt: VitalsSanityOptions = {}) {
    this.opt = {
      windowSize: opt.windowSize ?? 30,
      minSamples: opt.minSamples ?? 12,
      constantTolerance: opt.constantTolerance ?? 0.5,
      repetitiveStdMin: opt.repetitiveStdMin ?? 0.05,
      min: opt.min ?? 30,
      max: opt.max ?? 220,
    };
    this.onVerdict = opt.onVerdict;
  }

  reset(): void {
    this.buf = [];
    this.lastVerdict = { ok: true };
  }

  /** Read-only accessor for the active thresholds (for audit / UI display). */
  getOptions() {
    return { ...this.opt };
  }

  /** Push a new sample. 0 / non-finite values are treated as "no reading" and skipped. */
  push(value: number): SanityVerdict {
    if (!Number.isFinite(value) || value <= 0) return this.lastVerdict;
    this.buf.push(value);
    if (this.buf.length > this.opt.windowSize) this.buf.shift();
    this.lastVerdict = this.evaluate();
    if (this.onVerdict) {
      try { this.onVerdict(value, this.lastVerdict, this.buf.slice()); } catch { /* listener errors must not break pipeline */ }
    }
    return this.lastVerdict;
  }

  private evaluate(): SanityVerdict {
    const n = this.buf.length;
    if (n < this.opt.minSamples) return { ok: true };

    const last = this.buf[n - 1];

    // Compute all stats up-front so every verdict carries full metrics.
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const v of this.buf) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
    const span = mx - mn;
    const mean = sum / n;
    let variance = 0;
    for (const v of this.buf) variance += (v - mean) ** 2;
    variance /= n;
    const std = Math.sqrt(variance);

    let dSum = 0, dAbsSum = 0;
    const dN = n - 1;
    for (let i = 1; i < n; i++) {
      const d = this.buf[i] - this.buf[i - 1];
      dSum += d;
      dAbsSum += Math.abs(d);
    }
    const dMean = dN > 0 ? dSum / dN : 0;
    let dVar = 0;
    for (let i = 1; i < n; i++) {
      const d = this.buf[i] - this.buf[i - 1];
      dVar += (d - dMean) ** 2;
    }
    dVar = dN > 0 ? dVar / dN : 0;
    const dStd = Math.sqrt(dVar);
    const meanAbsDelta = dN > 0 ? dAbsSum / dN : 0;

    const metrics: SanityMetrics = {
      last, mean, span, variance, std, deltaStd: dStd, meanAbsDelta, min: mn, max: mx,
    };

    if (last < this.opt.min || last > this.opt.max) {
      return { ok: false, reason: 'OUT_OF_RANGE', detail: `value ${last.toFixed(1)} outside [${this.opt.min}, ${this.opt.max}]`, metrics };
    }
    if (span <= this.opt.constantTolerance) {
      return { ok: false, reason: 'CONSTANT', detail: `span ${span.toFixed(3)} ≤ tol ${this.opt.constantTolerance}`, metrics };
    }
    if (variance < 1e-6) {
      return { ok: false, reason: 'ZERO_VARIANCE', detail: `var ${variance.toExponential(2)}`, metrics };
    }
    if (dStd < this.opt.repetitiveStdMin && meanAbsDelta > this.opt.constantTolerance) {
      return { ok: false, reason: 'REPETITIVE', detail: `delta-std ${dStd.toFixed(3)} too low for delta-mean ${meanAbsDelta.toFixed(2)}`, metrics };
    }

    return { ok: true, metrics };
  }
}
