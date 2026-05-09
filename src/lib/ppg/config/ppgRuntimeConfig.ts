/**
 * Runtime-tunable PPG configuration.
 *
 * Subscribers (AdaptiveRoi, fingerDetector caller, SQI worker) react when
 * values change. Values are persisted in `localStorage` so the operator's
 * tuning survives reloads. All bounds are clamped to safe ranges.
 */

import { PPG_CONFIG } from "../types";

export interface FingerThresholds {
  /** Minimum red-dominance (R - (G+B)/2) to count a pixel as tissue. */
  redDominance: number;
  /** Minimum fraction of valid pixels to declare contact. */
  coverage: number;
  /** Upper saturation threshold (per-channel) for clipping rejection. */
  saturationHigh: number;
  /** Lower luma threshold for darkness rejection. */
  darkLuma: number;
}

export interface SqiThresholds {
  /** Linear scale applied to perfusion before sigmoid clamping. */
  perfusionScale: number;
  /** Weights for the three SQI sub-terms (auto-normalized). */
  weightPerfusion: number;
  weightSkewness: number;
  weightKurtosis: number;
  /** Minimum SQI a downstream consumer should treat as usable (UI gate). */
  acceptableSqi: number;
}

export interface PpgRuntimeConfig {
  roi: { cols: number; rows: number };
  finger: FingerThresholds;
  sqi: SqiThresholds;
}

const STORAGE_KEY = "ppg.runtime.config.v1";

const DEFAULTS: PpgRuntimeConfig = {
  roi: { cols: PPG_CONFIG.ROI_GRID.cols, rows: PPG_CONFIG.ROI_GRID.rows },
  finger: {
    redDominance: 35,
    coverage: 0.55,
    saturationHigh: 252,
    darkLuma: 20,
  },
  sqi: {
    perfusionScale: 25,
    weightPerfusion: 0.55,
    weightSkewness: 0.25,
    weightKurtosis: 0.2,
    acceptableSqi: 0.4,
  },
};

const BOUNDS = {
  cols: { min: 3, max: 24 },
  rows: { min: 3, max: 24 },
  redDominance: { min: 5, max: 120 },
  coverage: { min: 0.05, max: 0.95 },
  saturationHigh: { min: 200, max: 255 },
  darkLuma: { min: 0, max: 80 },
  perfusionScale: { min: 1, max: 200 },
  weight: { min: 0, max: 1 },
  acceptableSqi: { min: 0, max: 1 },
} as const;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function sanitize(input: PpgRuntimeConfig): PpgRuntimeConfig {
  return {
    roi: {
      cols: Math.round(clamp(input.roi.cols, BOUNDS.cols.min, BOUNDS.cols.max)),
      rows: Math.round(clamp(input.roi.rows, BOUNDS.rows.min, BOUNDS.rows.max)),
    },
    finger: {
      redDominance: clamp(input.finger.redDominance, BOUNDS.redDominance.min, BOUNDS.redDominance.max),
      coverage: clamp(input.finger.coverage, BOUNDS.coverage.min, BOUNDS.coverage.max),
      saturationHigh: Math.round(clamp(input.finger.saturationHigh, BOUNDS.saturationHigh.min, BOUNDS.saturationHigh.max)),
      darkLuma: Math.round(clamp(input.finger.darkLuma, BOUNDS.darkLuma.min, BOUNDS.darkLuma.max)),
    },
    sqi: {
      perfusionScale: clamp(input.sqi.perfusionScale, BOUNDS.perfusionScale.min, BOUNDS.perfusionScale.max),
      weightPerfusion: clamp(input.sqi.weightPerfusion, BOUNDS.weight.min, BOUNDS.weight.max),
      weightSkewness: clamp(input.sqi.weightSkewness, BOUNDS.weight.min, BOUNDS.weight.max),
      weightKurtosis: clamp(input.sqi.weightKurtosis, BOUNDS.weight.min, BOUNDS.weight.max),
      acceptableSqi: clamp(input.sqi.acceptableSqi, BOUNDS.acceptableSqi.min, BOUNDS.acceptableSqi.max),
    },
  };
}

function deepMerge(base: PpgRuntimeConfig, partial: Partial<PpgRuntimeConfig>): PpgRuntimeConfig {
  return {
    roi: { ...base.roi, ...(partial.roi ?? {}) },
    finger: { ...base.finger, ...(partial.finger ?? {}) },
    sqi: { ...base.sqi, ...(partial.sqi ?? {}) },
  };
}

function load(): PpgRuntimeConfig {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PpgRuntimeConfig>;
    return sanitize(deepMerge(DEFAULTS, parsed));
  } catch {
    return DEFAULTS;
  }
}

function persist(cfg: PpgRuntimeConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota / private mode — config remains in-memory */
  }
}

type Listener = (cfg: PpgRuntimeConfig) => void;

let current: PpgRuntimeConfig = load();
const listeners = new Set<Listener>();

export function getPpgRuntimeConfig(): PpgRuntimeConfig {
  return current;
}

export function getPpgRuntimeDefaults(): PpgRuntimeConfig {
  return DEFAULTS;
}

export function setPpgRuntimeConfig(partial: Partial<PpgRuntimeConfig>): PpgRuntimeConfig {
  current = sanitize(deepMerge(current, partial));
  persist(current);
  for (const l of listeners) l(current);
  return current;
}

export function resetPpgRuntimeConfig(): PpgRuntimeConfig {
  current = DEFAULTS;
  persist(current);
  for (const l of listeners) l(current);
  return current;
}

export function subscribePpgRuntimeConfig(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
