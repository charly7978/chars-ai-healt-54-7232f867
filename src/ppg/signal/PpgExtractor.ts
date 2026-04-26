/**
 * PPG EXTRACTOR
 * 
 * Multi-channel PPG signal extraction with ring buffers.
 * 
 * Rules:
 * - Extract R/G/B linear from ROI
 * - Convert to OD_R/OD_G/OD_B
 * - Maintain ring buffers (minimum 20 seconds)
 * - Use real timestamps, not assumed fps
 * - Calculate real fps with Timebase
 * - Degrade confidence if fps < 18
 * - Mark discontinuity if gaps > 250ms
 * 
 * Signals:
 * - raw.r/g/b
 * - linear.r/g/b
 * - od.r/g/b
 * - g1 = raw green linear mean
 * - g2 = detrended OD green
 * - g3 = filtered OD green (ready for beat detection)
 * - chromSignal (optional)
 * - posSignal (optional)
 * - primarySignal chosen by SQI
 */

import type { RoiBox, RawChannels, LinearChannels, OpticalDensityChannels, GSignals, PpgSample } from './PpgTypes';
import { RingBuffer } from './RingBuffer';
import { Timebase } from './Timebase';
import { srgbToLinear, rgbToLinear } from '../radiometry/SrgbLinearizer';
import { OpticalDensityCalculator } from '../radiometry/OpticalDensity';
import { calculateRoiPixelStats } from '../radiometry/PixelStats';

const BUFFER_DURATION_SEC = 20;
const MIN_FPS = 18;
const GAP_THRESHOLD_MS = 250;

export class PpgExtractor {
  private ringBuffers: {
    rawR: RingBuffer<number>;
    rawG: RingBuffer<number>;
    rawB: RingBuffer<number>;
    linearR: RingBuffer<number>;
    linearG: RingBuffer<number>;
    linearB: RingBuffer<number>;
    odR: RingBuffer<number>;
    odG: RingBuffer<number>;
    odB: RingBuffer<number>;
    g1: RingBuffer<number>;
    g2: RingBuffer<number>;
    g3: RingBuffer<number>;
  };
  
  private timebase: Timebase;
  private odCalculator: OpticalDensityCalculator;
  private roi: RoiBox | null = null;
  private frameCount = 0;
  private lastTimestamp = 0;
  private gapDetected = false;
  
  constructor(sampleRate: number = 30) {
    const bufferSize = Math.ceil(sampleRate * BUFFER_DURATION_SEC);
    
    this.ringBuffers = {
      rawR: new RingBuffer(bufferSize),
      rawG: new RingBuffer(bufferSize),
      rawB: new RingBuffer(bufferSize),
      linearR: new RingBuffer(bufferSize),
      linearG: new RingBuffer(bufferSize),
      linearB: new RingBuffer(bufferSize),
      odR: new RingBuffer(bufferSize),
      odG: new RingBuffer(bufferSize),
      odB: new RingBuffer(bufferSize),
      g1: new RingBuffer(bufferSize),
      g2: new RingBuffer(bufferSize),
      g3: new RingBuffer(bufferSize),
    };
    
    this.timebase = new Timebase();
    this.odCalculator = new OpticalDensityCalculator();
  }

  /**
   * Set ROI for extraction
   */
  setRoi(roi: RoiBox): void {
    this.roi = roi;
  }

  /**
   * Process a frame and extract PPG signals
   */
  processFrame(imageData: ImageData, timestamp: number): PpgSample | null {
    if (!this.roi) return null;
    
    // Update timebase
    const timeState = this.timebase.push(timestamp);
    
    // Check for gap
    if (this.lastTimestamp > 0 && timestamp - this.lastTimestamp > GAP_THRESHOLD_MS) {
      this.gapDetected = true;
    }
    this.lastTimestamp = timestamp;
    
    // Extract pixel stats from ROI
    const stats = calculateRoiPixelStats(imageData, this.roi);
    
    // Raw channels
    const raw: RawChannels = {
      r: stats.meanR,
      g: stats.meanG,
      b: stats.meanB,
    };
    
    // Linear channels
    const linear: LinearChannels = rgbToLinear(raw.r, raw.g, raw.b);
    
    // Optical density
    const odResult = this.odCalculator.calculate(linear.r, linear.g, linear.b);
    const od: OpticalDensityChannels = {
      odR: odResult.odR,
      odG: odResult.odG,
      odB: odResult.odB,
    };
    
    // G1: raw green linear mean
    const g1 = linear.g;
    
    // G2: detrended OD green (simple detrending: subtract EWMA baseline)
    const g2 = this.detrend(od.odG);
    
    // G3: filtered OD green (will be set by bandpass filter later)
    const g3 = g2; // Initially same as G2, will be filtered
    
    const g: GSignals = { g1, g2, g3 };
    
    // Push to ring buffers
    this.ringBuffers.rawR.push(raw.r);
    this.ringBuffers.rawG.push(raw.g);
    this.ringBuffers.rawB.push(raw.b);
    this.ringBuffers.linearR.push(linear.r);
    this.ringBuffers.linearG.push(linear.g);
    this.ringBuffers.linearB.push(linear.b);
    this.ringBuffers.odR.push(od.odR);
    this.ringBuffers.odG.push(od.odG);
    this.ringBuffers.odB.push(od.odB);
    this.ringBuffers.g1.push(g1);
    this.ringBuffers.g2.push(g2);
    this.ringBuffers.g3.push(g3);
    
    this.frameCount++;
    
    return {
      timestamp,
      raw,
      linear,
      od,
      g,
      roi: this.roi,
      fps: timeState.fpsMedian,
    };
  }

  /**
   * Simple detrending: subtract EWMA baseline
   */
  private detrend(signal: number): number {
    const buffer = this.ringBuffers.odG;
    if (buffer.length < 10) return signal;
    
    // Calculate EWMA baseline
    const alpha = 0.02;
    let baseline = buffer.get(0);
    for (let i = 1; i < buffer.length; i++) {
      baseline = baseline + alpha * (buffer.get(i) - baseline);
    }
    
    return signal - baseline;
  }

  /**
   * Update G3 after filtering
   */
  updateG3(filteredG3: number): void {
    this.ringBuffers.g3.push(filteredG3);
  }

  /**
   * Get current G signals
   */
  getGSignals(): GSignals {
    return {
      g1: this.ringBuffers.g1.latest(),
      g2: this.ringBuffers.g2.latest(),
      g3: this.ringBuffers.g3.latest(),
    };
  }

  /**
   * Get G signal history
   */
  getG1History(count: number): number[] {
    const buffer = this.ringBuffers.g1;
    const result: number[] = [];
    const start = Math.max(0, buffer.length - count);
    for (let i = start; i < buffer.length; i++) {
      result.push(buffer.get(i));
    }
    return result;
  }

  getG2History(count: number): number[] {
    const buffer = this.ringBuffers.g2;
    const result: number[] = [];
    const start = Math.max(0, buffer.length - count);
    for (let i = start; i < buffer.length; i++) {
      result.push(buffer.get(i));
    }
    return result;
  }

  getG3History(count: number): number[] {
    const buffer = this.ringBuffers.g3;
    const result: number[] = [];
    const start = Math.max(0, buffer.length - count);
    for (let i = start; i < buffer.length; i++) {
      result.push(buffer.get(i));
    }
    return result;
  }

  /**
   * Get raw channel history
   */
  getRawHistory(count: number): { r: number[]; g: number[]; b: number[] } {
    const startR = Math.max(0, this.ringBuffers.rawR.length - count);
    const startG = Math.max(0, this.ringBuffers.rawG.length - count);
    const startB = Math.max(0, this.ringBuffers.rawB.length - count);
    
    const r: number[] = [];
    const g: number[] = [];
    const b: number[] = [];
    
    for (let i = 0; i < count; i++) {
      if (startR + i < this.ringBuffers.rawR.length) {
        r.push(this.ringBuffers.rawR.get(startR + i));
      }
      if (startG + i < this.ringBuffers.rawG.length) {
        g.push(this.ringBuffers.rawG.get(startG + i));
      }
      if (startB + i < this.ringBuffers.rawB.length) {
        b.push(this.ringBuffers.rawB.get(startB + i));
      }
    }
    
    return { r, g, b };
  }

  /**
   * Get timebase state
   */
  getTimebaseState() {
    return this.timebase.getState();
  }

  /**
   * Get buffer duration
   */
  getBufferDuration(): number {
    if (this.ringBuffers.g1.length < 2) return 0;
    const timeState = this.timebase.getState();
    return (this.ringBuffers.g1.length / timeState.sampleRate) * 1000;
  }

  /**
   * Check if we have enough data
   */
  hasEnoughData(minDurationSec: number): boolean {
    const durationMs = this.getBufferDuration();
    return durationMs >= minDurationSec * 1000;
  }

  /**
   * Reset extractor
   */
  reset(): void {
    Object.values(this.ringBuffers).forEach(buffer => buffer.clear());
    this.timebase.reset();
    this.odCalculator.reset();
    this.frameCount = 0;
    this.lastTimestamp = 0;
    this.gapDetected = false;
  }

  /**
   * Get frame count
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Check if gap was detected
   */
  isGapDetected(): boolean {
    return this.gapDetected;
  }
}
