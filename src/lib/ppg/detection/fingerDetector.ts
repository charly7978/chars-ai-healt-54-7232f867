import type { RgbMean } from "../types";

export interface FingerMetrics {
  globalRgb: RgbMean;
  validPixelRatio: number;
  darkPixelRatio: number;
  clippedPixelRatio: number;
  reddishRatio: number;
  fingerScore: number;
}

/**
 * Heurística píxel a píxel: luma + chroma + pureza roja + clipping.
 * No depende de promedios — clasifica cada píxel y agrega.
 */
export function computeFingerMetrics(
  data: Uint8ClampedArray,
  width: number,
  height: number
): FingerMetrics {
  let rSum = 0, gSum = 0, bSum = 0, ySum = 0;
  let validCount = 0, darkCount = 0, clippedCount = 0, reddishCount = 0;
  const total = width * height;
  const eps = 1e-4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    rSum += r; gSum += g; bSum += b; ySum += y;
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const chroma = max - min;
    const sum = r + g + b + eps;
    const rn = r / sum;

    if (max >= 252) clippedCount++;
    if (y < 20) darkCount++;

    const isReddish = rn > 0.34 && r > g * 0.85 && r > b * 1.05 && chroma > 12;
    if (isReddish) reddishCount++;
    if (y >= 25 && y <= 250 && max < 252 && min > 2 && isReddish) validCount++;
  }

  const validPixelRatio = validCount / total;
  const darkPixelRatio = darkCount / total;
  const clippedPixelRatio = clippedCount / total;
  const reddishRatio = reddishCount / total;

  let fingerScore = 0;
  if (validPixelRatio > 0.55 && reddishRatio > 0.45 && clippedPixelRatio < 0.25) {
    fingerScore = 1.0 - clippedPixelRatio - darkPixelRatio;
  } else if (reddishRatio > 0.30) {
    fingerScore = 0.5 * (reddishRatio / 0.45) + 0.5 * (validPixelRatio / 0.55);
  }
  fingerScore = Math.max(0, Math.min(1, fingerScore));

  return {
    globalRgb: { r: rSum / total, g: gSum / total, b: bSum / total, y: ySum / total },
    validPixelRatio,
    darkPixelRatio,
    clippedPixelRatio,
    reddishRatio,
    fingerScore,
  };
}
