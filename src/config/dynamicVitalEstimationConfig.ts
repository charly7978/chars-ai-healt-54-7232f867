/**
 * DYNAMIC VITAL ESTIMATION CONFIGURATION
 *
 * Centralizes the thresholds and gating windows the UI/pipeline use to
 * decide WHEN a vital sign is allowed to be displayed and WITH WHAT
 * confidence. These values are PROCESSING parameters — they never
 * substitute for, replace or fabricate clinical results.
 *
 * No biometric value (BPM, SpO2, BP, glucose, lipids, arrhythmia) may be
 * defaulted from this file. Only the gates and timing windows.
 */

/**
 * Minimum stability requirements for a sample to feed the vital-signs
 * processor without being treated as background-noise.
 */
export const STABLE_SIGNAL_GATE = {
  /** Minimum global SQI (0-100) at which signal is considered HUMAN. */
  MIN_QUALITY: 12,
  /** Minimum perfusion index (AC/DC fraction) for any AC/DC math. */
  MIN_PERFUSION: 0.005,
  /** Required upstream contact label. */
  REQUIRED_CONTACT: 'STABLE_CONTACT' as const,
} as const;

/**
 * Temporal window before "no contact" silently zeroes the live HUD.
 * Increase = persists last legitimate value longer; decrease = zeroes
 * faster. The zeroing only happens after this many consecutive UNSTABLE
 * frames AND only when the upstream contact label drops.
 */
export const HUD_PERSISTENCE = {
  /** Frames of degraded signal that must elapse before HUD zeroes vitals. */
  UNSTABLE_ZERO_FRAMES: 30,
  /** Process vitals only every N frames (rate limiter). */
  VITALS_PROCESS_EVERY_N_FRAMES: 3,
} as const;

/**
 * Pressure-quality gate used to declare "OPTIMAL" finger pressure for
 * BP-feature extraction. Below these, BP estimate is allowed but its
 * confidence is downgraded.
 */
export const PRESSURE_GATE = {
  MIN_QUALITY_SCORE: 0.55,
  REQUIRES_LOCK: true,
  REJECT_IF_DRIFTING: true,
} as const;

/**
 * ROI/source-stability scoring weights (single source of truth — used
 * both by the HUD ribbon and by the per-beat ROI audit).
 */
export const ROI_SCORE_WEIGHTS = {
  QUALITY: 0.7,
  LOCK_BONUS: 0.3,
  DRIFT_PENALTY: 0.4,
  /** Drift fraction that maps to penalty=1.0. */
  DRIFT_NORMALIZATION: 0.30,
} as const;

/**
 * Per-beat ROI stability persistent-alert state.
 */
export const ROI_STABILITY_ALERT = {
  THRESHOLD: 0.55,                // [0..1] — below = "low"
  TRIGGER_BEATS: 5,               // consecutive low beats to trigger alert
  RECOVER_BEATS: 3,               // consecutive good beats to clear alert
  AUDIT_LOG_MAX: 64,
} as const;

/**
 * Compute the canonical ROI stability score from a position-quality
 * snapshot. Used in two places (HUD ribbon and per-beat ROI audit) so
 * the formula is defined ONCE here.
 */
export function computeRoiStabilityScore(pq: {
  qualityScore: number;
  locked: boolean;
  positionDrift: number;
}): number {
  const drift = Math.max(0, pq.positionDrift || 0);
  const driftPenalty = Math.min(1, drift / ROI_SCORE_WEIGHTS.DRIFT_NORMALIZATION);
  const score =
    (pq.qualityScore || 0) * ROI_SCORE_WEIGHTS.QUALITY +
    (pq.locked ? ROI_SCORE_WEIGHTS.LOCK_BONUS : 0) -
    driftPenalty * ROI_SCORE_WEIGHTS.DRIFT_PENALTY;
  return Math.max(0, Math.min(1, score));
}

/**
 * EMA smoothing alpha for HUD-only display smoothing.
 * Used ONLY when contact is stable. When contact is uncertain the HUD
 * MUST show raw values so the operator sees the real measurement.
 */
export const HUD_SMOOTHING = {
  EMA_ALPHA: 0.30,
} as const;

/**
 * Minimum BPM confidence the vital-signs processor accepts before it
 * trusts the rrData stream for BP/glucose/lipids feature extraction.
 */
export const VITAL_FEATURE_GATE = {
  MIN_BPM_CONFIDENCE: 0.18,
  MIN_RR_INTERVALS: 2,
} as const;
