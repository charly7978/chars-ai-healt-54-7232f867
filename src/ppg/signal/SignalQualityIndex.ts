/**
 * SIGNAL QUALITY INDEX
 * 
 * Calculates comprehensive signal quality metrics.
 * 
 * Metrics:
 * - sqiTemporal: temporal stability
 * - sqiSpectral: spectral concentration
 * - sqiMorphology: beat morphology quality
 * - sqiPerfusion: perfusion index
 * - sqiMotion: motion artifact level
 * - sqiSaturation: saturation ratio
 * - sqiFps: frame rate quality
 * - sqiOverall: weighted combination
 */

import type { SignalQualityMetrics } from './PpgTypes';

export interface SqiInput {
  temporalVariance: number;
  spectralPeakRatio: number;
  spectralPeakHz: number;
  morphologyScore: number;
  perfusionProxy: number;
  motionProxy: number;
  saturationRatio: number;
  darkRatio: number;
  validPixelRatio: number;
  fps: number;
  redDominance: number;
  channelCoherence: number;
}

const THRESHOLDS = {
  FPS_MIN: 18,
  VALID_PIXEL_MIN: 0.70,
  SATURATION_MAX: 0.45,
  DARK_MAX: 0.40,
  SPECTRAL_PEAK_RATIO_MIN: 0.35,
  SPECTRAL_MIN_HZ: 0.7,
  SPECTRAL_MAX_HZ: 4.0,
  PERFUSION_MIN: 0.01,
  MOTION_MAX: 0.3,
  COHERENCE_MIN: 0.5,
  RED_DOMINANCE_MIN: 1.0,
};

export class SignalQualityIndex {
  /**
   * Calculate all SQI metrics
   */
  calculate(input: SqiInput): SignalQualityMetrics {
    const temporal = this.calculateTemporalSqi(input);
    const spectral = this.calculateSpectralSqi(input);
    const morphology = this.calculateMorphologySqi(input);
    const perfusion = this.calculatePerfusionSqi(input);
    const motion = this.calculateMotionSqi(input);
    const saturation = this.calculateSaturationSqi(input);
    const fps = this.calculateFpsSqi(input);
    const overall = this.calculateOverallSqi({
      temporal,
      spectral,
      morphology,
      perfusion,
      motion,
      saturation,
      fps,
    });

    return {
      temporal,
      spectral,
      morphology,
      perfusion,
      motion,
      saturation,
      fps,
      overall,
    };
  }

  /**
   * Temporal SQI: based on variance stability
   */
  private calculateTemporalSqi(input: SqiInput): number {
    // Higher variance is good (has signal), but not too high (noise)
    const idealVariance = 0.02;
    const diff = Math.abs(input.temporalVariance - idealVariance);
    return Math.max(0, 1 - diff / 0.05);
  }

  /**
   * Spectral SQI: based on peak concentration and frequency
   */
  private calculateSpectralSqi(input: SqiInput): number {
    let score = 0;
    
    // Peak ratio
    score += Math.min(input.spectralPeakRatio / THRESHOLDS.SPECTRAL_PEAK_RATIO_MIN, 1) * 0.6;
    
    // Frequency in cardiac band
    if (input.spectralPeakHz >= THRESHOLDS.SPECTRAL_MIN_HZ && 
        input.spectralPeakHz <= THRESHOLDS.SPECTRAL_MAX_HZ) {
      score += 0.4;
    }
    
    return Math.min(score, 1);
  }

  /**
   * Morphology SQI: based on beat morphology score
   */
  private calculateMorphologySqi(input: SqiInput): number {
    return Math.min(input.morphologyScore / 100, 1);
  }

  /**
   * Perfusion SQI: based on perfusion proxy
   */
  private calculatePerfusionSqi(input: SqiInput): number {
    return Math.min(input.perfusionProxy / THRESHOLDS.PERFUSION_MIN, 1);
  }

  /**
   * Motion SQI: lower is better
   */
  private calculateMotionSqi(input: SqiInput): number {
    return Math.max(0, 1 - input.motionProxy / THRESHOLDS.MOTION_MAX);
  }

  /**
   * Saturation SQI: based on saturation and dark ratios
   */
  private calculateSaturationSqi(input: SqiInput): number {
    let score = 0;
    
    // Low saturation is good
    score += (1 - Math.min(input.saturationRatio / THRESHOLDS.SATURATION_MAX, 1)) * 0.5;
    
    // Low dark is good
    score += (1 - Math.min(input.darkRatio / THRESHOLDS.DARK_MAX, 1)) * 0.5;
    
    return score;
  }

  /**
   * FPS SQI: based on frame rate
   */
  private calculateFpsSqi(input: SqiInput): number {
    return Math.min(input.fps / THRESHOLDS.FPS_MIN, 1);
  }

  /**
   * Overall SQI: weighted combination
   */
  private calculateOverallSqi(metrics: {
    temporal: number;
    spectral: number;
    morphology: number;
    perfusion: number;
    motion: number;
    saturation: number;
    fps: number;
  }): number {
    const weights = {
      temporal: 0.15,
      spectral: 0.25,
      morphology: 0.20,
      perfusion: 0.15,
      motion: 0.10,
      saturation: 0.10,
      fps: 0.05,
    };

    return (
      metrics.temporal * weights.temporal +
      metrics.spectral * weights.spectral +
      metrics.morphology * weights.morphology +
      metrics.perfusion * weights.perfusion +
      metrics.motion * weights.motion +
      metrics.saturation * weights.saturation +
      metrics.fps * weights.fps
    );
  }

  /**
   * Check if SQI meets minimum threshold for publication
   */
  canPublish(sqi: SignalQualityMetrics, minOverall: number = 0.65): boolean {
    return sqi.overall >= minOverall;
  }

  /**
   * Get block reasons based on SQI
   */
  getBlockReasons(input: SqiInput, sqi: SignalQualityMetrics): string[] {
    const reasons: string[] = [];
    
    if (input.fps < THRESHOLDS.FPS_MIN) {
      reasons.push(`LOW_FPS (${input.fps.toFixed(1)} < ${THRESHOLDS.FPS_MIN})`);
    }
    
    if (input.validPixelRatio < THRESHOLDS.VALID_PIXEL_MIN) {
      reasons.push(`LOW_VALID_PIXELS (${(input.validPixelRatio * 100).toFixed(0)}%)`);
    }
    
    if (input.saturationRatio > THRESHOLDS.SATURATION_MAX) {
      reasons.push(`SATURATED (${(input.saturationRatio * 100).toFixed(0)}%)`);
    }
    
    if (input.darkRatio > THRESHOLDS.DARK_MAX) {
      reasons.push(`DARK_FRAME (${(input.darkRatio * 100).toFixed(0)}%)`);
    }
    
    if (input.spectralPeakRatio < THRESHOLDS.SPECTRAL_PEAK_RATIO_MIN) {
      reasons.push(`LOW_SPECTRAL_CONCENTRATION (${input.spectralPeakRatio.toFixed(3)})`);
    }
    
    if (input.spectralPeakHz < THRESHOLDS.SPECTRAL_MIN_HZ || 
        input.spectralPeakHz > THRESHOLDS.SPECTRAL_MAX_HZ) {
      reasons.push(`SPECTRAL_OUT_OF_RANGE (${input.spectralPeakHz.toFixed(2)} Hz)`);
    }
    
    if (input.perfusionProxy < THRESHOLDS.PERFUSION_MIN) {
      reasons.push(`LOW_PERFUSION (${input.perfusionProxy.toFixed(4)})`);
    }
    
    if (input.motionProxy > THRESHOLDS.MOTION_MAX) {
      reasons.push(`HIGH_MOTION (${input.motionProxy.toFixed(3)})`);
    }
    
    if (input.channelCoherence < THRESHOLDS.COHERENCE_MIN) {
      reasons.push(`LOW_COHERENCE (${input.channelCoherence.toFixed(3)})`);
    }
    
    if (input.redDominance < THRESHOLDS.RED_DOMINANCE_MIN) {
      reasons.push(`LOW_RED_DOMINANCE (${input.redDominance.toFixed(2)})`);
    }
    
    return reasons;
  }
}
