/**
 * PPG SIGNAL CONFIGURATION
 * 
 * Centralized DSP parameters for PPG signal processing.
 * These are mathematical constants and calibration parameters,
 * NOT clinical results or simulated values.
 */

// Buffer sizes (samples)
export const BUFFER_CONFIG = {
  RING_BUFFER_SIZE: 300,
  FRAME_TIME_BUFFER_SIZE: 120,
  MAX_RR_INTERVALS: 40,
  MAX_ACCEPTED_BEATS: 60,
  TEMPLATE_WINDOW: 25,
} as const;

// Frame rate constraints (Hz)
export const FPS_CONFIG = {
  MIN_FPS: 15,
  MAX_FPS: 60,
  DEFAULT_FPS: 30,
  TARGET_FPS: 30,
} as const;

// Contact detection thresholds
export const CONTACT_CONFIG = {
  FINGER_CONFIRM_FRAMES: 10,
  FINGER_LOST_FRAMES: 120,
  STABLE_CONTACT_THRESHOLD: 40,
  UNSTABLE_GRACE_FRAMES: 160,
  POS_LOCK_FRAMES: 60,
  POS_DRIFT_TOLERANCE: 0.12,
} as const;

// Signal quality thresholds (0-100)
export const QUALITY_THRESHOLDS = {
  HIGH: 60,
  MEDIUM: 35,
  LOW: 15,
  MINIMAL: 8,
  SUFFICIENT: 24,
} as const;

// Perfusion index thresholds (%)
export const PERFUSION_CONFIG = {
  MIN_PI: 0.003,
  TARGET_PI: 0.05,
  SUFFICIENT_PI: 0.03,
} as const;

// RR interval constraints (ms)
export const RR_CONFIG = {
  MIN_RR: 270,
  MAX_RR: 2200,
  HARD_REFRACTORY_MS: 280,
  SOFT_REFRACTORY_MS: 380,
  MAX_BEAT_AGE_MS: 4000,
} as const;

// BPM constraints
export const BPM_CONFIG = {
  MIN_BPM: 35,
  MAX_BPM: 200,
  DEFAULT_BPM: 0, // No default - must be derived from signal
} as const;

// Clipping thresholds
export const CLIPPING_CONFIG = {
  HIGH_SATURATION: 253,
  LOW_SATURATION: 2,
  HIGH_CLIP_THRESHOLD: 0.15,
  SATURATED_CLIP_THRESHOLD: 0.30,
} as const;

// EMA smoothing alphas
export const SMOOTHING_CONFIG = {
  RGB_ALPHA: 0.04,
  COVERAGE_ALPHA: 0.05,
  BPM_ALPHA_STABLE: 0.25,
  BPM_ALPHA_HIGH_CHANGE: 0.06,
  BPM_ALPHA_MEDIUM_CHANGE: 0.12,
  VALUE_ALPHA_STABLE: 0.20,
  VALUE_ALPHA_DYNAMIC: 0.30,
} as const;

// Motion detection
export const MOTION_CONFIG = {
  THRESHOLD: 0.6,
  BASELINE_ALPHA_MOTION: 0.008,
  BASELINE_ALPHA_STABLE: 0.02,
  BASELINE_ALPHA_UNSTABLE: 0.04,
} as const;

// Sample rate estimation
export const SAMPLERATE_CONFIG = {
  MIN_INTERVAL_MS: 8,
  MAX_INTERVAL_MS: 120,
  MEDIAN_WINDOW: 30,
} as const;

// Source ranker configuration
export const SOURCERANKER_CONFIG = {
  HYSTERESIS_FRAMES: 45,
  MIN_SQI_FOR_SWITCH: 15,
} as const;
