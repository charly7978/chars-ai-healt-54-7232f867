/**
 * FRAME SAMPLER
 * 
 * Captures real ImageData from video element using requestVideoFrameCallback.
 * 
 * Rules:
 * - Use requestVideoFrameCallback if available
 * - Fallback to requestAnimationFrame with timestamp control
 * - Draw video to offscreen canvas with { willReadFrequently: true }
 * - Read real ImageData with ctx.getImageData()
 * - Include timestamp, frameIndex, fps in each frame
 * - Emit error if getImageData fails
 * - Never process without real camera frame
 */

export interface SampledFrame {
  imageData: ImageData;
  timestamp: number;
  frameIndex: number;
  videoWidth: number;
  videoHeight: number;
  fps: number;
}

export interface SamplerConfig {
  maxCaptureWidth: number;
  minCaptureWidth: number;
  minCaptureHeight: number;
}

export class FrameSampler {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private config: SamplerConfig;
  
  private frameIndex = 0;
  private frameTimestamps: number[] = [];
  private readonly FPS_WINDOW_MS = 1000;
  private readonly MAX_TIMESTAMP_SAMPLES = 60;
  
  private rafId: number | null = null;
  private rvfcId: number | null = null;
  private isSampling = false;
  
  private videoElement: HTMLVideoElement | null = null;
  private onFrame: ((frame: SampledFrame) => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  constructor(config: Partial<SamplerConfig> = {}) {
    this.config = {
      maxCaptureWidth: 640,
      minCaptureWidth: 320,
      minCaptureHeight: 240,
      ...config,
    };
  }

  /**
   * Set video element to sample from
   */
  setVideoElement(video: HTMLVideoElement): void {
    this.videoElement = video;
  }

  /**
   * Ensure canvas is created with willReadFrequently
   */
  private ensureCanvas(): void {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  /**
   * Calculate rolling FPS
   */
  private calculateFPS(): number {
    const now = performance.now();
    this.frameTimestamps.push(now);
    
    while (this.frameTimestamps.length > 0 && 
           now - this.frameTimestamps[0] > this.FPS_WINDOW_MS) {
      this.frameTimestamps.shift();
    }
    
    if (this.frameTimestamps.length < 2) return 0;
    
    const duration = now - this.frameTimestamps[0];
    return (this.frameTimestamps.length - 1) / (duration / 1000);
  }

  /**
   * Size canvas to match video (with scaling)
   */
  private sizeCanvasToVideo(): void {
    if (!this.videoElement || !this.canvas || !this.ctx) return;
    
    const video = this.videoElement;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    
    if (!vw || !vh) return;
    
    const scale = Math.min(1, this.config.maxCaptureWidth / vw);
    const width = Math.max(this.config.minCaptureWidth, Math.round(vw * scale));
    const height = Math.max(this.config.minCaptureHeight, Math.round(vh * scale));
    
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Capture a single frame
   */
  private captureFrame(): SampledFrame | null {
    if (!this.videoElement || !this.canvas || !this.ctx) return null;
    
    const video = this.videoElement;
    
    // Check video is ready
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    this.sizeCanvasToVideo();

    try {
      this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      
      const fps = this.calculateFPS();
      const timestamp = performance.now();
      
      this.frameIndex++;
      
      return {
        imageData,
        timestamp,
        frameIndex: this.frameIndex,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        fps,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError?.(`Frame capture error: ${message}`);
      return null;
    }
  }

  /**
   * Start sampling loop
   */
  start(
    onFrame: (frame: SampledFrame) => void,
    onError: (error: string) => void
  ): void {
    if (this.isSampling) {
      console.warn('Already sampling');
      return;
    }

    this.onFrame = onFrame;
    this.onError = onError;
    this.ensureCanvas();
    this.isSampling = true;
    this.frameIndex = 0;
    this.frameTimestamps = [];

    this.scheduleNext();
  }

  /**
   * Schedule next frame capture
   */
  private scheduleNext(): void {
    if (!this.isSampling || !this.videoElement) return;

    const video = this.videoElement;

    if ('requestVideoFrameCallback' in video) {
      this.rvfcId = (video as any).requestVideoFrameCallback(
        (_now: number, metadata: { mediaTime?: number; presentationTime?: number }) => {
          if (!this.isSampling) return;
          
          const frame = this.captureFrame();
          if (frame && this.onFrame) {
            this.onFrame(frame);
          }
          
          this.scheduleNext();
        }
      );
    } else {
      this.rafId = requestAnimationFrame(() => {
        if (!this.isSampling) return;
        
        const frame = this.captureFrame();
        if (frame && this.onFrame) {
          this.onFrame(frame);
        }
        
        this.scheduleNext();
      });
    }
  }

  /**
   * Stop sampling
   */
  stop(): void {
    this.isSampling = false;
    
    if (this.rvfcId !== null && this.videoElement) {
      (this.videoElement as any).cancelVideoFrameCallback?.(this.rvfcId);
      this.rvfcId = null;
    }
    
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    
    this.onFrame = null;
    this.onError = null;
  }

  /**
   * Check if currently sampling
   */
  isActive(): boolean {
    return this.isSampling;
  }

  /**
   * Get current frame index
   */
  getFrameIndex(): number {
    return this.frameIndex;
  }
}
