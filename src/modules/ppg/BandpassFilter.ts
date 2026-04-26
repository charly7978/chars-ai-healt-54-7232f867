/**
 * Causal IIR bandpass filter as cascade of biquads (RBJ cookbook).
 * Designed for cardiac PPG band 0.5–4.0 Hz at runtime sample rate.
 * Coefficients are recomputed only when sample rate changes meaningfully.
 */

interface Biquad {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
  z1: number; z2: number;
}

function makeBandpass(fs: number, f0: number, q: number): Biquad {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
    z1: 0, z2: 0,
  };
}

function processBiquad(bq: Biquad, x: number): number {
  const y = bq.b0 * x + bq.z1;
  bq.z1 = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2 = bq.b2 * x - bq.a2 * y;
  return y;
}

export class CardiacBandpass {
  private fs = 0;
  private bq1: Biquad | null = null;
  private bq2: Biquad | null = null;
  private detrendEMA = 0;
  private detrendInit = false;

  constructor(private readonly fLow = 0.5, private readonly fHigh = 4.0) {}

  setSampleRate(fs: number): void {
    if (fs <= 0) return;
    if (this.fs > 0 && Math.abs(fs - this.fs) / this.fs < 0.05 && this.bq1 && this.bq2) return;
    this.fs = fs;
    const f0 = Math.sqrt(this.fLow * this.fHigh);
    const bw = (this.fHigh - this.fLow);
    const q = f0 / Math.max(0.01, bw);
    // Cascade of two biquads with same Q for steeper roll-off.
    this.bq1 = makeBandpass(fs, f0, q);
    this.bq2 = makeBandpass(fs, f0, q);
  }

  reset(): void {
    if (this.bq1) { this.bq1.z1 = 0; this.bq1.z2 = 0; }
    if (this.bq2) { this.bq2.z1 = 0; this.bq2.z2 = 0; }
    this.detrendInit = false;
    this.detrendEMA = 0;
  }

  process(x: number): number {
    if (!this.bq1 || !this.bq2) return 0;
    // High-pass detrend via EMA subtraction (stable, causal).
    if (!this.detrendInit) { this.detrendEMA = x; this.detrendInit = true; }
    const alpha = 0.02;
    this.detrendEMA += alpha * (x - this.detrendEMA);
    const detrended = x - this.detrendEMA;
    const y1 = processBiquad(this.bq1, detrended);
    return processBiquad(this.bq2, y1);
  }
}