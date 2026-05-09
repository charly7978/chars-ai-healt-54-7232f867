/**
 * Frame loop driven by `requestVideoFrameCallback` when available, with a
 * `requestAnimationFrame` fallback. Reports real jitter and dropped frames
 * derived from the platform-provided metadata, never `Date.now()`.
 */

export interface FrameTiming {
  readonly timestamp: number;
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly droppedFrames: number;
  readonly fpsInstant: number;
}

interface RVFCMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
}

type RVFCallback = (now: number, metadata: RVFCMetadata) => void;

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: RVFCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type FrameTickHandler = (timing: FrameTiming) => void;

export class FrameLoop {
  private handle = 0;
  private rafHandle = 0;
  private running = false;
  private lastMediaTime = 0;
  private lastPresented = 0;
  private lastTimestamp = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onTick: FrameTickHandler,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMediaTime = 0;
    this.lastPresented = 0;
    this.lastTimestamp = 0;

    const v = this.video as RVFCVideo;
    if (typeof v.requestVideoFrameCallback === "function") {
      this.scheduleRVFC(v);
    } else {
      this.scheduleRAF();
    }
  }

  stop(): void {
    this.running = false;
    const v = this.video as RVFCVideo;
    if (this.handle && typeof v.cancelVideoFrameCallback === "function") {
      v.cancelVideoFrameCallback(this.handle);
    }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.handle = 0;
    this.rafHandle = 0;
  }

  private scheduleRVFC(v: RVFCVideo): void {
    const fn = v.requestVideoFrameCallback;
    if (!fn) return;
    this.handle = fn.call(v, (now, meta) => {
      if (!this.running) return;
      const dtMedia = meta.mediaTime - this.lastMediaTime;
      const presentedDelta = meta.presentedFrames - this.lastPresented;
      const dropped = Math.max(0, presentedDelta - 1);
      const fpsInstant = dtMedia > 0 ? 1 / dtMedia : 0;

      this.onTick({
        timestamp: meta.presentationTime,
        mediaTime: meta.mediaTime,
        presentedFrames: meta.presentedFrames,
        droppedFrames: dropped,
        fpsInstant,
      });

      this.lastMediaTime = meta.mediaTime;
      this.lastPresented = meta.presentedFrames;
      this.scheduleRVFC(v);
    });
  }

  private scheduleRAF(): void {
    this.rafHandle = requestAnimationFrame((now) => {
      if (!this.running) return;
      const dt = this.lastTimestamp > 0 ? (now - this.lastTimestamp) / 1000 : 0;
      const fpsInstant = dt > 0 ? 1 / dt : 0;
      this.onTick({
        timestamp: now,
        mediaTime: now / 1000,
        presentedFrames: this.lastPresented + 1,
        droppedFrames: 0,
        fpsInstant,
      });
      this.lastPresented += 1;
      this.lastTimestamp = now;
      this.scheduleRAF();
    });
  }
}
