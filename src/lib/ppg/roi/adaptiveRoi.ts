import { PPG_CONFIG } from "../types";

/**
 * Adaptive Region-of-Interest selector.
 *
 * The frame is split into a fixed grid of tiles. Each tile is scored using
 * chromatic asymmetry (red dominance), with explicit penalties for clipped
 * highlights (R > 252) and absolute darkness (luma < 20).
 *
 * Tile weights are smoothed with an exponential moving average so the ROI
 * does not jump frame-to-frame; sudden ROI shifts inject low-frequency noise
 * that contaminates the cardiac band.
 */

export interface RoiResult {
  readonly weights: Float32Array;
  readonly weightedR: number;
  readonly weightedG: number;
  readonly weightedB: number;
  readonly perfusion: number;
}

const EMA_ALPHA = 0.2;
const SAT_HIGH = 252;
const DARK_LUMA = 20;

export class AdaptiveRoi {
  cols: number;
  rows: number;
  private weights: Float32Array;
  private tileR: Float32Array;
  private tileG: Float32Array;
  private tileB: Float32Array;
  private tileScore: Float32Array;
  private tileBaseline: Float32Array;
  private initialized = false;

  constructor(
    cols: number = PPG_CONFIG.ROI_GRID.cols,
    rows: number = PPG_CONFIG.ROI_GRID.rows,
  ) {
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.weights = new Float32Array(n);
    this.tileR = new Float32Array(n);
    this.tileG = new Float32Array(n);
    this.tileB = new Float32Array(n);
    this.tileScore = new Float32Array(n);
    this.tileBaseline = new Float32Array(n);
  }

  /**
   * Re-shape the tile grid at runtime. Reallocates internal buffers and
   * resets the EMA baseline so the new geometry is not biased by stale
   * scores from a different grid.
   */
  setGrid(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.weights = new Float32Array(n);
    this.tileR = new Float32Array(n);
    this.tileG = new Float32Array(n);
    this.tileB = new Float32Array(n);
    this.tileScore = new Float32Array(n);
    this.tileBaseline = new Float32Array(n);
    this.initialized = false;
  }

  process(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): RoiResult {
    const cols = this.cols;
    const rows = this.rows;
    const tileW = (width / cols) | 0;
    const tileH = (height / rows) | 0;
    const stride = width * 4;

    // Reset accumulators.
    this.tileR.fill(0);
    this.tileG.fill(0);
    this.tileB.fill(0);
    this.tileScore.fill(0);

    for (let ty = 0; ty < rows; ty++) {
      const yStart = ty * tileH;
      const yEnd = ty === rows - 1 ? height : yStart + tileH;
      for (let tx = 0; tx < cols; tx++) {
        const xStart = tx * tileW;
        const xEnd = tx === cols - 1 ? width : xStart + tileW;
        const tileIndex = ty * cols + tx;

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let valid = 0;
        let clip = 0;
        let dark = 0;
        let total = 0;

        for (let y = yStart; y < yEnd; y++) {
          let p = y * stride + xStart * 4;
          for (let x = xStart; x < xEnd; x++) {
            const r = rgba[p];
            const g = rgba[p + 1];
            const b = rgba[p + 2];
            const luma = (r * 299 + g * 587 + b * 114) * 0.001;
            total++;
            if (r >= SAT_HIGH && g >= SAT_HIGH && b >= SAT_HIGH) {
              clip++;
            } else if (luma <= DARK_LUMA) {
              dark++;
            } else {
              valid++;
              sumR += r;
              sumG += g;
              sumB += b;
            }
            p += 4;
          }
        }

        const meanR = valid > 0 ? sumR / valid : 0;
        const meanG = valid > 0 ? sumG / valid : 0;
        const meanB = valid > 0 ? sumB / valid : 0;
        const dominance = meanR - (meanG + meanB) * 0.5;
        const clipPenalty = total > 0 ? clip / total : 1;
        const darkPenalty = total > 0 ? dark / total : 1;
        const coverage = total > 0 ? valid / total : 0;

        const score = Math.max(
          0,
          dominance * coverage - clipPenalty * 80 - darkPenalty * 40,
        );

        this.tileR[tileIndex] = meanR;
        this.tileG[tileIndex] = meanG;
        this.tileB[tileIndex] = meanB;
        this.tileScore[tileIndex] = score;
      }
    }

    // EMA smoothing of tile baselines (controls jitter in spatial weight map).
    if (!this.initialized) {
      for (let i = 0; i < this.tileScore.length; i++) {
        this.tileBaseline[i] = this.tileScore[i];
      }
      this.initialized = true;
    } else {
      for (let i = 0; i < this.tileScore.length; i++) {
        this.tileBaseline[i] =
          this.tileBaseline[i] * (1 - EMA_ALPHA) +
          this.tileScore[i] * EMA_ALPHA;
      }
    }

    // Normalize weights, then aggregate weighted RGB.
    let sumWeights = 0;
    for (let i = 0; i < this.tileBaseline.length; i++) {
      sumWeights += this.tileBaseline[i];
    }
    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    if (sumWeights > 0) {
      for (let i = 0; i < this.tileBaseline.length; i++) {
        const w = this.tileBaseline[i] / sumWeights;
        this.weights[i] = w;
        weightedR += this.tileR[i] * w;
        weightedG += this.tileG[i] * w;
        weightedB += this.tileB[i] * w;
      }
    } else {
      this.weights.fill(0);
    }

    const perfusion =
      weightedR > 0 ? (weightedR - (weightedG + weightedB) * 0.5) / weightedR : 0;

    return {
      weights: this.weights,
      weightedR,
      weightedG,
      weightedB,
      perfusion,
    };
  }

  reset(): void {
    this.initialized = false;
    this.weights.fill(0);
    this.tileBaseline.fill(0);
  }
}
