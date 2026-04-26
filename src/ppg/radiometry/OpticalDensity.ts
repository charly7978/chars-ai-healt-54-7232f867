/**
 * OPTICAL DENSITY
 * 
 * Calculates optical density (absorbance) from linear RGB values.
 * 
 * OD = -ln((I + eps) / (I0 + eps))
 * 
 * Where:
 * - I is the measured linear intensity
 * - I0 is the baseline (DC) intensity
 * - eps is a small epsilon to avoid division by zero
 * 
 * The baseline should be a slow-moving EWMA or median (2-4 seconds),
 * never a constant fake value.
 */

export interface OpticalDensityResult {
  odR: number;
  odG: number;
  odB: number;
}

export interface BaselineState {
  dcR: number;
  dcG: number;
  dcB: number;
}

const EPSILON = 1e-6;
const EWMA_ALPHA = 0.02; // ~5s time constant at 30fps

/**
 * Calculate optical density for a single channel
 */
export function calculateOD(intensity: number, baseline: number): number {
  const safeBaseline = Math.max(baseline, EPSILON);
  const safeIntensity = Math.max(intensity, EPSILON);
  return -Math.log((safeIntensity + EPSILON) / (safeBaseline + EPSILON));
}

/**
 * Calculate optical density for RGB triplet
 */
export function calculateODRGB(
  linearR: number,
  linearG: number,
  linearB: number,
  baseline: BaselineState
): OpticalDensityResult {
  return {
    odR: calculateOD(linearR, baseline.dcR),
    odG: calculateOD(linearG, baseline.dcG),
    odB: calculateOD(linearB, baseline.dcB),
  };
}

/**
 * Update baseline using EWMA (exponentially weighted moving average)
 * This provides a slow-moving DC reference for OD calculation
 */
export function updateBaselineEWMA(
  current: { r: number; g: number; b: number },
  previous: BaselineState
): BaselineState {
  return {
    dcR: previous.dcR <= 0 ? current.r : previous.dcR + (current.r - previous.dcR) * EWMA_ALPHA,
    dcG: previous.dcG <= 0 ? current.g : previous.dcG + (current.g - previous.dcG) * EWMA_ALPHA,
    dcB: previous.dcB <= 0 ? current.b : previous.dcB + (current.b - previous.dcB) * EWMA_ALPHA,
  };
}

/**
 * OpticalDensityCalculator - maintains baseline state
 */
export class OpticalDensityCalculator {
  private baseline: BaselineState = { dcR: 0, dcG: 0, dcB: 0 };
  private initialized = false;

  /**
   * Calculate OD for new RGB values and update baseline
   */
  calculate(linearR: number, linearG: number, linearB: number): OpticalDensityResult {
    // Initialize baseline on first call
    if (!this.initialized) {
      this.baseline = { dcR: linearR, dcG: linearG, dcB: linearB };
      this.initialized = true;
    }

    // Update baseline with EWMA
    this.baseline = updateBaselineEWMA(
      { r: linearR, g: linearG, b: linearB },
      this.baseline
    );

    // Calculate OD
    return calculateODRGB(linearR, linearG, linearB, this.baseline);
  }

  /**
   * Get current baseline
   */
  getBaseline(): BaselineState {
    return { ...this.baseline };
  }

  /**
   * Reset baseline state
   */
  reset(): void {
    this.baseline = { dcR: 0, dcG: 0, dcB: 0 };
    this.initialized = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
