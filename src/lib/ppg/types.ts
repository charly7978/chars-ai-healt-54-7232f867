/**
 * PPG Pipeline — Tipos y configuración global
 * Contratos estrictos para todo el pipeline fotopletismográfico.
 */

export type PpgCaptureState =
  | "idle"
  | "requesting-camera"
  | "camera-ready"
  | "torch-ready"
  | "finger-missing"
  | "stabilizing"
  | "signal-locking"
  | "signal-locked"
  | "quality-low"
  | "error";

export type ExposureHint =
  | "ok"
  | "too-dark"
  | "too-bright"
  | "over-saturated"
  | "finger-not-covering"
  | "too-much-pressure"
  | "motion-or-contact-unstable";

export type RgbMean = {
  r: number;
  g: number;
  b: number;
  y: number;
};

export type FrameSample = {
  t: number;
  mediaTime?: number;
  width: number;
  height: number;
  rgb: RgbMean;
  roiRgb: RgbMean;
  validPixelRatio: number;
  clippedPixelRatio: number;
  darkPixelRatio: number;
  fingerScore: number;
  roiScore: number;
};

export type PpgSignalSnapshot = {
  state: PpgCaptureState;
  elapsedSec: number;
  effectiveFps: number;
  fpsJitterMs: number;
  droppedFrameRatio: number;
  fingerScore: number;
  sqi: number;
  selectedChannel: "r" | "g" | "b" | "rgb-fused";
  raw: { r: number; g: number; b: number };
  normalized: { r: number; g: number; b: number };
  filtered: number;
  perfusionIndex: number;
  pulseBandSnr: number;
  clipping: number;
  exposureHint: ExposureHint;
};

export const PPG_CONFIG = {
  TARGET_FPS: 30,
  DOWNSAMPLE_WIDTH: 160,
  DOWNSAMPLE_HEIGHT: 120,
  ROI_GRID_COLS: 10,
  ROI_GRID_ROWS: 8,
  BUFFER_SECONDS: 12,
  FILTER_LOW_HZ: 0.5,
  FILTER_HIGH_HZ: 4.0,
} as const;
