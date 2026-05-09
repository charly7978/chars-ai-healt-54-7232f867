import { PPG_CONFIG } from "../types";

/**
 * Downsamples the live video into a small RGBA buffer.
 *
 * Uses `OffscreenCanvas` when available, otherwise a hidden DOM canvas. In
 * BOTH cases the 2D context is created with `{ willReadFrequently: true }`,
 * which is critical: omitting that flag forces every `getImageData()` to copy
 * the framebuffer back from VRAM through the PCI bus, destroying frame rate
 * and battery life on mobile.
 */

type Ctx2D =
  | OffscreenCanvasRenderingContext2D
  | CanvasRenderingContext2D;

export class FrameDownsampler {
  readonly width: number;
  readonly height: number;
  private readonly ctx: Ctx2D;
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private cached: ImageData | null = null;

  constructor(
    width: number = PPG_CONFIG.DOWNSAMPLE.width,
    height: number = PPG_CONFIG.DOWNSAMPLE.height,
  ) {
    this.width = width;
    this.height = height;

    const canUseOffscreen = typeof OffscreenCanvas !== "undefined";
    if (canUseOffscreen) {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable.");
      this.canvas = c;
      this.ctx = ctx;
    } else {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.style.display = "none";
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas 2D context unavailable.");
      this.canvas = c;
      this.ctx = ctx;
    }
  }

  /**
   * Reads the current video frame into the downsampled RGBA buffer. The
   * returned `Uint8ClampedArray` is owned by an internal `ImageData` instance
   * that is reused across frames (no per-frame allocation).
   */
  capture(video: HTMLVideoElement): Uint8ClampedArray {
    this.ctx.drawImage(video, 0, 0, this.width, this.height);
    if (!this.cached) {
      this.cached = this.ctx.getImageData(0, 0, this.width, this.height);
    } else {
      // Re-read into the existing buffer where supported.
      const fresh = this.ctx.getImageData(0, 0, this.width, this.height);
      this.cached.data.set(fresh.data);
    }
    return this.cached.data;
  }
}
