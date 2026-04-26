/**
 * PPG TYPES
 * 
 * Core type definitions for the PPG pipeline.
 */

export type PpgState =
  | 'idle'
  | 'requesting_camera'
  | 'camera_ready'
  | 'torch_on'
  | 'measuring'
  | 'searching_signal'
  | 'ppg_candidate'
  | 'ppg_valid'
  | 'no_ppg_signal'
  | 'saturated'
  | 'dark_frame'
  | 'motion_artifact'
  | 'low_perfusion'
  | 'error';

export interface RoiBox {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface RawChannels {
  r: number;
  g: number;
  b: number;
}

export interface LinearChannels {
  r: number;
  g: number;
  b: number;
}

export interface OpticalDensityChannels {
  odR: number;
  odG: number;
  odB: number;
}

export interface GSignals {
  g1: number; // Raw green linear mean
  g2: number; // Detrended OD green
  g3: number; // Filtered OD green (ready for beat detection)
}

export interface PpgSample {
  timestamp: number;
  raw: RawChannels;
  linear: LinearChannels;
  od: OpticalDensityChannels;
  g: GSignals;
  roi: RoiBox;
  fps: number;
}

export interface PpgBuffer {
  samples: PpgSample[];
  duration: number; // milliseconds
  sampleRate: number; // Hz
}

export interface Beat {
  timestamp: number;
  index: number;
  amplitude: number;
  rrInterval: number; // ms since previous beat
}

export interface BeatDetectionResult {
  beats: Beat[];
  bpm: number;
  confidence: number;
  rrIntervals: number[];
  lastBeatTime: number | null;
}

export interface SignalQualityMetrics {
  temporal: number;
  spectral: number;
  morphology: number;
  perfusion: number;
  motion: number;
  saturation: number;
  fps: number;
  overall: number;
}

export interface PublicationGateResult {
  canPublishBpm: boolean;
  canPublishSpo2: boolean;
  canPublishWaveform: boolean;
  blockReasons: string[];
  currentStatus: PpgState;
}

export interface PpgEngineState {
  state: PpgState;
  cameraStatus: {
    active: boolean;
    videoWidth: number;
    videoHeight: number;
    fps: number;
    torchActive: boolean;
  };
  roi: RoiBox | null;
  rawChannels: RawChannels | null;
  g1: number;
  g2: number;
  g3: number;
  waveform: number[];
  beats: Beat[];
  bpm: number | null;
  spo2: number | null;
  sqi: SignalQualityMetrics | null;
  publication: PublicationGateResult | null;
  debug: {
    frameIndex: number;
    lastFrameAgeMs: number;
    bufferDuration: number;
    validSamples: number;
    noiseSamples: number;
  };
}
