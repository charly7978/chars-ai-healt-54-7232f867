/**
 * ADAPTIVE ROI MASK V2
 * 
 * Per-frame adaptive mask that:
 * 1. Uses dynamic 7x7 tile grid
 * 2. Excludes saturated/clipped pixels
 * 3. Computes per-tile hemoglobin score with center bias
 * 4. Adapts thresholds using frame percentiles (no fixed absolutes)
 * 5. Temporal intersection to prevent mask deformation
 * 6. Separates coarse ROI (detection) from fine ROI (extraction)
 */

export interface TileMetrics {
  meanR: number;
  meanG: number;
  meanB: number;
  redDominance: number;
  rgRatio: number;
  intensity: number;
  clipHighPct: number;  // % pixels > 250
  clipLowPct: number;   // % pixels < 5
  validPixels: number;
  centerBias: number;
  score: number;
  temporalScore: number;
}

export interface ROIMaskResult {
  // Weighted RGB from valid tiles only
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  // Coarse vs fine ROI separation
  coarseRed: number;
  coarseGreen: number;
  coarseBlue: number;
  // Metrics
  coverageRatio: number;
  fingerScore: number;
  clipHighRatio: number;
  clipLowRatio: number;
  spatialUniformity: number;
  centerCoverage: number;
  brightness: number;
  brightnessVariance: number;
  validPixelCount: number;
  totalPixelCount: number;
  tileScores: Float64Array;
  // V3: temporal mask stability (0=violently changing, 1=identical to prev)
  maskStability: number;
  // V3: percentile-derived adaptive thresholds for transparency
  adaptiveRedFloor: number;
  adaptiveDominanceFloor: number;
}

const GRID = 9; // V3: 9x9 grid for finer adaptive ROI
const TOTAL_TILES = GRID * GRID;
const CLIP_HIGH = 248;   // tighter to exclude near-saturation
const CLIP_LOW = 8;      // exclude crushed blacks

export class AdaptiveROIMask {
  private tileConfidence: Float64Array = new Float64Array(TOTAL_TILES);
  private prevMaskValid: Uint8Array = new Uint8Array(TOTAL_TILES).fill(0);
  private frameCount = 0;

  // Reusable per-tile accumulator arrays to avoid per-frame allocation
  private tileR = new Float64Array(TOTAL_TILES);
  private tileG = new Float64Array(TOTAL_TILES);
  private tileB = new Float64Array(TOTAL_TILES);
  private tileCount = new Int32Array(TOTAL_TILES);
  private tileClipHigh = new Int32Array(TOTAL_TILES);
  private tileClipLow = new Int32Array(TOTAL_TILES);
  private tileValid = new Int32Array(TOTAL_TILES);

  // V3: temporal smoothing of per-tile means for flicker-rejected RGB
  private tileMeanR = new Float64Array(TOTAL_TILES);
  private tileMeanG = new Float64Array(TOTAL_TILES);
  private tileMeanB = new Float64Array(TOTAL_TILES);
  private tileMeanInit = false;
  private readonly TILE_TEMPORAL_ALPHA = 0.45;

  process(imageData: ImageData): ROIMaskResult {
    this.frameCount++;
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    // V3: Central ROI: 85% of min dimension (cover more finger area)
    const roiSize = Math.min(w, h) * 0.85;
    const sx = Math.floor((w - roiSize) / 2);
    const sy = Math.floor((h - roiSize) / 2);
    const ex = sx + Math.floor(roiSize);
    const ey = sy + Math.floor(roiSize);
    const roiW = ex - sx;
    const roiH = ey - sy;

    // Reset accumulators
    this.tileR.fill(0);
    this.tileG.fill(0);
    this.tileB.fill(0);
    this.tileCount.fill(0);
    this.tileClipHigh.fill(0);
    this.tileClipLow.fill(0);
    this.tileValid.fill(0);

    let totalPixels = 0;
    let totalClipHigh = 0;
    let totalClipLow = 0;

    // V3: Adaptive subsampling — denser when finger likely present
    // step=2 for ≤480p, step=3 for higher to maintain ~25k samples
    const step = roiW * roiH > 200000 ? 3 : 2;
    for (let y = sy; y < ey; y += step) {
      const rowOff = y * w;
      for (let x = sx; x < ex; x += step) {
        const i = (rowOff + x) << 2; // *4
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const tileX = Math.min(GRID - 1, ((x - sx) * GRID / roiW) | 0);
        const tileY = Math.min(GRID - 1, ((y - sy) * GRID / roiH) | 0);
        const ti = tileY * GRID + tileX;

        totalPixels++;

        // V3: stricter clipping — ANY channel near sensor limits is excluded
        const isClipHigh = r >= CLIP_HIGH || g >= CLIP_HIGH || b >= CLIP_HIGH;
        const isClipLow = (r + g + b) <= (CLIP_LOW * 3);

        if (isClipHigh) {
          this.tileClipHigh[ti]++;
          totalClipHigh++;
        }
        if (isClipLow) {
          this.tileClipLow[ti]++;
          totalClipLow++;
        }

        // Only accumulate valid (non-clipped) pixels for signal
        if (!isClipHigh && !isClipLow) {
          this.tileR[ti] += r;
          this.tileG[ti] += g;
          this.tileB[ti] += b;
          this.tileValid[ti]++;
        }
        this.tileCount[ti]++;
      }
    }

    // --- Compute per-tile metrics ---
    // First pass: collect all tile scores for percentile-based thresholding
    const tileMetrics: TileMetrics[] = new Array(TOTAL_TILES);
    const allScores: number[] = [];

    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const cnt = this.tileValid[ti];
      const total = this.tileCount[ti];
      if (cnt === 0 || total === 0) {
        tileMetrics[ti] = {
          meanR: 0, meanG: 0, meanB: 0, redDominance: 0,
          rgRatio: 0, intensity: 0, clipHighPct: 0, clipLowPct: 0,
          validPixels: 0, centerBias: 0, score: 0, temporalScore: 0
        };
        continue;
      }

      const meanR = this.tileR[ti] / cnt;
      const meanG = this.tileG[ti] / cnt;
      const meanB = this.tileB[ti] / cnt;

      // V3: temporally smoothed per-tile means → flicker rejection
      if (!this.tileMeanInit) {
        this.tileMeanR[ti] = meanR;
        this.tileMeanG[ti] = meanG;
        this.tileMeanB[ti] = meanB;
      } else {
        const a = this.TILE_TEMPORAL_ALPHA;
        this.tileMeanR[ti] = this.tileMeanR[ti] * (1 - a) + meanR * a;
        this.tileMeanG[ti] = this.tileMeanG[ti] * (1 - a) + meanG * a;
        this.tileMeanB[ti] = this.tileMeanB[ti] * (1 - a) + meanB * a;
      }
      const smR = this.tileMeanR[ti];
      const smG = this.tileMeanG[ti];
      const smB = this.tileMeanB[ti];
      const intensity = smR + smG + smB;
      const redDominance = smR - (smG + smB) / 2;
      const rgRatio = smG > 1 ? smR / smG : 0;
      const clipHighPct = this.tileClipHigh[ti] / total;
      const clipLowPct = this.tileClipLow[ti] / total;

      // V3: Logarithmic center bias (sharper falloff, finger naturally fills center)
      const gx = ti % GRID;
      const gy = (ti / GRID) | 0;
      const nx = GRID > 1 ? gx / (GRID - 1) : 0.5;
      const ny = GRID > 1 ? gy / (GRID - 1) : 0.5;
      const dist = Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2);
      const centerBias = Math.max(0.15, Math.exp(-dist * 2.4));

      // V3: Hemoglobin signature — multi-factor with R/(G+B) and absorption
      // Real finger has rgRatio ≈ 1.4–2.5, redDominance ≈ 30–80 with flash
      const redScore = Math.max(0, Math.min(1, (rgRatio - 1.05) / 0.75));
      const domScore = Math.max(0, Math.min(1, (redDominance - 8) / 45));
      // R/(G+B) is more discriminative than rgRatio alone for hemoglobin
      const rgbAbsorption = (smG + smB) > 1 ? smR / (smG + smB) : 0;
      const absorbScore = Math.max(0, Math.min(1, (rgbAbsorption - 0.55) / 0.45));
      // Brightness sweet spot: 100–600 (flash on finger)
      const brightScore = intensity < 100 ? intensity / 100
        : intensity > 600 ? Math.max(0, 1 - (intensity - 600) / 200)
        : 1;
      const clipPenalty = Math.min(1, (clipHighPct * 1.5 + clipLowPct) * 2.5);
      const validRatio = cnt / total;

      const frameScore = (
        redScore * 0.28 +
        domScore * 0.24 +
        absorbScore * 0.20 +
        brightScore * 0.12 +
        validRatio * 0.16
      ) * (1 - clipPenalty);

      // Temporal smoothing
      this.tileConfidence[ti] = this.tileConfidence[ti] * 0.72 + frameScore * centerBias * 0.28;
      const combinedScore = this.tileConfidence[ti] * 0.65 + frameScore * 0.35;

      tileMetrics[ti] = {
        meanR: smR, meanG: smG, meanB: smB, redDominance,
        rgRatio, intensity, clipHighPct, clipLowPct,
        validPixels: cnt, centerBias,
        score: combinedScore, temporalScore: this.tileConfidence[ti]
      };
      allScores.push(combinedScore);
    }
    this.tileMeanInit = true;

    // --- V3: Adaptive thresholding from FRAME percentiles (no fixed thresholds) ---
    allScores.sort((a, b) => a - b);
    const p60 = allScores.length > 0 ? allScores[Math.floor(allScores.length * 0.6)] : 0;
    const p80 = allScores.length > 0 ? allScores[Math.floor(allScores.length * 0.8)] : 0;
    // Finger tile threshold: top 40% of tiles, but at least 0.28
    const fingerThreshold = Math.max(0.28, p60 * 0.9);

    // Adaptive R floor & dominance floor from valid tiles' percentiles
    const allR: number[] = [];
    const allDom: number[] = [];
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (tileMetrics[ti].validPixels > 0) {
        allR.push(tileMetrics[ti].meanR);
        allDom.push(tileMetrics[ti].redDominance);
      }
    }
    allR.sort((a, b) => a - b);
    allDom.sort((a, b) => a - b);
    const adaptiveRedFloor = allR.length > 0 ? Math.max(40, allR[Math.floor(allR.length * 0.4)] * 0.85) : 40;
    const adaptiveDominanceFloor = allDom.length > 0 ? Math.max(5, allDom[Math.floor(allDom.length * 0.5)] * 0.7) : 5;

    // --- Identify valid finger tiles ---
    const currentMask = new Uint8Array(TOTAL_TILES);
    let fingerTileCount = 0;
    const validTileIndices: number[] = [];

    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const m = tileMetrics[ti];
      const isFingerTile =
        m.score > fingerThreshold &&
        m.meanR > adaptiveRedFloor &&
        m.rgRatio > 1.08 &&
        m.redDominance > adaptiveDominanceFloor &&
        m.intensity > 90 &&
        m.clipHighPct < 0.40 &&
        m.clipLowPct < 0.40 &&
        m.validPixels > 4;

      if (isFingerTile) {
        currentMask[ti] = 1;
        fingerTileCount++;
        validTileIndices.push(ti);
      }
    }

    // V3: temporal mask stability — fraction of tiles unchanged
    let maskChangeCount = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (currentMask[ti] !== this.prevMaskValid[ti]) maskChangeCount++;
    }
    const maskStability = 1 - maskChangeCount / TOTAL_TILES;
    this.prevMaskValid.set(currentMask);

    // --- V3: COARSE ROI (all tiles with finger signature, lenient) ---
    // Used for contact detection only.
    let cR = 0, cG = 0, cB = 0, cTotal = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const m = tileMetrics[ti];
      if (m.validPixels === 0) continue;
      // Coarse: any tile not heavily clipped & with some red dominance
      if (m.clipHighPct < 0.6 && m.clipLowPct < 0.6 && m.redDominance > 3) {
        const w = 0.5 + m.score;
        cR += m.meanR * w;
        cG += m.meanG * w;
        cB += m.meanB * w;
        cTotal += w;
      }
    }
    const coarseRed = cTotal > 0 ? cR / cTotal : 0;
    const coarseGreen = cTotal > 0 ? cG / cTotal : 0;
    const coarseBlue = cTotal > 0 ? cB / cTotal : 0;

    // --- FINE ROI: weighted average over strict valid tiles (signal extraction) ---
    let wR = 0, wG = 0, wB = 0, wTotal = 0;
    let brightSum = 0, brightSqSum = 0;
    let totalValidPx = 0;

    for (const ti of validTileIndices) {
      const m = tileMetrics[ti];
      // V3: weight emphasizes high-quality central tiles
      const w = 0.15 + m.score * 2.4 + m.centerBias * 0.7;
      wR += m.meanR * w;
      wG += m.meanG * w;
      wB += m.meanB * w;
      wTotal += w;
      brightSum += m.intensity;
      brightSqSum += m.intensity * m.intensity;
      totalValidPx += m.validPixels;
    }

    // V3: Fallback to coarse ROI rather than averaging contaminated tiles
    if (wTotal === 0) {
      wR = coarseRed; wG = coarseGreen; wB = coarseBlue;
      wTotal = cTotal > 0 ? 1 : 0;
    }

    const rawRed = wTotal > 0 ? wR / wTotal : 0;
    const rawGreen = wTotal > 0 ? wG / wTotal : 0;
    const rawBlue = wTotal > 0 ? wB / wTotal : 0;

    const coverageRatio = fingerTileCount / TOTAL_TILES;
    const avgFingerScore = validTileIndices.length > 0
      ? validTileIndices.reduce((s, ti) => s + tileMetrics[ti].score, 0) / validTileIndices.length
      : 0;

    // Spatial uniformity among finger tiles
    let uniformity = 0;
    if (validTileIndices.length >= 3) {
      const scores = validTileIndices.map(ti => tileMetrics[ti].score);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      uniformity = Math.max(0, Math.min(1, 1 - cv));
    }

    // V3: Center coverage — inner 3x3 of 9x9 grid
    // For 9x9, center 3x3 = rows 3-5, cols 3-5 → indices: 30,31,32,39,40,41,48,49,50
    const centerIndices = [30, 31, 32, 39, 40, 41, 48, 49, 50];
    const centerCount = centerIndices.filter(ti => currentMask[ti] === 1).length;
    const centerCov = centerCount / centerIndices.length;

    const brightness = validTileIndices.length > 0
      ? brightSum / validTileIndices.length : 0;
    const brightnessVar = validTileIndices.length > 1
      ? (brightSqSum / validTileIndices.length) - brightness * brightness : 0;

    const tileScores = new Float64Array(TOTAL_TILES);
    for (let ti = 0; ti < TOTAL_TILES; ti++) tileScores[ti] = tileMetrics[ti].score;

    return {
      rawRed, rawGreen, rawBlue,
      coarseRed, coarseGreen, coarseBlue,
      coverageRatio,
      fingerScore: avgFingerScore,
      clipHighRatio: totalPixels > 0 ? totalClipHigh / totalPixels : 0,
      clipLowRatio: totalPixels > 0 ? totalClipLow / totalPixels : 0,
      spatialUniformity: uniformity,
      centerCoverage: centerCov,
      brightness,
      brightnessVariance: brightnessVar,
      validPixelCount: totalValidPx,
      totalPixelCount: totalPixels,
      tileScores,
      maskStability,
      adaptiveRedFloor,
      adaptiveDominanceFloor,
    };
  }

  reset(): void {
    this.tileConfidence.fill(0);
    this.prevMaskValid.fill(0);
    this.tileMeanR.fill(0);
    this.tileMeanG.fill(0);
    this.tileMeanB.fill(0);
    this.tileMeanInit = false;
    this.frameCount = 0;
  }
}
