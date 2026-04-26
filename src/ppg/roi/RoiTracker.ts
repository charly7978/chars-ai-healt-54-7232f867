/**
 * ROI TRACKER
 * 
 * Tracks ROI position over time with Kalman-like smoothing.
 * 
 * Rules:
 * - Smooth ROI position changes
 * - Handle ROI drift
 * - Maintain ROI size stability
 * - Don't block measurement on ROI changes
 */

import type { RoiBox } from './RoiScanner';

export interface RoiTrackerState {
  currentRoi: RoiBox;
  velocityX: number;
  velocityY: number;
  stabilityScore: number;
  driftDetected: boolean;
}

const SMOOTHING_FACTOR = 0.1;
const VELOCITY_SMOOTHING = 0.05;
const DRIFT_THRESHOLD = 20; // pixels
const STABILITY_WINDOW = 30; // frames

export class RoiTracker {
  private state: RoiTrackerState;
  private history: RoiBox[] = [];
  private frameCount = 0;

  constructor(initialRoi: RoiBox) {
    this.state = {
      currentRoi: { ...initialRoi },
      velocityX: 0,
      velocityY: 0,
      stabilityScore: 1.0,
      driftDetected: false,
    };
  }

  /**
   * Update ROI with new measurement
   */
  update(newRoi: RoiBox): RoiBox {
    this.frameCount++;
    
    // Calculate position difference
    const dx = newRoi.cx - this.state.currentRoi.cx;
    const dy = newRoi.cy - this.state.currentRoi.cy;
    
    // Update velocity
    this.state.velocityX = this.state.velocityX * (1 - VELOCITY_SMOOTHING) + dx * VELOCITY_SMOOTHING;
    this.state.velocityY = this.state.velocityY * (1 - VELOCITY_SMOOTHING) + dy * VELOCITY_SMOOTHING;
    
    // Smooth position
    const smoothedCx = this.state.currentRoi.cx + dx * SMOOTHING_FACTOR;
    const smoothedCy = this.state.currentRoi.cy + dy * SMOOTHING_FACTOR;
    
    // Smooth size
    const smoothedWidth = this.state.currentRoi.width + (newRoi.width - this.state.currentRoi.width) * SMOOTHING_FACTOR;
    const smoothedHeight = this.state.currentRoi.height + (newRoi.height - this.state.currentRoi.height) * SMOOTHING_FACTOR;
    
    // Update current ROI
    this.state.currentRoi = {
      x: Math.max(0, Math.round(smoothedCx - smoothedWidth / 2)),
      y: Math.max(0, Math.round(smoothedCy - smoothedHeight / 2)),
      width: Math.round(smoothedWidth),
      height: Math.round(smoothedHeight),
      cx: smoothedCx,
      cy: smoothedCy,
    };
    
    // Add to history
    this.history.push({ ...this.state.currentRoi });
    if (this.history.length > STABILITY_WINDOW) {
      this.history.shift();
    }
    
    // Calculate stability
    this.calculateStability();
    
    // Detect drift
    this.detectDrift();
    
    return { ...this.state.currentRoi };
  }

  /**
   * Calculate stability score based on ROI position variance
   */
  private calculateStability(): void {
    if (this.history.length < 5) {
      this.state.stabilityScore = 1.0;
      return;
    }
    
    // Calculate variance of center positions
    const meanCx = this.history.reduce((sum, roi) => sum + roi.cx, 0) / this.history.length;
    const meanCy = this.history.reduce((sum, roi) => sum + roi.cy, 0) / this.history.length;
    
    const varCx = this.history.reduce((sum, roi) => sum + (roi.cx - meanCx) ** 2, 0) / this.history.length;
    const varCy = this.history.reduce((sum, roi) => sum + (roi.cy - meanCy) ** 2, 0) / this.history.length;
    
    const stdDev = Math.sqrt(varCx + varCy);
    
    // Stability decreases with higher variance
    this.state.stabilityScore = Math.max(0, 1 - stdDev / DRIFT_THRESHOLD);
  }

  /**
   * Detect if ROI is drifting significantly
   */
  private detectDrift(): void {
    if (this.history.length < 10) {
      this.state.driftDetected = false;
      return;
    }
    
    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    
    const totalDrift = Math.sqrt(
      (last.cx - first.cx) ** 2 + (last.cy - first.cy) ** 2
    );
    
    this.state.driftDetected = totalDrift > DRIFT_THRESHOLD * 2;
  }

  /**
   * Get current ROI
   */
  getCurrentRoi(): RoiBox {
    return { ...this.state.currentRoi };
  }

  /**
   * Get tracker state
   */
  getState(): RoiTrackerState {
    return { ...this.state };
  }

  /**
   * Reset tracker with new ROI
   */
  reset(newRoi: RoiBox): void {
    this.state = {
      currentRoi: { ...newRoi },
      velocityX: 0,
      velocityY: 0,
      stabilityScore: 1.0,
      driftDetected: false,
    };
    this.history = [];
    this.frameCount = 0;
  }

  /**
   * Force ROI to specific position (used for manual override)
   */
  forceRoi(roi: RoiBox): void {
    this.state.currentRoi = { ...roi };
    this.history = [];
    this.state.velocityX = 0;
    this.state.velocityY = 0;
  }
}
