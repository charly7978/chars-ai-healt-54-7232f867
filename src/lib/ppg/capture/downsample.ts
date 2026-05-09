import { PPG_CONFIG } from "../types";

/**
 * Downsampler con willReadFrequently:true.
 * Mantiene la matriz de píxeles en RAM CPU (no VRAM) — getImageData zero-copy bottleneck.
 */
export class Downsampler {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(width = PPG_CONFIG.DOWNSAMPLE_WIDTH, height = PPG_CONFIG.DOWNSAMPLE_HEIGHT) {
    this.width = width;
    this.height = height;
    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(width, height);
    } else {
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      this.canvas = c;
    }
    this.ctx = (this.canvas as any).getContext("2d", { willReadFrequently: true })!;
  }

  getPixels(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): {
    data: Uint8ClampedArray; width: number; height: number;
  } {
    (this.ctx as any).drawImage(source, 0, 0, this.width, this.height);
    const img = (this.ctx as any).getImageData(0, 0, this.width, this.height);
    return { data: img.data, width: this.width, height: this.height };
  }
}
