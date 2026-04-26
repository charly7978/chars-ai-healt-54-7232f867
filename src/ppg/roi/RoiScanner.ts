/**
 * ROI SCANNER
 * 
 * Scans frame for optimal ROI without blocking measurement.
 * 
 * Rules:
 * - Divide frame into grid (8x8 or 12x12)
 * - Ignore extreme edges
 * - Evaluate ROI candidates
 * - Prioritize center if scores are similar
 * - Initial ROI size: 40-70% of useful width
 * - Don't use entire image if saturated/dark zones exist
 * - Camera always analyzes; ROI selects by optical evidence
 */

export interface RoiBox {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number; // center x
  cy: number; // center y
}

export interface RoiCandidate {
  box: RoiBox;
  score: number;
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  meanR: number;
  meanG: number;
  meanB: number;
}

export interface RoiScanResult {
  selectedRoi: RoiBox;
  candidates: RoiCandidate[];
  state: 'SEARCHING_SIGNAL' | 'OPTICAL_CONTACT_CANDIDATE' | 'PPG_CANDIDATE' | 'PPG_VALID' | 'NO_PPG_SIGNAL' | 'SATURATED' | 'DARK_FRAME' | 'MOTION_ARTIFACT' | 'LOW_PERFUSION';
}

const GRID_ROWS = 8;
const GRID_COLS = 8;
const EDGE_MARGIN = 0.1; // Ignore 10% from edges
const MIN_ROI_SIZE_RATIO = 0.4;
const MAX_ROI_SIZE_RATIO = 0.7;
const VALID_PIXEL_MIN = 0.70;
const SATURATION_MAX = 0.45;
const DARK_MAX = 0.40;

/**
 * Calculate ROI score based on pixel statistics
 */
function calculateRoiScore(
  validPixelRatio: number,
  saturationRatio: number,
  darkRatio: number,
  redDominance: number,
  centerBias: number
): number {
  let score = 0;
  
  // Valid pixels (higher is better)
  score += validPixelRatio * 0.4;
  
  // Low saturation (lower is better)
  score += (1 - Math.min(saturationRatio / SATURATION_MAX, 1)) * 0.2;
  
  // Low dark (lower is better)
  score += (1 - Math.min(darkRatio / DARK_MAX, 1)) * 0.2;
  
  // Red dominance (hemoglobin signature)
  score += Math.min(redDominance / 2.0, 1) * 0.1;
  
  // Center bias (prefer center ROI)
  score += centerBias * 0.1;
  
  return score;
}

/**
 * Scan frame for ROI candidates
 */
export function scanRoi(imageData: ImageData): RoiScanResult {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  
  // Calculate grid cell size
  const cellWidth = Math.floor(width / GRID_COLS);
  const cellHeight = Math.floor(height / GRID_ROWS);
  
  const candidates: RoiCandidate[] = [];
  
  // Scan grid cells
  for (let row = 1; row < GRID_ROWS - 1; row++) {
    for (let col = 1; col < GRID_COLS - 1; col++) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      
      // Skip edge cells
      if (x < width * EDGE_MARGIN || x > width * (1 - EDGE_MARGIN) ||
          y < height * EDGE_MARGIN || y > height * (1 - EDGE_MARGIN)) {
        continue;
      }
      
      // Calculate stats for this cell
      const stats = calculateCellStats(imageData, x, y, cellWidth, cellHeight);
      
      // Calculate center bias (distance from center)
      const cx = x + cellWidth / 2;
      const cy = y + cellHeight / 2;
      const centerX = width / 2;
      const centerY = height / 2;
      const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);
      const dist = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2);
      const centerBias = 1 - (dist / maxDist);
      
      const score = calculateRoiScore(
        stats.validPixelRatio,
        stats.saturationRatio,
        stats.darkRatio,
        stats.redDominance,
        centerBias
      );
      
      candidates.push({
        box: {
          x, y, width: cellWidth, height: cellHeight,
          cx, cy,
        },
        score,
        validPixelRatio: stats.validPixelRatio,
        saturationRatio: stats.saturationRatio,
        darkRatio: stats.darkRatio,
        meanR: stats.meanR,
        meanG: stats.meanG,
        meanB: stats.meanB,
      });
    }
  }
  
  // Sort by score
  candidates.sort((a, b) => b.score - a.score);
  
  // Select best candidate
  const best = candidates[0];
  
  // Determine state
  let state: RoiScanResult['state'] = 'SEARCHING_SIGNAL';
  
  if (best.saturationRatio > SATURATION_MAX) {
    state = 'SATURATED';
  } else if (best.darkRatio > DARK_MAX) {
    state = 'DARK_FRAME';
  } else if (best.validPixelRatio < VALID_PIXEL_MIN) {
    state = 'NO_PPG_SIGNAL';
  } else if (best.score > 0.6) {
    state = 'PPG_VALID';
  } else if (best.score > 0.4) {
    state = 'PPG_CANDIDATE';
  } else if (best.score > 0.2) {
    state = 'OPTICAL_CONTACT_CANDIDATE';
  } else {
    state = 'LOW_PERFUSION';
  }
  
  // Expand selected ROI to 40-70% of useful width
  const usefulWidth = width * (1 - 2 * EDGE_MARGIN);
  const roiWidth = Math.floor(usefulWidth * (MIN_ROI_SIZE_RATIO + (best.score * (MAX_ROI_SIZE_RATIO - MIN_ROI_SIZE_RATIO))));
  const roiHeight = Math.floor(roiWidth * (height / width));
  
  const selectedRoi: RoiBox = {
    x: Math.max(0, Math.floor(best.box.cx - roiWidth / 2)),
    y: Math.max(0, Math.floor(best.box.cy - roiHeight / 2)),
    width: roiWidth,
    height: roiHeight,
    cx: best.box.cx,
    cy: best.box.cy,
  };
  
  return {
    selectedRoi,
    candidates,
    state,
  };
}

/**
 * Calculate statistics for a cell
 */
function calculateCellStats(
  imageData: ImageData,
  x: number,
  y: number,
  width: number,
  height: number
): {
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  meanR: number;
  meanG: number;
  meanB: number;
  redDominance: number;
} {
  const data = imageData.data;
  const imgWidth = imageData.width;
  
  let validCount = 0;
  let saturatedCount = 0;
  let darkCount = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let pixelCount = 0;
  
  const SATURATION_THRESHOLD = 250;
  const DARK_THRESHOLD = 5;
  
  for (let ry = y; ry < y + height && ry < imageData.height; ry++) {
    for (let rx = x; rx < x + width && rx < imgWidth; rx++) {
      const offset = (ry * imgWidth + rx) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      
      totalR += r;
      totalG += g;
      totalB += b;
      pixelCount++;
      
      if (r >= SATURATION_THRESHOLD || g >= SATURATION_THRESHOLD || b >= SATURATION_THRESHOLD) {
        saturatedCount++;
      }
      
      if (r <= DARK_THRESHOLD && g <= DARK_THRESHOLD && b <= DARK_THRESHOLD) {
        darkCount++;
      }
      
      if (r > DARK_THRESHOLD && r < SATURATION_THRESHOLD &&
          g > DARK_THRESHOLD && g < SATURATION_THRESHOLD &&
          b > DARK_THRESHOLD && b < SATURATION_THRESHOLD) {
        validCount++;
      }
    }
  }
  
  if (pixelCount === 0) {
    return {
      validPixelRatio: 0,
      saturationRatio: 0,
      darkRatio: 0,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      redDominance: 0,
    };
  }
  
  const meanR = totalR / pixelCount;
  const meanG = totalG / pixelCount;
  const meanB = totalB / pixelCount;
  
  return {
    validPixelRatio: validCount / pixelCount,
    saturationRatio: saturatedCount / pixelCount,
    darkRatio: darkCount / pixelCount,
    meanR,
    meanG,
    meanB,
    redDominance: meanR / (meanG + meanB + 1e-6),
  };
}
