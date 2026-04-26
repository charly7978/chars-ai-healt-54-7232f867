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
  /**
   * V7: textura espacial del canal G dentro del fine ROI vía ENTROPÍA DE
   * SHANNON sobre histograma de 16 bins. Bits ∈ [0, 4]. Banda esperada para
   * piel real con crestas dactilares: ~1.6–3.9 bits.
   * Ref: Wang et al., Sensors 2020 — entropía espacial en G como mejor
   * discriminador piel-vs-no-piel bajo flash uniforme.
   * Devuelve 0 cuando hay menos de 200 píxeles válidos (no fiable).
   */
  textureEntropy: number;
  /**
   * V7: contigüidad de la máscara de cobertura en el grid 9×9: fracción de
   * tiles "finger-tile" que pertenecen a la mayor componente conexa
   * 8-connectivity. 1 = un solo dedo cohesionado; <0.55 ≈ parches dispersos.
   */
  coverageContiguity: number;
  /**
   * V8: Jaccard real |M_t ∩ M_{t-1}| / |M_t ∪ M_{t-1}| en el grid 9×9 de
   * finger-tiles. 1 = máscara idéntica al frame previo; 0 = sin solape.
   * Reemplaza la métrica Hamming usada como `maskStability` (que se mantiene
   * por compatibilidad pero ahora alias del IoU).
   */
  maskIoU: number;
  /**
   * V8: σ del tracker EMA del centroide ROI en píxeles del frame, expuesto
   * como motion-proxy óptico independiente del IMU. Mide cuánto se mueve la
   * observación del centroide respecto al estado suavizado: ~0 cuando el
   * dedo está quieto, > 4 px cuando hay temblor / reposicionamiento.
   */
  trackerSigma: number;
}

const GRID = 9; // V3: 9x9 grid for finer adaptive ROI
const TOTAL_TILES = GRID * GRID;
const CLIP_HIGH = 248;   // tighter to exclude near-saturation
const CLIP_LOW = 8;      // exclude crushed blacks

/**
 * V7 — Connected-components 8-connectivity in-place sobre una máscara
 * binaria w×h. Devuelve label-array (Int16) y un objeto compacto con la
 * info de cada componente (área, masa ponderada, bbox, contiene-centro).
 * Implementación two-pass con union-find por path-compression y rank.
 * Cero-alloc en caller: labels y union-find arrays se reciben como scratch.
 *
 * Ref. clásica: Rosenfeld & Pfaltz 1966 — usado en hand-segmentation
 * IEEE 2018+. Two-pass es 4-5x más rápido que recursivo en JS V8.
 */
function connectedComponents8(
  mask: Uint8Array, w: number, h: number,
  labels: Int16Array,
  parent: Int16Array,
  rank: Int16Array,
): number {
  // Reset scratch — labels al -1, parent/rank a 0 hasta nextLabel-1.
  labels.fill(-1);
  let nextLabel = 0;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // path compression
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  };

  // First pass — assign labels, union with neighbours (NW, N, NE, W).
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      if (!mask[idx]) continue;
      let lab = -1;
      // 4 neighbours already visited
      const nIdxs = [
        y > 0 && x > 0     ? rowOff - w + x - 1 : -1, // NW
        y > 0              ? rowOff - w + x     : -1, // N
        y > 0 && x < w - 1 ? rowOff - w + x + 1 : -1, // NE
        x > 0              ? rowOff + x - 1     : -1, // W
      ];
      for (let k = 0; k < 4; k++) {
        const ni = nIdxs[k];
        if (ni >= 0 && labels[ni] >= 0) {
          const nl = labels[ni];
          if (lab < 0) lab = nl;
          else if (nl !== lab) union(lab, nl);
        }
      }
      if (lab < 0) {
        if (nextLabel >= parent.length) { lab = 0; }
        else {
          lab = nextLabel++;
          parent[lab] = lab;
          rank[lab] = 0;
        }
      }
      labels[idx] = lab;
    }
  }

  // Second pass — flatten to root labels.
  for (let i = 0; i < w * h; i++) {
    if (labels[i] >= 0) labels[i] = find(labels[i]);
  }
  return nextLabel;
}

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

  // --- V8: residual EMA of |observation − smoothed_state| as σ proxy ---
  // Cheap online estimate: lo usamos como motion proxy óptico que no depende
  // del IMU. EMA con α=0.2 → ~5-frame time constant (≈170 ms @30 fps).
  private trackerResidualEMA = 0;
  private trackerSigmaPx = 0;
  private readonly TRACKER_RES_ALPHA = 0.2;

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

  // V7 — scratch arrays para connected-components (32×32 = 1024) y para
  // contiguity en el grid 9×9 (81). Reutilizables, cero-alloc en hot path.
  private ccLabels32 = new Int16Array(1024);
  private ccParent32 = new Int16Array(1024);
  private ccRank32 = new Int16Array(1024);
  private ccMask32 = new Uint8Array(1024);
  private ccRedDom32 = new Float32Array(1024);
  private ccLabels9 = new Int16Array(TOTAL_TILES);
  private ccParent9 = new Int16Array(TOTAL_TILES);
  private ccRank9 = new Int16Array(TOTAL_TILES);
  // Histograma 16-bin del canal G para textureEntropy. Cero-alloc.
  private gHist = new Int32Array(16);

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
    // V7 — además del centroide ponderado clásico, construimos una máscara
    // 32×32 de píxeles "finger-likely" y corremos connected-components 8-conn
    // para elegir UNA componente cohesionada en lugar del centroide global,
    // que se contamina con manchas rojas del fondo.
    this.ccMask32.fill(0);
    this.ccRedDom32.fill(0);
    const redDomMin = this.prepassRedDomMin;
    const redMin = this.prepassRedMin;
    // Tamaño efectivo del muestreo (puede ser < 32 si w/h son muy pequeños).
    const Nx = Math.min(N, Math.max(1, Math.ceil(w / stepX)));
    const Ny = Math.min(N, Math.max(1, Math.ceil(h / stepY)));
    let gx = 0, gy = 0;
    for (let y = 0; y < h; y += stepY) {
      const rowOff = y * w;
      gx = 0;
      for (let x = 0; x < w; x += stepX) {
        const i = (rowOff + x) << 2;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const cellIdx = gy * Nx + gx;
        gx++;
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
        if (cellIdx >= 0 && cellIdx < this.ccMask32.length) {
          this.ccMask32[cellIdx] = 1;
          this.ccRedDom32[cellIdx] = wgt;
        }
      }
      gy++;
    }
    // Run CC on 32×32-ish grid (Nx × Ny).
    const totalCells = Nx * Ny;
    if (totalCells === 0) {
      return { cx: w / 2, cy: h / 2, sizePx: Math.min(w, h) * 0.85, mass: 0 };
    }
    connectedComponents8(
      this.ccMask32.subarray(0, totalCells),
      Nx, Ny,
      this.ccLabels32.subarray(0, totalCells),
      this.ccParent32, this.ccRank32,
    );
    // Por componente: área, masa Σ redDom, bbox, área-en-disco-central.
    // Disco central: radio = 0.45 · min(Nx,Ny) en coords del grid.
    const cxGrid = (Nx - 1) / 2;
    const cyGrid = (Ny - 1) / 2;
    const rDisk = 0.45 * Math.min(Nx, Ny);
    const rDisk2 = rDisk * rDisk;
    // Acumuladores por label — usamos Map pequeño dado que #labels es bajo.
    // Por presupuesto cero-alloc estricto, usamos arrays típed dimensionados
    // al worst case (1024) reutilizables.
    const accArea = new Int32Array(totalCells);
    const accAreaCentral = new Int32Array(totalCells);
    const accMass = new Float32Array(totalCells);
    const accSumWX = new Float32Array(totalCells);
    const accSumWY = new Float32Array(totalCells);
    let accMinX = new Int32Array(totalCells);
    let accMaxX = new Int32Array(totalCells);
    let accMinY = new Int32Array(totalCells);
    let accMaxY = new Int32Array(totalCells);
    accMinX.fill(Nx); accMinY.fill(Ny); accMaxX.fill(-1); accMaxY.fill(-1);
    const labelsView = this.ccLabels32.subarray(0, totalCells);
    for (let cy = 0; cy < Ny; cy++) {
      for (let cx = 0; cx < Nx; cx++) {
        const idx = cy * Nx + cx;
        const lab = labelsView[idx];
        if (lab < 0) continue;
        const m = this.ccRedDom32[idx];
        accArea[lab]++;
        const dx = cx - cxGrid, dy = cy - cyGrid;
        if (dx * dx + dy * dy <= rDisk2) accAreaCentral[lab]++;
        accMass[lab] += m;
        // Coord en píxeles del frame (centro de la celda).
        const px = cx * stepX + (stepX >> 1);
        const py = cy * stepY + (stepY >> 1);
        accSumWX[lab] += m * px;
        accSumWY[lab] += m * py;
        if (cx < accMinX[lab]) accMinX[lab] = cx;
        if (cx > accMaxX[lab]) accMaxX[lab] = cx;
        if (cy < accMinY[lab]) accMinY[lab] = cy;
        if (cy > accMaxY[lab]) accMaxY[lab] = cy;
      }
    }
    // Elegir componente que MAXIMIZA areaCentral × Σ redDom.
    let bestLab = -1;
    let bestScore = 0;
    for (let lab = 0; lab < totalCells; lab++) {
      if (accArea[lab] === 0) continue;
      const score = accAreaCentral[lab] * accMass[lab];
      if (score > bestScore) { bestScore = score; bestLab = lab; }
    }
    if (bestLab < 0 || accMass[bestLab] <= 0) {
      return { cx: w / 2, cy: h / 2, sizePx: Math.min(w, h) * 0.85, mass: 0 };
    }
    // Validar: aspect ratio razonable + componente toca el centro.
    const bboxW = (accMaxX[bestLab] - accMinX[bestLab] + 1) * stepX;
    const bboxH = (accMaxY[bestLab] - accMinY[bestLab] + 1) * stepY;
    const aspect = bboxW > bboxH ? bboxW / Math.max(1, bboxH) : bboxH / Math.max(1, bboxW);
    if (accAreaCentral[bestLab] === 0 || aspect > 2.5) {
      return { cx: w / 2, cy: h / 2, sizePx: Math.min(w, h) * 0.85, mass: 0 };
    }
    const cx = accSumWX[bestLab] / accMass[bestLab];
    const cy = accSumWY[bestLab] / accMass[bestLab];
    const extent = Math.max(bboxW, bboxH) * 1.15;
    // Clamp to a sensible band: never smaller than 50% nor larger than 95%.
    const minDim = Math.min(w, h);
    const sizePx = Math.max(minDim * 0.5, Math.min(minDim * 0.95, extent));
    return { cx, cy, sizePx, mass: accMass[bestLab] };
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
      // V8: track residual |observation − previous smoothed| as σ proxy.
      const dxRes = box.cx - this.roiCenterX;
      const dyRes = box.cy - this.roiCenterY;
      const resMag = Math.sqrt(dxRes * dxRes + dyRes * dyRes);
      this.trackerResidualEMA =
        this.trackerResidualEMA * (1 - this.TRACKER_RES_ALPHA) +
        resMag * this.TRACKER_RES_ALPHA;
      this.trackerSigmaPx = this.trackerResidualEMA;
      this.roiCenterX += (box.cx - this.roiCenterX) * this.ROI_CENTER_ALPHA;
      this.roiCenterY += (box.cy - this.roiCenterY) * this.ROI_CENTER_ALPHA;
      this.roiSizeFrac += (targetSizeFrac - this.roiSizeFrac) * this.ROI_SIZE_ALPHA;
    } else {
      // No finger evidence — drift gently back to the geometric center
      // so the next finger touch starts from a neutral position.
      this.roiCenterX += (w / 2 - this.roiCenterX) * 0.05;
      this.roiCenterY += (h / 2 - this.roiCenterY) * 0.05;
      this.roiSizeFrac += (0.85 - this.roiSizeFrac) * 0.05;
      // Sin observación válida: relajar σ hacia 0.
      this.trackerResidualEMA *= 0.85;
      this.trackerSigmaPx = this.trackerResidualEMA;
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

    // ── V7: ENTROPÍA DE SHANNON DEL CANAL G EN EL FINE ROI ────────────
    // Banda de discriminación (Wang et al., Sensors 2020):
    //   piel real (crestas dactilares) ≈ 1.6 – 3.9 bits
    //   superficie plana / pared       <  1.5 bits
    //   reflejo / glare                >  3.9 bits
    // Implementación cero-alloc: histograma 16-bin reutilizado.
    let textureEntropy = 0;
    if (totalValidPx >= 200) {
      this.gHist.fill(0);
      const stepE = roiW * roiH > 200000 ? 4 : 3;
      let nE = 0;
      for (let y = sy; y < ey; y += stepE) {
        const rowOff = y * w;
        for (let x = sx; x < ex; x += stepE) {
          const i = (rowOff + x) << 2;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (r >= CLIP_HIGH || g >= CLIP_HIGH || b >= CLIP_HIGH) continue;
          if (r + g + b <= CLIP_LOW * 3) continue;
          const bin = (g >> 4) & 0xF; // 0..15
          this.gHist[bin]++;
          nE++;
        }
      }
      if (nE > 0) {
        const invN = 1 / nE;
        const LOG2 = Math.LN2;
        for (let k = 0; k < 16; k++) {
          const c = this.gHist[k];
          if (c === 0) continue;
          const p = c * invN;
          textureEntropy -= p * Math.log(p) / LOG2;
        }
      }
    }

    // ── V7: COVERAGE CONTIGUITY (mayor componente conexa 8-conn / total) ─
    let coverageContiguity = 0;
    if (fingerTileCount > 0) {
      connectedComponents8(
        this.currentMask, GRID, GRID,
        this.ccLabels9, this.ccParent9, this.ccRank9,
      );
      // Encontrar el label con más píxeles "1".
      // #labels máx = TOTAL_TILES, usamos sortScratch como acumulador.
      // No reutilizamos sortScratch para no chocar con su uso previo;
      // este conteo es O(81) → un Int32Array temporal pequeño.
      const counts = new Int32Array(TOTAL_TILES);
      for (let ti = 0; ti < TOTAL_TILES; ti++) {
        if (!this.currentMask[ti]) continue;
        const lab = this.ccLabels9[ti];
        if (lab >= 0) counts[lab]++;
      }
      let largest = 0;
      for (let k = 0; k < TOTAL_TILES; k++) {
        if (counts[k] > largest) largest = counts[k];
      }
      coverageContiguity = largest / fingerTileCount;
    }

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
      textureEntropy,
      coverageContiguity,
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
