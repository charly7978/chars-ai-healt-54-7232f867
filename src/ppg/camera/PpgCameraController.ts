/**
 * PPG CAMERA CONTROLLER
 * 
 * Single source of truth for rear camera + torch + frame capture.
 * 
 * Rules:
 * - Rear camera only (facingMode: "environment")
 * - High resolution (1920x1080 ideal, 1280x720 minimum)
 * - High frame rate (60 fps ideal, 30 fps fallback)
 * - Torch enabled and maintained during measurement
 * - No parallel streams, no duplicate refs
 * - Real ImageData capture via requestVideoFrameCallback
 */

export interface CameraConfig {
  idealWidth: number;
  idealHeight: number;
  minWidth: number;
  minHeight: number;
  idealFrameRate: number;
  minFrameRate: number;
}

export interface CameraStatus {
  state: 'idle' | 'requesting' | 'ready' | 'torch_on' | 'measuring' | 'error';
  videoWidth: number;
  videoHeight: number;
  actualFrameRate: number;
  torchSupported: boolean;
  torchActive: boolean;
  trackLabel: string;
  error?: string;
}

export interface FrameData {
  imageData: ImageData;
  timestamp: number;
  frameIndex: number;
  videoWidth: number;
  videoHeight: number;
  fps: number;
}

export type FrameCallback = (frame: FrameData) => void;
export type StatusCallback = (status: CameraStatus) => void;

const DEFAULT_CONFIG: CameraConfig = {
  idealWidth: 1920,
  idealHeight: 1080,
  minWidth: 1280,
  minHeight: 720,
  idealFrameRate: 60,
  minFrameRate: 30,
};

export class PpgCameraController {
  private config: CameraConfig;
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  
  private isMeasuring = false;
  private frameIndex = 0;
  private frameCallback: FrameCallback | null = null;
  private statusCallback: StatusCallback | null = null;
  
  private torchWatchdogInterval: number | null = null;
  private lastFrameTime = 0;
  private frameTimestamps: number[] = [];
  private readonly FPS_WINDOW_MS = 1000;
  private readonly MAX_TIMESTAMP_SAMPLES = 60;
  
  private rafId: number | null = null;
  private rvfcId: number | null = null;
  
  private currentStatus: CameraStatus = {
    state: 'idle',
    videoWidth: 0,
    videoHeight: 0,
    actualFrameRate: 0,
    torchSupported: false,
    torchActive: false,
    trackLabel: '',
  };

  constructor(config: Partial<CameraConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set up video element for capture
   */
  setVideoElement(video: HTMLVideoElement): void {
    this.videoElement = video;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
  }

  /**
   * Set up offscreen canvas for frame capture
   */
  private ensureCanvas(): void {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  /**
   * Update status and notify callback
   */
  private updateStatus(partial: Partial<CameraStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...partial };
    this.statusCallback?.(this.currentStatus);
  }

  /**
   * Request rear camera with specified constraints
   */
  private async requestCamera(): Promise<MediaStream> {
    this.updateStatus({ state: 'requesting' });

    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: { exact: 'environment' },
        width: { ideal: this.config.idealWidth, min: this.config.minWidth },
        height: { ideal: this.config.idealHeight, min: this.config.minHeight },
        frameRate: { ideal: this.config.idealFrameRate, min: this.config.minFrameRate },
      },
      audio: false,
    };

    try {
      let stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream;
    } catch (exactError) {
      console.warn('Exact facingMode failed, trying fallback:', exactError);
      
      const fallbackConstraints: MediaStreamConstraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: this.config.idealWidth, min: this.config.minWidth },
          height: { ideal: this.config.idealHeight, min: this.config.minHeight },
          frameRate: { ideal: this.config.idealFrameRate, min: this.config.minFrameRate },
        },
        audio: false,
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        return stream;
      } catch (fallbackError) {
        throw new Error(`Camera request failed: exact=${exactError.message}, fallback=${fallbackError.message}`);
      }
    }
  }

  /**
   * Enable torch on the video track
   */
  private async enableTorch(track: MediaStreamTrack): Promise<boolean> {
    try {
      const capabilities = track.getCapabilities?.() as any;
      const settings = track.getSettings?.() as any;
      
      if (capabilities?.torch === false) {
        console.warn('Torch not supported by device');
        this.updateStatus({ torchSupported: false });
        return false;
      }

      this.updateStatus({ torchSupported: true });

      await track.applyConstraints({
        advanced: [{ torch: true }] as any,
      });

      this.updateStatus({ torchActive: true });
      console.log('Torch enabled successfully');
      return true;
    } catch (error) {
      console.warn('Torch enable failed:', error);
      this.updateStatus({ torchSupported: false, torchActive: false });
      return false;
    }
  }

  /**
   * Watchdog to keep torch alive (re-apply every 2 seconds)
   */
  private startTorchWatchdog(track: MediaStreamTrack): void {
    this.torchWatchdogInterval = window.setInterval(async () => {
      if (!this.isMeasuring) return;
      
      try {
        const settings = track.getSettings?.() as any;
        if (settings?.torch !== true) {
          console.log('Torch watchdog: re-enabling torch');
          await track.applyConstraints({ advanced: [{ torch: true }] as any });
          this.updateStatus({ torchActive: true });
        }
      } catch (error) {
        console.warn('Torch watchdog failed:', error);
      }
    }, 2000);
  }

  private stopTorchWatchdog(): void {
    if (this.torchWatchdogInterval !== null) {
      clearInterval(this.torchWatchdogInterval);
      this.torchWatchdogInterval = null;
    }
  }

  /**
   * Calculate rolling FPS from frame timestamps
   */
  private calculateFPS(): number {
    const now = performance.now();
    this.frameTimestamps.push(now);
    
    // Remove timestamps older than FPS_WINDOW_MS
    while (this.frameTimestamps.length > 0 && 
           now - this.frameTimestamps[0] > this.FPS_WINDOW_MS) {
      this.frameTimestamps.shift();
    }
    
    if (this.frameTimestamps.length < 2) return 0;
    
    const duration = now - this.frameTimestamps[0];
    return (this.frameTimestamps.length - 1) / (duration / 1000);
  }

  /**
   * Capture a single frame from video to canvas
   */
  private captureFrame(): FrameData | null {
    if (!this.videoElement || !this.canvas || !this.ctx) return null;
    
    const video = this.videoElement;
    
    // Wait for video to be ready
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // Size canvas to match video (scaled if needed)
    const scale = Math.min(1, 640 / video.videoWidth);
    const width = Math.max(320, Math.round(video.videoWidth * scale));
    const height = Math.max(240, Math.round(video.videoHeight * scale));
    
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    try {
      this.ctx.drawImage(video, 0, 0, width, height);
      const imageData = this.ctx.getImageData(0, 0, width, height);
      
      const fps = this.calculateFPS();
      const timestamp = performance.now();
      
      this.frameIndex++;
      this.lastFrameTime = timestamp;
      
      return {
        imageData,
        timestamp,
        frameIndex: this.frameIndex,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        fps,
      };
    } catch (error) {
      console.error('Frame capture error:', error);
      return null;
    }
  }

  /**
   * Frame loop using requestVideoFrameCallback (preferred) or requestAnimationFrame
   */
  private startFrameLoop(): void {
    if (!this.videoElement) return;

    const video = this.videoElement;

    const processFrame = (now: number, metadata?: any) => {
      if (!this.isMeasuring) return;

      const frame = this.captureFrame();
      if (frame && this.frameCallback) {
        this.frameCallback(frame);
      }

      // Schedule next frame
      if ('requestVideoFrameCallback' in video) {
        this.rvfcId = (video as any).requestVideoFrameCallback(processFrame);
      } else {
        this.rafId = requestAnimationFrame((t) => processFrame(t));
      }
    };

    // Start the loop
    if ('requestVideoFrameCallback' in video) {
      this.rvfcId = (video as any).requestVideoFrameCallback(processFrame);
    } else {
      this.rafId = requestAnimationFrame(processFrame);
    }
  }

  private stopFrameLoop(): void {
    if (this.rvfcId !== null && this.videoElement) {
      (this.videoElement as any).cancelVideoFrameCallback?.(this.rvfcId);
      this.rvfcId = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Start measurement: open camera, enable torch, start frame loop
   */
  async startMeasurement(
    onFrame: FrameCallback,
    onStatus: StatusCallback
  ): Promise<void> {
    if (this.isMeasuring) {
      console.warn('Already measuring');
      return;
    }

    this.frameCallback = onFrame;
    this.statusCallback = onStatus;
    this.ensureCanvas();

    try {
      // Request camera
      this.stream = await this.requestCamera();
      
      // Get video track
      const videoTracks = this.stream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error('No video track in stream');
      }
      
      const videoTrack = videoTracks[0];
      const trackSettings = videoTrack.getSettings?.() as any;
      const trackLabel = videoTrack.label || 'unknown';
      
      this.updateStatus({
        trackLabel,
        videoWidth: trackSettings?.width || 0,
        videoHeight: trackSettings?.height || 0,
      });

      // Attach stream to video element
      if (this.videoElement) {
        this.videoElement.srcObject = this.stream;
        await this.videoElement.play();
      }

      // Wait for video to be ready
      await new Promise<void>((resolve, reject) => {
        if (!this.videoElement) {
          reject(new Error('Video element not set'));
          return;
        }

        const checkReady = () => {
          if (this.videoElement!.readyState >= 2 && 
              this.videoElement!.videoWidth > 0) {
            this.updateStatus({
              state: 'ready',
              videoWidth: this.videoElement!.videoWidth,
              videoHeight: this.videoElement!.videoHeight,
            });
            resolve();
          } else {
            setTimeout(checkReady, 50);
          }
        };

        const timeout = setTimeout(() => {
          reject(new Error('Video ready timeout'));
        }, 5000);

        checkReady().then(() => clearTimeout(timeout));
      });

      // Enable torch
      await this.enableTorch(videoTrack);
      this.updateStatus({ state: 'torch_on' });

      // Start torch watchdog
      this.startTorchWatchdog(videoTrack);

      // Start frame loop
      this.isMeasuring = true;
      this.frameIndex = 0;
      this.frameTimestamps = [];
      this.updateStatus({ state: 'measuring' });
      this.startFrameLoop();

      // Handle track ended
      videoTrack.addEventListener('ended', () => {
        console.warn('Video track ended, restarting...');
        this.restartOnEnded();
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({ state: 'error', error: message });
      this.stopMeasurement();
      throw error;
    }
  }

  /**
   * Stop measurement: stop frame loop, disable torch, release stream
   */
  stopMeasurement(): void {
    this.isMeasuring = false;
    this.stopFrameLoop();
    this.stopTorchWatchdog();

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.updateStatus({
      state: 'idle',
      torchActive: false,
      videoWidth: 0,
      videoHeight: 0,
      actualFrameRate: 0,
    });

    this.frameCallback = null;
    this.statusCallback = null;
  }

  /**
   * Restart if track ends
   */
  private async restartOnEnded(): Promise<void> {
    if (!this.isMeasuring) return;

    console.log('Restarting camera after track ended...');
    
    const onFrame = this.frameCallback;
    const onStatus = this.statusCallback;
    
    this.stopMeasurement();
    
    // Small delay before restart
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (onFrame && onStatus) {
      try {
        await this.startMeasurement(onFrame, onStatus);
      } catch (error) {
        console.error('Restart failed:', error);
      }
    }
  }

  /**
   * Get current status
   */
  getStatus(): CameraStatus {
    return { ...this.currentStatus };
  }

  /**
   * Check if currently measuring
   */
  isActive(): boolean {
    return this.isMeasuring;
  }
}
