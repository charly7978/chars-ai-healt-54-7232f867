/**
 * PPG core — stable contracts and immutable configuration.
 *
 * Strict types only. No `any`, no synthetic generators.
 */

export const PPG_CONFIG = {
  FPS_TARGET: 30,
  DOWNSAMPLE: { width: 160, height: 120 },
  ROI_GRID: { cols: 10, rows: 8 },
  BANDPASS: { lowHz: 0.5, highHz: 4.0 },
  RING_SECONDS: 12,
  STATE_THROTTLE_HZ: 8,
} as const;

export type PpgCaptureState =
  | "idle"
  | "starting"
  | "running"
  | "degraded"
  | "error";

export interface CameraDiagnostics {
  readonly torch: boolean;
  readonly focusManual: boolean;
  readonly exposureManual: boolean;
  readonly whiteBalanceManual: boolean;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly degraded: boolean;
  readonly notes: readonly string[];
}

export interface FrameSample {
  readonly timestamp: number;
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly droppedFrames: number;
  readonly fpsInstant: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly perfusion: number;
  readonly fingerDetected: boolean;
  readonly roiWeights: Float32Array;
}

export interface PpgSignalSnapshot {
  readonly filtered: Float32Array;
  readonly sqi: number;
  readonly perfusionIndex: number;
  readonly skewness: number;
  readonly kurtosis: number;
  readonly fpsActual: number;
}

export interface SafeMediaTrackCapabilities {
  readonly torch: boolean;
  readonly focusModes: readonly string[];
  readonly exposureModes: readonly string[];
  readonly whiteBalanceModes: readonly string[];
  readonly widthMax: number;
  readonly heightMax: number;
  readonly frameRateMax: number;
  readonly iso?: { min: number; max: number };
  readonly exposureCompensation?: { min: number; max: number };
}

export interface SafeMediaTrackSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly facingMode?: string;
  readonly deviceId?: string;
}

export type CameraStartResult = {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly state: PpgCaptureState;
  readonly diagnostics: CameraDiagnostics;
  readonly capabilities: SafeMediaTrackCapabilities;
  readonly settings: SafeMediaTrackSettings;
};
