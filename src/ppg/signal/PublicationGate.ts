/**
 * PUBLICATION GATE
 * 
 * Strict publication criteria for physiological values.
 * 
 * Rules:
 * - NO publish BPM if:
 *   - bufferDuration < 8s
 *   - fpsMedian < 18
 *   - validPixelRatio < 0.70
 *   - saturationRatio > 0.45
 *   - darkRatio > 0.40
 *   - spectralPeakRatio < 0.35
 *   - perfusionProxy < threshold
 *   - beatsValid < 5
 *   - RR_CV unreasonable
 *   - BPM_time vs BPM_freq diff > 8 BPM
 *   - sqiOverall < 0.65
 * - NO publish SpO2 without calibration
 * - NO publish waveform as "real" without evidence
 * - Show technical state if fails
 */

import type { PpgState, PublicationGateResult, SignalQualityMetrics } from './PpgTypes';

export interface PublicationGateInput {
  bufferDuration: number;
  fpsMedian: number;
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  spectralPeakRatio: number;
  spectralPeakHz: number;
  perfusionProxy: number;
  beatsValid: number;
  rrCV: number;
  bpmTime: number;
  bpmFreq: number;
  sqiOverall: number;
  spo2Calibrated: boolean;
}

const THRESHOLDS = {
  BUFFER_DURATION_MIN: 8000, // ms
  FPS_MIN: 18,
  VALID_PIXEL_MIN: 0.70,
  SATURATION_MAX: 0.45,
  DARK_MAX: 0.40,
  SPECTRAL_PEAK_RATIO_MIN: 0.35,
  SPECTRAL_MIN_HZ: 0.7,
  SPECTRAL_MAX_HZ: 4.0,
  PERFUSION_MIN: 0.01,
  BEATS_MIN: 5,
  RR_CV_MAX: 0.5,
  BPM_TOLERANCE: 8,
  SQI_OVERALL_MIN: 0.65,
};

export class PublicationGate {
  /**
   * Evaluate publication gate
   */
  evaluate(input: PublicationGateInput): PublicationGateResult {
    const blockReasons: string[] = [];
    let currentStatus: PpgState = 'searching_signal';
    
    // Check buffer duration
    if (input.bufferDuration < THRESHOLDS.BUFFER_DURATION_MIN) {
      blockReasons.push(`INSUFFICIENT_BUFFER (${(input.bufferDuration / 1000).toFixed(1)}s < ${THRESHOLDS.BUFFER_DURATION_MIN / 1000}s)`);
      currentStatus = 'searching_signal';
    }
    
    // Check FPS
    if (input.fpsMedian < THRESHOLDS.FPS_MIN) {
      blockReasons.push(`LOW_FPS (${input.fpsMedian.toFixed(1)} < ${THRESHOLDS.FPS_MIN})`);
      currentStatus = 'searching_signal';
    }
    
    // Check valid pixels
    if (input.validPixelRatio < THRESHOLDS.VALID_PIXEL_MIN) {
      blockReasons.push(`LOW_VALID_PIXELS (${(input.validPixelRatio * 100).toFixed(0)}%)`);
      currentStatus = 'no_ppg_signal';
    }
    
    // Check saturation
    if (input.saturationRatio > THRESHOLDS.SATURATION_MAX) {
      blockReasons.push(`SATURATED (${(input.saturationRatio * 100).toFixed(0)}%)`);
      currentStatus = 'saturated';
    }
    
    // Check dark
    if (input.darkRatio > THRESHOLDS.DARK_MAX) {
      blockReasons.push(`DARK_FRAME (${(input.darkRatio * 100).toFixed(0)}%)`);
      currentStatus = 'dark_frame';
    }
    
    // Check spectral peak ratio
    if (input.spectralPeakRatio < THRESHOLDS.SPECTRAL_PEAK_RATIO_MIN) {
      blockReasons.push(`LOW_SPECTRAL_CONCENTRATION (${input.spectralPeakRatio.toFixed(3)})`);
      currentStatus = 'low_perfusion';
    }
    
    // Check spectral peak frequency
    if (input.spectralPeakHz < THRESHOLDS.SPECTRAL_MIN_HZ || 
        input.spectralPeakHz > THRESHOLDS.SPECTRAL_MAX_HZ) {
      blockReasons.push(`SPECTRAL_OUT_OF_RANGE (${input.spectralPeakHz.toFixed(2)} Hz)`);
      currentStatus = 'no_ppg_signal';
    }
    
    // Check perfusion
    if (input.perfusionProxy < THRESHOLDS.PERFUSION_MIN) {
      blockReasons.push(`LOW_PERFUSION (${input.perfusionProxy.toFixed(4)})`);
      currentStatus = 'low_perfusion';
    }
    
    // Check beats
    if (input.beatsValid < THRESHOLDS.BEATS_MIN) {
      blockReasons.push(`INSUFFICIENT_BEATS (${input.beatsValid} < ${THRESHOLDS.BEATS_MIN})`);
      currentStatus = 'searching_signal';
    }
    
    // Check RR CV
    if (input.rrCV > THRESHOLDS.RR_CV_MAX) {
      blockReasons.push(`HIGH_RR_CV (${input.rrCV.toFixed(3)})`);
      currentStatus = 'motion_artifact';
    }
    
    // Check BPM agreement
    const bpmDiff = Math.abs(input.bpmTime - input.bpmFreq);
    if (bpmDiff > THRESHOLDS.BPM_TOLERANCE) {
      blockReasons.push(`BPM_MISMATCH (${bpmDiff.toFixed(1)} > ${THRESHOLDS.BPM_TOLERANCE})`);
      currentStatus = 'no_ppg_signal';
    }
    
    // Check SQI
    if (input.sqiOverall < THRESHOLDS.SQI_OVERALL_MIN) {
      blockReasons.push(`LOW_SQI (${input.sqiOverall.toFixed(2)} < ${THRESHOLDS.SQI_OVERALL_MIN})`);
      currentStatus = 'searching_signal';
    }
    
    // Determine final status
    const canPublishBpm = blockReasons.length === 0;
    const canPublishSpo2 = canPublishBpm && input.spo2Calibrated;
    const canPublishWaveform = canPublishBpm;
    
    if (canPublishBpm) {
      currentStatus = 'ppg_valid';
    } else if (blockReasons.length <= 2 && input.sqiOverall > 0.4) {
      currentStatus = 'ppg_candidate';
    }
    
    return {
      canPublishBpm,
      canPublishSpo2,
      canPublishWaveform,
      blockReasons,
      currentStatus,
    };
  }

  /**
   * Get SpO2 status
   */
  getSpo2Status(calibrated: boolean): 'CALIBRATED' | 'UNCALIBRATED' | 'NOT_AVAILABLE' {
    if (!calibrated) return 'UNCALIBRATED';
    return 'CALIBRATED';
  }
}
