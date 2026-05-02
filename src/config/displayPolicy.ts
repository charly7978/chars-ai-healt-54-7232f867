/**
 * DISPLAY POLICY CONFIGURATION
 * 
 * Defines how measurement values are presented in the UI
 * based on their confidence, quality, and calibration state.
 * 
 * CRITICAL: This configuration ONLY controls display behavior.
 * It does NOT generate, fabricate, or modify measurement values.
 * All values must be derived from actual PPG signal processing.
 */

// Output states for measurement display
export type OutputState =
  | 'ENABLED_HIGH_CONFIDENCE'
  | 'ENABLED_MEDIUM_CONFIDENCE'
  | 'ENABLED_LOW_CONFIDENCE'
  | 'RESEARCH_ONLY'
  | 'WITHHELD_LOW_QUALITY'
  | 'UNCALIBRATED'
  | 'NO_CONTACT'
  | 'SIGNAL_DEGRADED'
  | 'NOT_ESTIMABLE';

// Display confidence levels
export interface DisplayConfidence {
  level: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  color: string;
  icon: 'check' | 'warning' | 'alert' | 'none';
  showValue: boolean;
  showWarning: boolean;
  warningText?: string;
}

// State-based display configuration
export const DISPLAY_POLICY: Record<OutputState, DisplayConfidence> = {
  ENABLED_HIGH_CONFIDENCE: {
    level: 'HIGH',
    color: '#22c55e', // green-500
    icon: 'check',
    showValue: true,
    showWarning: false,
  },
  ENABLED_MEDIUM_CONFIDENCE: {
    level: 'MEDIUM',
    color: '#3b82f6', // blue-500
    icon: 'check',
    showValue: true,
    showWarning: false,
    warningText: 'Estimación con confianza moderada',
  },
  ENABLED_LOW_CONFIDENCE: {
    level: 'LOW',
    color: '#f59e0b', // amber-500
    icon: 'warning',
    showValue: true,
    showWarning: true,
    warningText: 'Estimación de baja confianza - verificar señal',
  },
  RESEARCH_ONLY: {
    level: 'LOW',
    color: '#a855f7', // purple-500
    icon: 'warning',
    showValue: true,
    showWarning: true,
    warningText: 'Solo investigación - no usar para diagnóstico',
  },
  WITHHELD_LOW_QUALITY: {
    level: 'INSUFFICIENT',
    color: '#6b7280', // gray-500
    icon: 'none',
    showValue: false,
    showWarning: true,
    warningText: 'Señal insuficiente - ajustar posición del dedo',
  },
  UNCALIBRATED: {
    level: 'LOW',
    color: '#f59e0b', // amber-500
    icon: 'warning',
    showValue: true,
    showWarning: true,
    warningText: 'Dispositivo no calibrado - valores estimados',
  },
  NO_CONTACT: {
    level: 'INSUFFICIENT',
    color: '#6b7280', // gray-500
    icon: 'none',
    showValue: false,
    showWarning: true,
    warningText: 'Coloque su dedo sobre la cámara y el flash',
  },
  SIGNAL_DEGRADED: {
    level: 'LOW',
    color: '#ef4444', // red-500
    icon: 'alert',
    showValue: true,
    showWarning: true,
    warningText: 'Señal degradada - mantener posición estable',
  },
  NOT_ESTIMABLE: {
    level: 'INSUFFICIENT',
    color: '#6b7280', // gray-500
    icon: 'none',
    showValue: false,
    showWarning: true,
    warningText: 'No estimable con señal actual',
  },
} as const;

// Quality thresholds for state transitions
export const QUALITY_POLICY = {
  HIGH: {
    minQuality: 60,
    minConfidence: 0.6,
    minBeats: 5,
  },
  MEDIUM: {
    minQuality: 35,
    minConfidence: 0.35,
    minBeats: 3,
  },
  LOW: {
    minQuality: 15,
    minConfidence: 0.15,
    minBeats: 2,
  },
} as const;

// Calibration state display mapping
export const CALIBRATION_DISPLAY: Record<string, string> = {
  UNCALIBRATED: 'Sin calibrar',
  SESSION_CALIBRATED: 'Calibrado sesión',
  DEVICE_CALIBRATED: 'Calibrado dispositivo',
} as const;

// Helper to determine output state from metrics
export function determineOutputState(
  value: number,
  confidence: number,
  quality: number,
  beatCount: number,
  isCalibrated: boolean = false,
  isResearchMode: boolean = false
): OutputState {
  if (value <= 0) {
    return 'NOT_ESTIMABLE';
  }

  if (isResearchMode && !isCalibrated) {
    return confidence >= 0.35 ? 'RESEARCH_ONLY' : 'WITHHELD_LOW_QUALITY';
  }

  if (confidence >= QUALITY_POLICY.HIGH.minConfidence && 
      quality >= QUALITY_POLICY.HIGH.minQuality && 
      beatCount >= QUALITY_POLICY.HIGH.minBeats) {
    return 'ENABLED_HIGH_CONFIDENCE';
  }

  if (confidence >= QUALITY_POLICY.MEDIUM.minConfidence && 
      quality >= QUALITY_POLICY.MEDIUM.minQuality && 
      beatCount >= QUALITY_POLICY.MEDIUM.minBeats) {
    return 'ENABLED_MEDIUM_CONFIDENCE';
  }

  if (confidence >= QUALITY_POLICY.LOW.minConfidence && 
      quality >= QUALITY_POLICY.LOW.minQuality && 
      beatCount >= QUALITY_POLICY.LOW.minBeats) {
    return 'ENABLED_LOW_CONFIDENCE';
  }

  if (!isCalibrated && quality >= QUALITY_POLICY.LOW.minQuality) {
    return 'UNCALIBRATED';
  }

  return 'WITHHELD_LOW_QUALITY';
}
