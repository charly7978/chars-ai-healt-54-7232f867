/**
 * TIMEBASE
 * 
 * Manages real-time timestamps and sample rate estimation.
 * 
 * Rules:
 * - Use real timestamps from requestVideoFrameCallback
 * - Don't assume fixed fps
 * - Calculate fps from actual timestamp differences
 * - Detect gaps > 250ms as discontinuities
 * - Degrade confidence if fps < 18
 */

export interface TimebaseState {
  sampleRate: number;
  fpsMedian: number;
  fpsInstant: number;
  confidence: number;
  lastTimestamp: number;
  gapDetected: boolean;
}

const FPS_WINDOW_MS = 1000;
const MAX_TIMESTAMP_SAMPLES = 60;
const MIN_FPS = 18;
const GAP_THRESHOLD_MS = 250;

export class Timebase {
  private timestamps: number[] = [];
  private lastTimestamp = 0;
  private sampleRate = 30;
  private confidence = 1.0;
  private gapDetected = false;

  /**
   * Add a new timestamp
   */
  push(timestamp: number): TimebaseState {
    if (this.lastTimestamp > 0) {
      const dt = timestamp - this.lastTimestamp;
      
      // Detect gap
      if (dt > GAP_THRESHOLD_MS) {
        this.gapDetected = true;
        this.confidence = Math.max(0.5, this.confidence - 0.2);
      }
      
      // Add to window
      this.timestamps.push(timestamp);
      
      // Remove old timestamps
      const cutoff = timestamp - FPS_WINDOW_MS;
      while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
        this.timestamps.shift();
      }
    }
    
    this.lastTimestamp = timestamp;
    
    // Calculate fps
    const fpsState = this.calculateFps();
    
    // Update sample rate
    if (fpsState.fpsMedian > 0) {
      this.sampleRate = fpsState.fpsMedian;
    }
    
    // Degrade confidence if fps is low
    if (fpsState.fpsMedian < MIN_FPS) {
      this.confidence = Math.max(0.3, this.confidence - 0.1);
    }
    
    return {
      sampleRate: this.sampleRate,
      fpsMedian: fpsState.fpsMedian,
      fpsInstant: fpsState.fpsInstant,
      confidence: this.confidence,
      lastTimestamp: this.lastTimestamp,
      gapDetected: this.gapDetected,
    };
  }

  /**
   * Calculate fps from timestamp window
   */
  private calculateFps(): { fpsMedian: number; fpsInstant: number } {
    if (this.timestamps.length < 2) {
      return { fpsMedian: 0, fpsInstant: 0 };
    }
    
    // Calculate instantaneous fps
    const lastTwo = this.timestamps.slice(-2);
    const fpsInstant = 1000 / (lastTwo[1] - lastTwo[0]);
    
    // Calculate median fps from window
    const intervals: number[] = [];
    for (let i = 1; i < this.timestamps.length; i++) {
      intervals.push(this.timestamps[i] - this.timestamps[i - 1]);
    }
    
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];
    const fpsMedian = 1000 / medianInterval;
    
    return { fpsMedian, fpsInstant };
  }

  /**
   * Get current sample rate
   */
  getSampleRate(): number {
    return this.sampleRate;
  }

  /**
   * Get current state
   */
  getState(): TimebaseState {
    const fpsState = this.calculateFps();
    return {
      sampleRate: this.sampleRate,
      fpsMedian: fpsState.fpsMedian,
      fpsInstant: fpsState.fpsInstant,
      confidence: this.confidence,
      lastTimestamp: this.lastTimestamp,
      gapDetected: this.gapDetected,
    };
  }

  /**
   * Reset timebase
   */
  reset(): void {
    this.timestamps = [];
    this.lastTimestamp = 0;
    this.sampleRate = 30;
    this.confidence = 1.0;
    this.gapDetected = false;
  }

  /**
   * Check if we have enough data
   */
  hasEnoughData(minDurationMs: number): boolean {
    if (this.timestamps.length < 2) return false;
    const duration = this.lastTimestamp - this.timestamps[0];
    return duration >= minDurationMs;
  }
}
