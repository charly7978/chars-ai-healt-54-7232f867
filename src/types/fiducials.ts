/**
 * BEAT FIDUCIAL TYPES
 * Per-beat anatomical landmarks of a PPG pulse and morphology metrics derived from them.
 *
 * Indices are sample positions inside the analysis window passed to the delineator.
 * Times are millisecond offsets from the foot of the beat (sample-rate aware).
 *
 *      systolic peak ●
 *                   ╱ ╲
 *                  ╱   ●  dicrotic notch (local min on downstroke)
 *                 ╱     ╲╱╲
 *                ╱        ●  diastolic peak (reflection wave)
 *               ╱          ╲___
 *           ●  foot/onset
 */
export interface BeatFiducials {
  /** Sample index of the pulse foot (lowest point at the start of the beat). */
  footIdx: number;
  /** Sample index of the systolic peak inside the window. */
  systolicIdx: number;
  /** Sample index of the dicrotic notch (-1 if not detected with confidence). */
  notchIdx: number;
  /** Sample index of the diastolic (reflection) peak (-1 if not detected). */
  diastolicIdx: number;

  /** Rise time foot → systolic peak (ms). */
  riseTimeMs: number;
  /** Decay time systolic peak → end of analysed segment (ms). */
  decayTimeMs: number;
  /** Pulse width at 50% of peak amplitude (ms). 0 if not measurable. */
  pulseWidth50Ms: number;

  /** Notch depth as fraction of pulse amplitude in [0,1]. 0 if no notch. */
  notchDepth: number;
  /**
   * Reflection Index = (diastolic peak amplitude) / (systolic peak amplitude).
   * Typical human range ~0.3–0.8. 0 if diastolic peak not detected.
   */
  reflectionIndex: number;

  /**
   * Morphology validity score in [0,1] computed from physiological plausibility
   * of the fiducial timings & amplitudes (not from template matching).
   */
  morphologyValidity: number;

  /** True if all four landmarks (foot, systolic, notch, diastolic) were located. */
  complete: boolean;
}