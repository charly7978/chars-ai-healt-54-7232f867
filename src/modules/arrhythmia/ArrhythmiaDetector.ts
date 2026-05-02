/**
 * ArrhythmiaDetector - Forensic-Grade Cardiac Arrhythmia Detection
 * 
 * Based on literature 2023-2025:
 * - RMSSD, pNN50 for HRV-based arrhythmia screening (Circulation 2024)
 * - RR interval irregularity detection for AFib (JACC 2023)
 * - Premature beat detection using local RR deviation (IEEE TBME 2024)
 * 
 * RULE: Only reports arrhythmias with quantifiable evidence.
 * No simulated or estimated-only classifications.
 */

import { parameterRegistry } from '@/config/medical-parameter-registry/loader';

export interface ArrhythmiaEvidence {
  detected: boolean;
  type: 'NONE' | 'AFIB_SUSPICION' | 'PREMATURE_BEAT' | 'IRREGULAR_RHYTHM' | 'BRADYCARDIA' | 'TACHYCARDIA';
  confidence: number; // 0-1 based on evidence strength
  rrMetrics: RRMetrics;
  evidence: {
    rmssd: number;          // Root mean square of successive differences
    pnn50: number;          // Percentage of NN50 (normal-normal > 50ms)
    cv: number;             // Coefficient of variation
    irregularityScore: number; // Local deviation from expected RR
    prematureBeatCount: number;
    missedBeatCount: number;
  };
  timestamp: number;
  statusLabel: string;
}

interface RRMetrics {
  intervals: number[];      // Last 30 seconds of RR intervals
  meanRR: number;           // Mean in ms
  medianRR: number;         // Median in ms
  minRR: number;
  maxRR: number;
  valid: boolean;
}

interface ArrhythmiaThresholds {
  // From Medical Parameter Registry
  rmssdThreshold: number;        // ms, normal typically 20-50ms
  pnn50Threshold: number;        // %, normal typically 3-15%
  cvThreshold: number;           // coefficient of variation
  afibIrregularityThreshold: number;
  prematureDeviationThreshold: number; // % deviation for premature detection
  bradycardiaBPM: number;
  tachycardiaBPM: number;
  minIntervalsForAnalysis: number;
}

export class ArrhythmiaDetector {
  private rrBuffer: number[] = [];
  private readonly MAX_RR_BUFFER = 40; // ~30 seconds at 60 BPM
  private lastAnalysisTime = 0;
  private readonly ANALYSIS_INTERVAL_MS = 2000; // Analyze every 2 seconds (faster detection)
  
  private thresholds: ArrhythmiaThresholds;
  
  // Running statistics for trend analysis
  private recentRMSSD: number[] = [];
  private recentCV: number[] = [];
  private readonly TREND_WINDOW = 6; // Last 6 analyses (30 seconds)

  constructor() {
    // Load thresholds from registry
    const hrvConfig = parameterRegistry.getSignalProcessingParam('arrhythmiaDetection.hrv');
    const rhythmConfig = parameterRegistry.getSignalProcessingParam('arrhythmiaDetection.rhythm');
    
    this.thresholds = {
      rmssdThreshold: hrvConfig?.rmssdThreshold ?? 50,      // Above suggests irregularity
      pnn50Threshold: hrvConfig?.pnn50Threshold ?? 15,    // Above suggests high variation
      cvThreshold: hrvConfig?.cvThreshold ?? 0.15,         // CV > 15% suggests irregularity
      afibIrregularityThreshold: rhythmConfig?.afibThreshold ?? 0.6,
      prematureDeviationThreshold: rhythmConfig?.prematureThreshold ?? 0.25, // 25% deviation
      bradycardiaBPM: 50,   // Adult resting threshold
      tachycardiaBPM: 100,  // Adult resting threshold
      minIntervalsForAnalysis: 5, // Need at least 5 intervals (faster detection)
    };
    
    console.log('[ArrhythmiaDetector] Initialized with registry thresholds:', this.thresholds);
  }

  /**
   * Process new RR interval and analyze for arrhythmias
   * Called on every detected beat
   */
  processBeat(rrIntervalMs: number, timestamp: number): ArrhythmiaEvidence | null {
    // Validate interval (30-200 BPM range = 300-2000ms)
    if (rrIntervalMs < 300 || rrIntervalMs > 2000) {
      return null; // Invalid interval, skip
    }
    
    // Add to buffer
    this.rrBuffer.push(rrIntervalMs);
    if (this.rrBuffer.length > this.MAX_RR_BUFFER) {
      this.rrBuffer.shift();
    }
    
    // Throttle analysis
    if (timestamp - this.lastAnalysisTime < this.ANALYSIS_INTERVAL_MS) {
      return null; // Not time for analysis yet
    }
    
    // Need minimum intervals
    if (this.rrBuffer.length < this.thresholds.minIntervalsForAnalysis) {
      return null;
    }
    
    this.lastAnalysisTime = timestamp;
    return this.analyzeArrhythmia(timestamp);
  }

  /**
   * Analyze RR buffer for arrhythmia patterns
   * Based on: JACC 2023 "Screening for Atrial Fibrillation using PPG"
   * IEEE TBME 2024 "Real-time Premature Beat Detection"
   */
  private analyzeArrhythmia(timestamp: number): ArrhythmiaEvidence {
    const intervals = [...this.rrBuffer];
    
    // Calculate basic metrics
    const metrics = this.calculateRRMetrics(intervals);
    
    if (!metrics.valid) {
      return this.createNoArrhythmiaEvidence(metrics, timestamp);
    }
    
    // Calculate HRV metrics
    const rmssd = this.calculateRMSSD(intervals);
    const pnn50 = this.calculatePNN50(intervals);
    const cv = this.calculateCV(intervals, metrics.meanRR);
    
    // Update trend buffers
    this.recentRMSSD.push(rmssd);
    this.recentCV.push(cv);
    if (this.recentRMSSD.length > this.TREND_WINDOW) {
      this.recentRMSSD.shift();
      this.recentCV.shift();
    }
    
    // Detect specific patterns
    const irregularityScore = this.calculateIrregularityScore(intervals);
    const { prematureCount, missedCount } = this.detectPrematureAndMissedBeats(intervals);
    
    // Determine arrhythmia type based on evidence
    const evidence = {
      rmssd,
      pnn50,
      cv,
      irregularityScore,
      prematureBeatCount: prematureCount,
      missedBeatCount: missedCount,
    };
    
    // Classification logic based on literature
    const bpm = 60000 / metrics.meanRR;
    let result: ArrhythmiaEvidence;
    
    // DEBUG: Log metrics for troubleshooting
    console.log(`[ArrhythmiaDetector] BPM:${bpm.toFixed(1)} RMSSD:${rmssd.toFixed(1)} pNN50:${pnn50.toFixed(1)}% CV:${cv.toFixed(3)} IR:${irregularityScore.toFixed(3)} PREM:${prematureCount}`);
    
    if (this.isAFibPattern(irregularityScore, rmssd, cv)) {
      console.log('[ArrhythmiaDetector] AFIB DETECTED!');
      result = {
        detected: true,
        type: 'AFIB_SUSPICION',
        confidence: this.calculateAFibConfidence(irregularityScore, rmssd, cv),
        rrMetrics: metrics,
        evidence,
        timestamp,
        statusLabel: 'FIBRILACIÓN AURICULAR SOSPECHADA',
      };
    } else if (prematureCount > 0 && irregularityScore > 0.3) {
      result = {
        detected: true,
        type: 'PREMATURE_BEAT',
        confidence: Math.min(0.95, 0.5 + prematureCount * 0.1),
        rrMetrics: metrics,
        evidence,
        timestamp,
        statusLabel: `LATIDOS PREMATUROS (${prematureCount})`,
      };
    } else if (bpm < this.thresholds.bradycardiaBPM) {
      result = {
        detected: true,
        type: 'BRADYCARDIA',
        confidence: bpm < 45 ? 0.9 : 0.7,
        rrMetrics: metrics,
        evidence,
        timestamp,
        statusLabel: 'BRADICARDIA',
      };
    } else if (bpm > this.thresholds.tachycardiaBPM) {
      result = {
        detected: true,
        type: 'TACHYCARDIA',
        confidence: bpm > 120 ? 0.9 : 0.7,
        rrMetrics: metrics,
        evidence,
        timestamp,
        statusLabel: 'TAQUICARDIA',
      };
    } else if (cv > this.thresholds.cvThreshold || irregularityScore > 0.25) {
      result = {
        detected: true,
        type: 'IRREGULAR_RHYTHM',
        confidence: Math.min(0.8, irregularityScore + cv),
        rrMetrics: metrics,
        evidence,
        timestamp,
        statusLabel: 'RITMO IRREGULAR',
      };
    } else {
      result = this.createNoArrhythmiaEvidence(metrics, timestamp);
      console.log('[ArrhythmiaDetector] No arrhythmia - SINUS rhythm');
    }
    
    // Log for forensic trace
    if (result.detected) {
      console.log(`[ArrhythmiaDetector] ${result.type} detected at ${timestamp}`, {
        confidence: result.confidence.toFixed(2),
        rmssd: rmssd.toFixed(1),
        irregularity: irregularityScore.toFixed(2),
      });
    }
    
    return result;
  }

  /**
   * Calculate RMSSD (Root Mean Square of Successive Differences)
   * Standard HRV metric for short-term variation
   */
  private calculateRMSSD(intervals: number[]): number {
    if (intervals.length < 2) return 0;
    
    let sumSquaredDiff = 0;
    let count = 0;
    
    for (let i = 1; i < intervals.length; i++) {
      const diff = intervals[i] - intervals[i - 1];
      sumSquaredDiff += diff * diff;
      count++;
    }
    
    return count > 0 ? Math.sqrt(sumSquaredDiff / count) : 0;
  }

  /**
   * Calculate pNN50 (Percentage of NN50)
   * NN50 = consecutive intervals differing by > 50ms
   */
  private calculatePNN50(intervals: number[]): number {
    if (intervals.length < 2) return 0;
    
    let nn50Count = 0;
    let totalPairs = 0;
    
    for (let i = 1; i < intervals.length; i++) {
      const diff = Math.abs(intervals[i] - intervals[i - 1]);
      if (diff > 50) nn50Count++;
      totalPairs++;
    }
    
    return totalPairs > 0 ? (nn50Count / totalPairs) * 100 : 0;
  }

  /**
   * Calculate Coefficient of Variation (CV)
   * Normalized measure of dispersion
   */
  private calculateCV(intervals: number[], mean: number): number {
    if (mean <= 0 || intervals.length < 2) return 0;
    
    const variance = intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev / mean;
  }

  /**
   * Calculate irregularity score based on local deviations
   * Used for AFib pattern detection
   */
  private calculateIrregularityScore(intervals: number[]): number {
    if (intervals.length < 4) return 0;
    
    // Calculate local mean (excluding current interval)
    let irregularitySum = 0;
    let count = 0;
    
    for (let i = 2; i < intervals.length; i++) {
      const localMean = (intervals[i - 2] + intervals[i - 1]) / 2;
      const deviation = Math.abs(intervals[i] - localMean) / localMean;
      
      // Weight recent intervals more
      const weight = i / intervals.length;
      irregularitySum += deviation * weight;
      count += weight;
    }
    
    return count > 0 ? irregularitySum / count : 0;
  }

  /**
   * Detect premature beats and missed beats
   * Premature: RR < 0.75 * local mean
   * Missed: RR > 1.5 * local mean (compensatory pause)
   */
  private detectPrematureAndMissedBeats(intervals: number[]): { prematureCount: number; missedCount: number } {
    if (intervals.length < 3) return { prematureCount: 0, missedCount: 0 };
    
    let prematureCount = 0;
    let missedCount = 0;
    
    for (let i = 1; i < intervals.length; i++) {
      const localMean = (intervals[i - 1] + (intervals[i + 1] || intervals[i - 1])) / 2;
      
      // Premature beat: significantly shorter than expected
      if (intervals[i] < localMean * (1 - this.thresholds.prematureDeviationThreshold)) {
        prematureCount++;
      }
      
      // Missed beat (compensatory pause): significantly longer
      if (intervals[i] > localMean * (1 + this.thresholds.prematureDeviationThreshold * 2)) {
        missedCount++;
      }
    }
    
    return { prematureCount, missedCount };
  }

  /**
   * Check for AFib pattern using irregularity and HRV metrics
   * AFib typically shows: irregularly irregular + high HRV
   */
  private isAFibPattern(irregularityScore: number, rmssd: number, cv: number): boolean {
    // AFib is characterized by:
    // 1. High irregularity (no pattern)
    // 2. High RMSSD (high variation between consecutive beats)
    // 3. High CV (overall dispersion)
    
    const irregularityCondition = irregularityScore > this.thresholds.afibIrregularityThreshold;
    const hrvCondition = rmssd > this.thresholds.rmssdThreshold || cv > this.thresholds.cvThreshold * 1.5;
    
    // Trend analysis: check if consistently irregular
    const trendCondition = this.recentRMSSD.length >= 3 && 
      this.recentRMSSD.every(r => r > this.thresholds.rmssdThreshold * 0.7);
    
    return irregularityCondition && hrvCondition && trendCondition;
  }

  private calculateAFibConfidence(irregularityScore: number, rmssd: number, cv: number): number {
    // Confidence increases with stronger signals
    const irregularityFactor = Math.min(1, irregularityScore);
    const hrvFactor = Math.min(1, rmssd / (this.thresholds.rmssdThreshold * 2));
    const cvFactor = Math.min(1, cv / (this.thresholds.cvThreshold * 2));
    
    return Math.min(0.95, (irregularityFactor * 0.4 + hrvFactor * 0.3 + cvFactor * 0.3));
  }

  private calculateRRMetrics(intervals: number[]): RRMetrics {
    if (intervals.length === 0) {
      return { intervals: [], meanRR: 0, medianRR: 0, minRR: 0, maxRR: 0, valid: false };
    }
    
    const sorted = [...intervals].sort((a, b) => a - b);
    const sum = intervals.reduce((a, b) => a + b, 0);
    
    return {
      intervals: [...intervals],
      meanRR: sum / intervals.length,
      medianRR: sorted[Math.floor(sorted.length / 2)],
      minRR: sorted[0],
      maxRR: sorted[sorted.length - 1],
      valid: intervals.length >= this.thresholds.minIntervalsForAnalysis,
    };
  }

  private createNoArrhythmiaEvidence(metrics: RRMetrics, timestamp: number): ArrhythmiaEvidence {
    return {
      detected: false,
      type: 'NONE',
      confidence: 0,
      rrMetrics: metrics,
      evidence: {
        rmssd: 0,
        pnn50: 0,
        cv: 0,
        irregularityScore: 0,
        prematureBeatCount: 0,
        missedBeatCount: 0,
      },
      timestamp,
      statusLabel: 'SIN ARRITMIAS',
    };
  }

  /**
   * Get current RR buffer for external analysis
   */
  getRRBuffer(): number[] {
    return [...this.rrBuffer];
  }

  /**
   * Reset detector state
   */
  reset(): void {
    this.rrBuffer = [];
    this.lastAnalysisTime = 0;
    this.recentRMSSD = [];
    this.recentCV = [];
  }
}

export default ArrhythmiaDetector;
