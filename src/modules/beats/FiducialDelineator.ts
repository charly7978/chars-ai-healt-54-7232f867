/**
 * BEAT-TO-BEAT FIDUCIAL DELINEATOR
 *
 * Locates foot, systolic peak, dicrotic notch and diastolic peak inside a
 * windowed PPG beat, plus morphology metrics (rise time, pulse width @ 50%,
 * notch depth, reflection index, validity).
 *
 * All search ranges and plausibility thresholds are runtime-tunable via
 * `setParams()` — a UI panel can mutate them and morphologyScore updates
 * will be visible on the very next processed beat.
 */
import type { BeatFiducials } from '../../types/fiducials';

export interface FiducialParams {
  // Search-range bounds (ms)
  footMaxLookbackMs: number;
  notchSearchEndMs: number;
  notchTimeWindowMinMs: number;
  notchTimeWindowMaxMs: number;
  diastolicSearchEndMs: number;
  // Plausibility thresholds (fractions of pulse amplitude)
  notchDepthMin: number;
  notchDepthMax: number;
  notchBelowPeakFrac: number;
  diastolicMinRiseFrac: number;
  // Validity scoring — rise time bands (ms)
  riseTimeIdealMinMs: number;
  riseTimeIdealMaxMs: number;
  riseTimeWideMinMs: number;
  riseTimeWideMaxMs: number;
  // Pulse width @50% bounds (ms)
  pulseWidth50MinMs: number;
  pulseWidth50MaxMs: number;
  // Reflection index bounds
  reflectionIdxMin: number;
  reflectionIdxMax: number;
}

export const DEFAULT_FIDUCIAL_PARAMS: FiducialParams = {
  footMaxLookbackMs: 800,
  notchSearchEndMs: 450,
  notchTimeWindowMinMs: 120,
  notchTimeWindowMaxMs: 400,
  diastolicSearchEndMs: 350,
  notchDepthMin: 0.03,
  notchDepthMax: 0.60,
  notchBelowPeakFrac: 0.03,
  diastolicMinRiseFrac: 0.01,
  riseTimeIdealMinMs: 70,
  riseTimeIdealMaxMs: 280,
  riseTimeWideMinMs: 50,
  riseTimeWideMaxMs: 350,
  pulseWidth50MinMs: 130,
  pulseWidth50MaxMs: 520,
  reflectionIdxMin: 0.25,
  reflectionIdxMax: 0.95,
};

const EMPTY: BeatFiducials = {
  footIdx: -1, systolicIdx: -1, notchIdx: -1, diastolicIdx: -1,
  riseTimeMs: 0, decayTimeMs: 0, pulseWidth50Ms: 0,
  notchDepth: 0, reflectionIndex: 0,
  morphologyValidity: 0, complete: false,
};

export class FiducialDelineator {
  private params: FiducialParams = { ...DEFAULT_FIDUCIAL_PARAMS };

  /** Replace any subset of the tunable params at runtime. */
  setParams(patch: Partial<FiducialParams>): void {
    this.params = { ...this.params, ...patch };
  }

  getParams(): FiducialParams {
    return { ...this.params };
  }

  delineate(samples: Float64Array, peakIdx: number, sampleRateHz: number): BeatFiducials {
    const n = samples.length;
    if (n < 16 || peakIdx < 6 || peakIdx >= n - 4 || sampleRateHz < 5) {
      return { ...EMPTY };
    }
    const msPerSample = 1000 / sampleRateHz;
    const P = this.params;

    // 1. FOOT — walk back until upstroke ends or hard cap reached
    let footIdx = peakIdx;
    for (let i = peakIdx - 1; i >= 1; i--) {
      if (samples[i] <= samples[i - 1] && samples[i] <= samples[i + 1]) {
        footIdx = i;
        break;
      }
      if ((peakIdx - i) * msPerSample > P.footMaxLookbackMs) {
        footIdx = i;
        break;
      }
    }
    if (footIdx >= peakIdx) return { ...EMPTY };

    // 2. SYSTOLIC peak refinement (parabolic interp)
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

    // 3. DICROTIC NOTCH — local min on downstroke, scored by depth + time
    let notchIdx = -1;
    let notchDepth = 0;
    const searchEnd = Math.min(n - 2, peakIdx + Math.round(P.notchSearchEndMs / msPerSample));
    let prevD2Sign = 0;
    let bestNotchScore = 0;
    for (let i = peakIdx + 2; i < searchEnd; i++) {
      const d2 = samples[i + 1] - 2 * samples[i] + samples[i - 1];
      const sign = d2 > 0 ? 1 : (d2 < 0 ? -1 : 0);
      const isLocalMin = samples[i] < samples[i - 1] && samples[i] <= samples[i + 1];
      if (isLocalMin || (prevD2Sign < 0 && sign > 0)) {
        const depth = (systolicAmp - samples[i]) / pulseAmp;
        const aboveFoot = samples[i] > samples[footIdx];
        const belowPeak = samples[i] < systolicAmp - P.notchBelowPeakFrac * pulseAmp;
        if (aboveFoot && belowPeak) {
          const tMs = (i - peakIdx) * msPerSample;
          const timeScore = tMs >= P.notchTimeWindowMinMs && tMs <= P.notchTimeWindowMaxMs ? 1 : 0.4;
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
    if (notchDepth < P.notchDepthMin) {
      notchIdx = -1;
      notchDepth = 0;
    }

    // 4. DIASTOLIC peak (local max after notch)
    let diastolicIdx = -1;
    let reflectionIndex = 0;
    if (notchIdx > 0) {
      const dEnd = Math.min(n - 2, notchIdx + Math.round(P.diastolicSearchEndMs / msPerSample));
      let bestAmp = samples[notchIdx];
      for (let i = notchIdx + 1; i < dEnd; i++) {
        if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1] && samples[i] > bestAmp) {
          if (samples[i] < systolicAmp && (samples[i] - samples[notchIdx]) / pulseAmp > P.diastolicMinRiseFrac) {
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

    // 5. PULSE WIDTH @ 50%
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

    // 6. MORPHOLOGY VALIDITY
    let validity = 0;
    if (riseTimeMs >= P.riseTimeIdealMinMs && riseTimeMs <= P.riseTimeIdealMaxMs) validity += 0.30;
    else if (riseTimeMs >= P.riseTimeWideMinMs && riseTimeMs <= P.riseTimeWideMaxMs) validity += 0.15;
    if (pulseWidth50Ms >= P.pulseWidth50MinMs && pulseWidth50Ms <= P.pulseWidth50MaxMs) validity += 0.20;
    if (notchIdx > 0 && notchDepth >= Math.max(0.05, P.notchDepthMin) && notchDepth <= P.notchDepthMax) validity += 0.25;
    if (reflectionIndex >= P.reflectionIdxMin && reflectionIndex <= P.reflectionIdxMax) validity += 0.15;
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
