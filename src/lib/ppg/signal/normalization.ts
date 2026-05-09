import type { RgbMean } from "../types";

/**
 * Normalización AC/DC + transformada logarítmica de Beer-Lambert.
 * EMA de baja frecuencia (τ ≈ 2s) modela el componente DC tisular estático.
 */
export class NormalizationPipeline {
  private dcEma: RgbMean = { r: 0, g: 0, b: 0, y: 0 };
  private alpha: number;
  private initialized = false;

  constructor(targetFps: number, tauSeconds: number = 2.0) {
    this.alpha = 1 - Math.exp(-1 / Math.max(1, targetFps * tauSeconds));
  }

  setFps(fps: number, tauSeconds: number = 2.0): void {
    this.alpha = 1 - Math.exp(-1 / Math.max(1, fps * tauSeconds));
  }

  reset(): void {
    this.dcEma = { r: 0, g: 0, b: 0, y: 0 };
    this.initialized = false;
  }

  process(raw: RgbMean): { acdc: RgbMean; logNorm: RgbMean; dc: RgbMean } {
    if (!this.initialized) {
      this.dcEma = { r: raw.r, g: raw.g, b: raw.b, y: raw.y };
      this.initialized = true;
    } else {
      const a = this.alpha;
      this.dcEma.r += a * (raw.r - this.dcEma.r);
      this.dcEma.g += a * (raw.g - this.dcEma.g);
      this.dcEma.b += a * (raw.b - this.dcEma.b);
      this.dcEma.y += a * (raw.y - this.dcEma.y);
    }
    const eps = 1e-6;
    const acdc: RgbMean = {
      r: (raw.r - this.dcEma.r) / (this.dcEma.r + eps),
      g: (raw.g - this.dcEma.g) / (this.dcEma.g + eps),
      b: (raw.b - this.dcEma.b) / (this.dcEma.b + eps),
      y: (raw.y - this.dcEma.y) / (this.dcEma.y + eps),
    };
    const logNorm: RgbMean = {
      r: -Math.log((raw.r + eps) / (this.dcEma.r + eps)),
      g: -Math.log((raw.g + eps) / (this.dcEma.g + eps)),
      b: -Math.log((raw.b + eps) / (this.dcEma.b + eps)),
      y: 0,
    };
    return { acdc, logNorm, dc: { ...this.dcEma } };
  }
}
