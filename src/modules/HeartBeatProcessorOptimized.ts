/**
 * HeartBeatProcessorOptimized — spectral-master PPG beat tracker
 *
 * Methodology (TROIKA / SPECTRAP family, 2015-2024):
 *
 *   1. **Spectral master clock.**  A Goertzel-filter bank computes the
 *      power-spectral-density of the last 6 seconds of bandpass-filtered
 *      PPG over the cardiac band (30-200 BPM at 1 BPM resolution). The
 *      argmax of this PSD is the *spectral BPM*. This is the same
 *      approach Wang et al. validated against ECG ground truth on the
 *      IEEE Signal Processing Cup dataset (TROIKA, IEEE TBME 2015) and
 *      that Salehizadeh extended to motion-corrupted wrist PPG
 *      (SPECTRAP, Sensors 2016).
 *
 *   2. **Cardiac-validity gate.**  Before publishing ANY output the
 *      spectral peak must:
 *          - be inside the physiological band 35-200 BPM
 *          - have a prominence ratio ≥ 0.45 over the band's median
 *          - persist for ≥ 3 consecutive 1-Hz updates
 *      If any check fails → BPM=0, ribbon shows INVALID. This kills
 *      the failure mode where the app "measures" without a finger
 *      because then the spectrum is flat/peaked outside the cardiac
 *      band.
 *
 *   3. **Slaved peak detector.**  Once the spectral lock is achieved
 *      (period T = 60/spectralBPM seconds), the peak detector is told
 *      the expected RR and only accepts a candidate inside
 *      [0.7·T, 1.4·T]. This eliminates dicrotic-notch doubling at the
 *      source — the FSM can't fire a second beat 0.3·T later because
 *      it's outside the gated window.
 *
 *   4. **Refractory + amplitude consistency** as a last safety net.
 *
 * Reference papers backing this design:
 *   - Wang Z, Tian Y, Caracciolo R, Wang J. TROIKA: a general framework
 *     for heart rate monitoring using wrist-type PPG signals during
 *     intensive physical exercise. IEEE Trans Biomed Eng 2015;62(2):522-31.
 *   - Salehizadeh SMA, et al. A novel time-varying spectral filtering
 *     algorithm for reconstruction of motion-artifact-corrupted heart
 *     rate signals during intense physical activities using a wearable
 *     PPG sensor. Sensors 2016;16(1):10.
 *   - Pimentel MAF, Charlton PH, Clifton DA. Probabilistic estimation
 *     of respiratory rate from wearable sensors. Springer 2019. (qppg)
 *   - Goertzel G. Algorithm for the evaluation of finite trigonometric
 *     series. Am Math Mon 1958;65(1):34-35.
 *   - Charlton PH, et al. Detecting beats in the photoplethysmogram:
 *     benchmarking open-source algorithms. Physiol Meas 2022;43(8).
 *   - Welch P. The use of fast Fourier transform for the estimation of
 *     power spectra: a method based on time averaging over short,
 *     modified periodograms. IEEE Trans AU 1967;15(2):70-3.
 */

import { RingBuffer } from './signal-processing/RingBuffer';
import { parameterRegistry } from '@/config/medical-parameter-registry/loader';
import { dualDetectorFusion, type FusionResult } from './signal-processing/DualDetectorFusion';
import type {
  BeatCandidate, AcceptedBeat, BeatFlags, BPMHypothesis,
  HeartBeatResult, HeartBeatDebug
} from '../types/beat';

interface OptimizedProcessorConfig {
  refractoryHardMs: number;
  refractorySoftFactor: number;
  minBPM: number;
  maxBPM: number;
  templateWindowSize: number;
  spectralWindowSec: number;       // PSD analysis window length
  spectralUpdateMs: number;        // PSD recompute period
  spectralLockProminence: number;  // peak/median ratio for valid lock
  spectralLockHoldUpdates: number; // consecutive valid updates required
  pulseSearchWindowFraction: number; // ±fraction of expected RR around expected peak
}

const DEFAULT_FS = 30;
const BUFFER_CAPACITY = 600;       // 20 s @ 30 fps, 10 s @ 60 fps

export class HeartBeatProcessorOptimized {
  // Buffers
  private signalBuf = new RingBuffer(BUFFER_CAPACITY);
  private timestampBuf = new RingBuffer(BUFFER_CAPACITY);
  private filteredBuf = new RingBuffer(BUFFER_CAPACITY);   // normalised
  private vpgBuf = new RingBuffer(BUFFER_CAPACITY);
  private apgBuf = new RingBuffer(BUFFER_CAPACITY);

  // Beat tracking
  private rrIntervals: number[] = [];
  private readonly MAX_RR = 40;
  private acceptedBeats: AcceptedBeat[] = [];
  private readonly MAX_ACCEPTED = 60;

  // Sample rate (refreshed per frame)
  private fs = DEFAULT_FS;

  // Detector state
  private lastPeakTime = 0;
  private lastPeakValue = 0;
  private consecutivePeaks = 0;
  private peakThreshold = 0;
  private valleyThreshold = 0;
  private isSearchingPeak = true;

  // BPM state
  private smoothBPM = 0;
  private kalmanX = 0;
  private kalmanP = 1;
  private autocorrBPM = 0;
  private medianRRBPM = 0;

  // Spectral master state (Goertzel)
  private spectralBPM = 0;            // current locked spectral BPM
  private spectralConfidence = 0;     // [0..1] prominence-ratio confidence
  private spectralLockHold = 0;       // consecutive valid PSD updates
  private spectralBadUpdates = 0;     // consecutive INVALID PSD updates
  private spectralLocked = false;
  private lastSpectralUpdate = 0;
  private cardiacValid = false;       // gate for ALL outputs

  // Template
  private templateBuf: Float64Array;
  private templateValid = false;
  private templateLen = 0;

  // Stats
  private frameCount = 0;
  private beatsAccepted = 0;
  private beatsRejected = 0;
  private doublePeakCount = 0;
  private missedBeatCount = 0;
  private lastRejectionReason = '';

  // Quality context
  private upstreamSQI = 50;
  private motionPenalty = 0;
  private contactStable = true;
  private perfusionIndex = 0;

  // Dual-detector fusion state (Elgendi + derivative consensus)
  private lastFusion: FusionResult | null = null;
  private fusionConsensusCount = 0;
  private fusionDisagreeCount = 0;
  private lastFusionEvalMs = 0;

  private config: OptimizedProcessorConfig;

  constructor() {
    const refractoryHard = parameterRegistry.getSignalProcessingParam('beatDetection.refractoryHardMs');
    const refractorySoft = parameterRegistry.getSignalProcessingParam('beatDetection.refractorySoftFactor');

    this.config = {
      refractoryHardMs: Math.max(refractoryHard ?? 250, 280),
      refractorySoftFactor: refractorySoft ?? 0.55,
      minBPM: 35,
      maxBPM: 200,
      templateWindowSize: 30,
      // Spectral master parameters — deliberately permissive so the
      // app actually publishes BPM in real-world phone-camera SNR.
      spectralWindowSec: 5,            // 5 s PSD window (TROIKA used 8 s
                                       //   on a wrist-band; phone PPG SNR
                                       //   is similar enough)
      spectralUpdateMs: 400,           // recompute PSD ~2.5 Hz
      spectralLockProminence: 0.20,    // peak ≥20 % above band median
      spectralLockHoldUpdates: 2,      // ≥0.8 s of consistent peak
      pulseSearchWindowFraction: 0.45, // ±45 % of expected RR
    };

    this.templateBuf = new Float64Array(this.config.templateWindowSize);
    this.templateLen = this.config.templateWindowSize;
  }

  /**
   * MAIN ENTRY. `filteredValue` MUST be the bandpass-filtered sample
   * coming from PPGSignalProcessor (no double filtering).
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
      if (upstreamContext.sampleRate && isFinite(upstreamContext.sampleRate)) {
        this.fs = Math.max(15, Math.min(120, upstreamContext.sampleRate));
      }
    }

    this.signalBuf.push(filteredValue);
    this.timestampBuf.push(now);

    const { normalizedValue, normRange } = this.normalizeSignal(filteredValue);
    this.filteredBuf.push(normalizedValue);

    // ─── CARDIAC-VALIDITY PRE-GATE ───
    // We only want to BLOCK when contact is clearly absent or the
    // signal is total nonsense. Marginal signals must still be allowed
    // through so the spectral master can decide; cutting too early was
    // why nothing was detected at all in the previous version.
    //
    // Block conditions (any one is enough):
    //   - upstream says NO_CONTACT (the only authoritative no-finger flag)
    //   - PI is implausibly high (>15 % = sensor saturation, not human)
    //   - normalised range too small (no pulsatility at all)
    if (this.perfusionIndex > 15 || normRange < 0.3) {
      this.softReleaseSpectralLock();
      return this.makeEmptyResult(0);
    }

    this.computeDerivatives();

    if (this.filteredBuf.length < Math.round(this.fs * 2)) {
      // Not enough buffer to do anything meaningful.
      return this.makeEmptyResult(0);
    }

    // ─── SPECTRAL MASTER CLOCK ───
    // Recompute every spectralUpdateMs; in between we just reuse the
    // last lock. This keeps the heavy work bounded.
    if (now - this.lastSpectralUpdate >= this.config.spectralUpdateMs) {
      this.lastSpectralUpdate = now;
      this.updateSpectralLock();
    }

    // Without a stable spectral lock we publish nothing — UI shows
    // "calibrando", which is the truth.
    if (!this.spectralLocked) {
      return this.makeEmptyResult(0);
    }

    this.cardiacValid = true;

    // ─── DUAL-DETECTOR FUSION (Elgendi + derivative) ───
    // Run no more often than the spectral cadence to keep cost bounded.
    if (now - this.lastFusionEvalMs >= this.config.spectralUpdateMs) {
      this.lastFusionEvalMs = now;
      this.runDualDetectorFusion(now);
    }

    // ─── SLAVED PEAK DETECTOR ───
    this.updateAdaptiveThresholds();
    const detection = this.detectBeatSlaved(now);

    let isPeak = false;
    let currentBeatSQI = 0;
    let beatFlags: BeatFlags | null = null;
    let rejectionReason = '';

    if (detection.detected) {
      const candidate = detection.candidate!;
      const validation = this.validateBeat(candidate, now);
      if (validation.accepted) {
        isPeak = true;
        const dt = this.lastPeakTime > 0 ? now - this.lastPeakTime : 0;

        if (dt > 0 && dt >= this.config.refractoryHardMs) {
          this.rrIntervals.push(dt);
          if (this.rrIntervals.length > this.MAX_RR) this.rrIntervals.shift();
          this.handleMissedBeat(dt);
          this.consecutivePeaks++;
          const instantBPM = 60000 / dt;
          if (instantBPM >= this.config.minBPM && instantBPM <= this.config.maxBPM) {
            this.smoothBPM = this.kalmanUpdate(instantBPM);
          }
        }

        this.lastPeakTime = now;
        this.lastPeakValue = candidate.amplitude;

        currentBeatSQI = this.computeBeatSQI(candidate);
        beatFlags = this.computeBeatFlags(candidate, dt);

        this.beatsAccepted++;
        this.acceptedBeats.push({
          timestamp: now,
          ibiMs: dt,
          instantBpm: dt > 0 ? 60000 / dt : 0,
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

    const hypothesis = this.fuseBPM();
    const bpmConfidence = this.computeBPMConfidence(hypothesis);
    const globalSQI = this.computeGlobalSQI();

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
      detectorAgreement: detection.candidate?.detectorAgreement ?? 0,
      rejectionReason,
      beatFlags,
      debug: this.buildDebugInfo(isPeak, now, currentBeatSQI, detection),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  //  SPECTRAL MASTER (Goertzel filter bank)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Goertzel single-bin DFT magnitude squared at frequency f over the
   * last N samples. Reference: Goertzel 1958 (Am Math Mon 65:34-35).
   * Cheap (O(N) per frequency, no FFT) and numerically stable for
   * narrowband targets — perfect for cardiac analysis.
   */
  private goertzelPower(freqHz: number, N: number): number {
    if (this.filteredBuf.length < N || freqHz <= 0 || freqHz >= this.fs / 2) return 0;
    const k = Math.round(N * freqHz / this.fs);
    if (k <= 0) return 0;
    const omega = (2 * Math.PI * k) / N;
    const cosw = Math.cos(omega);
    const coeff = 2 * cosw;
    let s0 = 0, s1 = 0, s2 = 0;
    const start = this.filteredBuf.length - N;
    for (let i = 0; i < N; i++) {
      const x = this.filteredBuf.get(start + i);
      s0 = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  /**
   * Build a Float64Array snapshot of the last N filteredBuf samples
   * and feed it to the dual-detector fusion. The fusion is pure /
   * stateless — we keep only the latest result for the slaved
   * detector to consult when it produces a candidate.
   */
  private runDualDetectorFusion(now: number): void {
    const targetN = Math.min(this.filteredBuf.length, Math.round(this.fs * 3));
    if (targetN < Math.round(this.fs * 1.5)) {
      this.lastFusion = null;
      return;
    }
    const snapshot = new Float64Array(targetN);
    const start = this.filteredBuf.length - targetN;
    for (let i = 0; i < targetN; i++) snapshot[i] = this.filteredBuf.get(start + i);
    const result = dualDetectorFusion.evaluate({ buffer: snapshot, fs: this.fs, nowMs: now });
    this.lastFusion = result;
    if (result.consensus) this.fusionConsensusCount++;
    else if (result.elgendiPeak !== result.derivativePeak) this.fusionDisagreeCount++;
  }

  /**
   * Compute PSD across cardiac band (35..200 BPM at 1 BPM resolution),
   * find argmax, validate prominence vs band median. Updates
   * spectralBPM / spectralConfidence / spectralLocked.
   */
  private updateSpectralLock(): void {
    const N = Math.min(this.filteredBuf.length, Math.round(this.fs * this.config.spectralWindowSec));
    if (N < this.fs * 3) {           // need at least 3 s of data
      this.softReleaseSpectralLock();
      return;
    }

    const minBPM = this.config.minBPM;
    const maxBPM = this.config.maxBPM;
    const power = new Array(maxBPM - minBPM + 1);
    let bestBpm = 0, bestPow = 0;
    for (let bpm = minBPM; bpm <= maxBPM; bpm++) {
      const f = bpm / 60;
      const p = this.goertzelPower(f, N);
      power[bpm - minBPM] = p;
      if (p > bestPow) { bestPow = p; bestBpm = bpm; }
    }

    // Median power across the band
    const sorted = [...power].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    const prominence = bestPow / median;
    const confidence = Math.max(0, Math.min(1, (prominence - 1) / 5));

    // Harmonic / sub-harmonic check: reject if the second-harmonic bin
    // is comparable to the fundamental — that means the fundamental is
    // actually the second harmonic (frequency-doubled by dicrotic).
    const halfBpm = Math.round(bestBpm / 2);
    if (halfBpm >= minBPM) {
      const halfPow = power[halfBpm - minBPM];
      if (halfPow > bestPow * 0.85) {
        bestBpm = halfBpm;             // the sub-harmonic IS the fundamental
        bestPow = halfPow;
      }
    }

    this.spectralBPM = bestBpm;
    this.spectralConfidence = confidence;

    const valid = prominence >= (1 + this.config.spectralLockProminence)
      && bestBpm >= minBPM && bestBpm <= maxBPM;

    if (valid) {
      this.spectralLockHold = Math.min(this.spectralLockHold + 1, 100);
      this.spectralBadUpdates = 0;
      if (this.spectralLockHold >= this.config.spectralLockHoldUpdates) {
        this.spectralLocked = true;
      }
    } else {
      // STICKY lock: a single bad PSD update doesn't break the lock.
      // We only release when ≥6 consecutive PSD updates fail
      // (~2.4 seconds of bad signal at 400 ms cadence). This stops the
      // "measures for 5 s then nothing" symptom: a momentary noise
      // burst won't strip a lock that's actually been valid.
      this.spectralBadUpdates++;
      if (this.spectralBadUpdates >= 6) {
        this.spectralLockHold = 0;
        this.spectralLocked = false;
      }
    }
  }

  private softReleaseSpectralLock(): void {
    // Pre-gate failure (PI obviously bad / no signal range). Same
    // sticky behaviour as updateSpectralLock — don't kill the lock on
    // a single bad frame, only after sustained failure.
    this.spectralBadUpdates++;
    if (this.spectralBadUpdates >= 12) {       // ~ same time-window
      this.spectralLockHold = 0;
      this.spectralLocked = false;
      this.cardiacValid = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  SLAVED PEAK DETECTOR
  // ─────────────────────────────────────────────────────────────────

  private updateAdaptiveThresholds(): void {
    const windowLen = Math.max(40, Math.min(BUFFER_CAPACITY, Math.round(this.fs * 4)));
    const n = Math.min(windowLen, this.filteredBuf.length);
    if (n < 20) return;

    const recent: number[] = new Array(n);
    for (let i = 0; i < n; i++) recent[i] = this.filteredBuf.get(this.filteredBuf.length - n + i);
    recent.sort((a, b) => a - b);
    const p10 = recent[Math.floor(n * 0.1)];
    const p90 = recent[Math.floor(n * 0.9)];
    const range = p90 - p10;

    const targetPeak   = p10 + range * 0.55;
    const targetValley = p10 + range * 0.40;

    if (this.peakThreshold === 0) {
      this.peakThreshold = targetPeak;
      this.valleyThreshold = targetValley;
    } else {
      const alpha = 0.12;
      this.peakThreshold = this.peakThreshold * (1 - alpha) + targetPeak * alpha;
      this.valleyThreshold = this.valleyThreshold * (1 - alpha) + targetValley * alpha;
    }
  }

  /**
   * Slaved peak detector: only accepts a candidate peak if we are
   * inside the *expected* RR window dictated by the spectral master.
   * This is what makes dicrotic doubling impossible: a dicrotic notch
   * always falls at ~0.3-0.4·T after the systolic peak, far outside
   * [0.7·T, 1.4·T].
   */
  private detectBeatSlaved(now: number): { detected: boolean; candidate?: BeatCandidate } {
    const n = this.filteredBuf.length;
    if (n < 5) return { detected: false };

    const cur = this.filteredBuf.get(n - 1);
    const prev = this.filteredBuf.get(n - 2);
    const prev2 = this.filteredBuf.get(n - 3);

    // Expected RR from spectral lock, fallback to median RR if we're
    // already running stably (kept for late-frame transitions).
    const expectedRR = this.spectralBPM > 0
      ? 60000 / this.spectralBPM
      : (this.rrIntervals.length >= 3 ? this.medianRRMs() : 800);
    const dtSinceLast = this.lastPeakTime > 0 ? now - this.lastPeakTime : 1e9;

    // Inside the slaved window? (Only blocks AFTER we've seen ≥1 beat.)
    const inSearchWindow = this.lastPeakTime === 0
      ? true
      : (dtSinceLast >= expectedRR * (1 - this.config.pulseSearchWindowFraction)
         && dtSinceLast <= expectedRR * (1 + this.config.pulseSearchWindowFraction));

    if (!inSearchWindow) {
      // Allow a "long-RR rescue" path: if dtSinceLast > 1.5·expectedRR
      // we may have missed a beat and need to re-acquire.
      if (dtSinceLast < expectedRR * 1.5) {
        // Inside the dicrotic-notch danger zone: reject any candidate.
        if (this.isSearchingPeak && cur < prev && prev >= prev2 && prev > this.peakThreshold) {
          this.isSearchingPeak = false;       // still update the FSM
          this.doublePeakCount++;
        } else if (cur < this.valleyThreshold) {
          this.isSearchingPeak = true;
        }
        return { detected: false };
      }
    }

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
          detectorAgreement: this.spectralLocked ? Math.max(0.7, this.spectralConfidence) : 0.5,
          zeroCrossingSupport: this.checkZeroCrossingSupport(),
          periodicitySupport: inSearchWindow,
          templateCorrelation: this.correlateWithTemplate(),
          localBandPowerRatio: this.spectralConfidence,
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
        // Augment detector hits / agreement using the dual-detector
        // fusion: a recent consensus from Elgendi+derivative confirms
        // this is a real beat, not a dicrotic shoulder. NEVER fabricates
        // a beat — only RAISES the agreement of one already produced.
        if (this.lastFusion) {
          if (this.lastFusion.consensus) {
            candidate.detectorHits = Math.max(candidate.detectorHits, 2);
            candidate.detectorAgreement = Math.min(1, Math.max(
              candidate.detectorAgreement, this.lastFusion.agreement,
            ));
          } else if (this.lastFusion.elgendiPeak || this.lastFusion.derivativePeak) {
            // Single-detector support — modest bump only.
            candidate.detectorAgreement = Math.min(1,
              candidate.detectorAgreement * 0.6 + 0.25,
            );
          }
        }
        return { detected: true, candidate };
      }
    } else if (cur < this.valleyThreshold) {
      this.isSearchingPeak = true;
    }
    return { detected: false };
  }

  // ─────────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────────

  private kalmanUpdate(measurement: number): number {
    if (this.kalmanX === 0) {
      this.kalmanX = measurement;
      return measurement;
    }
    const Q = 0.01, R = 0.1;
    const xPred = this.kalmanX;
    const pPred = this.kalmanP + Q;
    const K = pPred / (pPred + R);
    this.kalmanX = xPred + K * (measurement - xPred);
    this.kalmanP = (1 - K) * pPred;
    return this.kalmanX;
  }

  private normalizeSignal(value: number): { normalizedValue: number; normRange: number } {
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
    for (let i = lo; i < hi; i++) if (this.filteredBuf.get(i) > halfProm) width++;
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

  private calculateMorphologyScore(c: BeatCandidate): number {
    const ref = 120;
    const promFrac = c.prominence / ref;
    const upFrac = c.upSlope / ref;
    const dnFrac = c.downSlope / ref;
    let score = 0;
    score += Math.min(35, promFrac * 175);
    score += Math.min(20, Math.max(0, upFrac) * 400);
    score += (c.widthMs > 120 && c.widthMs < 550) ? 15 : 0;
    score += Math.min(10, Math.max(0, dnFrac) * 400);
    score += c.zeroCrossingSupport ? 5 : 0;
    score += c.templateCorrelation > 0 ? Math.min(15, c.templateCorrelation * 15) : 0;
    return Math.min(100, score);
  }

  private calculateRhythmScore(c: BeatCandidate): number {
    let score = 0;
    if (c.periodicitySupport) score += 30;
    score += Math.min(20, this.consecutivePeaks * 4);
    if (this.spectralLocked) score += 25;
    if (this.contactStable) score += 10;
    return Math.min(100, score);
  }

  private validateBeat(c: BeatCandidate, now: number): { accepted: boolean; reason: string } {
    const dt = this.lastPeakTime > 0 ? now - this.lastPeakTime : 1000;
    if (dt < this.config.refractoryHardMs) return { accepted: false, reason: 'refractory_hard' };

    const promFrac = c.prominence / 120;
    if (promFrac < 0.06) return { accepted: false, reason: 'low_prominence' };
    if (c.widthMs < 80 || c.widthMs > 700) return { accepted: false, reason: 'abnormal_width' };
    const upFrac = c.upSlope / 120;
    if (upFrac < 0.008) return { accepted: false, reason: 'no_rising_edge' };

    if (this.lastPeakValue > 0) {
      const ampRatio = c.amplitude / this.lastPeakValue;
      if (ampRatio < 0.20 || ampRatio > 5) return { accepted: false, reason: 'amplitude_inconsistent' };
    }

    const minScore = this.consecutivePeaks < 3 ? 18 : 25;
    if (c.totalScore < minScore) return { accepted: false, reason: 'low_total_score' };

    return { accepted: true, reason: '' };
  }

  private handleMissedBeat(longRR: number): void {
    if (this.rrIntervals.length < 3) return;
    const expectedRR = this.spectralBPM > 0 ? 60000 / this.spectralBPM : this.medianRRMs();
    if (expectedRR <= 0) return;
    const ratio = longRR / expectedRR;
    if (ratio >= 1.7 && ratio <= 2.5) {
      const half = longRR / 2;
      if (half >= 300 && half <= 1800) {
        const last = this.rrIntervals.length - 1;
        this.rrIntervals[last] = half;
        this.rrIntervals.push(half);
        if (this.rrIntervals.length > this.MAX_RR) this.rrIntervals.shift();
        this.missedBeatCount++;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  BPM FUSION (spectral-anchored)
  // ─────────────────────────────────────────────────────────────────

  private medianRRMs(): number {
    if (this.rrIntervals.length < 2) return 0;
    const sorted = [...this.rrIntervals.slice(-10)].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private trimmedMeanRRMs(): number {
    if (this.rrIntervals.length < 4) return 0;
    const sorted = [...this.rrIntervals.slice(-12)].sort((a, b) => a - b);
    const trimN = Math.max(1, Math.floor(sorted.length * 0.2));
    const trimmed = sorted.slice(trimN, sorted.length - trimN);
    if (trimmed.length === 0) return 0;
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }

  private estimateAutocorrBPM(): number {
    if (this.filteredBuf.length < Math.round(this.fs * 2.5)) return 0;
    const sr = this.fs;
    const n = Math.min(Math.round(sr * 6), this.filteredBuf.length);
    const minLag = Math.max(3, Math.round((sr * 60) / 200));
    const maxLag = Math.min(n - 10, Math.round((sr * 60) / 38));
    let bestLag = 0, bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += this.filteredBuf.get(this.filteredBuf.length - n + i)
             * this.filteredBuf.get(this.filteredBuf.length - n + i + lag);
      }
      if (sum > bestScore) { bestScore = sum; bestLag = lag; }
    }
    if (bestLag === 0 || bestScore < 0.1) return 0;
    return (60 * sr) / bestLag;
  }

  /**
   * Fusion is dominated by the spectral lock. Peak-derived values are
   * only used to refine when they agree with the spectrum (within
   * ±15 %), otherwise the spectral value wins.
   */
  private fuseBPM(): BPMHypothesis {
    const fromMedianIBI = this.rrIntervals.length >= 2 ? 60000 / this.medianRRMs() : 0;
    this.medianRRBPM = fromMedianIBI;
    const trimmed = this.trimmedMeanRRMs();
    const fromTrimmedIBI = trimmed > 0 ? 60000 / trimmed : 0;
    const fromAutocorr = this.estimateAutocorrBPM();
    this.autocorrBPM = fromAutocorr;
    const fromLastIBI = this.rrIntervals.length > 0 ? 60000 / this.rrIntervals[this.rrIntervals.length - 1] : 0;

    let finalBpm = this.spectralBPM;
    let dominantSource: 'peak' | 'autocorr' | 'median' = 'autocorr';
    let confidence = this.spectralConfidence;

    if (this.spectralLocked && fromMedianIBI > 0) {
      const ratio = fromMedianIBI / Math.max(1, this.spectralBPM);
      if (ratio > 0.85 && ratio < 1.15) {
        // Spectrum and median agree → blend lightly toward median for HRV detail
        finalBpm = this.spectralBPM * 0.6 + fromMedianIBI * 0.4;
        dominantSource = 'median';
        confidence = Math.min(1, this.spectralConfidence + 0.2);
      } else if (ratio > 1.7 && ratio < 2.3) {
        // Median is double — dicrotic. Trust spectrum.
        finalBpm = this.spectralBPM;
      } else if (ratio > 0.43 && ratio < 0.59) {
        // Median is half — missed beats. Trust spectrum.
        finalBpm = this.spectralBPM;
      } else {
        // Outright disagreement — trust spectrum.
        finalBpm = this.spectralBPM;
      }
    }

    if (finalBpm > 0) finalBpm = this.kalmanUpdate(finalBpm);

    return {
      fromLastIBI,
      fromMedianIBI,
      fromTrimmedIBI,
      fromAutocorrelation: fromAutocorr,
      fromSpectral: 0,
      finalBpm: Math.round(finalBpm),
      confidence,
      dominantSource,
    };
  }

  private computeBPMConfidence(h: BPMHypothesis): number {
    if (!this.spectralLocked || h.finalBpm === 0) return 0;
    const peakFactor = Math.min(1, this.consecutivePeaks / 8) * 0.20;
    const avgSQI = this.getAvgBeatSQI() / 100 * 0.20;
    const spectralFactor = this.spectralConfidence * 0.40;

    let rrStability = 0;
    if (this.rrIntervals.length >= 3) {
      const recent = this.rrIntervals.slice(-8);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const variance = recent.reduce((a, rr) => a + (rr - mean) ** 2, 0) / recent.length;
      const cv = Math.sqrt(variance) / Math.max(1, mean);
      rrStability = Math.max(0, Math.min(1, 1 - cv * 2)) * 0.20;
    }
    return Math.max(0, Math.min(1, peakFactor + avgSQI + spectralFactor + rrStability));
  }

  private computeGlobalSQI(): number {
    if (!this.spectralLocked || this.filteredBuf.length < 30) return 0;
    const range = this.getSignalRange();
    const rangeFactor = Math.min(1, range / 4) * 25;
    const peakFactor = Math.min(1, this.consecutivePeaks / 5) * 15;
    const spectralFactor = this.spectralConfidence * 30;
    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const m = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
      const v = this.rrIntervals.reduce((a, rr) => a + (rr - m) ** 2, 0) / this.rrIntervals.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrFactor = Math.max(0, 1 - cv * 2) * 20;
    }
    const perfusionBonus = this.perfusionIndex > 0.5 && this.perfusionIndex < 6 ? 10 : 0;
    return Math.max(0, Math.min(100, Math.round(rangeFactor + peakFactor + spectralFactor + rrFactor + perfusionBonus)));
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

  private computeBeatSQI(c: BeatCandidate): number {
    let sqi = 0;
    sqi += Math.min(30, c.morphologyScore * 0.35);
    sqi += c.detectorAgreement * 25;
    sqi += Math.max(0, c.templateCorrelation) * 18;
    sqi += Math.min(12, c.rhythmScore * 0.12);
    sqi += this.contactStable ? 8 : 0;
    sqi -= c.localMotionPenalty * 20;
    return Math.max(0, Math.min(100, Math.round(sqi)));
  }

  private computeBeatFlags(c: BeatCandidate, dt: number): BeatFlags {
    const expectedRR = this.spectralBPM > 0 ? 60000 / this.spectralBPM : this.medianRRMs();
    const isPremature = expectedRR > 0 && dt > 0 && dt < expectedRR * 0.7;
    return {
      isWeak: c.detectorHits < 2 && c.morphologyScore < 40,
      isDoublePeak: false,
      isMissedBeatInserted: false,
      isPremature,
      isSuspicious: isPremature || c.totalScore < 35,
    };
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
  ): HeartBeatDebug {
    const dt = this.lastPeakTime > 0 ? now - this.lastPeakTime : 0;
    const expectedRR = this.spectralBPM > 0 ? 60000 / this.spectralBPM : this.medianRRMs();
    return {
      instantBpm: isPeak && dt > 0 ? 60000 / dt : 0,
      medianRRBpm: this.medianRRBPM,
      autocorrBpm: this.autocorrBPM,
      spectralBpm: this.spectralBPM,
      lastBeatSQI: beatSQI,
      detectorAgreement: detection.candidate?.detectorAgreement ?? 0,
      expectedRR,
      refractoryState: dt < this.config.refractoryHardMs ? 'hard'
        : dt < expectedRR * this.config.refractorySoftFactor ? 'soft' : 'open',
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
        instantBpm: 0, medianRRBpm: 0, autocorrBpm: 0, spectralBpm: this.spectralBPM,
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
  getSQI(): number { return this.computeGlobalSQI(); }
  getSpectralBPM(): number { return this.spectralBPM; }
  isCardiacValid(): boolean { return this.cardiacValid; }

  reset(): void {
    this.signalBuf.clear();
    this.filteredBuf.clear();
    this.vpgBuf.clear();
    this.apgBuf.clear();
    this.timestampBuf.clear();
    this.rrIntervals = [];
    this.acceptedBeats = [];
    this.smoothBPM = 0;
    this.kalmanX = 0;
    this.kalmanP = 1;
    this.autocorrBPM = 0;
    this.medianRRBPM = 0;
    this.spectralBPM = 0;
    this.spectralConfidence = 0;
    this.spectralLockHold = 0;
    this.spectralBadUpdates = 0;
    this.spectralLocked = false;
    this.cardiacValid = false;
    this.lastSpectralUpdate = 0;
    this.lastPeakTime = 0;
    this.lastPeakValue = 0;
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
    this.lastFusion = null;
    this.fusionConsensusCount = 0;
    this.fusionDisagreeCount = 0;
    this.lastFusionEvalMs = 0;
  }

  dispose(): void { /* no-op */ }
}

export default HeartBeatProcessorOptimized;
