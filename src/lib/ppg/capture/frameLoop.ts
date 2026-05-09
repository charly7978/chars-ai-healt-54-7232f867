import { PPG_CONFIG } from "../types";

/**
 * Loop de cuadros con requestVideoFrameCallback (rVFC).
 * Usa metadata.mediaTime / presentedFrames para timing real y detección de drops.
 * Fallback a setTimeout(performance.now) si rVFC no está disponible.
 */
export interface FrameMeta {
  presentedFrames?: number;
  mediaTime?: number;
  expectedDisplayTime?: number;
}

export class FrameLoop {
  private isRunning = false;
  private rvfcId = 0;
  private fallbackId: ReturnType<typeof setInterval> | null = null;
  private lastPresentedFrames = 0;
  private droppedFrames = 0;
  private totalFrames = 0;

  constructor(
    private video: HTMLVideoElement,
    private onFrame: (t: number, meta?: FrameMeta) => void
  ) {}

  get droppedFrameRatio(): number {
    return this.totalFrames > 0 ? this.droppedFrames / this.totalFrames : 0;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const rvfc = (this.video as any).requestVideoFrameCallback?.bind(this.video);
    if (rvfc) {
      const loop = (_now: number, metadata: any) => {
        if (!this.isRunning) return;
        this.totalFrames++;
        if (this.lastPresentedFrames > 0 && typeof metadata?.presentedFrames === "number") {
          const delta = metadata.presentedFrames - this.lastPresentedFrames - 1;
          if (delta > 0) this.droppedFrames += delta;
        }
        if (typeof metadata?.presentedFrames === "number") {
          this.lastPresentedFrames = metadata.presentedFrames;
        }
        this.onFrame(performance.now(), metadata as FrameMeta);
        this.rvfcId = rvfc(loop);
      };
      this.rvfcId = rvfc(loop);
    } else {
      this.fallbackId = setInterval(() => {
        if (!this.isRunning) return;
        this.totalFrames++;
        this.onFrame(performance.now());
      }, 1000 / PPG_CONFIG.TARGET_FPS);
    }
  }

  stop(): void {
    this.isRunning = false;
    const cancel = (this.video as any).cancelVideoFrameCallback?.bind(this.video);
    if (this.rvfcId && cancel) cancel(this.rvfcId);
    if (this.fallbackId) { clearInterval(this.fallbackId); this.fallbackId = null; }
    this.rvfcId = 0;
    this.lastPresentedFrames = 0;
    this.droppedFrames = 0;
    this.totalFrames = 0;
  }
}
