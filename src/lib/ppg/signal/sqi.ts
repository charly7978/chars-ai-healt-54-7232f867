/**
 * Signal Quality Index combining higher-order statistics with perfusion.
 *
 * - Skewness and kurtosis discriminate true pulse morphology from motion
 *   interference (a clean PPG pulse has positive skew and a characteristic
 *   excess kurtosis profile).
 * - Perfusion index = AC / DC on the source signal.
 * - Final SQI is bounded to [0, 1] and severe with low perfusion.
 */

export interface SqiBreakdown {
  readonly sqi: number;
  readonly perfusionIndex: number;
  readonly skewness: number;
  readonly kurtosis: number;
}

export interface SqiWeights {
  perfusionScale: number;
  weightPerfusion: number;
  weightSkewness: number;
  weightKurtosis: number;
}

const DEFAULT_WEIGHTS: SqiWeights = {
  perfusionScale: 25,
  weightPerfusion: 0.55,
  weightSkewness: 0.25,
  weightKurtosis: 0.2,
};

export function computeSqi(
  filtered: Float32Array,
  filteredLength: number,
  dc: number,
  weights: SqiWeights = DEFAULT_WEIGHTS,
): SqiBreakdown {
  if (filteredLength < 16 || !Number.isFinite(dc) || Math.abs(dc) < 1e-6) {
    return { sqi: 0, perfusionIndex: 0, skewness: 0, kurtosis: 0 };
  }

  let mean = 0;
  for (let i = 0; i < filteredLength; i++) mean += filtered[i];
  mean /= filteredLength;

  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let amplitudeSum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < filteredLength; i++) {
    const d = filtered[i] - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
    amplitudeSum += Math.abs(d);
    if (filtered[i] > max) max = filtered[i];
    if (filtered[i] < min) min = filtered[i];
  }
  m2 /= filteredLength;
  m3 /= filteredLength;
  m4 /= filteredLength;

  const std = Math.sqrt(Math.max(m2, 1e-12));
  const skewness = m3 / (std * std * std);
  const kurtosis = m4 / (m2 * m2) - 3;

  const ac = max - min;
  const perfusionIndex = ac / Math.abs(dc);

  // Heuristic combination — bounded to [0, 1]. Weights auto-normalize so the
  // operator can rebias the index without exceeding unity.
  const wSum =
    weights.weightPerfusion + weights.weightSkewness + weights.weightKurtosis;
  const norm = wSum > 1e-6 ? 1 / wSum : 0;
  const perfTerm = Math.min(1, perfusionIndex * weights.perfusionScale);
  const skewTerm = 1 / (1 + Math.exp(-3 * (skewness - 0.2)));
  const kurtTerm = 1 - Math.min(1, Math.abs(kurtosis - 1.5) / 6);
  const sqi = Math.max(
    0,
    Math.min(
      1,
      (perfTerm * weights.weightPerfusion +
        skewTerm * weights.weightSkewness +
        kurtTerm * weights.weightKurtosis) *
        norm,
    ),
  );

  return { sqi, perfusionIndex, skewness, kurtosis };
}
