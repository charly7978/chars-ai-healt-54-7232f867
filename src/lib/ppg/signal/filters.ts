/**
 * Biquad Butterworth pasa-banda — Direct Form I.
 * Coeficientes recalculados solo cuando fs cambia significativamente.
 */
export class BiquadBandpass {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private currentFs = 0;
  private fLow: number;
  private fHigh: number;

  constructor(fLow: number, fHigh: number, fs: number) {
    this.fLow = fLow;
    this.fHigh = fHigh;
    this.setSampleRate(fs);
  }

  setSampleRate(fs: number): void {
    if (fs <= 0 || !isFinite(fs)) return;
    if (Math.abs(fs - this.currentFs) < 1.5) return; // ignora cambios pequeños
    this.currentFs = fs;
    const w0 = 2 * Math.PI * ((this.fLow + this.fHigh) / 2) / fs;
    const bw = (this.fHigh - this.fLow) / ((this.fLow + this.fHigh) / 2);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 * Math.sinh((Math.LN2 / 2) * bw * (w0 / Math.max(1e-9, sinW0)));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    if (!isFinite(x)) x = 0;
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    if (!isFinite(y) || Math.abs(y) > 1e8) {
      this.reset();
      return 0;
    }
    return y;
  }

  reset(): void {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
}
