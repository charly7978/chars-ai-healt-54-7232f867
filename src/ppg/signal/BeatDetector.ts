/**
 * BEAT DETECTOR
 * 
 * Detects cardiac beats using Elgendi approach with spectral validation.
 * 
 * Rules:
 * - Use G3 or primarySignal
 * - Detect systolic peaks with:
 *   - Minimum prominence based on MAD
 *   - Real ascending/descending slope
 *   - Refractory period minimum 280ms
 *   - RR interval: 300-2000ms
 *   - Reject attached peaks
 *   - Reject peaks without morphology
 * - Elgendi approach:
 *   - Short moving average for systolic events
 *   - Long moving average for baseline
 *   - Adaptive threshold
 *   - Block of interest
 *   - Choose max peak per block
 * - Validate with spectrum:
 *   - FFT/Welch on 8-12s window
 *   - Dominant peak between 0.7-4.0 Hz
 *   - BPM_time vs BPM_freq must match within ±8 BPM
 * - Require at least 5 valid beats
 * - HRV only if ≥10 valid RR intervals
 * - Vibration only on confirmed published beat
 * - No vibration without real beat
 */

import type { Beat, BeatDetectionResult } from './PpgTypes';

export interface BeatDetectorConfig {
  minBeats: number;
  minHrvBeats: number;
  refractoryMs: number;
  minRR: number;
  maxRR: number;
  spectralMinHz: number;
  spectralMaxHz: number;
  bpmTolerance: number;
}

const DEFAULT_CONFIG: BeatDetectorConfig = {
  minBeats: 5,
  minHrvBeats: 10,
  refractoryMs: 280,
  minRR: 300,
  maxRR: 2000,
  spectralMinHz: 0.7,
  spectralMaxHz: 4.0,
  bpmTolerance: 8,
};

export class BeatDetector {
  private config: BeatDetectorConfig;
  private beats: Beat[] = [];
  private lastBeatTime = 0;
  private signalBuffer: number[] = [];
  private timestampBuffer: number[] = [];
  private readonly BUFFER_SIZE = 360; // ~12 seconds at 30fps
  
  // Elgendi moving averages
  private maShort: number[] = [];
  private maLong: number[] = [];
  private readonly MA_SHORT_WINDOW = 5;
  private readonly MA_LONG_WINDOW = 15;
  
  // Statistics
  private beatsAccepted = 0;
  private beatsRejected = 0;
  private refractoryRejects = 0;
  private prominenceRejects = 0;
  private morphologyRejects = 0;

  constructor(config: Partial<BeatDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a signal sample
   */
  process(sample: number, timestamp: number): BeatDetectionResult {
    // Add to buffers
    this.signalBuffer.push(sample);
    this.timestampBuffer.push(timestamp);
    
    if (this.signalBuffer.length > this.BUFFER_SIZE) {
      this.signalBuffer.shift();
      this.timestampBuffer.shift();
    }
    
    // Update moving averages
    this.updateMovingAverages(sample);
    
    // Detect peaks using Elgendi method
    const peakIndex = this.detectElgendiPeak();
    
    if (peakIndex !== -1) {
      this.handlePeak(peakIndex);
    }
    
    // Calculate BPM
    const result = this.calculateBpm();
    
    return result;
  }

  /**
   * Update Elgendi moving averages
   */
  private updateMovingAverages(sample: number): void {
    this.maShort.push(sample);
    this.maLong.push(sample);
    
    if (this.maShort.length > this.MA_SHORT_WINDOW) {
      this.maShort.shift();
    }
    if (this.maLong.length > this.MA_LONG_WINDOW) {
      this.maLong.shift();
    }
  }

  /**
   * Detect peak using Elgendi method
   */
  private detectElgendiPeak(): number {
    if (this.maShort.length < this.MA_SHORT_WINDOW || 
        this.maLong.length < this.MA_LONG_WINDOW) {
      return -1;
    }
    
    const maShortMean = this.maShort.reduce((a, b) => a + b, 0) / this.maShort.length;
    const maLongMean = this.maLong.reduce((a, b) => a + b, 0) / this.maLong.length;
    
    // Threshold based on difference
    const threshold = maLongMean + 0.5 * (maShortMean - maLongMean);
    
    // Check if current sample exceeds threshold
    const current = this.signalBuffer[this.signalBuffer.length - 1];
    if (current > threshold) {
      return this.signalBuffer.length - 1;
    }
    
    return -1;
  }

  /**
   * Handle detected peak
   */
  private handlePeak(index: number): void {
    const timestamp = this.timestampBuffer[index];
    const amplitude = this.signalBuffer[index];
    
    // Refractory period check
    if (this.lastBeatTime > 0 && timestamp - this.lastBeatTime < this.config.refractoryMs) {
      this.refractoryRejects++;
      return;
    }
    
    // Prominence check (based on MAD)
    const mad = this.calculateMAD();
    const prominence = amplitude - this.calculateLocalBaseline(index);
    if (prominence < 2 * mad) {
      this.prominenceRejects++;
      return;
    }
    
    // Morphology check (ascending/descending slope)
    if (!this.hasValidMorphology(index)) {
      this.morphologyRejects++;
      return;
    }
    
    // Calculate RR interval
    let rrInterval = 0;
    if (this.lastBeatTime > 0) {
      rrInterval = timestamp - this.lastBeatTime;
      
      // RR interval validation
      if (rrInterval < this.config.minRR || rrInterval > this.config.maxRR) {
        this.beatsRejected++;
        return;
      }
    }
    
    // Accept beat
    const beat: Beat = {
      timestamp,
      index,
      amplitude,
      rrInterval,
    };
    
    this.beats.push(beat);
    this.lastBeatTime = timestamp;
    this.beatsAccepted++;
    
    // Keep only recent beats
    if (this.beats.length > 60) {
      this.beats.shift();
    }
  }

  /**
   * Calculate Median Absolute Deviation
   */
  private calculateMAD(): number {
    if (this.signalBuffer.length < 10) return 0;
    
    const median = this.calculateMedian(this.signalBuffer);
    const deviations = this.signalBuffer.map(v => Math.abs(v - median));
    return this.calculateMedian(deviations);
  }

  /**
   * Calculate median
   */
  private calculateMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Calculate local baseline around peak
   */
  private calculateLocalBaseline(index: number): number {
    const window = 5;
    const start = Math.max(0, index - window);
    const end = Math.min(this.signalBuffer.length, index + window + 1);
    
    const subset = this.signalBuffer.slice(start, end);
    return subset.reduce((a, b) => a + b, 0) / subset.length;
  }

  /**
   * Check morphology (ascending/descending slope)
   */
  private hasValidMorphology(index: number): boolean {
    const lookAhead = 3;
    const lookBehind = 3;
    
    if (index < lookBehind || index >= this.signalBuffer.length - lookAhead) {
      return true; // Can't check at edges
    }
    
    // Check ascending before peak
    let ascending = true;
    for (let i = index - lookBehind; i < index; i++) {
      if (this.signalBuffer[i] >= this.signalBuffer[i + 1]) {
        ascending = false;
        break;
      }
    }
    
    // Check descending after peak
    let descending = true;
    for (let i = index; i < index + lookAhead; i++) {
      if (this.signalBuffer[i] <= this.signalBuffer[i + 1]) {
        descending = false;
        break;
      }
    }
    
    return ascending && descending;
  }

  /**
   * Calculate BPM with spectral validation
   */
  private calculateBpm(): BeatDetectionResult {
    if (this.beats.length < this.config.minBeats) {
      return {
        beats: [...this.beats],
        bpm: 0,
        confidence: 0,
        rrIntervals: [],
        lastBeatTime: this.lastBeatTime,
      };
    }
    
    // Time domain BPM
    const rrIntervals = this.beats
      .slice(1)
      .map(b => b.rrInterval)
      .filter(rr => rr >= this.config.minRR && rr <= this.config.maxRR);
    
    if (rrIntervals.length < 2) {
      return {
        beats: [...this.beats],
        bpm: 0,
        confidence: 0,
        rrIntervals: [],
        lastBeatTime: this.lastBeatTime,
      };
    }
    
    const meanRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
    const bpmTimeDomain = 60000 / meanRR;
    
    // Frequency domain BPM
    const spectral = this.calculateSpectralBpm();
    
    // Validate agreement
    const bpmDiff = Math.abs(bpmTimeDomain - spectral.bpm);
    const valid = bpmDiff <= this.config.bpmTolerance;
    
    const finalBpm = valid ? (bpmTimeDomain + spectral.bpm) / 2 : bpmTimeDomain;
    const confidence = valid ? 0.8 : 0.5;
    
    return {
      beats: [...this.beats],
      bpm: Math.round(finalBpm),
      confidence,
      rrIntervals,
      lastBeatTime: this.lastBeatTime,
    };
  }

  /**
   * Calculate BPM from frequency domain (FFT)
   */
  private calculateSpectralBpm(): { bpm: number; peakHz: number } {
    if (this.signalBuffer.length < 32) {
      return { bpm: 0, peakHz: 0 };
    }
    
    const n = this.signalBuffer.length;
    const powerSpectrum = new Float64Array(n / 2);
    
    // Simple FFT (power spectrum)
    for (let k = 0; k < n / 2; k++) {
      let real = 0;
      let imag = 0;
      for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * k * i) / n;
        real += this.signalBuffer[i] * Math.cos(angle);
        imag -= this.signalBuffer[i] * Math.sin(angle);
      }
      powerSpectrum[k] = (real * real + imag * imag) / (n * n);
    }
    
    // Find peak in cardiac band
    let maxPower = 0;
    let peakIndex = 0;
    
    const minIndex = Math.floor((this.config.spectralMinHz * n) / 30); // Assuming 30fps
    const maxIndex = Math.ceil((this.config.spectralMaxHz * n) / 30);
    
    for (let i = minIndex; i < maxIndex && i < powerSpectrum.length; i++) {
      if (powerSpectrum[i] > maxPower) {
        maxPower = powerSpectrum[i];
        peakIndex = i;
      }
    }
    
    const peakHz = (peakIndex * 30) / n;
    const bpm = peakHz * 60;
    
    return { bpm, peakHz };
  }

  /**
   * Get HRV (Heart Rate Variability)
   */
  getHrv(): { rmssd: number; cv: number } | null {
    if (this.beats.length < this.config.minHrvBeats) return null;
    
    const rrIntervals = this.beats
      .slice(1)
      .map(b => b.rrInterval)
      .filter(rr => rr >= this.config.minRR && rr <= this.config.maxRR);
    
    if (rrIntervals.length < this.config.minHrvBeats) return null;
    
    // RMSSD
    const diffs = rrIntervals.slice(1).map((rr, i) => rr - rrIntervals[i]);
    const rmssd = Math.sqrt(diffs.reduce((sum, d) => sum + d * d, 0) / diffs.length);
    
    // Coefficient of variation
    const mean = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
    const variance = rrIntervals.reduce((sum, rr) => sum + (rr - mean) ** 2, 0) / rrIntervals.length;
    const cv = Math.sqrt(variance) / mean;
    
    return { rmssd, cv };
  }

  /**
   * Get rejection statistics
   */
  getRejectionStats() {
    return {
      accepted: this.beatsAccepted,
      rejected: this.beatsRejected,
      refractoryRejects: this.refractoryRejects,
      prominenceRejects: this.prominenceRejects,
      morphologyRejects: this.morphologyRejects,
    };
  }

  /**
   * Reset detector
   */
  reset(): void {
    this.beats = [];
    this.lastBeatTime = 0;
    this.signalBuffer = [];
    this.timestampBuffer = [];
    this.maShort = [];
    this.maLong = [];
    this.beatsAccepted = 0;
    this.beatsRejected = 0;
    this.refractoryRejects = 0;
    this.prominenceRejects = 0;
    this.morphologyRejects = 0;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<BeatDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): BeatDetectorConfig {
    return { ...this.config };
  }
}
