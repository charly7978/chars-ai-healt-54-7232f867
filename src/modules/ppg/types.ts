/**
 * RealPPG types — single source of truth for the new pipeline.
 * All numbers are SI / dimensionless. No defaults, no fallbacks.
 */

export interface FrameStats {
  /** Mean of sRGB-decoded LINEAR red channel in ROI, range [0,1]. */
  redLinear: number;
  greenLinear: number;
  blueLinear: number;
  /** Mean of raw 0..255 sRGB channels (for diagnostics only). */
  redMean: number;
  greenMean: number;
  blueMean: number;
  /** Optical density vs adaptive white reference: -log10((I+e)/(W+e)). */
  redOD: number;
  greenOD: number;
  blueOD: number;
  /** Pixel hygiene. */
  clipHighRatio: number;  // fraction of pixels with any channel >= 250
  clipLowRatio: number;   // fraction of pixels with all channels <= 5
  saturationRatio: number; // generic high-saturation indicator
  /** Spatial uniformity of green channel within ROI (0..1, higher = more uniform). */
  spatialUniformity: number;
  /** Frame-to-frame motion proxy on green mean (abs delta in linear units). */
  motionProxy: number;
  /** ROI selected for this frame. */
  roi: { x: number; y: number; w: number; h: number; pixels: number };
  /** Real frame timestamp (performance.now()-domain ms). */
  tMs: number;
}

export interface OpticalGateResult {
  opticalContact: boolean;
  tissueCandidate: boolean;
  perfusionCandidate: boolean;
  reason: string;
  /** [0..1] aggregate optical evidence score. */
  score: number;
  metrics: {
    redDC: number;
    rgRatio: number;
    rbRatio: number;
    perfusionIndexRed: number;
    perfusionIndexGreen: number;
    clipHighRatio: number;
    clipLowRatio: number;
    spatialUniformity: number;
    motionProxy: number;
    framesContact: number;
  };
}

export interface ExtractedPPG {
  rawSelected: number;       // raw selected source value before bandpass
  filteredValue: number;     // bandpassed value (cardiac band)
  selectedSource: 'GREEN_OD' | 'RED_OD' | 'CHROM' | 'NONE';
  acdc: { red: number; green: number; blue: number };
  perfusionIndex: { red: number; green: number; blue: number };
  sampleRate: number;
  sourceQuality: number;     // [0..1]
}

export interface CardiacEvidence {
  cardiacEvidence: boolean;
  spectralSQI: number;        // [0..1]
  peakSQI: number;            // [0..1]
  channelCoherence: number;   // [0..1]
  dominantHz: number;
  bpmCandidate: number | null;
  reason: string;
}

export interface Beat {
  tMs: number;
  amplitude: number;
  rrMs: number;          // RR with previous accepted beat (0 for first)
  beatSQI: number;       // [0..1]
}

export interface BeatDetectorState {
  acceptedBeat: boolean;     // true on the frame where a new beat is confirmed
  lastBeat: Beat | null;
  beats: Beat[];
  bpmInstant: number | null;     // 60000 / lastRR
  bpmMedian: number | null;      // median over recent beats
  rejectReason: string;
}

export interface PublicationDecision {
  canPublish: boolean;
  reason: string;
  bpm: number | null;
  waveform: number[]; // bandpassed PPG (latest N samples) — empty when canPublish=false
  beats: Beat[];
}

export interface RealPPGSnapshot {
  frame: FrameStats | null;
  optical: OpticalGateResult;
  extracted: ExtractedPPG;
  cardiac: CardiacEvidence;
  beat: BeatDetectorState;
  publication: PublicationDecision;
  /** Real fps measured from frame timestamps. */
  fps: number;
  /** Frame index (monotonic). */
  frameIndex: number;
  /** Whether vibration is allowed THIS frame (acceptedBeat && canPublish). */
  vibrationAllowed: boolean;
}

/** Defensive empty snapshot — never used as a fake reading. */
export function createEmptySnapshot(): RealPPGSnapshot {
  return {
    frame: null,
    optical: {
      opticalContact: false,
      tissueCandidate: false,
      perfusionCandidate: false,
      reason: 'NO_FRAMES',
      score: 0,
      metrics: {
        redDC: 0, rgRatio: 0, rbRatio: 0,
        perfusionIndexRed: 0, perfusionIndexGreen: 0,
        clipHighRatio: 0, clipLowRatio: 0,
        spatialUniformity: 0, motionProxy: 0, framesContact: 0,
      },
    },
    extracted: {
      rawSelected: 0, filteredValue: 0, selectedSource: 'NONE',
      acdc: { red: 0, green: 0, blue: 0 },
      perfusionIndex: { red: 0, green: 0, blue: 0 },
      sampleRate: 0, sourceQuality: 0,
    },
    cardiac: {
      cardiacEvidence: false, spectralSQI: 0, peakSQI: 0,
      channelCoherence: 0, dominantHz: 0, bpmCandidate: null,
      reason: 'NO_CARDIAC_EVIDENCE',
    },
    beat: {
      acceptedBeat: false, lastBeat: null, beats: [],
      bpmInstant: null, bpmMedian: null, rejectReason: '',
    },
    publication: {
      canPublish: false, reason: 'NO_OPTICAL_CONTACT',
      bpm: null, waveform: [], beats: [],
    },
    fps: 0,
    frameIndex: 0,
    vibrationAllowed: false,
  };
}