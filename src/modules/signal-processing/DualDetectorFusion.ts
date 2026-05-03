/**
 * DualDetectorFusion — Elgendi + Derivative consensus engine
 *
 * Two independent, mathematically distinct PPG beat detectors run in
 * parallel over the SAME normalised buffer. Their candidate-peak
 * timestamps are then matched within a tolerance window. The fusion
 * does NOT synthesise beats — it only emits a consensus score that the
 * upstream HeartBeatProcessor uses to gate / weight the candidate it
 * already produced from the slaved detector.
 *
 * Detector A — Elgendi (Optimal Systolic Peak Detection in PPG, 2013):
 *   - clip negatives, square the signal
 *   - short MA window  W1 ≈ 111 ms (systolic peak width)
 *   - long  MA window  W2 ≈ 667 ms (heart-beat duration)
 *   - threshold = MA_long + β·mean(squared)
 *   - block of interest = MA_short ≥ threshold AND width ≥ W1
 *   - per block, the local maximum is the systolic peak
 *
 * Detector B — Derivative / morphology:
 *   - first derivative zero-crossing (positive→negative) IS the peak
 *   - prominence, ascending slope, descending slope, half-width gate
 *   - rejects shoulders and dicrotic notches
 *
 * Consensus:
 *   - if both detectors fire within ±tolerance of the same instant →
 *     agreement = 1.0
 *   - if only one fires → agreement = 0.5 (weak; caller decides)
 *   - if neither fires → agreement = 0.0
 *
 * No synthesis, no interpolation, no missed-beat fabrication. Only
 * gating signal for upstream.
 */

export interface FusionInput {
  /** Most recent N samples of the normalised, bandpass-filtered PPG.
   *  Index N-1 is the newest sample. */
  buffer: Float64Array;
  /** Sample rate (Hz). */
  fs: number;
  /** Timestamp (ms, monotonic) of the newest sample. */
  nowMs: number;
}

export interface FusionResult {
  /** Did Elgendi detector fire on the most-recent block? */
  elgendiPeak: boolean;
  /** Did derivative detector fire? */
  derivativePeak: boolean;
  /** ms of the Elgendi peak relative to nowMs (negative = past), or null. */
  elgendiPeakAgeMs: number | null;
  /** ms of the derivative peak relative to nowMs, or null. */
  derivativePeakAgeMs: number | null;
  /** [0..1] consensus score. */
  agreement: number;
  /** Both fired AND inside tolerance window. */
  consensus: boolean;
}

/** ms tolerance to consider two detector firings as the SAME beat. */
const FUSION_TOLERANCE_MS = 80;

/** Elgendi β coefficient (paper-tuned). */
const ELGENDI_BETA = 0.02;

/** Elgendi short window in ms (systolic peak width). */
const ELGENDI_W1_MS = 111;

/** Elgendi long window in ms (typical beat duration). */
const ELGENDI_W2_MS = 667;

export class DualDetectorFusion {
  /**
   * Run both detectors over the provided normalised PPG buffer and
   * return a consensus payload. Pure function — no internal state, so
   * it is safe to call per-frame from the hot path.
   */
  evaluate(input: FusionInput): FusionResult {
    const { buffer, fs, nowMs } = input;
    const n = buffer.length;

    if (n < Math.round(fs * 1.5) || fs <= 0) {
      return {
        elgendiPeak: false, derivativePeak: false,
        elgendiPeakAgeMs: null, derivativePeakAgeMs: null,
        agreement: 0, consensus: false,
      };
    }

    const elgendiIdx = this.detectElgendi(buffer, fs);
    const derivativeIdx = this.detectDerivative(buffer, fs);

    const sampleMs = 1000 / fs;
    const elgendiAge = elgendiIdx >= 0 ? (n - 1 - elgendiIdx) * sampleMs : null;
    const derivAge = derivativeIdx >= 0 ? (n - 1 - derivativeIdx) * sampleMs : null;

    const elgFired = elgendiIdx >= 0;
    const derFired = derivativeIdx >= 0;

    let agreement = 0;
    let consensus = false;

    if (elgFired && derFired) {
      const dt = Math.abs((elgendiAge ?? 0) - (derivAge ?? 0));
      if (dt <= FUSION_TOLERANCE_MS) {
        consensus = true;
        // Closer in time → higher agreement (1.0 .. 0.7)
        agreement = 1 - (dt / FUSION_TOLERANCE_MS) * 0.3;
      } else {
        agreement = 0.45; // both fired but disagree → weak
      }
    } else if (elgFired || derFired) {
      agreement = 0.5;
    }

    return {
      elgendiPeak: elgFired,
      derivativePeak: derFired,
      elgendiPeakAgeMs: elgendiAge,
      derivativePeakAgeMs: derivAge,
      agreement,
      consensus,
    };
  }

  /**
   * Elgendi systolic-peak detector. Returns the buffer index of the
   * latest detected peak inside the most recent block-of-interest, or
   * -1 if no peak in the visible window.
   */
  private detectElgendi(buf: Float64Array, fs: number): number {
    const n = buf.length;
    const w1 = Math.max(3, Math.round((ELGENDI_W1_MS / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((ELGENDI_W2_MS / 1000) * fs));
    if (n < w2 + 4) return -1;

    // 1) clip negatives & square
    let meanSq = 0;
    const sq = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = buf[i] > 0 ? buf[i] : 0;
      const v2 = v * v;
      sq[i] = v2;
      meanSq += v2;
    }
    meanSq /= n;
    if (meanSq <= 0) return -1;

    // 2) moving averages (causal trailing)
    const ma1 = movingAverageTail(sq, w1);
    const ma2 = movingAverageTail(sq, w2);

    // 3) threshold
    const alpha = ELGENDI_BETA * meanSq;

    // 4) scan ONLY the trailing region (last ~1.5 s) for a fresh block
    const scanStart = Math.max(w2, n - Math.round(fs * 1.5));
    let blockStart = -1;
    let lastPeak = -1;
    for (let i = scanStart; i < n; i++) {
      const above = ma1[i] > ma2[i] + alpha;
      if (above && blockStart < 0) blockStart = i;
      if ((!above || i === n - 1) && blockStart >= 0) {
        const blockEnd = above ? i : i - 1;
        if (blockEnd - blockStart + 1 >= w1) {
          // local max inside this block on the ORIGINAL buffer
          let peakIdx = blockStart;
          let peakVal = buf[blockStart];
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            if (buf[j] > peakVal) { peakVal = buf[j]; peakIdx = j; }
          }
          lastPeak = peakIdx;
        }
        blockStart = -1;
      }
    }
    return lastPeak;
  }

  /**
   * Derivative / morphology detector. Looks for a positive→negative
   * zero-crossing of the first derivative (i.e. an actual local max),
   * with prominence and ascending-slope gating to reject shoulders.
   */
  private detectDerivative(buf: Float64Array, fs: number): number {
    const n = buf.length;
    if (n < 8) return -1;

    // Trailing scan window: last ~1.5 s
    const scanStart = Math.max(3, n - Math.round(fs * 1.5));

    // First derivative (central difference) computed on demand inside
    // the loop to avoid a full pre-pass allocation.
    let lastPeakIdx = -1;
    for (let i = scanStart; i < n - 1; i++) {
      const dPrev = (buf[i]     - buf[i - 2]) * 0.5;
      const dNext = (buf[i + 1] - buf[i - 1]) * 0.5;
      // Zero-crossing of derivative, positive→negative ⇒ local max.
      if (dPrev > 0 && dNext <= 0) {
        const peakVal = buf[i];

        // Local baseline = min over previous 6 samples
        let baseline = peakVal;
        const lo = Math.max(0, i - 6);
        for (let j = lo; j < i; j++) if (buf[j] < baseline) baseline = buf[j];
        const prominence = peakVal - baseline;
        if (prominence < 0.5) continue;             // too small

        // Ascending slope gate — real PPG has a fast rising edge
        const upSlope = peakVal - buf[i - 2];
        if (upSlope < 0.4) continue;

        // Half-width gate — reject narrow noise spikes
        const halfProm = baseline + prominence * 0.5;
        let width = 0;
        const wLo = Math.max(0, i - 6);
        const wHi = Math.min(n, i + 6);
        for (let j = wLo; j < wHi; j++) if (buf[j] > halfProm) width++;
        const widthMs = (width * 1000) / fs;
        if (widthMs < 80 || widthMs > 700) continue;

        lastPeakIdx = i; // keep latest valid one
      }
    }
    return lastPeakIdx;
  }
}

/**
 * Tail-only moving average. Returns a Float64Array of length N where
 * ma[i] is the mean of x[i-w+1 .. i] (or shorter near the start).
 * Allocates one array — acceptable because only invoked on the
 * spectral-update tick, not per-sample.
 */
function movingAverageTail(x: Float64Array, w: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += x[i];
    if (i >= w) sum -= x[i - w];
    const denom = Math.min(i + 1, w);
    out[i] = sum / denom;
  }
  return out;
}

export const dualDetectorFusion = new DualDetectorFusion();