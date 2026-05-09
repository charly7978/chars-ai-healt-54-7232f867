import type { ExposureHint } from "../types";
import type { FingerMetrics } from "./fingerDetector";

/**
 * Clasifica el estado de exposición / contacto en hints accionables.
 */
export function classifyExposure(
  metrics: FingerMetrics,
  perfusionIndex: number
): ExposureHint {
  if (metrics.darkPixelRatio > 0.35 || metrics.globalRgb.y < 35) return "too-dark";
  if (metrics.clippedPixelRatio > 0.20) return "over-saturated";
  if (metrics.globalRgb.y > 235) return "too-bright";
  if (metrics.fingerScore < 0.30) return "finger-not-covering";
  if (
    metrics.fingerScore > 0.80 &&
    metrics.clippedPixelRatio > 0.10 &&
    perfusionIndex < 0.005
  ) {
    return "too-much-pressure";
  }
  return "ok";
}
