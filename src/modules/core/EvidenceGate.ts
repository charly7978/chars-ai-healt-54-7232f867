/**
 * EVIDENCE GATE - Forensic-Grade Output Validation
 * 
 * Centralized gate that blocks all biometric outputs when:
 * - No stable finger contact detected
 * - Camera saturation/clipping detected
 * - FPS insufficient for reliable capture
 * - Signal Quality Index (SQI) below threshold
 * - Calibration required but not available
 * - Temporal incoherence detected
 * 
 * RULE: Fail closed. If in doubt, block output and explain why.
 * No simulated, estimated, or fallback values allowed.
 */

import { parameterRegistry, getEvidenceGateConfig, getQualityThreshold, getPhysiologicalLimit } from '@/config/medical-parameter-registry/loader';

export type EvidenceStatus = 
  | 'VALID'
  | 'NO_CONTACT'
  | 'SATURATION_DETECTED'
  | 'FPS_INSUFFICIENT'
  | 'SQI_INSUFFICIENT'
  | 'CALIBRATION_REQUIRED'
  | 'TEMPORALLY_INCOHERENT'
  | 'MULTIPLE_FAILURES';

export interface EvidenceResult {
  status: EvidenceStatus;
  allowed: boolean;
  reason: string;
  technicalDetails: Record<string, unknown>;
  timestamp: number;
  calibrationState: {
    spo2: boolean;
    bloodPressure: boolean;
    glucose: boolean;
    lipids: boolean;
  };
}

export interface SignalEvidence {
  timestamp: number;
  contactState: 'NO_CONTACT' | 'CONTACT_PARTIAL' | 'STABLE_CONTACT' | 'UNSTABLE';
  saturationRatio: number;  // 0-1, high = saturated
  fps: number;
  sqi: number;  // Signal Quality Index 0-100
  perfusionIndex: number;
  calibrationAvailable: {
    spo2: boolean;
    bloodPressure: boolean;
    glucose: boolean;
    lipids: boolean;
  };
  temporalCoherence?: {
    lastFrameDeltaMs: number;
    expectedDeltaMs: number;
    jitterMs: number;
  };
}

/**
 * EvidenceGate - Central forensic validator
 * 
 * Implements fail-closed logic: any doubt blocks output.
 */
export class EvidenceGate {
  private config = getEvidenceGateConfig();
  private lastValidEvidence: SignalEvidence | null = null;
  private failureHistory: Array<{ timestamp: number; reason: EvidenceStatus }> = [];
  private readonly MAX_FAILURE_HISTORY = 100;

  /**
   * Validate if a signal meets forensic standards for biometric output
   */
  validate(evidence: SignalEvidence): EvidenceResult {
    const failures: EvidenceStatus[] = [];
    const technicalDetails: Record<string, unknown> = {};
    const thresholds = getQualityThreshold('signalQualityIndex');
    const perfusionThresholds = getQualityThreshold('perfusionIndex');

    // Check 1: Contact detection
    if (evidence.contactState === 'NO_CONTACT' || evidence.contactState === 'UNSTABLE') {
      failures.push('NO_CONTACT');
      technicalDetails.contactState = evidence.contactState;
    }

    // Check 2: Saturation/clipping
    if (evidence.saturationRatio > 0.15) {  // From config: highClipThreshold
      failures.push('SATURATION_DETECTED');
      technicalDetails.saturationRatio = evidence.saturationRatio;
      technicalDetails.threshold = 0.15;
    }

    // Check 3: FPS sufficiency
    const fpsLimits = getPhysiologicalLimit('fps' as any) || { min: 15 };
    if (evidence.fps < 15) {  // Minimum 15 FPS for reliable PPG
      failures.push('FPS_INSUFFICIENT');
      technicalDetails.actualFps = evidence.fps;
      technicalDetails.requiredFps = 15;
    }

    // Check 4: Signal Quality Index
    if (evidence.sqi < thresholds.sufficient) {  // Config: sufficient = 24
      failures.push('SQI_INSUFFICIENT');
      technicalDetails.actualSqi = evidence.sqi;
      technicalDetails.requiredSqi = thresholds.sufficient;
      technicalDetails.thresholds = thresholds;
    }

    // Check 5: Perfusion Index (AC/DC ratio)
    if (evidence.perfusionIndex < perfusionThresholds.min) {  // Config: min = 0.003
      failures.push('SQI_INSUFFICIENT');  // Grouped under SQI
      technicalDetails.perfusionIndex = evidence.perfusionIndex;
      technicalDetails.requiredPerfusion = perfusionThresholds.min;
    }

    // Check 6: Temporal coherence (prevent frame drops/jumps)
    if (evidence.temporalCoherence) {
      const { jitterMs, expectedDeltaMs } = evidence.temporalCoherence;
      const maxAllowedJitter = expectedDeltaMs * 0.5;  // 50% tolerance
      if (jitterMs > maxAllowedJitter) {
        failures.push('TEMPORALLY_INCOHERENT');
        technicalDetails.jitterMs = jitterMs;
        technicalDetails.maxAllowedJitter = maxAllowedJitter;
      }
    }

    // Record failure if any
    if (failures.length > 0) {
      this.recordFailure(failures[0]);
    } else {
      this.lastValidEvidence = evidence;
    }

    // Determine final status
    let status: EvidenceStatus;
    if (failures.length === 0) {
      status = 'VALID';
    } else if (failures.length === 1) {
      status = failures[0];
    } else {
      status = 'MULTIPLE_FAILURES';
      technicalDetails.allFailures = failures;
    }

    // Build human-readable reason
    const reason = this.buildReason(status, technicalDetails);

    return {
      status,
      allowed: status === 'VALID',
      reason,
      technicalDetails,
      timestamp: Date.now(),
      calibrationState: evidence.calibrationAvailable,
    };
  }

  /**
   * Check if a specific biometric type can be output
   * Additional check: calibration requirements
   */
  canOutputBiometric(
    baseResult: EvidenceResult, 
    biometricType: 'spo2' | 'bloodPressure' | 'glucose' | 'lipids' | 'bpm' | 'arrhythmia'
  ): { allowed: boolean; reason: string; outputLabel?: string } {
    // First check base evidence
    if (!baseResult.allowed) {
      return {
        allowed: false,
        reason: `Evidence gate blocked: ${baseResult.reason}`,
      };
    }

    // BPM and arrhythmia don't require calibration (derived directly from signal)
    if (biometricType === 'bpm' || biometricType === 'arrhythmia') {
      return { allowed: true, reason: 'Direct signal derivation' };
    }

    // Check calibration requirement
    const requiresCal = parameterRegistry.requiresCalibration(biometricType);
    const hasCalibration = baseResult.calibrationState[biometricType];

    if (requiresCal && !hasCalibration) {
      const label = parameterRegistry.getUncalibratedLabel(biometricType);
      return {
        allowed: false,  // FAIL CLOSED: no calibration = no output
        reason: `Calibration required for ${biometricType}. Population model not sufficient for forensic use.`,
        outputLabel: label,
      };
    }

    return { allowed: true, reason: 'Calibration validated' };
  }

  /**
   * Get last valid evidence timestamp
   */
  getLastValidTimestamp(): number | null {
    return this.lastValidEvidence?.timestamp ?? null;
  }

  /**
   * Get failure history for forensic audit
   */
  getFailureHistory(): Array<{ timestamp: number; reason: EvidenceStatus }> {
    return [...this.failureHistory];
  }

  /**
   * Clear failure history
   */
  clearFailureHistory(): void {
    this.failureHistory = [];
  }

  private recordFailure(reason: EvidenceStatus): void {
    this.failureHistory.push({
      timestamp: Date.now(),
      reason,
    });

    // Trim history
    if (this.failureHistory.length > this.MAX_FAILURE_HISTORY) {
      this.failureHistory = this.failureHistory.slice(-this.MAX_FAILURE_HISTORY);
    }
  }

  private buildReason(status: EvidenceStatus, details: Record<string, unknown>): string {
    switch (status) {
      case 'VALID':
        return 'All forensic checks passed';
      case 'NO_CONTACT':
        return `No stable finger contact detected (state: ${details.contactState}). Place finger fully on camera lens.`;
      case 'SATURATION_DETECTED':
        return `Camera saturation detected (${Math.round((details.saturationRatio as number) * 100)}%). Reduce ambient light or adjust finger pressure.`;
      case 'FPS_INSUFFICIENT':
        return `Frame rate insufficient (${details.actualFps} FPS, need ${details.requiredFps}+). Close other apps or use better lighting.`;
      case 'SQI_INSUFFICIENT':
        return `Signal Quality Index insufficient (${details.actualSqi}/${details.requiredSqi}). Hold finger steady, apply gentle pressure.`;
      case 'CALIBRATION_REQUIRED':
        return 'Device calibration required for this measurement type. Population model insufficient for forensic use.';
      case 'TEMPORALLY_INCOHERENT':
        return `Frame timing incoherent (jitter: ${details.jitterMs}ms). System may be overloaded.`;
      case 'MULTIPLE_FAILURES':
        return `Multiple quality checks failed: ${(details.allFailures as string[]).join(', ')}`;
      default:
        return 'Unknown validation status';
    }
  }
}

// Singleton instance
export const evidenceGate = new EvidenceGate();

export default evidenceGate;
