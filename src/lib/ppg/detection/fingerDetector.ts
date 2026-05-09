/**
 * Pixel-level finger / contact classifier.
 *
 * Hot path: iterates a flat `Uint8ClampedArray` with primitive locals only —
 * no object allocations, no destructuring, no per-pixel intermediate objects.
 */

export interface FingerDetectionResult {
  readonly fingerDetected: boolean;
  readonly score: number;
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
  readonly clipHigh: number;
  readonly clipLow: number;
}

const SAT_HIGH = 252;
const DARK_LUMA = 20;
const RED_DOMINANCE = 35;
const COVERAGE_THRESHOLD = 0.55;

export function classifyFrame(rgba: Uint8ClampedArray): FingerDetectionResult {
  const len = rgba.length;
  if (len < 4) {
    return {
      fingerDetected: false,
      score: 0,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      clipHigh: 0,
      clipLow: 0,
    };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let validCount = 0;
  let clipHigh = 0;
  let clipLow = 0;
  let pixelCount = 0;

  for (let i = 0; i < len; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    pixelCount++;

    // Approximate luma (Rec. 601) using integer-ish arithmetic.
    const luma = (r * 299 + g * 587 + b * 114) * 0.001;

    if (r >= SAT_HIGH && g >= SAT_HIGH && b >= SAT_HIGH) {
      clipHigh++;
      continue;
    }
    if (luma <= DARK_LUMA) {
      clipLow++;
      continue;
    }

    const dominance = r - (g + b) * 0.5;
    if (dominance >= RED_DOMINANCE) {
      validCount++;
      sumR += r;
      sumG += g;
      sumB += b;
    }
  }

  const coverage = pixelCount > 0 ? validCount / pixelCount : 0;
  const meanR = validCount > 0 ? sumR / validCount : 0;
  const meanG = validCount > 0 ? sumG / validCount : 0;
  const meanB = validCount > 0 ? sumB / validCount : 0;
  const clipHighRatio = pixelCount > 0 ? clipHigh / pixelCount : 0;
  const clipLowRatio = pixelCount > 0 ? clipLow / pixelCount : 0;

  const score =
    coverage * (1 - clipHighRatio * 0.8) * (1 - clipLowRatio * 0.5);

  const fingerDetected =
    coverage >= COVERAGE_THRESHOLD &&
    clipHighRatio < 0.35 &&
    meanR > meanG &&
    meanR > meanB;

  return {
    fingerDetected,
    score,
    meanR,
    meanG,
    meanB,
    clipHigh: clipHighRatio,
    clipLow: clipLowRatio,
  };
}
