/**
 * QUALITY THRESHOLDS — single source of truth
 *
 * Exposes registry-backed quality thresholds so the rest of the code does
 * not hardcode them. The numbers below are read at module-load time from
 * the Medical Parameter Registry.
 *
 * NOTE: this file does not produce or default any biometric value. It
 * exposes only quality-gate thresholds (SQI, perfusion, etc.).
 */

import { getQualityThreshold, getPhysiologicalLimit } from '@/config/medical-parameter-registry/loader';

const sqi = getQualityThreshold('signalQualityIndex');
const perfusion = getQualityThreshold('perfusionIndex');
const beatDetection = getQualityThreshold('beatDetection');
const bpm = getPhysiologicalLimit('bpm');
const rr = getPhysiologicalLimit('rrInterval');
const spo2 = getPhysiologicalLimit('spo2');

/**
 * Signal Quality Index thresholds (0-100).
 */
export const SQI = {
  HIGH: sqi.high,
  MEDIUM: sqi.medium,
  LOW: sqi.low,
  MINIMAL: sqi.minimal,
  SUFFICIENT: sqi.sufficient,
} as const;

/**
 * Perfusion Index thresholds (AC/DC ratio).
 */
export const PERFUSION = {
  MIN: perfusion.min,
  TARGET: perfusion.target,
  SUFFICIENT: perfusion.sufficient,
} as const;

/**
 * Beat detection acceptance thresholds.
 */
export const BEAT_DETECTION = {
  MIN_CONFIDENCE: beatDetection.minConfidence,
  TEMPLATE_CORRELATION: beatDetection.templateCorrelationThreshold,
} as const;

/**
 * Physiological limits used as VALIDATION (never as default output).
 */
export const PHYSIOLOGICAL_LIMITS = {
  BPM: { MIN: bpm.min, MAX: bpm.max },
  RR_MS: { MIN: rr.minMs, MAX: rr.maxMs },
  SPO2: { MIN: spo2.min, MAX: spo2.max },
} as const;
