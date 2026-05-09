import { PPG_CONFIG, type RgbMean } from "../types";

interface TileStats {
  rgb: RgbMean;
  validPixelRatio: number;
  clippedPixelRatio: number;
  darkPixelRatio: number;
  reddishRatio: number;
}

/**
 * Adaptive ROI: grid 10x8 con EMA temporal y center prior.
 * Top-30% de tiles se promedian ponderadamente.
 */
export class AdaptiveRoiSelector {
  private cols = PPG_CONFIG.ROI_GRID_COLS;
  private rows = PPG_CONFIG.ROI_GRID_ROWS;
  private tileWeights: Float32Array;
  private emaAlpha = 0.15;
  private lastValidTileCount = 0;

  constructor() {
    this.tileWeights = new Float32Array(this.cols * this.rows);
  }

  reset(): void {
    this.tileWeights.fill(0);
    this.lastValidTileCount = 0;
  }

  get validTileCount(): number { return this.lastValidTileCount; }

  computeRoi(
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): { rgb: RgbMean; roiScore: number; validRatio: number } {
    const tileW = Math.floor(width / this.cols);
    const tileH = Math.floor(height / this.rows);
    const candidates: Array<{ idx: number; score: number; rgb: RgbMean }> = [];
    let validTiles = 0;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const idx = row * this.cols + col;
        const stats = this.extractTileStats(data, width, col * tileW, row * tileH, tileW, tileH);

        if (
          stats.clippedPixelRatio > 0.25 ||
          stats.darkPixelRatio > 0.40 ||
          stats.validPixelRatio < 0.45
        ) {
          this.tileWeights[idx] *= (1 - this.emaAlpha);
          continue;
        }
        validTiles++;

        const cx = (this.cols - 1) / 2;
        const cy = (this.rows - 1) / 2;
        const dist = Math.abs(col - cx) + Math.abs(row - cy);
        const centerPrior = 1 / (1 + dist * 0.10);

        const candidate =
          0.30 * stats.validPixelRatio +
          0.30 * stats.reddishRatio +
          0.20 * (1 - stats.clippedPixelRatio) +
          0.20 * centerPrior;
        this.tileWeights[idx] = (1 - this.emaAlpha) * this.tileWeights[idx] + this.emaAlpha * candidate;
        candidates.push({ idx, score: this.tileWeights[idx], rgb: stats.rgb });
      }
    }

    this.lastValidTileCount = validTiles;

    if (candidates.length === 0) {
      return { rgb: { r: 0, g: 0, b: 0, y: 0 }, roiScore: 0, validRatio: 0 };
    }
    candidates.sort((a, b) => b.score - a.score);
    const topN = Math.max(1, Math.floor(candidates.length * 0.30));
    let rS = 0, gS = 0, bS = 0, wS = 1e-9, scoreSum = 0;
    for (let i = 0; i < topN; i++) {
      const c = candidates[i];
      const w = c.score;
      rS += c.rgb.r * w; gS += c.rgb.g * w; bS += c.rgb.b * w;
      wS += w; scoreSum += c.score;
    }
    const r = rS / wS, g = gS / wS, b = bS / wS;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    return {
      rgb: { r, g, b, y },
      roiScore: scoreSum / topN,
      validRatio: validTiles / (this.cols * this.rows),
    };
  }

  private extractTileStats(
    data: Uint8ClampedArray,
    imgWidth: number,
    sx: number,
    sy: number,
    tw: number,
    th: number
  ): TileStats {
    let rSum = 0, gSum = 0, bSum = 0;
    let valid = 0, clipped = 0, dark = 0, reddish = 0;
    let count = 0;
    const eps = 1e-4;
    for (let y = sy; y < sy + th; y++) {
      const rowOff = y * imgWidth;
      for (let x = sx; x < sx + tw; x++) {
        const i = (rowOff + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const yL = 0.299 * r + 0.587 * g + 0.114 * b;
        rSum += r; gSum += g; bSum += b; count++;
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const sum = r + g + b + eps;
        const rn = r / sum;
        if (max >= 252) clipped++;
        if (yL < 20) dark++;
        const isReddish = rn > 0.34 && r > g * 0.85 && r > b * 1.05 && (max - min) > 12;
        if (isReddish) reddish++;
        if (yL >= 25 && yL <= 250 && max < 252 && min > 2 && isReddish) valid++;
      }
    }
    const c = Math.max(1, count);
    return {
      rgb: { r: rSum / c, g: gSum / c, b: bSum / c, y: 0 },
      validPixelRatio: valid / c,
      clippedPixelRatio: clipped / c,
      darkPixelRatio: dark / c,
      reddishRatio: reddish / c,
    };
  }
}
