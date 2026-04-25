/**
 * BEAT-TO-BEAT FIDUCIAL DELINEATOR
 *
 * Given the most recent samples of the filtered PPG signal that contain ONE beat,
 * locate four canonical landmarks and derive morphology metrics:
 *
 *   1. FOOT       — minimum on the upstroke side of the systolic peak.
 *                   Found by scanning backwards from peakIdx until the signal
 *                   stops decreasing (1st-derivative sign change −→+).
 *
 *   2. SYSTOLIC   — supplied peakIdx, refined by parabolic interpolation over
 *                   the 3-sample neighbourhood for sub-sample accuracy.
 *
 *   3. DICROTIC   — local minimum on the downstroke between systolic peak and
 *      NOTCH       end-of-window. Detected via second-derivative sign change
 *                  (concave-down → concave-up), with a fallback to the first
 *                  point where the 1st derivative changes from negative to
 *                  near-zero. Only kept if depth ≥ 3% of pulse amplitude.
 *
 *   4. DIASTOLIC  — local maximum AFTER the dicrotic notch, before the next
 *      PEAK        foot. Reflection wave from the periphery.
 *
 * Output also includes morphology metrics:
 *   • riseTimeMs       (foot → systolic)
 *   • decayTimeMs      (systolic → end of window)
 *   • pulseWidth50Ms   (width at 50% of pulse amplitude)
 *   • notchDepth       (relative depth of notch in [0,1])
 *   • reflectionIndex  (diastolic / systolic amplitude)
 *   • morphologyValidity in [0,1] from physiological plausibility checks.
 *
 * Hot-path conscious: indexed loops, no allocations beyond the returned object.
 */
import type { BeatFiducials } from '../../types/fiducials';

const EMPTY: BeatFiducials = {
  footIdx: -1, systolicIdx: -1, notchIdx: -1, diastolicIdx: -1,
  riseTimeMs: 0, decayTimeMs: 0, pulseWidth50Ms: 0,
  notchDepth: 0, reflectionIndex: 0,
  morphologyValidity: 0, complete: false,
};

export class FiducialDelineator {
  /**
   * @param samples       Float64Array containing the analysis window. Must contain
   *                      ≥10 samples before peakIdx and ≥6 samples after.
   * @param peakIdx       Index of the detected systolic peak inside `samples`.
   * @param sampleRateHz  Effective sample rate (used to convert sample indices → ms).
   */
  delineate(samples: Float64Array, peakIdx: number, sampleRateHz: number): BeatFiducials {
    const n = samples.length;
    if (n < 16 || peakIdx < 6 || peakIdx >= n - 4 || sampleRateHz < 5) {
      return { ...EMPTY };
    }
    const msPerSample = 1000 / sampleRateHz;

    // ─── 1. FOOT (search back from peak for last local minimum) ───────────
    // Walk backwards while the signal keeps decreasing; the first index whose
    // neighbour is higher (or equal) is the foot.
    let footIdx = peakIdx;
    for (let i = peakIdx - 1; i >= 1; i--) {
      if (samples[i] <= samples[i - 1] && samples[i] <= samples[i + 1]) {
        footIdx = i;
        break;
      }
      // Hard cap: don't search more than 800 ms into the past.
      if ((peakIdx - i) * msPerSample > 800) {
        footIdx = i;
        break;
      }
    }
    if (footIdx >= peakIdx) return { ...EMPTY };

    // ─── 2. SYSTOLIC PEAK refinement (parabolic interpolation) ────────────
    // Sub-sample peak position improves rise-time precision.
    let systolicAmp = samples[peakIdx];
    {
      const yL = samples[peakIdx - 1], yC = samples[peakIdx], yR = samples[peakIdx + 1];
      const denom = yL - 2 * yC + yR;
      if (Math.abs(denom) > 1e-9) {
        const offset = 0.5 * (yL - yR) / denom;
        if (Math.abs(offset) < 1) {
          systolicAmp = yC - 0.25 * (yL - yR) * offset;
        }
      }
    }
    const pulseAmp = systolicAmp - samples[footIdx];
    if (pulseAmp <= 0) return { ...EMPTY };

    // ─── 3. DICROTIC NOTCH (local minimum on downstroke) ──────────────────
    // Search after peak. Use 2nd derivative: notch is where concavity flips
    // from negative (downward curvature, falling) to positive (upward, recovery).
    let notchIdx = -1;
    let notchDepth = 0;
    const searchEnd = Math.min(n - 2, peakIdx + Math.round(450 / msPerSample));
    let prevD2Sign = 0;
    let bestNotchScore = 0;
    for (let i = peakIdx + 2; i < searchEnd; i++) {
      const d2 = samples[i + 1] - 2 * samples[i] + samples[i - 1];
      const sign = d2 > 0 ? 1 : (d2 < 0 ? -1 : 0);
      // Local minimum test: sample lower than both neighbours
      const isLocalMin = samples[i] < samples[i - 1] && samples[i] <= samples[i + 1];
      if (isLocalMin || (prevD2Sign < 0 && sign > 0)) {
        const depth = (systolicAmp - samples[i]) / pulseAmp; // 0 = at peak, 1 = back to foot level
        // Notch must be on the downstroke (below peak, above foot), and a local dip.
        const aboveFoot = samples[i] > samples[footIdx];
        const belowPeak = samples[i] < systolicAmp - 0.03 * pulseAmp;
        if (aboveFoot && belowPeak) {
          // Score prefers: clear depth, earlier in physiological window (150–350 ms post-peak).
          const tMs = (i - peakIdx) * msPerSample;
          const timeScore = tMs >= 120 && tMs <= 400 ? 1 : 0.4;
          const score = depth * timeScore;
          if (score > bestNotchScore) {
            bestNotchScore = score;
            notchIdx = i;
            notchDepth = Math.max(0, Math.min(1, depth));
          }
        }
      }
      prevD2Sign = sign;
    }
    if (notchDepth < 0.03) {
      notchIdx = -1;
      notchDepth = 0;
    }

    // ─── 4. DIASTOLIC PEAK (local max after notch) ────────────────────────
    let diastolicIdx = -1;
    let reflectionIndex = 0;
    if (notchIdx > 0) {
      const dEnd = Math.min(n - 2, notchIdx + Math.round(350 / msPerSample));
      let bestAmp = samples[notchIdx];
      for (let i = notchIdx + 1; i < dEnd; i++) {
        if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1] && samples[i] > bestAmp) {
          // Must be lower than systolic but higher than notch by ≥ 1% of amplitude.
          if (samples[i] < systolicAmp && (samples[i] - samples[notchIdx]) / pulseAmp > 0.01) {
            diastolicIdx = i;
            bestAmp = samples[i];
          }
        }
      }
      if (diastolicIdx > 0) {
        const dAmp = samples[diastolicIdx] - samples[footIdx];
        reflectionIndex = Math.max(0, Math.min(1.5, dAmp / pulseAmp));
      }
    }

    // ─── 5. PULSE WIDTH at 50% of pulse amplitude ─────────────────────────
    const halfLevel = samples[footIdx] + 0.5 * pulseAmp;
    let leftCross = footIdx, rightCross = peakIdx;
    for (let i = footIdx; i <= peakIdx; i++) {
      if (samples[i] >= halfLevel) { leftCross = i; break; }
    }
    for (let i = peakIdx; i < n - 1; i++) {
      if (samples[i] < halfLevel) { rightCross = i; break; }
      rightCross = i;
    }
    const pulseWidth50Ms = (rightCross - leftCross) * msPerSample;

    const riseTimeMs = (peakIdx - footIdx) * msPerSample;
    const decayTimeMs = (n - 1 - peakIdx) * msPerSample;

    // ─── 6. MORPHOLOGY VALIDITY (physiological plausibility) ──────────────
    let validity = 0;
    // Rise time: human PPG systolic upstroke ~80–250 ms.
    if (riseTimeMs >= 70 && riseTimeMs <= 280) validity += 0.30;
    else if (riseTimeMs >= 50 && riseTimeMs <= 350) validity += 0.15;
    // Pulse width 50: ~150–500 ms.
    if (pulseWidth50Ms >= 130 && pulseWidth50Ms <= 520) validity += 0.20;
    // Notch present is a strong sign of a clean beat.
    if (notchIdx > 0 && notchDepth >= 0.05 && notchDepth <= 0.6) validity += 0.25;
    // Reflection index in physiological range.
    if (reflectionIndex >= 0.25 && reflectionIndex <= 0.95) validity += 0.15;
    // Decay > rise (asymmetry of a real PPG pulse).
    if (decayTimeMs > riseTimeMs * 1.1) validity += 0.10;

    const complete = footIdx >= 0 && peakIdx > footIdx && notchIdx > peakIdx && diastolicIdx > notchIdx;

    return {
      footIdx,
      systolicIdx: peakIdx,
      notchIdx,
      diastolicIdx,
      riseTimeMs,
      decayTimeMs,
      pulseWidth50Ms,
      notchDepth,
      reflectionIndex,
      morphologyValidity: Math.max(0, Math.min(1, validity)),
      complete,
    };
  }
}