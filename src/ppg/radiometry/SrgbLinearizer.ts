/**
 * SRGB LINEARIZER
 * 
 * Converts sRGB 8-bit values to linear intensity according to IEC 61966-2-1.
 * 
 * Formula:
 * if c <= 0.04045:
 *   linear = c / 12.92
 * else:
 *   linear = ((c + 0.055) / 1.055) ** 2.4
 * 
 * This is necessary because cameras apply gamma compression (~2.2) which
 * compresses pulsatility. Optical density calculations require linear light.
 */

/**
 * Convert a single sRGB 8-bit value (0-255) to linear intensity [0-1]
 */
export function srgbToLinear(c8: number): number {
  const x = Math.max(0, Math.min(255, c8)) / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * Convert linear intensity [0-1] back to sRGB 8-bit (0-255)
 * Inverse of srgbToLinear
 */
export function linearToSrgb(linear: number): number {
  const x = Math.max(0, Math.min(1, linear));
  const srgb = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

/**
 * Convert RGB triplet from sRGB to linear
 */
export function rgbToLinear(r: number, g: number, b: number): { r: number; g: number; b: number } {
  return {
    r: srgbToLinear(r),
    g: srgbToLinear(g),
    b: srgbToLinear(b),
  };
}

/**
 * Convert RGB triplet from linear to sRGB
 */
export function linearToRgb(linearR: number, linearG: number, linearB: number): { r: number; g: number; b: number } {
  return {
    r: linearToSrgb(linearR),
    g: linearToSrgb(linearG),
    b: linearToSrgb(linearB),
  };
}

/**
 * Process ImageData pixel array and return linear RGB arrays
 * Returns separate arrays for R, G, B channels in linear space
 */
export function imageDataToLinear(imageData: ImageData): {
  rLinear: Float64Array;
  gLinear: Float64Array;
  bLinear: Float64Array;
} {
  const data = imageData.data;
  const pixelCount = data.length / 4;
  
  const rLinear = new Float64Array(pixelCount);
  const gLinear = new Float64Array(pixelCount);
  const bLinear = new Float64Array(pixelCount);
  
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    rLinear[i] = srgbToLinear(data[offset]);
    gLinear[i] = srgbToLinear(data[offset + 1]);
    bLinear[i] = srgbToLinear(data[offset + 2]);
  }
  
  return { rLinear, gLinear, bLinear };
}
