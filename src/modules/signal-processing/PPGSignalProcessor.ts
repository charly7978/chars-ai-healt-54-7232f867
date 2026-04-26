import type { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface, ContactState } from '../../types/signal';
import { BandpassFilter } from './BandpassFilter';
import { RingBuffer } from './RingBuffer';
import { AdaptiveROIMask, type ROIMaskResult } from './AdaptiveROIMask';
import { PressureProxyEstimator, type PressureState, type PressureEstimate } from './PressureProxyEstimator';
import { SignalSourceRanker } from './SignalSourceRanker';
import { computeGlobalSQI } from './SignalQualityEstimator';
import { CardiacBandVerifier } from './CardiacBandVerifier';
import { OpticalEvidenceGate, type OpticalEvidence, type OpticalGateConfig } from './OpticalEvidenceGate';

/**
 * Conversión sRGB (0..255) → intensidad lineal [0..1] según IEC 61966-2-1.
 * Necesaria para que la Optical Density represente absorbancia física real
 * (la cámara aplica gamma ≈ 2.2 que comprime la pulsatilidad).
 */
function srgbToLinear(c8: number): number {
  const x = Math.max(0, Math.min(255, c8)) / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

// Extended contact states
type ExtendedContactState = ContactState | 'ACQUIRING_CONTACT' | 'SATURATED_CONTACT' | 'EXCESSIVE_PRESSURE';

/**
 * FORENSIC LIVENESS THRESHOLDS — Gate #1 (hemoglobin signature + texture).
 *
 * This is the FIRST physical gate. A live finger covering the rear camera
 * with the torch on MUST satisfy ALL of the following simultaneously:
 *
 *   - R/(G+B) ≥ 1.35       hemoglobin absorbs G+B much more than R; a wall,
 *                          paper, mesa, ambient light or even another body
 *                          part NOT touching the lens will not reach 1.35.
 *   - R - (G+B)/2 ≥ 18     dominant red component on the raw 0..255 axis.
 *   - total intensity ∈ [180, 700]   skin-under-torch brightness band.
 *   - coverage ≥ 0.35      finger physically covers ≥35% of the frame.
 *   - sub-tile texture in [0.008, 0.06]   real fingertip has micro-texture
 *                          (sub-dermal vasculature, ridges); air/wall is
 *                          flat (≈0); violent reflection is high (>0.06).
 *   - sustained 12 frames (~400 ms) before locking; releases in 6 frames.
 *
 * If ANY criterion fails → gate1_optical = false and ALL downstream output
 * is zeroed. This is what physically prevents the app from "measuring the
 * air".
 */
const LIVENESS = {
  ABSORPTION_MIN: 1.35,
  RED_OVER_GB_MIN: 18,
  TOTAL_I_MIN: 180,
  TOTAL_I_MAX: 700,
  COVERAGE_MIN: 0.35,
  TEXTURE_MIN: 0.008, // stdR / meanR — flat surface gives ~0
  TEXTURE_MAX: 0.06,  // glare / motion gives >0.06
  CONFIRM_FRAMES: 12,
  RELEASE_FRAMES: 6,
} as const;

/**
 * PPG SIGNAL PROCESSOR V2
 * 
 * Complete rewrite with:
 * - AdaptiveROIMask (7x7 tiles, saturation exclusion, percentile thresholds)
 * - PressureProxyEstimator (LOW/OPTIMAL/HIGH)
 * - SignalSourceRanker (6 candidates, autocorrelation SQI, hysteresis)
 * - RingBuffer (Float64Array, zero-alloc hot path)
 * - Real frame timing from requestVideoFrameCallback metadata
 * - Comprehensive SQI from SignalQualityEstimator
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing = false;

  // --- Sub-modules ---
  private bandpassFilter: BandpassFilter;
  private roiMask = new AdaptiveROIMask();
  private pressureEstimator = new PressureProxyEstimator();
  private sourceRanker = new SignalSourceRanker();
  // Forensic Gate #2 — cardiac-band SNR verifier on the raw red channel.
  private cardiacVerifier = new CardiacBandVerifier();
  // Forensic Optical Evidence Gate — physical-only acceptance/rejection
  // (clipping, exposure, hemoglobin signature, texture, AC/DC, perfusion).
  // Independiente de morfología, no bloquea por "forma de dedo".
  private opticalGate = new OpticalEvidenceGate();
  private lastOpticalEvidence: OpticalEvidence | null = null;

  // --- Ring buffers (zero-alloc) ---
  private readonly BUF_SIZE = 300;
  private redBuf = new RingBuffer(300);
  private greenBuf = new RingBuffer(300);
  private blueBuf = new RingBuffer(300);
  private rawSignalBuf = new RingBuffer(300);
  private filteredBuf = new RingBuffer(300);
  private vpgBuf = new RingBuffer(300);
  private apgBuf = new RingBuffer(300);
  private frameTimeBuf = new RingBuffer(120);

  // ── BUFFER CIRCULAR 10s POR TIMESTAMPS REALES ────────────────────────
  // Cada muestra lleva su tiempo absoluto (frameTimestamp). En cada frame
  // se desalojan las muestras con edad > TIME_WINDOW_MS. Sample rate
  // efectivo se mide del span real, NO de un nominal 30 fps.
  private readonly TIME_WINDOW_MS = 10_000;
  private timedSamples: { t: number; od: number; r: number; g: number; b: number }[] = [];
  // PI window ~500 ms para detectar despegue de dedo (PERFUSION_DROP)
  private piWindow: number[] = [];
  private readonly PI_WINDOW_MS = 500;
  private piWindowTimes: number[] = [];

  // OD baseline (DC móvil para conversión sRGB→OD)
  private odDcMovingAvg = 0;

  // Triple-gate publication state (último resultado autorizado)
  private publicationGate = false;

  // --- AC/DC ---
  private redDC = 0; private redAC = 0;
  private greenDC = 0; private greenAC = 0;
  private blueDC = 0; private blueAC = 0;

  // --- Baselines ---
  private redBaseline = 0;
  private greenBaseline = 0;
  private blueBaseline = 0;
  private estimatedSampleRate = 30;
  private lastFrameTime = 0; // performance.now() based

  private frameCount = 0;
  private lastLogTime = 0;

  // --- Contact state machine ---
  private contactState: ExtendedContactState = 'NO_CONTACT';
  private exportedContactState: ContactState = 'NO_CONTACT';
  private fingerDetected = false;
  private signalQuality = 0;
  private fingerConfidenceCount = 0;
  private fingerLostCount = 0;
  private stableContactCount = 0;
  private readonly FINGER_CONFIRM = 10;   // ~333ms strict
  private readonly FINGER_LOST = 120;     // ~4s tolerance
  private readonly STABLE_THRESHOLD = 40; // ~1.3s for STABLE
  private readonly UNSTABLE_GRACE = 160;

  // --- Forensic optical liveness ---
  // Independent of the perfusion-based finger detector. Verifies that what
  // the camera sees has a hemoglobin signature; if not, NO numeric output
  // is ever produced.
  private livenessConfirmCount = 0;
  private livenessLostCount = 0;
  private opticalLive = false;
  private lastLivenessReason = 'AIRE / SIN TEJIDO';

  // --- Forensic Gate #2 telemetry ---
  private gate2Pass = false;
  private gate2SNRdB = 0;
  private gate2PeakHz = 0;
  private gate2Concentration = 0;
  private gate2Reason = 'CALENTANDO';

  // --- Forensic Gate #3 telemetry (filled by HeartBeatProcessor via setMorphologyGate) ---
  private gate3Pass = false;
  private gate3Reason = 'BUSCANDO LATIDOS';

  /**
   * Allow the heartbeat layer to push back gate #3 so the next emitted frame
   * carries the truth about morphology validation. Called from useHeartBeatProcessor.
   */
  public setMorphologyGate(pass: boolean, reason?: string): void {
    this.gate3Pass = pass;
    if (reason) this.gate3Reason = reason;
  }

  /** Permite ajustar umbrales del OpticalEvidenceGate desde UI/auditoría. */
  public setOpticalGateConfig(patch: Partial<OpticalGateConfig>): void {
    this.opticalGate.setConfig(patch);
  }

  public getOpticalGateConfig(): OpticalGateConfig {
    return this.opticalGate.getConfig();
  }

  public getLastOpticalEvidence(): OpticalEvidence | null {
    return this.lastOpticalEvidence;
  }

  public isPublicationGateOpen(): boolean {
    return this.publicationGate;
  }

  // --- Smoothed metrics (EWMA) ---
  private smoothedRed = 0;
  private smoothedGreen = 0;
  private smoothedBlue = 0;
  private smoothedCoverage = 0;
  private smoothedFingerScore = 0;
  private readonly RGB_ALPHA = 0.04;
  private readonly COV_ALPHA = 0.05;

  // --- Position lock ---
  private positionLocked = false;
  private lockedRedBase = 0;
  private lockedGreenBase = 0;
  private lockedCoverage = 0;
  private positionStabilityCount = 0;
  private readonly POS_LOCK_FRAMES = 60;
  private readonly POS_DRIFT_TOL = 0.12;
  private positionDrifting = false;
  private positionDrift = 0;
  private positionGuidance = 'COLOQUE SU DEDO SOBRE LA CÁMARA Y EL FLASH';
  private positionQualityScore = 0;
  private spatialUniformity = 0;
  private centerCoverage = 0;

  // --- Pressure ---
  private pressureState: PressureState = 'LOW_PRESSURE';
  private pressurePenalty = 1.0;

  // --- Motion (IMU-based gating) ---
  // motionScore is an EWMA-filtered RMS of accelerometer delta + gyroscope rate.
  // Levels:
  //   < MOTION_THRESH       → quiet, no penalty
  //   ≥ MOTION_THRESH       → motionArtifact flag set (down-weight downstream)
  //   ≥ MOTION_HIGH_THRESH  → strong down-weight: quality halved, no peak validation
  //   ≥ MOTION_GATE_THRESH  → SUSPEND: skip baseline/buffer/source updates entirely
  private motionScore = 0;
  private motionListenerActive = false;
  private lastAccel = { x: 0, y: 0, z: 0 };
  private motionEventCount = 0;
  private readonly MOTION_THRESH = 0.6;
  private readonly MOTION_HIGH_THRESH = 0.95;
  private readonly MOTION_GATE_THRESH = 1.6;

  // --- Debug / telemetry ---
  private debugEnabled = false;
  private lastROIResult: ROIMaskResult | null = null;
  private activeSourceLabel = 'RG';
  private allSourceSQI: Record<string, number> = {};
  private clipHighRatio = 0;
  private clipLowRatio = 0;
  private processingTimeMs = 0;
  private realFps = 0;
  private sourceStability = 0;
  private lastSourceLabel = 'RG';
  private sourceStableFrames = 0;

  constructor(
    public onSignalReady?: (signal: ProcessedSignal) => void,
    public onError?: (error: ProcessingError) => void
  ) {
    this.bandpassFilter = new BandpassFilter(this.estimatedSampleRate);
  }

  async initialize(): Promise<void> { this.reset(); }

  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.initialize();
    this.startMotionListener();
  }

  stop(): void {
    this.isProcessing = false;
    this.stopMotionListener();
  }

  async calibrate(): Promise<boolean> { return true; }

  /** Accept frame timestamp from requestVideoFrameCallback metadata */
  processFrame(imageData: ImageData, frameTimestamp?: number): void {
    if (!this.isProcessing || !this.onSignalReady) return;

    const t0 = performance.now();
    this.frameCount++;
    const timestamp = frameTimestamp ?? performance.now();
    this.updateSampleRate(timestamp);

    // --- ADAPTIVE ROI ---
    const roi = this.roiMask.process(imageData);
    this.lastROIResult = roi;
    this.clipHighRatio = roi.clipHighRatio;
    this.clipLowRatio = roi.clipLowRatio;
    this.spatialUniformity = roi.spatialUniformity;
    this.centerCoverage = roi.centerCoverage;

    // ════════════════════════════════════════════════════════════
    //  FORENSIC OPTICAL LIVENESS GATE
    //  This runs BEFORE anything else. If the camera is looking at air,
    //  ambient light, a wall, a desk, or anything that lacks a hemoglobin
    //  optical signature → emit NO_OPTICAL_CONTACT with rawValue=0,
    //  filteredValue=0, quality=0 and DO NOT update buffers, baselines
    //  or filters. This is the single line of defense that stops the app
    //  from inventing a "cardiac wave" out of camera noise / autoexposure.
    // ════════════════════════════════════════════════════════════
    const lr = roi.rawRed;
    const lg = roi.rawGreen;
    const lb = roi.rawBlue;
    const lAbsorption = (lg + lb) > 1 ? lr / (lg + lb) : 0;
    const lRedDom = lr - (lg + lb) / 2;
    const lTotalI = lr + lg + lb;
    // Spatial texture from ROI (1 - spatialUniformity) acts as the std/mean
    // proxy: a real fingertip pressed on the lens has micro-texture (>0.008
    // and <0.06); a wall/air/glare is either perfectly flat (~0) or wildly
    // non-uniform (>0.06). spatialUniformity in [0..1] inverts to texture.
    const textureProxy = Math.max(0, 1 - roi.spatialUniformity);
    const textureOk = textureProxy >= LIVENESS.TEXTURE_MIN && textureProxy <= LIVENESS.TEXTURE_MAX;
    const livenessInstant =
      lAbsorption >= LIVENESS.ABSORPTION_MIN &&
      lRedDom >= LIVENESS.RED_OVER_GB_MIN &&
      lTotalI >= LIVENESS.TOTAL_I_MIN &&
      lTotalI <= LIVENESS.TOTAL_I_MAX &&
      roi.coverageRatio >= LIVENESS.COVERAGE_MIN &&
      textureOk;

    if (livenessInstant) {
      this.livenessConfirmCount = Math.min(this.livenessConfirmCount + 1, 200);
      this.livenessLostCount = 0;
      if (!this.opticalLive && this.livenessConfirmCount >= LIVENESS.CONFIRM_FRAMES) {
        this.opticalLive = true;
      }
    } else {
      this.livenessLostCount = Math.min(this.livenessLostCount + 1, 200);
      this.livenessConfirmCount = Math.max(0, this.livenessConfirmCount - 1);
      if (this.opticalLive && this.livenessLostCount >= LIVENESS.RELEASE_FRAMES) {
        this.opticalLive = false;
      }
      // Build forensic reason string for the diagnostic banner
      if (lTotalI < LIVENESS.TOTAL_I_MIN) this.lastLivenessReason = 'OSCURO / SIN CONTACTO';
      else if (lTotalI > LIVENESS.TOTAL_I_MAX) this.lastLivenessReason = 'LUZ DIRECTA / NO ES TEJIDO';
      else if (lAbsorption < LIVENESS.ABSORPTION_MIN) this.lastLivenessReason = `SIN FIRMA DE HEMOGLOBINA (R/(G+B)=${lAbsorption.toFixed(2)})`;
      else if (lRedDom < LIVENESS.RED_OVER_GB_MIN) this.lastLivenessReason = 'ROJO INSUFICIENTE — NO ES TEJIDO';
      else if (roi.coverageRatio < LIVENESS.COVERAGE_MIN) this.lastLivenessReason = 'CUBRA EL LENTE CON EL DEDO';
      else if (!textureOk) this.lastLivenessReason = textureProxy < LIVENESS.TEXTURE_MIN
        ? 'SUPERFICIE PLANA — NO ES PIEL'
        : 'TEXTURA INESTABLE — REFLEJO/MOVIMIENTO';
      else this.lastLivenessReason = 'SIN CONTACTO ÓPTICO';
    }

    if (!this.opticalLive) {
      // HARD FORENSIC ZERO. No buffers, no filter step, no source ranking.
      // Reset transient detector counters so when liveness returns we start clean.
      this.fingerDetected = false;
      this.fingerConfidenceCount = 0;
      this.stableContactCount = 0;
      this.contactState = 'NO_CONTACT';
      this.exportedContactState = 'NO_OPTICAL_CONTACT';
      this.signalQuality = 0;
      // Reset spectral verifier so a fresh contact starts cleanly.
      this.cardiacVerifier.reset();
      this.gate2Pass = false; this.gate2Reason = 'SIN SEÑAL';
      this.gate3Pass = false; this.gate3Reason = 'SIN SEÑAL';
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: 0,
        quality: 0,
        fingerDetected: false,
        contactState: 'NO_OPTICAL_CONTACT',
        motionArtifact: false,
        roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
        perfusionIndex: 0,
        rawRed: lr,
        rawGreen: lg,
        diagnostics: {
          message: `SIN PULSO — ${this.lastLivenessReason}`,
          hasPulsatility: false,
          pulsatilityValue: 0,
        },
        forensicGate: {
          gate1_optical: false,
          gate2_spectral: false,
          gate3_morphology: false,
          passAll: false,
          cardiacSNRdB: 0,
          spectralPeakHz: 0,
          spectralConcentration: 0,
          livenessReason: this.lastLivenessReason,
        },
      });
      this.processingTimeMs = performance.now() - t0;
      return;
    }

    // --- PRESSURE ESTIMATION ---
    const pressure = this.pressureEstimator.estimate({
      coverageRatio: roi.coverageRatio,
      clipHighRatio: roi.clipHighRatio,
      clipLowRatio: roi.clipLowRatio,
      perfusionIndex: this.calculatePerfusionIndex(),
      spatialUniformity: roi.spatialUniformity,
      brightness: roi.brightness,
      brightnessVariance: roi.brightnessVariance,
      baselineDrift: this.getBaselineDrift(),
    });
    this.pressureState = pressure.state;
    this.pressurePenalty = pressure.penalty;

    // --- CONTACT STATE ---
    this.updateContactState(roi, pressure);
    const motionArtifact = this.motionScore > this.MOTION_THRESH;
    const motionHigh = this.motionScore > this.MOTION_HIGH_THRESH;
    // FORENSIC: motion is NEVER a hard gate. The forensic operator may move
    // the phone while examining a victim. Heavy motion only down-weights SQI
    // (handled below), it does NOT freeze the pipeline.
    const motionGated = false;

    if (this.exportedContactState === 'NO_CONTACT' || this.exportedContactState === 'NO_OPTICAL_CONTACT') {
      this.signalQuality = 0;
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: 0,
        quality: 0,
        fingerDetected: false,
        contactState: this.exportedContactState,
        motionArtifact,
        roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
        perfusionIndex: 0,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        diagnostics: {
          message: `BUSCANDO DEDO C:${(roi.coverageRatio * 100).toFixed(0)}% P:${pressure.state}${motionArtifact ? ' MOV' : ''}`,
          hasPulsatility: false,
          pulsatilityValue: 0,
        },
      });
      this.processingTimeMs = performance.now() - t0;
      return;
    }

    // --- MOTION GATE: if device shaking hard, freeze signal extraction ---
    // Buffers, baselines and source ranking are NOT updated → no contamination.
    // We still emit a signal frame (so UI / downstream see continuity) but with
    // quality=0, motionArtifact=true and the last filtered value held.
    if (motionGated) {
      const lastFiltered = this.filteredBuf.length > 0 ? this.filteredBuf.get(this.filteredBuf.length - 1) : 0;
      this.signalQuality = 0;
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: lastFiltered,
        quality: 0,
        fingerDetected: this.fingerDetected,
        contactState: 'UNSTABLE_CONTACT',
        motionArtifact: true,
        roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
        perfusionIndex: 0,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        diagnostics: {
          message: `MOV ALTO m=${this.motionScore.toFixed(2)} - SOSTENGA EL TELÉFONO QUIETO`,
          hasPulsatility: false,
          pulsatilityValue: 0,
        },
      });
      this.processingTimeMs = performance.now() - t0;
      return;
    }

    // --- Contact detected: update baselines & buffers ---
    this.updateBaselines(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);
    this.redBuf.push(roi.rawRed);
    this.greenBuf.push(roi.rawGreen);
    this.blueBuf.push(roi.rawBlue);

    // ── sRGB → LINEAL → OPTICAL DENSITY (absorbancia hemoglobina) ─────
    // OD = -log10((I_lin + ε) / I0_lin), donde I0 es el DC móvil lineal.
    // OD es la magnitud que la espectroscopía ve realmente; usar el rojo
    // crudo subestima la pulsatilidad cuando la cámara aplica gamma.
    const linR = srgbToLinear(roi.rawRed);
    if (this.odDcMovingAvg <= 0) this.odDcMovingAvg = linR;
    else this.odDcMovingAvg += (linR - this.odDcMovingAvg) * 0.02; // ~5s tau a 30fps
    const odSample = -Math.log10((linR + 1e-6) / Math.max(this.odDcMovingAvg, 1e-6));

    // ── BUFFER TEMPORAL DE 10s POR TIMESTAMPS REALES ────────────────
    this.timedSamples.push({ t: timestamp, od: odSample, r: roi.rawRed, g: roi.rawGreen, b: roi.rawBlue });
    while (this.timedSamples.length > 0 && (timestamp - this.timedSamples[0].t) > this.TIME_WINDOW_MS) {
      this.timedSamples.shift();
    }

    if (this.redBuf.length >= 36) {
      this.calculateACDC();
    }

    // --- MULTI-SOURCE EXTRACTION ---
    const redPI = this.redDC > 0 ? this.redAC / this.redDC : 0;
    const greenPI = this.greenDC > 0 ? this.greenAC / this.greenDC : 0;

    const source = this.sourceRanker.update(
      roi.rawRed, roi.rawGreen, roi.rawBlue,
      this.redBaseline, this.greenBaseline, this.blueBaseline,
      redPI, greenPI,
      roi.clipHighRatio, motionArtifact
    );
    this.activeSourceLabel = source.label;
    this.allSourceSQI = source.allSQI;

    // Track source stability
    if (source.label === this.lastSourceLabel) {
      this.sourceStableFrames = Math.min(this.sourceStableFrames + 1, 300);
    } else {
      this.sourceStableFrames = 0;
      this.lastSourceLabel = source.label;
    }
    this.sourceStability = Math.min(1, this.sourceStableFrames / 60);

    // --- FILTERING ---
    this.rawSignalBuf.push(source.value);
    const filtered = this.bandpassFilter.filter(source.value);
    this.filteredBuf.push(filtered);

    // Derivatives for morphology analysis
    if (this.filteredBuf.length >= 3) {
      const n = this.filteredBuf.length;
      this.vpgBuf.push((this.filteredBuf.get(n - 1) - this.filteredBuf.get(n - 3)) / 2);
    }
    if (this.vpgBuf.length >= 3) {
      const n = this.vpgBuf.length;
      this.apgBuf.push((this.vpgBuf.get(n - 1) - this.vpgBuf.get(n - 3)) / 2);
    }

    // --- GLOBAL SQI ---
    const perfusionIndex = this.calculatePerfusionIndex();

    // ── PI WINDOW (500 ms) para detección de PERFUSION_DROP ──────────
    this.piWindow.push(perfusionIndex);
    this.piWindowTimes.push(timestamp);
    while (this.piWindowTimes.length > 0 && (timestamp - this.piWindowTimes[0]) > this.PI_WINDOW_MS) {
      this.piWindowTimes.shift();
      this.piWindow.shift();
    }

    // ── OPTICAL EVIDENCE GATE (físico, sin morfología) ──────────────
    // Stats RGB de la ROI + AC/DC reciente del rojo. Si rechaza, el frame
    // se sigue emitiendo pero con publicationGate=false y razón visible.
    const stdR_proxy = roi.rawRed > 0 ? roi.rawRed * (1 - this.spatialUniformity) : 0;
    this.lastOpticalEvidence = this.opticalGate.evaluate(
      {
        meanR: roi.rawRed,
        meanG: roi.rawGreen,
        meanB: roi.rawBlue,
        stdR: stdR_proxy,
        clipHighRatio: roi.clipHighRatio,
        clipLowRatio: roi.clipLowRatio,
        acComponent: this.redAC,
        dcComponent: this.redDC,
      },
      { piWindow: this.piWindow.slice() }
    );

    const signalRange = this.getSignalRange();
    const redDominance = this.smoothedRed - (this.smoothedGreen + this.smoothedBlue) / 2;

    // Periodicity from source ranker autocorrelation
    const periodicityScore = this.estimatePeriodicityFromFiltered();

    this.signalQuality = computeGlobalSQI({
      perfusionIndex,
      periodicityScore,
      coverageRatio: this.smoothedCoverage,
      spatialUniformity: this.spatialUniformity,
      pressurePenalty: this.pressurePenalty,
      motionScore: this.motionScore,
      clipHighRatio: roi.clipHighRatio,
      clipLowRatio: roi.clipLowRatio,
      positionDrift: this.positionDrift,
      signalRange,
      redDominance,
      contactState: this.exportedContactState,
      sourceStability: this.sourceStability,
    });

    // Gate: drift penalty
    const driftPenalty = this.positionDrifting ? 0.15 : 1.0;
    // Motion penalty applied on top of contact/drift gating
    const motionQualPenalty = motionHigh ? 0.40 : (motionArtifact ? 0.70 : 1.0);
    const isGoodPerfusion = this.exportedContactState === 'OPTICAL_CONTACT_GOOD_PERFUSION';
    const gatedQuality = isGoodPerfusion && perfusionIndex >= 0.005
      ? this.signalQuality * driftPenalty
      : Math.min(18, this.signalQuality * 0.45);
    const finalQuality = gatedQuality * motionQualPenalty;

    // --- LOGGING ---
    const now = performance.now();
    this.processingTimeMs = now - t0;
    if (now - this.lastLogTime >= 3000) {
      this.lastLogTime = now;
      console.log(
        `📷 PPG [${source.label}] Q=${gatedQuality.toFixed(0)} PI=${perfusionIndex.toFixed(3)} ` +
        `${this.exportedContactState} P:${this.pressureState} ` +
        `FPS=${this.realFps.toFixed(0)} Clip:${(roi.clipHighRatio * 100).toFixed(1)}% ` +
        `Cov:${(this.smoothedCoverage * 100).toFixed(0)}% Proc:${this.processingTimeMs.toFixed(1)}ms`
      );
    }

    this.onSignalReady({
      timestamp,
      rawValue: source.value,
      filteredValue: filtered,
      quality: finalQuality,
      fingerDetected: this.fingerDetected,
      contactState: this.exportedContactState,
      motionArtifact,
      roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
      perfusionIndex,
      rawRed: roi.rawRed,
      rawGreen: roi.rawGreen,
      diagnostics: {
        message:
          `${source.label} PI:${perfusionIndex.toFixed(2)} P:${this.pressureState.charAt(0)} ` +
          `C:${(this.smoothedCoverage * 100).toFixed(0)} ${this.exportedContactState}` +
          `${motionArtifact ? (motionHigh ? ' MOV+' : ' MOV') : ''}`,
        hasPulsatility: isGoodPerfusion && perfusionIndex >= 0.05,
        pulsatilityValue: isGoodPerfusion ? perfusionIndex : 0,
      },
      forensicGate: this.computeForensicGate(roi.rawRed, timestamp),
    });
  }

  /**
   * Run Gate #2 (cardiac SNR) on the latest red sample and merge with the
   * already-known Gate #1 + Gate #3 state into the unified verdict the UI
   * uses to decide whether ANYTHING gets rendered.
   */
  private computeForensicGate(rawRed: number, nowMs: number) {
    const g2 = this.cardiacVerifier.update(rawRed, this.estimatedSampleRate, nowMs);
    this.gate2Pass = g2.passes;
    this.gate2SNRdB = g2.snrDb;
    this.gate2PeakHz = g2.peakHz;
    this.gate2Concentration = g2.concentration;
    this.gate2Reason = g2.reason;

    const passAll = this.opticalLive && this.gate2Pass && this.gate3Pass;
    let livenessReason = 'OK';
    if (!this.opticalLive) livenessReason = this.lastLivenessReason;
    else if (!this.gate2Pass) livenessReason = this.gate2Reason;
    else if (!this.gate3Pass) livenessReason = this.gate3Reason;

    return {
      gate1_optical: this.opticalLive,
      gate2_spectral: this.gate2Pass,
      gate3_morphology: this.gate3Pass,
      passAll,
      cardiacSNRdB: this.gate2SNRdB,
      spectralPeakHz: this.gate2PeakHz,
      spectralConcentration: this.gate2Concentration,
      livenessReason,
    };
  }

  // ══════════════════════════════════════════════════════
  //  CONTACT STATE MACHINE V2
  // ══════════════════════════════════════════════════════

  private updateContactState(roi: ROIMaskResult, pressure: PressureEstimate): void {
    const prev = this.contactState;
    const instant = this.detectFingerInstant(roi);

    if (instant) {
      this.fingerLostCount = 0;
      this.fingerConfidenceCount = Math.min(this.fingerConfidenceCount + 1, 200);
      this.stableContactCount++;

      if (this.fingerConfidenceCount >= this.FINGER_CONFIRM) {
        this.fingerDetected = true;

        // Check for pressure-based state overrides
        if (pressure.state === 'HIGH_PRESSURE' && roi.clipHighRatio > 0.15) {
          this.contactState = 'EXCESSIVE_PRESSURE';
        } else if (roi.clipHighRatio > 0.3) {
          this.contactState = 'SATURATED_CONTACT';
        } else {
          const perfusion = this.calculatePerfusionIndex();
          this.contactState = (this.stableContactCount >= this.STABLE_THRESHOLD && perfusion > 0.003 && pressure.state !== 'HIGH_PRESSURE')
            ? 'STABLE_CONTACT'
            : 'UNSTABLE_CONTACT';
        }
      } else {
        this.contactState = 'ACQUIRING_CONTACT';
      }
    } else {
      this.fingerConfidenceCount = Math.max(0, this.fingerConfidenceCount - 0.3);
      this.fingerLostCount++;
      this.stableContactCount = Math.max(0, this.stableContactCount - 0.2);

      if (this.fingerDetected) {
        const softHold =
          this.smoothedCoverage > 0.10 &&
          (this.smoothedRed - (this.smoothedGreen + this.smoothedBlue) / 2) > 5 &&
          this.smoothedFingerScore > 0.12 &&
          (this.smoothedRed / Math.max(1, this.smoothedGreen)) > 1.03;

        if (softHold || this.fingerLostCount < this.FINGER_LOST) {
          this.contactState = 'UNSTABLE_CONTACT';
        } else if (this.fingerLostCount < this.UNSTABLE_GRACE) {
          this.contactState = 'UNSTABLE_CONTACT';
        } else {
          this.contactState = 'NO_CONTACT';
          this.fingerDetected = false;
          this.stableContactCount = 0;
          this.resetSignalBuffers();
          this.resetBaselines();
        }
      } else {
        this.contactState = 'NO_CONTACT';
      }
    }

    // Map extended state → standard ContactState for export
    switch (this.contactState) {
      case 'NO_CONTACT':
        // We are inside updateContactState only when liveness already passed,
        // so a "no_contact" here actually means "optical contact present but
        // no perfusion-based finger lock yet" → forensic LOW_PERFUSION state.
        this.exportedContactState = 'OPTICAL_CONTACT_LOW_PERFUSION';
        break;
      case 'ACQUIRING_CONTACT':
      case 'UNSTABLE_CONTACT':
      case 'SATURATED_CONTACT':
      case 'EXCESSIVE_PRESSURE':
        this.exportedContactState = 'OPTICAL_CONTACT_LOW_PERFUSION';
        break;
      case 'STABLE_CONTACT':
        this.exportedContactState = 'OPTICAL_CONTACT_GOOD_PERFUSION';
        break;
    }

    // Reset buffers on transition from NO_CONTACT
    if (prev === 'NO_CONTACT' && this.contactState !== 'NO_CONTACT') {
      this.resetSignalBuffers();
    }

    // Position lock logic
    this.updatePositionLock(roi);
  }

  private detectFingerInstant(roi: ROIMaskResult): boolean {
    // Smooth inputs
    if (this.smoothedRed === 0) {
      this.smoothedRed = roi.rawRed;
      this.smoothedGreen = roi.rawGreen;
      this.smoothedBlue = roi.rawBlue;
      this.smoothedCoverage = roi.coverageRatio;
      this.smoothedFingerScore = roi.fingerScore;
    } else {
      const a = this.RGB_ALPHA;
      const ca = this.COV_ALPHA;
      this.smoothedRed += (roi.rawRed - this.smoothedRed) * a;
      this.smoothedGreen += (roi.rawGreen - this.smoothedGreen) * a;
      this.smoothedBlue += (roi.rawBlue - this.smoothedBlue) * a;
      this.smoothedCoverage += (roi.coverageRatio - this.smoothedCoverage) * ca;
      this.smoothedFingerScore += (roi.fingerScore - this.smoothedFingerScore) * ca;
    }

    const r = this.smoothedRed;
    const g = this.smoothedGreen;
    const b = this.smoothedBlue;
    const redDominance = r - (g + b) / 2;
    const rgRatio = r / Math.max(1, g);
    const totalI = r + g + b;
    const notBlownOut = !(r > 253 && g > 252 && b > 252);
    // V3: hemoglobin-specific absorption ratio R/(G+B) — higher = more red blood
    const absorption = (g + b) > 1 ? r / (g + b) : 0;
    // V3: require temporally-stable mask (no frame-to-frame ROI flipping)
    const maskStable = roi.maskStability > 0.65;

    if (this.fingerDetected) {
      // MAINTAIN — moderately strict; tolerate brief mask churn
      return r > 55 && rgRatio > 1.10 && redDominance > 12 &&
        absorption > 0.62 &&
        this.smoothedCoverage > 0.15 && this.smoothedFingerScore > 0.18 &&
        notBlownOut;
    } else {
      // V3 ACQUIRE — strict, hemoglobin signature + spatial + temporal stability
      return r > 95 && rgRatio > 1.28 && redDominance > 28 &&
        absorption > 0.78 &&
        totalI > 160 && totalI < 700 &&
        this.smoothedCoverage > 0.42 && this.smoothedFingerScore > 0.42 &&
        roi.spatialUniformity > 0.42 &&
        roi.centerCoverage > 0.30 &&
        roi.clipHighRatio < 0.25 &&
        this.motionScore < 1.0 &&
        maskStable &&
        notBlownOut;
    }
  }

  private updatePositionLock(roi: ROIMaskResult): void {
    const currentRed = roi.rawRed;
    const currentGreen = roi.rawGreen;

    this.positionQualityScore = roi.coverageRatio * 0.35 + roi.spatialUniformity * 0.35 + roi.centerCoverage * 0.3;

    if (this.positionLocked) {
      const redDrift = this.lockedRedBase > 0 ? Math.abs(currentRed - this.lockedRedBase) / this.lockedRedBase : 0;
      const greenDrift = this.lockedGreenBase > 0 ? Math.abs(currentGreen - this.lockedGreenBase) / this.lockedGreenBase : 0;
      const covDrift = this.lockedCoverage > 0 ? Math.abs(roi.coverageRatio - this.lockedCoverage) / this.lockedCoverage : 0;
      this.positionDrift = (redDrift + greenDrift + covDrift) / 3;

      if (this.positionDrift > this.POS_DRIFT_TOL) {
        this.positionDrifting = true;
        this.positionGuidance = '⚠️ DEDO MOVIDO — VUELVA A LA POSICIÓN';
        if (this.positionDrift > this.POS_DRIFT_TOL * 2.5) {
          this.positionLocked = false;
          this.positionStabilityCount = 0;
          this.positionDrifting = false;
          this.positionGuidance = 'REPOSICIONE EL DEDO';
        }
      } else {
        this.positionDrifting = false;
        const adapt = 0.003;
        this.lockedRedBase += (currentRed - this.lockedRedBase) * adapt;
        this.lockedGreenBase += (currentGreen - this.lockedGreenBase) * adapt;
        this.lockedCoverage += (roi.coverageRatio - this.lockedCoverage) * adapt;
        this.positionGuidance = 'POSICIÓN CORRECTA — NO MUEVA EL DEDO';
      }
    } else if (this.fingerDetected) {
      this.positionDrifting = false;
      if (this.positionQualityScore > 0.60 && roi.coverageRatio > 0.45 &&
        roi.spatialUniformity > 0.45 && roi.centerCoverage > 0.30 &&
        this.pressureState !== 'HIGH_PRESSURE') {
        this.positionStabilityCount++;
        if (this.positionStabilityCount >= this.POS_LOCK_FRAMES) {
          this.positionLocked = true;
          this.lockedRedBase = currentRed;
          this.lockedGreenBase = currentGreen;
          this.lockedCoverage = roi.coverageRatio;
          this.positionGuidance = 'POSICIÓN BLOQUEADA — MANTENGA ASÍ';
        } else {
          this.positionGuidance = `ESTABILIZANDO... ${Math.round((this.positionStabilityCount / this.POS_LOCK_FRAMES) * 100)}%`;
        }
      } else {
        this.positionStabilityCount = Math.max(0, this.positionStabilityCount - 3);
        if (this.pressureState === 'HIGH_PRESSURE') {
          this.positionGuidance = 'REDUZCA LA PRESIÓN DEL DEDO';
        } else if (roi.coverageRatio < 0.40) {
          this.positionGuidance = 'CUBRA TODA LA CÁMARA CON SU DEDO';
        } else if (roi.spatialUniformity < 0.40) {
          this.positionGuidance = 'CENTRE EL DEDO SOBRE LA CÁMARA';
        } else {
          this.positionGuidance = 'PRESIONE SUAVEMENTE — FIRME Y SIN MOVER';
        }
      }
    } else {
      this.positionStabilityCount = 0;
      this.positionDrifting = false;
      this.positionGuidance = 'COLOQUE SU DEDO SOBRE LA CÁMARA Y EL FLASH';
    }
  }

  // ══════════════════════════════════════════════════════
  //  SIGNAL PROCESSING
  // ══════════════════════════════════════════════════════

  private updateSampleRate(timestamp: number): void {
    if (this.lastFrameTime === 0) {
      this.lastFrameTime = timestamp;
      return;
    }
    const delta = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    if (delta < 8 || delta > 120) return;

    this.frameTimeBuf.push(delta);
    if (this.frameTimeBuf.length < 10) return;

    // Median of last 30 intervals
    const n = Math.min(30, this.frameTimeBuf.length);
    const arr = this.frameTimeBuf.last(n);
    arr.sort();
    const median = arr[Math.floor(n / 2)];
    const fps = Math.max(15, Math.min(60, 1000 / median));
    this.realFps = fps;

    if (Math.abs(fps - this.estimatedSampleRate) > 2) {
      this.estimatedSampleRate = fps;
      this.bandpassFilter.setSampleRate(fps);
    }
  }

  private updateBaselines(r: number, g: number, b: number, motion: boolean): void {
    if (this.redBaseline === 0) {
      this.redBaseline = r; this.greenBaseline = g; this.blueBaseline = b;
      return;
    }
    const alpha = motion ? 0.008 : this.exportedContactState === 'OPTICAL_CONTACT_GOOD_PERFUSION' ? 0.02 : 0.04;
    this.redBaseline += (r - this.redBaseline) * alpha;
    this.greenBaseline += (g - this.greenBaseline) * alpha;
    this.blueBaseline += (b - this.blueBaseline) * alpha;
  }

  private getBaselineDrift(): number {
    // V4: True drift = |mean(recent 30) − mean(older 30)| / baseline.
    // The previous "olderMean = mean(60) − mean(30)" was algebraically wrong
    // (mean of 60 minus mean of 30 ≠ mean of older 30 unless windows are same size).
    if (this.redBuf.length < 60) return 0;
    const recentMean = this.redBuf.mean(30);
    // Older 30 = first half of last 60 samples
    const totalLen = this.redBuf.length;
    let olderSum = 0;
    const olderStart = totalLen - 60;
    for (let i = 0; i < 30; i++) olderSum += this.redBuf.get(olderStart + i);
    const olderMean = olderSum / 30;
    return Math.abs(recentMean - olderMean) / (this.redBaseline + 1);
  }

  private calculateACDC(): void {
    const n = Math.min(180, this.redBuf.length);
    if (n < 36) return;

    this.redDC = this.redBuf.mean(n);
    this.greenDC = this.greenBuf.mean(n);
    this.blueDC = this.blueBuf.mean(n);

    if (this.redDC < 5 || this.greenDC < 5) return;

    const computeAC = (buf: RingBuffer, dc: number): number => {
      const p5 = buf.percentile(0.05, n);
      const p95 = buf.percentile(0.95, n);
      const p2p = p95 - p5;
      const v = buf.variance(n);
      const rms = Math.sqrt(v) * Math.sqrt(2);
      return (rms + p2p * 0.5) / 2;
    };

    this.redAC = computeAC(this.redBuf, this.redDC);
    this.greenAC = computeAC(this.greenBuf, this.greenDC);
    this.blueAC = computeAC(this.blueBuf, this.blueDC);

    // Reject if no real pulsatility
    if ((this.redAC / this.redDC) < 0.0001 && (this.greenAC / this.greenDC) < 0.0001) {
      this.redAC = 0; this.greenAC = 0;
    }
  }

  private calculatePerfusionIndex(): number {
    if (this.greenDC > 0) return (this.greenAC / this.greenDC) * 100;
    if (this.redDC > 0) return (this.redAC / this.redDC) * 100;
    return 0;
  }

  private getSignalRange(): number {
    if (this.filteredBuf.length < 30) return 0;
    const mm = this.filteredBuf.minMax(90);
    return mm.max - mm.min;
  }

  private estimatePeriodicityFromFiltered(): number {
    if (this.filteredBuf.length < 60) return 0;
    const n = Math.min(120, this.filteredBuf.length);
    // V4: parabolic-refined autocorrelation peak in physiological cardiac range.
    // Detects local maxima then refines via 3-point parabolic vertex; this is the
    // same trick used in the source ranker → consistent SQI semantics.
    let bestAc = 0;
    let prevAc = 0, prevPrevAc = 0;
    let pPrev = 0, pCurr = 0, pNext = 0;
    let bestLag = 0;
    for (let lag = 8; lag <= 60; lag++) {
      const ac = this.filteredBuf.autocorrelation(lag, n);
      if (lag >= 10 && prevAc > prevPrevAc && prevAc > ac) {
        if (prevAc > bestAc) {
          bestAc = prevAc;
          bestLag = lag - 1;
          pPrev = prevPrevAc; pCurr = prevAc; pNext = ac;
        }
      }
      prevPrevAc = prevAc;
      prevAc = ac;
    }
    if (bestLag > 0) {
      const denom = pPrev - 2 * pCurr + pNext;
      if (Math.abs(denom) > 1e-6) {
        const offset = 0.5 * (pPrev - pNext) / denom;
        if (Math.abs(offset) < 1) {
          bestAc = pCurr - 0.25 * (pPrev - pNext) * offset;
        }
      }
    }
    return Math.max(0, Math.min(1, bestAc));
  }

  // ══════════════════════════════════════════════════════
  //  RESET
  // ══════════════════════════════════════════════════════

  private resetBaselines(): void {
    this.redBaseline = 0; this.greenBaseline = 0; this.blueBaseline = 0;
  }

  private resetSignalBuffers(): void {
    this.redBuf.clear(); this.greenBuf.clear(); this.blueBuf.clear();
    this.rawSignalBuf.clear(); this.filteredBuf.clear();
    this.vpgBuf.clear(); this.apgBuf.clear();
    this.redDC = 0; this.redAC = 0;
    this.greenDC = 0; this.greenAC = 0;
    this.blueDC = 0; this.blueAC = 0;
    this.sourceRanker.reset();
    this.bandpassFilter.reset();
    // Forensic: limpiar buffers temporales y estado de publicación.
    this.timedSamples.length = 0;
    this.piWindow.length = 0;
    this.piWindowTimes.length = 0;
    this.odDcMovingAvg = 0;
    this.publicationGate = false;
    this.lastOpticalEvidence = null;
  }

  reset(): void {
    this.resetSignalBuffers();
    this.frameTimeBuf.clear();
    this.roiMask.reset();
    this.pressureEstimator.reset();
    this.frameCount = 0;
    this.lastLogTime = 0;
    this.lastFrameTime = 0;
    this.estimatedSampleRate = 30;
    this.realFps = 0;
    this.fingerDetected = false;
    this.contactState = 'NO_CONTACT';
    this.exportedContactState = 'NO_CONTACT';
    this.signalQuality = 0;
    this.fingerConfidenceCount = 0;
    this.fingerLostCount = 0;
    this.stableContactCount = 0;
    this.smoothedRed = 0; this.smoothedGreen = 0; this.smoothedBlue = 0;
    this.smoothedCoverage = 0; this.smoothedFingerScore = 0;
    this.motionScore = 0;
    this.lastAccel = { x: 0, y: 0, z: 0 };
    this.activeSourceLabel = 'RG';
    this.allSourceSQI = {};
    this.sourceStableFrames = 0;
    this.sourceStability = 0;
    this.pressureState = 'LOW_PRESSURE';
    this.pressurePenalty = 1.0;
    this.clipHighRatio = 0; this.clipLowRatio = 0;
    this.resetBaselines();
    this.bandpassFilter.setSampleRate(this.estimatedSampleRate);
    // Position lock
    this.positionLocked = false;
    this.lockedRedBase = 0; this.lockedGreenBase = 0; this.lockedCoverage = 0;
    this.positionStabilityCount = 0;
    this.spatialUniformity = 0; this.centerCoverage = 0;
    this.positionDrift = 0; this.positionDrifting = false;
    this.positionQualityScore = 0;
    this.positionGuidance = 'COLOQUE SU DEDO';
  }

  // ══════════════════════════════════════════════════════
  //  MOTION LISTENER
  // ══════════════════════════════════════════════════════

  private handleMotionEvent = (event: DeviceMotionEvent) => {
    // Prefer linear acceleration (gravity removed) when available; fall back to
    // accelerationIncludingGravity with a discrete-difference high-pass to cancel gravity.
    const lin = event.acceleration;
    let accelMag = 0;
    if (lin && lin.x !== null && lin.y !== null && lin.z !== null) {
      const ax = lin.x ?? 0, ay = lin.y ?? 0, az = lin.z ?? 0;
      accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
    } else {
      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.y === null || acc.z === null) return;
      const dx = (acc.x ?? 0) - this.lastAccel.x;
      const dy = (acc.y ?? 0) - this.lastAccel.y;
      const dz = (acc.z ?? 0) - this.lastAccel.z;
      this.lastAccel = { x: acc.x ?? 0, y: acc.y ?? 0, z: acc.z ?? 0 };
      // Δa per event ≈ jerk × dt; magnitudes ~0.05 quiet, >0.6 hand tremor, >2 strong shake
      accelMag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const rot = event.rotationRate;
    let gyroMag = 0;
    if (rot && (rot.alpha !== null || rot.beta !== null || rot.gamma !== null)) {
      // deg/s normalised by 120 → ~unit at brisk wrist rotation
      gyroMag = Math.sqrt((rot.alpha ?? 0) ** 2 + (rot.beta ?? 0) ** 2 + (rot.gamma ?? 0) ** 2) / 120;
    }

    // Composite motion: weighted RMS of accel + gyro, EWMA-smoothed.
    // α=0.18 → ~5-event time constant (≈250 ms at 20 Hz devicemotion).
    const instant = accelMag * 0.6 + gyroMag * 0.4;
    this.motionScore = this.motionScore * 0.82 + instant * 0.18;
    this.motionEventCount++;
  };

  private startMotionListener(): void {
    if (this.motionListenerActive) return;
    try {
      if (typeof DeviceMotionEvent !== 'undefined') {
        if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
          (DeviceMotionEvent as any).requestPermission()
            .then((state: string) => {
              if (state === 'granted') {
                window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
                this.motionListenerActive = true;
              }
            }).catch(() => {});
        } else {
          window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
          this.motionListenerActive = true;
        }
      }
    } catch {}
  }

  private stopMotionListener(): void {
    if (!this.motionListenerActive) return;
    window.removeEventListener('devicemotion', this.handleMotionEvent);
    this.motionListenerActive = false;
    this.motionScore = 0;
    this.motionEventCount = 0;
  }

  // ══════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════

  getRGBStats() {
    return {
      redAC: this.redAC, redDC: this.redDC,
      greenAC: this.greenAC, greenDC: this.greenDC,
      rgRatio: this.greenDC > 0 ? this.redDC / this.greenDC : 0,
      ratioOfRatios: this.greenDC > 0 && this.greenAC > 0 && this.redDC > 0
        ? (this.redAC / this.redDC) / (this.greenAC / this.greenDC) : 0,
    };
  }

  getPositionQuality() {
    return {
      locked: this.positionLocked,
      drifting: this.positionDrifting,
      spatialUniformity: this.spatialUniformity,
      centerCoverage: this.centerCoverage,
      positionDrift: this.positionDrift,
      guidance: this.positionGuidance,
      qualityScore: this.positionQualityScore,
    };
  }

  /** IMU-derived motion telemetry for upstream gating */
  getMotionInfo() {
    return {
      motionScore: this.motionScore,
      motionArtifact: this.motionScore > this.MOTION_THRESH,
      motionHigh: this.motionScore > this.MOTION_HIGH_THRESH,
      motionGated: this.motionScore > this.MOTION_GATE_THRESH,
      imuActive: this.motionListenerActive && this.motionEventCount > 5,
      eventCount: this.motionEventCount,
    };
  }

  /** Debug telemetry — call from UI debug panel */
  getDebugInfo() {
    return {
      contactState: this.contactState,
      exportedState: this.exportedContactState,
      pressureState: this.pressureState,
      pressurePenalty: this.pressurePenalty,
      activeSource: this.activeSourceLabel,
      allSourceSQI: this.allSourceSQI,
      realFps: this.realFps,
      processingTimeMs: this.processingTimeMs,
      sqiGlobal: this.signalQuality,
      clipHighRatio: this.clipHighRatio,
      clipLowRatio: this.clipLowRatio,
      perfusionIndex: this.calculatePerfusionIndex(),
      coverageRatio: this.smoothedCoverage,
      positionDrift: this.positionDrift,
      positionLocked: this.positionLocked,
      spatialUniformity: this.spatialUniformity,
      sourceStability: this.sourceStability,
      motionScore: this.motionScore,
      validROIPixels: this.lastROIResult?.validPixelCount ?? 0,
      guidance: this.positionGuidance,
    };
  }
}
