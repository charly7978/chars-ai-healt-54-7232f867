/**
 * ROI QUALITY
 * 
 * Evaluates ROI quality for PPG signal extraction.
 * 
 * Metrics:
 * - validPixelRatio > 0.70
 * - saturationRatio < 0.20 ideal; > 0.45 = SATURATED
 * - darkRatio < 0.20 ideal; > 0.40 = DARK_FRAME
 * - temporalVariance in G real
 * - perfusionProxy = std(OD_G_bandpassed) / meanG
 * - spectralPeakPower between 0.7 and 4.0 Hz
 * - spectralPeakRatio = peakPower / totalPower
 * - motionProxy = frameDiffNormalized
 * - channelCoherence: correlation between OD_G and OD_R
 */

import type { RoiBox } from './RoiScanner';
import { calculateRoiPixelStats } from '../radiometry/PixelStats';

export interface RoiQualityMetrics {
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  temporalVariance: number;
  perfusionProxy: number;
  spectralPeakHz: number;
  spectralPeakRatio: number;
  motionProxy: number;
  channelCoherence: number;
  redDominance: number;
  overallScore: number;
}

export interface RoiQualityResult {
  metrics: RoiQualityMetrics;
  state: 'SEARCHING_SIGNAL' | 'OPTICAL_CONTACT_CANDIDATE' | 'PPG_CANDIDATE' | 'PPG_VALID' | 'NO_PPG_SIGNAL' | 'SATURATED' | 'DARK_FRAME' | 'MOTION_ARTIFACT' | 'LOW_PERFUSION';
  canPublish: boolean;
  blockReasons: string[];
}

const THRESHOLDS = {
  VALID_PIXEL_MIN: 0.70,
  SATURATION_IDEAL: 0.20,
  SATURATION_MAX: 0.45,
  DARK_IDEAL: 0.20,
  DARK_MAX: 0.40,
  PERFUSION_MIN: 0.01,
  SPECTRAL_PEAK_MIN_HZ: 0.7,
  SPECTRAL_PEAK_MAX_HZ: 4.0,
  SPECTRAL_PEAK_RATIO_MIN: 0.35,
  COHERENCE_MIN: 0.5,
  MOTION_MAX: 0.3,
  RED_DOMINANCE_MIN: 1.0,
};

/**
 * Calculate ROI quality from current frame and history
 */
export function evaluateRoiQuality(
  imageData: ImageData,
  roi: RoiBox,
  greenHistory: number[],
  redHistory: number[],
  blueHistory: number[]
): RoiQualityResult {
  const stats = calculateRoiPixelStats(imageData, roi);
  const blockReasons: string[] = [];
  
  // Calculate temporal variance
  const temporalVariance = calculateTemporalVariance(greenHistory);
  
  // Calculate perfusion proxy
  const perfusionProxy = calculatePerfusionProxy(greenHistory);
  
  // Calculate spectral metrics
  const spectral = calculateSpectralMetrics(greenHistory);
  
  // Calculate motion proxy
  const motionProxy = calculateMotionProxy(greenHistory);
  
  // Calculate channel coherence
  const channelCoherence = calculateChannelCoherence(redHistory, greenHistory);
  
  const metrics: RoiQualityMetrics = {
    validPixelRatio: stats.validPixelRatio,
    saturationRatio: stats.saturationRatio,
    darkRatio: stats.darkRatio,
    temporalVariance,
    perfusionProxy,
    spectralPeakHz: spectral.peakHz,
    spectralPeakRatio: spectral.peakRatio,
    motionProxy,
    channelCoherence,
    redDominance: stats.redDominance,
    overallScore: 0, // Calculated below
  };
  
  // Determine state
  let state: RoiQualityResult['state'] = 'SEARCHING_SIGNAL';
  let canPublish = false;
  
  // Check saturation
  if (stats.saturationRatio > THRESHOLDS.SATURATION_MAX) {
    state = 'SATURATED';
    blockReasons.push(`SATURATED (${(stats.saturationRatio * 100).toFixed(0)}%)`);
  }
  
  // Check dark
  if (stats.darkRatio > THRESHOLDS.DARK_MAX) {
    state = 'DARK_FRAME';
    blockReasons.push(`DARK_FRAME (${(stats.darkRatio * 100).toFixed(0)}%)`);
  }
  
  // Check valid pixels
  if (stats.validPixelRatio < THRESHOLDS.VALID_PIXEL_MIN) {
    state = 'NO_PPG_SIGNAL';
    blockReasons.push(`LOW_VALID_PIXELS (${(stats.validPixelRatio * 100).toFixed(0)}%)`);
  }
  
  // Check motion
  if (motionProxy > THRESHOLDS.MOTION_MAX) {
    state = 'MOTION_ARTIFACT';
    blockReasons.push(`HIGH_MOTION (${motionProxy.toFixed(3)})`);
  }
  
  // Check perfusion
  if (perfusionProxy < THRESHOLDS.PERFUSION_MIN) {
    state = 'LOW_PERFUSION';
    blockReasons.push(`LOW_PERFUSION (${perfusionProxy.toFixed(4)})`);
  }
  
  // Check spectral peak
  if (spectral.peakHz < THRESHOLDS.SPECTRAL_PEAK_MIN_HZ || spectral.peakHz > THRESHOLDS.SPECTRAL_PEAK_MAX_HZ) {
    blockReasons.push(`SPECTRAL_OUT_OF_RANGE (${spectral.peakHz.toFixed(2)} Hz)`);
  }
  
  // Check spectral peak ratio
  if (spectral.peakRatio < THRESHOLDS.SPECTRAL_PEAK_RATIO_MIN) {
    blockReasons.push(`LOW_SPECTRAL_CONCENTRATION (${spectral.peakRatio.toFixed(3)})`);
  }
  
  // Check coherence
  if (channelCoherence < THRESHOLDS.COHERENCE_MIN) {
    blockReasons.push(`LOW_CHANNEL_COHERENCE (${channelCoherence.toFixed(3)})`);
  }
  
  // Check red dominance
  if (stats.redDominance < THRESHOLDS.RED_DOMINANCE_MIN) {
    blockReasons.push(`LOW_RED_DOMINANCE (${stats.redDominance.toFixed(2)})`);
  }
  
  // Determine final state
  if (blockReasons.length === 0) {
    state = 'PPG_VALID';
    canPublish = true;
  } else if (state === 'SEARCHING_SIGNAL') {
    if (metrics.overallScore > 0.6) {
      state = 'PPG_VALID';
      canPublish = true;
    } else if (metrics.overallScore > 0.4) {
      state = 'PPG_CANDIDATE';
    } else if (metrics.overallScore > 0.2) {
      state = 'OPTICAL_CONTACT_CANDIDATE';
    } else {
      state = 'LOW_PERFUSION';
    }
  }
  
  // Calculate overall score
  metrics.overallScore = calculateOverallScore(metrics, blockReasons.length === 0);
  
  return {
    metrics,
    state,
    canPublish,
    blockReasons,
  };
}

/**
 * Calculate temporal variance of signal
 */
function calculateTemporalVariance(signal: number[]): number {
  if (signal.length < 2) return 0;
  
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  const variance = signal.reduce((sum, val) => sum + (val - mean) ** 2, 0) / signal.length;
  
  return Math.sqrt(variance);
}

/**
 * Calculate perfusion proxy (AC/DC ratio)
 */
function calculatePerfusionProxy(signal: number[]): number {
  if (signal.length < 10) return 0;
  
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  const std = Math.sqrt(signal.reduce((sum, val) => sum + (val - mean) ** 2, 0) / signal.length);
  
  return mean > 0 ? std / mean : 0;
}

/**
 * Calculate spectral metrics using FFT
 */
function calculateSpectralMetrics(signal: number[]): { peakHz: number; peakRatio: number } {
  if (signal.length < 16) {
    return { peakHz: 0, peakRatio: 0 };
  }
  
  // Simple power spectrum estimation
  const n = signal.length;
  const powerSpectrum = new Float64Array(n / 2);
  
  for (let k = 0; k < n / 2; k++) {
    let real = 0;
    let imag = 0;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * k * i) / n;
      real += signal[i] * Math.cos(angle);
      imag -= signal[i] * Math.sin(angle);
    }
    powerSpectrum[k] = (real * real + imag * imag) / (n * n);
  }
  
  // Find peak
  let maxPower = 0;
  let peakIndex = 0;
  let totalPower = 0;
  
  for (let i = 1; i < powerSpectrum.length; i++) {
    totalPower += powerSpectrum[i];
    if (powerSpectrum[i] > maxPower) {
      maxPower = powerSpectrum[i];
      peakIndex = i;
    }
  }
  
  // Convert to Hz (assuming 30 fps)
  const peakHz = (peakIndex * 30) / n;
  const peakRatio = totalPower > 0 ? maxPower / totalPower : 0;
  
  return { peakHz, peakRatio };
}

/**
 * Calculate motion proxy from frame differences
 */
function calculateMotionProxy(signal: number[]): number {
  if (signal.length < 2) return 0;
  
  let totalDiff = 0;
  for (let i = 1; i < signal.length; i++) {
    totalDiff += Math.abs(signal[i] - signal[i - 1]);
  }
  
  const meanDiff = totalDiff / (signal.length - 1);
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  
  return mean > 0 ? meanDiff / mean : 0;
}

/**
 * Calculate channel coherence (correlation)
 */
function calculateChannelCoherence(signal1: number[], signal2: number[]): number {
  const n = Math.min(signal1.length, signal2.length);
  if (n < 2) return 0;
  
  const mean1 = signal1.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const mean2 = signal2.slice(0, n).reduce((a, b) => a + b, 0) / n;
  
  let covariance = 0;
  let var1 = 0;
  let var2 = 0;
  
  for (let i = 0; i < n; i++) {
    const d1 = signal1[i] - mean1;
    const d2 = signal2[i] - mean2;
    covariance += d1 * d2;
    var1 += d1 * d1;
    var2 += d2 * d2;
  }
  
  const std1 = Math.sqrt(var1 / n);
  const std2 = Math.sqrt(var2 / n);
  
  if (std1 === 0 || std2 === 0) return 0;
  
  return covariance / (n * std1 * std2);
}

/**
 * Calculate overall quality score
 */
function calculateOverallScore(metrics: RoiQualityMetrics, allPassed: boolean): number {
  let score = 0;
  
  // Valid pixels
  score += Math.min(metrics.validPixelRatio / THRESHOLDS.VALID_PIXEL_MIN, 1) * 0.15;
  
  // Saturation (lower is better)
  score += (1 - Math.min(metrics.saturationRatio / THRESHOLDS.SATURATION_MAX, 1)) * 0.1;
  
  // Dark (lower is better)
  score += (1 - Math.min(metrics.darkRatio / THRESHOLDS.DARK_MAX, 1)) * 0.1;
  
  // Perfusion
  score += Math.min(metrics.perfusionProxy / THRESHOLDS.PERFUSION_MIN, 1) * 0.15;
  
  // Spectral peak ratio
  score += Math.min(metrics.spectralPeakRatio / THRESHOLDS.SPECTRAL_PEAK_RATIO_MIN, 1) * 0.2;
  
  // Coherence
  score += Math.min(metrics.channelCoherence / THRESHOLDS.COHERENCE_MIN, 1) * 0.15;
  
  // Red dominance
  score += Math.min(metrics.redDominance / THRESHOLDS.RED_DOMINANCE_MIN, 1) * 0.1;
  
  // Motion (lower is better)
  score += (1 - Math.min(metrics.motionProxy / THRESHOLDS.MOTION_MAX, 1)) * 0.05;
  
  return Math.min(score, 1);
}
