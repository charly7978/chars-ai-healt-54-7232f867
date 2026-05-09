/**
 * STFT-based Signal Quality Index.
 *
 * Computes the cardiac-band power ratio across overlapping windows and tracks
 * its temporal stability. A clean PPG signal exhibits:
 *   - High and stable cardiac-band ratio across consecutive windows.
 *   - Low spectral entropy (energy concentrated around the heart-rate peak).
 *
 * Windows are Hann-tapered to reduce spectral leakage. Power is sampled with
 * a small Goertzel grid, so the cost stays O(N · K) per window and there are
 * no FFT allocations on the hot path.
 */

export interface StftSqiOptions {
  readonly windowSize: number;     // samples per window
  readonly hopSize: number;        // samples between successive windows
  readonly cardiacLowHz: number;
  readonly cardiacHighHz: number;
  readonly bins: number;           // Goertzel taps from DC to Nyquist
}

export const DEFAULT_STFT_OPTIONS: StftSqiOptions = {
  windowSize: 128,
  hopSize: 32,
  cardiacLowHz: 0.7,
  cardiacHighHz: 4.0,
  bins: 24,
};

export interface StftSqiResult {
  /** Mean cardiac-band power ratio across windows (0..1). */
  readonly meanCardiacRatio: number;
  /** Standard deviation of cardiac-band ratio (lower = more stable). */
  readonly stdCardiacRatio: number;
  /** Spectral entropy averaged across windows (lower = more periodic). */
  readonly meanSpectralEntropy: number;
  /** Combined SQI in [0, 1]. */
  readonly sqi: number;
  /** Number of analysis windows actually evaluated. */
  readonly windowsEvaluated: number;
}

function goertzelMagSq(
  signal: Float32Array,
  start: number,
  length: number,
  hann: Float32Array,
  k: number,
): number {
  const omega = (2 * Math.PI * k) / length;
  const cosw = Math.cos(omega);
  const coeff = 2 * cosw;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    const x = signal[start + i] * hann[i];
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

const hannCache = new Map<number, Float32Array>();
function hannWindow(n: number): Float32Array {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  const denom = n - 1;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  hannCache.set(n, w);
  return w;
}

/**
 * Evaluate STFT-derived SQI on a filtered PPG buffer.
 *
 * @param filtered  Bandpass-filtered signal samples.
 * @param length    Number of valid samples in `filtered`.
 * @param fps       Real sample rate in Hz.
 * @param opts      Optional override of window/hop/bins.
 */
export function computeStftSqi(
  filtered: Float32Array,
  length: number,
  fps: number,
  opts: StftSqiOptions = DEFAULT_STFT_OPTIONS,
): StftSqiResult {
  const { windowSize, hopSize, cardiacLowHz, cardiacHighHz, bins } = opts;
  if (length < windowSize || !(fps > 1)) {
    return {
      meanCardiacRatio: 0,
      stdCardiacRatio: 0,
      meanSpectralEntropy: 1,
      sqi: 0,
      windowsEvaluated: 0,
    };
  }

  const hann = hannWindow(windowSize);
  const nyquist = fps * 0.5;

  // Pre-compute the Goertzel k indices and band membership once per call.
  let cardiacBins = 0;
  for (let b = 1; b < bins; b++) {
    const f = (b / bins) * nyquist;
    if (f >= cardiacLowHz && f <= cardiacHighHz) cardiacBins++;
  }
  if (cardiacBins === 0) {
    return {
      meanCardiacRatio: 0,
      stdCardiacRatio: 0,
      meanSpectralEntropy: 1,
      sqi: 0,
      windowsEvaluated: 0,
    };
  }

  let nWin = 0;
  let sumRatio = 0;
  let sumRatioSq = 0;
  let sumEntropy = 0;
  const log2 = Math.log(2);

  for (let start = 0; start + windowSize <= length; start += hopSize) {
    let total = 0;
    let cardiac = 0;
    // Stack-allocated accumulator for entropy: store mag² per bin.
    // bins is bounded (typically 24), so a small loop with two passes is fine.
    let maxMag = 0;
    const mags = new Float32Array(bins);
    for (let b = 1; b < bins; b++) {
      const f = (b / bins) * nyquist;
      const k = (f * windowSize) / fps;
      const mag2 = Math.max(0, goertzelMagSq(filtered, start, windowSize, hann, k));
      mags[b] = mag2;
      total += mag2;
      if (mag2 > maxMag) maxMag = mag2;
      if (f >= cardiacLowHz && f <= cardiacHighHz) cardiac += mag2;
    }
    if (total <= 1e-12) continue;

    const ratio = cardiac / total;
    sumRatio += ratio;
    sumRatioSq += ratio * ratio;

    // Shannon entropy normalized to [0, 1] by log2(K).
    let entropy = 0;
    let usedBins = 0;
    for (let b = 1; b < bins; b++) {
      const p = mags[b] / total;
      if (p > 1e-9) {
        entropy -= p * (Math.log(p) / log2);
        usedBins++;
      }
    }
    const norm = usedBins > 1 ? Math.log(usedBins) / log2 : 1;
    sumEntropy += norm > 1e-6 ? entropy / norm : 0;

    nWin++;
  }

  if (nWin === 0) {
    return {
      meanCardiacRatio: 0,
      stdCardiacRatio: 0,
      meanSpectralEntropy: 1,
      sqi: 0,
      windowsEvaluated: 0,
    };
  }

  const meanRatio = sumRatio / nWin;
  const varRatio = Math.max(0, sumRatioSq / nWin - meanRatio * meanRatio);
  const stdRatio = Math.sqrt(varRatio);
  const meanEntropy = sumEntropy / nWin;

  // Combine: high mean ratio is good, low std (stable) is good, low entropy
  // (peaky spectrum) is good. All three terms in [0, 1].
  const ratioTerm = Math.min(1, Math.max(0, meanRatio));
  const stabilityTerm = Math.min(1, Math.max(0, 1 - stdRatio * 2.5));
  const entropyTerm = Math.min(1, Math.max(0, 1 - meanEntropy));
  const sqi = Math.min(
    1,
    Math.max(0, ratioTerm * 0.55 + stabilityTerm * 0.25 + entropyTerm * 0.2),
  );

  return {
    meanCardiacRatio: meanRatio,
    stdCardiacRatio: stdRatio,
    meanSpectralEntropy: meanEntropy,
    sqi,
    windowsEvaluated: nWin,
  };
}
