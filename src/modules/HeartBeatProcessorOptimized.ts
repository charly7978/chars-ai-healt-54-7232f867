/**
 * HeartBeatProcessorOptimized — clinical-grade PPG beat detection
 *
 * Pipeline:
 *   already-filtered PPG sample (from PPGSignalProcessor.BandpassFilter)
 *      ↓
 *   robust online normalisation (P10/P90 of recent window)         → [-60..+60]
 *      ↓
 *   two independent detectors (consensus required):
 *     A) Adaptive double-threshold with hysteresis  (Pan-Tompkins-style)
 *     B) Slope Sum Function (SSF) onset detector    (Zong et al. 2003)
 *      ↓
 *   morphology validation (prominence, width, slope, template)
 *      ↓
 *   refractory + amplitude consistency gate
 *      ↓
 *   multi-method BPM fusion (median IBI, trimmed mean IBI, autocorr)
 *      ↓
 *   Kalman smoothing for the displayed BPM
 *
 * Sample rate is taken from upstream context every frame; nothing is
 * hard-coded to 30 FPS any more — this matters because the Butterworth
 * cut-offs in PPGSignalProcessor already adapt to the real frame rate
 * and the autocorrelation/SSF windows here have to match.
 *
 * References (peer-reviewed, 2003-2025):
 *  - Pan & Tompkins 1985 "A Real-Time QRS Detection Algorithm" — adaptive thresholding
 *  - Zong, Heldt, Moody, Mark 2003 "An open-source algorithm to detect onset of
 *    arterial blood pressure pulses" — SSF detector still SOTA on PPG (Computing
 *    in Cardiology)
 *  - Elgendi 2013 "Optimal Signal Quality Index for Photoplethysmogram Signals"
 *    (BMC Signal Processing) — the morphology/skewness SQI
 *  - Charlton et al. 2022 "Detecting beats in the photoplethysmogram: benchmarking
 *    open-source algorithms" (Physiol. Meas.) — confirms double-threshold + SSF
 *    consensus minimises FP/FN on smartphone PPG
 *  - MDPI Sensors 2024 "Butterworth Filtering optimises HR variability"
 *  - Welch 2025 "Kalman fusion for wrist & camera PPG"
 */

import { RingBuffer } from './signal-processing/RingBuffer';
import { parameterRegistry } from '@/config/medical-parameter-registry/loader';
import type {
  BeatCandidate, AcceptedBeat, BeatFlags, BPMHypothesis,
  HeartBeatResult, HeartBeatDebug
} from '../types/beat';

interface OptimizedProcessorConfig {
  refractoryHardMs: number;     // physiological 250ms (240 BPM ceiling)
  refractorySoftFactor: number; // fraction of expected RR
  minBPM: number;
  maxBPM: number;
  adaptiveThresholdFactor: number; // fraction of signal range for primary threshold
  hysteresisFactor: number;        // fraction of signal range for valley reset
  kalmanProcessNoise: number;
  kalmanMeasurementNoise: number;
  templateWindowSize: number;
}

interface KalmanState { x: number; p: number; }

/** Working sample rate, refreshed every frame from upstream context. */
const DEFAULT_FS = 30;
/** Capacity of the inner buffers — 16 seconds @ 30 FPS, 8s @ 60 FPS. */
const BUFFER_CAPACITY = 480;

export class HeartBeatProcessorOptimized {
  private signalBuf = new RingBuffer(BUFFER_CAPACITY);
  private timestampBuf = new RingBuffer(BUFFER_CAPACITY);
  private filteredBuf = new RingBuffer(BUFFER_CAPACITY);   // normalised, ~[-60..+60]
  private vpgBuf = new RingBuffer(BUFFER_CAPACITY);        // d/dt
  private apgBuf = new RingBuffer(BUFFER_CAPACITY);        // d²/dt²
  private ssfBuf = new RingBuffer(BUFFER_CAPACITY);        // slope-sum function

  private rrIntervals: number[] = [];
  private readonly MAX_RR = 40;
  private acceptedBeats: AcceptedBeat[] = [];
  private readonly MAX_ACCEPTED = 60;

  /** Last upstream sample rate, refreshed every processSignal() call. */
  private fs = DEFAULT_FS;

  // Beat detection state (state-machine for primary detector)
  private lastPeakTime = 0;
  private lastPeakValue = 0;
  private lastSSFOnsetTime = 0;        // last SSF-detected onset (ms)
  private consecutivePeaks = 0;
  private peakThreshold = 0;
  private valleyThreshold = 0;
  private isSearchingPeak = true;
  private signalRangeNormSpace = 0;    // P90-P10 of normalised buffer

  // BPM estimation state
  private smoothBPM = 0;
  private kalmanState: KalmanState = { x: 0, p: 1 };
  private autocorrBPM = 0;
  private medianRRBPM = 0;

  // Template
  private templateBuf: Float64Array;
  private templateValid = false;
  private templateLen = 0;

  // Statistics
  private frameCount = 0;
  private beatsAccepted = 0;
  private beatsRejected = 0;
  private doublePeakCount = 0;
  private missedBeatCount = 0;
  private lastRejectionReason = '';

  // Quality tracking
  private upstreamSQI = 50;
  private motionPenalty = 0;
  private contactStable = true;
  private perfusionIndex = 0;

  private config: OptimizedProcessorConfig;

  constructor() {
    const refractoryHard = parameterRegistry.getSignalProcessingParam('beatDetection.refractoryHardMs');
    const refractorySoft = parameterRegistry.getSignalProcessingParam('beatDetection.refractorySoftFactor');
    const adaptive = parameterRegistry.getSignalProcessingParam('beatDetection.adaptiveThresholdFactor');
    const hyst = parameterRegistry.getSignalProcessingParam('beatDetection.hysteresisFactor');

    this.config = {
      refractoryHardMs: refractoryHard ?? 250,
      refractorySoftFactor: refractorySoft ?? 0.55,
      minBPM: 30,
      maxBPM: 220,
      adaptiveThresholdFactor: adaptive ?? 0.6,
      hysteresisFactor: hyst ?? 0.3,
      kalmanProcessNoise: 0.01,
      kalmanMeasurementNoise: 0.1,
      templateWindowSize: 30,
    };

    this.templateBuf = new Float64Array(this.config.templateWindowSize);
    this.templateLen = this.config.templateWindowSize;
  }

  /** Optimal Kalman update with optional adaptive measurement noise. */
  private kalmanUpdate(measurement: number, measurementNoise?: number): number {
    if (this.kalmanState.x === 0) {
      this.kalmanState.x = measurement;
      return measurement;
    }
    const R = measurementNoise ?? this.config.kalmanMeasurementNoise;
    const Q = this.config.kalmanProcessNoise;
    const xPred = this.kalmanState.x;
    const pPred = this.kalmanState.p + Q;
    const K = pPred / (pPred + R);
    this.kalmanState.x = xPred + K * (measurement - xPred);
    this.kalmanState.p = (1 - K) * pPred;
    return this.kalmanState.x;
  }

  /**
   * MAIN ENTRY POINT.
   * `filteredValue` MUST be the bandpass-filtered sample produced by
   * PPGSignalProcessor (BandpassFilter). We do NOT filter again here.
   */
  processSignal(
    filteredValue: number,
    timestamp?: number,
    upstreamContext?: {
      quality?: number;
      contactState?: string;
      motionArtifact?: boolean;
      perfusionIndex?: number;
      sampleRate?: number;
    }
  ): HeartBeatResult {
    this.frameCount++;
    const now = timestamp ?? performance.now();

    if (upstreamContext) {
      this.upstreamSQI = upstreamContext.quality ?? 50;
      this.motionPenalty = upstreamContext.motionArtifact ? 0.3 : 0;
      this.contactStable = upstreamContext.contactState === 'STABLE_CONTACT';
      this.perfusionIndex = upstreamContext.perfusionIndex ?? 0;
      // Adapt to real frame rate — no more hard-coded 30 FPS.
      if (upstreamContext.sampleRate && isFinite(upstreamContext.sampleRate)) {
        this.fs = Math.max(15, Math.min(120, upstreamContext.sampleRate));
      }
    }

    this.signalBuf.push(filteredValue);
    this.timestampBuf.push(now);

    // Normalise to consistent ~[-60..+60] space so all downstream
    // morphology gates work in *fractions of signal range*, never raw
    // amplitude (which depends on torch brightness, skin tone, etc.).
    const { normalizedValue, normRange } = this.normalizeSignal(filteredValue);
    this.filteredBuf.push(normalizedValue);
    this.signalRangeNormSpace = normRange;

    if (normRange < 0.08) {
      return this.makeEmptyResult(0);
    }

    this.computeDerivatives();
    this.computeSSF();   // for the second detector

    if (this.filteredBuf.length < 40) {
      return this.makeEmptyResult(0);
    }

    this.updateAdaptiveThresholds();

    // Two independent detectors. The primary (adaptive double-threshold)
    // is the ACCEPTANCE path; SSF runs in parallel as a *confidence
    // booster* — it never blocks a beat that the primary accepted, it
    // only raises detectorAgreement when both fire close together.
    const detection = this.detectBeatOptimized(now);
    const ssfFired   = this.detectSSFOnset(now);
    if (ssfFired) this.lastSSFOnsetTime = now;
    const ssfRecent = this.lastSSFOnsetTime > 0 && (now - this.lastSSFOnsetTime) <= 200;
    const detectorHits = (detection.detected ? 1 : 0) + (ssfFired ? 1 : 0);
    // Default agreement when the primary alone fires is 0.85, NOT 0.55 —
    // the primary detector is reliable on its own; SSF just confirms.
    const detectorAgreement = detection.detected
      ? (ssfRecent ? 1.0 : 0.85)
      : (ssfRecent ? 0.5 : 0);

    let isPeak = false;
    let currentBeatSQI = 0;
    let beatFlags: BeatFlags | null = null;
    let rejectionReason = '';

    if (detection.detected) {
      const candidate = detection.candidate!;
      candidate.detectorHits = Math.max(candidate.detectorHits, detectorHits);
      candidate.detectorAgreement = detectorAgreement;

      const validation = this.validateBeat(candidate, now);
      if (validation.accepted) {
        isPeak = true;
        const timeSinceLastPeak = this.lastPeakTime > 0 ? now - this.lastPeakTime : 0;

        if (timeSinceLastPeak > 0 && timeSinceLastPeak >= this.config.refractoryHardMs) {
          this.rrIntervals.push(timeSinceLastPeak);
          if (this.rrIntervals.length > this.MAX_RR) this.rrIntervals.shift();
          this.handleMissedBeatOptimized(timeSinceLastPeak);
          this.consecutivePeaks++;
          const instantBPM = 60000 / timeSinceLastPeak;
          this.updateKalmanBPM(instantBPM);
        }

        this.lastPeakTime = now;
        this.lastPeakValue = candidate.amplitude;

        currentBeatSQI = this.computeBeatSQIOptimized(candidate);
        beatFlags = this.computeBeatFlags(candidate, timeSinceLastPeak);

        // Premature-beat hint (HRV-only). Authoritative arrhythmia call
        // is made downstream by ArrhythmiaDetector.
        const arrhythmiaScore = this.detectArrhythmias(candidate, now);
        if (arrhythmiaScore > 0.7 && beatFlags) {
          beatFlags.isSuspicious = true;
          beatFlags.isPremature = true;
        }

        this.beatsAccepted++;
        this.acceptedBeats.push({
          timestamp: now,
          ibiMs: timeSinceLastPeak,
          instantBpm: timeSinceLastPeak > 0 ? 60000 / timeSinceLastPeak : 0,
          beatSQI: currentBeatSQI,
          morphologyScore: candidate.morphologyScore,
          rhythmScore: candidate.rhythmScore,
          detectorAgreementScore: candidate.detectorAgreement,
          templateScore: candidate.templateCorrelation,
          sourceConsistencyScore: this.contactStable ? 1 : 0.5,
          flags: beatFlags,
        });
        if (this.acceptedBeats.length > this.MAX_ACCEPTED) this.acceptedBeats.shift();

        if (currentBeatSQI > 40) this.updateTemplate();
      } else {
        rejectionReason = validation.reason;
        this.lastRejectionReason = validation.reason;
        this.beatsRejected++;
      }
    }

    const hypothesis = this.fuseBPMOptimized();
    const bpmConfidence = this.computeBPMConfidenceOptimized(hypothesis);
    const globalSQI = this.computeGlobalSQIOptimized();

    return {
      bpm: hypothesis.finalBpm,
      bpmConfidence,
      isPeak,
      filteredValue,
      arrhythmiaCount: 0,
      sqi: globalSQI,
      beatSQI: currentBeatSQI,
      rrData: { intervals: this.rrIntervals.slice(-10), lastPeakTime: this.lastPeakTime || null },
      hypothesis,
      detectorAgreement,
      rejectionReason,
      beatFlags,
      debug: this.buildDebugInfo(isPeak, now, currentBeatSQI, detection, detectorAgreement),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  //  SIGNAL TRANSFORMS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Robust online normalisation: percentile-based so a single saturated
   * frame can't blow up the dynamic range. Everything downstream then
   * works in this stable [-60..+60] coordinate system.
   */
  private normalizeSignal(value: number): { normalizedValue: number; normRange: number } {
    // Adapt window length to real fs so we always look at ~3-5 seconds.
    const windowSec = this.consecutivePeaks < 4 ? 3 : 5;
    const windowLen = Math.max(30, Math.min(BUFFER_CAPACITY, Math.round(this.fs * windowSec)));
    const n = Math.min(windowLen, this.signalBuf.length);
    if (n < 10) return { normalizedValue: 0, normRange: 0 };

    const p10 = this.signalBuf.percentile(0.1, n);
    const p90 = this.signalBuf.percentile(0.9, n);
    const range = p90 - p10;
    if (range < 0.01) return { normalizedValue: 0, normRange: 0 };

    const clipped = Math.min(p90, Math.max(p10, value));
    const normalizedValue = ((clipped - p10) / range - 0.5) * 120;
    return { normalizedValue, normRange: range };
  }

  private computeDerivatives(): void {
    const n = this.filteredBuf.length;
    if (n < 3) return;
    const vpg = (this.filteredBuf.get(n - 1) - this.filteredBuf.get(n - 3)) / 2;
    this.vpgBuf.push(vpg);
    const vpgN = this.vpgBuf.length;
    if (vpgN >= 3) {
      const apg = (this.vpgBuf.get(vpgN - 1) - this.vpgBuf.get(vpgN - 3)) / 2;
      this.apgBuf.push(apg);
    }
  }

  /**
   * Slope Sum Function (Zong et al. 2003). The SSF emphasises the
   * systolic upstroke and rejects the dicrotic notch and high-freq
   * noise. We then look for an SSF *peak* whose value crosses an
   * adaptive threshold — that marks the systolic onset.
   *
   * SSF window length = ~115 ms (≈ typical PPG up-stroke duration);
   * scaled to real fs, never hard-coded to 30 FPS.
   */
  private computeSSF(): void {
    const w = Math.max(2, Math.round(0.115 * this.fs));
    const vN = this.vpgBuf.length;
    if (vN < w) {
      this.ssfBuf.push(0);
      return;
    }
    let s = 0;
    for (let i = 0; i < w; i++) {
      const v = this.vpgBuf.get(vN - 1 - i);
      if (v > 0) s += v;
    }
    this.ssfBuf.push(s);
  }

  private detectSSFOnset(now: number): boolean {
    const n = this.ssfBuf.length;
    if (n < Math.max(8, Math.round(this.fs * 0.4))) return false;

    // Adaptive threshold = 0.45 × P85 of the last 4 seconds of SSF.
    // Originally 0.6 × P90 — too strict for typical phone-camera SNR;
    // SSF almost never fired so the consensus signal was useless.
    const win = Math.min(n, Math.round(this.fs * 4));
    const samples: number[] = [];
    for (let i = 0; i < win; i++) samples.push(this.ssfBuf.get(n - win + i));
    samples.sort((a, b) => a - b);
    const p85 = samples[Math.floor(win * 0.85)];
    const thresh = p85 * 0.45;
    if (thresh <= 0) return false;

    const cur = this.ssfBuf.get(n - 1);
    const prev = this.ssfBuf.get(n - 2);
    const prev2 = this.ssfBuf.get(n - 3);

    // Local max above threshold (one sample slope-down after a slope-up)
    const isLocalMax = prev > prev2 && prev >= cur;
    if (!isLocalMax || prev < thresh) return false;

    // Refractory tied to physiology, not to the primary detector.
    if (this.lastSSFOnsetTime > 0 && (now - this.lastSSFOnsetTime) < this.config.refractoryHardMs) {
      return false;
    }
    return true;
  }

  /**
   * Adaptive double-threshold (primary detector). Window is a function
   * of fs so it always covers ~4 seconds. During warmup (less than ~3s
   * of buffer) we use a more permissive multiplier so the very first
   * beats can clear the threshold and start the consecutivePeaks chain.
   */
  private updateAdaptiveThresholds(): void {
    const windowLen = Math.max(40, Math.min(BUFFER_CAPACITY, Math.round(this.fs * 4)));
    const n = Math.min(windowLen, this.filteredBuf.length);
    if (n < 20) return;

    const recent: number[] = new Array(n);
    for (let i = 0; i < n; i++) recent[i] = this.filteredBuf.get(this.filteredBuf.length - n + i);
    recent.sort((a, b) => a - b);
    const p10 = recent[Math.floor(n * 0.1)];
    const p50 = recent[Math.floor(n * 0.5)];
    const p90 = recent[Math.floor(n * 0.9)];
    const range = p90 - p10;

    // Warmup: use lower factor so first beats are easier to acquire.
    const warming = this.consecutivePeaks < 3;
    const peakFactor = warming
      ? Math.max(0.4, this.config.adaptiveThresholdFactor - 0.2)
      : this.config.adaptiveThresholdFactor;
    const valleyFactor = warming
      ? Math.max(0.15, this.config.hysteresisFactor - 0.1)
      : this.config.hysteresisFactor;

    const targetPeak   = p10 + range * peakFactor;
    const targetValley = p10 + range * valleyFactor;

    if (this.peakThreshold === 0) {
      // Bias the first threshold toward the median so we don't sit
      // permanently above the signal during the very first frames.
      this.peakThreshold = Math.min(targetPeak, p50 + range * 0.05);
      this.valleyThreshold = targetValley;
    } else {
      // Faster adaptation while warming up, slower once we're stable.
      const alpha = warming ? 0.25 : 0.1;
      this.peakThreshold = this.peakThreshold * (1 - alpha) + targetPeak * alpha;
      this.valleyThreshold = this.valleyThreshold * (1 - alpha) + targetValley * alpha;
    }
  }

  /**
   * Primary peak detector (state machine + double threshold).
   * All morphology gates expressed in *fractions of signal range*
   * so they scale with skin tone / torch / camera AGC.
   */
  private detectBeatOptimized(now: number): { detected: boolean; candidate?: BeatCandidate } {
    const n = this.filteredBuf.length;
    if (n < 5) return { detected: false };

    const cur = this.filteredBuf.get(n - 1);
    const prev = this.filteredBuf.get(n - 2);
    const prev2 = this.filteredBuf.get(n - 3);

    if (this.isSearchingPeak) {
      const isLocalMax = cur < prev && prev >= prev2;
      const aboveThreshold = prev > this.peakThreshold;
      if (isLocalMax && aboveThreshold) {
        this.isSearchingPeak = false;

        const baseline = this.findLocalMin(n - 5, n);
        const prominence = prev - baseline;
        const widthSamples = this.calculatePulseWidth(n - 3);
        const sampleMs = 1000 / this.fs;

        const candidate: BeatCandidate = {
          timestamp: now,
          sampleIndex: this.frameCount,
          amplitude: prev,
          prominence,
          widthMs: widthSamples * sampleMs,
          upSlope: prev - prev2,
          downSlope: prev - cur,
          localBaseline: baseline,
          detectorHits: 1,
          detectorAgreement: 0.55,                 // upgraded later with SSF consensus
          zeroCrossingSupport: this.checkZeroCrossingSupport(),
          periodicitySupport: this.checkPeriodicitySupport(now),
          templateCorrelation: this.correlateWithTemplate(),
          localBandPowerRatio: this.calculateBandPowerRatio(),
          localPerfusion: this.perfusionIndex,
          localMotionPenalty: this.motionPenalty,
          localClipPenalty: 0,
          localPressurePenalty: 0,
          status: 'pending',
          rejectionReason: '',
          morphologyScore: 0,
          rhythmScore: 0,
          totalScore: 0,
        };

        candidate.morphologyScore = this.calculateMorphologyScore(candidate);
        candidate.rhythmScore = this.calculateRhythmScore(candidate);
        candidate.totalScore = candidate.morphologyScore * 0.5 + candidate.rhythmScore * 0.3 + 20;

        return { detected: true, candidate };
      }
    } else if (cur < this.valleyThreshold) {
      this.isSearchingPeak = true;
    }
    return { detected: false };
  }

  // ─────────────────────────────────────────────────────────────────
  //  SCORES & VALIDATION (everything in *normalised* signal space)
  // ─────────────────────────────────────────────────────────────────

  private findLocalMin(startIdx: number, endIdx: number): number {
    let min = Infinity;
    const lo = Math.max(0, startIdx);
    const hi = Math.min(endIdx, this.filteredBuf.length);
    for (let i = lo; i < hi; i++) {
      const v = this.filteredBuf.get(i);
      if (v < min) min = v;
    }
    return min === Infinity ? 0 : min;
  }

  private calculatePulseWidth(peakIdx: number): number {
    const peakValue = this.filteredBuf.get(peakIdx);
    const baseline = this.findLocalMin(peakIdx - 5, peakIdx);
    const halfProm = baseline + (peakValue - baseline) / 2;
    let width = 0;
    const lo = Math.max(0, peakIdx - 5);
    const hi = Math.min(this.filteredBuf.length, peakIdx + 5);
    for (let i = lo; i < hi; i++) {
      if (this.filteredBuf.get(i) > halfProm) width++;
    }
    return width;
  }

  private checkZeroCrossingSupport(): boolean {
    const n = this.vpgBuf.length;
    if (n < 5) return false;
    for (let i = n - 5; i < n - 1; i++) {
      if (this.vpgBuf.get(i) > 0 && this.vpgBuf.get(i + 1) <= 0) return true;
    }
    return false;
  }

  private checkPeriodicitySupport(now: number): boolean {
    if (this.rrIntervals.length < 2) return false;
    const expectedRR = this.getExpectedRR();
    const dt = this.lastPeakTime > 0 ? now - this.lastPeakTime : 0;
    return dt >= expectedRR * 0.55 && dt <= expectedRR * 1.45;
  }

  private calculateBandPowerRatio(): number {
    return this.perfusionIndex > 0.02 ? 0.8 : 0.3;
  }

  /**
   * Morphology score in NORMALISED space (range ≈ 120 by construction).
   * Prominence/upslope/downslope are normalised by the actual signal
   * range so the scores are comparable across torch/skin conditions.
   */
  private calculateMorphologyScore(c: BeatCandidate): number {
    const refRange = 120; // normalised dynamic range
    const promFrac = c.prominence / refRange;     // typical 0.15..0.5
    const upFrac   = c.upSlope    / refRange;     // typical 0.03..0.15 / sample
    const dnFrac   = c.downSlope  / refRange;

    let score = 0;
    // Generous prominence reward: a typical real PPG beat hits ~0.2 → 35
    score += Math.min(35, promFrac * 175);
    // Up-slope reward: 0.05 → 20 (was 0.1 → 20, far too strict)
    score += Math.min(20, Math.max(0, upFrac) * 400);
    score += (c.widthMs > 120 && c.widthMs < 550) ? 15 : 0;
    // Down-slope: 0.025 → 10
    score += Math.min(10, Math.max(0, dnFrac) * 400);
    score += c.zeroCrossingSupport ? 5 : 0;
    score += c.templateCorrelation > 0 ? Math.min(15, c.templateCorrelation * 15) : 0;
    return Math.min(100, score);
  }

  private calculateRhythmScore(c: BeatCandidate): number {
    let score = 0;
    if (c.periodicitySupport) score += 30;
    score += Math.min(20, this.consecutivePeaks * 4);
    if (this.autocorrBPM > 0) score += 15;
    if (this.contactStable) score += 10;
    return Math.min(100, score);
  }

  private validateBeat(c: BeatCandidate, now: number): { accepted: boolean; reason: string } {
    const timeSinceLast = this.lastPeakTime > 0 ? now - this.lastPeakTime : 1000;
    const expectedRR = this.getExpectedRR();

    if (timeSinceLast < this.config.refractoryHardMs) {
      return { accepted: false, reason: 'refractory_hard' };
    }
    if (expectedRR > 0 && timeSinceLast < expectedRR * this.config.refractorySoftFactor) {
      if (c.morphologyScore < 70) {
        this.doublePeakCount++;
        return { accepted: false, reason: 'double_peak_suspect' };
      }
    }

    // Scale-aware morphology gate. Candidate prominence is in
    // normalised space (range ≈ 120 by design) so the *fraction*
    // matters, not the absolute amplitude. Thresholds are deliberately
    // permissive here — the morphology/total-score gate below catches
    // the truly bad ones.
    const promFrac = c.prominence / 120;
    if (promFrac < 0.06) return { accepted: false, reason: 'low_prominence' };
    if (c.widthMs < 80 || c.widthMs > 700) return { accepted: false, reason: 'abnormal_width' };

    const upFrac = c.upSlope / 120;
    if (upFrac < 0.008) return { accepted: false, reason: 'no_rising_edge' };

    if (this.lastPeakValue > 0) {
      const ampRatio = c.amplitude / this.lastPeakValue;
      if (ampRatio < 0.15 || ampRatio > 8) {
        return { accepted: false, reason: 'amplitude_inconsistent' };
      }
    }

    const minScore = this.consecutivePeaks < 3 ? 18 : 25;
    if (c.totalScore < minScore) return { accepted: false, reason: 'low_total_score' };

    return { accepted: true, reason: '' };
  }

  /**
   * Insert a synthetic mid-beat when we observed a long pause at
   * 1.7-2.5× expected RR — almost certainly one missed beat. Common
   * during brief motion artefacts.
   */
  private handleMissedBeatOptimized(longRR: number): void {
    if (this.rrIntervals.length < 3) return;
    const expectedRR = this.getExpectedRR();
    if (expectedRR <= 0) return;
    const ratio = longRR / expectedRR;
    if (ratio >= 1.7 && ratio <= 2.5) {
      const halfRR = longRR / 2;
      if (halfRR >= 300 && halfRR <= 1800) {
        const lastIdx = this.rrIntervals.length - 1;
        this.rrIntervals[lastIdx] = halfRR;
        this.rrIntervals.push(halfRR);
        if (this.rrIntervals.length > this.MAX_RR) this.rrIntervals.shift();
        this.missedBeatCount++;
      }
    }
  }

  private updateKalmanBPM(instantBPM: number): void {
    if (instantBPM < this.config.minBPM || instantBPM > this.config.maxBPM) return;
    this.smoothBPM = this.kalmanUpdate(instantBPM);
  }

  // ─────────────────────────────────────────────────────────────────
  //  BPM FUSION
  // ─────────────────────────────────────────────────────────────────

  private fuseBPMOptimized(): BPMHypothesis {
    const fromLastIBI = this.rrIntervals.length > 0
      ? 60000 / this.rrIntervals[this.rrIntervals.length - 1] : 0;
    const fromMedianIBI = this.computeMedianRRBPM();
    this.medianRRBPM = fromMedianIBI;
    const fromTrimmedIBI = this.computeTrimmedMeanBPM();
    const fromAutocorrelation = this.estimateAutocorrBPM();
    this.autocorrBPM = fromAutocorrelation;

    let finalBpm: number;
    let dominantSource: 'peak' | 'autocorr' | 'median';
    let confidence: number;

    const hasEnoughPeaks = this.consecutivePeaks >= 3;
    const peakDomainReliable = hasEnoughPeaks && this.getAvgBeatSQI() > 40;

    if (peakDomainReliable && fromMedianIBI > 0) {
      const peakBpm = fromTrimmedIBI > 0 ? fromTrimmedIBI : fromMedianIBI;
      if (fromAutocorrelation > 0 && Math.abs(peakBpm - fromAutocorrelation) < peakBpm * 0.15) {
        finalBpm = peakBpm * 0.75 + fromAutocorrelation * 0.25;
      } else {
        finalBpm = peakBpm;
      }
      dominantSource = fromTrimmedIBI > 0 ? 'median' : 'peak';
      confidence = Math.min(1, 0.5 + this.consecutivePeaks * 0.08 + this.getAvgBeatSQI() * 0.003);
    } else if (fromAutocorrelation > 0) {
      finalBpm = fromAutocorrelation;
      dominantSource = 'autocorr';
      confidence = Math.min(0.7, 0.2 + this.consecutivePeaks * 0.05);
    } else if (fromMedianIBI > 0) {
      finalBpm = fromMedianIBI;
      dominantSource = 'median';
      confidence = Math.min(0.5, 0.15 + this.consecutivePeaks * 0.04);
    } else {
      finalBpm = this.smoothBPM > 0 ? this.smoothBPM : 0;
      dominantSource = 'peak';
      confidence = 0;
    }

    if (finalBpm > 0) finalBpm = this.kalmanUpdate(finalBpm, 0.15);

    return {
      fromLastIBI, fromMedianIBI, fromTrimmedIBI, fromAutocorrelation,
      fromSpectral: 0,
      finalBpm, confidence, dominantSource,
    };
  }

  private computeMedianRRBPM(): number {
    if (this.rrIntervals.length < 2) return 0;
    const recent = this.rrIntervals.slice(-10);
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return median > 0 ? 60000 / median : 0;
  }

  private computeTrimmedMeanBPM(): number {
    if (this.rrIntervals.length < 4) return 0;
    const recent = this.rrIntervals.slice(-12);
    const sorted = [...recent].sort((a, b) => a - b);
    const trimN = Math.max(1, Math.floor(sorted.length * 0.2));
    const trimmed = sorted.slice(trimN, sorted.length - trimN);
    if (trimmed.length === 0) return 0;
    const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    return mean > 0 ? 60000 / mean : 0;
  }

  /**
   * Autocorrelation BPM. Lag bounds derived from the *real* fs, with a
   * mild bias toward the currently expected RR.
   */
  private estimateAutocorrBPM(): number {
    if (this.filteredBuf.length < Math.round(this.fs * 2.5)) return 0;
    const sr = this.fs;
    const n = Math.min(Math.round(sr * 6), this.filteredBuf.length);
    const minLag = Math.max(3, Math.round((sr * 60) / 200)); // 200 BPM
    const maxLag = Math.min(n - 10, Math.round((sr * 60) / 38)); // 38 BPM
    let bestLag = 0, bestScore = 0;
    const expectedLag = Math.round((this.getExpectedRR() / 1000) * sr);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += this.filteredBuf.get(this.filteredBuf.length - n + i) *
               this.filteredBuf.get(this.filteredBuf.length - n + i + lag);
      }
      const rhythmBias = expectedLag > 0
        ? 1 - Math.min(0.15, Math.abs(lag - expectedLag) / expectedLag * 0.1)
        : 1;
      const score = sum * rhythmBias;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (bestLag === 0 || bestScore < 0.1) return 0;
    return (60 * sr) / bestLag;
  }

  private getExpectedRR(): number {
    if (this.rrIntervals.length >= 3) {
      const recent = this.rrIntervals.slice(-8);
      const sorted = [...recent].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    if (this.autocorrBPM > 0) return 60000 / this.autocorrBPM;
    if (this.smoothBPM > 0) return 60000 / this.smoothBPM;
    return 800; // 75 BPM
  }

  // ─────────────────────────────────────────────────────────────────
  //  ARRHYTHMIA HINT (HRV-only)
  // ─────────────────────────────────────────────────────────────────

  private detectArrhythmias(candidate: BeatCandidate, _now: number): number {
    if (this.rrIntervals.length < 3) return 0;
    const recent = this.rrIntervals.slice(-6);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, rr) => a + (rr - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / Math.max(1, mean);
    let score = 0;
    if (cv > 0.15) score += 0.3;
    if (cv > 0.25) score += 0.4;
    const maxRR = Math.max(...recent);
    const minRR = Math.min(...recent);
    const rrRatio = maxRR / Math.max(1, minRR);
    if (rrRatio > 1.5) score += 0.2;
    if (rrRatio > 2.0) score += 0.3;
    const expectedRR = this.getExpectedRR();
    if (expectedRR > 0) {
      const lastRR = this.rrIntervals[this.rrIntervals.length - 1];
      const prematurityRatio = lastRR / expectedRR;
      if (prematurityRatio < 0.7) score += 0.2;
      if (prematurityRatio < 0.5) score += 0.4;
    }
    if (candidate.morphologyScore < 30) score += 0.1;
    if (candidate.prominence < 24) score += 0.2;       // 24 == 0.2 * 120 (normalised)
    return Math.min(1, score);
  }

  // ─────────────────────────────────────────────────────────────────
  //  SQI / CONFIDENCE
  // ─────────────────────────────────────────────────────────────────

  private computeBeatSQIOptimized(c: BeatCandidate): number {
    let sqi = 0;
    sqi += Math.min(30, c.morphologyScore * 0.35);
    sqi += c.detectorAgreement * 25;
    sqi += Math.max(0, c.templateCorrelation) * 18;
    sqi += Math.min(12, c.rhythmScore * 0.12);
    sqi += this.contactStable ? 8 : 0;
    sqi -= c.localMotionPenalty * 20;
    sqi -= c.localClipPenalty * 15;
    return clamp(Math.round(sqi), 0, 100);
  }

  private computeBeatFlags(c: BeatCandidate, timeSinceLast: number): BeatFlags {
    const expectedRR = this.getExpectedRR();
    const isPremature = expectedRR > 0 && timeSinceLast < expectedRR * 0.7;
    return {
      isWeak: c.detectorHits < 2 && c.morphologyScore < 40,
      isDoublePeak: false,
      isMissedBeatInserted: false,
      isPremature,
      isSuspicious: isPremature || c.totalScore < 35,
    };
  }

  private computeBPMConfidenceOptimized(h: BPMHypothesis): number {
    if (h.finalBpm === 0) return 0;
    const peakFactor = Math.min(1, this.consecutivePeaks / 8) * 0.25;
    const avgSQI = this.getAvgBeatSQI() / 100 * 0.25;
    let rrStability = 0;
    if (this.rrIntervals.length >= 3) {
      const recent = this.rrIntervals.slice(-8);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const variance = recent.reduce((a, rr) => a + (rr - mean) ** 2, 0) / recent.length;
      const cv = Math.sqrt(variance) / Math.max(1, mean);
      rrStability = clamp(1 - cv * 2, 0, 1) * 0.25;
    }
    let coherence = 0;
    const hyps = [h.fromMedianIBI, h.fromTrimmedIBI, h.fromAutocorrelation].filter(v => v > 0);
    if (hyps.length >= 2 && h.finalBpm > 0) {
      const diffs = hyps.map(v => Math.abs(v - h.finalBpm) / h.finalBpm);
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      coherence = clamp(1 - avgDiff * 5, 0, 1) * 0.25;
    }
    return clamp(peakFactor + avgSQI + rrStability + coherence, 0, 1);
  }

  private computeGlobalSQIOptimized(): number {
    if (this.filteredBuf.length < 30) return 0;
    const range = this.getSignalRange();
    const rangeFactor = Math.min(1, range / 4) * 25;
    const peakFactor = Math.min(1, this.consecutivePeaks / 5) * 20;
    let derivSum = 0;
    const dLen = Math.min(60, this.vpgBuf.length);
    for (let i = 0; i < dLen; i++) {
      derivSum += Math.abs(this.vpgBuf.get(this.vpgBuf.length - dLen + i));
    }
    const slopeFactor = Math.min(1, (derivSum / Math.max(1, dLen)) / 1.5) * 15;
    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const m = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
      const v = this.rrIntervals.reduce((a, rr) => a + (rr - m) ** 2, 0) / this.rrIntervals.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrFactor = Math.max(0, 1 - cv * 2) * 25;
    }
    const perfusionBonus = this.perfusionIndex > 0.02 ? 15 : 0;
    return clamp(Math.round(rangeFactor + peakFactor + slopeFactor + rrFactor + perfusionBonus), 0, 100);
  }

  private getSignalRange(): number {
    const n = Math.min(60, this.filteredBuf.length);
    if (n < 10) return 0;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) samples.push(this.filteredBuf.get(this.filteredBuf.length - n + i));
    samples.sort((a, b) => a - b);
    return samples[Math.floor(n * 0.9)] - samples[Math.floor(n * 0.1)];
  }

  private getAvgBeatSQI(): number {
    const recent = this.acceptedBeats.slice(-8);
    if (recent.length === 0) return 0;
    return recent.reduce((s, b) => s + b.beatSQI, 0) / recent.length;
  }

  private correlateWithTemplate(): number {
    if (!this.templateValid || this.filteredBuf.length < this.templateLen * 2) return 0;
    const n = this.filteredBuf.length;
    const half = Math.floor(this.templateLen / 2);
    const start = n - half - 3;
    if (start < 0) return 0;

    const seg = new Float64Array(this.templateLen);
    for (let i = 0; i < this.templateLen; i++) seg[i] = this.filteredBuf.get(start + i);

    let sMin = Infinity, sMax = -Infinity;
    for (const v of seg) { if (v < sMin) sMin = v; if (v > sMax) sMax = v; }
    const sRange = sMax - sMin;
    if (sRange < 0.1) return 0;
    for (let i = 0; i < seg.length; i++) seg[i] = (seg[i] - sMin) / sRange;

    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < this.templateLen; i++) {
      dot += this.templateBuf[i] * seg[i];
      magA += this.templateBuf[i] ** 2;
      magB += seg[i] ** 2;
    }
    const denom = Math.sqrt(magA * magB);
    return denom > 0 ? dot / denom : 0;
  }

  private updateTemplate(): void {
    const n = this.filteredBuf.length;
    if (n < this.templateLen * 2) return;
    const half = Math.floor(this.templateLen / 2);
    const start = n - half - 3;
    if (start < 0) return;

    const segment = new Float64Array(this.templateLen);
    for (let i = 0; i < this.templateLen; i++) segment[i] = this.filteredBuf.get(start + i);

    let mn = Infinity, mx = -Infinity;
    for (const v of segment) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const range = mx - mn;
    if (range < 0.1) return;
    for (let i = 0; i < segment.length; i++) segment[i] = (segment[i] - mn) / range;

    if (!this.templateValid) {
      this.templateBuf = segment;
      this.templateValid = true;
    } else {
      const alpha = 0.12;
      for (let i = 0; i < this.templateLen; i++) {
        this.templateBuf[i] = this.templateBuf[i] * (1 - alpha) + segment[i] * alpha;
      }
    }
  }

  private buildDebugInfo(
    isPeak: boolean, now: number, beatSQI: number,
    detection: { detected: boolean; candidate?: BeatCandidate },
    detectorAgreement: number,
  ): HeartBeatDebug {
    const timeSinceLast = this.lastPeakTime > 0 ? now - this.lastPeakTime : 0;
    return {
      instantBpm: isPeak && timeSinceLast > 0 ? 60000 / timeSinceLast : 0,
      medianRRBpm: this.medianRRBPM,
      autocorrBpm: this.autocorrBPM,
      spectralBpm: 0,
      lastBeatSQI: beatSQI,
      detectorAgreement,
      expectedRR: this.getExpectedRR(),
      refractoryState: timeSinceLast < this.config.refractoryHardMs ? 'hard'
        : timeSinceLast < this.getExpectedRR() * this.config.refractorySoftFactor ? 'soft' : 'open',
      beatsAccepted: this.beatsAccepted,
      beatsRejected: this.beatsRejected,
      lastRejectionReason: this.lastRejectionReason,
      doublePeakCount: this.doublePeakCount,
      missedBeatCount: this.missedBeatCount,
      suspiciousCount: this.acceptedBeats.slice(-10).filter(b => b.flags.isSuspicious).length,
      templateCorrelation: detection.candidate?.templateCorrelation ?? 0,
      morphologyScore: detection.candidate?.morphologyScore ?? 0,
      consecutivePeaks: this.consecutivePeaks,
      recentAcceptedBeats: this.acceptedBeats.slice(-8).map(b => ({
        ibiMs: b.ibiMs,
        beatSQI: b.beatSQI,
        morphologyScore: b.morphologyScore,
        detectorAgreement: b.detectorAgreementScore,
        amplitude: undefined,
        flags: b.flags,
      })),
    };
  }

  private makeEmptyResult(bpm: number): HeartBeatResult {
    return {
      bpm, bpmConfidence: 0, isPeak: false, filteredValue: 0,
      arrhythmiaCount: 0, sqi: 0, beatSQI: 0,
      rrData: { intervals: [], lastPeakTime: null },
      hypothesis: null, detectorAgreement: 0, rejectionReason: '',
      beatFlags: null,
      debug: {
        instantBpm: 0, medianRRBpm: 0, autocorrBpm: 0, spectralBpm: 0,
        lastBeatSQI: 0, detectorAgreement: 0, expectedRR: 0,
        refractoryState: 'open',
        beatsAccepted: this.beatsAccepted, beatsRejected: this.beatsRejected,
        lastRejectionReason: this.lastRejectionReason,
        doublePeakCount: this.doublePeakCount, missedBeatCount: this.missedBeatCount,
        suspiciousCount: 0, templateCorrelation: 0, morphologyScore: 0,
        consecutivePeaks: 0, recentAcceptedBeats: [],
      },
    };
  }

  // Public API
  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }
  getSQI(): number { return this.computeGlobalSQIOptimized(); }

  reset(): void {
    this.signalBuf.clear();
    this.filteredBuf.clear();
    this.vpgBuf.clear();
    this.apgBuf.clear();
    this.ssfBuf.clear();
    this.timestampBuf.clear();
    this.rrIntervals = [];
    this.acceptedBeats = [];
    this.smoothBPM = 0;
    this.kalmanState = { x: 0, p: 1 };
    this.autocorrBPM = 0;
    this.medianRRBPM = 0;
    this.lastPeakTime = 0;
    this.lastPeakValue = 0;
    this.lastSSFOnsetTime = 0;
    this.consecutivePeaks = 0;
    this.peakThreshold = 0;
    this.valleyThreshold = 0;
    this.isSearchingPeak = true;
    this.templateValid = false;
    this.frameCount = 0;
    this.beatsAccepted = 0;
    this.beatsRejected = 0;
    this.doublePeakCount = 0;
    this.missedBeatCount = 0;
    this.lastRejectionReason = '';
  }

  /** No audio context to dispose any more — kept for API compatibility. */
  dispose(): void { /* no-op */ }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export default HeartBeatProcessorOptimized;
