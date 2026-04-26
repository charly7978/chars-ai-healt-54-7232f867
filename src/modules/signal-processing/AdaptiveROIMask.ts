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
  // V6: adaptive ROI box geometry (px in source frame coords) + auto-tuned
  // thresholds used by the 32×32 pre-pass. Exposed so the host can record
  // structured telemetry per frame and verify finger coverage in real time.
  roiBox: { cx: number; cy: number; sizePx: number; sizeFrac: number; mass: number };
  prepassThresholds: { redDomMin: number; redMin: number };
  prepassSuccessRate: number;
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

  // V4: reusable per-tile metric scratch (zero alloc in hot path)
  private mScore = new Float64Array(TOTAL_TILES);
  private mIntensity = new Float64Array(TOTAL_TILES);
  private mRedDom = new Float64Array(TOTAL_TILES);
  private mRgRatio = new Float64Array(TOTAL_TILES);
  private mClipHi = new Float64Array(TOTAL_TILES);
  private mClipLo = new Float64Array(TOTAL_TILES);
  private mCenterBias = new Float64Array(TOTAL_TILES);
  private mValidPx = new Int32Array(TOTAL_TILES);
  private currentMask = new Uint8Array(TOTAL_TILES);
  // Reusable scratch for percentile sorts (worst case = TOTAL_TILES)
  private sortScratch = new Float64Array(TOTAL_TILES);
  // Reusable output tile scores returned to caller
  private outTileScores = new Float64Array(TOTAL_TILES);

  // V4: precomputed center-bias table — depends only on geometry
  private static readonly CENTER_BIAS_TBL = (() => {
    const t = new Float64Array(TOTAL_TILES);
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const gx = ti % GRID;
      const gy = (ti / GRID) | 0;
      const nx = GRID > 1 ? gx / (GRID - 1) : 0.5;
      const ny = GRID > 1 ? gy / (GRID - 1) : 0.5;
      const dist = Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2);
      t[ti] = Math.max(0.15, Math.exp(-dist * 2.4));
    }
    return t;
  })();

  // --- V5: adaptive ROI re-centering state ---
  // The ROI box was previously fixed to the geometric center of the frame at
  // 85% of min(w,h). For off-center fingers (very common on phones with the
  // rear camera near a corner) this leaves half the ROI outside the finger,
  // which crushes `coverage` and inflates `spatialUniformity` (because the
  // dark/non-finger half is itself uniform). Both effects sabotage Liveness.
  //
  // V5 runs a *very* cheap coarse pre-pass at ~32×32 to estimate the centroid
  // of the red-dominant (high-luminance) region of the frame, and re-centers
  // the working ROI on that centroid with light temporal smoothing.
  // No gate logic is altered — only WHERE we look.
  private roiCenterX = -1; // smoothed (px in source frame coords)
  private roiCenterY = -1;
  private roiSizeFrac = 0.85; // adaptive size fraction of min(w,h)
  private readonly ROI_CENTER_ALPHA = 0.35; // EMA on centroid
  private readonly ROI_SIZE_ALPHA = 0.25;   // EMA on size

  // --- V6: auto-tuned pre-pass thresholds ---
  // The 32×32 coarse pass used to require redDom≥12 and r≥70 for every skin
  // tone and lighting condition. That fails for darker skin (lower red
  // dominance) and for under-illuminated rear cameras. We now adapt both
  // thresholds based on the recent success rate of the pre-pass (fraction
  // of last N frames where we found ANY finger-likely pixel). When success
  // is too low we loosen, when too high we tighten — bounded to safe range.
  private prepassRedDomMin = 12;
  private prepassRedMin = 70;
  private prepassRecent = new Uint8Array(60); // rolling window of last 60 frames
  private prepassRecentIdx = 0;
  private prepassRecentFilled = 0;
  private prepassSuccessRate = 0;
  private readonly PREPASS_REDDOM_MIN_LO = 4;
  private readonly PREPASS_REDDOM_MIN_HI = 20;
  private readonly PREPASS_RED_MIN_LO = 35;
  private readonly PREPASS_RED_MIN_HI = 100;
  private readonly PREPASS_TARGET_LO = 0.35; // below → loosen
  private readonly PREPASS_TARGET_HI = 0.85; // above → tighten
  private lastBox: { cx: number; cy: number; sizePx: number; mass: number } = {
    cx: 0, cy: 0, sizePx: 0, mass: 0,
  };

  /**
   * Coarse 32×32 pre-pass that returns the centroid of the red-dominant
   * region and an estimate of its bounding extent (used to size the ROI).
   * Cost: ~1024 pixel reads — negligible vs the main pass.
   */
  private estimateFingerBox(
    data: Uint8ClampedArray, w: number, h: number,
  ): { cx: number; cy: number; sizePx: number; mass: number } {
    const N = 32;
    const stepX = Math.max(1, (w / N) | 0);
    const stepY = Math.max(1, (h / N) | 0);
    let sumW = 0, sumWX = 0, sumWY = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    const redDomMin = this.prepassRedDomMin;
    const redMin = this.prepassRedMin;
    for (let y = 0; y < h; y += stepY) {
      const rowOff = y * w;
      for (let x = 0; x < w; x += stepX) {
        const i = (rowOff + x) << 2;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Skip clipped lows (shadows around the finger) and pure saturation.
        if (r + g + b < 60) continue;
        // "Finger-likely" pixel: red dominates AND luminance is meaningful.
        const redDom = r - (g + b) * 0.5;
        if (redDom < redDomMin || r < redMin) continue;
        // Weight by red dominance × luminance band (favour 100..240).
        const lum = (r + g + b) / 3;
        const lumW = lum < 100 ? lum / 100 : lum > 240 ? Math.max(0, 1 - (lum - 240) / 30) : 1;
        const wgt = Math.max(0, redDom) * lumW;
        if (wgt <= 0) continue;
        sumW += wgt;
        sumWX += wgt * x;
        sumWY += wgt * y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (sumW <= 0) {
      return { cx: w / 2, cy: h / 2, sizePx: Math.min(w, h) * 0.85, mass: 0 };
    }
    const cx = sumWX / sumW;
    const cy = sumWY / sumW;
    // Use the larger of the two extents as size hint, padded ×1.15.
    const extent = Math.max(maxX - minX, maxY - minY) * 1.15;
    // Clamp to a sensible band: never smaller than 50% nor larger than 95%.
    const minDim = Math.min(w, h);
    const sizePx = Math.max(minDim * 0.5, Math.min(minDim * 0.95, extent));
    return { cx, cy, sizePx, mass: sumW };
  }

  /**
   * V6: feed the most recent pre-pass outcome into the rolling success
   * window and gently adapt the thresholds once the window is full enough
   * to be statistically meaningful (≥30 frames).
   */
  private updatePrepassAutoTune(success: boolean): void {
    this.prepassRecent[this.prepassRecentIdx] = success ? 1 : 0;
    this.prepassRecentIdx = (this.prepassRecentIdx + 1) % this.prepassRecent.length;
    if (this.prepassRecentFilled < this.prepassRecent.length) this.prepassRecentFilled++;
    if (this.prepassRecentFilled < 30) return;
    let s = 0;
    for (let i = 0; i < this.prepassRecentFilled; i++) s += this.prepassRecent[i];
    const rate = s / this.prepassRecentFilled;
    this.prepassSuccessRate = rate;
    // Adapt every 10 frames to avoid over-reacting.
    if (this.frameCount % 10 !== 0) return;
    if (rate < this.PREPASS_TARGET_LO) {
      // Too few finger-likely pixels — loosen (allow darker / less red).
      this.prepassRedDomMin = Math.max(this.PREPASS_REDDOM_MIN_LO, this.prepassRedDomMin - 1);
      this.prepassRedMin = Math.max(this.PREPASS_RED_MIN_LO, this.prepassRedMin - 4);
    } else if (rate > this.PREPASS_TARGET_HI) {
      // Plenty of "finger-likely" hits — tighten to reject ambient red.
      this.prepassRedDomMin = Math.min(this.PREPASS_REDDOM_MIN_HI, this.prepassRedDomMin + 1);
      this.prepassRedMin = Math.min(this.PREPASS_RED_MIN_HI, this.prepassRedMin + 4);
    }
  }

  process(imageData: ImageData): ROIMaskResult {
    this.frameCount++;
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    // V5: Adaptive ROI — coarse pre-pass picks the finger centroid and size,
    // then we EMA-smooth both to avoid jitter. Falls back to the geometric
    // center when no red-dominant pixels are found (no finger / pure noise).
    const minDim = Math.min(w, h);
    const box = this.estimateFingerBox(data, w, h);
    this.lastBox = box;
    this.updatePrepassAutoTune(box.mass > 0);
    const targetSizeFrac = Math.max(0.5, Math.min(0.95, box.sizePx / minDim));
    if (this.roiCenterX < 0) {
      // first frame seed
      this.roiCenterX = box.cx;
      this.roiCenterY = box.cy;
      this.roiSizeFrac = targetSizeFrac;
    } else if (box.mass > 0) {
      // Smoothly follow the finger; don't snap.
      this.roiCenterX += (box.cx - this.roiCenterX) * this.ROI_CENTER_ALPHA;
      this.roiCenterY += (box.cy - this.roiCenterY) * this.ROI_CENTER_ALPHA;
      this.roiSizeFrac += (targetSizeFrac - this.roiSizeFrac) * this.ROI_SIZE_ALPHA;
    } else {
      // No finger evidence — drift gently back to the geometric center
      // so the next finger touch starts from a neutral position.
      this.roiCenterX += (w / 2 - this.roiCenterX) * 0.05;
      this.roiCenterY += (h / 2 - this.roiCenterY) * 0.05;
      this.roiSizeFrac += (0.85 - this.roiSizeFrac) * 0.05;
    }
    const roiSize = minDim * this.roiSizeFrac;
    const half = roiSize / 2;
    // Clamp the box inside the frame.
    const cxC = Math.max(half, Math.min(w - half, this.roiCenterX));
    const cyC = Math.max(half, Math.min(h - half, this.roiCenterY));
    const sx = Math.floor(cxC - half);
    const sy = Math.floor(cyC - half);
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

    // --- V4: Compute per-tile metrics into pre-allocated Float64Arrays ---
    let scoreCount = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const cnt = this.tileValid[ti];
      const total = this.tileCount[ti];
      if (cnt === 0 || total === 0) {
        this.mScore[ti] = 0;
        this.mIntensity[ti] = 0;
        this.mRedDom[ti] = 0;
        this.mRgRatio[ti] = 0;
        this.mClipHi[ti] = 0;
        this.mClipLo[ti] = 0;
        this.mCenterBias[ti] = AdaptiveROIMask.CENTER_BIAS_TBL[ti];
        this.mValidPx[ti] = 0;
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

      // V4: precomputed center bias from static table
      const centerBias = AdaptiveROIMask.CENTER_BIAS_TBL[ti];

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

      this.mScore[ti] = combinedScore;
      this.mIntensity[ti] = intensity;
      this.mRedDom[ti] = redDominance;
      this.mRgRatio[ti] = rgRatio;
      this.mClipHi[ti] = clipHighPct;
      this.mClipLo[ti] = clipLowPct;
      this.mCenterBias[ti] = centerBias;
      this.mValidPx[ti] = cnt;
      this.sortScratch[scoreCount++] = combinedScore;
    }
    this.tileMeanInit = true;

    // --- V4: Adaptive thresholds from FRAME percentiles (subarray sort, no GC) ---
    let fingerThreshold = 0.28;
    if (scoreCount > 0) {
      const view = this.sortScratch.subarray(0, scoreCount);
      view.sort();
      const p60 = view[Math.floor(scoreCount * 0.6)];
      fingerThreshold = Math.max(0.28, p60 * 0.9);
    }
    // Adaptive R-floor & dominance-floor: reuse sortScratch with two passes
    let validN = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (this.mValidPx[ti] > 0) this.sortScratch[validN++] = this.tileMeanR[ti];
    }
    let adaptiveRedFloor = 40;
    if (validN > 0) {
      const v = this.sortScratch.subarray(0, validN);
      v.sort();
      adaptiveRedFloor = Math.max(40, v[Math.floor(validN * 0.4)] * 0.85);
    }
    let validN2 = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (this.mValidPx[ti] > 0) this.sortScratch[validN2++] = this.mRedDom[ti];
    }
    let adaptiveDominanceFloor = 5;
    if (validN2 > 0) {
      const v = this.sortScratch.subarray(0, validN2);
      v.sort();
      adaptiveDominanceFloor = Math.max(5, v[Math.floor(validN2 * 0.5)] * 0.7);
    }

    // --- Identify valid finger tiles ---
    this.currentMask.fill(0);
    let fingerTileCount = 0;
    let scoreSum = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      const isFingerTile =
        this.mScore[ti] > fingerThreshold &&
        this.tileMeanR[ti] > adaptiveRedFloor &&
        this.mRgRatio[ti] > 1.08 &&
        this.mRedDom[ti] > adaptiveDominanceFloor &&
        this.mIntensity[ti] > 90 &&
        this.mClipHi[ti] < 0.40 &&
        this.mClipLo[ti] < 0.40 &&
        this.mValidPx[ti] > 4;
      if (isFingerTile) {
        this.currentMask[ti] = 1;
        fingerTileCount++;
        scoreSum += this.mScore[ti];
      }
    }

    // V3: temporal mask stability — fraction of tiles unchanged
    let maskChangeCount = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (this.currentMask[ti] !== this.prevMaskValid[ti]) maskChangeCount++;
    }
    const maskStability = 1 - maskChangeCount / TOTAL_TILES;
    this.prevMaskValid.set(this.currentMask);

    // --- V3: COARSE ROI (all tiles with finger signature, lenient) ---
    // Used for contact detection only.
    let cR = 0, cG = 0, cB = 0, cTotal = 0;
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (this.mValidPx[ti] === 0) continue;
      // Coarse: any tile not heavily clipped & with some red dominance
      if (this.mClipHi[ti] < 0.6 && this.mClipLo[ti] < 0.6 && this.mRedDom[ti] > 3) {
        const w = 0.5 + this.mScore[ti];
        cR += this.tileMeanR[ti] * w;
        cG += this.tileMeanG[ti] * w;
        cB += this.tileMeanB[ti] * w;
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
    for (let ti = 0; ti < TOTAL_TILES; ti++) {
      if (!this.currentMask[ti]) continue;
      const w = 0.15 + this.mScore[ti] * 2.4 + this.mCenterBias[ti] * 0.7;
      wR += this.tileMeanR[ti] * w;
      wG += this.tileMeanG[ti] * w;
      wB += this.tileMeanB[ti] * w;
      wTotal += w;
      brightSum += this.mIntensity[ti];
      brightSqSum += this.mIntensity[ti] * this.mIntensity[ti];
      totalValidPx += this.mValidPx[ti];
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
    const avgFingerScore = fingerTileCount > 0 ? scoreSum / fingerTileCount : 0;

    // V4: Spatial uniformity from coefficient of variation — single pass
    let uniformity = 0;
    if (fingerTileCount >= 3) {
      const mean = scoreSum / fingerTileCount;
      let varSum = 0;
      for (let ti = 0; ti < TOTAL_TILES; ti++) {
        if (this.currentMask[ti]) {
          const d = this.mScore[ti] - mean;
          varSum += d * d;
        }
      }
      const variance = varSum / fingerTileCount;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      uniformity = Math.max(0, Math.min(1, 1 - cv));
    }

    // V3: Center coverage — inner 3x3 of 9x9 grid
    // For 9x9, center 3x3 = rows 3-5, cols 3-5 → indices: 30,31,32,39,40,41,48,49,50
    const centerIndices = [30, 31, 32, 39, 40, 41, 48, 49, 50];
    let centerCount = 0;
    for (let i = 0; i < 9; i++) if (this.currentMask[centerIndices[i]]) centerCount++;
    const centerCov = centerCount / centerIndices.length;

    const brightness = fingerTileCount > 0 ? brightSum / fingerTileCount : 0;
    const brightnessVar = fingerTileCount > 1
      ? (brightSqSum / fingerTileCount) - brightness * brightness : 0;

    // V4: copy into reusable output buffer (caller treats as read-only)
    this.outTileScores.set(this.mScore);

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
      tileScores: this.outTileScores,
      maskStability,
      adaptiveRedFloor,
      adaptiveDominanceFloor,
      roiBox: {
        cx: cxC,
        cy: cyC,
        sizePx: roiSize,
        sizeFrac: this.roiSizeFrac,
        mass: this.lastBox.mass,
      },
      prepassThresholds: {
        redDomMin: this.prepassRedDomMin,
        redMin: this.prepassRedMin,
      },
      prepassSuccessRate: this.prepassSuccessRate,
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
    // V5: clear adaptive ROI tracker so the next session starts at center.
    this.roiCenterX = -1;
    this.roiCenterY = -1;
    this.roiSizeFrac = 0.85;
    // V6: reset auto-tuner so a new session starts from neutral defaults.
    this.prepassRedDomMin = 12;
    this.prepassRedMin = 70;
    this.prepassRecent.fill(0);
    this.prepassRecentIdx = 0;
    this.prepassRecentFilled = 0;
    this.prepassSuccessRate = 0;
    this.lastBox = { cx: 0, cy: 0, sizePx: 0, mass: 0 };
  }
}
