/**
 * PIXEL STATS
 * 
 * Calculates robust statistics from pixel data:
 * - mean, trimmed mean, median
 * - saturation ratio (pixels >= 250)
 * - dark ratio (pixels <= 5)
 * - valid pixel ratio
 * - red dominance
 */

export interface PixelStats {
  meanR: number;
  meanG: number;
  meanB: number;
  trimmedMeanR: number;
  trimmedMeanG: number;
  trimmedMeanB: number;
  medianR: number;
  medianG: number;
  medianB: number;
  saturationRatio: number;
  darkRatio: number;
  validPixelRatio: number;
  redDominance: number;
  greenSignal: number;
  blueSignal: number;
}

const TRIM_PERCENT = 0.05; // Trim 5% from each end
const SATURATION_THRESHOLD = 250;
const DARK_THRESHOLD = 5;
const EPSILON = 1e-6;

/**
 * Calculate trimmed mean (removes outliers from both ends)
 */
function trimmedMean(arr: number[], trimPercent: number): number {
  if (arr.length === 0) return 0;
  
  const sorted = [...arr].sort((a, b) => a - b);
  const trimCount = Math.floor(arr.length * trimPercent);
  const trimmed = sorted.slice(trimCount, arr.length - trimCount);
  
  if (trimmed.length === 0) return 0;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/**
 * Calculate median
 */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Calculate pixel statistics from ImageData
 */
export function calculatePixelStats(imageData: ImageData): PixelStats {
  const data = imageData.data;
  const pixelCount = data.length / 4;
  
  const rValues: number[] = [];
  const gValues: number[] = [];
  const bValues: number[] = [];
  
  let saturatedCount = 0;
  let darkCount = 0;
  let validCount = 0;
  
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    
    rValues.push(r);
    gValues.push(g);
    bValues.push(b);
    
    // Check saturation
    if (r >= SATURATION_THRESHOLD || g >= SATURATION_THRESHOLD || b >= SATURATION_THRESHOLD) {
      saturatedCount++;
    }
    
    // Check dark
    if (r <= DARK_THRESHOLD && g <= DARK_THRESHOLD && b <= DARK_THRESHOLD) {
      darkCount++;
    }
    
    // Valid pixel (not extreme)
    if (r > DARK_THRESHOLD && r < SATURATION_THRESHOLD &&
        g > DARK_THRESHOLD && g < SATURATION_THRESHOLD &&
        b > DARK_THRESHOLD && b < SATURATION_THRESHOLD) {
      validCount++;
    }
  }
  
  const meanR = rValues.reduce((a, b) => a + b, 0) / pixelCount;
  const meanG = gValues.reduce((a, b) => a + b, 0) / pixelCount;
  const meanB = bValues.reduce((a, b) => a + b, 0) / pixelCount;
  
  const trimmedMeanR = trimmedMean(rValues, TRIM_PERCENT);
  const trimmedMeanG = trimmedMean(gValues, TRIM_PERCENT);
  const trimmedMeanB = trimmedMean(bValues, TRIM_PERCENT);
  
  const medianR = median(rValues);
  const medianG = median(gValues);
  const medianB = median(bValues);
  
  const saturationRatio = saturatedCount / pixelCount;
  const darkRatio = darkCount / pixelCount;
  const validPixelRatio = validCount / pixelCount;
  
  const redDominance = meanR / (meanG + meanB + EPSILON);
  const greenSignal = meanG;
  const blueSignal = meanB;
  
  return {
    meanR,
    meanG,
    meanB,
    trimmedMeanR,
    trimmedMeanG,
    trimmedMeanB,
    medianR,
    medianG,
    medianB,
    saturationRatio,
    darkRatio,
    validPixelRatio,
    redDominance,
    greenSignal,
    blueSignal,
  };
}

/**
 * Calculate pixel statistics from ROI subset
 */
export function calculateRoiPixelStats(
  imageData: ImageData,
  roi: { x: number; y: number; width: number; height: number }
): PixelStats {
  const { x, y, width, height } = roi;
  const data = imageData.data;
  const imgWidth = imageData.width;
  
  const rValues: number[] = [];
  const gValues: number[] = [];
  const bValues: number[] = [];
  
  let saturatedCount = 0;
  let darkCount = 0;
  let validCount = 0;
  let pixelCount = 0;
  
  for (let ry = y; ry < y + height; ry++) {
    for (let rx = x; rx < x + width; rx++) {
      if (rx < 0 || rx >= imgWidth || ry < 0 || ry >= imageData.height) continue;
      
      const offset = (ry * imgWidth + rx) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      
      rValues.push(r);
      gValues.push(g);
      bValues.push(b);
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
      meanR: 0, meanG: 0, meanB: 0,
      trimmedMeanR: 0, trimmedMeanG: 0, trimmedMeanB: 0,
      medianR: 0, medianG: 0, medianB: 0,
      saturationRatio: 0, darkRatio: 0, validPixelRatio: 0,
      redDominance: 0, greenSignal: 0, blueSignal: 0,
    };
  }
  
  const meanR = rValues.reduce((a, b) => a + b, 0) / pixelCount;
  const meanG = gValues.reduce((a, b) => a + b, 0) / pixelCount;
  const meanB = bValues.reduce((a, b) => a + b, 0) / pixelCount;
  
  const trimmedMeanR = trimmedMean(rValues, TRIM_PERCENT);
  const trimmedMeanG = trimmedMean(gValues, TRIM_PERCENT);
  const trimmedMeanB = trimmedMean(bValues, TRIM_PERCENT);
  
  const medianR = median(rValues);
  const medianG = median(gValues);
  const medianB = median(bValues);
  
  const saturationRatio = saturatedCount / pixelCount;
  const darkRatio = darkCount / pixelCount;
  const validPixelRatio = validCount / pixelCount;
  
  const redDominance = meanR / (meanG + meanB + EPSILON);
  const greenSignal = meanG;
  const blueSignal = meanB;
  
  return {
    meanR,
    meanG,
    meanB,
    trimmedMeanR,
    trimmedMeanG,
    trimmedMeanB,
    medianR,
    medianG,
    medianB,
    saturationRatio,
    darkRatio,
    validPixelRatio,
    redDominance,
    greenSignal,
    blueSignal,
  };
}
