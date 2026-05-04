/**
 * FrameTimingEstimator
 * --------------------
 * Tracks REAL inter-frame timing using requestVideoFrameCallback metadata
 * (`mediaTime` / `presentationTime` / `expectedDisplayTime`) when available,
 * with a `performance.now()` fallback. Computes a robust sample rate via
 * a trimmed moving median of inter-frame deltas — resilient to jank spikes
 * and OS scheduling jitter.
 *
 * Hot-path budget: O(1) per frame, ring buffer, no allocations.
 */

const RING = 32; // ~1 s @ 30fps

export interface FrameTiming {
  /** Best-estimate timestamp for this frame in performance.now() domain. */
  timestamp: number;
  /** Inter-frame interval, ms. */
  dtMs: number;
  /** Robust effective fps over the recent window. */
  fps: number;
  /** True if this frame's dt looks like a dropped/late frame. */
  dropped: boolean;
  /** Cumulative dropped frames since last reset(). */
  droppedCount: number;
  /** Cumulative frames seen since last reset(). */
  frameCount: number;
  /** Source of the timestamp. */
  source: 'rvfc-mediaTime' | 'rvfc-presentationTime' | 'rvfc-now' | 'performance.now';
}

export class FrameTimingEstimator {
  private dts = new Float32Array(RING);
  private idx = 0;
  private filled = 0;
  private lastTs = -1;
  private lastMediaTime = -1;
  private droppedCount = 0;
  private frameCount = 0;
  // Scratch buffer for median (avoid allocation per frame)
  private scratch = new Float32Array(RING);

  reset(): void {
    this.idx = 0;
    this.filled = 0;
    this.lastTs = -1;
    this.lastMediaTime = -1;
    this.droppedCount = 0;
    this.frameCount = 0;
  }

  /**
   * Feed a frame. Pass the rVFC `metadata` object when available, otherwise
   * leave it undefined for performance.now() fallback.
   */
  push(metadata?: VideoFrameCallbackMetadata): FrameTiming {
    let timestamp: number;
    let source: FrameTiming['source'];

    if (metadata && typeof metadata.mediaTime === 'number' && metadata.mediaTime > 0) {
      // mediaTime is in seconds, monotonic for the stream — most accurate
      const mtMs = metadata.mediaTime * 1000;
      timestamp = mtMs;
      source = 'rvfc-mediaTime';
    } else if (metadata && typeof metadata.presentationTime === 'number') {
      timestamp = metadata.presentationTime;
      source = 'rvfc-presentationTime';
    } else if (metadata && typeof (metadata as any).expectedDisplayTime === 'number') {
      timestamp = (metadata as any).expectedDisplayTime;
      source = 'rvfc-now';
    } else {
      timestamp = performance.now();
      source = 'performance.now';
    }

    let dt = 0;
    if (this.lastTs >= 0) {
      dt = timestamp - this.lastTs;
      if (dt > 0 && dt < 1000) {
        this.dts[this.idx] = dt;
        this.idx = (this.idx + 1) % RING;
        if (this.filled < RING) this.filled++;
      }
    }
    this.lastTs = timestamp;
    this.frameCount++;

    const fps = this.computeFps();
    // Heuristic: dropped if dt > 1.7× expected interval
    const expected = fps > 0 ? 1000 / fps : 33.33;
    const dropped = dt > expected * 1.7 && dt > 0;
    if (dropped) this.droppedCount++;

    return {
      timestamp,
      dtMs: dt,
      fps,
      dropped,
      droppedCount: this.droppedCount,
      frameCount: this.frameCount,
      source,
    };
  }

  /** Robust fps via trimmed median of recent dts. */
  private computeFps(): number {
    if (this.filled < 4) return 0;
    // Copy filled portion to scratch
    for (let i = 0; i < this.filled; i++) this.scratch[i] = this.dts[i];
    // Partial sort — small N, in-place insertion sort is fine
    const n = this.filled;
    for (let i = 1; i < n; i++) {
      const v = this.scratch[i];
      let j = i - 1;
      while (j >= 0 && this.scratch[j] > v) { this.scratch[j + 1] = this.scratch[j]; j--; }
      this.scratch[j + 1] = v;
    }
    // Trim 12.5% on each side, average remainder
    const trim = Math.floor(n * 0.125);
    let sum = 0; let count = 0;
    for (let i = trim; i < n - trim; i++) { sum += this.scratch[i]; count++; }
    const medianDt = count > 0 ? sum / count : this.scratch[n >> 1];
    return medianDt > 0 ? 1000 / medianDt : 0;
  }

  /** Lightweight read-only snapshot for telemetry. */
  snapshot(): { fps: number; droppedCount: number; frameCount: number } {
    return { fps: this.computeFps(), droppedCount: this.droppedCount, frameCount: this.frameCount };
  }
}

// Minimal type for environments where TS lib doesn't ship rVFC types yet
interface VideoFrameCallbackMetadata {
  presentationTime: number;
  expectedDisplayTime?: number;
  width?: number;
  height?: number;
  mediaTime?: number;
  presentedFrames?: number;
  processingDuration?: number;
}
