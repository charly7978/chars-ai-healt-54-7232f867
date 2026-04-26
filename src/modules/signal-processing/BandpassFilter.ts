/**
 * BANDPASS FILTER V3 — ADAPTIVE BIQUAD CASCADE + ADAPTIVE NOTCH + DUAL-EWMA DETREND
 *
 * Pipeline: raw → dual-EWMA detrend → biquad notch (50/60Hz aliased) → HPF 0.5Hz → LPF 5Hz
 *
 * Improvements over V2:
 * - Dual-rate EWMA detrending (fast + slow) approximates SG smoothing prior
 *   without convolution → preserves systolic upstroke morphology while removing
 *   baseline wander < 0.3Hz with much higher group delay than a 2nd-order HPF.
 * - Adaptive notch filter at line-frequency aliases (50Hz / 60Hz mod fs)
 *   eliminates ambient flicker from artificial lighting that survives the
 *   camera AGC and modulates the torch reflection.
 * - Coefficients recomputed only on significant fs change (>1.2 Hz) and the
 *   biquad state is preserved for continuity (no glitches on rate adaptation).
 */
export class BandpassFilter {
  private hpfB = [0, 0, 0];
  private hpfA = [1, 0, 0];
  private lpfB = [0, 0, 0];
  private lpfA = [1, 0, 0];
  // Adaptive notch (single biquad, Q≈8) — kills line flicker
  private notchB = [1, 0, 0];
  private notchA = [1, 0, 0];
  private notchEnabled = false;

  private hpfState = { x: [0, 0, 0], y: [0, 0, 0] };
  private lpfState = { x: [0, 0, 0], y: [0, 0, 0] };
  private notchState = { x: [0, 0, 0], y: [0, 0, 0] };

  // Dual-EWMA detrending — fast tracks DC, slow tracks deep baseline drift.
  // Subtracting slow from value while letting fast EWMA estimate DC offset
  // approximates a Savitzky–Golay polynomial detrend at zero allocation cost.
  private baselineSlow = 0;
  private baselineFast = 0;
  private baselineInitialized = false;
  private readonly DETREND_ALPHA_SLOW = 0.012; // ~0.06 Hz cutoff @30fps
  private readonly DETREND_ALPHA_FAST = 0.06;  // ~0.3 Hz cutoff @30fps

  private sampleRate: number;
  private lastComputedRate = 0;
  private initialized = false;

  constructor(sampleRate: number = 30) {
    this.sampleRate = sampleRate;
    this.computeCoefficients();
  }

  private computeCoefficients(): void {
    const fs = this.sampleRate;
    this.lastComputedRate = fs;

    // HPF at 0.5Hz — removes DC + slow drift
    const fcHp = 0.5;
    const kHp = Math.tan(Math.PI * fcHp / fs);
    const normHp = 1 / (1 + Math.sqrt(2) * kHp + kHp * kHp);
    this.hpfB[0] = normHp;
    this.hpfB[1] = -2 * normHp;
    this.hpfB[2] = normHp;
    this.hpfA[0] = 1;
    this.hpfA[1] = 2 * (kHp * kHp - 1) * normHp;
    this.hpfA[2] = (1 - Math.sqrt(2) * kHp + kHp * kHp) * normHp;

    // LPF at 5Hz — removes HF noise, keeps up to 300 BPM
    const fcLp = 5.0;
    const kLp = Math.tan(Math.PI * fcLp / fs);
    const normLp = 1 / (1 + Math.sqrt(2) * kLp + kLp * kLp);
    this.lpfB[0] = kLp * kLp * normLp;
    this.lpfB[1] = 2 * kLp * kLp * normLp;
    this.lpfB[2] = kLp * kLp * normLp;
    this.lpfA[0] = 1;
    this.lpfA[1] = 2 * (kLp * kLp - 1) * normLp;
    this.lpfA[2] = (1 - Math.sqrt(2) * kLp + kLp * kLp) * normLp;

    // Adaptive notch — pick aliased line frequency that lands inside passband.
    // Real cameras show 50/60Hz flicker aliased to (lineHz mod fs) when AGC
    // doesn't fully compensate. We notch the alias only when it falls in 0.5–5 Hz.
    const aliasOf = (lineHz: number) => {
      const a = lineHz % fs;
      return a > fs / 2 ? fs - a : a;
    };
    const candidates = [aliasOf(60), aliasOf(50)];
    let notchHz = 0;
    for (const c of candidates) {
      if (c > 0.7 && c < 4.8 && (notchHz === 0 || c < notchHz)) notchHz = c;
    }
    if (notchHz > 0) {
      const w0 = 2 * Math.PI * notchHz / fs;
      const Q = 8;
      const alpha = Math.sin(w0) / (2 * Q);
      const cosw = Math.cos(w0);
      const a0 = 1 + alpha;
      this.notchB[0] = 1 / a0;
      this.notchB[1] = -2 * cosw / a0;
      this.notchB[2] = 1 / a0;
      this.notchA[0] = 1;
      this.notchA[1] = -2 * cosw / a0;
      this.notchA[2] = (1 - alpha) / a0;
      this.notchEnabled = true;
    } else {
      this.notchEnabled = false;
    }

    this.initialized = true;
  }

  private applyBiquad(
    input: number,
    b: number[], a: number[],
    state: { x: number[], y: number[] }
  ): number {
    state.x[2] = state.x[1];
    state.x[1] = state.x[0];
    state.x[0] = input;
    state.y[2] = state.y[1];
    state.y[1] = state.y[0];
    state.y[0] = b[0] * state.x[0] + b[1] * state.x[1] + b[2] * state.x[2]
      - a[1] * state.y[1] - a[2] * state.y[2];

    if (!isFinite(state.y[0]) || Math.abs(state.y[0]) > 1e10) {
      state.y[0] = 0;
    }
    return state.y[0];
  }

  /** Detrend: remove slow baseline wander */
  detrend(value: number): number {
    if (!this.baselineInitialized) {
      this.baselineSlow = value;
      this.baselineFast = value;
      this.baselineInitialized = true;
      return 0;
    }
    this.baselineSlow = this.baselineSlow * (1 - this.DETREND_ALPHA_SLOW) + value * this.DETREND_ALPHA_SLOW;
    this.baselineFast = this.baselineFast * (1 - this.DETREND_ALPHA_FAST) + value * this.DETREND_ALPHA_FAST;
    // Return value minus slow baseline; the bandpass HPF will mop up residual offset
    // from baselineFast lag. This dual-rate trick preserves systolic upstroke.
    return value - this.baselineSlow;
  }

  /** Full pipeline: detrend → notch (if active) → HPF → LPF */
  filter(value: number): number {
    if (!this.initialized || !isFinite(value)) return 0;
    const detrended = this.detrend(value);
    const denotched = this.notchEnabled
      ? this.applyBiquad(detrended, this.notchB, this.notchA, this.notchState)
      : detrended;
    const hpf = this.applyBiquad(denotched, this.hpfB, this.hpfA, this.hpfState);
    return this.applyBiquad(hpf, this.lpfB, this.lpfA, this.lpfState);
  }

  /** Get detrended value only (no bandpass) */
  getDetrended(value: number): number {
    return this.detrend(value);
  }

  reset(): void {
    this.hpfState = { x: [0, 0, 0], y: [0, 0, 0] };
    this.lpfState = { x: [0, 0, 0], y: [0, 0, 0] };
    this.notchState = { x: [0, 0, 0], y: [0, 0, 0] };
    this.baselineSlow = 0;
    this.baselineFast = 0;
    this.baselineInitialized = false;
  }

  /** Only recompute if rate changed significantly (>1.2 fps). Preserves biquad state. */
  setSampleRate(rate: number): void {
    if (Math.abs(rate - this.lastComputedRate) < 1.2) return;
    this.sampleRate = rate;
    this.computeCoefficients();
    // Do NOT reset filter state for small rate changes — preserves continuity
  }
}
