import type { FrameStats } from './types';

/**
 * RadiometricProcessor
 * --------------------
 * Extracts physically meaningful per-frame statistics from a video frame:
 *  - mean linear RGB inside an ROI
 *  - optical density per channel against an adaptive white reference
 *  - clipping / saturation / spatial uniformity / motion proxy
 *
 * Hot path notes:
 *  - works directly on Uint8ClampedArray RGBA from canvas getImageData
 *  - sRGB -> linear via fast 256-entry LUT
 *  - no allocations per pixel
 */

const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

export class RadiometricProcessor {
  /** Adaptive white reference (per channel), slowly tracking the brightest stable mean. */
  private whiteR = 0.001;
  private whiteG = 0.001;
  private whiteB = 0.001;

  /** Previous green linear mean for motion proxy. */
  private prevGreenLinear = 0;
  private hasPrev = false;

  reset(): void {
    this.whiteR = 0.001;
    this.whiteG = 0.001;
    this.whiteB = 0.001;
    this.prevGreenLinear = 0;
    this.hasPrev = false;
  }

  /**
   * Process a frame already drawn on a canvas.
   * @param data ImageData.data (RGBA Uint8ClampedArray)
   * @param width frame width in pixels
   * @param height frame height in pixels
   * @param tMs real timestamp (performance.now() domain)
   * @param roiFraction fraction of width/height for the centered ROI (default 0.40)
   */
  process(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    tMs: number,
    roiFraction = 0.40,
  ): FrameStats {
    const f = Math.max(0.10, Math.min(0.90, roiFraction));
    const w = Math.max(8, Math.floor(width * f));
    const h = Math.max(8, Math.floor(height * f));
    const x0 = Math.floor((width - w) / 2);
    const y0 = Math.floor((height - h) / 2);
    const x1 = x0 + w;
    const y1 = y0 + h;

    let sumR = 0, sumG = 0, sumB = 0;
    let sumRl = 0, sumGl = 0, sumBl = 0;
    let sumGl2 = 0; // for green spatial std
    let clipHigh = 0, clipLow = 0, satHigh = 0;
    let count = 0;

    // Sub-sample for speed: stride 2 in both dimensions when ROI is large.
    const stride = (w * h) > 20000 ? 2 : 1;

    for (let y = y0; y < y1; y += stride) {
      let p = (y * width + x0) * 4;
      for (let x = x0; x < x1; x += stride) {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        sumR += r; sumG += g; sumB += b;
        const rl = SRGB_TO_LINEAR_LUT[r];
        const gl = SRGB_TO_LINEAR_LUT[g];
        const bl = SRGB_TO_LINEAR_LUT[b];
        sumRl += rl; sumGl += gl; sumBl += bl;
        sumGl2 += gl * gl;
        if (r >= 250 || g >= 250 || b >= 250) clipHigh++;
        if (r <= 5 && g <= 5 && b <= 5) clipLow++;
        // Generic high saturation: any channel max - min > 0.6 in linear space
        const mx = rl > gl ? (rl > bl ? rl : bl) : (gl > bl ? gl : bl);
        const mn = rl < gl ? (rl < bl ? rl : bl) : (gl < bl ? gl : bl);
        if (mx - mn > 0.6) satHigh++;
        count++;
        p += 4 * stride;
      }
    }

    if (count === 0) {
      return {
        redLinear: 0, greenLinear: 0, blueLinear: 0,
        redMean: 0, greenMean: 0, blueMean: 0,
        redOD: 0, greenOD: 0, blueOD: 0,
        clipHighRatio: 0, clipLowRatio: 0, saturationRatio: 0,
        spatialUniformity: 0, motionProxy: 0,
        roi: { x: x0, y: y0, w, h, pixels: 0 },
        tMs,
      };
    }

    const redMean = sumR / count;
    const greenMean = sumG / count;
    const blueMean = sumB / count;
    const redLinear = sumRl / count;
    const greenLinear = sumGl / count;
    const blueLinear = sumBl / count;
    const greenVar = Math.max(0, sumGl2 / count - greenLinear * greenLinear);
    const greenStd = Math.sqrt(greenVar);
    // Spatial uniformity in [0..1]: 1 = perfectly uniform; collapses fast with std.
    const spatialUniformity = greenLinear > 1e-4
      ? Math.max(0, Math.min(1, 1 - greenStd / Math.max(greenLinear, 1e-4)))
      : 0;

    // Adaptive white reference: track upward fast, decay slowly, per channel.
    const upAlpha = 0.05;
    const downAlpha = 0.001;
    const updateWhite = (cur: number, sample: number) =>
      sample > cur ? cur + upAlpha * (sample - cur) : cur + downAlpha * (sample - cur);
    this.whiteR = Math.max(1e-3, updateWhite(this.whiteR, redLinear));
    this.whiteG = Math.max(1e-3, updateWhite(this.whiteG, greenLinear));
    this.whiteB = Math.max(1e-3, updateWhite(this.whiteB, blueLinear));

    const eps = 1e-4;
    const redOD = -Math.log10((redLinear + eps) / (this.whiteR + eps));
    const greenOD = -Math.log10((greenLinear + eps) / (this.whiteG + eps));
    const blueOD = -Math.log10((blueLinear + eps) / (this.whiteB + eps));

    const motionProxy = this.hasPrev ? Math.abs(greenLinear - this.prevGreenLinear) : 0;
    this.prevGreenLinear = greenLinear;
    this.hasPrev = true;

    return {
      redLinear, greenLinear, blueLinear,
      redMean, greenMean, blueMean,
      redOD, greenOD, blueOD,
      clipHighRatio: clipHigh / count,
      clipLowRatio: clipLow / count,
      saturationRatio: satHigh / count,
      spatialUniformity,
      motionProxy,
      roi: { x: x0, y: y0, w, h, pixels: count },
      tMs,
    };
  }
}