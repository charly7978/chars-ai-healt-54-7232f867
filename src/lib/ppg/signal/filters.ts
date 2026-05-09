/**
 * Cascaded Butterworth band-pass implemented as two biquads in
 * Transposed Direct Form II.
 *
 * Coefficients are recomputed via `setSampleRate(fs)` whenever the real
 * frame-loop FPS drifts; the filter never assumes Fs = 30.
 */

const SQRT2 = Math.SQRT2;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
}

function makeBiquad(): Biquad {
  return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 };
}

function designHighpass(bq: Biquad, fc: number, fs: number): void {
  const k = Math.tan((Math.PI * fc) / fs);
  const k2 = k * k;
  const norm = 1 / (1 + SQRT2 * k + k2);
  bq.b0 = norm;
  bq.b1 = -2 * norm;
  bq.b2 = norm;
  bq.a1 = 2 * (k2 - 1) * norm;
  bq.a2 = (1 - SQRT2 * k + k2) * norm;
}

function designLowpass(bq: Biquad, fc: number, fs: number): void {
  const k = Math.tan((Math.PI * fc) / fs);
  const k2 = k * k;
  const norm = 1 / (1 + SQRT2 * k + k2);
  bq.b0 = k2 * norm;
  bq.b1 = 2 * bq.b0;
  bq.b2 = bq.b0;
  bq.a1 = 2 * (k2 - 1) * norm;
  bq.a2 = (1 - SQRT2 * k + k2) * norm;
}

function processBiquad(bq: Biquad, x: number): number {
  // Transposed Direct Form II.
  const y = bq.b0 * x + bq.z1;
  bq.z1 = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2 = bq.b2 * x - bq.a2 * y;
  if (!Number.isFinite(y)) {
    bq.z1 = 0;
    bq.z2 = 0;
    return 0;
  }
  return y;
}

export class BandpassBiquad {
  private readonly hp = makeBiquad();
  private readonly lp = makeBiquad();
  private fs: number;
  private readonly lowHz: number;
  private readonly highHz: number;

  constructor(sampleRate: number, lowHz: number, highHz: number) {
    this.fs = sampleRate;
    this.lowHz = lowHz;
    this.highHz = highHz;
    this.redesign();
  }

  setSampleRate(fs: number): void {
    if (!Number.isFinite(fs) || fs <= 0) return;
    if (Math.abs(fs - this.fs) < 0.05) return;
    this.fs = fs;
    this.redesign();
  }

  process(x: number): number {
    if (!Number.isFinite(x)) return 0;
    const y1 = processBiquad(this.hp, x);
    return processBiquad(this.lp, y1);
  }

  reset(): void {
    this.hp.z1 = 0;
    this.hp.z2 = 0;
    this.lp.z1 = 0;
    this.lp.z2 = 0;
  }

  private redesign(): void {
    designHighpass(this.hp, this.lowHz, this.fs);
    designLowpass(this.lp, this.highHz, this.fs);
  }
}
