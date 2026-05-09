/**
 * Measurement quality gate.
 *
 * Hard-blocks emission of vital-sign results when the underlying PPG signal
 * does not meet two independent quality criteria:
 *
 *   1. Perfusion Index (PI = AC/DC) above a clinically meaningful floor.
 *   2. Cardiac Power Ratio: fraction of total spectral power that lies inside
 *      the cardiac band (0.7 – 4.0 Hz). Low ratios indicate that motion or
 *      baseline drift dominate the signal.
 *
 * The gate is fully deterministic — no random, no fabricated values, no
 * "physiological clamping". It returns a verdict the UI layer must respect.
 */

export interface QualityGateThresholds {
  /** Minimum perfusion index (AC/DC) required to release a reading. */
  readonly minPerfusionIndex: number;
  /** Minimum fraction (0..1) of spectral power inside the cardiac band. */
  readonly minCardiacPowerRatio: number;
  /** Lower edge of the cardiac band in Hz. */
  readonly cardiacLowHz: number;
  /** Upper edge of the cardiac band in Hz. */
  readonly cardiacHighHz: number;
}

export const DEFAULT_GATE_THRESHOLDS: QualityGateThresholds = {
  minPerfusionIndex: 0.0035,
  minCardiacPowerRatio: 0.45,
  cardiacLowHz: 0.7,
  cardiacHighHz: 4.0,
};

export type QualityGateReason =
  | "OK"
  | "PERFUSION_TOO_LOW"
  | "POWER_RATIO_TOO_LOW"
  | "INSUFFICIENT_SAMPLES";

export interface QualityGateResult {
  readonly accepted: boolean;
  readonly reason: QualityGateReason;
  readonly perfusionIndex: number;
  readonly cardiacPowerRatio: number;
  readonly totalPower: number;
  readonly cardiacPower: number;
}

/**
 * Goertzel-based band power estimator. We avoid full FFT to keep allocations
 * out of the hot path: a small, fixed grid of Goertzel taps gives us cardiac
 * vs. total power with O(N · K) work and zero allocations beyond the result.
 */
function goertzelMagnitudeSq(
  signal: Float32Array,
  length: number,
  k: number,
): number {
  // k is the normalized frequency bin index (k = freqHz * length / fps).
  const omega = (2 * Math.PI * k) / length;
  const cosw = Math.cos(omega);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  // |X(k)|^2 without the final complex reconstruction step.
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Evaluate the measurement gate on a filtered PPG window.
 *
 * @param filtered  Bandpass-filtered PPG samples (zero-mean is fine).
 * @param length    Number of valid samples in `filtered`.
 * @param dc        DC component of the source signal (for PI = AC/DC).
 * @param fps       Real sample rate in Hz.
 * @param th        Threshold set; defaults to DEFAULT_GATE_THRESHOLDS.
 */
export function evaluateQualityGate(
  filtered: Float32Array,
  length: number,
  dc: number,
  fps: number,
  th: QualityGateThresholds = DEFAULT_GATE_THRESHOLDS,
): QualityGateResult {
  if (length < 32 || !Number.isFinite(dc) || Math.abs(dc) < 1e-6 || !(fps > 1)) {
    return {
      accepted: false,
      reason: "INSUFFICIENT_SAMPLES",
      perfusionIndex: 0,
      cardiacPowerRatio: 0,
      totalPower: 0,
      cardiacPower: 0,
    };
  }

  // --- Perfusion Index from peak-to-peak amplitude over |DC| ---
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < length; i++) {
    const v = filtered[i];
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const ac = max - min;
  const perfusionIndex = ac / Math.abs(dc);

  // --- Cardiac Power Ratio via Goertzel grid ---
  // Sample 16 bins from DC up to Nyquist; sum cardiac vs. total.
  const bins = 16;
  const nyquist = fps * 0.5;
  let totalPower = 0;
  let cardiacPower = 0;
  for (let b = 1; b < bins; b++) {
    const freq = (b / bins) * nyquist;
    const k = (freq * length) / fps;
    const mag2 = Math.max(0, goertzelMagnitudeSq(filtered, length, k));
    totalPower += mag2;
    if (freq >= th.cardiacLowHz && freq <= th.cardiacHighHz) {
      cardiacPower += mag2;
    }
  }
  const cardiacPowerRatio = totalPower > 1e-12 ? cardiacPower / totalPower : 0;

  if (perfusionIndex < th.minPerfusionIndex) {
    return {
      accepted: false,
      reason: "PERFUSION_TOO_LOW",
      perfusionIndex,
      cardiacPowerRatio,
      totalPower,
      cardiacPower,
    };
  }
  if (cardiacPowerRatio < th.minCardiacPowerRatio) {
    return {
      accepted: false,
      reason: "POWER_RATIO_TOO_LOW",
      perfusionIndex,
      cardiacPowerRatio,
      totalPower,
      cardiacPower,
    };
  }

  return {
    accepted: true,
    reason: "OK",
    perfusionIndex,
    cardiacPowerRatio,
    totalPower,
    cardiacPower,
  };
}
