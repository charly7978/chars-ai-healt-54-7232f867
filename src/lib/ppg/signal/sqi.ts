/**
 * SQI: skewness + kurtosis + perfusion + clipping penalty.
 * Welford streaming para momentos estables sin overflow.
 */
export class SqiEvaluator {
  static compute(
    signal: Float32Array,
    fps: number,
    fingerScore: number,
    clipRatio: number
  ): number {
    const n = signal.length;
    if (n < Math.max(30, fps * 2) || fingerScore < 0.4) return 0;

    let mean = 0, m2 = 0, m3 = 0, m4 = 0;
    for (let i = 0; i < n; i++) {
      const k = i + 1;
      const delta = signal[i] - mean;
      const delta_n = delta / k;
      const delta_n2 = delta_n * delta_n;
      const term1 = delta * delta_n * (k - 1);
      mean += delta_n;
      m4 += term1 * delta_n2 * (k * k - 3 * k + 3) + 6 * delta_n2 * m2 - 4 * delta_n * m3;
      m3 += term1 * delta_n * (k - 2) - 3 * delta_n * m2;
      m2 += term1;
    }
    const variance = m2 / n;
    const stdDev = Math.sqrt(variance) + 1e-8;
    const skewness = Math.abs((m3 / n) / Math.pow(stdDev, 3));
    const kurtosis = (m4 / n) / Math.pow(variance + 1e-12, 2);

    const kScore = Math.min(1, Math.max(0, (kurtosis - 1.5) / 3.0));
    const sScore = Math.min(1, Math.max(0, skewness / 2.0));
    const piScore = Math.min(1, stdDev * 100);

    let sqi = 100 * (
      0.35 * fingerScore +
      0.25 * kScore +
      0.20 * sScore +
      0.10 * piScore +
      0.10 * (1 - clipRatio)
    );
    if (clipRatio > 0.35) sqi = Math.min(sqi, 35);
    if (fps < 20) sqi = Math.min(sqi, 45);
    return Math.max(0, Math.min(100, sqi));
  }
}
